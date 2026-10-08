/**
 * DATA-412 W4: an end-to-end replay of the welcome, every branch, through the
 * real script as a subprocess.
 *
 *   bun test skills/index-network/scripts/tests/welcome-replay.test.ts
 *   WELCOME_SCRIPT=/path/to/welcome.ts bun test skills/index-network/scripts/tests/welcome-replay.test.ts
 *
 * Each case runs `bun welcome.ts --draft --home <tmp>` (and the default mode)
 * with HERMES_HOME=<tmp>, INDEX_API_KEY and INDEX_MCP_URL pointing at a local
 * Bun.serve on 127.0.0.1 that fronts indexMcpFake. The stub is stateful:
 * `list_intents` answers the current rows and `create_intent` adds one active
 * row titled with its `description`, so a seeded welcome re-lists what it
 * created. Every call the stub receives is recorded (tool name, arguments).
 *
 * welcome.test.ts already pins the texts, the trailer and the marker in
 * process; this file checks what only a replay shows: the exact Index calls a
 * real run makes on each branch (nothing but `list_intents` unless it seeds,
 * and then exactly the resident's selected texts), stdout bytes against
 * fixtures/welcome-texts.json, one stderr line with --draft and none without,
 * exit 0, a --draft run leaving the home untouched, and the default mode
 * claiming the marker once.
 *
 * The seeded cases (W1: welcome.ts reads `## Selected intentions` from
 * $HERMES_HOME/USER.md and creates up to three intents when none is active)
 * run only when the script under test carries the seed (its source mentions
 * `intents_seeded`); until then they are skipped, by name. WELCOME_SCRIPT
 * points the replay at another checkout's welcome.ts; the texts are then read
 * from that checkout's fixtures/welcome-texts.json.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { FAKE_API_KEY, type FakeCall, type ToolHandler, indexMcpFake } from "./index-mcp-fake";

const SCRIPT = process.env.WELCOME_SCRIPT?.trim() || join(import.meta.dir, "..", "welcome.ts");
const SOURCE = readFileSync(SCRIPT, "utf8");
/** The texts pinned next to the script under test. */
const golden = JSON.parse(readFileSync(join(dirname(SCRIPT), "tests", "fixtures", "welcome-texts.json"), "utf8")) as Record<string, string>;
/** W1 (DATA-412) has landed in the script under test. */
const SEED_SUPPORTED = SOURCE.includes("intents_seeded");
const SEED_SKIP = SEED_SUPPORTED ? "" : " [skipped until W1 (DATA-412 seed) lands in welcome.ts]";

/** The marker and the already-sent word: the contract shared with the control plane and install/welcome_state.ts. */
const MARKER = join("memory", "welcome-state.json");
const ALREADY_SENT = "WELCOME_ALREADY_SENT";
/** The seeded branch's lead and close (DATA-412 brief, "The change" 3). */
const SEEDED_LEAD = "From what you told me at signup, I've set up these signals:";
const SEEDED_CLOSE = "Say change or pause to adjust any of them, or tell me a new one.";
/** The overlay's cap on the whole welcome (welcome.ts WELCOME_MAX_CHARS). */
const WELCOME_MAX_CHARS = 1150;
/** create_intent argument keys the brief allows: the text, and an onboarding source marker if the tool takes one. */
const CREATE_KEYS = new Set(["description", "source"]);
/** Each case spawns several processes. */
const CASE_TIMEOUT_MS = 60_000;

const MEMORY = "Looking for people building agent memory";
const DINNER = "Open to co-hosting a village dinner";
const SURF = "Want a surfing buddy for early mornings";
const KONKANI = "Learning Konkani";
const CHESS = "Find a chess partner for the evenings";
/** Two more of the selected texts W1 pins its seeded texts with (welcome-texts.json seededThree). */
const RUST = "Hiring a founding engineer who loves Rust";
const RAISE = "Want advice on raising a seed round in India";

// ---------------------------------------------------------------------------
// The resident's home: av-profile.json (the agent's nickname) and USER.md in the app's exact format.

type Intention = { category: "build" | "learn" | "meet" | "explore"; text: string; kept: boolean };

/**
 * agentvillage-app src/lib/agent/profile-text.ts `profileText`, line for line:
 * the one flattened profile the control plane writes to $HERMES_HOME/USER.md.
 * The context source, the follow-up answers and the offers all carry lines
 * that start with "- ", and one is even shaped like a selected intention, so
 * a parser that reads past `## Selected intentions` sends them to Index.
 */
