/**
 * restore-memory refuses tar archives carrying PAX or Solaris extended headers
 * (the form tar uses for extended attributes), and a restored file carries no
 * extended attribute of its own.
 *
 * The archives are fixed bytes under `fixtures/restore-xattr/<case>/`, each named
 * `memory.<sha256 of the gzip>.tar.gz` the way `ARCHIVE_NAME` expects. Every one
 * holds the same regular file, `memories/MEMORY.md`; the four refusal cases put
 * one extra header in front of it:
 *
 *   ok-regular              `0`        control: restores
 *   pax-x-schily-xattr      `x`, `0`   per-file PAX header, `SCHILY.xattr.user.plant`
 *   pax-x-libarchive-xattr  `x`, `0`   per-file PAX header, `LIBARCHIVE.xattr.user.plant`
 *   pax-g-global            `g`, `0`   global PAX header
 *   solaris-X-xattr         `X`, `0`   Solaris extended header
 *
 * Each test runs against a fresh temp HOME, with a fetcher that serves the
 * archive and a manifest built for it (no network).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterEach, describe, expect, test } from "bun:test";

import { MANIFEST_SCHEMA, parseTar, type Fetcher, restoreMemory } from "../restore-memory";

const FIXTURES = join(import.meta.dir, "fixtures", "restore-xattr");
const TENANT = "t_xattr-1";
const TOKEN = "backup-token-for-tests-xattr";
const DATE = "2026-10-01";
const PATH = "memories/MEMORY.md";
const CONTENT = "benign memory line\n";
const MTIME_MS = 1_780_000_000_000;
/** The xattr name every refusal fixture's extended header asks for. */
const PLANTED = "user.plant";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

const dirs: string[] = [];
function tempDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `av-restore-xattr-${label}-`));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Fixture = { name: string; archive: Uint8Array };

/** The fixture's one archive, after checking its name is its own SHA-256. */
function loadFixture(kase: string): Fixture {
  const names = readdirSync(join(FIXTURES, kase));
  expect(names.length).toBe(1);
  const name = names[0];
  const m = /^memory\.([0-9a-f]{64})\.tar\.gz$/.exec(name);
  expect(m).not.toBeNull();
  const archive = new Uint8Array(readFileSync(join(FIXTURES, kase, name)));
  expect(sha(archive)).toBe(m![1]);
  return { name, archive };
}

/** Each header's typeflag and name, read straight from the 512-byte blocks, so
 * the test knows the fixture holds what it says before relying on it. */
function headers(tar: Uint8Array): { type: string; name: string; body: string }[] {
  const out: { type: string; name: string; body: string }[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512);
    if (h.every((b) => b === 0)) break;
    const name = new TextDecoder().decode(h.subarray(0, 100)).replace(/\0.*$/s, "");
    const size = parseInt(new TextDecoder().decode(h.subarray(124, 136)).replace(/\0.*$/s, "").trim(), 8);
    const body = new TextDecoder().decode(tar.subarray(offset + 512, offset + 512 + size));
    out.push({ type: String.fromCharCode(h[156]), name, body });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** A `memory_manifest.v1` that names this archive and the one file it holds. */
function manifestFor(f: Fixture): { key: string; bytes: Uint8Array } {
  const doc = {
    schema: MANIFEST_SCHEMA,
    tenant_id: TENANT,
    date: DATE,
    created_at: "2026-10-01T00:00:00Z",
    plugin_version: "test",
    archive: { name: f.name, sha256: sha(f.archive), bytes: f.archive.length },
    file_count: 1,
    total_bytes: Buffer.byteLength(CONTENT),
    files: [{ path: PATH, sha256: sha(CONTENT), bytes: Buffer.byteLength(CONTENT), mtime_ms: MTIME_MS }],
  };
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  return { key: `${DATE}/manifest.${sha(bytes)}.json`, bytes };
}

/** The GET half of the backup route, in memory: `latest`, the manifest, the archive. */
function fetcherFor(f: Fixture): Fetcher {
  const manifest = manifestFor(f);
  const prefix = `/v1/backup/${TENANT}/`;
  return async (url, init) => {
    if (init.headers.Authorization !== `Bearer ${TOKEN}`) return new Response("", { status: 401 });
    const path = new URL(url).pathname;
    if (path === `${prefix}latest`) return new Response(manifest.bytes, { headers: { "X-Backup-Key": manifest.key } });
    if (path === `${prefix}${manifest.key}`) return new Response(manifest.bytes);
    if (path === `${prefix}${DATE}/${f.name}`) return new Response(f.archive);
    return new Response("", { status: 404 });
  };
}

const restore = (home: string, f: Fixture) =>
  restoreMemory({ url: "http://127.0.0.1:9", token: TOKEN, tenant: TENANT, home, fetcher: fetcherFor(f) });

/** Every entry under `home`, dotfiles and directories included, except the restore marker's `av-events/`. */
function listAll(home: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!prefix && e.name === "av-events") continue;
      out.push(`${prefix}${e.name}${e.isDirectory() ? "/" : ""}`);
      if (e.isDirectory()) walk(join(dir, e.name), `${prefix}${e.name}/`);
    }
  };
  if (existsSync(home)) walk(home, "");
  return out.sort();
}

