/**
 * F-28 (overlay half): every intent the welcome seeds carries one fixed
 * `sourceId` (SEED_SOURCE_ID), and the `--draft` trailer names the ids this
 * run created (`seed_ids`), both behind AV_WELCOME_SEED_TAG, off by default.
 *
 *   bun test skills/index-network/scripts/tests/welcome-seed-tag.test.ts
 *   WELCOME_SCRIPT=/path/to/welcome.ts bun test skills/index-network/scripts/tests/welcome-seed-tag.test.ts
 *
 * Switch off (unset, or anything but `1`, in the environment or
 * `$HERMES_HOME/.env`): every scenario of welcome-seed-tag-scenarios.ts (the
 * first seed with each outcome a create can have, the paused seed, the
 * default mode, the extra trailer keys, the runs that create nothing, and
 * `--reseed`) leaves exactly the requests, files, stdout and stderr that
 * origin/main 581056b7 left (fixtures/welcome-seed-tag-off.json). With
 * WELCOME_SCRIPT set, that block runs against another welcome.ts (581056b7's
 * own reproduces the fixture).
 *
 * Switch on: each create of the seed and of `--reseed` gains exactly
 * `"sourceId":"<SEED_SOURCE_ID>"` at the end of its body and nothing else
 * changes in any request; the markers and stdout are main's bytes; the
 * trailer gains only `seed_ids` (before `reason`), equal to the ids the
 * run's own marker holds as the control plane reads them (lower-cased,
 * repeats dropped), absent when the run created none. No other create
 * carries the tag, and the trailer never holds text.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { createIntentDirect } from "../index-mcp";
import * as Local from "../welcome";
import { CREATE_CALL, FAKE_API_KEY, createdReply, indexMcpFake } from "./index-mcp-fake";
import { LINES, NOW, type Record_, SCENARIOS, SCENARIO_VARS, type WelcomeModule, idFor, runScenario } from "./welcome-seed-tag-scenarios";
import fixture from "./fixtures/welcome-seed-tag-off.json";

const SCRIPT = process.env.WELCOME_SCRIPT?.trim() || join(import.meta.dir, "..", "welcome.ts");
/** The welcome.ts under test for the switch-off block (this one unless WELCOME_SCRIPT names another). */
const Off = (await import(SCRIPT)) as WelcomeModule;
const W = Local;
const OFF = fixture.scenarios as Record<string, Record_>;
const TAG = W.SEED_SOURCE_ID;
const REPO = join(import.meta.dir, "..", "..", "..", "..");
/** The reseed marker every scenario's `--reseed` writes (welcome.ts WELCOME_RESEED_PREFIX at NOW). */
const RESEED_MARKER = `memory/welcome-reseed-${NOW.toISOString().replace(/[:.]/g, "-")}.json`;
const SEED_MARKER = "memory/welcome-seed.json";
/** The id form the seed marker keeps (index-mcp.ts INTENT_ID), written out here independently. */
const MARKER_ID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{4,32})$/;
/** The control plane reads only the last 4096 characters of stderr for the trailer (telegram-onboarding.js TRAILER_TAIL_CHARS). */
const CP_TRAILER_TAIL_CHARS = 4096;

