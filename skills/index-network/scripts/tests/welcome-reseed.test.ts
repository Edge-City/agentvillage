/**
 * The welcome's seed lines and `--reseed` (SEED-REJECT 3b, Carter's ruling
 * (4), 12 Oct 2026), since the direct create (lead's ruling, 13 Oct 06:03Z):
 * each line is one `POST <origin>/api/intents` with `{description,
 * sourceType: "agentvillage"}` and no `preparationReceipt` (no `/prepare`
 * first: Index's admission rewrote or refused card lines). A create Index
 * answers non-2xx with its `intent_needs_revision` refusal is kept as
 * revisable in memory/welcome-seed.json (ov#302's `refused` record) and the
 * welcome still goes out. Behind AV_SEED_TRAILER_V2=1 (default off) the
 * `--draft` trailer adds `seed_codes` and `seed_recovery_kinds`: codes only,
 * never text (the data door's ruling, CLAIMS 18:28Z).
 *
 *   bun test skills/index-network/scripts/tests/welcome-reseed.test.ts
 *
 * Carter's ruling (18:23Z) is pinned here as "verbatim".
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGAIN_FLAG,
  DRY_RUN_FLAG,
  RESEED_ALREADY_RAN,
  RESEED_FLAG,
  RESEED_IN_PROGRESS,
  RESEED_NO_LINES,
  REFUSED_SEEDS,
  SEED_CODE,
  SEED_SOURCE_TYPE,
  SELECTED_HEADING,
  WELCOME_SEED_FILE,
  WELCOME_RESEED_LOCK,
  WELCOME_STATE_FILE,
  WOULD_CREATE,
  draftTrailer,
  main,
  reseedLines,
  reseedRun,
  seedCode,
  seedTrailerV2,
  surfaceRefusedSeeds,
  welcomeRun,
} from "../welcome";
import { CREATE_CALL, type CreateReply, FAKE_API_KEY, FAKE_MCP_URL, createdReply, indexMcpFake } from "./index-mcp-fake";

const PREPARE_URL = "https://index-mcp.fake.test/api/intents/prepare";
const VAGUE = "Make the goal more concrete: specify the role, outcome, or particular help you need.";
const NON_ACTIONABLE = "Describe who you want to reach and what you want to do together.";
const BROAD = "Please specify the desired role, location, timeframe, or concrete collaboration goal to narrow down potential matches in climate tools.";
/** Lines as the app writes them; odd spacing inside, punctuation, an emoji: sent exactly as selectedIntentions reads them. */
const LINES = ["Here to meet founders", "Wants to meet people working on climate tools  (Goa) 🌱", "Working on a climate data startup."];
const BASE_KEYS = ["welcome", "fallback", "intents_listed", "intents_seeded", "seed_failed"];

let home: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["INDEX_API_KEY", "INDEX_MCP_URL", "INDEX_API_URL", "HERMES_HOME", "AV_WELCOME_SEED_MODE", "AV_SEED_TRAILER_V2", "AV_CONNECTIONS_URL"];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-welcome-reseed-"));
  for (const key of VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function writeLines(lines: string[], categories = ["meet", "meet", "build"]): void {
  writeFileSync(
    join(home, "USER.md"),
    ["# Participant profile", "", "## Context supplied by the participant", "### Notes", "Some context.", "", SELECTED_HEADING, ...lines.map((l, i) => `- [${categories[i % categories.length]}] ${l}`), "", "## Follow-up preferences", ""].join("\n"),
  );
}

/** Index refusing the line: a non-2xx create whose body is the `intent_needs_revision` refusal (fixtures/index-create-direct.json notInSource). */
const refuse = (feedback: string): CreateReply => ({
  status: 422,
  body: { success: false, code: "intent_needs_revision", error: "The signal needs revision before it can be created.", feedback, proposedPayload: "ECHOED-LINE", recovery: [] },
});

/**
 * A fake Index: list_intents over its rows, and the REST create answered by
 * `plan` per description (undefined: created, active). `urls`: every URL the
 * client asked for, in order (a prepare would show here).
 */
function fakeIndex(plan: (description: string, n: number) => CreateReply | undefined = () => undefined, initial: Array<{ id: string; summary: string; status: string }> = []) {
  const rows: Array<{ id: string; summary: string; status: string }> = initial.map((r) => ({ ...r }));
  const fake = indexMcpFake({
    tools: {
      list_intents: () => `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, pagination: { limit: 20, offset: 0, count: rows.length } })}`,
    },
    create: (body, n) => {
      const description = String(body.description);
      const replaced = plan(description, n);
      if (replaced !== undefined) return replaced;
      const id = `bbbbbbbb-0000-4000-8000-${(0x100 + rows.length).toString(16).padStart(12, "0")}`;
      rows.push({ id, summary: description, status: "active" });
      return createdReply(id);
    },
  });
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    return fake.fetch(url, init);
  }) as typeof globalThis.fetch;
  return { fake, fetch, urls, rows };
}

