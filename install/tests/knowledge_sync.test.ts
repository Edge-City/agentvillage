/**
 * K1: skills/edge-india/scripts/knowledge-sync.ts, the script of the
 * "Edge — knowledge sync" job, against a stand-in fetch (no network): the
 * host allowlist, the manifest's own directory, the atomic set swap with the
 * previous set kept, the last good set untouched on every failure, the
 * unchanged skip (ETag and sha256), `unconfigured`, the caps, and the shim
 * Hermes runs. In install/tests so the CI suite runs it with no new suite
 * directory.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  DEFAULT_SNAPSHOT_URL,
  LOG_MAX_BYTES,
  currentSetDir,
  exitCode,
  documentPathValid,
  parseExtraHosts,
  previousSetDir,
  runKnowledgeSync,
  snapshotSource,
  syncLogPath,
  urlAllowed,
  type SyncOptions,
  type SyncResult,
} from "../../skills/edge-india/scripts/knowledge-sync";

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");
const BASE = "https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/";
const MANIFEST_URL = `${BASE}manifest.json`;

interface Served {
  status?: number;
  body?: string | Uint8Array;
  type?: string | null;
  etag?: string;
  location?: string;
  length?: string;
}

let home: string;
let served: Map<string, Served>;
let requests: { url: string; headers: Record<string, string> }[];

function manifest(paths: string[], extra: Record<string, unknown> = {}, hashes: Record<string, string> = {}): string {
  return JSON.stringify({
    version: 1,
    event: "edge-india-2026",
    documents: paths.map((path) => ({ path, title: path, url: `https://example.org/${path}`, hash: hashes[path] ?? "x" })),
    ...extra,
  }, null, 2);
}

function sha(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** A complete upstream: the manifest, index.md and every listed file (no SNAPSHOT.json unless asked). */
function serveSnapshot(files: Record<string, string>, etag = '"e1"', base = BASE): void {
  // Upstream's manifest carries a hash per document, so new content is a new manifest.
  const hashes = Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha(body)]));
  served.set(`${base}manifest.json`, { body: manifest(Object.keys(files), {}, hashes), type: "text/plain; charset=utf-8", etag });
  served.set(`${base}index.md`, { body: "# Index\n\n| [Wiki](./wiki-content.md) |\n", type: "text/plain; charset=utf-8" });
  for (const [path, body] of Object.entries(files)) served.set(`${base}${path}`, { body, type: "text/plain; charset=utf-8" });
}

/** The mirror's SNAPSHOT.json for what is served under a base right now (#203's shape). */
function serveRecord(base = BASE, override: Record<string, string> = {}): void {
  const files = [...served.entries()]
    .filter(([url]) => url.startsWith(base) && !url.endsWith("SNAPSHOT.json"))
    .map(([url, entry]) => ({ path: url.slice(base.length), sha256: override[url.slice(base.length)] ?? sha(entry.body ?? ""), bytes: 0 }));
  served.set(`${base}SNAPSHOT.json`, {
    body: JSON.stringify({ schema: 1, event: "edge-india-2026", source: { repo: "x/y", path: "references", commit: "0".repeat(40), commit_date: "2026-10-01T00:00:00.000Z" }, synced_at: "2026-10-05T00:00:00.000Z", files }),
    type: "text/plain; charset=utf-8",
  });
}

const MIRROR_BASE = "https://raw.githubusercontent.com/Edge-City/agentvillage/main/skills/edge-india/references/";

const fakeFetch = async (url: string, init: RequestInit): Promise<Response> => {
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  requests.push({ url, headers });
  expect(init.redirect).toBe("manual");
  const entry = served.get(url);
  if (!entry) return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
  if (entry.etag && headers["if-none-match"] === entry.etag) return new Response(null, { status: 304, headers: { etag: entry.etag } });
  const out = new Headers();
  if (entry.type !== null) out.set("content-type", entry.type ?? "text/plain; charset=utf-8");
  if (entry.etag) out.set("etag", entry.etag);
  if (entry.location) out.set("location", entry.location);
  if (entry.length) out.set("content-length", entry.length);
  return new Response(entry.body ?? "", { status: entry.status ?? 200, headers: out });
};

function opts(env: Record<string, string> = { KNOWLEDGE_SNAPSHOT_URL: MANIFEST_URL }, over: Partial<SyncOptions> = {}): SyncOptions {
  return { home, env, fetchImpl: fakeFetch, now: () => new Date("2026-10-11T03:00:00Z"), ...over };
}

/** Every file under a directory, path → content, for byte-for-byte comparisons. */
function tree(dir: string, prefix = ""): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) Object.assign(out, tree(path, `${prefix}${entry}/`));
    else out[`${prefix}${entry}`] = readFileSync(path, "utf8");
  }
  return out;
}

