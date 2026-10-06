/**
 * The two halves of the India knowledge path agree (DATA-271, rc15):
 *
 *   - #203's sync workflow publishes `skills/edge-india/references/` on `main`
 *     (`scripts/sync-india-references.ts`, with SNAPSHOT.json: a sha256 per file);
 *   - #206's "Edge — knowledge sync" job (`knowledge-sync.ts`) fetches the
 *     manifest at DEFAULT_SNAPSHOT_URL and verifies every file against that
 *     SNAPSHOT.json before it writes `$HERMES_HOME/knowledge/edge-india/`;
 *   - `refs.ts` reads that copy, and by default never fetches.
 *
 * The URL is derived from the workflow, never fetched: the job runs here
 * against a stand-in fetch that serves the committed tree at the raw URL.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

import { DEFAULT_SNAPSHOT_URL, MANIFEST_FILE, SNAPSHOT_RECORD_FILE, currentSetDir, manifestFiles, runKnowledgeSync, snapshotRecord } from "../knowledge-sync";
import { DEFAULT_BASE_URL, run, type Context } from "../refs";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(SKILL_DIR, "..", "..");
const REFERENCES = join(SKILL_DIR, "references");
const WORKFLOW = join(REPO_ROOT, ".github", "workflows", "sync-edge-india-references.yml");
/** The public repo the mirror lives in (the `/Edge-City/` raw prefix the job allows). */
const REPO_SLUG = "Edge-City/agentvillage";

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function tree(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...tree(path));
    else out.push(relative(REFERENCES, path));
  }
  return out;
}

/** The directory the workflow publishes, read from its `--target` argument. */
function workflowTarget(): string {
  const text = readFileSync(WORKFLOW, "utf8");
  const targets = [...text.matchAll(/--target\s+(\S+)/g)].map((m) => m[1]);
  expect(targets.length).toBe(1);
  return targets[0].replace(/\/+$/, "");
}

/** A stand-in for raw.githubusercontent.com serving the committed tree; `override` replaces one file's bytes. */
function rawServer(override: Record<string, string> = {}) {
  const base = new URL("./", DEFAULT_SNAPSHOT_URL).href;
  const requests: string[] = [];
  const fetchImpl = async (url: string) => {
    requests.push(url);
    if (!url.startsWith(base)) return new Response("not found", { status: 404 });
    const rel = url.slice(base.length);
    const path = join(REFERENCES, rel);
    if (!rel || rel.includes("..") || !existsSync(path)) return new Response("404: Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    const body = override[rel] ?? readFileSync(path);
    return new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  };
  return { fetchImpl, requests };
}

test("the manifest URL the job defaults to is the path the sync workflow publishes on main", () => {
  const target = workflowTarget();
  expect(target).toBe("skills/edge-india/references");
  expect(existsSync(join(REPO_ROOT, target, MANIFEST_FILE))).toBe(true);
  // The workflow runs on a schedule (always the default branch, main) and pushes to the branch it runs on.
  const workflow = readFileSync(WORKFLOW, "utf8");
  expect(workflow).toMatch(/schedule:\s*\n\s*- cron:/);
  expect(workflow).toContain('git pull --rebase origin "${GITHUB_REF_NAME}"');
  const derived = `https://raw.githubusercontent.com/${REPO_SLUG}/main/${target}/${MANIFEST_FILE}`;
  expect(DEFAULT_SNAPSHOT_URL).toBe(derived);
  // refs.ts's opt-in live mirror is the same directory.
  expect(`${DEFAULT_BASE_URL}/${MANIFEST_FILE}`).toBe(derived);
});

test("the committed SNAPSHOT.json is complete and its sha256 per file matches the bytes, as the job reads it", () => {
  const recordText = readFileSync(join(REFERENCES, SNAPSHOT_RECORD_FILE), "utf8");
  const record = snapshotRecord(recordText); // the job's own parser
  const { paths } = manifestFiles(readFileSync(join(REFERENCES, MANIFEST_FILE), "utf8")); // index.md first, then every document
  const expected = new Set([MANIFEST_FILE, ...paths]);
  expect(new Set(record.keys())).toEqual(expected);
  for (const [path, digest] of record) expect(sha(readFileSync(join(REFERENCES, path)))).toBe(digest);
  // Nothing in the published directory is outside the record but the record itself.
  expect(tree(REFERENCES).sort()).toEqual([...expected, SNAPSHOT_RECORD_FILE].sort());
});

test("the job syncs the published tree from the default URL, verified file by file, and refs.ts reads that copy without fetching", async () => {
  const home = mkdtempSync(join(tmpdir(), "india-consistency-"));
  temps.push(home);
  const server = rawServer();
  const result = await runKnowledgeSync({ home, env: {}, fetchImpl: server.fetchImpl as never, now: () => new Date("2026-10-11T03:00:00Z") });
  expect(result).toMatchObject({ status: "ok", reason: "written" });
  expect(server.requests).toContain(DEFAULT_SNAPSHOT_URL);
  expect(server.requests).toContain(new URL(SNAPSHOT_RECORD_FILE, DEFAULT_SNAPSHOT_URL).href);
  const record = snapshotRecord(readFileSync(join(REFERENCES, SNAPSHOT_RECORD_FILE), "utf8"));
  for (const [path, digest] of record) expect(sha(readFileSync(join(currentSetDir(home), path)))).toBe(digest);

  const refused = () => Promise.reject(new Error("refs.ts must not fetch"));
  const ctx: Context = {
    installedDir: REFERENCES,
    knowledgeDir: currentSetDir(home),
    cacheDir: join(home, "cache", "edge-india"),
    env: {},
    now: () => new Date("2026-10-11T03:10:00Z"),
    fetch: refused as unknown as typeof fetch,
  };
  const status = await run(["status"], ctx);
  expect(status.code).toBe(0);
  expect(status.out).toContain("reading: background sync copy");
  expect(status.out).not.toContain("STALE");
  const read = await run(["read", "newsletter/housing-for-edge-city-india.md", "--section", "riva"], ctx);
  expect(read.code).toBe(0);
  expect(read.out).toContain("background sync copy");
  expect(existsSync(ctx.cacheDir)).toBe(false);
});

test("a served file that differs from SNAPSHOT.json is caught by the job (snapshot-mismatch), nothing written", async () => {
  const home = mkdtempSync(join(tmpdir(), "india-consistency-"));
  temps.push(home);
  const server = rawServer({ "newsletter/housing-for-edge-city-india.md": "# Housing\n\nA copy from another commit.\n" });
  const result = await runKnowledgeSync({ home, env: {}, fetchImpl: server.fetchImpl as never, now: () => new Date("2026-10-11T03:00:00Z") });
  expect(result).toMatchObject({ status: "incomplete", reason: "snapshot-mismatch", path: "newsletter/housing-for-edge-city-india.md" });
  expect(existsSync(currentSetDir(home))).toBe(false);
});