async function run(index: ReturnType<typeof fakeIndex>, argv: string[] = [], timeoutMs = 200) {
  process.env.INDEX_API_KEY = FAKE_API_KEY;
  process.env.INDEX_MCP_URL = FAKE_MCP_URL;
  const out = await welcomeRun(["--home", home, ...argv], { fetch: index.fetch, timeoutMs });
  const creates = index.fake.calls.filter((c) => c.name === CREATE_CALL);
  return { ...out, creates };
}
const marker = () => JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8"));

describe("(verbatim) the seed line is never rewritten, trimmed or composed", () => {
  test("each create's description is exactly the line selectedIntentions reads, in order; nothing else is sent, and no prepare", async () => {
    writeLines(LINES);
    const index = fakeIndex();
    const { creates } = await run(index);
    expect(creates.map((c) => c.arguments)).toEqual(LINES.map((description) => ({ description, sourceType: SEED_SOURCE_TYPE })));
    expect(index.urls).not.toContain(PREPARE_URL);
  });
});

describe("a refused create never blocks the welcome", () => {
  test("every line refused: the welcome still goes out, every line kept as revisable (ov#302's fields only)", async () => {
    writeLines(LINES);
    const feedback = [NON_ACTIONABLE, VAGUE, BROAD];
    const out = await run(fakeIndex((_d, n) => refuse(feedback[n - 1]!)));
    expect(out.creates).toHaveLength(3);
    expect(out.text.length).toBeGreaterThan(0);
    expect(out.branch).toEqual({ fallback: "context", intents_listed: 0, intents_seeded: 0, seed_failed: 3 });
    const m = marker();
    expect(m).toMatchObject({ selected: 3, created: 0, failed: 3, done: true });
    expect(m.refused.map((r: { line: string }) => r.line)).toEqual(LINES);
    for (const r of m.refused) expect(Object.keys(r)).toEqual(["line", "feedback", "code", "at", "keys"]);
    expect(m.refused.map((r: { feedback: string }) => r.feedback).sort()).toEqual([...feedback].sort());
    expect(JSON.stringify(m)).not.toContain("ECHOED-LINE");
  });

  test("one line created, two refused: the welcome lists it; the first-turn block names the first refused line, question null", async () => {
    writeLines(LINES);
    const out = await run(fakeIndex((d) => (d === LINES[1] ? undefined : refuse(VAGUE))));
    expect(out.branch).toMatchObject({ intents_seeded: 1, seed_failed: 2 });
    expect(marker().refused).toHaveLength(2);
    const block = await surfaceRefusedSeeds(home);
    expect(JSON.parse(block!.slice(REFUSED_SEEDS.length + 1))).toEqual([{ line: LINES[0], kind: null, question: null }]);
    expect(block).not.toContain(VAGUE);
  });
});