function logLines(): Record<string, unknown>[] {
  const path = syncLogPath(home);
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function knowledgeEntries(): string[] {
  const dir = join(home, "knowledge");
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-knowledge-sync-"));
  served = new Map();
  requests = [];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("switched off, and the default snapshot", () => {
  test("KNOWLEDGE_SNAPSHOT_URL= (empty) in .env: unconfigured, nothing fetched, no knowledge file written, one log line", async () => {
    serveSnapshot({ "a.md": "A\n" });
    writeFileSync(join(home, ".env"), "KNOWLEDGE_SNAPSHOT_URL=\n");
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: MANIFEST_URL }));
    expect(result).toMatchObject({ status: "unconfigured", reason: "unset", files: 0, bytes: 0, sha256: null });
    expect(exitCode(result)).toBe(0);
    expect(requests).toEqual([]);
    expect(existsSync(join(home, "knowledge"))).toBe(false);
    expect(logLines()).toEqual([{ v: 1, event: "knowledge_sync", status: "unconfigured", reason: "unset", files: 0, bytes: 0, sha256: null, fetched_at: "2026-10-11T03:00:00.000Z" }]);
  });

  test("CRLF line endings: KNOWLEDGE_SNAPSHOT_URL=\"\" switches it off (recheck S1)", async () => {
    serveSnapshot({ "a.md": "A\n" });
    writeFileSync(join(home, ".env"), 'OTHER=1\r\nKNOWLEDGE_SNAPSHOT_URL=""\r\n');
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: MANIFEST_URL }));
    expect(result.status).toBe("unconfigured");
    expect(requests).toEqual([]);
  });

  test("CRLF line endings: an override URL in .env is honoured, not the default (recheck S1)", async () => {
    serveSnapshot({ "a.md": "A\n" });
    writeFileSync(join(home, ".env"), `KNOWLEDGE_SNAPSHOT_URL=${MANIFEST_URL}\r\n`);
    const result = await runKnowledgeSync(opts({}));
    expect(result.status).toBe("ok");
    expect(requests[0].url).toBe(MANIFEST_URL);
  });

  test("with no .env, an empty (or blank) variable switches it off too", async () => {
    expect((await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: "  " }))).status).toBe("unconfigured");
    expect(requests).toEqual([]);
  });

  test("no .env and no variable: the built-in default, Edge City's mirror in this repo, is synced", async () => {
    expect(DEFAULT_SNAPSHOT_URL).toBe(`${MIRROR_BASE}manifest.json`);
    serveSnapshot({ "a.md": "A\n" }, '"e1"', MIRROR_BASE);
    serveRecord(MIRROR_BASE);
    const result = await runKnowledgeSync(opts({}));
    expect(result).toMatchObject({ status: "ok", reason: "written", files: 2 });
    expect(requests[0].url).toBe(DEFAULT_SNAPSHOT_URL);
    expect(JSON.parse(readFileSync(join(currentSetDir(home), "_sync.json"), "utf8")).source).toBe(DEFAULT_SNAPSHOT_URL);
  });

  test("a .env without the line means the default, whatever the (stale) process environment holds", async () => {
    // The gateway loaded .env at its start: a deleted line lives on in its environment.
    serveSnapshot({ "a.md": "A\n" }, '"e1"', MIRROR_BASE);
    writeFileSync(join(home, ".env"), "OTHER=1\n");
    const stale = "https://raw.githubusercontent.com/Edge-City/stale/main/manifest.json";
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: stale }));
    expect(result.status).toBe("ok");
    expect(requests.map((r) => r.url)).not.toContain(stale);
    expect(requests[0].url).toBe(DEFAULT_SNAPSHOT_URL);
  });

  test("a .env without KNOWLEDGE_SNAPSHOT_HOSTS means no extra hosts, whatever the process environment holds", async () => {
    writeFileSync(join(home, ".env"), "KNOWLEDGE_SNAPSHOT_URL=https://knowledge.edgecity.live/india/manifest.json\n");
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_HOSTS: "knowledge.edgecity.live" }));
    expect(result).toMatchObject({ status: "failed", reason: "host-not-allowed" });
    expect(requests).toEqual([]);
  });

  test("an .env that exists but cannot be read fails the run (env-unreadable), nothing fetched", async () => {
    mkdirSync(join(home, ".env"));
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: MANIFEST_URL }));
    expect(result).toMatchObject({ status: "failed", reason: "env-unreadable" });
    expect(exitCode(result)).toBe(1);
    expect(requests).toEqual([]);
  });
});

describe("the host allowlist", () => {
  const refused = [
    ["http, not https", "http://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/manifest.json"],
    ["another org on raw.githubusercontent.com", "https://raw.githubusercontent.com/evil/edge-agent-skill/main/references/manifest.json"],
    ["another repo of p2p-lanes", "https://raw.githubusercontent.com/p2p-lanes/other/main/references/manifest.json"],
    ["the former upstream, aromeoes/edge-agent-skill (the upstream is p2p-lanes/edge-agent-skill since 2026-10-07, DATA-393)", "https://raw.githubusercontent.com/aromeoes/edge-agent-skill/main/references/manifest.json"],
    ["a look-alike of the upstream repo", "https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill-evil/main/references/manifest.json"],
    ["a look-alike org prefix", "https://raw.githubusercontent.com/Edge-City-evil/x/main/manifest.json"],
    ["a user name in the URL", "https://u:p@raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/manifest.json"],
    ["an explicit port", "https://raw.githubusercontent.com:8443/p2p-lanes/edge-agent-skill/main/references/manifest.json"],
    ["a query string", `${MANIFEST_URL}?token=x`],
    ["a fragment", `${MANIFEST_URL}#x`],
    ["github.com itself", "https://github.com/p2p-lanes/edge-agent-skill/raw/main/references/manifest.json"],
    ["a look-alike host", "https://raw.githubusercontent.com.evil.example/p2p-lanes/edge-agent-skill/manifest.json"],
    ["not a URL", "raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/manifest.json"],
    ["not a .json manifest", `${BASE}index.md`],
    ["an encoded dot-dot that climbs out of the allowed repo", "https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/%2e%2e/%2e%2e/evil/x/manifest.json"],
    ["an encoded character in the path", "https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references%2Fmanifest.json"],
  ];
  for (const [label, url] of refused) {
    test(`refused, nothing fetched or written: ${label}`, async () => {
      const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: url }));
      expect(result.status).toBe("failed");
      expect(["host-not-allowed", "bad-url"]).toContain(result.reason);
      expect(requests).toEqual([]);
      expect(knowledgeEntries()).toEqual([]);
    });
  }

  test("allowed: anything under Edge-City/ (the default mirror) and, as an operator override, p2p-lanes/edge-agent-skill on raw.githubusercontent.com", () => {
    const none = new Set<string>();
    expect(urlAllowed(new URL(DEFAULT_SNAPSHOT_URL), none)).toBe(true);
    expect(urlAllowed(new URL(MANIFEST_URL), none)).toBe(true);
    expect(urlAllowed(new URL("https://raw.githubusercontent.com/Edge-City/agentvillage/main/k/manifest.json"), none)).toBe(true);
    expect(urlAllowed(new URL("https://RAW.githubusercontent.com/Edge-City/agentvillage/main/k/manifest.json"), none)).toBe(true);
  });

  test("KNOWLEDGE_SNAPSHOT_HOSTS adds a host, but never widens raw.githubusercontent.com or admits an IP literal", () => {
    const hosts = parseExtraHosts("knowledge.edgecity.live, raw.githubusercontent.com 127.0.0.1 localhost https://x.example/ [::1]");
    expect([...hosts].sort()).toEqual(["knowledge.edgecity.live", "raw.githubusercontent.com"]);
    expect(urlAllowed(new URL("https://knowledge.edgecity.live/snap/manifest.json"), hosts)).toBe(true);
    expect(urlAllowed(new URL("https://raw.githubusercontent.com/evil/x/manifest.json"), hosts)).toBe(false);
    expect(urlAllowed(new URL("https://127.0.0.1/manifest.json"), hosts)).toBe(false);
    expect(urlAllowed(new URL("https://other.edgecity.live/manifest.json"), hosts)).toBe(false);
  });

  test("an allowlisted extra host syncs; its files come from the manifest's own directory", async () => {
    const base = "https://knowledge.edgecity.live/india/";
    served.set(`${base}manifest.json`, { body: manifest(["a.md"]), type: "application/json" });
    served.set(`${base}index.md`, { body: "# i\n", type: "text/markdown" });
    served.set(`${base}a.md`, { body: "# a\n", type: "text/markdown; charset=utf-8" });
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: `${base}manifest.json`, KNOWLEDGE_SNAPSHOT_HOSTS: "knowledge.edgecity.live" }));
    expect(result).toMatchObject({ status: "ok", files: 2 });
    expect(requests.map((r) => r.url).sort()).toEqual([`${base}SNAPSHOT.json`, `${base}a.md`, `${base}index.md`, `${base}manifest.json`]);
  });
});

