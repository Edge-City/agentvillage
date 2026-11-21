// The nap restore's box side (install/restore-state.ts): P-COST NAP design v2 section 8 box tests 7 and 8,
// section 12 M2 (no private key in any form; the data key only from a 0600 file, review-a N-n4), 13 M3
// (secret_cp skipped, secret_box restored 0600, .env merged), 13 S3/S4 and review-a (b) with release L43372
// (the approvald store copy is an opaque encrypted pair that never lands in the home). Synthetic homes and a
// loopback stub only.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { chunkName, dataEntryName, hasData, manifestName, TAR_END, tarPadding, toolSha256, ustarHeader } from "../nap-common";
import { BUNDLE_FILES, CP_REMINTABLE, STORE_BLOB_ENTRY, STORE_MEMBERS_ENTRY } from "../nap-state-paths";
import { envBytesWithoutRemintable, envEntriesToMerge } from "../restore-state";
import {
  buildNapHome,
  cleanup,
  decryptPayload,
  napDir,
  newRunId,
  type NapHome,
  PLANTED,
  publishManifest,
  runFold,
  runPrefix,
  SERVED,
  snapshotTree,
  decryptStoreBlob,
  stageStoreCopy,
  stageGetRun,
  stageKey,
  stagePaths,
  stagePutRun,
  tempBase,
  TENANT,
  unwrapKeyDoc,
  wrapKeys,
} from "./fixtures/nap-home";
import { startStub, type Stub } from "./fixtures/put-stub";

const INSTALL = resolve(import.meta.dir, "..");
const ARCHIVE = join(INSTALL, "nap-archive.ts");
const RESTORE = join(INSTALL, "restore-state.ts");
const FOLD = join(INSTALL, "nap-sqlite-fold.ts");
const TOOL = toolSha256(INSTALL, BUNDLE_FILES)!;
const CHUNK = 65536;
const FRESH = { events: "FRESH-EVENTS-TOKEN-from-the-wake", bot: "FRESH-BOT-TOKEN-from-the-wake", agent: "FRESH-AGENT-TOKEN-from-the-wake" };
const dirs: string[] = [];
let stub: Stub;
setDefaultTimeout(60_000); // each test spawns several bun processes (fold, archive, restore)

beforeAll(() => {
  wrapKeys();
  stub = startStub();
});
afterAll(() => stub.stop());
afterEach(() => {
  cleanup(dirs);
  stub.onGet = () => undefined;
});

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

async function run(cmd: string[], env: Record<string, string>) {
  const p = Bun.spawn([process.execPath, "--no-env-file", "--no-install", ...cmd], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  return { code, line: lines.length ? JSON.parse(lines[lines.length - 1]) : null, stdout, stderr };
}

type Archived = {
  h: NapHome;
  manifestKey: string;
  manifest: any;
  files: any[];
  entries: Map<string, Buffer>;
  /** What the root piece staged (null with --no-store-copy). */
  store: { blob: Buffer; list: Buffer } | null;
};

/** Archive a fresh fixture home the way the cp drives it, and publish its manifest. */
async function archiveFixture(label: string, tweak: (h: NapHome) => void = () => {}, o: { noStoreCopy?: boolean } = {}): Promise<Archived> {
  const base = tempBase(label);
  dirs.push(base);
  const h = buildNapHome(base);
  tweak(h);
  mkdirSync(join(base, "proc"));
  const runId = newRunId();
  stagePutRun(stub, h.home, runId);
  const paths = stagePaths(h.home);
  expect(runFold(FOLD, h, runId).code).toBe(0);
  let store: Archived["store"] = null;
  if (o.noStoreCopy) {
    rmSync(join(napDir(h.home), "approvald-store.enc"), { force: true });
    rmSync(join(napDir(h.home), "approvald-store.members.enc"), { force: true });
  } else {
    const staged = stageStoreCopy(h);
    store = { blob: staged.blob, list: staged.list };
  }
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NAP_WRAP_PUBLIC_KEY: wrapKeys().publicPem, NAP_PROC_ROOT: join(base, "proc") };
  const r = await run([ARCHIVE, "--tenant", TENANT, "--root", h.root, "--home", h.home, "--run-id", runId, "--served-commit", SERVED,
    "--tool-sha256", TOOL, "--mode", "presigned", "--paths", paths, "--chunk-bytes", String(CHUNK), ...(o.noStoreCopy ? ["--no-store-copy"] : [])], env);
  expect({ code: r.code, status: r.line?.status, stderr: r.stderr }).toEqual({ code: 0, status: "archived", stderr: "" });
  const manifest = JSON.parse(publishManifest(stub, r.line.manifest_key).toString("utf8"));
  const { entries } = decryptPayload(stub, manifest);
  return { h, manifestKey: r.line.manifest_key, manifest, files: JSON.parse(entries.get("files.json")!.toString()).files, entries, store };
}

type Target = { base: string; root: string; home: string };
/** A woken runtime before the restore: the cp has written a fresh `.env` and re-minted the agent token. */
function wakeTarget(label: string): Target {
  const base = tempBase(label);
  dirs.push(base);
  const root = join(base, "home");
  const home = join(root, ".hermes");
  mkdirSync(join(home, "approval"), { recursive: true });
  writeFileSync(join(home, ".env"), `AV_EVENTS_TOKEN=${FRESH.events}\nTELEGRAM_BOT_TOKEN=${FRESH.bot}\n`, { mode: 0o600 });
  writeFileSync(join(home, "approval", "agent-token"), FRESH.agent, { mode: 0o600 });
  return { base, root, home };
}

type Key = { doc: string; mode?: number } | null;
async function restore(t: Target, manifestKey: string, chunks: number, o: { extra?: string[]; env?: Record<string, string>; key?: Key; keyDoc?: string } = {}) {
  stageGetRun(stub, t.home, manifestKey, chunks);
  const key = o.key === undefined ? { doc: o.keyDoc! } : o.key;
  if (key) {
    const path = stageKey(t.home, key.doc);
    if (key.mode !== undefined) chmodSync(path, key.mode);
  }
  return run([RESTORE, "--tenant", TENANT, "--manifest", manifestKey, "--mode", "presigned", "--root", t.root, "--home", t.home, ...(o.extra ?? [])], {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: t.root,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    NAP_UPLOAD_RETRY_MS: "5",
    ...(o.env ?? {}),
  });
}
const keyFor = (a: { manifest: any }) => unwrapKeyDoc(a.manifest);
const notNap = (rel: string) => rel.startsWith(".hermes/av-events/nap");

// ---------------------------------------------------------------------------------------------------------
// A forger: the cp's own decrypt-and-list, edited, re-packed and re-encrypted under a key the test holds
// ---------------------------------------------------------------------------------------------------------

type Item = { entry: any; data?: Buffer };
function itemsOf(a: Archived): Item[] {
  return a.files.map((entry, i) => ({ entry: { ...entry }, data: hasData(entry) ? a.entries.get(dataEntryName(i)) : undefined }));
}