describe("the trailer: exactly the five keys, plus at most seed_codes and seed_recovery_kinds behind AV_SEED_TRAILER_V2", () => {
  async function trailerOf(v2: boolean, plan: (d: string, n: number) => CreateReply | undefined) {
    if (v2) process.env.AV_SEED_TRAILER_V2 = "1";
    writeLines(LINES);
    process.env.INDEX_API_KEY = FAKE_API_KEY;
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    const index = fakeIndex(plan);
    const out: string[] = [];
    const err: string[] = [];
    await main(["--home", home, "--draft"], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, (argv) => welcomeRun(argv, { fetch: index.fetch, timeoutMs: 200 }));
    return { stdout: out.join(""), trailer: JSON.parse(err.join("").trim()) as Record<string, unknown>, raw: err.join("") };
  }

  test("off (the default): exactly the five keys, whatever the seed left", async () => {
    expect(seedTrailerV2(home)).toBe(false);
    const { trailer } = await trailerOf(false, () => refuse(VAGUE));
    expect(Object.keys(trailer)).toEqual(BASE_KEYS);
  });

  test("on: the five, then seed_codes (one per line that left one); codes match the door's pattern; no text at all", async () => {
    const feedback = [NON_ACTIONABLE, VAGUE, BROAD];
    const { trailer, raw, stdout } = await trailerOf(true, (_d, n) => (n === 3 ? { status: 500, body: { error: "Failed to create intent" } } : refuse(feedback[n - 1]!)));
    expect(Object.keys(trailer)).toEqual([...BASE_KEYS, "seed_codes"]);
    expect(trailer.seed_codes).toEqual(["intent_needs_revision", "intent_needs_revision", "create-http-500"]);
    for (const c of trailer.seed_codes as string[]) expect(SEED_CODE.test(c)).toBe(true);
    for (const text of [...LINES, ...feedback]) expect(raw).not.toContain(text);
    expect(stdout.length).toBeGreaterThan(0);
  });

  test("on, every line created: the five keys only (no empty array is ever sent)", async () => {
    const { trailer } = await trailerOf(true, () => undefined);
    expect(Object.keys(trailer)).toEqual(BASE_KEYS);
  });

  test("on via $HERMES_HOME/.env as well; any value but 1 is off", () => {
    writeFileSync(join(home, ".env"), "AV_SEED_TRAILER_V2=1\n");
    expect(seedTrailerV2(home)).toBe(true);
    writeFileSync(join(home, ".env"), "AV_SEED_TRAILER_V2=true\n");
    expect(seedTrailerV2(home)).toBe(false);
  });

  test("draftTrailer: without v2 the extra fields are never written; with v2 each only when non-empty, capped", () => {
    const branch = { fallback: "context" as const, intents_listed: 0, intents_seeded: 0, seed_failed: 3, seed_codes: ["a", "b", "c", "d"], seed_recovery_kinds: ["text" as const] };
    expect(Object.keys(JSON.parse(draftTrailer(branch)))).toEqual(BASE_KEYS);
    expect(JSON.parse(draftTrailer(branch, true))).toMatchObject({ seed_codes: ["a", "b", "c"], seed_recovery_kinds: ["text"] });
    expect(Object.keys(JSON.parse(draftTrailer({ ...branch, seed_codes: [], seed_recovery_kinds: [] }, true)))).toEqual(BASE_KEYS);
  });

  test("seedCode shapes any code to the door's pattern", () => {
    expect(seedCode("mcp-http-400:-32022")).toBe("mcp-http-400:-32022");
    expect(seedCode("a b/c")).toBe("a_b_c");
    expect(seedCode("x".repeat(80))).toBe("x".repeat(64));
    expect(seedCode("")).toBeNull();
  });

  test("a create that fails without the refusal leaves its own code (create-http-<status>, create-timeout), never a refusal", async () => {
    process.env.AV_SEED_TRAILER_V2 = "1";
    writeLines(LINES.slice(0, 2));
    const out = await run(fakeIndex((_d, n) => (n === 1 ? { status: 401, body: { error: "Invalid API key" } } : { hang: true })), ["--draft"], 100);
    expect(out.creates).toHaveLength(2);
    expect(out.branch).toMatchObject({ intents_seeded: 0, seed_failed: 2, seed_codes: ["create-http-401", "create-timeout"] });
    expect(marker().refused).toBeUndefined();
    expect(WELCOME_STATE_FILE).toBe(join("memory", "welcome-state.json"));
  });
});