describe("a full sync", () => {
  test("writes the manifest, index.md and every listed file into knowledge/edge-india/, with _sync.json, and logs ok", async () => {
    serveSnapshot({ "wiki-content.md": "# Wiki\n\nSource: https://edgecity.notion.site/x\n", "newsletter/housing.md": "# Housing\n" });
    const result = await runKnowledgeSync(opts());
    const sha = createHash("sha256").update(served.get(MANIFEST_URL)!.body as string).digest("hex");
    expect(result).toMatchObject({ status: "ok", reason: "written", files: 3, sha256: sha });
    const set = tree(currentSetDir(home));
    expect(Object.keys(set).sort()).toEqual(["SNAPSHOT.json", "_sync.json", "index.md", "manifest.json", "newsletter/housing.md", "wiki-content.md"]);
    // No SNAPSHOT.json upstream: the job stores a record of the bytes it fetched, one sha256 per file.
    const stored = JSON.parse(set["SNAPSHOT.json"]);
    expect(stored.schema).toBe(1);
    expect(Object.fromEntries(stored.files.map((file: { path: string; sha256: string }) => [file.path, file.sha256]))).toEqual(
      Object.fromEntries(["manifest.json", "index.md", "wiki-content.md", "newsletter/housing.md"].map((path) => [path, createHash("sha256").update(set[path]).digest("hex")])),
    );
    expect(set["wiki-content.md"]).toContain("Source: https://edgecity.notion.site/x");
    const state = JSON.parse(set["_sync.json"]);
    expect(state).toMatchObject({ v: 1, source: MANIFEST_URL, manifest_sha256: sha, etag: '"e1"', files: ["index.md", "wiki-content.md", "newsletter/housing.md"] });
    expect(state.hashes).toEqual({ "wiki-content.md": createHash("sha256").update("# Wiki\n\nSource: https://edgecity.notion.site/x\n").digest("hex"), "newsletter/housing.md": createHash("sha256").update("# Housing\n").digest("hex") });
    expect(state.fetched_at).toBe("2026-10-11T03:00:00.000Z");
    expect(state.checked_at).toBe("2026-10-11T03:00:00.000Z");
    expect(result.bytes).toBe(state.bytes);
    expect(existsSync(previousSetDir(home))).toBe(false);
    expect(knowledgeEntries()).toEqual(["edge-india"]);
    const [line] = logLines();
    expect(line).toEqual({ v: 1, event: "knowledge_sync", status: "ok", reason: "written", files: 3, bytes: result.bytes, sha256: sha, fetched_at: "2026-10-11T03:00:00.000Z" });
    expect(JSON.stringify(line)).not.toContain("http");
  });

  test("a changed snapshot replaces the set and keeps the one it replaced in knowledge-prev/, outside knowledge/", async () => {
    serveSnapshot({ "wiki-content.md": "# Wiki v1\n" }, '"e1"');
    await runKnowledgeSync(opts());
    const first = tree(currentSetDir(home));
    served.clear();
    serveSnapshot({ "wiki-content.md": "# Wiki v2\n", "website-content.md": "# Site\n" }, '"e2"');
    const result = await runKnowledgeSync(opts());
    expect(result.status).toBe("ok");
    expect(tree(currentSetDir(home))["wiki-content.md"]).toBe("# Wiki v2\n");
    expect(tree(previousSetDir(home))).toEqual(first);
    expect(previousSetDir(home)).toBe(join(home, "knowledge-prev", "edge-india"));
    expect(knowledgeEntries()).toEqual(["edge-india"]);
  });

  test("a document the manifest drops leaves the current set (it stays in prev)", async () => {
    serveSnapshot({ "a.md": "A\n", "b.md": "B\n" }, '"e1"');
    await runKnowledgeSync(opts());
    served.clear();
    serveSnapshot({ "a.md": "A\n" }, '"e2"');
    await runKnowledgeSync(opts());
    expect(existsSync(join(currentSetDir(home), "b.md"))).toBe(false);
    expect(existsSync(join(previousSetDir(home), "b.md"))).toBe(true);
  });
});

