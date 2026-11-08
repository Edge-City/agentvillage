// The nap archive's box side (install/nap-archive.ts, install/nap-sqlite-fold.ts, install/nap-state-paths.ts):
// P-COST NAP design v2 section 8 box tests 1, 2, 2b, 2c, 2d, 3, 4, 5, 6 (7 and 8 are in restore-state.test.ts),
// section 12 (M2, N5, W5) and review-a's reads (M1-M3, S1, S4, S6, S10; S-n1 to S-n4, N-n1, N-n3).
// Synthetic homes and a loopback stub bucket only.
import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import { MANIFEST_KEYS, MANIFEST_PAYLOAD_KEYS, MANIFEST_TREE_KEYS, toolSha256 } from "../nap-common";
import { parseArgs, runArchive, type ArchiveHooks } from "../nap-archive";
import { BUNDLE_FILES, excludedBy, napStatePathsDocument, STORE_BLOB_ENTRY, STORE_MEMBERS_ENTRY, walkHome, WalkRefused } from "../nap-state-paths";
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
  SERVED,
  snapshotTree,
  decryptStoreBlob,
  stageStoreCopy,
  stagePaths,
  stagePutRun,
  STATE_DB_ROWS,
  tempBase,
  TENANT,
  wrapKeys,
} from "./fixtures/nap-home";
import { startStub, type Stub } from "./fixtures/put-stub";

const REPO = resolve(import.meta.dir, "..", "..");
const INSTALL = join(REPO, "install");
const SCRIPT = join(INSTALL, "nap-archive.ts");
const FOLD = join(INSTALL, "nap-sqlite-fold.ts");
const TOOL = toolSha256(INSTALL, BUNDLE_FILES)!;
const PATHS_SHA = createHash("sha256").update(JSON.stringify(napStatePathsDocument())).digest("hex");
const CHUNK = 65536;
const MEMBERS = ["data/APPROVAL.md", "data/chain.jsonl", "sandbox-id"];
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
  stub.onPut = () => undefined;
  stub.onGet = () => undefined;
});

type Home = NapHome & { proc: string };
function fresh(label: string, opts: { bigBytes?: number } = {}): Home {
  const base = tempBase(label);
  dirs.push(base);
  const h = buildNapHome(base, opts);
  const proc = join(base, "proc");
  mkdirSync(proc);
  return { ...h, proc };
}

function envFor(h: Home, extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: h.root,
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    NAP_WRAP_PUBLIC_KEY: wrapKeys().publicPem,
    NAP_PROC_ROOT: h.proc,
    NAP_UPLOAD_RETRY_MS: "5",
    NAP_UPLOAD_PARALLEL: "1",
    ...extra,
  };
}

const pathsFile = (h: NapHome) => join(napDir(h.home), "nap-state-paths.json");
function args(h: NapHome, runId: string, extra: string[] = [], o: { tool?: string; mode?: string } = {}): string[] {
  return [
    "--tenant", TENANT, "--root", h.root, "--home", h.home, "--run-id", runId, "--served-commit", SERVED,
    "--tool-sha256", o.tool ?? TOOL, "--mode", o.mode ?? "presigned", "--paths", pathsFile(h), "--chunk-bytes", String(CHUNK), ...extra,
  ];
}

/** The control plane's steps before the archive: run file, rules, the fold's own exec, the root piece's tar. */
function prepare(h: Home, runId: string, o: { slots?: number; ttlS?: number } = {}) {
  stagePutRun(stub, h.home, runId, o.slots ?? 64, o.ttlS ?? 3600);
  stagePaths(h.home);
  const fold = runFold(FOLD, h, runId);
  stageStoreCopy(h);
  return fold;
}