describe("--reseed: the operator's one-shot second seed (Carter's ruling (4))", () => {
  async function reseed(index: ReturnType<typeof fakeIndex>, extra: string[] = []) {
    process.env.INDEX_API_KEY = FAKE_API_KEY;
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    const out: string[] = [];
    const err: string[] = [];
    await main(["--home", home, RESEED_FLAG, ...extra], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, (argv) => welcomeRun(argv, { fetch: index.fetch, timeoutMs: 200 }));
    const creates = index.fake.calls.filter((c) => c.name === CREATE_CALL);
    return { stdout: out.join(""), trailer: JSON.parse(err.join("").trim()) as Record<string, unknown>, creates };
  }
  const reseedMarkers = () => (existsSync(join(home, "memory")) ? readdirSync(join(home, "memory")).filter((f) => f.startsWith("welcome-reseed-")) : []);
  function welcomed(): string {
    mkdirSync(join(home, "memory"), { recursive: true });
    const state = `${JSON.stringify({ welcomeSent: true, sentAt: "2026-10-12T15:48:14.000Z" })}\n`;
    writeFileSync(join(home, WELCOME_STATE_FILE), state);
    return state;
  }

  test("after a sent welcome: prints nothing on stdout, seeds through the direct create (no prepare), writes its own marker, leaves welcome-state untouched", async () => {
    const state = welcomed();
    const seedMarker = `${JSON.stringify({ seededAt: "2026-10-12T15:47:18.759Z", selected: 3, created: 0, failed: 3, done: true })}\n`;
    writeFileSync(join(home, WELCOME_SEED_FILE), seedMarker);
    writeLines(LINES);
    const index = fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined));
    const { stdout, trailer, creates } = await reseed(index);
    expect(stdout).toBe("");
    expect(index.urls).not.toContain(PREPARE_URL);
    expect(creates.map((c) => c.arguments)).toEqual(LINES.map((description) => ({ description, sourceType: SEED_SOURCE_TYPE })));
    expect(trailer).toEqual({ welcome: 1, fallback: "none", intents_listed: 2, intents_seeded: 2, seed_failed: 1, seed_codes: ["intent_needs_revision"] });
    expect(readFileSync(join(home, WELCOME_STATE_FILE), "utf8")).toBe(state);
    // G1: the seed marker keeps its own fields; only the refused line is added (below).
    const { refused: _added, ...kept } = marker();
    expect(`${JSON.stringify(kept)}\n`).toBe(seedMarker);
    const files = reseedMarkers();
    expect(files).toHaveLength(1);
    const m = JSON.parse(readFileSync(join(home, "memory", files[0]!), "utf8"));
    expect(m).toMatchObject({ selected: 3, created: 2, failed: 1, codes: ["intent_needs_revision"], refusedMerged: true });
    expect(m.refused.map((r: { line: string }) => r.line)).toEqual([LINES[0]]);
  });

  describe("G1: a line Index refuses again reaches the resident (the seed marker's refused, which REFUSED_SEEDS reads)", () => {
    const entry = (line: string, extra: Record<string, unknown> = {}) => ({ line, feedback: null, code: "intent_needs_revision", at: "2026-10-12T15:47:18.759Z", keys: ["status"], ...extra });

    test("a done marker without refused (welcomed before ov#302): the refusal lands with surfacedAt unset, and the first turn's block names it", async () => {
      welcomed();
      writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: "2026-10-12T15:47:18.759Z", selected: 3, created: 0, failed: 3, done: true })}\n`);
      writeLines(LINES);
      const index = fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined));
      await reseed(index);
      const m = marker();
      expect(m).toMatchObject({ seededAt: "2026-10-12T15:47:18.759Z", selected: 3, created: 0, failed: 3, done: true });
      expect(m.refused).toHaveLength(1);
      expect(m.refused[0]).toMatchObject({ line: LINES[0], code: "intent_needs_revision", feedback: VAGUE });
      expect(Object.keys(m.refused[0])).toEqual(["line", "feedback", "code", "at", "keys"]);
      expect("surfacedAt" in m.refused[0]).toBe(false);
      // The reseed's own marker is still written, with the same refused line.
      const files = reseedMarkers();
      expect(files).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(home, "memory", files[0]!), "utf8")).refused.map((r: { line: string }) => r.line)).toEqual([LINES[0]]);
      // ov#302's first-turn reader, unchanged, now surfaces it once.
      const block = await surfaceRefusedSeeds(home);
      expect(block?.startsWith(`${REFUSED_SEEDS} `)).toBe(true);
      expect(JSON.parse(block!.slice(REFUSED_SEEDS.length + 1))[0].line).toBe(LINES[0]);
      expect(typeof marker().refused[0].surfacedAt).toBe("string");
      expect(await surfaceRefusedSeeds(home)).toBeNull();
    });

    test("a second refusal of the same line replaces the old entry in place (surfacedAt, notShown, questionWithheld cleared); other entries stay", async () => {
      welcomed();
      const other = entry("Another line the resident wrote", { surfacedAt: "2026-10-12T16:00:00.000Z", notShown: "cap" });
      const old = [entry(LINES[0]!, { surfacedAt: "2026-10-12T16:00:00.000Z", questionWithheld: "shape" }), other, entry(LINES[0]!, { surfacedAt: "2026-10-12T16:00:00.000Z" })];
      writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: "2026-10-12T15:47:18.759Z", selected: 2, created: 0, failed: 2, done: true, refused: old })}\n`);
      writeLines(LINES);
      const index = fakeIndex((p) => (p === LINES[0] ? refuse(NON_ACTIONABLE) : undefined));
      await reseed(index);
      const refused = marker().refused;
      expect(refused.map((r: { line: string }) => r.line)).toEqual([LINES[0], other.line]);
      expect(refused[0]).toMatchObject({ line: LINES[0], feedback: NON_ACTIONABLE });
      for (const key of ["surfacedAt", "notShown", "questionWithheld"]) expect(key in refused[0]).toBe(false);
      expect(refused[1]).toEqual(other);
      const block = await surfaceRefusedSeeds(home);
      expect(JSON.parse(block!.slice(REFUSED_SEEDS.length + 1)).map((r: { line: string }) => r.line)).toEqual([LINES[0]]);
    });

    test("no seed marker: a minimal one in recordSeed's shape (done, this run's counts) holding the refusal", async () => {
      welcomed();
      writeLines(LINES);
      const index = fakeIndex((p) => (p === LINES[2] ? refuse(BROAD) : undefined));
      await reseed(index);
      const m = marker();
      expect(Object.keys(m)).toEqual(["seededAt", "selected", "created", "failed", "done", "refused"]);
      expect(m).toMatchObject({ selected: 3, created: 2, failed: 1, done: true });
      expect(m.refused.map((r: { line: string }) => r.line)).toEqual([LINES[2]]);
      expect("surfacedAt" in m.refused[0]).toBe(false);
    });

    test("a marker another run claimed moments ago (no done) is left alone; nothing refused, the seed marker is not touched", async () => {
      welcomed();
      writeLines(LINES);
      const busy = `${JSON.stringify({ seededAt: new Date().toISOString(), selected: 3, created: 0, failed: 0 })}\n`;
      writeFileSync(join(home, WELCOME_SEED_FILE), busy);
      await reseed(fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined)));
      expect(readFileSync(join(home, WELCOME_SEED_FILE), "utf8")).toBe(busy);
      const files = reseedMarkers();
      expect(JSON.parse(readFileSync(join(home, "memory", files[0]!), "utf8")).refusedMerged).toBe(false);
      rmSync(join(home, WELCOME_SEED_FILE));
      for (const f of files) rmSync(join(home, "memory", f));
      await new Promise((r) => setTimeout(r, 5));
      const clean = await reseed(fakeIndex());
      expect(clean.trailer).toMatchObject({ seed_failed: 0 });
      expect(existsSync(join(home, WELCOME_SEED_FILE))).toBe(false);
    });

    test("an old claimed marker (no done: a welcome that died mid-seed) gains done with the refusal, and the unchanged reader surfaces it exactly once", async () => {
      welcomed();
      writeLines(LINES);
      const old = new Date(Date.now() - 3_600_000).toISOString();
      writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: old, selected: 3, created: 0, failed: 0, refused: [entry("Other", { surfacedAt: old })] })}\n`);
      await reseed(fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined)));
      expect(marker()).toMatchObject({ seededAt: old, done: true });
      expect(marker().refused.map((r: { line: string }) => r.line)).toEqual(["Other", LINES[0]]);
      const block = await surfaceRefusedSeeds(home);
      expect(JSON.parse(block!.slice(REFUSED_SEEDS.length + 1)).map((r: { line: string }) => r.line)).toEqual([LINES[0]]);
      expect(await surfaceRefusedSeeds(home)).toBeNull();
    });

    test("the merge waits on the seed marker's lock: a live holder keeps the marker untouched (refusedMerged false)", async () => {
      welcomed();
      writeLines(LINES);
      const body = `${JSON.stringify({ seededAt: "2026-10-12T15:47:18.759Z", selected: 3, created: 0, failed: 3, done: true })}\n`;
      writeFileSync(join(home, WELCOME_SEED_FILE), body);
      writeFileSync(join(home, `${WELCOME_SEED_FILE}.lock`), JSON.stringify({ token: "other", pid: 1, at: new Date().toISOString() }));
      await reseed(fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined)));
      expect(readFileSync(join(home, WELCOME_SEED_FILE), "utf8")).toBe(body);
      expect(JSON.parse(readFileSync(join(home, "memory", reseedMarkers()[0]!), "utf8")).refusedMerged).toBe(false);
    }, 10_000);
  });

  test("a line already in Index is skipped (not created, not counted)", async () => {
    welcomed();
    writeLines(LINES);
    const index = fakeIndex(undefined, [{ id: "bbbbbbbb-0000-4000-8000-000000000001", summary: LINES[1]!, status: "active" }]);
    const { trailer, creates, stdout } = await reseed(index);
    expect(stdout).toBe("");
    expect(creates.map((c) => c.arguments?.description)).toEqual([LINES[0], LINES[2]]);
    expect(trailer).toMatchObject({ intents_seeded: 2, seed_failed: 0 });
  });

  test("the profile's section empty (the app drops it once Telegram is paired): the welcome's refused lines, verbatim", async () => {
    welcomed();
    writeLines([]);
    writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: "x", selected: 2, created: 0, failed: 2, done: true, refused: [{ line: LINES[1], feedback: null, code: "intent_needs_revision", at: "x", keys: [] }, { line: LINES[2], feedback: null, code: "intent_needs_revision", at: "x", keys: [] }] })}\n`);
    expect(reseedLines(home)).toEqual([LINES[1], LINES[2]]);
    const index = fakeIndex();
    const { creates } = await reseed(index);
    expect(creates.map((c) => c.arguments?.description)).toEqual([LINES[1], LINES[2]]);
  });

  test("nothing to send: zero Index calls, no marker, trailer coded no_lines; list unavailable or no key: no marker; the run-once is not spent", async () => {
    welcomed();
    writeLines([]);
    const index = fakeIndex();
    const quiet = await reseed(index);
    expect(quiet.stdout).toBe("");
    expect(index.fake.calls).toHaveLength(0);
    expect(index.urls).toHaveLength(0);
    expect(quiet.trailer).toEqual({ welcome: 1, fallback: "unreachable", intents_listed: 0, intents_seeded: 0, seed_failed: 0, seed_codes: [RESEED_NO_LINES] });
    expect(reseedMarkers()).toHaveLength(0);
    writeLines(LINES);
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    const runs: Array<Record<string, unknown>> = [];
    const down = (async () => new Response("down", { status: 503 })) as unknown as typeof globalThis.fetch;
    for (const key of [FAKE_API_KEY, undefined]) {
      if (key === undefined) delete process.env.INDEX_API_KEY;
      else process.env.INDEX_API_KEY = key;
      const err: string[] = [];
      await main(["--home", home, RESEED_FLAG], { stdout: () => { throw new Error("stdout written"); }, stderr: (s) => err.push(s) }, (argv) => welcomeRun(argv, { fetch: down, timeoutMs: 200 }));
      runs.push(JSON.parse(err.join("")));
    }
    for (const t of runs) expect(t).toMatchObject({ fallback: "unreachable", intents_seeded: 0, seed_codes: ["list-unavailable"] });
    expect(reseedMarkers()).toHaveLength(0);
    // A zero-count marker an earlier build left does not count either: the real pass runs without --again.
    writeFileSync(join(home, "memory", "welcome-reseed-2026-10-12T22-00-00-000Z.json"), `${JSON.stringify({ reseededAt: "2026-10-12T22:00:00.000Z", selected: 0, created: 0, failed: 0, codes: [] })}\n`);
    const real = await reseed(fakeIndex());
    expect(real.creates.map((c) => c.arguments?.description)).toEqual(LINES);
    expect(reseedMarkers()).toHaveLength(2);
    expect((statSync(join(home, "memory", reseedMarkers().find((f) => !f.includes("22-00-00"))!)).mode & 0o777).toString(8)).toBe("600");
    // Every line already in Index: nothing sent, no marker.
    await new Promise((r) => setTimeout(r, 5));
    const listed = fakeIndex(undefined, LINES.map((l, i) => ({ id: `bbbbbbbb-0000-4000-8000-00000000000${i}`, summary: l, status: "active" })));
    expect((await reseed(listed, [AGAIN_FLAG])).creates).toHaveLength(0);
    expect(reseedMarkers()).toHaveLength(2);
  });

  test("the refused[] fallback is filtered as the first turn's reader filters it: never a line marked gone or removed, nothing when the tags are unreadable; --dry-run the same", async () => {
    welcomed();
    writeLines([]);
    const [gone, removed, held] = ["Wants to meet people working on climate tools", "Here to meet founders", "Working on a climate data startup"];
    const row = (line: string, extra: Record<string, unknown> = {}) => ({ line, feedback: null, code: "intent_needs_revision", at: "x", keys: [], ...extra });
    writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: "x", selected: 3, created: 0, failed: 3, done: true, refused: [row(gone, { surfacedAt: "y", notShown: "gone" }), row(removed), row(held)] })}\n`);
    mkdirSync(join(home, "memories"), { recursive: true });
    const tags = ["[Context tags, kept in the Agent Village app]", "Here to:", `- ${removed} (setup)`, "Working on:", `- ${held} (setup)`, `- ${gone} (setup)`, "Removed by you:", `- ${removed} (setup)`].join("\n");
    writeFileSync(join(home, "memories", "USER.md"), tags);
    expect(reseedLines(home)).toEqual([held]);
    const dry = fakeIndex();
    expect((await reseed(dry, [DRY_RUN_FLAG])).trailer).toMatchObject({ seed_codes: [WOULD_CREATE] });
    expect(dry.fake.calls.map((c) => c.name)).toEqual(["list_intents"]);
    const index = fakeIndex();
    const { creates } = await reseed(index);
    expect(creates.map((c) => c.arguments?.description)).toEqual([held]);
    // Tags unreadable (a directory where the file should be): fail closed, no Index call at all.
    rmSync(join(home, "memories", "USER.md"));
    mkdirSync(join(home, "memories", "USER.md"));
    expect(reseedLines(home)).toEqual([]);
    const blind = fakeIndex();
    const out = await reseed(blind, [AGAIN_FLAG]);
    expect(blind.fake.calls).toHaveLength(0);
    expect(out.trailer).toMatchObject({ seed_codes: [RESEED_NO_LINES] });
  });

  test("two real runs at once: one holds the lock and sends each line once, the other leaves reseed_in_progress with no Index call; a stale lock is taken over", async () => {
    welcomed();
    writeLines(LINES);
    process.env.INDEX_API_KEY = FAKE_API_KEY;
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    const index = fakeIndex();
    const runs = await Promise.all([0, 1].map((ms) => reseedRun(home, { fetch: index.fetch, timeoutMs: 200, now: new Date(Date.UTC(2026, 9, 13, 0, 0, 0, ms)) })));
    expect(index.fake.calls.filter((c) => c.name === CREATE_CALL)).toHaveLength(3);
    expect(runs.map((r) => r.intents_seeded).sort()).toEqual([0, 3]);
    expect(draftTrailer(runs.find((r) => r.intents_seeded === 0)!, true)).toBe(`{"welcome":1,"fallback":"unreachable","intents_listed":0,"intents_seeded":0,"seed_failed":0,"seed_codes":["${RESEED_IN_PROGRESS}"]}`);
    expect(reseedMarkers()).toHaveLength(1);
    expect(existsSync(join(home, WELCOME_RESEED_LOCK))).toBe(false);
    // A live lock (another process): refused at once, nothing listed. A stale one (a killed run): taken over.
    writeFileSync(join(home, WELCOME_RESEED_LOCK), JSON.stringify({ token: "other", pid: 1, at: new Date().toISOString() }));
    const held = fakeIndex();
    expect((await reseed(held, [AGAIN_FLAG])).trailer).toMatchObject({ seed_codes: [RESEED_IN_PROGRESS] });
    expect(held.fake.calls).toHaveLength(0);
    utimesSync(join(home, WELCOME_RESEED_LOCK), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    const stale = fakeIndex();
    expect((await reseed(stale, [AGAIN_FLAG])).creates).toHaveLength(3);
    expect(existsSync(join(home, WELCOME_RESEED_LOCK))).toBe(false);
  });

  describe("G2: --dry-run, and a run-once guard that --again overrides", () => {
    /** Every file under the home, with its content: a dry run must leave this exactly as it was. */
    function snapshot(): Record<string, string> {
      const out: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const f of readdirSync(join(home, dir), { withFileTypes: true })) {
          const rel = dir ? join(dir, f.name) : f.name;
          if (f.isDirectory()) walk(rel);
          else out[rel] = readFileSync(join(home, rel), "utf8");
        }
      };
      walk("");
      return out;
    }

    test("--dry-run: the list and nothing else (no prepare, no create), no file written; the trailer names each line a run would send (would_create) and intents_seeded 0", async () => {
      welcomed();
      writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: "2026-10-12T15:47:18.759Z", selected: 3, created: 0, failed: 3, done: true })}\n`);
      writeLines(LINES);
      const before = snapshot();
      const index = fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined));
      const { stdout, trailer, creates } = await reseed(index, [DRY_RUN_FLAG]);
      expect(stdout).toBe("");
      expect(creates).toHaveLength(0);
      expect(index.fake.calls.map((c) => c.name)).toEqual(["list_intents"]);
      expect(index.urls).toEqual([FAKE_MCP_URL]);
      expect(trailer).toEqual({
        welcome: 1,
        fallback: "questions",
        intents_listed: 0,
        intents_seeded: 0,
        seed_failed: 0,
        seed_codes: [WOULD_CREATE, WOULD_CREATE, WOULD_CREATE],
      });
      expect(snapshot()).toEqual(before);
      expect(reseedMarkers()).toHaveLength(0);
    });

    test("--dry-run is never refused by an earlier run's marker, and alone it is a dry reseed (no welcome claimed, nothing written)", async () => {
      writeLines(LINES);
      const index = fakeIndex();
      // Not welcomed, no marker: `--dry-run` without `--reseed` still creates and writes nothing.
      const before = snapshot();
      process.env.INDEX_API_KEY = FAKE_API_KEY;
      process.env.INDEX_MCP_URL = FAKE_MCP_URL;
      const err: string[] = [];
      await main(["--home", home, DRY_RUN_FLAG], { stdout: () => { throw new Error("stdout written"); }, stderr: (s) => err.push(s) }, (argv) => welcomeRun(argv, { fetch: index.fetch, timeoutMs: 200 }));
      expect(JSON.parse(err.join(""))).toMatchObject({ intents_seeded: 0, seed_codes: [WOULD_CREATE, WOULD_CREATE, WOULD_CREATE] });
      expect(index.fake.calls.map((c) => c.name)).toEqual(["list_intents"]);
      expect(snapshot()).toEqual(before);
      expect(existsSync(join(home, WELCOME_STATE_FILE))).toBe(false);
      welcomed();
      // One Index across the runs: it remembers what the real run created.
      const dry = fakeIndex((p) => (p === LINES[0] ? refuse(VAGUE) : undefined));
      const real = await reseed(dry);
      expect(real.creates).toHaveLength(3);
      expect(reseedMarkers()).toHaveLength(1);
      const after = snapshot();
      const { trailer, creates } = await reseed(dry, [DRY_RUN_FLAG]);
      // Only the line Index does not list yet (the refused one) would be sent; nothing new reached the create.
      expect(creates).toHaveLength(3);
      expect(trailer).toMatchObject({ intents_seeded: 0, seed_failed: 0, seed_codes: [WOULD_CREATE] });
      expect(snapshot()).toEqual(after);
    });

    test("a second real --reseed is refused whole: no Index call, nothing written, stdout empty, trailer coded reseed_already_ran; --again runs", async () => {
      welcomed();
      writeLines(LINES);
      // One Index across the runs: refuses LINES[0] the first time, lets it through after.
      const index = fakeIndex((p, n) => (p === LINES[0] && n <= 3 ? refuse(VAGUE) : undefined));
      const first = await reseed(index);
      expect(first.trailer).toMatchObject({ intents_seeded: 2, seed_failed: 1 });
      expect(reseedMarkers()).toHaveLength(1);
      const after = snapshot();
      const calls = index.fake.calls.length;
      await new Promise((r) => setTimeout(r, 5));
      const second = await reseed(index);
      expect(second.stdout).toBe("");
      expect(index.fake.calls).toHaveLength(calls);
      expect(second.trailer).toEqual({ welcome: 1, fallback: "unreachable", intents_listed: 0, intents_seeded: 0, seed_failed: 0, seed_codes: [RESEED_ALREADY_RAN] });
      expect(snapshot()).toEqual(after);
      // --again: runs, sends the line still refused (and only it), writes a second marker.
      const again = await reseed(index, [AGAIN_FLAG]);
      expect(again.stdout).toBe("");
      expect(again.creates.map((c) => c.arguments?.description)).toEqual([...LINES, LINES[0]]);
      expect(again.trailer).toMatchObject({ intents_seeded: 1, seed_failed: 0 });
      expect(reseedMarkers()).toHaveLength(2);
    });
  });
});