describe("unchanged", () => {
  test("the manifest answers 304 to the stored ETag: unchanged, only the manifest requested, only checked_at rewritten", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    const before = tree(currentSetDir(home));
    requests = [];
    const later = () => new Date("2026-10-13T03:00:00Z");
    const result = await runKnowledgeSync(opts(undefined, { now: later }));
    expect(result).toMatchObject({ status: "unchanged", reason: "etag", files: 2 });
    expect(requests.map((r) => r.url)).toEqual([MANIFEST_URL]);
    expect(requests[0].headers["if-none-match"]).toBe('"e1"');
    const after = tree(currentSetDir(home));
    const { "_sync.json": stateBefore, ...filesBefore } = before;
    const { "_sync.json": stateAfter, ...filesAfter } = after;
    expect(filesAfter).toEqual(filesBefore);
    // S1: fetched_at stays the time the content was written; checked_at is the last confirmation.
    expect(JSON.parse(stateAfter)).toEqual({ ...JSON.parse(stateBefore), checked_at: "2026-10-13T03:00:00.000Z" });
    expect(JSON.parse(stateAfter).fetched_at).toBe("2026-10-11T03:00:00.000Z");
    expect(existsSync(previousSetDir(home))).toBe(false);
    expect(readdirSync(currentSetDir(home)).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  test("no ETag but the same manifest sha256: unchanged, no file fetched or written", async () => {
    serveSnapshot({ "a.md": "A\n" }, "");
    await runKnowledgeSync(opts());
    requests = [];
    const result = await runKnowledgeSync(opts(undefined, { now: () => new Date("2026-10-12T09:30:00Z") }));
    expect(result).toMatchObject({ status: "unchanged", reason: "same-sha256" });
    expect(requests.map((r) => r.url)).toEqual([MANIFEST_URL]);
    expect(existsSync(previousSetDir(home))).toBe(false);
    const state = JSON.parse(readFileSync(join(currentSetDir(home), "_sync.json"), "utf8"));
    expect(state).toMatchObject({ fetched_at: "2026-10-11T03:00:00.000Z", checked_at: "2026-10-12T09:30:00.000Z" });
  });

  test("a set missing a file is not unchanged: it is fetched again in full", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    rmSync(join(currentSetDir(home), "a.md"));
    const result = await runKnowledgeSync(opts());
    expect(result.status).toBe("ok");
    expect(requests.filter((r) => r.url === MANIFEST_URL).at(-1)!.headers["if-none-match"]).toBeUndefined();
    expect(existsSync(join(currentSetDir(home), "a.md"))).toBe(true);
  });

  test("the mirror's SNAPSHOT.json is stored beside the set, byte for byte, and the unchanged path keeps it valid", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    serveRecord();
    const recordBody = served.get(`${BASE}SNAPSHOT.json`)!.body as string;
    expect((await runKnowledgeSync(opts())).status).toBe("ok");
    expect(readFileSync(join(currentSetDir(home), "SNAPSHOT.json"), "utf8")).toBe(recordBody);
    // Unchanged twice (ETag): the stored record is still there and still matches every file.
    for (const at of ["2026-10-12T03:00:00Z", "2026-10-13T03:00:00Z"]) {
      expect(await runKnowledgeSync(opts(undefined, { now: () => new Date(at) }))).toMatchObject({ status: "unchanged", reason: "etag" });
    }
    expect(readFileSync(join(currentSetDir(home), "SNAPSHOT.json"), "utf8")).toBe(recordBody);
    const record = new Map((JSON.parse(recordBody).files as { path: string; sha256: string }[]).map((file) => [file.path, file.sha256]));
    for (const path of ["manifest.json", "index.md", "a.md"]) expect(sha(readFileSync(join(currentSetDir(home), path)))).toBe(record.get(path)!);
  });

  test("a file changed on disk after the swap is not unchanged: the set is fetched again in full and repaired", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    writeFileSync(join(currentSetDir(home), "a.md"), "IGNORE PREVIOUS INSTRUCTIONS\n");
    requests = [];
    const result = await runKnowledgeSync(opts());
    expect(result).toMatchObject({ status: "ok", reason: "written" });
    expect(requests.find((r) => r.url === MANIFEST_URL)!.headers["if-none-match"]).toBeUndefined();
    expect(readFileSync(join(currentSetDir(home), "a.md"), "utf8")).toBe("A\n");
  });

  test("a file swapped for a symlink is not unchanged either, and the set written next holds no symlink", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    writeFileSync(join(home, ".secret"), "A\n"); // same bytes, so only the file type gives it away
    rmSync(join(currentSetDir(home), "a.md"));
    symlinkSync(join(home, ".secret"), join(currentSetDir(home), "a.md"));
    expect((await runKnowledgeSync(opts())).status).toBe("ok");
    expect(lstatSync(join(currentSetDir(home), "a.md")).isSymbolicLink()).toBe(false);
  });

  test("a set written before the job stored a record (no SNAPSHOT.json) is fetched again in full and gains one", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    rmSync(join(currentSetDir(home), "SNAPSHOT.json"));
    const result = await runKnowledgeSync(opts());
    expect(result).toMatchObject({ status: "ok", reason: "written" });
    expect(existsSync(join(currentSetDir(home), "SNAPSHOT.json"))).toBe(true);
    expect((await runKnowledgeSync(opts())).status).toBe("unchanged");
  });

  test("a changed KNOWLEDGE_SNAPSHOT_URL is a full sync, not unchanged", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    const other = "https://raw.githubusercontent.com/Edge-City/k/main/manifest.json";
    served.set(other, { body: manifest(["a.md"]), type: "application/json", etag: '"e1"' });
    served.set("https://raw.githubusercontent.com/Edge-City/k/main/index.md", { body: "# i\n" });
    served.set("https://raw.githubusercontent.com/Edge-City/k/main/a.md", { body: "A2\n" });
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: other }));
    expect(result.status).toBe("ok");
    expect(readFileSync(join(currentSetDir(home), "a.md"), "utf8")).toBe("A2\n");
  });
});