type Run = { code: number; line: any; stdout: string; stderr: string };
async function cli(h: Home, runId: string, extra: string[] = [], env: Record<string, string> = {}, o: { tool?: string; mode?: string } = {}): Promise<Run> {
  const p = Bun.spawn([process.execPath, "--no-env-file", "--no-install", SCRIPT, ...args(h, runId, extra, o)], {
    env: envFor(h, env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  const lines = stdout.trim().split("\n").filter(Boolean);
  return { code, line: lines.length ? JSON.parse(lines[lines.length - 1]) : null, stdout, stderr };
}

const storeBlob = (h: NapHome) => join(napDir(h.home), "approvald-store.enc");
const storeList = (h: NapHome) => join(napDir(h.home), "approvald-store.members.enc");
/** The plaintext member list's own bytes: its JSON key and every member's name-with-hash (release L43372). */
const listNeedles = (h: NapHome) => [
  '{"members":',
  ...MEMBERS.map((m) => createHash("sha256").update(readFileSync(join(h.approvaldDir, m))).digest("hex")),
];
/** Neither the plaintext store nor its plaintext list ever appears under the home (review-a (b), release
 * L43372): no member's bytes, no token, no member hash. */
function expectNoPlaintextStore(h: NapHome) {
  const needles = [PLANTED.approvaldEnv, PLANTED.approvaldHook, "# attested policy", '{"seq":0}', ...listNeedles(h)];
  const tree = snapshotTree(h.root);
  for (const rel of Object.keys(tree)) {
    if (tree[rel] === "special" || tree[rel].startsWith("link:")) continue;
    const text = readFileSync(join(h.root, rel)).toString("latin1");
    for (const n of needles) expect([rel, n, text.includes(n)]).toEqual([rel, n, false]);
  }
}
const progress = (h: NapHome) => JSON.parse(readFileSync(join(napDir(h.home), "progress.json"), "utf8"));
const putsSince = (from: number) => stub.requests.slice(from).filter((r) => r.method === "PUT").map((r) => r.key.slice(r.key.lastIndexOf("/") + 1));
const inProcess = (h: Home, runId: string, env: Record<string, string> = {}) => parseArgs(args(h, runId), envFor(h, env));

/** S-n3: after any exit the box reaches, no signing-key tar, run file or pid file is left in the home. */
function expectStagingGone(h: NapHome) {
  expect({
    blob: existsSync(storeBlob(h)),
    list: existsSync(storeList(h)),
    run: existsSync(join(napDir(h.home), "run.json")),
    pid: existsSync(join(napDir(h.home), "archive.pid")),
  }).toEqual({ blob: false, list: false, run: false, pid: false });
}

async function archived(h: Home, env: Record<string, string> = {}) {
  const runId = newRunId();
  expect(prepare(h, runId).code).toBe(0);
  const r = await cli(h, runId, [], env);
  expect({ code: r.code, status: r.line?.status, reason: r.line?.reason, stderr: r.stderr }).toEqual({ code: 0, status: "archived", reason: undefined, stderr: "" });
  const manifestBytes = publishManifest(stub, r.line.manifest_key);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const { tar, entries } = decryptPayload(stub, manifest);
  const files = JSON.parse(entries.get("files.json")!.toString("utf8")).files as any[];
  return { r, runId, manifest, manifestBytes, tar, entries, files };
}

/** After the fold, SQLite removes the sidecars, or keeps them emptied where WAL persistence is on (macOS's
 * system SQLite): whichever are on disk are archived like any other file. */
const sidecars = (h: NapHome) => [".hermes/state.db-shm", ".hermes/state.db-wal"].filter((rel) => existsSync(join(h.root, rel)));

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

// ---------------------------------------------------------------------------------------------------------
// 1. the whole home against the exclude list (13 M1), classes (13 M3), the approvald store (S-n2)
// ---------------------------------------------------------------------------------------------------------

test("1. every path under the home is archived except the exclude list, which is counted per name; classes right; unknown files kept", async () => {
  const h = fresh("walk");
  const { r, manifest, files } = await archived(h);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const home = files.filter((f) => !f.path.startsWith("/") && f.class !== "dir");
  // Exactly the fixture's included set: nothing else, nothing missing (directories: Fable S2's test).
  expect(home.map((f) => f.path)).toEqual([...Object.keys(h.included), ...sidecars(h)].sort());
  for (const [rel, cls] of Object.entries(h.included)) expect([rel, byPath.get(rel)?.class]).toEqual([rel, cls]);
  for (const rel of Object.keys(h.excluded)) expect([rel, byPath.has(rel)]).toEqual([rel, false]);
  // Unknown files at the root, in resident-chat/, cache/audio and legacy image_cache/ are archived.
  for (const rel of ["surprise.bin", ".hermes/brand-new-dir/unknown.dat", ".hermes/resident-chat/plan.md", ".hermes/cache/audio/v.ogg", ".hermes/image_cache/i.jpg"]) {
    expect([rel, byPath.has(rel)]).toEqual([rel, true]);
  }
  expect(byPath.get("surprise.bin").class).toBe("unclassified");
  // An unknown secret file is secret_box; the recall epoch marker is kept, the recall index is not.
  expect(byPath.get("notes/deploy.pem").class).toBe("secret_box");
  expect(byPath.get(".hermes/.recall/epoch").class).toBe("state");
  // Links recorded with their target, never followed; the hard-link pair read once.
  expect(byPath.get(".hermes/skills/linked")).toMatchObject({ class: "link", target: "edge" });
  expect(byPath.get(".hermes/memory/hard-b.md")).toMatchObject({ same_as: ".hermes/memory/hard-a.md" });
  // Per-exclude counts: every planted excluded path, under its name, with its size.
  const expected: Record<string, { files: number; bytes: number }> = {};
  for (const [rel, name] of Object.entries(h.excluded)) {
    const c = (expected[name] ??= { files: 0, bytes: 0 });
    c.files++;
    c.bytes += lstatSync(join(h.root, rel)).size;
  }
  expect(manifest.tree.excluded).toEqual(expected);
  // N-n3: the browser profile stays excluded, counted and flagged in the manifest.
  expect([manifest.tree.browser_profile_files, manifest.tree.browser_profile_dropped]).toEqual([1, true]);
  // S-n4: the bundle and the rules it ran by.
  expect([manifest.tool_sha256, manifest.paths_sha256, r.line.tool_sha256]).toEqual([TOOL, PATHS_SHA, TOOL]);
  // Counts agree everywhere.
  const count = (c: string) => files.filter((f) => f.class === c).length;
  expect(manifest.payload).toMatchObject({
    file_count: files.length,
    secret_cp_count: count("secret_cp"),
    secret_box_count: count("secret_box"),
    unclassified_count: count("unclassified"),
    link_count: count("link"),
    log_count: count("log"),
  });
  expect(r.line).toMatchObject({ files: files.length, secret_cp: count("secret_cp"), secret_box: count("secret_box"), unclassified: count("unclassified") });
  expectStagingGone(h);
});

test("(b), release L43372: the store copy is one opaque pair (encrypted blob, encrypted list); no member rows; the cp's counts as given; no plaintext", async () => {
  const h = fresh("store");
  const runId = newRunId();
  prepare(h, runId);
  const staged = { blob: readFileSync(storeBlob(h)), list: readFileSync(storeList(h)) };
  const r = await cli(h, runId, ["--store-count", "3", "--store-bytes", "4321"]);
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "archived" });
  const manifest = JSON.parse(publishManifest(stub, r.line.manifest_key).toString("utf8"));
  const { tar, entries } = decryptPayload(stub, manifest);
  const files = JSON.parse(entries.get("files.json")!.toString()).files as any[];
  // Both opaque entries, byte-for-byte as staged; their shas in the manifest.
  const at = (p: string) => files.findIndex((f) => f.path === p);
  for (const [path, bytes] of [[STORE_BLOB_ENTRY, staged.blob], [STORE_MEMBERS_ENTRY, staged.list]] as const) {
    const i = at(path);
    expect([path, files[i].class, entries.get(`data/${String(i).padStart(6, "0")}`)!.equals(bytes)]).toEqual([path, "state", true]);
  }
  expect([manifest.store_copy, manifest.store_blob_sha256, manifest.store_members_sha256]).toEqual(["blob", sha(staged.blob), sha(staged.list)]);
  expect([manifest.store_member_count, manifest.store_total_bytes]).toEqual([3, 4321]); // recorded as given, never checked
  // The pair is the only thing outside the home: no member rows (the cp decrypts the list and does the parity).
  expect(files.filter((f) => f.path.startsWith("/")).map((f) => f.path)).toEqual([STORE_BLOB_ENTRY, STORE_MEMBERS_ENTRY]);
  expect(Object.keys(manifest.tree)).not.toContain("approvald_files");
  // The list the cp staged is ciphertext: the cp's key opens it to its members, the box never did.
  expect(JSON.parse(decryptStoreBlob(staged.list).toString()).members.map((m: any) => m.path)).toEqual(MEMBERS);
  // No plaintext store or list byte in the payload or the home.
  for (const n of ["# attested policy", '{"seq":0}', PLANTED.approvaldEnv, PLANTED.approvaldHook, ...listNeedles(h)]) {
    expect(tar.toString("latin1")).not.toContain(n);
  }
  expectNoPlaintextStore(h);
  expectStagingGone(h);
});

test("(b), release L43372: the box never parses the list; any bytes archive; no counts given records null", async () => {
  const h = fresh("store-opaque");
  const runId = newRunId();
  prepare(h, runId);
  writeFileSync(storeList(h), Buffer.from([0, 255, 1, 254, 0x7b]), { mode: 0o600 });
  const r = await cli(h, runId);
  expect({ code: r.code, status: r.line.status, reason: r.line.reason }).toEqual({ code: 0, status: "archived", reason: undefined });
  const manifest = JSON.parse(publishManifest(stub, r.line.manifest_key).toString("utf8"));
  expect([manifest.store_members_sha256, manifest.store_member_count, manifest.store_total_bytes]).toEqual([sha(Buffer.from([0, 255, 1, 254, 0x7b])), null, null]);
  expectStagingGone(h);
});

test("(a): with --no-store-copy and nothing staged the manifest records store_copy none, no rows; any partial staging refuses 64", async () => {
  const h = fresh("no-store");
  const runId = newRunId();
  prepare(h, runId);
  rmSync(storeBlob(h));
  rmSync(storeList(h));
  const r = await cli(h, runId, ["--no-store-copy"]);
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "archived" });
  const manifest = JSON.parse(publishManifest(stub, r.line.manifest_key).toString("utf8"));
  expect([manifest.store_copy, manifest.store_blob_sha256, manifest.store_members_sha256, manifest.store_member_count, manifest.store_total_bytes])
    .toEqual(["none", null, null, null, null]);
  const files = JSON.parse(decryptPayload(stub, manifest).entries.get("files.json")!.toString()).files as any[];
  expect(files.filter((f) => f.path.startsWith("/"))).toEqual([]);
  // Counts describe a store copy: with --no-store-copy they are a usage error (2), before anything runs.
  const u = await cli(h, newRunId(), ["--no-store-copy", "--store-count", "1"]);
  expect([u.code, u.line]).toEqual([2, null]);
});

test("the exclude list: rebuildable trees, installer-built trees, pids and the nap dir; never SQLite sidecars, media or unknown dirs", () => {
  const rules = { hermesRel: ".hermes" };
  for (const rel of [".hermes/hermes-agent/x", ".hermes/edge-src/x", ".hermes/bin/x", ".bun/bin/bun", ".bun/install/cache/x", "a/node_modules/b",
    "a/.venv/b", "a/venv/b", "a/site-packages/b", "a/__pycache__/b", "a/b.pyc", ".hermes/gateway.pid", ".hermes/cron.pid", ".hermes/gateway.lock",
    ".hermes/processes.json", ".hermes/av-events/nap/progress.json", ".hermes/browser-profile/x", ".hermes/.recall/index.db", ".cache/x"]) {
    expect([rel, excludedBy(rel, rules)]).not.toEqual([rel, null]);
  }
  // A directory name rule matches a directory, never a file of that name (Fable S3).
  for (const rel of ["notes/venv", "notes/.cache", "a/node_modules"]) {
    expect([rel, excludedBy(rel, rules, true)]).not.toEqual([rel, null]);
    expect([rel, excludedBy(rel, rules, false)]).toEqual([rel, null]);
  }
  for (const rel of [".hermes/state.db-wal", ".hermes/state.db-shm", "x/a.sqlite-journal", ".hermes/kanban.db", ".hermes/cache/images/a",
    ".hermes/image_cache/a", ".hermes/.recall/epoch", ".local/share/x", "project/.git/HEAD", ".hermes/backups/x", ".bun/install/global/x",
    "x/cron.pid", "project/processes.json", "project/gateway.lock", ".hermes/skills/x/gateway.pid"]) {
    expect([rel, excludedBy(rel, rules)]).toEqual([rel, null]);
  }
});