/** What each scenario's switch-on trailer must name, written out by hand (cross-checks the marker rule below). */
const EXPECTED_IDS: Record<string, string[]> = {
  seedThree: [idFor(0x101), idFor(0x102), idFor(0x103)],
  seedOneDefaultMode: [],
  seedPaused: [idFor(0x101), idFor(0x102)],
  refusedLine: [idFor(0x101), idFor(0x103)],
  allRefused: [],
  noIdLanded: [idFor(0x102)],
  noIdNotLanded: [],
  failedCreate: [idFor(0x102)],
  malformedIds: ["eeeeeeee-0000-4000-8000-00000000000a"],
  duplicateIds: ["ffffffff-0000-4000-8000-000000000001", idFor(0x300)],
  caseDuplicateIds: ["abcdef0123456789"],
  shortHexId: ["abcd"],
  v2AndReason: [idFor(0x101)],
  listed: [],
  unreachableNoKey: [],
  markerExists: [],
  reseed: [idFor(0x101), idFor(0x102), idFor(0x103)],
  reseedRefused: [idFor(0x102)],
  reseedDryRun: [],
  reseedAlreadyRan: [],
};

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const key of SCENARIO_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  for (const key of SCENARIO_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const isCreate = (url: string) => new URL(url).pathname === "/api/intents";

/** The ids the run's own marker holds, as the control plane's marker reader takes them: lower-cased, repeats dropped, at most 3. */
function markerIds(name: string, files: Record<string, string>): string[] {
  const scenario = SCENARIOS[name]!;
  const path = scenario.argv.includes("--reseed") ? RESEED_MARKER : SEED_MARKER;
  // A marker that was there before the run is another run's: never this run's ids.
  if (!files[path] || scenario.files?.[path] !== undefined) return [];
  const ids = (JSON.parse(files[path]!) as { ids?: string[] }).ids ?? [];
  return [...new Set(ids.filter((id) => MARKER_ID.test(id)).map((id) => id.toLowerCase()))].slice(0, 3);
}

/** main's trailer line with `seed_ids` (when any) placed before `reason`, else last. */
function withSeedIds(line: string, ids: string[]): string {
  if (ids.length === 0) return line;
  const key = `"seed_ids":${JSON.stringify(ids)}`;
  const at = line.indexOf(',"reason":');
  return at >= 0 ? `${line.slice(0, at)},${key}${line.slice(at)}` : `${line.slice(0, -1)},${key}}`;
}

/** What a scenario must leave with the switch on, from main's record: the tag on each create, `seed_ids` in the trailer, nothing else. */
function tagged(name: string): Record_ {
  const off = OFF[name]!;
  const ids = markerIds(name, off.files);
  return {
    ...off,
    requests: off.requests.map((r) => (isCreate(r.url) ? { ...r, body: `${r.body.slice(0, -1)},"sourceId":"${TAG}"}` } : r)),
    stderr: off.stderr === "" ? "" : `${withSeedIds(off.stderr.slice(0, -1), ids)}\n`,
  };
}

// ── Switch off ───────────────────────────────────────────────────────────────

describe("switch off: every scenario leaves exactly main 581056b7's bytes (requests, markers, stdout, trailer)", () => {
  test("the fixture is main's, and every scenario has its record", () => {
    expect(fixture.base).toBe("581056b7cf35dc352fee5ec037f15aa04b4ed736");
    expect(Object.keys(OFF).sort()).toEqual(Object.keys(SCENARIOS).sort());
    expect(Object.keys(EXPECTED_IDS).sort()).toEqual(Object.keys(SCENARIOS).sort());
  });

  for (const name of Object.keys(SCENARIOS)) {
    test(`${name}: unset`, async () => {
      expect(await runScenario(Off, SCENARIOS[name]!)).toEqual(OFF[name]!);
    });
  }

  for (const value of ["0", "true", "yes", "on", " ", "", "11", "1.0", "01", "-1"]) {
    test(`AV_WELCOME_SEED_TAG=${JSON.stringify(value)}, in the environment and in .env: off, every scenario main's bytes`, async () => {
      for (const name of Object.keys(SCENARIOS)) {
        expect({ name, env: await runScenario(Off, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: value }) }).toEqual({ name, env: OFF[name]! });
        expect({ name, dotenv: await runScenario(Off, SCENARIOS[name]!, {}, `AV_WELCOME_SEED_TAG=${value}\n`) }).toEqual({ name, dotenv: OFF[name]! });
      }
    });
  }

  test("the environment wins over .env, as for the welcome's other switches: set to 0 there, `1` in .env is off", async () => {
    expect(await runScenario(Off, SCENARIOS.seedThree!, { AV_WELCOME_SEED_TAG: "0" }, "AV_WELCOME_SEED_TAG=1\n")).toEqual(OFF.seedThree!);
  });

  test("the fixture's creates carry no sourceId, and its trailers no seed_ids (main had neither)", () => {
    for (const record of Object.values(OFF)) {
      for (const r of record.requests) expect(r.body).not.toContain("sourceId");
      expect(record.stderr).not.toContain("seed_ids");
    }
  });
});