describe("any failure keeps the last good set byte for byte", () => {
  async function goodSet(): Promise<Record<string, string>> {
    serveSnapshot({ "wiki-content.md": "# Wiki\n", "newsletter/n.md": "# N\n" }, '"e1"');
    expect((await runKnowledgeSync(opts())).status).toBe("ok");
    served.clear();
    serveSnapshot({ "wiki-content.md": "# Wiki NEW\n", "newsletter/n.md": "# N NEW\n" }, '"e2"');
    return tree(currentSetDir(home));
  }

  async function expectKept(before: Record<string, string>, reason: string): Promise<void> {
    const result = await runKnowledgeSync(opts());
    expect(result).toMatchObject({ status: "failed", reason });
    expect(tree(currentSetDir(home))).toEqual(before);
    expect(existsSync(previousSetDir(home))).toBe(false);
    expect(knowledgeEntries()).toEqual(["edge-india"]);
    expect(logLines().at(-1)).toMatchObject({ event: "knowledge_sync", status: "failed", reason });
  }

  test("a listed document is missing (404)", async () => {
    const before = await goodSet();
    served.delete(`${BASE}newsletter/n.md`);
    await expectKept(before, "http-404");
  });

  test("index.md is missing", async () => {
    const before = await goodSet();
    served.delete(`${BASE}index.md`);
    await expectKept(before, "http-404");
  });

  test("the manifest is not JSON, lists nothing, or has no event", async () => {
    const before = await goodSet();
    served.set(MANIFEST_URL, { body: "{nope", type: "text/plain" });
    await expectKept(before, "bad-manifest");
    served.set(MANIFEST_URL, { body: JSON.stringify({ event: "edge-india-2026", documents: [] }), type: "text/plain" });
    await expectKept(before, "bad-manifest");
    served.set(MANIFEST_URL, { body: JSON.stringify({ documents: [{ path: "a.md" }] }), type: "text/plain" });
    await expectKept(before, "bad-manifest");
  });

  for (const path of ["../escape.md", "/abs.md", "a/../b.md", "notes.txt", "a.md/../../x.md", "dir.md/x.md", "_sync.json", "sub/.hidden.md", "a b.md", "x%2f.md"]) {
    test(`a manifest path that leaves the directory or is not plain .md is refused: ${path}`, async () => {
      const before = await goodSet();
      served.set(MANIFEST_URL, { body: manifest(["wiki-content.md", path]), type: "text/plain", etag: '"e3"' });
      await expectKept(before, "bad-path");
      expect(requests.some((r) => r.url.includes("escape") || r.url.includes("abs.md"))).toBe(false);
    });
  }

  test("a duplicated path is refused", async () => {
    const before = await goodSet();
    served.set(MANIFEST_URL, { body: manifest(["wiki-content.md", "wiki-content.md"]), type: "text/plain", etag: '"e3"' });
    await expectKept(before, "bad-path");
  });

  test("an HTML page served as text/html is refused", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { body: "<html><body>login</body></html>", type: "text/html; charset=utf-8" });
    await expectKept(before, "html");
  });

  test("an HTML page served as text/plain is refused", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { body: "﻿  <!DOCTYPE html>\n<html><body>x</body></html>", type: "text/plain" });
    await expectKept(before, "html");
  });

  test("an unexpected content type, or none, is refused", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { body: "# x", type: "application/octet-stream" });
    await expectKept(before, "bad-content-type");
    served.set(`${BASE}wiki-content.md`, { body: "# x", type: null });
    await expectKept(before, "bad-content-type");
  });

  test("bytes that are not UTF-8, or carry a NUL, are refused", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { body: new Uint8Array([0x23, 0xff, 0xfe, 0x0a]), type: "text/plain" });
    await expectKept(before, "not-utf8");
    served.set(`${BASE}wiki-content.md`, { body: "# a\u0000b", type: "text/plain" });
    await expectKept(before, "not-utf8");
  });

  test("a file over the per-file cap is refused (read cap and declared length)", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { body: "x".repeat(5000), type: "text/plain" });
    const capped = await runKnowledgeSync(opts(undefined, { fileCapBytes: 4096 }));
    expect(capped).toMatchObject({ status: "failed", reason: "too-large" });
    served.set(`${BASE}wiki-content.md`, { body: "small", type: "text/plain", length: String(3 * 1024 * 1024) });
    await expectKept(before, "too-large");
  });

  test("a set over the total cap is refused", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { body: "x".repeat(3000), type: "text/plain" });
    served.set(`${BASE}newsletter/n.md`, { body: "y".repeat(3000), type: "text/plain" });
    const result = await runKnowledgeSync(opts(undefined, { totalCapBytes: 5000 }));
    expect(result).toMatchObject({ status: "failed", reason: "total-too-large" });
    expect(tree(currentSetDir(home))).toEqual(before);
  });

  test("a fetch that hangs times out", async () => {
    const before = await goodSet();
    const hanging = (url: string, init: RequestInit): Promise<Response> =>
      url.endsWith("n.md")
        ? new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
        : fakeFetch(url, init);
    const result = await runKnowledgeSync(opts(undefined, { fetchImpl: hanging, fetchTimeoutMs: 50 }));
    expect(result).toMatchObject({ status: "failed", reason: "timeout" });
    expect(tree(currentSetDir(home))).toEqual(before);
  });

  test("a fetch cut off by the run's budget (not its own timeout) logs budget", async () => {
    const before = await goodSet();
    const hanging = (url: string, init: RequestInit): Promise<Response> =>
      url.endsWith("n.md")
        ? new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))
        : fakeFetch(url, init);
    const result = await runKnowledgeSync(opts(undefined, { fetchImpl: hanging, fetchTimeoutMs: 10_000, runBudgetMs: 80 }));
    expect(result).toMatchObject({ status: "failed", reason: "budget" });
    expect(tree(currentSetDir(home))).toEqual(before);
  });

  test("a network error fails the run", async () => {
    const before = await goodSet();
    const broken = async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    };
    const result = await runKnowledgeSync(opts(undefined, { fetchImpl: broken }));
    expect(result).toMatchObject({ status: "failed", reason: "network" });
    expect(tree(currentSetDir(home))).toEqual(before);
  });

  test("a redirect off the host, or out of the manifest's directory, is refused and never followed", async () => {
    const before = await goodSet();
    served.set(`${BASE}wiki-content.md`, { status: 302, location: "https://evil.example/wiki-content.md" });
    await expectKept(before, "redirect-refused");
    expect(requests.some((r) => r.url.startsWith("https://evil.example"))).toBe(false);
    served.set(`${BASE}wiki-content.md`, { status: 301, location: "https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/other/wiki-content.md" });
    await expectKept(before, "redirect-refused");
    served.set(`${BASE}wiki-content.md`, { status: 301, location: "http://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/wiki-content.md" });
    await expectKept(before, "redirect-refused");
    served.set(`${BASE}wiki-content.md`, { status: 302 });
    await expectKept(before, "redirect-refused");
  });

  test("a redirect inside the manifest's directory is followed (at most 3)", async () => {
    await goodSet();
    served.set(`${BASE}wiki-content.md`, { status: 302, location: "./moved/wiki-content.md" });
    served.set(`${BASE}moved/wiki-content.md`, { body: "# moved\n", type: "text/plain" });
    served.set(MANIFEST_URL, { body: manifest(["wiki-content.md", "newsletter/n.md"], { generation: 8 }), type: "text/plain", etag: '"e8"' });
    expect((await runKnowledgeSync(opts())).status).toBe("ok");
    expect(readFileSync(join(currentSetDir(home), "wiki-content.md"), "utf8")).toBe("# moved\n");
    served.set(MANIFEST_URL, { body: manifest(["wiki-content.md", "newsletter/n.md"]), type: "text/plain", etag: '"e9"' });
    served.set(`${BASE}wiki-content.md`, { status: 302, location: `${BASE}r1.md` });
    served.set(`${BASE}r1.md`, { status: 302, location: `${BASE}r2.md` });
    served.set(`${BASE}r2.md`, { status: 302, location: `${BASE}r3.md` });
    served.set(`${BASE}r3.md`, { status: 302, location: `${BASE}r4.md` });
    const result = await runKnowledgeSync(opts());
    expect(result).toMatchObject({ status: "failed", reason: "too-many-redirects" });
  });

  test("a manifest served as text/html is refused before any file is fetched", async () => {
    const before = await goodSet();
    served.set(MANIFEST_URL, { body: "<html></html>", type: "text/html" });
    await expectKept(before, "html");
    expect(requests.at(-1)!.url).toBe(MANIFEST_URL);
  });
});