test("the shared path rules print as one JSON document for the control plane's count (S-n4: the same bytes the box checks)", () => {
  const p = spawnSync(process.execPath, ["--no-env-file", "--no-install", join(INSTALL, "nap-state-paths.ts")], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  });
  expect(p.status).toBe(0);
  expect(p.stdout.trim()).toBe(JSON.stringify(napStatePathsDocument()));
  const doc = JSON.parse(p.stdout);
  expect(doc.cp_remintable.env_keys).toContain("AV_EVENTS_TOKEN");
  expect(doc.bundle_files).toEqual([...BUNDLE_FILES]);
  expect(doc.browser_profile).toEqual({ exclude: "browser_profile", archived: false });
});

// ---------------------------------------------------------------------------------------------------------
// 2. refusals: exit 64 before any write (but progress.json), nothing uploaded
// ---------------------------------------------------------------------------------------------------------

async function expectRefusal(
  h: Home,
  reason: string,
  o: { env?: Record<string, string>; tool?: string; mode?: string; extra?: string[]; after?: (runId: string) => void } = {},
) {
  const runId = newRunId();
  prepare(h, runId);
  o.after?.(runId);
  const before = stub.requests.length;
  const r = await cli(h, runId, o.extra ?? [], o.env ?? {}, o);
  expect({ reason, code: r.code, line: r.line }).toEqual({ reason, code: 64, line: { status: "refused", reason, chunks_acked: 0 } });
  expect(stub.requests.length).toBe(before);
  // Only the cp's own inputs and progress.json in the nap dir: no chunk, no pid, no run file, no store tar.
  const left = readdirSync(napDir(h.home)).filter((n) => !["progress.json", "nap-state-paths.json", "fold.json"].includes(n));
  expect([reason, left]).toEqual([reason, []]);
  expect(progress(h)).toMatchObject({ phase: "refused", reason });
  expectNoPlaintextStore(h);
}

test("2. refusals exit 64 before any write: key, run file, URL, transport, bundle, rules, fold, WAL, writers, store tar, link", async () => {
  const h = fresh("refuse");
  const nap = napDir(h.home);
  await expectRefusal(h, "public_key_missing", { env: { NAP_WRAP_PUBLIC_KEY: "" } });
  await expectRefusal(h, "public_key_invalid", { env: { NAP_WRAP_PUBLIC_KEY: "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n" } });
  await expectRefusal(h, "public_key_invalid", { env: { NAP_WRAP_PUBLIC_KEY: wrapKeys().privatePem } });
  const weak = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
  await expectRefusal(h, "public_key_invalid", { env: { NAP_WRAP_PUBLIC_KEY: weak } });
  await expectRefusal(h, "transport_not_built", { mode: "ingest" }); // the ingest route is parked
  await expectRefusal(h, "tool_mismatch", { tool: "0".repeat(64) });
  await expectRefusal(h, "paths_missing", { after: () => rmSync(pathsFile(h)) });
  // The cp's rules with one exclude dropped: the count and the walk would disagree, so it refuses.
  const doc = JSON.parse(JSON.stringify(napStatePathsDocument()));
  doc.excludes = doc.excludes.filter((e: { name: string }) => e.name !== "node_modules");
  await expectRefusal(h, "paths_mismatch", { after: () => stagePaths(h.home, doc) });
  await expectRefusal(h, "run_file_missing", { after: () => rmSync(join(nap, "run.json")) });
  await expectRefusal(h, "run_file_mode", { after: () => chmodSync(join(nap, "run.json"), 0o644) });
  const editRun = (fn: (doc: any) => void) => () => {
    const path = join(nap, "run.json");
    const d = JSON.parse(readFileSync(path, "utf8"));
    fn(d);
    writeFileSync(path, JSON.stringify(d), { mode: 0o600 });
  };
  await expectRefusal(h, "url_not_allowed", { after: editRun((d) => (d.chunks[1].url = d.chunks[1].url.replace(stub.base, "http://example.com"))) });
  await expectRefusal(h, "url_not_allowed", { after: editRun((d) => (d.chunks[1].url = d.chunks[2].url)) }); // a URL for another key
  // S-n1: the fold's record must be this run's.
  await expectRefusal(h, "fold_missing", { after: () => rmSync(join(nap, "fold.json")) });
  await expectRefusal(h, "fold_mismatch", { after: () => expect(runFold(FOLD, h, newRunId()).code).toBe(0) });
  // A writer came back (13 S6).
  mkdirSync(join(h.proc, "4242"));
  writeFileSync(join(h.proc, "4242", "cmdline"), "bash\0-lc\0while true; do hermes gateway run; sleep 2; done\0");
  await expectRefusal(h, "writers_alive");
  rmSync(join(h.proc, "4242"), { recursive: true });
  // The store copy (review-a (b)): both or (with --no-store-copy) neither; 0600 regular files.
  await expectRefusal(h, "store_copy_missing", { after: () => (rmSync(storeBlob(h)), rmSync(storeList(h))) });
  await expectRefusal(h, "store_copy_partial", { after: () => rmSync(storeBlob(h)) });
  await expectRefusal(h, "store_copy_partial", { after: () => rmSync(storeList(h)) });
  await expectRefusal(h, "store_copy_unexpected", { extra: ["--no-store-copy"] });
  await expectRefusal(h, "store_copy_unexpected", { extra: ["--no-store-copy"], after: () => rmSync(storeList(h)) });
  await expectRefusal(h, "store_copy_mode", { after: () => chmodSync(storeBlob(h), 0o644) });
  await expectRefusal(h, "store_copy_mode", { after: () => chmodSync(storeList(h), 0o640) });
  // Fable read 2 S1: a zero-byte blob or list (a cut root-piece write) is never a store copy.
  await expectRefusal(h, "store_copy_invalid", { after: () => writeFileSync(storeBlob(h), "", { mode: 0o600 }) });
  await expectRefusal(h, "store_copy_invalid", { after: () => writeFileSync(storeList(h), "", { mode: 0o600 }) });
  // Still archives once every cause is gone.
  await archived(h);
});

test("2 / S-n1: a -wal of any name the fold cannot empty refuses; one that fills after the fold refuses; the fold never destroys bytes", async () => {
  const h = fresh("wal-refuse");
  // A `-wal` beside a file that is not SQLite: the fold must not open it, so its bytes stay and it refuses.
  const blob = join(h.home, "plugin-data", "store.bin-wal");
  mkdirSync(dirname(blob), { recursive: true });
  writeFileSync(join(h.home, "plugin-data", "store.bin"), "not sqlite"); // its main file (no main: an orphan, review-a N3)
  writeFileSync(blob, "wal bytes that stay");
  let runId = newRunId();
  const fold = prepare(h, runId);
  expect({ code: fold.code, line: fold.line }).toEqual({ code: 64, line: { status: "refused", reason: "wal_unfolded", db_count: 1, wal_folded: 1, wal_unfolded: 1, wal_orphan: 0 } });
  expect(readFileSync(blob, "utf8")).toBe("wal bytes that stay");
  let r = await cli(h, runId);
  expect({ code: r.code, line: r.line }).toEqual({ code: 64, line: { status: "refused", reason: "wal_unfolded", chunks_acked: 0 } });
  expectStagingGone(h);
  rmSync(blob);
  // The fold ran clean, then a writer left a WAL: the archive's own check refuses; it never folds.
  runId = newRunId();
  expect(prepare(h, runId).code).toBe(0);
  writeFileSync(join(h.home, "kanban.db-wal"), "late wal bytes");
  r = await cli(h, runId);
  expect(r.line).toEqual({ status: "refused", reason: "wal_unfolded", chunks_acked: 0 });
  expect(readFileSync(join(h.home, "kanban.db-wal"), "utf8")).toBe("late wal bytes");
});

// ---------------------------------------------------------------------------------------------------------
// 2b. the WAL fold (13 S1), its own exec before the root count (S-n1)
// ---------------------------------------------------------------------------------------------------------

