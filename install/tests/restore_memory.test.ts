import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";

import {
  backupUrlAllowed,
  DAILY_NOTE_NAME,
  parseArgs,
  parseTar,
  RESTORE_PATH,
  restoreMemory,
  type RestoreResult,
} from "../restore-memory";

const REPO = join(import.meta.dir, "..", "..");
const TENANT = "t_Dogfood-1";
const TOKEN = "backup-token-for-tests-0123456789";

const FILES: Record<string, string> = {
  "MEMORY.md": "# Long-term\n- likes jazz\n",
  "USER.md": "# Landing profile\n",
  "memories/MEMORY.md": "tool memory § entry\n",
  "memories/USER.md": "tool user profile\n",
  "memory/2026-09-20.md": "- met B at the cafe\n",
  "memory/2026-09-21.md": "- [gate] index-network: ok\n",
};

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const dirs: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `av-restore-${label}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeTree(home: string, files: Record<string, string | Uint8Array>) {
  for (const [rel, data] of Object.entries(files)) {
    mkdirSync(join(home, ...rel.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(home, ...rel.split("/")), data);
  }
}

type Snap = { date: string; archiveName: string; manifestName: string; archive: Uint8Array; manifest: Uint8Array };

/** A snapshot built by the plugin's own `_backup` module, so the reader here is
 * tested against the bytes Python's tarfile and gzip actually produce. */
function pythonSnapshot(files: Record<string, string>, mtimeSeconds = 1_780_000_000): Snap {
  const src = tempDir("src");
  writeTree(src, files);
  for (const rel of Object.keys(files)) utimesSync(join(src, ...rel.split("/")), mtimeSeconds, mtimeSeconds);
  const script = `
import base64, importlib.util, json, sys, types
pkg = "hermes_plugins.av_events"
ns = types.ModuleType("hermes_plugins"); ns.__path__ = []; sys.modules["hermes_plugins"] = ns
spec = importlib.util.spec_from_file_location(pkg, sys.argv[1] + "/__init__.py", submodule_search_locations=[sys.argv[1]])
mod = importlib.util.module_from_spec(spec); sys.modules[pkg] = mod; spec.loader.exec_module(mod)
b = sys.modules[pkg + "._backup"]
snap = b.build_snapshot(b.collect(sys.argv[2]).files, sys.argv[3], 1790000000.0)
m = snap.manifest_bytes()
print(json.dumps({"date": snap.date, "archive_name": snap.archive_name,
  "manifest_name": "manifest." + b.sha256_hex(m) + ".json",
  "archive": base64.b64encode(snap.archive).decode(), "manifest": base64.b64encode(m).decode()}))
`;
  const run = Bun.spawnSync(["python3", "-c", script, join(REPO, "plugins", "av-events"), src, TENANT]);
  if (run.exitCode !== 0) throw new Error(`python snapshot failed: ${run.stderr.toString()}`);
  const out = JSON.parse(run.stdout.toString());
  return {
    date: out.date,
    archiveName: out.archive_name,
    manifestName: out.manifest_name,
    archive: new Uint8Array(Buffer.from(out.archive, "base64")),
    manifest: new Uint8Array(Buffer.from(out.manifest, "base64")),
  };
}

/** A stub of the GET half of the DATA-93 route. */
const route = {
  objects: new Map<string, Uint8Array>(),
  latest: null as string | null,
  status: 0,
  requests: [] as { path: string; auth: string | null }[],
};
let server: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      route.requests.push({ path, auth: req.headers.get("authorization") });
      if (route.status) return new Response("no", { status: route.status });
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("", { status: 401 });
      const m = /^\/v1\/backup\/([^/]+)\/(.+)$/.exec(path);
      if (!m) return new Response("", { status: 404 });
      const [, tenant, rest] = m;
      if (rest === "latest") {
        if (!route.latest) return new Response("", { status: 404 });
        return new Response(route.objects.get(`backup/${tenant}/${route.latest}`)!, {
          headers: { "X-Backup-Key": route.latest },
        });
      }
      const obj = route.objects.get(`backup/${tenant}/${rest}`);
      return obj ? new Response(obj) : new Response("", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
afterEach(() => {
  route.objects.clear();
  route.latest = null;
  route.status = 0;
  route.requests = [];
});

function publish(snap: Snap, tenant = TENANT) {
  route.objects.set(`backup/${tenant}/${snap.date}/${snap.archiveName}`, snap.archive);
  route.objects.set(`backup/${tenant}/${snap.date}/${snap.manifestName}`, snap.manifest);
  route.latest = `${snap.date}/${snap.manifestName}`;
}

/** Republish a snapshot whose manifest was edited, under its new (valid) key. */
function publishEdited(snap: Snap, edit: (doc: any) => void, archive = snap.archive) {
  const doc = JSON.parse(new TextDecoder().decode(snap.manifest));
  edit(doc);
  const manifest = new TextEncoder().encode(JSON.stringify(doc));
  publish({ ...snap, archive, manifest, manifestName: `manifest.${sha(manifest)}.json` });
}

const base = () => `http://127.0.0.1:${server.port}`;
const restore = (home: string, extra: Partial<Parameters<typeof restoreMemory>[0]> = {}) =>
  restoreMemory({ url: base(), token: TOKEN, tenant: TENANT, home, ...extra });