function profileText(intentions: Intention[]): string {
  const sources = [{ label: "Imported from LinkedIn", text: "Builds memory systems for agents.\n- [learn] Decoy line from an imported source, never selected" }];
  const answers: Record<string, string[]> = {
    "What are you most excited about this month?": ["surfing", "the dinners"],
    "What would make this month a real success for you?": ["one collaborator"],
  };
  const offers = [{ title: "Pairing on Rust", detail: "two afternoons" }];
  return [
    "# Participant profile",
    "Name: Asha Rao",
    "Work: agent infrastructure",
    "Based in: Bengaluru",
    "Staying: Oct 11 - Nov 1",
    "Links: https://example.com/asha",
    intentions.some((i) => i.kept)
      ? "Only the selected intentions below are current goals. Imported sources are background and may contain discarded suggestions; do not pursue those unless the participant selects them again."
      : "The participant has not selected intentions yet. Treat the context below as background, and ask before pursuing any goal on their behalf.",
    "\n## Context supplied by the participant",
    ...sources.map((s) => `### ${s.label}\n${s.text}`),
    "\n## Selected intentions",
    ...intentions.filter((i) => i.kept).map((i) => `- [${i.category}] ${i.text}`),
    "\n## Follow-up preferences",
    ...Object.entries(answers).map(([q, a]) => `- ${q}: ${a.join("; ")}`),
    "\n## Offers",
    ...offers.map((o) => `- ${o.title}: ${o.detail}`),
    "The participant wants to choose offer recipients themselves. Do not allocate offers automatically.",
  ].join("\n");
}

const CATEGORIES: Intention["category"][] = ["meet", "build", "explore", "learn"];
/** `texts` as kept intentions, with one discarded suggestion between the first and the second (never selected, never sent). */
function selected(texts: string[]): Intention[] {
  const kept = texts.map((text, i) => ({ category: CATEGORIES[i % CATEGORIES.length], text, kept: true }));
  return [...kept.slice(0, 1), { category: "explore", text: "Discarded suggestion the resident did not keep", kept: false }, ...kept.slice(1)];
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-welcome-replay-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeProfile(nickname: string | null): void {
  writeFileSync(join(home, "av-profile.json"), JSON.stringify({ version: 1, nickname, about_me: "SECRET-ABOUT-ME", interests: [], preferences: {} }));
}
function writeUserMd(texts: string[] | null): void {
  if (texts !== null) writeFileSync(join(home, "USER.md"), `${profileText(selected(texts))}\n`);
}

// ---------------------------------------------------------------------------
// The Index stub: indexMcpFake behind Bun.serve on 127.0.0.1, stateful, recording every call.

type Row = { id: string; summary: string; status: string; url: string };
type CreateFailure = "isError" | "http500";

const row = (summary: string, n: number, status = "active"): Row => {
  const id = `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
  return { id, summary, status, url: `https://index.network/i/${id}` };
};
/** A `list_intents` text in the live shape (markdown lead, blank line, JSON). */
function intentsText(rows: Row[]): string {
  return `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, totalWaitingOpportunities: 0, pagination: { limit: 20, offset: 0, count: rows.length } }, null, 2)}`;
}

const stub = {
  rows: [] as Row[],
  /** Every request answers HTTP 500. */
  down: false,
  /** create_intent call numbers (1-based) that fail, and how. */
  failCreates: new Map<number, CreateFailure>(),
  creates: 0,
  fake: null as unknown as ReturnType<typeof indexMcpFake>,
};

function resetStub(rows: string[] = []): void {
  stub.rows = rows.map((summary, i) => row(summary, i + 1));
  stub.down = false;
  stub.failCreates = new Map();
  stub.creates = 0;
  const http500 = (): ReturnType<ToolHandler> => ({ response: new Response("internal error", { status: 500 }) });
  stub.fake = indexMcpFake({
    url: "http://127.0.0.1/mcp",
    apiKey: FAKE_API_KEY,
    tools: {
      list_intents: () => (stub.down ? http500() : intentsText(stub.rows)),
      create_intent: (args) => {
        if (stub.down) return http500();
        const n = ++stub.creates;
        const failure = stub.failCreates.get(n);
        if (failure === "http500") return http500();
        if (failure === "isError") {
          return { result: { content: [{ type: "text", text: "Could not create the intent." }], isError: true, resultType: "complete" } };
        }
        const created = row(String(args.description ?? ""), 100 + n);
        stub.rows.push(created);
        return `Created your signal.\n\n${JSON.stringify({ success: true, intent: created }, null, 2)}`;
      },
    },
  });
}

let server: ReturnType<typeof Bun.serve>;
let MCP_URL: string;
/** A port nothing listens on: a server's, stopped. */
let CLOSED_URL: string;

beforeAll(() => {
  resetStub();
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => stub.fake.fetch(stub.fake.url, { method: req.method, headers: req.headers, body: await req.text() }),
  });
  MCP_URL = `http://127.0.0.1:${server.port}/mcp`;
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  CLOSED_URL = `http://127.0.0.1:${closed.port}/mcp`;
  closed.stop(true);
});
afterAll(() => {
  server.stop(true);
});