test("2b. state.db with rows only in its -wal is folded by the fold exec; the archived db holds the last row; db_count and wal_folded in the manifest", async () => {
  const h = fresh("wal");
  expect(lstatSync(join(h.home, "state.db-wal")).size).toBeGreaterThan(0);
  const { manifest, files, entries } = await archived(h);
  expect([manifest.tree.db_count, manifest.tree.wal_folded]).toEqual([1, 1]);
  expect(files.some((f) => f.path.endsWith("-wal") && f.bytes > 0)).toBe(false);
  const i = files.findIndex((f) => f.path === ".hermes/state.db");
  const copy = join(h.base, "copy.db");
  writeFileSync(copy, entries.get(`data/${String(i).padStart(6, "0")}`)!);
  const { Database } = await import("bun:sqlite");
  const db = new Database(copy); // alone, without its sidecars
  const row = db.query("SELECT count(*) AS n, max(x) AS last FROM t").get() as { n: number; last: number };
  db.close();
  expect(row).toEqual({ n: STATE_DB_ROWS, last: STATE_DB_ROWS - 1 });
  // The fold's record (the cp copies it to its row, the archive into the manifest).
  expect(JSON.parse(readFileSync(join(napDir(h.home), "fold.json"), "utf8"))).toMatchObject({ schema: "nap_fold.v1", db_count: 1, wal_folded: 1, wal_unfolded: 0 });
});

// ---------------------------------------------------------------------------------------------------------
// 2c. S10: nothing is ever skipped
// ---------------------------------------------------------------------------------------------------------

test("2c. a file that changes during the walk or before it is packed, or cannot be read, fails the run: exit 1, no manifest, no skipped key", async () => {
  const h = fresh("changed");
  const target = join(h.home, "sessions", "s1.jsonl");
  const once = (fn: () => void): ((rel: string) => void) => {
    let done = false;
    return (rel) => {
      if (!done && rel === ".hermes/sessions/s1.jsonl") {
        done = true;
        fn();
      }
    };
  };
  const outputs: string[] = [];
  const expectFailed = async (reason: string, run: (runId: string) => Promise<{ code: number; line: unknown }>) => {
    const runId = newRunId();
    prepare(h, runId);
    const before = stub.requests.length;
    const out = await run(runId);
    expect({ reason, code: out.code, line: out.line }).toEqual({ reason, code: 1, line: { status: "error", reason, chunks_acked: 0 } });
    expect(progress(h)).toMatchObject({ phase: "failed", reason });
    expect(progress(h).stream).toBeUndefined();
    expect(existsSync(join(napDir(h.home), "chunks"))).toBe(false);
    expect(putsSince(before)).toEqual([]);
    expectStagingGone(h);
    outputs.push(JSON.stringify(out.line), readFileSync(join(napDir(h.home), "progress.json"), "utf8"));
  };
  await expectFailed("file_changed", (runId) => runArchive(inProcess(h, runId), { afterHash: once(() => writeFileSync(target, "changed during the read\n")) }));
  await expectFailed("file_changed", (runId) => runArchive(inProcess(h, runId), { beforePack: once(() => writeFileSync(target, "changed after the hash\n")) }));
  if (process.getuid?.() !== 0) {
    chmodSync(target, 0o000);
    await expectFailed("file_unreadable", (runId) => cli(h, runId));
    chmodSync(target, 0o644);
    chmodSync(join(h.home, "resident-chat"), 0o000);
    await expectFailed("file_unreadable", (runId) => cli(h, runId));
    chmodSync(join(h.home, "resident-chat"), 0o755);
  }
  for (const text of outputs) expect(text).not.toContain("skipped");
});

// ---------------------------------------------------------------------------------------------------------
// 2d. M2 support: the script's own totals equal an independent count under the same exclude list
// ---------------------------------------------------------------------------------------------------------

/** The parity convention (README "Nap: state archive and restore", Fable S6): find's predicates, verbatim. */
const PARITY = {
  files: ["-xdev", "-mindepth", "1", "(", "-type", "f", "-o", "-type", "l", ")"],
  dirs: ["-xdev", "-mindepth", "1", "-type", "d"],
  endpoints: ["-xdev", "-mindepth", "1", "(", "-type", "s", "-o", "-type", "p", ")"],
};

test("2d / S6. live_files, live_bytes and live_dirs equal find(1) under the README's predicates and the same excludes; live + excluded = everything", async () => {
  const h = fresh("count");
  const { manifest } = await archived(h);
  const find = (preds: string[]) => spawnSync("find", [h.root, ...preds], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  const rules = { hermesRel: ".hermes" };
  let live = 0;
  let liveBytes = 0;
  let excluded = 0;
  for (const path of find(PARITY.files)) {
    const st = lstatSync(path);
    const why = excludedBy(relative(h.root, path), rules, false);
    if (why === "nap_dir") continue; // pruned from both counts
    if (why) excluded++;
    else {
      live++;
      liveBytes += st.size; // a symlink's lstat size is its target's length
    }
  }
  let dirs = 0;
  for (const path of find(PARITY.dirs)) if (!excludedBy(relative(h.root, path), rules, true)) dirs++;
  for (const path of find(PARITY.endpoints)) if (excludedBy(relative(h.root, path), rules, false) !== "nap_dir") excluded++;
  expect([manifest.tree.live_files, manifest.tree.live_bytes, manifest.tree.live_dirs]).toEqual([live, liveBytes, dirs]);
  expect(Object.values(manifest.tree.excluded as Record<string, { files: number }>).reduce((n, c) => n + c.files, 0)).toBe(excluded);
  // The README states exactly these predicates.
  const readme = readFileSync(join(REPO, "README.md"), "utf8");
  for (const preds of Object.values(PARITY)) {
    const text = preds.map((p) => (p === "(" ? "\\(" : p === ")" ? "\\)" : p)).join(" ");
    expect([text, readme.includes(`find "$HOME" ${text}`)]).toEqual([text, true]);
  }
});

// ---------------------------------------------------------------------------------------------------------
// 3. chunking
// ---------------------------------------------------------------------------------------------------------

test("3. chunks are each at most --chunk-bytes, listed in order with sizes and hashes; together they decrypt to a tar matching files.json", async () => {
  const h = fresh("chunks", { bigBytes: 300 * 1024 });
  const { manifest, entries, files } = await archived(h);
  expect(manifest.chunks.length).toBeGreaterThanOrEqual(4);
  manifest.chunks.forEach((c: any, n: number) => {
    expect(c.n).toBe(n);
    expect(c.name).toBe(`chunk-${String(n).padStart(4, "0")}.bin`);
    const obj = stub.objects.get(`${manifest.prefix}${c.name}`)!;
    expect(obj.length).toBe(c.bytes);
    expect(c.bytes).toBeLessThanOrEqual(CHUNK);
    if (n < manifest.chunks.length - 1) expect(c.bytes).toBe(CHUNK);
    expect(sha(obj)).toBe(c.sha256);
  });
  expect([...entries.keys()][0]).toBe("files.json");
  // Every regular file's data entry: its index name, its size and its hash (data M1: sha256 + size for every file).
  let dataEntries = 0;
  files.forEach((f, i) => {
    expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isSafeInteger(f.bytes)).toBe(true);
    if (f.class === "link" || f.class === "dir" || f.same_as) return;
    const data = entries.get(`data/${String(i).padStart(6, "0")}`)!;
    expect(data.length).toBe(f.bytes);
    expect(sha(data)).toBe(f.sha256);
    dataEntries++;
  });
  expect(entries.size).toBe(dataEntries + 1);
  expect(files.find((f) => f.path === ".hermes/sessions/big.bin").bytes).toBe(300 * 1024);
});

// ---------------------------------------------------------------------------------------------------------
// 4. resume (13 S6), the pid file, a second start, a gateway that comes back
// ---------------------------------------------------------------------------------------------------------