/** Every file under `home` except the restore marker's `av-events/`. */
function listTree(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && e.name === "av-events") continue;
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
      else out.push(`${prefix}${e.name}`);
    }
  };
  if (existsSync(home)) walk(home, "");
  return out.sort();
}

// ---------------------------------------------------------------------------

test("restores every file byte-identical, with the snapshot's mtimes, and reports what memory.restored needs", async () => {
  const snap = pythonSnapshot(FILES);
  publish(snap);
  const home = tempDir("home");
  const result = await restore(home);
  expect(result).toEqual({
    status: "restored",
    snapshot_ref: `backup/${sha(snap.manifest)}`,
    bytes: Object.values(FILES).reduce((n, s) => n + Buffer.byteLength(s), 0),
    file_count: 6,
    written: 6,
    unchanged: 0,
    kept_newer: 0,
    partial: false,
  });
  expect(listTree(home)).toEqual(Object.keys(FILES).sort());
  for (const [rel, text] of Object.entries(FILES)) {
    const path = join(home, ...rel.split("/"));
    expect(readFileSync(path, "utf8")).toBe(text);
    expect(Math.floor(statSync(path).mtimeMs)).toBe(1_780_000_000_000);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  }
  expect(route.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  expect(route.requests[0].path).toBe(`/v1/backup/${TENANT}/latest`);
  // Idempotent: a second run finds everything already there.
  const again = await restore(home);
  expect(again).toMatchObject({ status: "restored", written: 0, unchanged: 6, kept_newer: 0, bytes: 0, file_count: 0 });
});

test("the snapshot_ref matches the plugin's memory.snapshot manifest_ref shape", async () => {
  publish(pythonSnapshot(FILES));
  const result = await restore(tempDir("home"));
  expect(result.snapshot_ref).toMatch(/^[a-z0-9_-]{1,32}\/[0-9a-f]{64}$/);
});

test("no backup is status none, and nothing is written", async () => {
  const home = tempDir("home");
  expect(await restore(home)).toMatchObject({ status: "none", written: 0, snapshot_ref: null });
  expect(listTree(home)).toEqual([]);
});

test("a manifest whose bytes do not match its key is refused", async () => {
  const snap = pythonSnapshot(FILES);
  publish(snap);
  const tampered = new TextEncoder().encode(new TextDecoder().decode(snap.manifest).replace("jazz", "jazz"));
  route.objects.set(`backup/${TENANT}/${snap.date}/${snap.manifestName}`, new Uint8Array([...tampered, 0x20]));
  const home = tempDir("home");
  expect(await restore(home)).toMatchObject({ status: "refused", reason: "manifest_hash_mismatch" });
  expect(listTree(home)).toEqual([]);
});

test("an archive that does not match the manifest is refused, and nothing is written", async () => {
  const snap = pythonSnapshot(FILES);
  publish(snap);
  const other = pythonSnapshot({ ...FILES, "MEMORY.md": "something else\n" });
  route.objects.set(`backup/${TENANT}/${snap.date}/${snap.archiveName}`, other.archive);
  const home = tempDir("home");
  expect(await restore(home)).toMatchObject({ status: "refused", reason: "archive_hash_mismatch" });
  expect(listTree(home)).toEqual([]);
});

test("an archive with the right length and files but different bytes is refused on its own hash", async () => {
  const snap = pythonSnapshot(FILES);
  publish(snap);
  // The gzip header's OS byte: still valid gzip, same length, same tar inside.
  const altered = new Uint8Array(snap.archive);
  altered[9] = altered[9] === 3 ? 7 : 3;
  route.objects.set(`backup/${TENANT}/${snap.date}/${snap.archiveName}`, altered);
  const home = tempDir("home");
  expect(await restore(home)).toMatchObject({ status: "refused", reason: "archive_hash_mismatch" });
  expect(listTree(home)).toEqual([]);
});

test("a file whose hash does not match its manifest entry refuses the whole restore", async () => {
  const snap = pythonSnapshot(FILES);
  publishEdited(snap, (doc) => {
    doc.files.find((f: any) => f.path === "memory/2026-09-21.md").sha256 = "0".repeat(64);
  });
  const home = tempDir("home");
  expect(await restore(home)).toMatchObject({ status: "refused", reason: "file_hash_mismatch" });
  expect(listTree(home)).toEqual([]);
});

test("a path outside the allowlist is refused, even if the hashes agree", async () => {
  const snap = pythonSnapshot(FILES);
  for (const bad of ["../escape.md", "/etc/passwd", ".recall/index.sqlite", "memory/notes.md", "av-events/hash.key"]) {
    publishEdited(snap, (doc) => {
      doc.files[0].path = bad;
    });
    expect(await restore(tempDir("home"))).toMatchObject({ status: "refused", reason: "manifest_path_not_allowed" });
  }
});

test("a manifest for another tenant is refused", async () => {
  const snap = pythonSnapshot(FILES);
  publishEdited(snap, (doc) => {
    doc.tenant_id = "t_other";
  });
  expect(await restore(tempDir("home"))).toMatchObject({ status: "refused", reason: "manifest_tenant_mismatch" });
});

test("a tar entry that is not a regular file is refused", () => {
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode("MEMORY.md"), 0);
  header.set(new TextEncoder().encode("00000000000\0"), 124);
  header[156] = 0x32; // symlink
  expect(() => parseTar(new Uint8Array([...header, ...new Uint8Array(1024)]))).toThrow("tar_entry_not_regular");
});