function forge(a: Archived, edit: (items: Item[]) => Item[] | void, o: { tagFlip?: boolean; payload?: (p: any) => void; manifest?: (m: any) => void } = {}) {
  let items = itemsOf(a);
  items = edit(items) ?? items;
  const files = items.map((x) => x.entry);
  const parts: Uint8Array[] = [];
  const filesJson = Buffer.from(JSON.stringify({ schema: "nap_files.v1", files }));
  parts.push(ustarHeader("files.json", filesJson.length), filesJson, new Uint8Array(tarPadding(filesJson.length)));
  items.forEach((x, i) => {
    if (!hasData(x.entry)) return;
    parts.push(ustarHeader(dataEntryName(i), x.data!.length), x.data!, new Uint8Array(tarPadding(x.data!.length)));
  });
  parts.push(TAR_END);
  const gz = gzipSync(Buffer.concat(parts));
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(gz), c.final()]);
  const tag = c.getAuthTag();
  if (o.tagFlip) tag[0] ^= 1;
  const runId = newRunId();
  const prefix = runPrefix(runId);
  const chunks = [];
  for (let off = 0, n = 0; off < ct.length; off += CHUNK, n++) {
    const body = ct.subarray(off, off + CHUNK);
    stub.objects.set(`${prefix}${chunkName(n)}`, Buffer.from(body));
    chunks.push({ n, name: chunkName(n), bytes: body.length, sha256: sha(body) });
  }
  const count = (cls: string) => files.filter((f) => f.class === cls).length;
  const manifest = {
    ...a.manifest,
    run_id: runId,
    prefix,
    iv_b64: iv.toString("base64"),
    gcm_tag_b64: tag.toString("base64"),
    payload: {
      sha256: sha(gz),
      bytes: gz.length,
      file_count: files.length,
      total_file_bytes: files.filter((f) => f.class !== "link").reduce((n, f) => n + f.bytes, 0),
      secret_cp_count: count("secret_cp"),
      secret_box_count: count("secret_box"),
      unclassified_count: count("unclassified"),
      link_count: count("link"),
      log_count: count("log"),
      dir_count: count("dir"),
    },
    tree: a.manifest.tree,
    chunks,
  };
  o.payload?.(manifest.payload);
  o.manifest?.(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  const manifestKey = `${prefix}${manifestName(sha(bytes))}`;
  stub.objects.set(manifestKey, bytes);
  const keyDoc = JSON.stringify({ schema: "nap_key.v1", data_key_b64: key.toString("base64"), iv_b64: iv.toString("base64") });
  return { manifestKey, keyDoc, chunks: chunks.length };
}

const at = (items: Item[], path: string) => items.find((x) => x.entry.path === path)!;

// ---------------------------------------------------------------------------------------------------------
// 7. all-or-nothing on each mismatch class; two-phase write; classes; .env merge; verify-only; key file
// ---------------------------------------------------------------------------------------------------------

test("7. each mismatch class refuses (exit 1) and writes nothing into the home", async () => {
  const a = await archiveFixture("mismatch");
  const t = wakeTarget("mismatch-t");
  writeFileSync(join(t.home, "config.yaml"), "model: on-disk-before\n");
  const before = snapshotTree(t.root, notNap);
  const n = a.manifest.chunks.length;
  const expectRefused = async (reason: string, r: { code: number; line: any }) => {
    expect({ reason, code: r.code, status: r.line?.status, got: r.line?.reason }).toEqual({ reason, code: 1, status: "refused", got: reason });
    expect(r.line).toMatchObject({ written: 0, secret_box_written: 0, env_merged: 0 });
    expect([reason, snapshotTree(t.root, notNap)]).toEqual([reason, before]);
    expect([reason, existsSync(join(napDir(t.home), "run.json")), existsSync(join(napDir(t.home), "restore-key.json"))]).toEqual([reason, false, false]);
  };
  const prefix = a.manifest.prefix;
  const swap = async (key: string, edit: (b: Buffer) => Buffer | undefined, reason: string) => {
    const orig = stub.objects.get(key)!;
    const next = edit(Buffer.from(orig));
    if (next) stub.objects.set(key, next);
    else stub.objects.delete(key);
    try {
      await expectRefused(reason, await restore(t, a.manifestKey, n, { keyDoc: keyFor(a) }));
    } finally {
      stub.objects.set(key, orig);
    }
  };
  // The bucket's bytes.
  await swap(a.manifestKey, (b) => Buffer.from(b.toString().replace(`"run_id"`, ` "run_id"`)), "manifest_hash_mismatch");
  await swap(`${prefix}chunk-0000.bin`, (b) => ((b[100] ^= 1), b), "chunk_hash_mismatch");
  await swap(`${prefix}chunk-0000.bin`, (b) => b.subarray(1), "chunk_size_mismatch");
  await swap(`${prefix}chunk-0001.bin`, () => undefined, "chunk_missing");
  // The key: another IV, or another key under the right IV.
  const doc = JSON.parse(keyFor(a));
  await expectRefused("key_mismatch", await restore(t, a.manifestKey, n, { keyDoc: JSON.stringify({ ...doc, iv_b64: randomBytes(12).toString("base64") }) }));
  await expectRefused("gcm_tag_invalid", await restore(t, a.manifestKey, n, { keyDoc: JSON.stringify({ ...doc, data_key_b64: randomBytes(32).toString("base64") }) }));
  // Forged archives: each validly encrypted, each wrong in one way.
  const forged = async (reason: string, edit: (items: Item[]) => Item[] | void, o: Parameters<typeof forge>[2] = {}) => {
    const f = forge(a, edit, o);
    await expectRefused(reason, await restore(t, f.manifestKey, f.chunks, { keyDoc: f.keyDoc }));
  };
  await forged("gcm_tag_invalid", () => {}, { tagFlip: true });
  await forged("counts_mismatch", () => {}, { payload: (p) => p.secret_box_count++ });
  await forged("path_not_allowed", (items) => void (at(items, ".hermes/config.yaml").entry.path = "../escape.yaml"));
  await forged("path_not_allowed", (items) => {
    const x = at(items, ".hermes/SOUL.md");
    return [...items, { entry: { ...x.entry, path: ".hermes/av-events/nap/planted.json" }, data: x.data }].sort((p, q) =>
      p.entry.path.startsWith("/") === q.entry.path.startsWith("/") ? (p.entry.path < q.entry.path ? -1 : 1) : p.entry.path.startsWith("/") ? 1 : -1);
  });
  await forged("class_mismatch", (items) => void (at(items, ".hermes/auth.json").entry.class = "bogus"));
  await forged("files_invalid", (items) => {
    const l = at(items, ".hermes/skills/linked").entry;
    l.target = "edge\0/etc"; // a NUL in a target: no link can hold it
    l.bytes = Buffer.byteLength(l.target);
    l.sha256 = sha(l.target);
  });
  await forged("file_hash_mismatch", (items) => {
    const x = at(items, ".hermes/MEMORY.md");
    x.data = Buffer.from(x.data!);
    x.data[0] ^= 1; // same size, other bytes, files.json unchanged
  });
  // The store pair (release L43372): each entry must hash to the manifest's sha; nothing else sits outside the home.
  await forged("files_invalid", (items) => {
    const x = at(items, STORE_MEMBERS_ENTRY);
    x.data = Buffer.from("another list");
    x.entry.bytes = x.data.length;
    x.entry.sha256 = sha(x.data);
  });
  await forged("files_invalid", (items) => void (items[items.length - 1].entry.path = "/etc/passwd"));
  await forged("files_invalid", (items) => {
    // A store member posing as a file of its own (data and all), after the pair: never a path a restore writes.
    const data = Buffer.from("old-sandbox\n");
    return [...items, { entry: { path: `/var/lib/approvald/${TENANT}/sandbox-id`, bytes: data.length, sha256: sha(data), mtime_ms: 0, mode: 0o600, class: "state" }, data }];
  });
});