test("4. killed after chunk 2 is acked with stream_complete: a re-run PUTs only the rest from the persisted key material; one manifest that decrypts", async () => {
  const h = fresh("resume", { bigBytes: 300 * 1024 });
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  stub.onPut = (key) => (key.endsWith("chunk-0002.bin") ? "hang" : undefined);
  const p = Bun.spawn([process.execPath, "--no-env-file", "--no-install", SCRIPT, ...args(h, runId)], { env: envFor(h), stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 400 && !putsSince(before).includes("chunk-0002.bin"); i++) await Bun.sleep(25);
  expect(putsSince(before)).toEqual(["chunk-0000.bin", "chunk-0001.bin", "chunk-0002.bin"]);
  expect(readFileSync(join(napDir(h.home), "archive.pid"), "utf8").trim()).toBe(String(p.pid)); // held for the run's life
  p.kill("SIGKILL");
  await p.exited;
  const doc = progress(h);
  expect(doc).toMatchObject({ phase: "running", step: "uploading", acked: [0, 1] });
  expect(doc.stream).toMatchObject({ stream_complete: true, run_id: runId, tool_sha256: TOOL });
  for (const k of ["wrapped_key_b64", "iv_b64", "gcm_tag_b64", "key_id"]) expect(typeof doc.stream[k]).toBe("string");
  expect(lstatSync(join(napDir(h.home), "progress.json")).mode & 0o777).toBe(0o600);
  expect(existsSync(join(napDir(h.home), "chunks", "chunk-0000.bin"))).toBe(false); // acked chunks are deleted
  stub.onPut = () => undefined;
  prepare(h, runId);
  const mid = stub.requests.length;
  const r = await cli(h, runId);
  expect({ code: r.code, status: r.line.status }).toEqual({ code: 0, status: "archived" });
  const total = doc.stream.chunks.length;
  expect(putsSince(mid)).toEqual([...Array.from({ length: total - 2 }, (_, k) => `chunk-${String(k + 2).padStart(4, "0")}.bin`), "state_manifest.json"]);
  const manifest = JSON.parse(publishManifest(stub, r.line.manifest_key).toString("utf8"));
  expect(manifest.wrapped_key_b64).toBe(doc.stream.wrapped_key_b64);
  expect(decryptPayload(stub, manifest).entries.has("files.json")).toBe(true);
  expectStagingGone(h);
  expect(existsSync(join(napDir(h.home), "chunks"))).toBe(false);
});

test("4. killed mid-stream: the same run id fails resume_needs_new_run and drops its chunks; a new run never names the old ones", async () => {
  const h = fresh("midstream");
  const runId = newRunId();
  prepare(h, runId);
  let snapshot = "";
  const out = await runArchive(inProcess(h, runId), {
    beforePack: (rel) => {
      if (rel === ".hermes/sessions/big.bin") {
        snapshot = readFileSync(join(napDir(h.home), "progress.json"), "utf8");
        throw new Error("simulated crash mid-stream");
      }
    },
  });
  expect(out.code).toBe(1);
  // What a crash at that moment leaves: the stream started (key material on record), not complete, a .part.
  const crashed = JSON.parse(snapshot);
  expect(crashed.stream).toMatchObject({ stream_complete: false });
  writeFileSync(join(napDir(h.home), "progress.json"), JSON.stringify({ ...crashed, pid: 999999999 }), { mode: 0o600 });
  mkdirSync(join(napDir(h.home), "chunks"), { recursive: true });
  writeFileSync(join(napDir(h.home), "chunks", "0000.part"), "partial");
  prepare(h, runId);
  const before = stub.requests.length;
  const again = await cli(h, runId);
  expect({ code: again.code, line: again.line }).toEqual({ code: 1, line: { status: "error", reason: "resume_needs_new_run", chunks_acked: 0 } });
  expect(existsSync(join(napDir(h.home), "chunks"))).toBe(false);
  expect(progress(h).stream).toBeUndefined();
  expect(putsSince(before)).toEqual([]);
  const next = await archived(h);
  expect(next.manifest.prefix).toContain(next.runId);
  expect(next.manifest.prefix).not.toContain(runId);
  expect(next.manifest.wrapped_key_b64).not.toBe(crashed.stream.wrapped_key_b64);
});

test("a second start while a live run holds progress.json or the pid file refuses, touching nothing; a finished run refuses and drops the store tar", async () => {
  const h = fresh("running");
  const sleeper = Bun.spawn(["sleep", "30"]);
  try {
    const runId = newRunId();
    prepare(h, runId);
    const progressPath = join(napDir(h.home), "progress.json");
    const live = { schema: "nap_progress.v1", phase: "running", pid: sleeper.pid, run_id: runId, started_at: "x", updated_at: "x", acked: [] };
    writeFileSync(progressPath, JSON.stringify(live));
    let r = await cli(h, runId);
    expect({ code: r.code, line: r.line }).toEqual({ code: 64, line: { status: "refused", reason: "nap_already_running", chunks_acked: 0 } });
    expect(JSON.parse(readFileSync(progressPath, "utf8"))).toEqual(live);
    expect([existsSync(join(napDir(h.home), "run.json")), existsSync(storeBlob(h)), existsSync(storeList(h))]).toEqual([true, true, true]); // the live run's inputs
    rmSync(progressPath);
    writeFileSync(join(napDir(h.home), "archive.pid"), `${sleeper.pid}\n`);
    r = await cli(h, runId);
    expect(r.line).toMatchObject({ status: "refused", reason: "nap_already_running" });
    expect(existsSync(progressPath)).toBe(false);
  } finally {
    sleeper.kill();
  }
  rmSync(join(napDir(h.home), "archive.pid"));
  const { runId } = await archived(h);
  prepare(h, runId);
  const again = await cli(h, runId);
  expect(again.line).toMatchObject({ status: "refused", reason: "run_already_archived" });
  expectStagingGone(h);
});

test("S6: the gateway coming back mid-run aborts it; no stream of that run survives; the pid file was held and is released", async () => {
  const h = fresh("gateway", { bigBytes: 300 * 1024 });
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  let pidSeen = "";
  const hooks: ArchiveHooks = {
    beforeUpload: (n) => {
      pidSeen ||= readFileSync(join(napDir(h.home), "archive.pid"), "utf8").trim();
      if (n === 1) {
        mkdirSync(join(h.proc, "777"));
        writeFileSync(join(h.proc, "777", "cmdline"), "/home/hermes/.hermes/hermes-agent/venv/bin/python\0/home/hermes/.local/bin/hermes\0gateway\0run\0");
      }
    },
  };
  const out = await runArchive(inProcess(h, runId), hooks);
  expect(out).toEqual({ code: 1, line: { status: "error", reason: "gateway_running", chunks_acked: 1 } });
  expect(pidSeen).toBe(String(process.pid));
  expectStagingGone(h);
  expect(existsSync(join(napDir(h.home), "chunks"))).toBe(false);
  expect(progress(h).stream).toBeUndefined();
  expect(putsSince(before)).not.toContain("state_manifest.json");
});

// ---------------------------------------------------------------------------------------------------------
// 5. transport refusals; S-n3 on a signal
// ---------------------------------------------------------------------------------------------------------

test("5. 401 → auth_refused; 403 (an expired URL) → url_expired; 503 retried then given up; each exit 1 with the acks kept", async () => {
  const h = fresh("transport");
  const cases: [(key: string) => number | undefined, string, number][] = [
    [(k) => (k.endsWith("chunk-0001.bin") ? 401 : undefined), "auth_refused", 1],
    [(k) => (k.endsWith("chunk-0000.bin") ? 403 : undefined), "url_expired", 0],
    [(k) => (k.endsWith("chunk-0002.bin") ? 503 : undefined), "upload_unavailable", 2],
  ];
  for (const [onPut, reason, acked] of cases) {
    const runId = newRunId();
    prepare(h, runId);
    const before = stub.requests.length;
    stub.onPut = onPut;
    const r = await cli(h, runId);
    expect({ code: r.code, line: r.line }).toEqual({ code: 1, line: { status: "error", reason, chunks_acked: acked } });
    expect(progress(h)).toMatchObject({ phase: "failed", reason, acked: Array.from({ length: acked }, (_, k) => k) });
    expect(readdirSync(join(napDir(h.home), "chunks")).filter((n) => n.endsWith(".part"))).toEqual([]);
    // A transport failure after the stream completed is resumable: the run file and pid go, the staged
    // store pair stays (Fable read 2 S2).
    expect([existsSync(join(napDir(h.home), "run.json")), existsSync(join(napDir(h.home), "archive.pid"))]).toEqual([false, false]);
    expect([existsSync(storeBlob(h)), existsSync(storeList(h))]).toEqual([true, true]);
    if (reason === "upload_unavailable") expect(putsSince(before).filter((n) => n === "chunk-0002.bin").length).toBe(4);
  }
  // A URL that has really expired is a 403 from the bucket: url_expired, and the cp re-mints.
  stub.onPut = () => undefined;
  const runId = newRunId();
  prepare(h, runId, { ttlS: -10 });
  expect((await cli(h, runId)).line).toMatchObject({ status: "error", reason: "url_expired" });
});

test("5 / S-n3: TERM mid-upload exits 143 and leaves no store tar, run file, pid file or .part; the stub refuses a DELETE", async () => {
  const h = fresh("term", { bigBytes: 300 * 1024 });
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  stub.onPut = (key) => (key.endsWith("chunk-0001.bin") ? "hang" : undefined);
  const p = Bun.spawn([process.execPath, "--no-env-file", "--no-install", SCRIPT, ...args(h, runId)], { env: envFor(h), stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 400 && !putsSince(before).includes("chunk-0001.bin"); i++) await Bun.sleep(25);
  expect([existsSync(storeBlob(h)), existsSync(storeList(h))]).toEqual([true, true]); // staged inputs until the run ends
  p.kill("SIGTERM");
  expect(await p.exited).toBe(143);
  const line = JSON.parse((await new Response(p.stdout).text()).trim().split("\n").pop()!);
  expect(line).toEqual({ status: "error", reason: "interrupted", chunks_acked: 1 });
  expectStagingGone(h);
  expect(readdirSync(join(napDir(h.home), "chunks")).filter((n) => n.endsWith(".part"))).toEqual([]);
  expect(progress(h)).toMatchObject({ phase: "failed", reason: "interrupted" });
  expectNoPlaintextStore(h);
  // A chunk already in the bucket cannot be deleted with the writer's URLs (13 S7).
  const key = `nap/${TENANT}/2026-11-08/${runId}/chunk-0000.bin`;
  const del = await fetch(stub.url("DELETE", key), { method: "DELETE" });
  expect(del.status).toBe(403);
  expect(stub.objects.has(key)).toBe(true);
});

// ---------------------------------------------------------------------------------------------------------
// 6. secrets never in clear outside the ciphertext; the manifest is provider-neutral (12 W5); 12 M2
// ---------------------------------------------------------------------------------------------------------

test("6. planted secrets and paths never reach stdout, stderr, progress.json or the manifest; the manifest names no provider object", async () => {
  const h = fresh("secrets");
  const env = { RAILWAY_SANDBOX_ID: "sbx-planted-railway-id-31337", RAILWAY_CHECKPOINT: "nap-planted-checkpoint-name" };
  const { r, manifestBytes, manifest, tar } = await archived(h, env);
  const progressText = readFileSync(join(napDir(h.home), "progress.json"), "utf8");
  for (const text of [r.stdout, r.stderr, progressText, manifestBytes.toString("utf8")]) {
    for (const secret of Object.values(PLANTED)) expect(text).not.toContain(secret);
    expect(text).not.toContain(h.base);
    expect(text).not.toContain(".hermes");
    expect(text).not.toContain("sbx-planted");
    expect(text).not.toContain("nap-planted-checkpoint");
    expect(text).not.toContain("BEGIN PUBLIC KEY");
  }
  // 13 S4 and review-a (b): no plaintext store byte (member contents, the daemon's tokens) in the home or
  // the payload; the store rides only as the cp-encrypted blob.
  expectNoPlaintextStore(h);
  for (const n of [PLANTED.approvaldEnv, PLANTED.approvaldHook, "# attested policy"]) expect(tar.toString("latin1")).not.toContain(n);
  // W5: exactly the format's keys, none naming a provider object; no value is a filesystem path but the
  // approvald virtual prefix in files.json (not in the manifest).
  expect(Object.keys(manifest).sort()).toEqual([...MANIFEST_KEYS].sort());
  expect(Object.keys(manifest.payload).sort()).toEqual([...MANIFEST_PAYLOAD_KEYS].sort());
  expect(Object.keys(manifest.tree).sort()).toEqual([...MANIFEST_TREE_KEYS].sort());
  const keys: string[] = [];
  const values: [string, string][] = [];
  const walk = (v: unknown, key = "") => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (keys.push(k), walk(x, k));
    else if (typeof v === "string") values.push([key, v]);
  };
  walk(manifest);
  for (const k of keys) expect(k).not.toMatch(/railway|sandbox|checkpoint|service|volume|deployment|domain|host/i);
  // Base64 may start with "/"; every other string value must not look like a path.
  for (const [k, v] of values) if (!k.endsWith("_b64")) expect([k, v.startsWith("/")]).toEqual([k, false]);
});

test("6 / 12 M2: no box-side file reads NAP_WRAP_PRIVATE_KEY or any private key; the archive script decrypts nothing", () => {
  const hits: string[] = [];
  for (const name of readdirSync(INSTALL)) {
    if (!name.endsWith(".ts")) continue;
    const text = readFileSync(join(INSTALL, name), "utf8");
    if (text.includes("NAP_WRAP_PRIVATE_KEY")) hits.push(name);
  }
  expect(hits).toEqual([]);
  for (const name of BUNDLE_FILES) {
    const text = readFileSync(join(INSTALL, name), "utf8");
    expect([name, /privateDecrypt|createPrivateKey/.test(text)]).toEqual([name, false]);
  }
  expect(readFileSync(SCRIPT, "utf8")).not.toMatch(/createDecipheriv/);
});

// ---------------------------------------------------------------------------------------------------------
// N-n1: batch 0's dry count
// ---------------------------------------------------------------------------------------------------------

test("N-n1: --dry-run counts with the writers live, no key, no run file and no fold; reports unreadable files and live WALs; writes nothing", async () => {
  const h = fresh("dry");
  mkdirSync(join(h.proc, "4242"));
  writeFileSync(join(h.proc, "4242", "cmdline"), "hermes\0gateway\0run\0");
  const unreadable = process.getuid?.() !== 0;
  const before = snapshotTree(h.root);
  if (unreadable) chmodSync(join(h.home, "sessions", "s1.jsonl"), 0o000);
  const p = Bun.spawn(
    [process.execPath, "--no-env-file", "--no-install", SCRIPT, "--tenant", TENANT, "--root", h.root, "--home", h.home, "--dry-run"],
    { env: { ...envFor(h), NAP_WRAP_PUBLIC_KEY: "" }, stdout: "pipe", stderr: "pipe" },
  );
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (unreadable) chmodSync(join(h.home, "sessions", "s1.jsonl"), 0o644);
  expect(code).toBe(0);
  const line = JSON.parse(stdout.trim());
  expect(line).toMatchObject({
    status: "dry_run",
    tool_sha256: TOOL,
    paths_sha256: PATHS_SHA,
    unreadable: unreadable ? 1 : 0,
    unsupported: 0,
    not_owned: 0,
    wal_nonempty: 1,
    store_copy_staged: "blob",
    browser_profile_files: 1,
  });
  expect(line.live_files).toBe(Object.keys(h.included).length + 2); // + state.db's -wal and -shm before the fold
  expect(snapshotTree(h.root)).toEqual(before);
});

// ---------------------------------------------------------------------------------------------------------
// The box's runtime contract (S-n4): bun --no-install from the pinned bundle alone
// ---------------------------------------------------------------------------------------------------------

function importGraph(root: string, entry: string): { files: string[]; bare: string[] } {
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const seen = new Set<string>();
  const bare: string[] = [];
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { path: spec } of transpiler.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (spec.startsWith("node:") || spec.startsWith("bun:")) continue;
      if (spec.startsWith(".")) walk(`${resolve(dirname(file), spec)}${spec.endsWith(".ts") ? "" : ".ts"}`);
      else bare.push(`${relative(root, file)}: ${spec}`);
    }
  };
  walk(join(root, entry));
  return { files: [...seen].map((f) => relative(root, f)).sort(), bare };
}