// ── Switch on ────────────────────────────────────────────────────────────────

describe("switch on (AV_WELCOME_SEED_TAG=1): the tag on each seed create, seed_ids in the trailer, nothing else changes", () => {
  for (const name of Object.keys(SCENARIOS)) {
    test(`${name}: environment and .env`, async () => {
      const want = tagged(name);
      expect(await runScenario(W, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: "1" })).toEqual(want);
      expect(await runScenario(W, SCENARIOS[name]!, {}, "AV_WELCOME_SEED_TAG=1\n")).toEqual(want);
      expect(await runScenario(W, SCENARIOS[name]!, {}, 'export AV_WELCOME_SEED_TAG="1"\n')).toEqual(want);
      expect(await runScenario(W, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: " 1 " })).toEqual(want);
    });
  }

  test("the trailer's seed_ids is the hand-written list for every scenario, and equals the run's own marker ids as the control plane reads them", async () => {
    for (const name of Object.keys(SCENARIOS)) {
      const rec = await runScenario(W, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: "1" });
      const trailer = rec.stderr ? (JSON.parse(rec.stderr) as Record<string, unknown>) : null;
      const got = (trailer?.seed_ids as string[] | undefined) ?? [];
      expect({ name, got }).toEqual({ name, got: EXPECTED_IDS[name]! });
      // A run with no trailer (the default mode) names nothing, whatever its marker holds.
      expect({ name, got }).toEqual({ name, got: rec.stderr ? markerIds(name, rec.files) : [] });
      // None created (or none named): the key is absent, not empty.
      if (got.length === 0 && trailer) expect({ name, has: "seed_ids" in trailer }).toEqual({ name, has: false });
    }
  });

  test("each seed create's body is main's with only `sourceId` added, last; nothing else in any request changes", async () => {
    let tagged = 0;
    for (const name of Object.keys(SCENARIOS)) {
      const rec = await runScenario(W, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: "1" });
      expect(rec.requests.length).toBe(OFF[name]!.requests.length);
      rec.requests.forEach((r, i) => {
        const off = OFF[name]!.requests[i]!;
        if (!isCreate(r.url)) return expect(r).toEqual(off);
        tagged++;
        const body = JSON.parse(r.body) as Record<string, unknown>;
        expect(Object.keys(body)).toEqual(["description", "sourceType", "sourceId"]);
        expect(body.sourceId).toBe(TAG);
        expect({ ...body, sourceId: undefined }).toEqual({ ...(JSON.parse(off.body) as object), sourceId: undefined });
        expect({ ...r, body: "" }).toEqual({ ...off, body: "" });
      });
    }
    expect(tagged).toBeGreaterThan(20);
  });

  test("the markers are main's bytes: the tag never reaches a file, and the #621 `ids` stay as they were", async () => {
    for (const name of Object.keys(SCENARIOS)) {
      const rec = await runScenario(W, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: "1" });
      expect({ name, files: rec.files }).toEqual({ name, files: OFF[name]!.files });
      for (const body of Object.values(rec.files)) expect(body).not.toContain(TAG);
    }
  });

  test("the trailer never holds text: no selected line, no word of one, no title, only the five keys' values and ids", async () => {
    // Each whole line, and each word of five letters or more (shorter ones, such as "seed", are in the key names).
    const words = [...LINES, ...LINES.flatMap((l) => l.split(" ")).filter((w) => w.length >= 5)];
    for (const name of Object.keys(SCENARIOS)) {
      const rec = await runScenario(W, SCENARIOS[name]!, { AV_WELCOME_SEED_TAG: "1", AV_SEED_TRAILER_V2: "1", AV_WELCOME_REASON: "1" });
      if (!rec.stderr) continue;
      for (const w of words) expect({ name, w, in: rec.stderr.includes(w) }).toEqual({ name, w, in: false });
      const t = JSON.parse(rec.stderr) as Record<string, unknown>;
      for (const id of (t.seed_ids as string[] | undefined) ?? []) expect(id).toMatch(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{4,32})$/);
      expect(rec.stderr.split("\n")).toEqual([rec.stderr.slice(0, -1), ""]);
    }
  });

  test("the paused seed: the pause calls are main's, the tag rides on the creates only", async () => {
    const rec = await runScenario(W, SCENARIOS.seedPaused!, { AV_WELCOME_SEED_TAG: "1" });
    const pauses = rec.requests.filter((r) => r.body.includes('"pause_intent"'));
    expect(pauses).toHaveLength(2);
    for (const p of pauses) expect(p.body).not.toContain(TAG);
  });
});