test("an archive holding a file the manifest does not list is refused", async () => {
  const snap = pythonSnapshot(FILES);
  const fewer = pythonSnapshot({ "MEMORY.md": FILES["MEMORY.md"] });
  // Manifest lists one file; archive (hash-matched) holds six.
  publishEdited(
    fewer,
    (doc) => {
      doc.archive = { name: snap.archiveName, sha256: sha(snap.archive), bytes: snap.archive.length };
    },
    snap.archive,
  );
  route.objects.set(`backup/${TENANT}/${fewer.date}/${snap.archiveName}`, snap.archive);
  expect(await restore(tempDir("home"))).toMatchObject({ status: "refused", reason: "archive_files_mismatch" });
});

test("a gzip bomb is refused rather than inflated", async () => {
  const bomb = gzipSync(new Uint8Array(300 * 1024 * 1024));
  const snap = pythonSnapshot(FILES);
  publishEdited(
    snap,
    (doc) => {
      doc.archive = { name: `memory.${sha(bomb)}.tar.gz`, sha256: sha(bomb), bytes: bomb.length };
    },
    new Uint8Array(bomb),
  );
  const doc = JSON.parse(new TextDecoder().decode(route.objects.get(`backup/${TENANT}/${route.latest}`)!));
  route.objects.set(`backup/${TENANT}/${snap.date}/${doc.archive.name}`, new Uint8Array(bomb));
  expect(await restore(tempDir("home"))).toMatchObject({ status: "refused", reason: "archive_unreadable" });
});