describe("crash safety and one run at a time", () => {
  test("a run killed between the two renames (no current set, prev present) is recovered at the next run", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    const good = tree(currentSetDir(home));
    // As if killed after current → prev and before temp → current.
    mkdirSync(join(home, "knowledge", ".edge-india.tmp-999-dead"), { recursive: true });
    writeFileSync(join(home, "knowledge", ".edge-india.tmp-999-dead", "half.md"), "half");
    rmSync(previousSetDir(home), { recursive: true, force: true });
    copyDir(currentSetDir(home), previousSetDir(home));
    rmSync(currentSetDir(home), { recursive: true, force: true });
    const result = await runKnowledgeSync(opts());
    expect(result).toMatchObject({ status: "unchanged", reason: "etag" });
    expect(tree(currentSetDir(home))).toEqual(good);
    expect(knowledgeEntries()).toEqual(["edge-india"]);
  });

  test("a held lock skips the run without touching the set (exit 0, logged); a lock older than 3 minutes is taken over", async () => {
    serveSnapshot({ "a.md": "A\n" }, '"e1"');
    await runKnowledgeSync(opts());
    const before = tree(currentSetDir(home));
    const lock = join(home, "knowledge", ".edge-india.lock");
    mkdirSync(lock);
    requests = [];
    const skipped = await runKnowledgeSync(opts());
    expect(skipped).toMatchObject({ status: "skipped", reason: "locked" });
    expect(exitCode(skipped)).toBe(0);
    expect(requests).toEqual([]);
    expect(tree(currentSetDir(home))).toEqual(before);
    expect(logLines().at(-1)).toMatchObject({ status: "skipped", reason: "locked" });
    const old = (Date.now() - 4 * 60 * 1000) / 1000;
    utimesSync(lock, old, old);
    expect((await runKnowledgeSync(opts())).status).toBe("unchanged");
    expect(existsSync(lock)).toBe(false);
  });
});

describe("configuration and the log", () => {
  test("$HERMES_HOME/.env wins over the process environment (Hermes lets .env win; the control plane writes it)", async () => {
    serveSnapshot({ "a.md": "A\n" });
    writeFileSync(join(home, ".env"), `OTHER=1\nKNOWLEDGE_SNAPSHOT_URL="${MANIFEST_URL}"\n`);
    const result = await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: "https://evil.example/manifest.json" }));
    expect(result.status).toBe("ok");
    writeFileSync(join(home, ".env"), "KNOWLEDGE_SNAPSHOT_URL=\n");
    expect((await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: MANIFEST_URL }))).status).toBe("unconfigured");
  });

  test("the log rotates to sync.jsonl.1 at 1 MB", async () => {
    const path = syncLogPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "x".repeat(LOG_MAX_BYTES));
    await runKnowledgeSync(opts({ KNOWLEDGE_SNAPSHOT_URL: "" }));
    expect(statSync(`${path}.1`).size).toBe(LOG_MAX_BYTES);
    expect(logLines()).toHaveLength(1);
  });

  test("documentPathValid and snapshotSource agree with the manifest shape upstream uses", () => {
    for (const path of ["wiki-content.md", "website/about.md", "newsletter/a-typical-day-and-week-at-edge-city.md", "residencies/community-builders.md"]) {
      expect(documentPathValid(path)).toBe(true);
    }
    const source = snapshotSource(MANIFEST_URL, new Set());
    expect(source.ok && source.base.href).toBe(BASE);
  });
});

