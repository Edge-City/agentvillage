// The nap restore's box side (install/restore-state.ts): P-COST NAP design v2 section 8 box tests 7 and 8,
// section 12 M2 (no private key in any form; the data key only from a 0600 file, review-a N-n4), 13 M3
// (secret_cp skipped, secret_box restored 0600, .env merged), 13 S3/S4 and review-a S-n2 (the approvald store
// never lands in the home; its members must match files.json). Synthetic homes and a loopback stub only.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";

import { chunkName, dataEntryName, hasData, manifestName, TAR_END, tarPadding, toolSha256, ustarHeader } from "../nap-common";
import { APPROVALD_STORE_ENTRY, BUNDLE_FILES } from "../nap-state-paths";
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
  stageApprovaldTar,
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

type Archived = { h: NapHome; manifestKey: string; manifest: any; files: any[]; entries: Map<string, Buffer> };

/** Archive a fresh fixture home the way the cp drives it, and publish its manifest. */
async function archiveFixture(label: string, tweak: (h: NapHome) => void = () => {}): Promise<Archived> {
  const base = tempBase(label);
  dirs.push(base);
  const h = buildNapHome(base);
  tweak(h);
  mkdirSync(join(base, "proc"));
  const runId = newRunId();
  stagePutRun(stub, h.home, runId);
  const paths = stagePaths(h.home);
  expect(runFold(FOLD, h, runId).code).toBe(0);
  stageApprovaldTar(h);
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: h.root, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0", NAP_WRAP_PUBLIC_KEY: wrapKeys().publicPem, NAP_PROC_ROOT: join(base, "proc") };
  const r = await run([ARCHIVE, "--tenant", TENANT, "--root", h.root, "--home", h.home, "--run-id", runId, "--served-commit", SERVED,
    "--tool-sha256", TOOL, "--mode", "presigned", "--paths", paths, "--chunk-bytes", String(CHUNK)], env);
  expect({ code: r.code, status: r.line?.status, stderr: r.stderr }).toEqual({ code: 0, status: "archived", stderr: "" });
  const manifest = JSON.parse(publishManifest(stub, r.line.manifest_key).toString("utf8"));
  const { entries } = decryptPayload(stub, manifest);
  return { h, manifestKey: r.line.manifest_key, manifest, files: JSON.parse(entries.get("files.json")!.toString()).files, entries };
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

function forge(a: Archived, edit: (items: Item[]) => Item[] | void, o: { tagFlip?: boolean; payload?: (p: any) => void } = {}) {
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
  const members = files.filter((f) => f.member_of !== undefined);
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
    tree: { ...a.manifest.tree, approvald_files: members.length, approvald_bytes: members.reduce((n, f) => n + f.bytes, 0) },
    chunks,
  };
  o.payload?.(manifest.payload);
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
    return [...items, { entry: { ...x.entry, path: ".hermes/edge-src/install/install.ts" }, data: x.data }].sort((p, q) =>
      p.entry.path.startsWith("/") === q.entry.path.startsWith("/") ? (p.entry.path < q.entry.path ? -1 : 1) : p.entry.path.startsWith("/") ? 1 : -1);
  });
  await forged("class_mismatch", (items) => void (at(items, ".hermes/auth.json").entry.class = "state"));
  await forged("class_mismatch", (items) => void (at(items, ".hermes/approval/agent-token").entry.class = "secret_box"));
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
  await forged("approvald_members_mismatch", (items) => items.filter((x) => x.entry.path !== `/var/lib/approvald/${TENANT}/sandbox-id`));
  await forged("files_invalid", (items) => void (items[items.length - 1].entry.path = "/etc/passwd"));
  await forged("files_invalid", (items) => {
    // A store member posing as a file of its own (data and all): never a path a restore writes.
    const x = at(items, `/var/lib/approvald/${TENANT}/data/APPROVAL.md`);
    delete x.entry.member_of;
    x.data = Buffer.alloc(x.entry.bytes);
    x.entry.sha256 = sha(x.data);
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
  expect(usage([...m, "--approvald-out", join(t.root, "store.tar.gz")])).toBe(2);
  expect(usage([...m, "--key-file", join(t.base, "outside.json")])).toBe(2);
  expect(usage(["--manifest", a.manifestKey.replace(TENANT, "other-tenant"), "--mode", "presigned"])).toBe(2);
});

// ---------------------------------------------------------------------------------------------------------
// 8. round trip
// ---------------------------------------------------------------------------------------------------------

test("8. archive → restore into a woken home: byte-equal for every class but secret_cp; secret_box 0600; .env merged; the store extracts to <t>/", async () => {
  const a = await archiveFixture("roundtrip");
  const { h } = a;
  const t = wakeTarget("roundtrip-t");
  const out = join(t.base, "approvald-out", "store.tar.gz");
  mkdirSync(dirname(out));
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
  // The store: outside the home only, 0600; it extracts to <t>/ with data/ one level down, without token files.
  expect(statSync(out).mode & 0o777).toBe(0o600);
  for (const rel of Object.keys(snapshotTree(t.root))) expect(rel).not.toMatch(/store\.tar\.gz|var\/lib\/approvald/);
  const tdir = join(t.base, "var-lib-approvald", TENANT);
  mkdirSync(tdir, { recursive: true });
  expect(spawnSync("tar", ["-xzf", out, "-C", tdir]).status).toBe(0);
  expect(readFileSync(join(tdir, "data", "APPROVAL.md"), "utf8")).toBe("# attested policy\n");
  expect(readFileSync(join(tdir, "sandbox-id"), "utf8")).toBe("old-sandbox\n");
  expect([existsSync(join(tdir, "env")), existsSync(join(tdir, "hook-token")), existsSync(join(tdir, TENANT))]).toEqual([false, false, false]);
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
  expect(Object.keys(all).filter((p) => p.endsWith(".tar.gz"))).toEqual([]);
  expect(a.files.some((f) => f.path === APPROVALD_STORE_ENTRY)).toBe(true);
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