test("no npm package on any entry's import graph, and every graph stays inside BUNDLE_FILES; the path module imports node: only", () => {
  for (const entry of ["nap-archive.ts", "nap-sqlite-fold.ts", "restore-state.ts", "nap-state-paths.ts"]) {
    const g = importGraph(INSTALL, entry);
    expect([entry, g.bare]).toEqual([entry, []]);
    for (const f of g.files) expect([entry, BUNDLE_FILES.includes(f)]).toEqual([entry, true]);
  }
  expect(importGraph(INSTALL, "nap-state-paths.ts").files).toEqual(["nap-state-paths.ts"]);
  expect(readFileSync(join(INSTALL, "nap-state-paths.ts"), "utf8")).not.toMatch(/from "bun:/);
});

test("S-n4: the bundle staged alone (no package.json, no node_modules) folds, archives with its own sha in the manifest, and restore loads", async () => {
  const h = fresh("bundle");
  const bundle = join(napDir(h.home), "bundle");
  mkdirSync(bundle, { recursive: true });
  for (const name of BUNDLE_FILES) copyFileSync(join(INSTALL, name), join(bundle, name));
  writeFileSync(join(bundle, "nap-state-paths.json"), JSON.stringify(napStatePathsDocument()));
  for (let dir = bundle; ; dir = dirname(dir)) {
    expect(existsSync(join(dir, "node_modules")) ? dir : null).toBeNull();
    expect(existsSync(join(dir, "package.json")) ? dir : null).toBeNull();
    if (dirname(dir) === dir) break;
  }
  expect(toolSha256(bundle, BUNDLE_FILES)).toBe(TOOL);
  const runId = newRunId();
  stagePutRun(stub, h.home, runId);
  expect(runFold(join(bundle, "nap-sqlite-fold.ts"), h, runId).code).toBe(0);
  stageStoreCopy(h);
  const a = args(h, runId).filter((x, i, all) => x !== "--paths" && all[i - 1] !== "--paths"); // the default: next to the script
  // Async: the stub bucket answers from this process.
  const p = Bun.spawn([process.execPath, "--no-env-file", "--no-install", join(bundle, "nap-archive.ts"), ...a], { cwd: bundle, env: envFor(h), stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  expect({ status, stderr }).toEqual({ status: 0, stderr: "" });
  const line = JSON.parse(stdout.trim());
  expect(line).toMatchObject({ status: "archived", tool_sha256: TOOL });
  const manifest = JSON.parse(publishManifest(stub, line.manifest_key).toString("utf8"));
  expect(manifest.tool_sha256).toBe(TOOL);
  // The bundle sits in the nap dir: neither archived nor counted.
  const files = JSON.parse(decryptPayload(stub, manifest).entries.get("files.json")!.toString()).files as any[];
  expect(files.some((f) => f.path.includes("/bundle/"))).toBe(false);
  const usage = spawnSync(process.execPath, ["--no-env-file", "--no-install", join(bundle, "restore-state.ts")], { cwd: bundle, encoding: "utf8", env: envFor(h) });
  expect(usage.status).toBe(2); // loads, then refuses its missing arguments
  expect(usage.stderr).toContain("usage:");
});

// ---------------------------------------------------------------------------------------------------------
// Fable read 1 (overlay#617 at fb5a0f9c)
// ---------------------------------------------------------------------------------------------------------

test("M1: a run discarded after two acks cannot be re-run under its id: run_id_spent, nothing PUT, no stale acks carried", async () => {
  const h = fresh("stale-acks", { bigBytes: 300 * 1024 });
  const runId = newRunId();
  prepare(h, runId);
  // The reader's probe: two chunks acked, then the gateway comes back and the stream is discarded.
  const out = await runArchive(inProcess(h, runId), {
    beforeUpload: (n) => {
      if (n === 2) {
        mkdirSync(join(h.proc, "778"));
        writeFileSync(join(h.proc, "778", "cmdline"), "hermes\0gateway\0run\0");
      }
    },
  });
  expect(out).toEqual({ code: 1, line: { status: "error", reason: "gateway_running", chunks_acked: 2 } });
  const after = progress(h);
  expect([after.stream, after.acked, after.orphan_chunks, after.spent]).toEqual([undefined, [], 2, true]);
  rmSync(join(h.proc, "778"), { recursive: true });
  // The cp retries the archive step with the same run id: refused before any write, nothing uploaded.
  prepare(h, runId);
  const before = stub.requests.length;
  const r = await cli(h, runId);
  expect({ code: r.code, line: r.line }).toEqual({ code: 64, line: { status: "refused", reason: "run_id_spent", chunks_acked: 0 } });
  expect(putsSince(before)).toEqual([]);
  expectStagingGone(h);
  // Still spent after the refusal; a new run id archives every chunk.
  prepare(h, runId);
  expect((await cli(h, runId)).line).toMatchObject({ reason: "run_id_spent" });
  const next = await archived(h);
  for (const c of next.manifest.chunks) expect(stub.objects.has(`${next.manifest.prefix}${c.name}`)).toBe(true);
});

test("M1: a progress file with acks but no stream (an older tool's discard) is spent too", async () => {
  const h = fresh("stale-acks-2");
  const runId = newRunId();
  prepare(h, runId);
  writeFileSync(join(napDir(h.home), "progress.json"), JSON.stringify({
    schema: "nap_progress.v1", phase: "failed", pid: 999999999, run_id: runId, started_at: "x", updated_at: "x", acked: [0, 1],
  }), { mode: 0o600 });
  const before = stub.requests.length;
  const r = await cli(h, runId);
  expect({ code: r.code, line: r.line }).toEqual({ code: 64, line: { status: "refused", reason: "run_id_spent", chunks_acked: 0 } });
  expect(putsSince(before)).toEqual([]);
});

test("S1: files.json over the restore's cap refuses before pack (64, nothing PUT); --dry-run reports its size against the cap", async () => {
  const { MAX_FILES_JSON_BYTES } = await import("../nap-common");
  const h = fresh("files-cap");
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  const out = await runArchive({ ...inProcess(h, runId), maxFilesJsonBytes: 2048 });
  expect(out).toEqual({ code: 64, line: { status: "refused", reason: "files_json_too_large", chunks_acked: 0 } });
  expect(putsSince(before)).toEqual([]);
  expect(existsSync(join(napDir(h.home), "chunks"))).toBe(false);
  expectStagingGone(h);
  const dry = await runArchive({ ...inProcess(h, runId), dryRun: true });
  expect(dry.line).toMatchObject({ files_json_max: MAX_FILES_JSON_BYTES });
  expect((dry.line as any).files_json_bytes).toBeGreaterThan(2048);
  expect(parseArgs(args(h, runId), envFor(h)).maxFilesJsonBytes).toBe(MAX_FILES_JSON_BYTES);
});

test("N10: a server that refuses before the body drains gets the chunk's file descriptor closed, not leaked", async () => {
  const { httpCall } = await import("../nap-common");
  const dir = tempBase("fd");
  dirs.push(dir);
  const file = join(dir, "chunk.bin");
  writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 7));
  // Answers 403 at once, never reading the body.
  const early = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("no", { status: 403 }) });
  const ino = lstatSync(file).ino;
  // Descriptors open on the chunk file itself (sockets and the rest are not counted).
  const fds = () => readdirSync("/dev/fd").filter((name) => {
    try {
      return fstatSync(Number(name)).ino === ino;
    } catch {
      return false;
    }
  }).length;
  try {
    const before = fds();
    for (let i = 0; i < 5; i++) {
      try {
        await httpCall("PUT", `http://127.0.0.1:${early.port}/b/k`, { body: { file, bytes: 16 * 1024 * 1024 }, idleMs: 2000 });
      } catch {
        // a reset is fine; the descriptor is what is checked
      }
    }
    await Bun.sleep(100);
    expect(fds()).toBe(before);
  } finally {
    early.stop(true);
  }
});

