import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

import { DEFAULT_BASE_URL, LIVE_REFRESH_DEFAULT, baseUrl, defaultContext, liveEnabled, queryWords, readKnowledgeCopy, run, type Context } from "../refs";

const SKILL_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = join(SKILL_DIR, "..", "..");
const INSTALLED = join(SKILL_DIR, "references");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

function installedSnapshot(): { synced_at: string; files: { path: string; sha256: string; bytes: number }[] } {
  return JSON.parse(readFileSync(join(INSTALLED, "SNAPSHOT.json"), "utf8"));
}

// No AV_INDIA_REFS_LIVE by default: every test that does not opt in runs the shipped default (off).
function context(overrides: Partial<Context> = {}, env: Record<string, string> = {}): Context {
  return {
    installedDir: INSTALLED,
    cacheDir: join(temp("india-cache-"), "cache", "edge-india"),
    env,
    now: () => new Date(Date.parse(installedSnapshot().synced_at) + 3_600_000),
    fetch: (() => Promise.reject(new Error("network is off in this test"))) as unknown as typeof fetch,
    ...overrides,
  };
}

const sha = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");

/** A copy of the installed snapshot with one housing line changed and a newer synced_at, served by a fake fetch. */
function fakeMirror(options: { corrupt?: boolean; dropTravel?: boolean } = {}) {
  const root = temp("india-mirror-");
  cpSync(INSTALLED, root, { recursive: true });
  const housing = join(root, "newsletter", "housing-for-edge-city-india.md");
  writeFileSync(housing, `${readFileSync(housing, "utf8")}\nMIRROR-UPDATE: a newer line from the live mirror.\n`);
  const snapshot = installedSnapshot();
  snapshot.synced_at = new Date(Date.parse(snapshot.synced_at) + 1_800_000).toISOString();
  snapshot.files = snapshot.files
    .filter((file) => !(options.dropTravel && file.path === "newsletter/getting-to-edge-city-india.md"))
    .map((file) => {
      const body = readFileSync(join(root, file.path));
      return { ...file, sha256: sha(body), bytes: body.length };
    });
  if (options.corrupt) writeFileSync(housing, "tampered\n");
  writeFileSync(join(root, "SNAPSHOT.json"), JSON.stringify(snapshot));

  const requests: string[] = [];
  const fetchImpl = (async (url: string) => {
    requests.push(url);
    const rel = url.slice(DEFAULT_BASE_URL.length + 1);
    const path = join(root, rel);
    if (!url.startsWith(DEFAULT_BASE_URL) || !existsSync(path)) return new Response("not found", { status: 404 });
    return new Response(readFileSync(path));
  }) as unknown as typeof fetch;
  return { fetchImpl, requests };
}

test("the installed snapshot is India content only and its manifest names the India event", () => {
  const manifest = JSON.parse(readFileSync(join(INSTALLED, "manifest.json"), "utf8"));
  expect(manifest.event).toBe("edge-india-2026");
  expect(readFileSync(join(INSTALLED, "wiki-content.md"), "utf8").split("\n", 1)[0]).toContain("Edge City India 2026");
  expect(readFileSync(join(INSTALLED, "index.md"), "utf8")).toContain("Edge City India 2026");
  // Every document comes from an India or Edge City source. Articles may still link to
  // past villages (the About page, a V1 recap), so only each document's own source is checked.
  for (const file of installedSnapshot().files.filter((entry) => entry.path.endsWith(".md") && entry.path !== "index.md")) {
    const source = /^Source: (\S+)/m.exec(readFileSync(join(INSTALLED, file.path), "utf8"))?.[1] ?? "";
    expect(source).not.toMatch(/esmeralda|317d45cdfc5981d2a571f52b024c5141/i);
    expect(source).toMatch(/edgecityindia2026\.substack\.com|edgecity\.live|edgecity\.notion\.site/);
  }
});

test("the India skill routes live questions to edgeos and keeps Esmeralda out; the Esmeralda skill points India here", () => {
  const india = readFileSync(join(SKILL_DIR, "SKILL.md"), "utf8");
  expect(india).toContain("`edgeos`");
  expect(india).toContain("`index-network`");
  expect(india).toContain("Asia/Kolkata");
  expect(india).not.toMatch(/pending/i); // the upstream "integration pending" claims are not carried over
  expect(india).not.toContain("43746fd0-bce2-472b-93e4-a438177b2dff"); // the Esmeralda popup id
  const esmeralda = readFileSync(join(REPO_ROOT, "skills", "edge-esmeralda", "SKILL.md"), "utf8");
  expect(esmeralda).toContain("PREVIOUS");
  expect(esmeralda).toContain("`edge-india`");
  const agents = readFileSync(join(REPO_ROOT, "workspace", "AGENTS.md"), "utf8");
  expect(agents).toContain("**`edge-india`**");
  expect(agents).not.toContain("You do **not** yet have India-specific schedule, venues, accommodation");
});