function marker(home: string) {
  return JSON.parse(readFileSync(join(home, "av-events", "restore.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// Listing extended attributes.
//
// Linux (CI): python3's os.listxattr. macOS: /usr/bin/xattr. Either way the
// lister is proven at load time on a probe file: it must list nothing on a
// fresh file's baseline and must see an attribute the probe sets. If it cannot,
// the xattr assertion is skipped, with the reason in the test's name.

type Lister = (path: string) => string[];

function pythonLister(path: string): string[] {
  const run = Bun.spawnSync(["python3", "-I", "-c", "import json, os, sys; print(json.dumps(os.listxattr(sys.argv[1])))", path]);
  if (run.exitCode !== 0) throw new Error(`os.listxattr failed: ${run.stderr.toString().trim()}`);
  return (JSON.parse(run.stdout.toString()) as string[]).sort();
}

function macLister(path: string): string[] {
  const run = Bun.spawnSync(["/usr/bin/xattr", path]);
  if (run.exitCode !== 0) throw new Error(`xattr failed: ${run.stderr.toString().trim()}`);
  return run.stdout.toString().split("\n").filter(Boolean).sort();
}

function setXattr(path: string, name: string, value: string): boolean {
  const run =
    process.platform === "darwin"
      ? Bun.spawnSync(["/usr/bin/xattr", "-w", name, value, path])
      : Bun.spawnSync(["python3", "-I", "-c", "import os, sys; os.setxattr(sys.argv[1], sys.argv[2], sys.argv[3].encode())", path, name, value]);
  return run.exitCode === 0;
}

function probeLister(): { lister: Lister | null; why: string } {
  let lister: Lister;
  if (process.platform === "linux") lister = pythonLister;
  else if (process.platform === "darwin") lister = macLister;
  else return { lister: null, why: `no xattr lister for platform ${process.platform}` };
  const dir = mkdtempSync(join(tmpdir(), "av-restore-xattr-probe-"));
  try {
    const probe = join(dir, "probe");
    writeFileSync(probe, "probe\n");
    const before = lister(probe);
    if (!setXattr(probe, PLANTED, "probe")) return { lister: null, why: `cannot set a ${PLANTED} xattr in ${tmpdir()}` };
    const after = lister(probe);
    if (!after.includes(PLANTED) || before.includes(PLANTED)) return { lister: null, why: "the xattr lister does not see a set attribute" };
    return { lister, why: "" };
  } catch (err) {
    return { lister: null, why: `cannot list xattrs: ${(err as Error).message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const XATTR = probeLister();
if (!XATTR.lister && process.platform !== "linux") console.warn(`restore_memory_xattr: SKIPPING the no-xattr assertion: ${XATTR.why}`);

/** The attributes the OS puts on any file this process writes in `dir`: none on
 * Linux; on macOS, `com.apple.provenance` when the process is provenance-tracked. */
function baselineXattrs(lister: Lister, dir: string): string[] {
  const ref = join(dir, ".xattr-baseline");
  writeFileSync(ref, "baseline\n");
  try {
    return lister(ref);
  } finally {
    rmSync(ref);
  }
}

// ---------------------------------------------------------------------------

describe("restore-memory and tar extended headers (PAX x/g, Solaris X)", () => {
  test("fixture ok-regular holds one regular entry, memories/MEMORY.md", () => {
    const f = loadFixture("ok-regular");
    const hs = headers(gunzipSync(f.archive));
    expect(hs.map((h) => [h.type, h.name])).toEqual([["0", PATH]]);
    expect(hs[0].body).toBe(CONTENT);
  });

  test("control ok-regular: restores memories/MEMORY.md with its content, and nothing else", async () => {
    const f = loadFixture("ok-regular");
    const home = tempDir("home");
    const result = await restore(home, f);
    expect(result).toEqual({
      status: "restored",
      snapshot_ref: `backup/${sha(manifestFor(f).bytes)}`,
      bytes: Buffer.byteLength(CONTENT),
      file_count: 1,
      written: 1,
      unchanged: 0,
      kept_newer: 0,
      partial: false,
    });
    expect(listAll(home)).toEqual(["memories/", PATH]);
    expect(readFileSync(join(home, ...PATH.split("/")), "utf8")).toBe(CONTENT);
    expect(statSync(join(home, ...PATH.split("/"))).mode & 0o777).toBe(0o600);
    expect(marker(home)).toMatchObject({ status: "restored" });
  });

  // On Linux (CI's platform) a missing lister is a failure, never a skip: the
  // assertion must not go quiet if CI loses python3 or a settable tmp.
  test.skipIf(!XATTR.lister && process.platform !== "linux")(
    `control ok-regular: the restored file carries no extended attribute${XATTR.lister ? "" : ` (SKIPPED: ${XATTR.why})`}`,
    async () => {
      if (!XATTR.lister) throw new Error(`no working xattr lister on linux: ${XATTR.why}`);
      const lister = XATTR.lister;
      const f = loadFixture("ok-regular");
      const home = tempDir("home");
      expect(await restore(home, f)).toMatchObject({ status: "restored", written: 1 });
      const restored = join(home, ...PATH.split("/"));
      const attrs = lister(restored);
      expect(attrs).not.toContain(PLANTED);
      // Nothing beyond what the OS puts on every file this process writes there.
      expect(attrs).toEqual(baselineXattrs(lister, join(home, "memories")));
      if (process.platform === "linux") expect(attrs).toEqual([]);
    },
  );

  const REFUSED: { kase: string; type: string; key: RegExp | null }[] = [
    { kase: "pax-x-schily-xattr", type: "x", key: /^\d+ SCHILY\.xattr\.user\.plant=/ },
    { kase: "pax-x-libarchive-xattr", type: "x", key: /^\d+ LIBARCHIVE\.xattr\.user\.plant=/ },
    { kase: "pax-g-global", type: "g", key: /^\d+ SCHILY\.xattr\.user\.plant=/ },
    { kase: "solaris-X-xattr", type: "X", key: /^\d+ SCHILY\.xattr\.user\.plant=/ },
  ];

  for (const { kase, type, key } of REFUSED) {
    test(`fixture ${kase} holds a '${type}' header, then the regular memories/MEMORY.md`, () => {
      const hs = headers(gunzipSync(loadFixture(kase).archive));
      expect(hs.map((h) => h.type)).toEqual([type, "0"]);
      expect(hs[1].name).toBe(PATH);
      expect(hs[1].body).toBe(CONTENT);
      if (key) expect(hs[0].body).toMatch(key);
    });

    test(`${kase}: refused tar_entry_not_regular, and nothing is written`, async () => {
      const f = loadFixture(kase);
      const home = tempDir("home");
      const result = await restore(home, f);
      // Nothing written first, so a reader that skips the header and restores is caught here.
      // No memory file, no memories/ directory, no staged temp: only the marker.
      expect(listAll(home)).toEqual([]);
      expect(readdirSync(home)).toEqual(["av-events"]);
      expect(readdirSync(join(home, "av-events"))).toEqual(["restore.json"]);
      expect(result).toEqual({
        status: "refused",
        snapshot_ref: null,
        bytes: 0,
        file_count: 0,
        written: 0,
        unchanged: 0,
        kept_newer: 0,
        partial: false,
        reason: "tar_entry_not_regular",
      });
      expect(marker(home)).toMatchObject({
        status: "error",
        reason: "tar_entry_not_regular",
        manifest_key: manifestFor(f).key,
        workspace_empty: true,
      });
      // The refusal is the tar reader's own, on the extended header.
      expect(() => parseTar(new Uint8Array(gunzipSync(f.archive)))).toThrow("tar_entry_not_regular");
    });
  }
});