describe("a mixed snapshot across CDN commits heals itself (real fetch, local server)", () => {
  // The refuter's pattern: Bun's own fetch against a local server standing in
  // for raw.githubusercontent.com, two manifest versions, one stale body.
  let server: ReturnType<typeof Bun.serve>;
  let routes: Map<string, (req: Request) => Response>;

  beforeEach(() => {
    routes = new Map();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req) {
        const route = routes.get(new URL(req.url).pathname);
        return route ? route(req) : new Response("nope", { status: 404, headers: { "content-type": "text/plain" } });
      },
    });
  });

  afterEach(() => {
    server.stop(true);
  });

  const local = (url: string, init: RequestInit): Promise<Response> => {
    const target = new URL(url);
    if (target.hostname !== "raw.githubusercontent.com") throw new Error(`off-host fetch ${url}`);
    return fetch(`http://127.0.0.1:${server.port}${target.pathname}`, init);
  };
  const path = (rel: string) => new URL(rel, BASE).pathname;
  const text = (body: string, headers: Record<string, string> = {}) => () =>
    new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", ...headers } });
  /** A manifest that answers 304 to its own ETag, as GitHub's raw host does. */
  const manifestRoute = (body: string, etag: string) => (req: Request) =>
    req.headers.get("if-none-match") === etag
      ? new Response(null, { status: 304, headers: { etag } })
      : new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", etag } });
  const run = (now: string) => runKnowledgeSync({ home, env: { KNOWLEDGE_SNAPSHOT_URL: MANIFEST_URL }, fetchImpl: local, now: () => new Date(now) });
  const state = () => JSON.parse(readFileSync(join(currentSetDir(home), "_sync.json"), "utf8"));

  test("a document whose manifest hash changed but whose body is the stored copy: incomplete, nothing advanced, healed on the next run", async () => {
    const a1 = "# A\n\nversion one\n";
    const a2 = "# A\n\nversion two\n";
    const b = "# B\n\nunchanged\n";
    const manifestA = manifest(["a.md", "b.md"], {}, { "a.md": sha(a1), "b.md": sha(b) });
    const manifestB = manifest(["a.md", "b.md"], {}, { "a.md": sha(a2), "b.md": sha(b) });
    routes.set(path("manifest.json"), manifestRoute(manifestA, '"e1"'));
    routes.set(path("index.md"), text("# Index\n"));
    routes.set(path("a.md"), text(a1));
    routes.set(path("b.md"), text(b));
    expect((await run("2026-10-11T00:00:00Z")).status).toBe("ok");
    const good = tree(currentSetDir(home));
    expect(state().hashes).toEqual({ "a.md": sha(a1), "b.md": sha(b) });

    // Upstream pushes: the manifest is B, but the CDN still serves a.md's old bytes.
    routes.set(path("manifest.json"), manifestRoute(manifestB, '"e2"'));
    const stale = await run("2026-10-11T00:30:00Z");
    expect(stale).toMatchObject({ status: "incomplete", reason: "stale-document", path: "a.md" });
    expect(exitCode(stale)).toBe(1);
    expect(tree(currentSetDir(home))).toEqual(good);
    expect(state()).toMatchObject({ etag: '"e1"', manifest_sha256: sha(manifestA), checked_at: "2026-10-11T00:00:00.000Z" });
    expect(existsSync(previousSetDir(home))).toBe(false);
    expect(logLines().at(-1)).toMatchObject({ status: "incomplete", reason: "stale-document", path: "a.md" });

    // Still stale on the next run: still incomplete (the ETag was not advanced, so it is not "unchanged").
    expect((await run("2026-10-11T01:00:00Z")).status).toBe("incomplete");

    // The CDN heals: the next run writes B. b.md (same hash, same body) never blocks it.
    routes.set(path("a.md"), text(a2));
    const healed = await run("2026-10-11T01:30:00Z");
    expect(healed).toMatchObject({ status: "ok", reason: "written" });
    expect(readFileSync(join(currentSetDir(home), "a.md"), "utf8")).toBe(a2);
    expect(readFileSync(join(currentSetDir(home), "b.md"), "utf8")).toBe(b);
    expect(state()).toMatchObject({ etag: '"e2"', manifest_sha256: sha(manifestB), hashes: { "a.md": sha(a2), "b.md": sha(b) } });

    // And the run after that is unchanged by ETag.
    expect(await run("2026-10-11T02:00:00Z")).toMatchObject({ status: "unchanged", reason: "etag" });
  });

  /** The mirror's SNAPSHOT.json for given file bodies (#203's shape). */
  const record = (files: Record<string, string>) =>
    JSON.stringify({ schema: 1, event: "edge-india-2026", source: { repo: "x/y", path: "references", commit: "0".repeat(40), commit_date: "2026-10-01T00:00:00.000Z" }, synced_at: "2026-10-05T00:00:00.000Z", files: Object.entries(files).map(([p, body]) => ({ path: p, sha256: sha(body), bytes: Buffer.byteLength(body) })) });

  test("SNAPSHOT.json beside the manifest: every file is checked against its sha256; a stale file is incomplete, healed next run", async () => {
    const index = "# Index\n";
    const a1 = "# A\n\none\n";
    const a2 = "# A\n\ntwo\n";
    const mA = manifest(["a.md"], {}, { "a.md": sha(a1) });
    const mB = manifest(["a.md"], {}, { "a.md": sha(a2) });
    routes.set(path("manifest.json"), manifestRoute(mA, '"e1"'));
    routes.set(path("SNAPSHOT.json"), text(record({ "manifest.json": mA, "index.md": index, "a.md": a1 })));
    routes.set(path("index.md"), text(index));
    routes.set(path("a.md"), text(a1));
    expect(await run("2026-10-11T00:00:00Z")).toMatchObject({ status: "ok", reason: "written" });
    const good = tree(currentSetDir(home));

    // The mirror moved to B (manifest and SNAPSHOT.json), but a.md is still A at the CDN.
    routes.set(path("manifest.json"), manifestRoute(mB, '"e2"'));
    routes.set(path("SNAPSHOT.json"), text(record({ "manifest.json": mB, "index.md": index, "a.md": a2 })));
    const stale = await run("2026-10-11T00:30:00Z");
    expect(stale).toMatchObject({ status: "incomplete", reason: "snapshot-mismatch", path: "a.md" });
    expect(exitCode(stale)).toBe(1);
    expect(tree(currentSetDir(home))).toEqual(good);
    expect(state()).toMatchObject({ etag: '"e1"', manifest_sha256: sha(mA) });

    // SNAPSHOT.json still the old commit while the manifest is new: the manifest itself mismatches.
    routes.set(path("SNAPSHOT.json"), text(record({ "manifest.json": mA, "index.md": index, "a.md": a1 })));
    routes.set(path("a.md"), text(a2));
    expect(await run("2026-10-11T01:00:00Z")).toMatchObject({ status: "incomplete", reason: "snapshot-mismatch", path: "manifest.json" });

    // All of B at last.
    routes.set(path("SNAPSHOT.json"), text(record({ "manifest.json": mB, "index.md": index, "a.md": a2 })));
    expect(await run("2026-10-11T01:30:00Z")).toMatchObject({ status: "ok", reason: "written" });
    expect(readFileSync(join(currentSetDir(home), "a.md"), "utf8")).toBe(a2);
    expect(state()).toMatchObject({ etag: '"e2"', manifest_sha256: sha(mB) });
  });

  test("SNAPSHOT.json catches a stale file the byte heuristic cannot: the very first sync, and a file it does not list", async () => {
    const index = "# Index\n";
    const a1 = "# A\n\none\n";
    const a2 = "# A\n\ntwo\n";
    const mB = manifest(["a.md"], {}, { "a.md": sha(a2) });
    routes.set(path("manifest.json"), manifestRoute(mB, '"e2"'));
    routes.set(path("SNAPSHOT.json"), text(record({ "manifest.json": mB, "index.md": index, "a.md": a2 })));
    routes.set(path("index.md"), text(index));
    routes.set(path("a.md"), text(a1));
    expect(await run("2026-10-11T00:00:00Z")).toMatchObject({ status: "incomplete", reason: "snapshot-mismatch", path: "a.md" });
    expect(existsSync(currentSetDir(home))).toBe(false);
    routes.set(path("SNAPSHOT.json"), text(record({ "manifest.json": mB, "a.md": a2 })));
    routes.set(path("a.md"), text(a2));
    expect(await run("2026-10-11T00:30:00Z")).toMatchObject({ status: "incomplete", reason: "snapshot-mismatch", path: "index.md" });
    expect(existsSync(currentSetDir(home))).toBe(false);
  });

  test("a malformed SNAPSHOT.json fails the run (bad-snapshot) and keeps the last good set", async () => {
    const index = "# Index\n";
    const a = "# A\n";
    const m1 = manifest(["a.md"], {}, { "a.md": sha(a) });
    routes.set(path("manifest.json"), manifestRoute(m1, '"e1"'));
    routes.set(path("index.md"), text(index));
    routes.set(path("a.md"), text(a));
    expect((await run("2026-10-11T00:00:00Z")).status).toBe("ok");
    const good = tree(currentSetDir(home));
    routes.set(path("manifest.json"), manifestRoute(manifest(["a.md"], { generation: 2 }, { "a.md": sha(a) }), '"e2"'));
    for (const bad of ["{nope", JSON.stringify({ schema: 2, files: [] }), JSON.stringify({ schema: 1, files: [{ path: "a.md", sha256: "XYZ" }] })]) {
      routes.set(path("SNAPSHOT.json"), text(bad));
      expect(await run("2026-10-11T00:30:00Z")).toMatchObject({ status: "failed", reason: "bad-snapshot" });
      expect(tree(currentSetDir(home))).toEqual(good);
    }
  });

  test("a new manifest whose documents kept their hashes and bodies is written normally (no false incomplete)", async () => {
    const a = "# A\n";
    routes.set(path("manifest.json"), manifestRoute(manifest(["a.md"], {}, { "a.md": sha(a) }), '"e1"'));
    routes.set(path("index.md"), text("# Index\n"));
    routes.set(path("a.md"), text(a));
    expect((await run("2026-10-11T00:00:00Z")).status).toBe("ok");
    // Only the manifest's own bytes change (a new field): same hash, same body.
    routes.set(path("manifest.json"), manifestRoute(manifest(["a.md"], { generation: 2 }, { "a.md": sha(a) }), '"e2"'));
    expect(await run("2026-10-11T00:30:00Z")).toMatchObject({ status: "ok", reason: "written" });
  });
});