test("7. two-phase write: a target that cannot be written, or a parent that is a symlink, leaves every file as it was", async () => {
  const a = await archiveFixture("twophase");
  const n = a.manifest.chunks.length;
  if (process.getuid?.() !== 0) {
    const t = wakeTarget("twophase-ro");
    mkdirSync(join(t.home, "sessions"), { recursive: true });
    chmodSync(join(t.home, "sessions"), 0o500);
    const before = snapshotTree(t.root, notNap);
    const r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a) });
    chmodSync(join(t.home, "sessions"), 0o700);
    expect({ code: r.code, status: r.line.status, reason: r.line.reason, written: r.line.written }).toEqual({ code: 1, status: "error", reason: "write_failed", written: 0 });
    expect(snapshotTree(t.root, notNap)).toEqual(before);
    // No temp left anywhere.
    expect(Object.keys(snapshotTree(t.root)).filter((p) => p.includes(".nap-restore-"))).toEqual([]);
  }
  const t = wakeTarget("twophase-link");
  const elsewhere = join(t.base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(t.home, "memory"));
  const before = snapshotTree(t.root, notNap);
  const r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a) });
  // The directory entry itself is a symlink now (Fable S2 records directories): never written through.
  expect({ code: r.code, status: r.line.status, reason: r.line.reason }).toEqual({ code: 1, status: "refused", reason: "target_not_directory" });
  expect(snapshotTree(t.root, notNap)).toEqual(before);
  expect(snapshotTree(elsewhere)).toEqual({});
  // review-a S4: a forged archive WITHOUT the directory's own entry, so only the restore's on-disk parent
  // check stands between its files and the link (a box writes its own files.json).
  const forgedNoDir = forge(a, (items) => items.filter((x) => x.entry.path !== ".hermes/memory"));
  const t2 = wakeTarget("twophase-link-nodir");
  const elsewhere2 = join(t2.base, "elsewhere");
  mkdirSync(elsewhere2);
  symlinkSync(elsewhere2, join(t2.home, "memory"));
  const before2 = snapshotTree(t2.root, notNap);
  const r2 = await restore(t2, forgedNoDir.manifestKey, forgedNoDir.chunks, { keyDoc: forgedNoDir.keyDoc });
  expect({ code: r2.code, status: r2.line.status, reason: r2.line.reason }).toEqual({ code: 1, status: "refused", reason: "target_parent_not_directory" });
  expect(snapshotTree(t2.root, notNap)).toEqual(before2);
  expect(snapshotTree(elsewhere2)).toEqual({});
});

test("7. --verify-only writes nothing and reports drift both ways; --repair refuses extra files, then rewrites changed and missing ones", async () => {
  const a = await archiveFixture("verify");
  const n = a.manifest.chunks.length;
  const t = wakeTarget("verify-t");
  const first = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a) });
  expect({ code: first.code, status: first.line.status }).toEqual({ code: 0, status: "restored" });
  const marker = () => JSON.parse(readFileSync(join(napDir(t.home), "restore.json"), "utf8"));
  expect(marker()).toMatchObject({ status: "restored", manifest_key: a.manifestKey, verify_only: false });
  rmSync(join(napDir(t.home), "restore.json"));
  let r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a), extra: ["--verify-only"] });
  expect({ code: r.code, status: r.line.status, m: r.line.drift_missing, c: r.line.drift_changed, x: r.line.drift_extra }).toEqual({ code: 0, status: "verified", m: 0, c: 0, x: 0 });
  expect(existsSync(join(napDir(t.home), "restore.json"))).toBe(false); // no marker on verify-only
  writeFileSync(join(t.home, "SOUL.md"), "# changed after the nap\n");
  rmSync(join(t.home, "knowledge", "index.md"));
  writeFileSync(join(t.home, "sessions", "new-after-checkpoint.jsonl"), "{}\n");
  const before = snapshotTree(t.root, notNap);
  r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a), extra: ["--verify-only"] });
  expect({ code: r.code, status: r.line.status, reason: r.line.reason, m: r.line.drift_missing, c: r.line.drift_changed, x: r.line.drift_extra, w: r.line.written })
    .toEqual({ code: 1, status: "drift", reason: "checkpoint_drift", m: 1, c: 1, x: 1, w: 0 });
  expect(snapshotTree(t.root, notNap)).toEqual(before);
  r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a), extra: ["--verify-only", "--repair"] });
  expect({ code: r.code, status: r.line.status, w: r.line.written }).toEqual({ code: 1, status: "drift", w: 0 }); // never deletes
  expect(snapshotTree(t.root, notNap)).toEqual(before);
  rmSync(join(t.home, "sessions", "new-after-checkpoint.jsonl"));
  r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a), extra: ["--verify-only", "--repair"] });
  expect({ code: r.code, status: r.line.status, w: r.line.written }).toEqual({ code: 0, status: "repaired", w: 2 });
  expect(marker()).toMatchObject({ status: "repaired", verify_only: true, written: 2 });
  expect(readFileSync(join(t.home, "SOUL.md"), "utf8")).toBe("# SOUL.md\n");
  r = await restore(t, a.manifestKey, n, { keyDoc: keyFor(a), extra: ["--verify-only"] });
  expect(r.line.status).toBe("verified");
});

test("7 / 12 M2 / N-n4: the data key comes only from a 0600 file; NAP_WRAP_PRIVATE_KEY in the environment is never read; usage exits 2", async () => {
  const a = await archiveFixture("key");
  const n = a.manifest.chunks.length;
  const t = wakeTarget("key-t");
  const before = snapshotTree(t.root, notNap);
  let r = await restore(t, a.manifestKey, n, { key: { doc: keyFor(a), mode: 0o644 } });
  expect({ code: r.code, line: r.line }).toMatchObject({ code: 1, line: { status: "refused", reason: "key_file_mode" } });
  expect(existsSync(join(napDir(t.home), "restore-key.json"))).toBe(false); // deleted on exit, refused or not
  r = await restore(t, a.manifestKey, n, { key: null, env: { NAP_WRAP_PRIVATE_KEY: wrapKeys().privatePem, NAP_DATA_KEY: JSON.parse(keyFor(a)).data_key_b64 } });
  expect({ code: r.code, line: r.line }).toMatchObject({ code: 1, line: { status: "refused", reason: "data_key_missing" } });
  expect(snapshotTree(t.root, notNap)).toEqual(before);
  for (const text of [r.stdout, r.stderr]) expect(text).not.toContain("PRIVATE KEY");
  const usage = (extra: string[]) =>
    spawnSync(process.execPath, ["--no-env-file", "--no-install", RESTORE, "--tenant", TENANT, "--root", t.root, "--home", t.home, ...extra], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
    }).status;
  const m = ["--manifest", a.manifestKey, "--mode", "presigned"];
  expect(usage(["--mode", "presigned"])).toBe(2);
  expect(usage([...m, "--key-stdin"])).toBe(2); // N-n4: no stdin path for the key
  expect(usage([...m, "--repair"])).toBe(2);
  expect(usage([...m, "--approvald-out", join(t.root, "out")])).toBe(2);
  expect(usage([...m, "--key-file", join(t.base, "outside.json")])).toBe(2);
  expect(usage(["--manifest", a.manifestKey.replace(TENANT, "other-tenant"), "--mode", "presigned"])).toBe(2);
});

// ---------------------------------------------------------------------------------------------------------
// 8. round trip
// ---------------------------------------------------------------------------------------------------------