/** The tool calls the stub received since `from`. */
const toolCalls = (from = 0): FakeCall[] => stub.fake.calls.slice(from);
const names = (calls: FakeCall[]) => calls.map((c) => c.name);
const creates = (calls: FakeCall[]) => calls.filter((c) => c.name === "create_intent");

// ---------------------------------------------------------------------------
// The script, as a process.

type Run = { stdout: string; stderr: string; code: number };
type Spawn = { key?: string; url?: string };

/** Env vars that would change the run; dropped from the child's environment (the seed's mode flag among them). */
const DROPPED = /^(INDEX_|AV_|HERMES_)|SEED/;

async function spawn(argv: string[], options: Spawn = {}): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROPPED.test(k)) env[k] = v;
  Object.assign(env, { HERMES_HOME: home, INDEX_API_KEY: options.key ?? FAKE_API_KEY, INDEX_MCP_URL: options.url ?? MCP_URL, AV_CONNECTIONS_URL: "" });
  const proc = Bun.spawn(["bun", SCRIPT, ...argv], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, code };
}

/** Every path under the home with its kind, size and mtime. */
function snapshot(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      out.push(`${relative(home, path)} ${st.isDirectory() ? "dir" : "file"} ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(home);
  return out;
}

/**
 * What each --draft run of the current test changed under the home: the
 * snapshot lines it added and removed. Checked at the end of each test
 * (expectDraftsWroteNothing), after the calls and the text, so a write never
 * hides how the rest of the run went.
 */
let draftWrites: Array<{ added: string[]; removed: string[] }> = [];
beforeEach(() => {
  draftWrites = [];
});

/** `bun welcome.ts --draft --home <home>`: never the welcome marker; every other change recorded for expectDraftsWroteNothing. */
async function draft(options: Spawn = {}): Promise<Run> {
  const before = snapshot();
  const run = await spawn(["--draft", "--home", home], options);
  expect(existsSync(join(home, MARKER))).toBe(false);
  const after = snapshot();
  draftWrites.push({ added: after.filter((l) => !before.includes(l)), removed: before.filter((l) => !after.includes(l)) });
  return run;
}

/** The brief's W4 line: a --draft run writes nothing, so every --draft run of this test left the home exactly as it found it (paths, sizes, mtimes). */
function expectDraftsWroteNothing(): void {
  expect(draftWrites.length).toBeGreaterThan(0);
  for (const change of draftWrites) expect(change).toEqual({ added: [], removed: [] });
}

/** The trailer the contract fixes, keys in this order; the seed's two keys only once the script carries them. */
function trailer(fallback: "none" | "questions" | "unreachable", listed: number, seeded = 0, failed = 0): string {
  const line: Record<string, unknown> = { welcome: 1, fallback, intents_listed: listed };
  if (SEED_SUPPORTED) Object.assign(line, { intents_seeded: seeded, seed_failed: failed });
  return `${JSON.stringify(line)}\n`;
}

/** A --draft run's whole observable result. */
function expectDraft(run: Run, stdout: string, stderr: string): void {
  expect(run).toEqual({ stdout: `${stdout}\n`, stderr, code: 0 });
}

/**
 * The default mode, twice: the first run prints `text` with nothing on
 * stderr, adds only the marker to the home, and the marker records the
 * welcome; the second prints WELCOME_ALREADY_SENT and calls Index not at all.
 * Returns the calls the first run made.
 */
async function claimOnce(text: string, options: Spawn = {}): Promise<FakeCall[]> {
  const before = new Set(snapshot().map((line) => line.split(" ")[0]));
  const from = stub.fake.calls.length;
  const t0 = Date.now();
  const first = await spawn([], options);
  const t1 = Date.now();
  expect(first).toEqual({ stdout: `${text}\n`, stderr: "", code: 0 });
  const added = snapshot()
    .map((line) => line.split(" ")[0])
    .filter((path) => !before.has(path));
  expect(added.sort()).toEqual(before.has("memory") ? [MARKER] : ["memory", MARKER]);
  const marker = JSON.parse(readFileSync(join(home, MARKER), "utf8")) as Record<string, unknown>;
  expect(Object.keys(marker)).toEqual(["welcomeSent", "sentAt"]);
  expect(marker.welcomeSent).toBe(true);
  const sentAt = Date.parse(String(marker.sentAt));
  expect(new Date(sentAt).toISOString()).toBe(String(marker.sentAt));
  expect(sentAt).toBeGreaterThanOrEqual(t0 - 1000);
  expect(sentAt).toBeLessThanOrEqual(t1 + 1000);
  const firstCalls = toolCalls(from);

  const markerBytes = readFileSync(join(home, MARKER), "utf8");
  const afterFirst = stub.fake.calls.length;
  const second = await spawn([], options);
  expect(second).toEqual({ stdout: `${ALREADY_SENT}\n`, stderr: "", code: 0 });
  expect(stub.fake.calls.length).toBe(afterFirst);
  expect(readFileSync(join(home, MARKER), "utf8")).toBe(markerBytes);
  return firstCalls;
}

/** Only reads: every one of `calls` a `list_intents` with the key, so nothing was created or changed. */
function expectReadsOnly(calls: FakeCall[], count: number): void {
  expect(names(calls)).toEqual(Array(count).fill("list_intents"));
  for (const call of calls) expect(call.headers["x-api-key"]).toBe(FAKE_API_KEY);
}

/** welcome-texts.json pins at least one seeded text (W1 adds them). */
const PINS_SEEDED = Object.values(golden).some((text) => text.includes(SEEDED_LEAD));

/**
 * The seeded welcome: the lead, then exactly `titles` as `- ` lines, then
 * the close; under the overlay's cap. When welcome-texts.json pins a seeded
 * text for the same name and titles, the bytes must match it. Returns how
 * many pinned texts it was compared with.
 */
function expectSeededText(stdout: string, name: string | null, titles: string[]): number {
  const text = stdout.slice(0, -1);
  expect(stdout.endsWith("\n")).toBe(true);
  const intro = name
    ? `Mandrem, Goa, October 11 to November 1. I'm ${name}, your personal agent for your time in the village.`
    : "Mandrem, Goa, October 11 to November 1. I'm your personal agent for your time in the village. You can call me Edge, or give me whatever name you like.";
  expect(text.startsWith(`Welcome to Edge City India ☀️\n\n${intro}\n\n`)).toBe(true);
  const block = [SEEDED_LEAD, ...titles.map((t) => `- ${t}`)].join("\n");
  expect(text).toContain(`\n\n${block}\n\n`);
  expect(text.split("\n").filter((l) => l.startsWith("- "))).toEqual(titles.map((t) => `- ${t}`));
  expect(text).toContain(SEEDED_CLOSE);
  expect(text.length).toBeLessThan(WELCOME_MAX_CHARS);
  let compared = 0;
  for (const pinned of Object.values(golden)) {
    const dashes = pinned.split("\n").filter((l) => l.startsWith("- "));
    if (pinned.includes(SEEDED_LEAD) && pinned.includes(intro) && JSON.stringify(dashes) === JSON.stringify(titles.map((t) => `- ${t}`))) {
      expect(text).toBe(pinned);
      compared++;
    }
  }
  return compared;
}

/** The create calls, in order: exactly `texts` as `description`, no key beyond the brief's. */
function expectCreated(calls: FakeCall[], texts: string[]): void {
  const made = creates(calls);
  expect(made.map((c) => c.arguments?.description)).toEqual(texts);
  for (const call of made) {
    for (const key of Object.keys(call.arguments ?? {})) expect({ key, allowed: CREATE_KEYS.has(key) }).toEqual({ key, allowed: true });
    if (call.arguments && "source" in call.arguments) expect(String(call.arguments.source)).toMatch(/onboarding/i);
    expect(call.headers["x-api-key"]).toBe(FAKE_API_KEY);
  }
}

// ---------------------------------------------------------------------------

describe("none: active intents are listed, nothing is created", () => {
  const cases: Array<[string, string | null, string[]]> = [
    ["one", "Mira", [MEMORY]],
    ["two", null, [MEMORY, DINNER]],
    ["three", "Mira", [MEMORY, DINNER, SURF]],
    // Five active: the first three, and the lead says three of them (the fixture's moreThanThree, pinned with four).
    ["moreThanThree", "Mira", [MEMORY, DINNER, SURF, KONKANI, CHESS]],
  ];
  for (const [key, nickname, rows] of cases) {
    test(
      `${rows.length} active (${key}): stdout is the fixture, one trailer line, exit 0; only list_intents; by default the marker is claimed once`,
      async () => {
        resetStub(rows);
        if (nickname) writeProfile(nickname);
        const listed = Math.min(rows.length, 3);
        expectDraft(await draft(), golden[key], trailer("none", listed));
        expectReadsOnly(toolCalls(), 1);
        const calls = await claimOnce(golden[key]);
        expectReadsOnly(calls, 1);
        expectDraftsWroteNothing();
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "paused and archived intents are not active: with only those, the questions text",
    async () => {
      resetStub();
      stub.rows = [row(MEMORY, 1, "paused"), row(DINNER, 2, "archived")];
      expectDraft(await draft(), golden.zero, trailer("questions", 0));
      expectReadsOnly(toolCalls(), 1);
      expectDraftsWroteNothing();
    },
    CASE_TIMEOUT_MS,
  );
});

describe("questions: no active intents and nothing selected", () => {
  const homes: Array<[string, string[] | null]> = [
    ["no USER.md", null],
    ["a USER.md whose `## Selected intentions` is empty (follow-up answers, offers and an imported source still carry `- ` lines)", []],
  ];
  for (const [label, texts] of homes) {
    test(
      `${label}: the fixture's questions text, zero create calls, stderr empty by default`,
      async () => {
        resetStub();
        writeUserMd(texts);
        expectDraft(await draft(), golden.zero, trailer("questions", 0));
        expectReadsOnly(toolCalls(), 1);
        const calls = await claimOnce(golden.zero);
        expectReadsOnly(calls, 1);
        expectDraftsWroteNothing();
      },
      CASE_TIMEOUT_MS,
    );
  }
});

describe("unreachable: the fixture's catch-up text and nothing created, even with intentions selected", () => {
  const cases: Array<[string, () => Spawn, () => void]> = [
    ["no INDEX_API_KEY", () => ({ key: "" }), () => {}],
    ["Index answers HTTP 500", () => ({}), () => (stub.down = true)],
    ["INDEX_MCP_URL is a closed port", () => ({ url: CLOSED_URL }), () => {}],
  ];
  for (const [label, options, arrange] of cases) {
    test(
      `${label}: stdout is the fixture, one trailer line, exit 0; zero create calls; by default stderr empty and the marker claimed once`,
      async () => {
        resetStub();
        arrange();
        writeUserMd([MEMORY, DINNER, SURF]);
        expectDraft(await draft(options()), golden.unreachable, trailer("unreachable", 0));
        const calls = toolCalls();
        // Without a key or a listening port the stub hears nothing; a 500 is one failed read, never followed by a write.
        expectReadsOnly(calls, label.includes("500") ? 1 : 0);
        expectReadsOnly(await claimOnce(golden.unreachable, options()), label.includes("500") ? 1 : 0);
        expectDraftsWroteNothing();
      },
      CASE_TIMEOUT_MS,
    );
  }
});

describe("active intents present and intentions selected: the dedupe path creates nothing", () => {
  test(
    "an active intent whose title is a selected line, and another selected line: zero create calls, the plain listing",
    async () => {
      resetStub([MEMORY]);
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      expectDraft(await draft(), golden.one, trailer("none", 1));
      expectReadsOnly(toolCalls(), 1);
      expectReadsOnly(await claimOnce(golden.one), 1);
      expectDraftsWroteNothing();
    },
    CASE_TIMEOUT_MS,
  );
});

describe(`seeded (DATA-412 W1): zero active and selected lines in USER.md${SEED_SKIP}`, () => {
  // The names and texts of welcome-texts.json seededOne and seededThree, so the bytes are compared once W1 pins them.
  const cases: Array<[number, string | null, string[]]> = [
    [1, null, [MEMORY]],
    [3, "Mira", [MEMORY, RUST, RAISE]],
    [5, "Mira", [MEMORY, RUST, RAISE, KONKANI, CHESS]],
  ];
  for (const [n, nickname, texts] of cases) {
    const seeded = texts.slice(0, 3);
    test.skipIf(!SEED_SUPPORTED)(
      `${n} selected${SEED_SKIP}: create_intent once per selected text, first three in order, then the re-list; the seeded text; intents_seeded=${seeded.length}, seed_failed=0`,
      async () => {
        resetStub();
        if (nickname) writeProfile(nickname);
        writeUserMd(texts);
        const run = await draft();
        expect(run.code).toBe(0);
        expect(run.stderr).toBe(trailer("none", seeded.length, seeded.length, 0));
        expect(expectSeededText(run.stdout, nickname, seeded)).toBe(PINS_SEEDED ? 1 : 0);
        const calls = toolCalls();
        expect(names(calls)).toEqual(["list_intents", ...seeded.map(() => "create_intent"), "list_intents"]);
        expectCreated(calls, seeded);
        expect(stub.rows.map((r) => r.summary)).toEqual(seeded);
        expectDraftsWroteNothing();
      },
      CASE_TIMEOUT_MS,
    );
  }

  test.skipIf(!SEED_SUPPORTED)(
    `a second --draft for the same box (the control plane's retry, a re-attach)${SEED_SKIP}: nothing created again, the plain listing, intents_seeded=0`,
    async () => {
      resetStub();
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      expect((await draft()).code).toBe(0);
      expect(creates(toolCalls())).toHaveLength(3);
      const from = stub.fake.calls.length;
      expectDraft(await draft(), golden.three, trailer("none", 3, 0, 0));
      expectReadsOnly(toolCalls(from), 1);
      expect(creates(stub.fake.calls)).toHaveLength(3);
      expectDraftsWroteNothing();
    },
    CASE_TIMEOUT_MS,
  );

  test.skipIf(!SEED_SUPPORTED)(
    `default mode${SEED_SKIP}: seeds, prints the seeded text with stderr empty, claims the marker; the second run calls Index not at all`,
    async () => {
      resetStub();
      writeUserMd([MEMORY, DINNER]);
      const before = new Set(snapshot().map((line) => line.split(" ")[0]));
      const from = stub.fake.calls.length;
      const first = await spawn([]);
      expect({ stderr: first.stderr, code: first.code }).toEqual({ stderr: "", code: 0 });
      expectSeededText(first.stdout, null, [MEMORY, DINNER]);
      expectCreated(toolCalls(from), [MEMORY, DINNER]);
      expect(names(toolCalls(from))).toEqual(["list_intents", "create_intent", "create_intent", "list_intents"]);
      const added = snapshot()
        .map((line) => line.split(" ")[0])
        .filter((p) => !before.has(p));
      const afterFirst = stub.fake.calls.length;
      expect(await spawn([])).toEqual({ stdout: `${ALREADY_SENT}\n`, stderr: "", code: 0 });
      expect(stub.fake.calls.length).toBe(afterFirst);
      // The welcome marker is claimed; the brief names no other file, so anything else written is reported here, under memory/ only.
      expect(added).toContain(MARKER);
      for (const path of added) expect(path === "memory" || path.startsWith("memory/")).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );
});

describe(`seed failure (DATA-412 W1): one create fails, the others still go${SEED_SKIP}`, () => {
  const failures: Array<[CreateFailure, number]> = [
    ["isError", 1],
    ["isError", 2],
    ["http500", 3],
  ];
  for (const [failure, which] of failures) {
    test.skipIf(!SEED_SUPPORTED)(
      `create #${which} answers ${failure}${SEED_SKIP}: all three attempted in order, two created and listed, intents_seeded=2, seed_failed=1`,
      async () => {
        resetStub();
        stub.failCreates.set(which, failure);
        writeProfile("Mira");
        const texts = [MEMORY, DINNER, SURF];
        writeUserMd(texts);
        const run = await draft();
        expect(run.code).toBe(0);
        expect(run.stderr).toBe(trailer("none", 2, 2, 1));
        const kept = texts.filter((_, i) => i !== which - 1);
        expectSeededText(run.stdout, "Mira", kept);
        const calls = toolCalls();
        expect(names(calls)).toEqual(["list_intents", "create_intent", "create_intent", "create_intent", "list_intents"]);
        expectCreated(calls, texts);
        expect(stub.rows.map((r) => r.summary)).toEqual(kept);
        expectDraftsWroteNothing();
      },
      CASE_TIMEOUT_MS,
    );
  }
});