describe("exit codes", () => {
  test("failed and incomplete exit 1; ok, unchanged, unconfigured and skipped exit 0", () => {
    const at = (status: SyncResult["status"]): SyncResult => ({ status, reason: "r", files: 0, bytes: 0, sha256: null, fetched_at: "" });
    expect(["ok", "unchanged", "unconfigured", "skipped", "failed", "incomplete"].map((status) => exitCode(at(status as SyncResult["status"])))).toEqual([0, 0, 0, 0, 1, 1]);
  });
});

describe("the shim Hermes runs", () => {
  function installShim(): string {
    const target = join(home, "skills", "edge-india", "scripts");
    mkdirSync(join(target, "shims"), { recursive: true });
    copyFileSync(join(REPO_SKILLS, "edge-india", "scripts", "knowledge-sync.ts"), join(target, "knowledge-sync.ts"));
    mkdirSync(join(home, "scripts"), { recursive: true });
    const shim = join(home, "scripts", "agentvillage_knowledge_sync.sh");
    copyFileSync(join(REPO_SKILLS, "edge-india", "scripts", "shims", "agentvillage_knowledge_sync.sh"), shim);
    return shim;
  }

  function runShim(shim: string, env: Record<string, string> = {}) {
    const clean: Record<string, string> = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, ...env };
    return spawnSync("bash", [shim], { cwd: tmpdir(), env: clean, encoding: "utf8", timeout: 30_000 });
  }

  test("switched off (KNOWLEDGE_SNAPSHOT_URL= in .env): exit 0, the wake line is the only stdout, and no knowledge file is written", () => {
    const shim = installShim();
    writeFileSync(join(home, ".env"), "KNOWLEDGE_SNAPSHOT_URL=\n");
    const run = runShim(shim);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(JSON.stringify({ wakeAgent: false, reason: "knowledge-unconfigured-unset" }));
    expect(existsSync(join(home, "knowledge"))).toBe(false);
    expect(logLines()).toHaveLength(1);
  });

  test("a refused URL in .env: exit 1 (a failure for Hermes's local failure target), still silent on stdout", () => {
    const shim = installShim();
    writeFileSync(join(home, ".env"), "KNOWLEDGE_SNAPSHOT_URL=https://evil.example/manifest.json\n");
    const run = runShim(shim);
    expect(run.status).toBe(1);
    expect(JSON.parse(run.stdout.trim())).toEqual({ wakeAgent: false, reason: "knowledge-failed-host-not-allowed" });
  });

  test("no sync script installed: exit 1 with a failed log line", () => {
    const shim = installShim();
    rmSync(join(home, "skills"), { recursive: true, force: true });
    const run = runShim(shim);
    expect(run.status).toBe(1);
    expect(logLines().at(-1)).toMatchObject({ status: "failed", reason: "no-script" });
  });
});

function copyDir(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from)) {
    const source = join(from, entry);
    if (statSync(source).isDirectory()) copyDir(source, join(to, entry));
    else copyFileSync(source, join(to, entry));
  }
}