test("8. archive → restore into a woken home: byte-equal for every class but secret_cp; secret_box 0600; .env merged; the store copy comes back byte-equal and extracts to <t>/", async () => {
  const a = await archiveFixture("roundtrip");
  const { h } = a;
  const t = wakeTarget("roundtrip-t");
  const out = join(t.base, "approvald-out");
  mkdirSync(out);
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a), extra: ["--approvald-out", out] });
  expect({ code: r.code, status: r.line.status, reason: r.line.reason, stderr: r.stderr }).toEqual({ code: 0, status: "restored", reason: undefined, stderr: "" });
  const home = a.files.filter((f) => !f.path.startsWith("/"));
  for (const f of home) {
    const src = join(h.root, f.path);
    const dst = join(t.root, f.path);
    if (f.class === "secret_cp" || f.path === ".hermes/.env") continue;
    if (f.class === "dir") {
      expect([f.path, statSync(dst).isDirectory(), statSync(dst).mode & 0o777]).toEqual([f.path, true, statSync(src).mode & 0o777]);
      continue;
    }
    if (f.class === "link") {
      expect([f.path, readlinkSync(dst)]).toEqual([f.path, readlinkSync(src)]);
      continue;
    }
    expect([f.path, sha(readFileSync(dst))]).toEqual([f.path, sha(readFileSync(src))]);
    expect([f.path, statSync(dst).mode & 0o777]).toEqual([f.path, f.class === "secret_box" ? 0o600 : statSync(src).mode & 0o777]);
    expect([f.path, Math.floor(statSync(dst).mtimeMs)]).toEqual([f.path, f.mtime_ms]);
  }
  // secret_cp: the archive's copy never comes back; the wake's fresh one stays.
  expect(readFileSync(join(t.home, "approval", "agent-token"), "utf8")).toBe(FRESH.agent);
  // .env: the resident's keys merged in; the cp's fresh keys kept; the archived cp keys never back.
  const env = readFileSync(join(t.home, ".env"), "utf8");
  expect(env).toContain(`AV_EVENTS_TOKEN=${FRESH.events}`);
  expect(env).toContain(`TELEGRAM_BOT_TOKEN=${FRESH.bot}`);
  expect(env).toContain(`MY_GITHUB_PAT=${PLANTED.residentKey}`);
  expect(env).toContain("RESIDENT_NOTE=hello");
  expect(env).not.toContain(PLANTED.eventsToken);
  expect(env).not.toContain(PLANTED.botToken);
  expect(statSync(join(t.home, ".env")).mode & 0o777).toBe(0o600);
  const secretBox = home.filter((f) => f.class === "secret_box").length;
  expect(r.line).toMatchObject({ secret_cp_skipped: 1, env_merged: 2, secret_box_written: secretBox - 1, links: 1 });
  // Nothing excluded comes back.
  for (const rel of Object.keys(h.excluded)) expect([rel, existsSync(join(t.root, rel))]).toEqual([rel, false]);
  // The store copy ("wake from the archive copy", box half): the blob and the list, byte-equal to what root
  // staged, 0600, outside the home only; the box never decrypted either.
  const blobOut = join(out, "nap-store.enc");
  const listOut = join(out, "nap-store.members.enc");
  expect([readFileSync(blobOut).equals(a.store!.blob), readFileSync(listOut).equals(a.store!.list)]).toEqual([true, true]);
  expect([statSync(blobOut).mode & 0o777, statSync(listOut).mode & 0o777]).toEqual([0o600, 0o600]);
  expect(r.line).toMatchObject({ store_copy: "blob", store_written: 2 });
  for (const rel of Object.keys(snapshotTree(t.root))) expect(rel).not.toMatch(/nap-store|var\/lib\/approvald/);
  // The cp's root step, simulated: decrypt the blob, extract to <t>/ with data/ one level down, no token files.
  const tdir = join(t.base, "var-lib-approvald", TENANT);
  mkdirSync(tdir, { recursive: true });
  const tgz = join(t.base, "store.tar.gz");
  writeFileSync(tgz, decryptStoreBlob(readFileSync(blobOut)));
  expect(spawnSync("tar", ["-xzf", tgz, "-C", tdir]).status).toBe(0);
  expect(readFileSync(join(tdir, "data", "APPROVAL.md"), "utf8")).toBe("# attested policy\n");
  expect(readFileSync(join(tdir, "sandbox-id"), "utf8")).toBe("old-sandbox\n");
  expect([existsSync(join(tdir, "env")), existsSync(join(tdir, "hook-token")), existsSync(join(tdir, TENANT))]).toEqual([false, false, false]);
  // The cp's parity, simulated: decrypt the list and check every member against the extracted store.
  const listed = JSON.parse(decryptStoreBlob(readFileSync(listOut)).toString()).members as { path: string; bytes: number; sha256: string }[];
  expect(listed.map((m) => m.path)).toEqual(["data/APPROVAL.md", "data/chain.jsonl", "sandbox-id"]);
  for (const m of listed) expect([m.path, sha(readFileSync(join(tdir, m.path))), statSync(join(tdir, m.path)).size]).toEqual([m.path, m.sha256, m.bytes]);
  expect(r.stdout).not.toContain(t.base);
});

test("8. --no-merge-env leaves the cp's .env alone; without --approvald-out the store is verified and written nowhere", async () => {
  const a = await archiveFixture("nomerge");
  const t = wakeTarget("nomerge-t");
  const envBefore = readFileSync(join(t.home, ".env"), "utf8");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a), extra: ["--no-merge-env"] });
  expect({ code: r.code, status: r.line.status, env_merged: r.line.env_merged }).toEqual({ code: 0, status: "restored", env_merged: 0 });
  expect(readFileSync(join(t.home, ".env"), "utf8")).toBe(envBefore);
  const all = snapshotTree(t.base);
  expect(Object.keys(all).filter((p) => p.includes("nap-store"))).toEqual([]);
  expect(r.line).toMatchObject({ store_copy: "blob", store_written: 0 });
  expect(a.files.some((f) => f.path === STORE_BLOB_ENTRY)).toBe(true);
});

test("(a): an archive with store_copy none restores; --approvald-out receives nothing", async () => {
  const a = await archiveFixture("no-store", () => {}, { noStoreCopy: true });
  expect(a.manifest.store_copy).toBe("none");
  const t = wakeTarget("no-store-t");
  const out = join(t.base, "approvald-out");
  mkdirSync(out);
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a), extra: ["--approvald-out", out] });
  expect({ code: r.code, status: r.line.status, store_copy: r.line.store_copy, store_written: r.line.store_written })
    .toEqual({ code: 0, status: "restored", store_copy: "none", store_written: 0 });
  expect(snapshotTree(out)).toEqual({});
});

// ---------------------------------------------------------------------------------------------------------
// Fable read 1 (overlay#617 at fb5a0f9c)
// ---------------------------------------------------------------------------------------------------------

test("S2: every directory is recorded with its mode, empty ones included; restore recreates them; verify-only sees a missing one", async () => {
  const a = await archiveFixture("dirs", (h) => {
    mkdirSync(join(h.root, "drafts"));
    chmodSync(join(h.root, "drafts"), 0o750);
    mkdirSync(join(h.home, "cron", "output", "empty"), { recursive: true });
    chmodSync(join(h.home, "mcp-tokens"), 0o700);
    chmodSync(join(h.home, "skills"), 0o755);
  });
  const dirsOf = a.files.filter((f) => f.class === "dir");
  const byPath = new Map(dirsOf.map((f) => [f.path, f]));
  expect(byPath.get("drafts")).toMatchObject({ mode: 0o750, bytes: 0 });
  expect(byPath.get(".hermes/cron/output/empty")).toBeDefined();
  expect(byPath.get(".hermes/mcp-tokens")).toMatchObject({ mode: 0o700 });
  expect(byPath.has(".hermes/edge-src")).toBe(false); // excluded trees stay out
  expect(byPath.has(".hermes/av-events/nap")).toBe(false); // the nap dir is pruned
  expect(a.manifest.payload.dir_count).toBe(dirsOf.length);
  expect(a.manifest.tree.live_dirs).toBe(dirsOf.length);
  const t = wakeTarget("dirs-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "restored" });
  for (const f of dirsOf) {
    const st = statSync(join(t.root, f.path));
    expect([f.path, st.isDirectory(), st.mode & 0o777]).toEqual([f.path, true, f.mode]);
  }
  rmSync(join(t.root, "drafts"), { recursive: true });
  const v = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a), extra: ["--verify-only"] });
  expect({ code: v.code, status: v.line.status, m: v.line.drift_missing }).toEqual({ code: 1, status: "drift", m: 1 });
});