test("N11: a file over the tar's entry limit refuses file_too_large (64) before pack; the dry run reports the largest file", async () => {
  const { MAX_TAR_ENTRY_BYTES } = await import("../nap-common");
  const h = fresh("too-large", { bigBytes: 200 * 1024 });
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  const out = await runArchive({ ...inProcess(h, runId), maxEntryBytes: 100 * 1024 });
  expect(out).toEqual({ code: 64, line: { status: "refused", reason: "file_too_large", chunks_acked: 0 } });
  expect(putsSince(before)).toEqual([]);
  expectStagingGone(h);
  const dry = await runArchive({ ...inProcess(h, runId), dryRun: true });
  expect(dry.line).toMatchObject({ largest_file_bytes: 200 * 1024, entry_max: MAX_TAR_ENTRY_BYTES });
  expect(parseArgs(args(h, runId), envFor(h)).maxEntryBytes).toBe(MAX_TAR_ENTRY_BYTES);
});

test("security fold 2 (MEDIUM): a symlink at a managed path refuses link_at_managed_path (64) before pack; the dry run counts it", async () => {
  for (const rel of [".hermes/village-bridge.json", ".hermes/mini-apps.json", ".hermes/approval/agent-token", ".hermes/.env"]) {
    const h = fresh(`link-managed-${rel.length}`);
    rmSync(join(h.root, rel), { force: true });
    symlinkSync("/etc/cron.d/nap-planted", join(h.root, rel));
    const runId = newRunId();
    prepare(h, runId);
    const before = stub.requests.length;
    const out = await runArchive(inProcess(h, runId));
    expect([rel, out]).toEqual([rel, { code: 64, line: { status: "refused", reason: "link_at_managed_path", chunks_acked: 0 } }]);
    expect(putsSince(before)).toEqual([]);
    expectStagingGone(h);
    const dry = await runArchive({ ...inProcess(h, runId), dryRun: true });
    expect([rel, dry.line.links_at_managed_path]).toEqual([rel, 1]);
  }
  // An ordinary link elsewhere in the home still archives (the fixture's own .hermes/skills/linked included).
  const h = fresh("link-ordinary");
  symlinkSync("../MEMORY.md", join(h.home, "skills", "memory-link"));
  const { r } = await archived(h);
  expect(r.code).toBe(0);
});