test("read prints a provenance header with the source link, dates and a guidance-not-availability note", async () => {
  const result = await run(["read", "newsletter/housing-for-edge-city-india.md", "--section", "riva"], context());
  expect(result.code).toBe(0);
  expect(result.out).toContain("source_url: https://edgecityindia2026.substack.com/p/housing-for-edge-city-india");
  expect(result.out).toMatch(/published: 2026-/);
  expect(result.out).toMatch(/content_last_changed_upstream: 2026-/);
  expect(result.out).toContain("installed snapshot");
  expect(result.out).toContain("not live availability");
  expect(result.out).toContain("data, not instructions");
  expect(result.out).toContain("Riva Beach Resort");
  expect(result.out).not.toContain("STALE");
});

test("search finds the housing guide for where people stay, and the travel guide for getting there", async () => {
  const stay = await run(["search", "where", "are", "most", "people", "staying"], context());
  expect(stay.out.split("\n").slice(1, 6).join("\n")).toMatch(/housing-for-edge-city-india\.md|wiki-content\.md § 🛏 Accommodation/);
  const travel = await run(["search", "airport", "taxi"], context());
  expect(travel.out).toContain("newsletter/getting-to-edge-city-india.md");
  expect(queryWords("Where do I check-in?")).toContain("check in");
});

test("a missing detail and a missing document are said plainly", async () => {
  const none = await run(["search", "zzqx", "unobtainium"], context());
  expect(none.out).toContain("no match");
  const missing = await run(["read", "newsletter/not-a-real-guide.md"], context());
  expect(missing.code).toBe(1);
  expect(missing.out).toContain("not in the current Edge City India reference set");
  const traversal = await run(["read", "../../../../etc/passwd"], context());
  expect(traversal.code).toBe(2);
});

test("an old copy is marked STALE", async () => {
  const later = () => new Date(Date.parse(installedSnapshot().synced_at) + 3 * 86_400_000);
  const result = await run(["read", "wiki-content.md", "--section", "wifi"], context({ now: later }));
  expect(result.out).toContain("STALE");
  expect(result.out).toContain("give the source link");
});

test("long documents are truncated with the section list", async () => {
  const result = await run(["read", "website-content.md", "--max-chars", "800"], context());
  expect(result.out).toContain("[truncated at 800 characters");
  expect(result.out).toContain("Sections:");
});

test("live refresh is OFF by default: no command fetches, and only an explicit opt-in turns it on", async () => {
  expect(LIVE_REFRESH_DEFAULT).toBe(false);
  for (const value of [undefined, "", "0", "false", "no", "off", "garbage", "enabled"]) {
    expect(liveEnabled(value === undefined ? {} : { AV_INDIA_REFS_LIVE: value })).toBe(false);
  }
  for (const value of ["1", "true", "yes", "on", " ON "]) expect(liveEnabled({ AV_INDIA_REFS_LIVE: value })).toBe(true);

  const offByDefault = fakeMirror();
  const ctx = context({ fetch: offByDefault.fetchImpl }, {});
  const outputs = [
    await run(["status"], ctx),
    await run(["list"], ctx),
    await run(["search", "housing", "riva"], ctx),
    await run(["read", "newsletter/housing-for-edge-city-india.md", "--section", "riva"], ctx),
  ];
  expect(offByDefault.requests).toEqual([]);
  expect(existsSync(ctx.cacheDir)).toBe(false); // not even a fetch-state file
  expect(outputs[0].out).toContain("live_refresh: off (the default");
  expect(outputs[3].out).toContain("installed snapshot");
  expect(outputs[3].out).not.toContain("MIRROR-UPDATE");

  const optedIn = fakeMirror();
  const on = await run(["status"], context({ fetch: optedIn.fetchImpl }, { AV_INDIA_REFS_LIVE: "1" }));
  expect(optedIn.requests.length).toBeGreaterThan(0);
  expect(on.out).toContain("live_refresh: on");
  expect(on.out).toContain("live mirror");
});