test("S3: a resident's processes.json, cron.pid or gateway.lock outside $HERMES_HOME, and a FILE named venv or .cache, are archived and restored", async () => {
  const planted = ["project/processes.json", "project/cron.pid", "project/gateway.lock", "project/.backup.lock", "notes/venv", "notes/.cache", "docs/browser-profile"];
  const a = await archiveFixture("resident-names", (h) => {
    for (const rel of planted) {
      mkdirSync(join(h.root, dirname(rel)), { recursive: true });
      writeFileSync(join(h.root, rel), `resident file ${rel}\n`);
    }
  });
  const paths = new Set(a.files.map((f) => f.path));
  for (const rel of planted) expect([rel, paths.has(rel)]).toEqual([rel, true]);
  // Hermes's own runtime files at the $HERMES_HOME root stay out.
  for (const rel of [".hermes/processes.json", ".hermes/gateway.pid", ".hermes/cron.pid", ".hermes/gateway.lock", ".hermes/.backup.lock"]) {
    expect([rel, paths.has(rel)]).toEqual([rel, false]);
  }
  const t = wakeTarget("resident-names-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "restored" });
  for (const rel of planted) expect([rel, readFileSync(join(t.root, rel), "utf8")]).toEqual([rel, `resident file ${rel}\n`]);
});

test("S4: absolute and escaping symlinks are archived verbatim and recreated as links; a dry run counts them; nothing is written through a link", async () => {
  const a = await archiveFixture("links", (h) => {
    symlinkSync("/usr/bin/env", join(h.home, "skills", "absolute"));
    mkdirSync(join(h.root, "bin2"));
    symlinkSync("../../outside-the-home", join(h.root, "bin2", "up"));
  });
  const byPath = new Map(a.files.map((f) => [f.path, f]));
  expect(byPath.get(".hermes/skills/absolute")).toMatchObject({ class: "link", target: "/usr/bin/env" });
  expect(byPath.get("bin2/up")).toMatchObject({ class: "link", target: "../../outside-the-home" });
  const t = wakeTarget("links-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "restored" });
  expect(readlinkSync(join(t.home, "skills", "absolute"))).toBe("/usr/bin/env");
  expect(readlinkSync(join(t.root, "bin2", "up"))).toBe("../../outside-the-home");
  // The dry run reads every link.
  const { runArchive } = await import("../nap-archive");
  const dry = await runArchive({ root: a.h.root, home: a.h.home, dryRun: true } as any);
  expect(dry.line).toMatchObject({ links_absolute: 1, links_escaping: 1 });
  // A forged archive with a file under a link entry refuses before anything is written.
  const f = forge(a, (items) => {
    const x = at(items, ".hermes/SOUL.md");
    const extra = { entry: { ...x.entry, path: ".hermes/skills/absolute/planted" }, data: x.data };
    return [...items, extra].sort((p, q) => {
      const pa = p.entry.path.startsWith("/"), qa = q.entry.path.startsWith("/");
      return pa === qa ? (p.entry.path < q.entry.path ? -1 : 1) : pa ? 1 : -1;
    });
  });
  const t2 = wakeTarget("links-t2");
  const before = snapshotTree(t2.root, notNap);
  const bad = await restore(t2, f.manifestKey, f.chunks, { keyDoc: f.keyDoc });
  expect({ code: bad.code, status: bad.line.status, reason: bad.line.reason }).toEqual({ code: 1, status: "refused", reason: "files_invalid" });
  expect(snapshotTree(t2.root, notNap)).toEqual(before);
});

test("S5 / security fold 2 (HIGH): paths_sha256 relaxes nothing; the CURRENT rules decide what is allowed and every class", async () => {
  const a = await archiveFixture("old-rules");
  const olderRules = (items: Item[]) => {
    at(items, ".hermes/SOUL.md").entry.class = "unclassified"; // the old rules did not name it
    at(items, ".hermes/approval/agent-token").entry.class = "state"; // a current secret_cp path marked state
    at(items, ".hermes/auth.json").entry.class = "state"; // a current secret_box path marked state
    at(items, ".hermes/auth.json").entry.mode = 0o644; // and recorded world-readable
  };
  // Claimed older rules or not, the same outcome: written by the current classes, never by the recorded ones.
  for (const [label, o] of [["same", {}], ["older", { manifest: (m: any) => (m.paths_sha256 = "1".repeat(64)) }]] as const) {
    const f = forge(a, olderRules, o);
    const t = wakeTarget(`old-rules-${label}`);
    const r = await restore(t, f.manifestKey, f.chunks, { keyDoc: f.keyDoc });
    expect({ label, code: r.code, status: r.line.status, paths_match: r.line.paths_match, reclassified: r.line.class_reclassified })
      .toEqual({ label, code: 0, status: "restored", paths_match: label === "same", reclassified: 3 });
    expect(readFileSync(join(t.home, "SOUL.md"), "utf8")).toBe("# SOUL.md\n");
    expect(readFileSync(join(t.home, "approval", "agent-token"), "utf8")).toBe(FRESH.agent); // skipped, never written
    expect(r.line.secret_cp_skipped).toBe(1);
    expect(statSync(join(t.home, "auth.json")).mode & 0o777).toBe(0o600); // secret_box by the current rules
  }
  // An entry at a path the CURRENT rules exclude is never written, whatever rules the manifest claims: skipped
  // and counted (Fable read 2 S3), the rest restored; the tool's own dir still refuses.
  for (const rel of [".hermes/edge-src/install/install.ts", ".hermes/gateway.pid", "a/node_modules/x.js"]) {
    const older = forge(a, (items) => {
      olderRules(items);
      const x = at(items, ".hermes/MEMORY.md");
      return [...items, { entry: { ...x.entry, path: rel }, data: x.data }].sort((p, q) =>
        p.entry.path.startsWith("/") === q.entry.path.startsWith("/") ? (p.entry.path < q.entry.path ? -1 : 1) : p.entry.path.startsWith("/") ? 1 : -1);
    }, { manifest: (m) => (m.paths_sha256 = "1".repeat(64)) });
    const t3 = wakeTarget("old-rules-excluded");
    const r3 = await restore(t3, older.manifestKey, older.chunks, { keyDoc: older.keyDoc });
    expect({ rel, code: r3.code, status: r3.line.status, skipped: r3.line.excluded_skipped }).toEqual({ rel, code: 0, status: "restored", skipped: 1 });
    expect([rel, existsSync(join(t3.root, rel))]).toEqual([rel, false]);
    expect(existsSync(join(t3.home, "MEMORY.md"))).toBe(true);
  }
  for (const rel of [".hermes/av-events/nap/run.json"]) {
    const bad = forge(a, (items) => {
      olderRules(items);
      const x = at(items, ".hermes/MEMORY.md");
      return [...items, { entry: { ...x.entry, path: rel }, data: x.data }].sort((p, q) =>
        p.entry.path.startsWith("/") === q.entry.path.startsWith("/") ? (p.entry.path < q.entry.path ? -1 : 1) : p.entry.path.startsWith("/") ? 1 : -1);
    }, { manifest: (m) => (m.paths_sha256 = "1".repeat(64)) });
    const t2 = wakeTarget("old-rules-bad");
    const r2 = await restore(t2, bad.manifestKey, bad.chunks, { keyDoc: bad.keyDoc });
    expect({ rel, code: r2.code, reason: r2.line.reason }).toEqual({ rel, code: 1, reason: "path_not_allowed" });
    expect([rel, existsSync(join(t2.root, rel))]).toEqual([rel, false]);
    expect(existsSync(join(t2.home, "MEMORY.md"))).toBe(false); // nothing written at all
  }
});

test("security fold 2 (MEDIUM): a link at a secret_cp, cp-env, excluded or cp-written path, or above one, refuses link_at_managed_path; nothing written", async () => {
  const a = await archiveFixture("link-managed");
  const target = "/etc/cron.d/nap-planted";
  const sorted = (items: Item[]) => items.sort((p, q) =>
    p.entry.path.startsWith("/") === q.entry.path.startsWith("/") ? (p.entry.path < q.entry.path ? -1 : 1) : p.entry.path.startsWith("/") ? 1 : -1);
  for (const rel of [
    ".hermes/approval/agent-token", // secret_cp, CP_REMINTABLE.files
    ".hermes/.env", // the cp's .env keys
    ".hermes/gateway.pid", // excluded
    ".hermes/av-events/nap", // the tool's own dir (excluded)
    ".hermes/mini-apps.json", ".hermes/village-bridge.json", ".hermes/constitution.md", // the wake's step 4 writes
    ".hermes/shell-hooks-allowlist.json", ".hermes/config.yaml", ".hermes/SOUL.md", // the installer's writes
    ".hermes/approval", // a directory above agent-token
    ".hermes", // above all of them
  ]) {
    const f = forge(a, (items) => sorted([
      ...items.filter((x) => x.entry.path !== rel && !x.entry.path.startsWith(`${rel}/`)),
      { entry: { path: rel, bytes: Buffer.byteLength(target), sha256: sha(target), mtime_ms: 0, mode: 0o777, class: "link", target } },
    ]));
    const t = wakeTarget("link-managed-t");
    const before = snapshotTree(t.root, notNap);
    const r = await restore(t, f.manifestKey, f.chunks, { keyDoc: f.keyDoc });
    expect({ rel, code: r.code, status: r.line.status, reason: r.line.reason }).toEqual({ rel, code: 1, status: "refused", reason: "link_at_managed_path" });
    expect([rel, snapshotTree(t.root, notNap)]).toEqual([rel, before]);
  }
  // Control: the same link at an ordinary path restores as a link.
  const ok = forge(a, (items) => sorted([
    ...items,
    { entry: { path: ".hermes/skills/planted-link", bytes: Buffer.byteLength(target), sha256: sha(target), mtime_ms: 0, mode: 0o777, class: "link", target } },
  ]));
  const t = wakeTarget("link-ordinary-t");
  const r = await restore(t, ok.manifestKey, ok.chunks, { keyDoc: ok.keyDoc });
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "restored" });
  expect(readlinkSync(join(t.home, "skills", "planted-link"))).toBe(target);
});