// ── Only the welcome's creates carry the tag ─────────────────────────────────

describe("no create but the welcome's seed carries the tag", () => {
  test("createIntentDirect without a sourceId sends main's body exactly, whatever AV_WELCOME_SEED_TAG says (index-mcp never reads it)", async () => {
    for (const value of [undefined, "1"]) {
      if (value === undefined) delete process.env.AV_WELCOME_SEED_TAG;
      else process.env.AV_WELCOME_SEED_TAG = value;
      const fake = indexMcpFake({ create: () => createdReply(idFor(1)) });
      const bodies: string[] = [];
      const fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
        bodies.push(String(init?.body));
        return fake.fetch(url, init);
      }) as typeof globalThis.fetch;
      const out = await createIntentDirect({ apiKey: FAKE_API_KEY, mcpUrl: fake.url, fetch, timeoutMs: 200 }, "An agent's own line");
      expect(out).toEqual({ ok: true, id: idFor(1) });
      expect(bodies).toEqual(['{"description":"An agent\'s own line","sourceType":"agentvillage"}']);
      expect(fake.calls.map((c) => c.name)).toEqual([CREATE_CALL]);
    }
  });

  test("the tag's value is written once in the overlay: in welcome.ts, nowhere else (no plugin, no record path, no other script)", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".git" || name === "tests" || name === "fixtures") continue;
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) walk(path);
        else if (st.size < 4_000_000 && /\.(ts|tsx|js|cjs|mjs|py|json|md|sh|ya?ml|toml|txt)$/.test(name)) {
          const text = readFileSync(path, "utf8");
          const n = text.split(TAG).length - 1;
          if (n) hits.push(`${relative(REPO, path)}:${n}`);
        }
      }
    };
    walk(REPO);
    expect(hits).toEqual(["skills/index-network/scripts/welcome.ts:1"]);
  });

  test("welcome.ts passes the tag to the one create call, through seedOne only; the create is still made in one place", () => {
    const source = readFileSync(join(import.meta.dir, "..", "welcome.ts"), "utf8");
    expect(source.match(/await createIntentDirect\(/g)).toHaveLength(1);
    expect(source).toContain("await createIntentDirect(createTarget, description, sourceId)");
    expect(source.match(/SEED_SOURCE_ID\b/g)!.length).toBeGreaterThanOrEqual(2);
    expect(source.match(/tagged \? SEED_SOURCE_ID : undefined/g)).toHaveLength(1);
  });

  test("SEED_SOURCE_ID is one lower-case version-4 uuid: never a version-7 uuid like the av-events plugin's own sourceId", () => {
    expect(TAG).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(TAG).toBe("ec9911a3-b128-4220-86be-c9ef8ccf0cdc");
  });
});

// ── The pure parts ───────────────────────────────────────────────────────────