test("mtime rule: a newer local file is kept unless --force; an older one is replaced; the same bytes are left", async () => {
  publish(pythonSnapshot(FILES)); // files at mtime 1_780_000_000 s
  const home = tempDir("home");
  writeTree(home, {
    "MEMORY.md": "NEWER LOCAL\n",
    "USER.md": "OLDER LOCAL\n",
    "memory/2026-09-20.md": FILES["memory/2026-09-20.md"],
  });
  utimesSync(join(home, "MEMORY.md"), 1_790_000_000, 1_790_000_000);
  utimesSync(join(home, "USER.md"), 1_770_000_000, 1_770_000_000);
  utimesSync(join(home, "memory", "2026-09-20.md"), 1_790_000_000, 1_790_000_000);

  const result = await restore(home);
  expect(result).toMatchObject({ status: "restored", written: 4, unchanged: 1, kept_newer: 1, file_count: 4 });
  expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("NEWER LOCAL\n");
  expect(readFileSync(join(home, "USER.md"), "utf8")).toBe(FILES["USER.md"]);

  const forced = await restore(home, { force: true });
  expect(forced).toMatchObject({ status: "restored", written: 1, unchanged: 5, kept_newer: 0 });
  expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe(FILES["MEMORY.md"]);
});

test("a symlink or directory where a memory file goes refuses the restore before anything is written", async () => {
  publish(pythonSnapshot(FILES));
  const home = tempDir("home");
  const outside = tempDir("outside");
  writeFileSync(join(outside, "victim"), "untouched\n");
  mkdirSync(join(home, "memory"));
  symlinkSync(join(outside, "victim"), join(home, "memory", "2026-09-21.md"));
  expect(await restore(home, { force: true })).toMatchObject({ status: "refused", reason: "target_not_regular" });
  expect(readFileSync(join(outside, "victim"), "utf8")).toBe("untouched\n");
  expect(existsSync(join(home, "MEMORY.md"))).toBe(false);

  const home2 = tempDir("home2");
  symlinkSync(outside, join(home2, "memories"));
  expect(await restore(home2)).toMatchObject({ status: "refused", reason: "target_dir_not_directory" });
  expect(listTree(outside)).toEqual(["victim"]);
});

test("--dry-run verifies and counts but writes nothing, not even the marker", async () => {
  publish(pythonSnapshot(FILES));
  const home = tempDir("home");
  expect(await restore(home, { dryRun: true })).toMatchObject({ status: "dry_run", written: 6 });
  expect(readdirSync(home)).toEqual([]);
});

test("--manifest restores a named, older snapshot instead of the latest", async () => {
  const older = pythonSnapshot({ "MEMORY.md": "older\n" });
  publish(older);
  const newer = pythonSnapshot(FILES);
  publish(newer);
  const home = tempDir("home");
  const result = await restore(home, { manifestKey: `${older.date}/${older.manifestName}` });
  expect(result).toMatchObject({ status: "restored", written: 1, snapshot_ref: `backup/${sha(older.manifest)}` });
  expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe("older\n");
});

test("an HTTP failure is status error with a code, never the URL", async () => {
  route.status = 500;
  const result: RestoreResult = await restore(tempDir("home"));
  expect(result).toMatchObject({ status: "error", reason: "http_500" });
  const unreachable = await restoreMemory({ url: "http://127.0.0.1:1", token: TOKEN, tenant: TENANT, home: tempDir("h") });
  expect(unreachable).toMatchObject({ status: "error", reason: "fetch_failed" });
});

test("AV_BACKUP_URL may be the base or the route", async () => {
  publish(pythonSnapshot(FILES));
  const result = await restoreMemory({ url: `${base()}/v1/backup/`, token: TOKEN, tenant: TENANT, home: tempDir("h") });
  expect(result.status).toBe("restored");
});

test("parseArgs: tenant from flag or env, URL and token required", () => {
  const env = { AV_BACKUP_URL: "http://x", AV_BACKUP_TOKEN: "t", TENANT_ID: "t_env", HERMES_HOME: "/tmp/h" };
  expect(parseArgs([], env)).toMatchObject({ tenant: "t_env", url: "http://x", token: "t" });
  expect(parseArgs(["--tenant", "t_flag", "--force", "--home", "/h"], env)).toMatchObject({
    tenant: "t_flag",
    force: true,
    home: "/h",
  });
});