test("review-a S1: a file from before 1970 (a negative mtime_ms) archives and restores with its mtime", async () => {
  const a = await archiveFixture("pre-epoch", (h) => {
    mkdirSync(join(h.root, "notes"), { recursive: true });
    writeFileSync(join(h.root, "notes", "old.txt"), "from 1969\n");
    utimesSync(join(h.root, "notes", "old.txt"), new Date(-86_400_000), new Date(-86_400_000));
  });
  expect(a.files.find((f) => f.path === "notes/old.txt")).toMatchObject({ mtime_ms: -86_400_000 });
  const t = wakeTarget("pre-epoch-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, reason: r.line.reason }).toEqual({ code: 0, status: "restored", reason: undefined });
  expect([readFileSync(join(t.root, "notes", "old.txt"), "utf8"), statSync(join(t.root, "notes", "old.txt")).mtimeMs]).toEqual(["from 1969\n", -86_400_000]);
});

test("review-a S2: an archived symlinked dotfile over a fresh box's regular file (and a file over a link) is put in place; a directory in the way refuses", async () => {
  const a = await archiveFixture("dotfile-link", (h) => {
    mkdirSync(join(h.root, "dotfiles"), { recursive: true });
    writeFileSync(join(h.root, "dotfiles", "bashrc"), "alias ll='ls -l'\n");
    symlinkSync("dotfiles/bashrc", join(h.root, ".bashrc"));
    writeFileSync(join(h.root, ".profile"), "resident profile\n");
  });
  const t = wakeTarget("dotfile-link-t");
  writeFileSync(join(t.root, ".bashrc"), "# /etc/skel copy\n"); // a fresh useradd -m home
  symlinkSync("/etc/skel/.profile", join(t.root, ".profile"));
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, reason: r.line.reason }).toEqual({ code: 0, status: "restored", reason: undefined });
  expect(readlinkSync(join(t.root, ".bashrc"))).toBe("dotfiles/bashrc");
  expect([lstatSync(join(t.root, ".profile")).isFile(), readFileSync(join(t.root, ".profile"), "utf8")]).toEqual([true, "resident profile\n"]);
  // A directory where the archive has a link still refuses, nothing written.
  const t2 = wakeTarget("dotfile-dir-t");
  mkdirSync(join(t2.root, ".bashrc"));
  const before = snapshotTree(t2.root, notNap);
  const r2 = await restore(t2, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r2.code, reason: r2.line.reason }).toEqual({ code: 1, reason: "target_kind_mismatch" });
  expect(snapshotTree(t2.root, notNap)).toEqual(before);
});