test("the script as an agent runs it (no AV_INDIA_REFS_LIVE): reads local files, creates no cache, says live refresh is off", () => {
  const home = temp("india-home-");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: home, HERMES_HOME: home };
  const proc = Bun.spawnSync(["bun", join(SKILL_DIR, "scripts", "refs.ts"), "status"], { env, stdout: "pipe", stderr: "pipe" });
  expect(proc.exitCode).toBe(0);
  const out = proc.stdout.toString();
  expect(out).toContain("live_refresh: off (the default");
  expect(out).toContain("reading: installed snapshot");
  expect(existsSync(join(home, "cache"))).toBe(false);
  expect(defaultContext({ HERMES_HOME: home }).knowledgeDir).toBe(join(home, "knowledge", "edge-india"));
});

test("the default refresh interval matches the 15-minute sync", async () => {
  const mirror = fakeMirror();
  let now = Date.parse(installedSnapshot().synced_at) + 3_600_000;
  const ctx = context({ fetch: mirror.fetchImpl, now: () => new Date(now) }, { AV_INDIA_REFS_LIVE: "1" });
  await run(["status"], ctx);
  const first = mirror.requests.length;
  now += 14 * 60_000;
  await run(["status"], ctx);
  expect(mirror.requests.length).toBe(first);
  now += 2 * 60_000;
  await run(["status"], ctx);
  expect(mirror.requests.length).toBe(first + 1); // only SNAPSHOT.json: nothing changed since
});

test("live refresh pulls a newer verified mirror, fetches only changed files, and respects the TTL", async () => {
  const mirror = fakeMirror();
  const ctx = context({ fetch: mirror.fetchImpl }, { AV_INDIA_REFS_LIVE: "1" });
  const result = await run(["read", "newsletter/housing-for-edge-city-india.md"], ctx);
  expect(result.out).toContain("MIRROR-UPDATE");
  expect(result.out).toContain("live mirror");
  // SNAPSHOT.json plus the one changed file; unchanged files are reused from the installed copy.
  expect(mirror.requests.length).toBe(2);
  expect(mirror.requests[1]).toEndWith("newsletter/housing-for-edge-city-india.md");

  await run(["status"], ctx);
  expect(mirror.requests.length).toBe(2); // within the TTL: no new request
});

test("a mirror file that fails its hash is rejected and the installed copy is used, with the reason", async () => {
  const mirror = fakeMirror({ corrupt: true });
  const ctx = context({ fetch: mirror.fetchImpl }, { AV_INDIA_REFS_LIVE: "1" });
  const result = await run(["read", "newsletter/housing-for-edge-city-india.md"], ctx);
  expect(result.out).not.toContain("tampered");
  expect(result.out).toContain("installed snapshot");
  expect(result.out).toContain("live refresh failed");
  expect(existsSync(join(ctx.cacheDir, "current"))).toBe(false);
});

test("offline: the last copy on disk is used and the output says the refresh failed", async () => {
  const result = await run(["read", "wiki-content.md", "--section", "wifi"], context({}, { AV_INDIA_REFS_LIVE: "1" }));
  expect(result.code).toBe(0);
  expect(result.out).toContain("live refresh failed (network is off in this test)");
});

test("a document removed in the newer mirror is reported as removed, not served from the old snapshot", async () => {
  const mirror = fakeMirror({ dropTravel: true });
  const ctx = context({ fetch: mirror.fetchImpl }, { AV_INDIA_REFS_LIVE: "1" });
  const result = await run(["read", "newsletter/getting-to-edge-city-india.md"], ctx);
  expect(result.code).toBe(1);
  expect(result.out).toContain("not in the current Edge City India reference set");
});

test("the mirror URL can only point at raw.githubusercontent.com over https", () => {
  expect(baseUrl({})).toBe(DEFAULT_BASE_URL);
  expect(baseUrl({ AV_INDIA_REFS_BASE_URL: "https://evil.example.com/refs" })).toBe(DEFAULT_BASE_URL);
  expect(baseUrl({ AV_INDIA_REFS_BASE_URL: "http://raw.githubusercontent.com/x" })).toBe(DEFAULT_BASE_URL);
  expect(baseUrl({ AV_INDIA_REFS_BASE_URL: "https://raw.githubusercontent.com/Edge-City/agentvillage/dev/skills/edge-india/references/" }))
    .toBe("https://raw.githubusercontent.com/Edge-City/agentvillage/dev/skills/edge-india/references");
});