test("N4 (CI fold 2): a non-UTF-8 name is caught from its raw bytes before any stat; the strict walk refuses file_name_invalid, never file_unreadable", () => {
  // Runs on every platform: the directory reader hands the walker raw bytes, as Linux's readdir does.
  const h = fresh("raw-name");
  const bad = Buffer.from([0x66, 0xff, 0x6f]);
  const rules = { hermesRel: ".hermes" };
  const readdirBytes = (dir: string) => {
    const real = readdirSync(dir, { encoding: "buffer" }) as Buffer[];
    return dir === join(h.root, "notes") ? [...real, bad] : real;
  };
  mkdirSync(join(h.root, "notes"), { recursive: true });
  writeFileSync(join(h.root, "notes", "ok.txt"), "ok\n");
  let code = "";
  try {
    walkHome(h.root, rules, { readdirBytes });
  } catch (err) {
    code = err instanceof WalkRefused ? err.message : String(err);
  }
  expect(code).toBe("file_name_invalid");
  // The lenient walk (dry run, fold) counts it once and carries on; nothing else is called unreadable.
  const lenient = walkHome(h.root, rules, { lenient: true, readdirBytes });
  expect(lenient.problems).toEqual({ unreadable: 0, unsupported: 0, name_invalid: 1 });
  expect(lenient.items.some((i) => i.rel === "notes/ok.txt")).toBe(true);
});

test("Fable read 2 S2: after a 503 on chunk 2 the same run id resumes from the archive step alone; the manifest's store shas are the first staging's", async () => {
  const h = fresh("resume-store", { bigBytes: 300 * 1024 });
  const runId = newRunId();
  prepare(h, runId);
  const first = { blob: readFileSync(storeBlob(h)), list: readFileSync(storeList(h)) };
  stub.onPut = (k) => (k.endsWith("chunk-0002.bin") ? 503 : undefined);
  const r1 = await cli(h, runId);
  stub.onPut = () => undefined;
  expect({ code: r1.code, reason: r1.line.reason, acked: r1.line.chunks_acked }).toEqual({ code: 1, reason: "upload_unavailable", acked: 2 });
  expect(progress(h)).toMatchObject({ phase: "failed", stream: { stream_complete: true } });
  expect([readFileSync(storeBlob(h)).equals(first.blob), readFileSync(storeList(h)).equals(first.list)]).toEqual([true, true]);
  // The cp re-runs the archive step alone (a fresh run file), and also once more with the pair re-staged
  // (new ciphertext): either way the stream is resumed and its own shas are recorded.
  for (const restage of [false, true]) {
    const id = restage ? newRunId() : runId;
    if (restage) {
      prepare(h, id);
      stub.onPut = (k) => (k.endsWith("chunk-0002.bin") ? 503 : undefined);
      await cli(h, id);
      stub.onPut = () => undefined;
    }
    const staged = { blob: readFileSync(storeBlob(h)), list: readFileSync(storeList(h)) };
    if (restage) stageStoreCopy(h); // the root piece ran again: other bytes, never consulted by the resume
    stagePutRun(stub, h.home, id);
    const before = stub.requests.length;
    const r2 = await cli(h, id);
    expect({ restage, code: r2.code, status: r2.line.status, reason: r2.line.reason }).toEqual({ restage, code: 0, status: "archived", reason: undefined });
    const puts = putsSince(before);
    expect(puts).not.toContain("chunk-0000.bin");
    expect(puts).not.toContain("chunk-0001.bin");
    expect(puts).toContain("chunk-0002.bin");
    const manifest = JSON.parse(publishManifest(stub, r2.line.manifest_key).toString("utf8"));
    expect([manifest.store_blob_sha256, manifest.store_members_sha256]).toEqual([sha(staged.blob), sha(staged.list)]);
    expectStagingGone(h);
  }
});

test("review-a S1: the archive runs the restore's own entry rules before pack; a refusal there is 64 with the restore's code, nothing PUT", async () => {
  const h = fresh("entry-rules");
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  const hooks: ArchiveHooks = { afterWalk: (files) => void (files.find((f) => f.path === ".hermes/MEMORY.md")!.class = "bogus" as any) };
  const out = await runArchive(inProcess(h, runId), hooks);
  expect(out).toEqual({ code: 64, line: { status: "refused", reason: "class_mismatch", chunks_acked: 0 } });
  expect(putsSince(before)).toEqual([]);
  expectStagingGone(h);
});

test("review-a S3: Hermes's retired-WAL capture is never folded and never blocks the nap; its image, WAL and manifest archive byte for byte", async () => {
  const h = fresh("retired-wal");
  // Hermes's shape: <db>.retired-wal-<ts>-<pid>/ with the main image copy, the retired WAL (frames NOT in the
  // image) and manifest.json; here the fixture's state.db and its non-empty -wal, copied before any fold.
  const cap = join(h.home, "state.db.retired-wal-20261101T000000Z-4242");
  mkdirSync(cap);
  copyFileSync(join(h.home, "state.db"), join(cap, "state.db"));
  copyFileSync(join(h.home, "state.db-wal"), join(cap, "state.db-wal"));
  writeFileSync(join(cap, "manifest.json"), '{"note":"digests of the two files"}\n');
  // A header-only capture (image over 512 MiB): a WAL with no main file beside it.
  const hdr = join(h.home, "big.db.retired-wal-20261101T000000Z-4243.partial");
  mkdirSync(hdr);
  copyFileSync(join(h.home, "state.db-wal"), join(hdr, "big.db-wal"));
  const rels = [".hermes/state.db.retired-wal-20261101T000000Z-4242/state.db", ".hermes/state.db.retired-wal-20261101T000000Z-4242/state.db-wal",
    ".hermes/state.db.retired-wal-20261101T000000Z-4242/manifest.json", ".hermes/big.db.retired-wal-20261101T000000Z-4243.partial/big.db-wal"];
  const shas = Object.fromEntries(rels.map((rel) => [rel, sha(readFileSync(join(h.root, rel)))]));
  expect(lstatSync(join(cap, "state.db-wal")).size).toBeGreaterThan(0);
  const { manifest, files } = await archived(h);
  expect([manifest.tree.db_count, manifest.tree.wal_folded]).toEqual([1, 1]); // the live state.db only
  for (const rel of rels) {
    expect([rel, sha(readFileSync(join(h.root, rel)))]).toEqual([rel, shas[rel]]); // untouched on disk
    expect([rel, files.find((f) => f.path === rel)?.sha256]).toEqual([rel, shas[rel]]); // archived as is
  }
});

test("review-a N1: a symlink target that is not UTF-8 refuses file_name_invalid (64), byte-true like names; the dry run counts it", async () => {
  const h = fresh("raw-target");
  symlinkSync(Buffer.from([0xff, 0xfe, 0x61]), join(h.root, "odd-link"));
  const runId = newRunId();
  prepare(h, runId);
  const before = stub.requests.length;
  const out = await runArchive(inProcess(h, runId));
  expect(out).toEqual({ code: 64, line: { status: "refused", reason: "file_name_invalid", chunks_acked: 0 } });
  expect(putsSince(before)).toEqual([]);
  const dry = await runArchive({ ...inProcess(h, runId), dryRun: true });
  expect(dry.line).toMatchObject({ file_name_invalid: 1, unreadable: 0 });
});

test("review-a N3: an orphan -wal (no main file beside it) never blocks a nap; it is archived as is and the dry run counts it", async () => {
  const h = fresh("orphan-wal");
  const orphan = Buffer.alloc(4096, 7);
  writeFileSync(join(h.home, "orphan.db-wal"), orphan);
  const dry = await runArchive({ ...inProcess(h, newRunId()), dryRun: true });
  expect(dry.line).toMatchObject({ wal_orphan: 1, wal_nonempty: 1 }); // the fixture's live state.db-wal, before its fold
  const { files } = await archived(h);
  expect(files.find((f) => f.path === ".hermes/orphan.db-wal")).toMatchObject({ bytes: 4096, sha256: sha(orphan) });
  expect(JSON.parse(readFileSync(join(napDir(h.home), "fold.json"), "utf8"))).toMatchObject({ wal_unfolded: 0, wal_orphan: 1 });
});