describe("seedTagOn, trailerSeedIds, draftTrailer", () => {
  let home: string;
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "av-welcome-seed-tag-unit-"));
  });
  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("seedTagOn: `1` only (trimmed, environment else .env), as AV_WELCOME_REASON", () => {
    expect(W.seedTagOn(home)).toBe(false);
    for (const [v, on] of [["1", true], [" 1", true], ["0", false], ["true", false], ["11", false], ["", false], ["yes", false]] as const) {
      process.env.AV_WELCOME_SEED_TAG = v;
      expect({ v, on: W.seedTagOn(home) }).toEqual({ v, on });
      expect({ v, on: W.welcomeReasonOn(home) }).toEqual({ v, on: false });
    }
    delete process.env.AV_WELCOME_SEED_TAG;
    writeFileSync(join(home, ".env"), "AV_WELCOME_SEED_TAG=1\n");
    expect(W.seedTagOn(home)).toBe(true);
    rmSync(join(home, ".env"));
  });

  test("trailerSeedIds: lower-cased, the marker's id form only, repeats (any case) dropped, in order, at most 3", () => {
    const u = (n: number) => idFor(n);
    expect(W.trailerSeedIds(undefined)).toEqual([]);
    expect(W.trailerSeedIds([])).toEqual([]);
    expect(W.trailerSeedIds([u(1), u(2), u(3), u(4)])).toEqual([u(1), u(2), u(3)]);
    expect(W.trailerSeedIds(["ABCD1234", "abcd1234", u(1)])).toEqual(["abcd1234", u(1)]);
    expect(W.trailerSeedIds(["not an id", "", "abc", "a".repeat(33), "g".repeat(8), 42, null, `${u(1)} `, `${u(1)}\n`, "ab-cd", u(2)])).toEqual([u(2)]);
    expect(W.trailerSeedIds([u(1).toUpperCase()])).toEqual([u(1)]);
    expect(W.trailerSeedIds([u(1), "bad!", u(1), u(2), "x", u(3), u(4)])).toEqual([u(1), u(2), u(3)]);
    expect(W.trailerSeedIds(["abcd", "a".repeat(32)])).toEqual(["abcd", "a".repeat(32)]);
    expect(W.SEED_IDS_TRAILER_MAX).toBe(3);
  });

  const BRANCH = { fallback: "none" as const, intents_listed: 2, intents_seeded: 2, seed_failed: 0, seed_ids: [idFor(1), idFor(2)] };
  test("draftTrailer: seed_ids only with the switch, only when there is one, after the v2 keys, before reason", () => {
    expect(W.draftTrailer(BRANCH)).toBe('{"welcome":1,"fallback":"none","intents_listed":2,"intents_seeded":2,"seed_failed":0}');
    expect(W.draftTrailer(BRANCH, true, true)).toBe('{"welcome":1,"fallback":"none","intents_listed":2,"intents_seeded":2,"seed_failed":0}');
    expect(W.draftTrailer(BRANCH, false, false, true)).toBe(
      `{"welcome":1,"fallback":"none","intents_listed":2,"intents_seeded":2,"seed_failed":0,"seed_ids":["${idFor(1)}","${idFor(2)}"]}`,
    );
    expect(W.draftTrailer({ ...BRANCH, seed_ids: [] }, false, false, true)).toBe('{"welcome":1,"fallback":"none","intents_listed":2,"intents_seeded":2,"seed_failed":0}');
    expect(W.draftTrailer({ ...BRANCH, seed_ids: ["bad id"] }, false, false, true)).toBe('{"welcome":1,"fallback":"none","intents_listed":2,"intents_seeded":2,"seed_failed":0}');
    const full = { fallback: "unreachable" as const, intents_listed: 0, intents_seeded: 1, seed_failed: 1, seed_codes: ["c"], seed_recovery_kinds: ["text" as const], seed_ids: [idFor(1)], reason: "list_failed" as const };
    expect(Object.keys(JSON.parse(W.draftTrailer(full, true, true, true)))).toEqual([
      "welcome",
      "fallback",
      "intents_listed",
      "intents_seeded",
      "seed_failed",
      "seed_codes",
      "seed_recovery_kinds",
      "seed_ids",
      "reason",
    ]);
  });

  test("welcomeBranch carries seed_ids only when non-empty", () => {
    const read = { kind: "listed" as const, titles: ["a"] };
    expect(W.welcomeBranch(read, { intents_seeded: 1, seed_failed: 0, seed_ids: [] })).toEqual({ fallback: "none", intents_listed: 1, intents_seeded: 1, seed_failed: 0 });
    expect(W.welcomeBranch(read, { intents_seeded: 1, seed_failed: 0, seed_ids: [idFor(1)] })).toEqual({ fallback: "none", intents_listed: 1, intents_seeded: 1, seed_failed: 0, seed_ids: [idFor(1)] });
  });

  test("the longest trailer the script can print is one line, far inside the control plane's 4096-character tail", () => {
    const longest = W.draftTrailer(
      {
        fallback: "unreachable",
        intents_listed: 0,
        intents_seeded: 3,
        seed_failed: 3,
        seed_codes: Array(9).fill("x".repeat(64)),
        seed_recovery_kinds: Array(9).fill("multi"),
        seed_ids: Array.from({ length: 9 }, (_, i) => idFor(i).toUpperCase()),
        reason: "list_failed",
      },
      true,
      true,
      true,
    );
    expect(longest).not.toContain("\n");
    expect(JSON.parse(longest).seed_ids).toHaveLength(3);
    expect(longest.length).toBeLessThan(600);
    expect(longest.length).toBeLessThan(CP_TRAILER_TAIL_CHARS);
  });
});