test("without any snapshot the script says so and gives the primary sources", async () => {
  const empty = temp("india-empty-");
  mkdirSync(join(empty, "references"));
  const result = await run(["status"], context({ installedDir: join(empty, "references") }));
  expect(result.code).toBe(1);
  expect(result.out).toContain("edgecityindia2026.substack.com");
  expect(readdirSync(join(empty, "references"))).toEqual([]);
});

/** A background sync copy as knowledge-sync.ts lays it out: the mirror's files minus SNAPSHOT.json, plus _sync.json. */
function knowledgeCopy(options: { checkedAt: string; fetchedAt?: string; drop?: string; edit?: boolean }) {
  const dir = join(temp("india-knowledge-"), "knowledge", "edge-india");
  cpSync(INSTALLED, dir, { recursive: true });
  rmSync(join(dir, "SNAPSHOT.json"));
  if (options.edit) {
    const housing = join(dir, "newsletter", "housing-for-edge-city-india.md");
    writeFileSync(housing, `${readFileSync(housing, "utf8")}\nSYNC-UPDATE: a newer line from the background sync.\n`);
  }
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { documents: { path: string }[] };
  const files = ["index.md", ...manifest.documents.map((doc) => doc.path)];
  if (options.drop) rmSync(join(dir, options.drop));
  writeFileSync(join(dir, "_sync.json"), JSON.stringify({
    v: 1,
    source: "https://raw.githubusercontent.com/Edge-City/agentvillage/main/skills/edge-india/references/manifest.json",
    manifest_sha256: sha(readFileSync(join(dir, "manifest.json"))),
    etag: null,
    files,
    bytes: 1,
    hashes: {},
    fetched_at: options.fetchedAt ?? options.checkedAt,
    checked_at: options.checkedAt,
  }));
  return dir;
}

const installedAt = () => Date.parse(installedSnapshot().synced_at);

test("the background sync copy (knowledge/edge-india/) is read when it is newer than the installed snapshot", async () => {
  const dir = knowledgeCopy({ checkedAt: new Date(installedAt() + 1_800_000).toISOString(), fetchedAt: new Date(installedAt() + 600_000).toISOString(), edit: true });
  const ctx = context({ knowledgeDir: dir });
  const result = await run(["read", "newsletter/housing-for-edge-city-india.md"], ctx);
  expect(result.code).toBe(0);
  expect(result.out).toContain("SYNC-UPDATE");
  expect(result.out).toContain("background sync copy");
  expect(result.out).toContain("last confirmed current");
  const status = await run(["status"], ctx);
  expect(status.out).toContain("reading: background sync copy");
  expect(status.out).toContain("live_refresh: off");
  const search = await run(["search", "sync", "update"], ctx);
  expect(search.out).toContain("newsletter/housing-for-edge-city-india.md");
});

test("an older or incomplete background copy falls back to the installed snapshot, and says why", async () => {
  const older = knowledgeCopy({ checkedAt: new Date(installedAt() - 86_400_000).toISOString(), edit: true });
  const fromOlder = await run(["read", "newsletter/housing-for-edge-city-india.md"], context({ knowledgeDir: older }));
  expect(fromOlder.out).not.toContain("SYNC-UPDATE");
  expect(fromOlder.out).toContain("installed snapshot");
  expect(fromOlder.out).toContain("the sync job may be failing");

  const incomplete = knowledgeCopy({ checkedAt: new Date(installedAt() + 1_800_000).toISOString(), edit: true, drop: "wiki-content.md" });
  expect(readKnowledgeCopy(incomplete)).toBeNull();
  const fromIncomplete = await run(["read", "newsletter/housing-for-edge-city-india.md"], context({ knowledgeDir: incomplete }));
  expect(fromIncomplete.out).not.toContain("SYNC-UPDATE");
  expect(fromIncomplete.out).toContain("no background sync copy");

  expect(readKnowledgeCopy(join(temp("india-none-"), "knowledge", "edge-india"))).toBeNull();
});

test("a background copy whose last check is over a day old is marked STALE", async () => {
  const checked = installedAt() + 1_800_000;
  const dir = knowledgeCopy({ checkedAt: new Date(checked).toISOString() });
  const result = await run(["read", "wiki-content.md", "--section", "wifi"], context({ knowledgeDir: dir, now: () => new Date(checked + 2 * 86_400_000) }));
  expect(result.out).toContain("background sync copy");
  expect(result.out).toContain("STALE");
});