test("CLI: one JSON line, exit 0 on restore, 1 on refusal, 2 on usage; never the token", async () => {
  const snap = pythonSnapshot(FILES);
  publish(snap);
  const home = tempDir("home");
  const env = { ...process.env, AV_BACKUP_URL: base(), AV_BACKUP_TOKEN: TOKEN, HERMES_HOME: home };
  const script = join(REPO, "install", "restore-memory.ts");

  const ok = Bun.spawn(["bun", script, "--tenant", TENANT], { env, stdout: "pipe", stderr: "pipe" });
  const okOut = await new Response(ok.stdout).text();
  expect(await ok.exited).toBe(0);
  expect(JSON.parse(okOut.trim())).toMatchObject({ status: "restored", written: 6 });
  expect(okOut).not.toContain(TOKEN);
  expect(readFileSync(join(home, "MEMORY.md"), "utf8")).toBe(FILES["MEMORY.md"]);

  publishEdited(snap, (doc) => {
    doc.files[0].sha256 = "f".repeat(64);
  });
  const bad = Bun.spawn(["bun", script, "--tenant", TENANT], { env, stdout: "pipe", stderr: "pipe" });
  const badOut = await new Response(bad.stdout).text();
  expect(await bad.exited).toBe(1);
  expect(JSON.parse(badOut.trim())).toMatchObject({ status: "refused" });

  const noToken = Bun.spawn(["bun", script, "--tenant", TENANT], {
    env: { ...env, AV_BACKUP_TOKEN: "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await noToken.exited).toBe(2);
});

// ---------------------------------------------------------------------------
// Refutation fixes (DATA-82 review)

const VECTORS = JSON.parse(
  readFileSync(join(REPO, "plugins", "av-events", "tests", "vectors", "daily_note_names.json"), "utf8"),
) as { accept: string[]; reject: string[] };

test("daily-note names: the same vectors as the plugin's DAILY_NOTE", () => {
  expect(VECTORS.reject).toContain("2026-09-22.md\n");
  expect(VECTORS.reject).toContain("２０２６-09-24.md");
  for (const name of VECTORS.accept) {
    expect(DAILY_NOTE_NAME.test(name)).toBe(true);
    expect(RESTORE_PATH.test(`memory/${name}`)).toBe(true);
  }
  for (const name of VECTORS.reject) {
    expect(DAILY_NOTE_NAME.test(name)).toBe(false);
    expect(RESTORE_PATH.test(`memory/${name}`)).toBe(false);
  }
});

test("a snapshot taken beside oddly named notes still restores", async () => {
  const odd: Record<string, string> = { ...FILES };
  for (const name of VECTORS.reject) if (name && !name.includes("/")) odd[`memory/${name}`] = "odd\n";
  publish(pythonSnapshot(odd));
  const home = tempDir("home");
  expect(await restore(home)).toMatchObject({ status: "restored", written: 6 });
  expect(listTree(home)).toEqual(Object.keys(FILES).sort());
});

function tarEntry(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const put = (at: number, text: string) => header.set(new TextEncoder().encode(text), at);
  put(0, name);
  put(100, "0000600\0");
  put(124, data.length.toString(8).padStart(11, "0") + "\0");
  put(136, "00000000000\0");
  header[156] = 0x30;
  put(257, "ustar\0");
  put(263, "00");
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  return new Uint8Array([...header, ...padded]);
}

test("a tar holding the same path twice is refused", () => {
  const a = tarEntry("MEMORY.md", new TextEncoder().encode("one\n"));
  const b = tarEntry("MEMORY.md", new TextEncoder().encode("two\n"));
  expect(() => parseTar(new Uint8Array([...a, ...b, ...new Uint8Array(1024)]))).toThrow("tar_duplicate_entry");
  expect(parseTar(new Uint8Array([...a, ...new Uint8Array(1024)])).get("MEMORY.md")).toEqual(new TextEncoder().encode("one\n"));
});

test("a manifest whose date is not its key's date is refused", async () => {
  const snap = pythonSnapshot(FILES);
  publishEdited(snap, (doc) => {
    doc.date = "2026-01-01";
  });
  expect(await restore(tempDir("home"))).toMatchObject({ status: "refused", reason: "manifest_date_mismatch" });
});

test("partial: the manifest's flag is reported; inconsistent skip counts are refused", async () => {
  const snap = pythonSnapshot(FILES);
  publishEdited(snap, (doc) => {
    doc.partial = true;
    doc.skipped = { count: 2, reasons: { over_budget: 2 } };
  });
  expect(await restore(tempDir("home"))).toMatchObject({ status: "restored", partial: true, written: 6 });
  for (const skipped of [
    { count: 3, reasons: { over_budget: 2 } },
    { count: 1, reasons: { "memory/2026-09-23.md": 1 } },
    { count: -1, reasons: {} },
  ]) {
    publishEdited(snap, (doc) => {
      doc.partial = true;
      doc.skipped = skipped;
    });
    expect(await restore(tempDir("home"))).toMatchObject({ status: "refused", reason: "manifest_skipped_invalid" });
  }
  publish(snap);
  expect(await restore(tempDir("home"))).toMatchObject({ status: "restored", partial: false });
});

function marker(home: string) {
  return JSON.parse(readFileSync(join(home, "av-events", "restore.json"), "utf8"));
}

test("the marker records restored, none and error, with the manifest key", async () => {
  const snap = pythonSnapshot(FILES);
  publish(snap);
  const ok = tempDir("ok");
  await restore(ok);
  expect(marker(ok)).toMatchObject({ status: "restored", manifest_key: `${snap.date}/${snap.manifestName}` });
  expect(statSync(join(ok, "av-events", "restore.json")).mode & 0o777).toBe(0o600);

  route.latest = null;
  const none = tempDir("none");
  await restore(none);
  expect(marker(none)).toMatchObject({ status: "none", manifest_key: null });

  publishEdited(snap, (doc) => {
    doc.files[0].sha256 = "0".repeat(64);
  });
  const bad = tempDir("bad");
  await restore(bad);
  expect(marker(bad)).toMatchObject({ status: "error", reason: "file_hash_mismatch" });

  route.status = 503;
  const down = tempDir("down");
  await restore(down);
  expect(marker(down)).toMatchObject({ status: "error", reason: "http_503" });
});

test("a read-only memory/ is write_failed, and nothing is written anywhere", async () => {
  publish(pythonSnapshot(FILES));
  const home = tempDir("home");
  mkdirSync(join(home, "memory"));
  chmodSync(join(home, "memory"), 0o500);
  try {
    const result = await restore(home);
    expect(result).toMatchObject({ status: "error", reason: "write_failed", written: 0, file_count: 0, bytes: 0 });
    expect(existsSync(join(home, "MEMORY.md"))).toBe(false);
    expect(existsSync(join(home, "memories", "MEMORY.md"))).toBe(false);
    expect(readdirSync(home).filter((n) => n.startsWith("."))).toEqual([]);
    expect(readdirSync(join(home, "memory"))).toEqual([]);
    expect(marker(home)).toMatchObject({ status: "error", reason: "write_failed" });
  } finally {
    chmodSync(join(home, "memory"), 0o700);
  }
});

test("the backup URL must be https, or http to railway.internal or the local machine", async () => {
  expect(backupUrlAllowed("https://ingest.example.com")).toBe(true);
  expect(backupUrlAllowed("http://ingest.railway.internal:8080")).toBe(true);
  expect(backupUrlAllowed("http://127.0.0.1:9")).toBe(true);
  expect(backupUrlAllowed("http://[::1]:9")).toBe(true);
  expect(backupUrlAllowed("http://ingest.example.com")).toBe(false);
  expect(backupUrlAllowed("http://railway.internal.evil.com")).toBe(false);
  expect(backupUrlAllowed("https://u:p@ingest.example.com")).toBe(false);
  expect(backupUrlAllowed("https://ingest.example.com/?x=1")).toBe(false);
  const home = tempDir("home");
  const result = await restoreMemory({ url: "http://ingest.example.com", token: TOKEN, tenant: TENANT, home });
  expect(result).toMatchObject({ status: "error", reason: "url_not_allowed" });
  expect(route.requests).toEqual([]);
});