// ── The real script, as a process ────────────────────────────────────────────

describe("as a process: the switch is read from the environment and from $HERMES_HOME/.env", () => {
  let server: ReturnType<typeof Bun.serve>;
  let fake: ReturnType<typeof indexMcpFake>;
  let rows: Array<{ id: string; summary: string; status: string }> = [];
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: async (req) => {
        const path = new URL(req.url).pathname;
        const target = path === "/mcp" ? fake.url : path === "/api/intents" ? new URL("/api/intents", fake.url).href : null;
        if (target === null) return new Response("not found", { status: 404 });
        return fake.fetch(target, { method: req.method, headers: req.headers, body: await req.text() });
      },
    });
  });
  afterAll(() => {
    server.stop(true);
  });

  async function spawnSeed(env: Record<string, string>, dotenv?: string) {
    rows = [];
    fake = indexMcpFake({
      tools: {
        list_intents: () => `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, pagination: { limit: 20, offset: 0, count: rows.length } }, null, 2)}`,
      },
      create: (body, n) => {
        rows.push({ id: idFor(0x100 + n), summary: String(body.description), status: "active" });
        return createdReply(idFor(0x100 + n));
      },
    });
    const home = mkdtempSync(join(tmpdir(), "av-welcome-seed-tag-proc-"));
    try {
      writeFileSync(join(home, "USER.md"), ["# Participant profile", "", "## Selected intentions", ...LINES.map((l) => `- [meet] ${l}`), ""].join("\n"));
      if (dotenv !== undefined) writeFileSync(join(home, ".env"), dotenv);
      const base: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(INDEX_|AV_|HERMES_)|SEED/.test(k)) base[k] = v;
      const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "welcome.ts"), "--draft", "--home", home], {
        env: { ...base, HERMES_HOME: home, INDEX_API_KEY: FAKE_API_KEY, INDEX_MCP_URL: `http://127.0.0.1:${server.port}/mcp`, AV_CONNECTIONS_URL: "", ...env },
        cwd: home,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      const marker = JSON.parse(readFileSync(join(home, SEED_MARKER), "utf8")) as { ids: string[] };
      const bodies = fake.calls.filter((c) => c.name === CREATE_CALL).map((c) => c.arguments);
      return { stdout, stderr, code, marker, bodies };
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  test("unset: stdout and trailer are main's (seedThree), the creates untagged", async () => {
    const run = await spawnSeed({});
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(OFF.seedThree!.stdout);
    expect(run.stderr).toBe(OFF.seedThree!.stderr);
    expect(run.bodies).toEqual(LINES.slice(0, 3).map((description) => ({ description, sourceType: "agentvillage" })));
  }, 30_000);

  for (const [label, env, dotenv] of [
    ["environment", { AV_WELCOME_SEED_TAG: "1" }, undefined],
    [".env", {}, "AV_WELCOME_SEED_TAG=1\n"],
  ] as const) {
    test(`on in the ${label}: each create tagged, the trailer's seed_ids are the marker's ids, stdout main's`, async () => {
      const run = await spawnSeed({ ...env }, dotenv);
      expect(run.code).toBe(0);
      expect(run.stdout).toBe(OFF.seedThree!.stdout);
      expect(run.bodies).toEqual(LINES.slice(0, 3).map((description) => ({ description, sourceType: "agentvillage", sourceId: TAG })));
      expect(run.stderr).toBe(`${withSeedIds(OFF.seedThree!.stderr.slice(0, -1), run.marker.ids)}\n`);
      expect(run.marker.ids).toEqual([idFor(0x101), idFor(0x102), idFor(0x103)]);
    }, 30_000);
  }
});