test("review-a N4: browser_profiles and other browser-ish dirs stay archived, classed secret_box, restored 0600", async () => {
  const a = await archiveFixture("browser-dirs", (h) => {
    for (const rel of [".hermes/browser_profiles/Default/Cookies", "projects/BrowserData/Login Data", "x/browser-user-data/Local State"]) {
      mkdirSync(dirname(join(h.root, rel)), { recursive: true });
      writeFileSync(join(h.root, rel), `secret of ${rel}\n`, { mode: 0o644 });
    }
  });
  const rels = [".hermes/browser_profiles/Default/Cookies", "projects/BrowserData/Login Data", "x/browser-user-data/Local State"];
  for (const rel of rels) expect([rel, a.files.find((f) => f.path === rel)?.class]).toEqual([rel, "secret_box"]);
  const t = wakeTarget("browser-dirs-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "restored" });
  for (const rel of rels) {
    expect([rel, readFileSync(join(t.root, rel), "utf8"), statSync(join(t.root, rel)).mode & 0o777]).toEqual([rel, `secret of ${rel}\n`, 0o600]);
  }
});

test.skipIf(process.getuid?.() === 0)("review-a N8: a target directory the restore cannot read is target_unreadable, never payload_unreadable (skipped as root, which reads anything)", async () => {
  const a = await archiveFixture("plan-io");
  const t = wakeTarget("plan-io-t");
  mkdirSync(join(t.home, "sessions"), { recursive: true });
  chmodSync(join(t.home, "sessions"), 0o000);
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  chmodSync(join(t.home, "sessions"), 0o700);
  expect({ code: r.code, reason: r.line.reason, written: r.line.written }).toEqual({ code: 1, reason: "target_unreadable", written: 0 });
});

test("N4: a name with a backslash is archived and restored", async () => {
  const a = await archiveFixture("odd-names", (h) => {
    mkdirSync(join(h.root, "notes"), { recursive: true });
    writeFileSync(join(h.root, "notes", "a\\b.txt"), "backslash\n");
  });
  expect(a.files.some((f) => f.path === "notes/a\\b.txt")).toBe(true);
  const t = wakeTarget("odd-names-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "restored" });
  expect(readFileSync(join(t.root, "notes", "a\\b.txt"), "utf8")).toBe("backslash\n");
});

/** Whether this filesystem takes a name that is not UTF-8 (Linux ext4/tmpfs: yes; macOS APFS refuses it with
 * EILSEQ). Probed once, by raw bytes, and removed by raw bytes. */
const RAW_NAMES = (() => {
  const dir = mkdtempSync(join(tmpdir(), "nap-rawname-"));
  const name = Buffer.concat([Buffer.from(`${dir}/`), Buffer.from([0x66, 0xff, 0x6f])]);
  try {
    writeFileSync(name, "");
    unlinkSync(name);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
})();

// Skips where the filesystem refuses a non-UTF-8 name (macOS APFS); runs on Linux CI. The byte-level
// check itself runs everywhere in nap-archive.test.ts through the walker's reader seam.
test.skipIf(!RAW_NAMES)("N4 (Linux): a real non-UTF-8 name refuses file_name_invalid (64) before any open; the dry run counts it", async () => {
  const a = await archiveFixture("raw-names", (h) => {
    mkdirSync(join(h.root, "notes"), { recursive: true });
  });
  const bad = Buffer.concat([Buffer.from(join(a.h.root, "notes") + "/"), Buffer.from([0x66, 0xff, 0x6f])]);
  writeFileSync(bad, "latin-1 name\n");
  const { runArchive, parseArgs } = await import("../nap-archive");
  const dry = await runArchive({ root: a.h.root, home: a.h.home, dryRun: true } as any);
  expect(dry.line).toMatchObject({ file_name_invalid: 1 });
  const runId = newRunId();
  stagePutRun(stub, a.h.home, runId);
  const paths = stagePaths(a.h.home);
  expect(runFold(FOLD, a.h, runId).code).toBe(0);
  stageStoreCopy(a.h);
  const opts = parseArgs(["--tenant", TENANT, "--root", a.h.root, "--home", a.h.home, "--run-id", runId, "--served-commit", SERVED,
    "--tool-sha256", TOOL, "--mode", "presigned", "--paths", paths], { HOME: a.h.root, NAP_WRAP_PUBLIC_KEY: wrapKeys().publicPem, NAP_PROC_ROOT: join(a.h.base, "proc") });
  const out = await runArchive(opts);
  expect(out).toEqual({ code: 64, line: { status: "refused", reason: "file_name_invalid", chunks_acked: 0 } });
  unlinkSync(bad);
});

test("N3: a hard link to a secret_cp file is skipped like the file itself; the stale token never lands at the second path", async () => {
  const a = await archiveFixture("hard-secret", (h) => {
    mkdirSync(join(h.root, "notes"), { recursive: true });
    linkSync(join(h.home, "approval", "agent-token"), join(h.root, "notes", "token-copy"));
  });
  expect(a.files.find((f) => f.path === "notes/token-copy")).toMatchObject({ same_as: ".hermes/approval/agent-token" });
  const t = wakeTarget("hard-secret-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, skipped: r.line.secret_cp_skipped }).toEqual({ code: 0, status: "restored", skipped: 2 });
  expect(existsSync(join(t.root, "notes", "token-copy"))).toBe(false);
  expect(readFileSync(join(t.home, "approval", "agent-token"), "utf8")).toBe(FRESH.agent);
});

test("Fable read 2 N (.env): a duplicate key merges its LAST value; every hard link to .env gets it without the re-minted keys; a .env symlink refuses", async () => {
  const archivedEnv = `# resident notes\nMY_TOKEN=first\nAV_EVENTS_TOKEN=${PLANTED.eventsToken}\nMY_TOKEN=second\nOTHER=1\n`;
  const a = await archiveFixture("env-links", (h) => {
    writeFileSync(join(h.home, ".env"), archivedEnv, { mode: 0o600 });
    mkdirSync(join(h.root, "notes"), { recursive: true });
    linkSync(join(h.home, ".env"), join(h.root, "notes", "env-copy")); // sorts after .hermes/.env
    linkSync(join(h.home, ".env"), join(h.root, ".a-env")); // sorts before it: .env is then the second path
  });
  expect(a.files.find((f) => f.path === ".hermes/.env")).toMatchObject({ same_as: ".a-env" });
  const t = wakeTarget("env-links-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, merged: r.line.env_merged, links: r.line.env_links_filtered, dropped: r.line.env_archived_dropped })
    .toEqual({ code: 0, status: "restored", merged: 2, links: 2, dropped: 1 });
  const env = readFileSync(join(t.home, ".env"), "utf8");
  expect([env.includes("MY_TOKEN=second"), env.includes("MY_TOKEN=first"), env.includes(PLANTED.eventsToken)]).toEqual([true, false, false]);
  const filtered = `# resident notes\nMY_TOKEN=first\nMY_TOKEN=second\nOTHER=1\n`;
  for (const rel of ["notes/env-copy", ".a-env"]) {
    expect([rel, readFileSync(join(t.root, rel), "utf8"), statSync(join(t.root, rel)).mode & 0o777]).toEqual([rel, filtered, 0o600]);
  }
  expect(readFileSync(join(napDir(t.home), "env.archived"), "utf8")).toBe(filtered); // F2: the re-minted key's old value is gone
  // A .env that is a symlink is never silently dropped: the archive refuses it (link_at_managed_path, 64,
  // in nap-archive.test.ts) and a forged one refuses the restore (the MEDIUM test above).
});

test("N2: a multi-line quoted value merges whole; the archived .env is kept 0600 in the nap dir; an oversized .env no longer refuses the restore", async () => {
  const archivedEnv = `# resident notes\nAV_EVENTS_TOKEN=${PLANTED.eventsToken}\nCERT="-----BEGIN-----\nline two\n-----END-----"\nSINGLE='a b'\nAFTER=1\n`;
  const a = await archiveFixture("env-shape", (h) => writeFileSync(join(h.home, ".env"), archivedEnv, { mode: 0o600 }));
  const t = wakeTarget("env-shape-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, merged: r.line.env_merged }).toEqual({ code: 0, status: "restored", merged: 3 });
  const env = readFileSync(join(t.home, ".env"), "utf8");
  expect(env).toContain(`CERT="-----BEGIN-----\nline two\n-----END-----"\n`);
  expect(env).toContain("SINGLE='a b'\nAFTER=1\n");
  expect(env).toContain(`AV_EVENTS_TOKEN=${FRESH.events}`);
  expect(env).not.toContain(PLANTED.eventsToken);
  const kept = join(napDir(t.home), "env.archived");
  expect([readFileSync(kept, "utf8"), statSync(kept).mode & 0o777, r.line.env_archived_dropped])
    .toEqual([archivedEnv.replace(`AV_EVENTS_TOKEN=${PLANTED.eventsToken}\n`, ""), 0o600, 1]);
  // Over the merge cap: restored without a merge, the archived copy kept, still without the re-minted keys (F2).
  const padding = "# padding\n".repeat(120_000);
  const big = `RESIDENT_KEY=1\nAV_EVENTS_TOKEN=${PLANTED.eventsToken}\n${padding}`;
  const b = await archiveFixture("env-big", (h) => writeFileSync(join(h.home, ".env"), big, { mode: 0o600 }));
  const t2 = wakeTarget("env-big-t");
  const r2 = await restore(t2, b.manifestKey, b.manifest.chunks.length, { keyDoc: keyFor(b) });
  expect({ code: r2.code, status: r2.line.status, merged: r2.line.env_merged, dropped: r2.line.env_archived_dropped })
    .toEqual({ code: 0, status: "restored", merged: 0, dropped: 1 });
  expect(readFileSync(join(napDir(t2.home), "env.archived"), "utf8")).toBe(`RESIDENT_KEY=1\n${padding}`);
});

// F2 (review-a L43945, lead L44199): env.archived holds the archived .env minus every line of a key the cp
// re-mints, every other line byte-exact. Lines as [bytes, kept?]; the keys come from the module.
const REMINT = CP_REMINTABLE.env_keys;
const envLine = (text: string | Buffer, kept: boolean): [Buffer, boolean] => [typeof text === "string" ? Buffer.from(text, "utf8") : text, kept];
function f2Lines(o: { swallow: boolean }): [Buffer, boolean][] {
  return [
    envLine("# resident notes", true),
    envLine("", true),
    envLine("MY_TOKEN=first", true),
    // Every re-mintable key, plain, `export` and spaced forms.
    ...REMINT.map((k, i) => envLine(i % 2 ? `export ${k}=old-${i}` : `  ${k} = old-${i}`, false)),
    // A multi-line quoted re-mintable value (the key given a second time): all three lines go.
    envLine(`${REMINT[0]}="-----BEGIN OLD-----`, false),
    envLine("old body line", false),
    envLine(`-----END OLD-----"`, false),
    // A key given twice.
    envLine(`${REMINT[1]}=old-twice`, false),
    envLine("CERT='keep", true),
    envLine("me'", true),
    // Not UTF-8: a kept line round-trips byte for byte; a dropped one goes whole. Truncated sequences sit
    // right before the 0x0A so a decoder that swallowed it would shift every later line.
    envLine(Buffer.from([0x4c, 0x41, 0x54, 0x49, 0x4e, 0x3d, 0xff, 0xfe, 0xc3]), true),
    envLine(Buffer.concat([Buffer.from(`${REMINT[2]}=old-`), Buffer.from([0xe0, 0x80])]), false),
    envLine(Buffer.from([0x23, 0x20, 0xf0, 0x90, 0x80]), true),
    envLine("CRLF_KEY=1\r", true),
    envLine("MY_TOKEN=second", true),
    ...(o.swallow
      ? [envLine('SWALLOW="abc', true), envLine(`${REMINT[3]}=old-swallowed`, false), envLine('END="x"', true)]
      : []),
    // An unclosed quote on a re-mintable key: not an entry, but its line still holds the old value.
    envLine(`${REMINT[4]}="old-unclosed`, false),
    envLine("AFTER_UNCLOSED=1", true),
    envLine("", true), // the trailing newline
  ];
}
const joinLines = (ls: [Buffer, boolean][], keptOnly: boolean) =>
  Buffer.concat(ls.filter(([, k]) => k || !keptOnly).flatMap(([b], i) => (i === 0 ? [b] : [Buffer.from("\n"), b])));
/** Every line of `bytes` that assigns a re-mintable key, as a dotenv reader would see it. */
const remintLines = (bytes: Buffer) =>
  bytes.toString("latin1").split("\n").filter((l) => REMINT.some((k) => new RegExp(`^\\s*(?:export\\s+)?${k}\\s*=`).test(l)));

test("F2: env.archived is the archived .env minus every line of a re-mintable key, byte-exact (multi-line, twice, unclosed, swallowed, not UTF-8)", () => {
  expect(REMINT.length).toBeGreaterThanOrEqual(5);
  const ls = f2Lines({ swallow: true });
  const archived = joinLines(ls, false);
  expect(remintLines(archived).length).toBe(REMINT.length + 5); // the fixture does hold them
  const { bytes, dropped } = envBytesWithoutRemintable(archived);
  expect(bytes.equals(joinLines(ls, true))).toBe(true);
  expect(dropped).toBe(REMINT.length + 5);
  expect(remintLines(bytes)).toEqual([]);
  expect(/old/i.test(bytes.toString("latin1"))).toBe(false);
  // Nothing to drop: the bytes come back whole, not-UTF-8 and all.
  const clean = joinLines(ls.filter(([, k]) => k), false);
  expect(envBytesWithoutRemintable(clean)).toEqual({ bytes: clean, dropped: 0 });
  // No trailing newline, the last line dropped.
  expect(envBytesWithoutRemintable(Buffer.from(`A=1\n${REMINT[0]}=old`)).bytes.toString()).toBe("A=1");
});

test("F2: a restore writes env.archived without the re-minted keys' lines, byte-exact; the .env merge is unchanged", async () => {
  const ls = f2Lines({ swallow: false });
  const archived = joinLines(ls, false);
  const a = await archiveFixture("env-f2", (h) => writeFileSync(join(h.home, ".env"), archived, { mode: 0o600 }));
  const t = wakeTarget("env-f2-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, merged: r.line.env_merged, dropped: r.line.env_archived_dropped })
    .toEqual({ code: 0, status: "restored", merged: 5, dropped: REMINT.length + 4 });
  const kept = join(napDir(t.home), "env.archived");
  const bytes = readFileSync(kept);
  expect([bytes.equals(joinLines(ls, true)), statSync(kept).mode & 0o777]).toEqual([true, 0o600]);
  expect(remintLines(bytes)).toEqual([]);
  // The merge, as before: the last value of each key not re-minted and not set, on the UTF-8 decoding.
  expect(readFileSync(join(t.home, ".env"), "utf8")).toBe(
    `AV_EVENTS_TOKEN=${FRESH.events}\nTELEGRAM_BOT_TOKEN=${FRESH.bot}\n` +
      "CERT='keep\nme'\nLATIN=\ufffd\ufffd\ufffd\nCRLF_KEY=1\nMY_TOKEN=second\nAFTER_UNCLOSED=1\n",
  );
});

// review-b S1 (L44339): a stray quote in an earlier entry swallows a re-mintable key's line into that entry's
// quoted value; the merge must not carry the entry (and so the old line) into the live .env. The keys come
// from the module: two the wake's .env does not set.
const WAKE_KEYS = ["AV_EVENTS_TOKEN", "TELEGRAM_BOT_TOKEN"];
const [S1_KEY, S1_KEY2] = REMINT.filter((k) => !WAKE_KEYS.includes(k));
const s1Env = () =>
  [
    "# resident notes",
    "KEEP_A=1",
    `X_${S1_KEY}_NOTE=decoy-contains`, // a key that merely contains a re-mintable name: merged
    `${S1_KEY}_SUFFIX=decoy-suffix`,
    'STRAY="abc', // stray double quote: the next line is inside STRAY's value
    `${S1_KEY}=old-swallowed-1`,
    'END="x"',
    "STRAY2='abc", // stray single quote, an `export` spaced form swallowed
    `  export ${S1_KEY2} = old-swallowed-2`,
    "tail'",
    "KEEP_B=2",
    'TAIL="never closed', // unclosed to EOF: not an entry; the next line is its own (re-minted) entry
    `${S1_KEY}=old-after-unclosed`,
    "",
  ].join("\n");

test("S1: envEntriesToMerge skips an entry carrying a swallowed re-mintable line and counts it; the rest still merge", () => {
  expect([typeof S1_KEY, typeof S1_KEY2]).toEqual(["string", "string"]);
  const archived = s1Env();
  expect(remintLines(Buffer.from(archived)).length).toBe(3); // the fixture does hold them
  const m = envEntriesToMerge(archived, `AV_EVENTS_TOKEN=fresh\n`);
  expect({ keys: m.entries.map((e) => e.key), skipped: m.skipped })
    .toEqual({ keys: ["KEEP_A", `X_${S1_KEY}_NOTE`, `${S1_KEY}_SUFFIX`, "KEEP_B"], skipped: 2 });
  const merged = m.entries.flatMap((e) => e.lines).join("\n");
  expect(remintLines(Buffer.from(merged))).toEqual([]);
  expect(merged).not.toContain("old-");
  // Only entries that would otherwise merge are counted: one already set is not.
  expect(envEntriesToMerge(archived, "STRAY2=fresh\n").skipped).toBe(1);
  // Nothing swallowed: nothing skipped.
  expect(envEntriesToMerge("A=1\nB=\"x\ny\"\n", "").skipped).toBe(0);
});

test("S1: a restore merges no swallowed re-mintable line into the live .env (env_merge_skipped counts the entries)", async () => {
  const archived = s1Env();
  const a = await archiveFixture("env-s1", (h) => writeFileSync(join(h.home, ".env"), archived, { mode: 0o600 }));
  const t = wakeTarget("env-s1-t");
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, merged: r.line.env_merged, skipped: r.line.env_merge_skipped, dropped: r.line.env_archived_dropped })
    .toEqual({ code: 0, status: "restored", merged: 4, skipped: 2, dropped: 3 });
  const live = readFileSync(join(t.home, ".env"));
  // The live .env sets re-mintable keys only through the wake's own fresh lines.
  expect(remintLines(live)).toEqual([`AV_EVENTS_TOKEN=${FRESH.events}`, `TELEGRAM_BOT_TOKEN=${FRESH.bot}`]);
  expect(live.toString("utf8")).toBe(
    `AV_EVENTS_TOKEN=${FRESH.events}\nTELEGRAM_BOT_TOKEN=${FRESH.bot}\n` +
      `KEEP_A=1\nX_${S1_KEY}_NOTE=decoy-contains\n${S1_KEY}_SUFFIX=decoy-suffix\nKEEP_B=2\n`,
  );
  expect(remintLines(readFileSync(join(napDir(t.home), "env.archived")))).toEqual([]);
  expect(r.stdout).not.toContain("old-");
});

test("N7: env_merge_skipped counts a skipped entry even when nothing is merged (the live .env left as the wake wrote it)", async () => {
  // The only candidate entry swallows a re-mintable line, so nothing merges and the merged .env is never written.
  const archived = ['ONLY="abc', `${S1_KEY}=old-swallowed-only`, 'END="x"', ""].join("\n");
  const a = await archiveFixture("env-n7", (h) => writeFileSync(join(h.home, ".env"), archived, { mode: 0o600 }));
  const t = wakeTarget("env-n7-t");
  const before = readFileSync(join(t.home, ".env"));
  const r = await restore(t, a.manifestKey, a.manifest.chunks.length, { keyDoc: keyFor(a) });
  expect({ code: r.code, status: r.line.status, merged: r.line.env_merged, skipped: r.line.env_merge_skipped })
    .toEqual({ code: 0, status: "restored", merged: 0, skipped: 1 });
  expect(readFileSync(join(t.home, ".env")).equals(before)).toBe(true);
  expect(r.stdout).not.toContain("old-");
});
