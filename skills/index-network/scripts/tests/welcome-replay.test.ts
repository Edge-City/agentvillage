/**
 * DATA-416 W4 (was DATA-412): an end-to-end replay of the welcome, every
 * branch, through the real script as a subprocess.
 *
 *   bun test skills/index-network/scripts/tests/welcome-replay.test.ts
 *   WELCOME_SCRIPT=/path/to/welcome.ts bun test skills/index-network/scripts/tests/welcome-replay.test.ts
 *
 * Each case runs `bun welcome.ts --draft --home <tmp>` (and the default mode)
 * with HERMES_HOME=<tmp>, INDEX_API_KEY and INDEX_MCP_URL pointing at a local
 * Bun.serve on 127.0.0.1 that fronts indexMcpFake. The stub is stateful:
 * `list_intents` answers the current rows, `create_intent` adds one active
 * row with its `description` as summary, `pause_intent` pauses the row it
 * names, so a seeded welcome re-lists what it created. Every call the stub
 * receives is recorded (tool name, arguments, headers).
 *
 * welcome.test.ts and welcome-seed.test.ts pin the texts, the trailer and the
 * markers in process; this file checks what only a replay shows, against W1's
 * final contract (welcome.ts header, DATA-416):
 *   - the exact Index calls a real run makes on each branch: `list_intents`
 *     only unless it seeds; then `create_intent({description, sourceType:
 *     "agentvillage"})` with exactly the selected texts (first three, after
 *     dedupe), `pause_intent({intentId})` for each created id in paused mode,
 *     and the second list; nothing but those three tools, ever;
 *   - stdout bytes against fixtures/welcome-texts.json (the derived seeded
 *     and listed texts are built by helpers that first reproduce the pinned
 *     ones byte for byte), exit 0, one five-key stderr line with --draft and
 *     none without;
 *   - a --draft run never writes memory/welcome-state.json; it adds exactly
 *     memory/welcome-seed.json (and memory/ when absent) when it seeded, and
 *     nothing at all when it did not; the seed marker's bytes after a seed;
 *   - the default mode claims memory/welcome-state.json once;
 *   - a marker that exists stops the creates across processes, whatever the
 *     first list showed (DATA-416 race 1): a run that finds it waits while it
 *     lacks `done`, then lists again in every case (race 2), so a welcome
 *     beside another run's seed lists every seeded intent; such a run's
 *     trailer says intents_seeded 0 (the refuter's C-1, W1's documented
 *     behaviour);
 *   - every run ends inside the control plane's 60 s draft timeout, and every
 *     case inside 60 s.
 *
 * The timers are read from the script under test (WELCOME_BUDGET_MS,
 * WELCOME_SEED_WAIT_MS, WELCOME_SEED_TIMEOUT_MS, WELCOME_RELIST_RESERVE_MS).
 * Two cases wait them out for real, because the timer is what they test and
 * a subprocess has no knob for it: the timed-out create (WELCOME_SEED_TIMEOUT_MS,
 * 20 s) and the marker that never gains done (WELCOME_SEED_WAIT_MS, 25 s).
 * Everything else uses the stub's own latency and finishes in a few seconds.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { FAKE_API_KEY, type FakeCall, type ToolHandler, type ToolReply, indexMcpFake } from "./index-mcp-fake";

const SCRIPT = process.env.WELCOME_SCRIPT?.trim() || join(import.meta.dir, "..", "welcome.ts");
/** The script under test as a module (its `import.meta.main` guard keeps it from running), for its timers only. */
const W1 = (await import(SCRIPT)) as typeof import("../welcome");
/** The texts pinned next to the script under test. */
const golden = JSON.parse(readFileSync(join(dirname(SCRIPT), "tests", "fixtures", "welcome-texts.json"), "utf8")) as Record<string, string>;

/** The welcome marker and the already-sent word: the contract shared with the control plane and install/welcome_state.ts. */
const MARKER = join("memory", "welcome-state.json");
const ALREADY_SENT = "WELCOME_ALREADY_SENT";
/** The seed marker (welcome.ts WELCOME_SEED_FILE): claimed exclusively in both modes, `done` after the seed. */
const SEED_MARKER = join("memory", "welcome-seed.json");
/** create_intent's one constant besides the text (welcome.ts SEED_SOURCE_TYPE). */
const SOURCE_TYPE = "agentvillage";
/** The only tools a welcome run may call. */
const ALLOWED_TOOLS = ["list_intents", "create_intent", "pause_intent"];
/** The trailer's keys, in this order, nothing else. */
const TRAILER_KEYS = ["welcome", "fallback", "intents_listed", "intents_seeded", "seed_failed"];
/** The seeded branch's lead and close, by mode (welcome.ts SEEDED_COPY; the fixtures pin them). */
const SEEDED = {
  publish: { lead: "From what you told me at signup, I've set up these signals:", close: "Say change or pause to adjust any of them, or tell me a new one." },
  paused: { lead: "From what you told me at signup, I've drafted these signals, paused until you say go:", close: "Say go to publish any of them, change or drop to adjust, or tell me a new one." },
} as const;
/** The same when the seeded welcome lists exactly one intent, singular throughout (welcome.ts SEEDED_COPY_ONE, DATA-416 Q3; seededOne, seededPausedOne). */
const SEEDED_ONE = {
  publish: { lead: "From what you told me at signup, I've set up this signal:", close: "Say change or pause to adjust it, or tell me a new one." },
  paused: { lead: "From what you told me at signup, I've drafted this signal, paused until you say go:", close: "Say go to publish it, change or drop to adjust, or tell me a new one." },
} as const;
type Mode = keyof typeof SEEDED;
/** The overlay's cap on the whole welcome (welcome.ts WELCOME_MAX_CHARS). */
const WELCOME_MAX_CHARS = 1150;
/**
 * The script's timers, read from it (W1 after its fix round 2: budget 50 s,
 * was 25 s; seed wait 25 s, was 10 s; one create 20 s; the second list's
 * reserve 5 s), as a subprocess meets them.
 */
const BUDGET_MS = W1.WELCOME_BUDGET_MS;
const SEED_WAIT_MS = W1.WELCOME_SEED_WAIT_MS;
const SEED_TIMEOUT_MS = W1.WELCOME_SEED_TIMEOUT_MS;
const RELIST_RESERVE_MS = W1.WELCOME_RELIST_RESERVE_MS;
/**
 * The control plane stops a `--draft` run at its draft timeout and sends its
 * fixed greeting instead (control-plane telegram-onboarding.js greetingDraft,
 * 60 s from DATA-416 W2): every run here must end before it.
 */
const CP_DRAFT_TIMEOUT_MS = 60_000;
/** What a subprocess adds to the script's own Index time: bun's start, the imports, the files. */
const PROCESS_MARGIN_MS = 5_000;
/** Each case inside the control plane's draft timeout too; the two slow ones wait out the script's own timers. */
const CASE_TIMEOUT_MS = CP_DRAFT_TIMEOUT_MS;

const MEMORY = "Looking for people building agent memory";
const DINNER = "Open to co-hosting a village dinner";
const SURF = "Want a surfing buddy for early mornings";
const KONKANI = "Learning Konkani";
const CHESS = "Find a chess partner for the evenings";
/** The selected texts W1 pins its seeded texts with (welcome-texts.json seededThree, seededOne, seededPausedThree). */
const RUST = "Hiring a founding engineer who loves Rust";
const RAISE = "Want advice on raising a seed round in India";

// ---------------------------------------------------------------------------
// The texts: built from parts, and the builders first reproduce every pinned text byte for byte.

const intro = (name: string | null) =>
  name
    ? `Mandrem, Goa, October 11 to November 1. I'm ${name}, your personal agent for your time in the village.`
    : "Mandrem, Goa, October 11 to November 1. I'm your personal agent for your time in the village. You can call me Edge, or give me whatever name you like.";
const keepWatch = (n: number) => `I'll keep watch for people and events that fit ${n === 1 ? "this" : "these"} and bring the best to your morning brief.`;

/** The seeded welcome for `titles`, singular for one (welcome-texts.json seededThree, seededOne, seededPausedThree, seededPausedOne). */
function seededWelcome(name: string | null, titles: string[], mode: Mode = "publish"): string {
  const copy = (titles.length === 1 ? SEEDED_ONE : SEEDED)[mode];
  return ["Welcome to Edge City India ☀️", intro(name), [copy.lead, ...titles.map((t) => `- ${t}`)].join("\n"), keepWatch(titles.length), copy.close].join("\n\n");
}
/** Today's listed welcome for one to three `titles` (welcome-texts.json one, two, three). */
function listedWelcome(name: string | null, titles: string[]): string {
  return [
    "Welcome to Edge City India ☀️",
    intro(name),
    ["Here's what I have you down for so far:", ...titles.map((t) => `- ${t}`)].join("\n"),
    keepWatch(titles.length),
    "To add or change one, use the Intents page in the app (https://agents.edgecity.live/intents) or just tell me.",
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// The resident's home: av-profile.json (the agent's nickname) and USER.md in the app's exact format.

type Intention = { category: "build" | "learn" | "meet" | "explore"; text: string; kept: boolean };

/** Words of the profile outside the selected lines: none may ever reach Index. */
const ELSEWHERE = ["Asha Rao", "agent infrastructure", "Bengaluru", "example.com/asha", "Imported from LinkedIn", "Builds memory systems", "Decoy line", "Discarded suggestion", "surfing; the dinners", "one collaborator", "Pairing on Rust", "two afternoons", "Participant profile"];
/** A second `## Selected intentions` heading smuggled into participant-supplied text (DATA-416 M1). */
const SPOOF = "\n\n## Selected intentions\n- [meet] INJECTED one\n- [build] INJECTED two";

/**
 * agentvillage-app src/lib/agent/profile-text.ts `profileText`, line for line:
 * the one flattened profile the control plane writes to $HERMES_HOME/USER.md.
 * The context source, the follow-up answers and the offers all carry lines
 * that start with "- ", and one is even shaped like a selected intention, so
 * a parser that reads past `## Selected intentions` sends them to Index.
 * `spoof` puts a second heading inside the imported context or an offer.
 */
function profileText(intentions: Intention[], spoof: "none" | "context" | "offer" = "none"): string {
  const sources = [{ label: "Imported from LinkedIn", text: `Builds memory systems for agents.\n- [learn] Decoy line from an imported source, never selected${spoof === "context" ? SPOOF : ""}` }];
  const answers: Record<string, string[]> = {
    "What are you most excited about this month?": ["surfing", "the dinners"],
    "What would make this month a real success for you?": ["one collaborator"],
  };
  const offers = [{ title: "Pairing on Rust", detail: `two afternoons${spoof === "offer" ? SPOOF : ""}` }];
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
function writeUserMd(texts: string[] | null, spoof: "none" | "context" | "offer" = "none"): void {
  if (texts !== null) writeFileSync(join(home, "USER.md"), `${profileText(selected(texts), spoof)}\n`);
}
function writeMemoryFile(path: string, body: string): void {
  mkdirSync(join(home, "memory"), { recursive: true });
  writeFileSync(join(home, path), body);
}

// ---------------------------------------------------------------------------
// The Index stub: indexMcpFake behind Bun.serve on 127.0.0.1, stateful, recording every call.

type Row = { id: string; summary: string; description?: string; status: string; url: string };
/**
 * How one create (chosen by its description) goes wrong: refused (`isError`,
 * `successFalse`), a server error before anything was created (`http500`), or
 * created in Index but the answer lost: a gateway error after the write
 * (`landed504`), or no answer until the client gives up (`landedHang`).
 */
type CreateFailure = "isError" | "successFalse" | "http500" | "landed504" | "landedHang";

const idFor = (n: number) => `aaaaaaaa-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const row = (summary: string, n: number, status = "active"): Row => ({ id: idFor(n), summary, status, url: `https://index.network/i/${idFor(n)}` });
/** A `list_intents` text in the live shape (markdown lead, blank line, JSON). */
function intentsText(rows: Row[]): string {
  return `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, totalWaitingOpportunities: 0, pagination: { limit: 20, offset: 0, count: rows.length } }, null, 2)}`;
}
/** A `create_intent` answer in the live shape: the signal link, a blank line, then the JSON. */
function createAnswer(created: Row): string {
  return `[${created.summary}](https://agents.edgecity.live/intents?intent=${created.id}) — created\n\n${JSON.stringify({ success: true, data: { intent: { id: created.id, summary: created.summary, status: created.status } } }, null, 2)}`;
}

const stub = {
  rows: [] as Row[],
  /** list_intents answers these rows, whatever was created (only the seed marker can stop a second seed). */
  frozen: null as Row[] | null,
  /** Every request answers HTTP 500. */
  down: false,
  /** create_intent failures, by description. */
  failCreates: new Map<string, CreateFailure>(),
  /** Every create answers after this long. */
  createDelayMs: 0,
  /** One create (by description) answers after this long instead; its row lands in Index only then. */
  createDelays: new Map<string, number>(),
  /** How many active rows each list_intents answer held, in the order they were answered. */
  listed: [] as number[],
  /** Runs once, right after the next list_intents is answered: another run's creates landing in between. */
  afterList: null as (() => void) | null,
  /** pause_intent answers a tool error. */
  failPause: false,
  creates: 0,
  fake: null as unknown as ReturnType<typeof indexMcpFake>,
};

function resetStub(rows: string[] = []): void {
  stub.rows = rows.map((summary, i) => row(summary, i + 1));
  stub.frozen = null;
  stub.down = false;
  stub.failCreates = new Map();
  stub.createDelayMs = 0;
  stub.createDelays = new Map();
  stub.listed = [];
  stub.afterList = null;
  stub.failPause = false;
  stub.creates = 0;
  const status = (code: number): ToolReply => ({ response: new Response("upstream error", { status: code }) });
  const toolError = (text: string): ToolReply => ({ result: { content: [{ type: "text", text }], isError: true, resultType: "complete" } });
  const tools: Record<string, ToolHandler> = {
    list_intents: () => {
      if (stub.down) return status(500);
      const rows = stub.frozen ?? stub.rows;
      stub.listed.push(rows.filter((r) => r.status === "active").length);
      const text = intentsText(rows);
      const after = stub.afterList;
      stub.afterList = null;
      after?.();
      return text;
    },
    create_intent: async (args) => {
      if (stub.down) return status(500);
      const n = ++stub.creates;
      const description = String(args.description ?? "");
      const delay = stub.createDelays.get(description) ?? stub.createDelayMs;
      if (delay) await Bun.sleep(delay);
      const failure = stub.failCreates.get(description);
      if (failure === "isError") return toolError("Could not create the intent.");
      if (failure === "successFalse") return `Too vague to match on.\n\n${JSON.stringify({ success: false, error: "too vague" })}`;
      if (failure === "http500") return status(500);
      const created = row(description, 0x100 + n);
      stub.rows.push(created);
      if (failure === "landed504") return status(504);
      if (failure === "landedHang") return { hang: true };
      return createAnswer(created);
    },
    pause_intent: (args) => {
      if (stub.down) return status(500);
      if (stub.failPause) return toolError("Could not pause the intent.");
      const target = stub.rows.find((r) => r.id === args.intentId);
      if (!target) return toolError("No such intent.");
      target.status = "paused";
      return `[${target.summary}](https://agents.edgecity.live/intents?intent=${target.id}) — paused\n\n${JSON.stringify({ success: true, data: { intentId: target.id, status: "paused", changed: true } })}`;
    },
  };
  stub.fake = indexMcpFake({ url: "http://127.0.0.1/mcp", apiKey: FAKE_API_KEY, tools });
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
    idleTimeout: 0,
    fetch: async (req) => stub.fake.fetch(stub.fake.url, { method: req.method, headers: req.headers, body: await req.text(), signal: req.signal }),
  });
  MCP_URL = `http://127.0.0.1:${server.port}/mcp`;
  const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  CLOSED_URL = `http://127.0.0.1:${closed.port}/mcp`;
  closed.stop(true);
});
afterAll(() => {
  server.stop(true);
});

/** Whatever the case, every request that reached Index was a tools/call of an allowed tool, with the key. */
afterEach(() => {
  for (const call of stub.fake.calls) {
    expect({ method: call.method, name: call.name, allowed: ALLOWED_TOOLS.includes(String(call.name)), key: call.headers["x-api-key"] }).toEqual({
      method: "tools/call",
      name: call.name,
      allowed: true,
      key: FAKE_API_KEY,
    });
  }
});

/** The tool calls the stub received since `from`. */
const toolCalls = (from = 0): FakeCall[] => stub.fake.calls.slice(from);
const names = (calls: FakeCall[]) => calls.map((c) => c.name);
const creates = (calls: FakeCall[]) => calls.filter((c) => c.name === "create_intent");
const pauses = (calls: FakeCall[]) => calls.filter((c) => c.name === "pause_intent");

// ---------------------------------------------------------------------------
// The script, as a process.

type Run = { stdout: string; stderr: string; code: number };
type Spawn = { key?: string; url?: string; env?: Record<string, string> };

/** Env vars that would change the run; dropped from the child's environment (the seed's mode flag among them). */
const DROPPED = /^(INDEX_|AV_|HERMES_)|SEED/;

/** Every run ends inside the control plane's draft timeout, whatever the case (the cp would have sent its fixed greeting). */
async function spawn(argv: string[], options: Spawn = {}): Promise<Run> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !DROPPED.test(k)) env[k] = v;
  Object.assign(env, { HERMES_HOME: home, INDEX_API_KEY: options.key ?? FAKE_API_KEY, INDEX_MCP_URL: options.url ?? MCP_URL, AV_CONNECTIONS_URL: "" }, options.env ?? {});
  const t0 = Date.now();
  const proc = Bun.spawn(["bun", SCRIPT, ...argv], { env, cwd: home, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  expect(Date.now() - t0).toBeLessThan(CP_DRAFT_TIMEOUT_MS);
  return { stdout, stderr, code };
}

/** Each case, all its runs together, inside the control plane's draft timeout as well (and CASE_TIMEOUT_MS stops one that is not). */
let caseStart = 0;
beforeEach(() => {
  caseStart = Date.now();
});
afterEach(() => {
  expect(Date.now() - caseStart).toBeLessThan(CP_DRAFT_TIMEOUT_MS);
});
const draftArgv = () => ["--draft", "--home", home];

/** Every path under the home: a file with its size and mtime, a directory by its path (its children show its changes). */
function snapshot(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      out.push(st.isDirectory() ? `${relative(home, path)} dir` : `${relative(home, path)} file ${st.size} ${st.mtimeMs}`);
      if (st.isDirectory()) walk(path);
    }
  };
  walk(home);
  return out;
}
const paths = (lines: string[]) => lines.map((line) => line.split(" ")[0]);
const readOrNull = (path: string) => (existsSync(join(home, path)) ? readFileSync(join(home, path), "utf8") : null);

/**
 * What each --draft run of the current test changed under the home, and
 * what it was allowed to: nothing, or (`seed`) exactly the seed marker, plus
 * memory/ when it was absent. Checked at the end of each test
 * (expectDraftWrites), after the calls and the text, so a write never hides
 * how the rest of the run went.
 */
type DraftWrites = { allowed: "nothing" | "seed"; added: string[]; removed: string[]; hadMemory: boolean };
let draftWrites: DraftWrites[] = [];
beforeEach(() => {
  draftWrites = [];
});

/** `bun welcome.ts --draft --home <home>`: the welcome marker is never touched; every other change recorded for expectDraftWrites. */
async function draft(allowed: DraftWrites["allowed"], options: Spawn = {}): Promise<Run> {
  const before = snapshot();
  const welcomeBefore = readOrNull(MARKER);
  const hadMemory = existsSync(join(home, "memory"));
  const run = await spawn(draftArgv(), options);
  expect(readOrNull(MARKER)).toBe(welcomeBefore);
  const after = snapshot();
  draftWrites.push({ allowed, added: after.filter((l) => !before.includes(l)), removed: before.filter((l) => !after.includes(l)), hadMemory });
  return run;
}

/** W1's contract: a --draft run that seeded added only the seed marker (and memory/ when absent); any other --draft run changed nothing. */
function expectDraftWrites(): void {
  expect(draftWrites.length).toBeGreaterThan(0);
  for (const change of draftWrites) {
    const expected = change.allowed === "nothing" ? [] : change.hadMemory ? [SEED_MARKER] : ["memory", SEED_MARKER];
    expect({ allowed: change.allowed, added: paths(change.added), removed: change.removed }).toEqual({ allowed: change.allowed, added: expected, removed: [] });
  }
}

/** The trailer the contract fixes: five keys in this order, nothing else. */
function trailer(fallback: "none" | "questions" | "context" | "unreachable", listed: number, seeded = 0, failed = 0): string {
  return `${JSON.stringify({ welcome: 1, fallback, intents_listed: listed, intents_seeded: seeded, seed_failed: failed })}\n`;
}

/** A --draft run's whole observable result; the trailer is one line of exactly the five keys, in order. */
function expectDraft(run: Run, stdout: string, stderr: string): void {
  expect({ stdout: run.stdout, stderr: run.stderr, code: run.code }).toEqual({ stdout: `${stdout}\n`, stderr, code: 0 });
  expect(stdout.length).toBeLessThanOrEqual(WELCOME_MAX_CHARS);
  expect(run.stderr.split("\n")).toHaveLength(2);
  expect(Object.keys(JSON.parse(run.stderr))).toEqual(TRAILER_KEYS);
}

/**
 * The seed marker after a seed: exactly `{seededAt, selected, created,
 * failed, done: true}` in that order and a newline, mode 0600, seededAt the
 * run's own time.
 */
function expectSeedMarker(counts: { selected: number; created: number; failed: number }, t0: number, t1: number): void {
  const raw = readFileSync(join(home, SEED_MARKER), "utf8");
  const marker = JSON.parse(raw) as Record<string, unknown>;
  expect(raw).toBe(`${JSON.stringify({ seededAt: marker.seededAt, ...counts, done: true })}\n`);
  const at = Date.parse(String(marker.seededAt));
  expect(new Date(at).toISOString()).toBe(String(marker.seededAt));
  expect(at).toBeGreaterThanOrEqual(t0 - 1000);
  expect(at).toBeLessThanOrEqual(t1 + 1000);
  expect(statSync(join(home, SEED_MARKER)).mode & 0o777).toBe(0o600);
}

/** A --draft run that is expected to seed, timed for expectSeedMarker. */
async function seedingDraft(options: Spawn = {}): Promise<Run & { t0: number; t1: number }> {
  const t0 = Date.now();
  const run = await draft("seed", options);
  return { ...run, t0, t1: Date.now() };
}

/**
 * The default mode, twice: the first run prints `text` with nothing on
 * stderr, adds only the welcome marker to the home (never the seed marker),
 * and the marker records the welcome; the second prints WELCOME_ALREADY_SENT
 * and calls Index not at all. Returns the calls the first run made.
 */
async function claimOnce(text: string, options: Spawn = {}): Promise<FakeCall[]> {
  const before = new Set(paths(snapshot()));
  const from = stub.fake.calls.length;
  const t0 = Date.now();
  const first = await spawn([], options);
  const t1 = Date.now();
  expect(first).toEqual({ stdout: `${text}\n`, stderr: "", code: 0 });
  const added = paths(snapshot()).filter((path) => !before.has(path));
  expect(added.sort()).toEqual(before.has("memory") ? [MARKER] : ["memory", MARKER]);
  expectWelcomeMarker(t0, t1);
  const firstCalls = toolCalls(from);
  await expectSecondDefaultRunSilent(options);
  return firstCalls;
}

function expectWelcomeMarker(t0: number, t1: number): void {
  const marker = JSON.parse(readFileSync(join(home, MARKER), "utf8")) as Record<string, unknown>;
  expect(Object.keys(marker)).toEqual(["welcomeSent", "sentAt"]);
  expect(marker.welcomeSent).toBe(true);
  const sentAt = Date.parse(String(marker.sentAt));
  expect(new Date(sentAt).toISOString()).toBe(String(marker.sentAt));
  expect(sentAt).toBeGreaterThanOrEqual(t0 - 1000);
  expect(sentAt).toBeLessThanOrEqual(t1 + 1000);
}

/** A default run once the welcome marker is set: WELCOME_ALREADY_SENT, no Index call, the home untouched. */
async function expectSecondDefaultRunSilent(options: Spawn = {}): Promise<void> {
  const before = snapshot();
  const from = stub.fake.calls.length;
  expect(await spawn([], options)).toEqual({ stdout: `${ALREADY_SENT}\n`, stderr: "", code: 0 });
  expect(stub.fake.calls.length).toBe(from);
  expect(snapshot()).toEqual(before);
}

/** Only reads: every one of `calls` a `list_intents`, so nothing was created or changed. */
function expectReadsOnly(calls: FakeCall[], count: number): void {
  expect(names(calls)).toEqual(Array(count).fill("list_intents"));
  for (const call of calls) expect(call.arguments).toEqual({ limit: 20 });
}

/**
 * A seeding run's calls: the first list, then `texts` created at once (in
 * any arrival order), each with exactly `{description, sourceType}` and no
 * other key, then (paused mode) one pause per created id, then the second
 * list last. Nothing of USER.md but the selected texts in any call.
 */
function expectSeedCalls(calls: FakeCall[], texts: string[], pausedIds: string[] = []): void {
  expect(calls[0]?.name).toBe("list_intents");
  expect(calls.at(-1)?.name).toBe("list_intents");
  expect(names(calls.slice(1, -1)).every((n) => n === "create_intent" || n === "pause_intent")).toBe(true);
  expect(creates(calls).map((c) => c.arguments)).toEqual(
    expect.arrayContaining(texts.map((description) => ({ description, sourceType: SOURCE_TYPE }))),
  );
  expect(creates(calls)).toHaveLength(texts.length);
  expect(pauses(calls).map((c) => c.arguments).sort((a, b) => String(a?.intentId).localeCompare(String(b?.intentId)))).toEqual(
    [...pausedIds].sort().map((intentId) => ({ intentId })),
  );
  for (const call of calls) {
    const body = JSON.stringify(call.body);
    expect(body).not.toMatch(/\[(build|learn|meet|explore)\]/);
    for (const word of [...ELSEWHERE, "INJECTED", "SECRET-ABOUT-ME"]) expect({ word, sent: body.includes(word) }).toEqual({ word, sent: false });
  }
}

// ---------------------------------------------------------------------------

describe("the texts this file derives are the pinned ones", () => {
  test("seededWelcome and listedWelcome reproduce welcome-texts.json byte for byte; the six older keys, the four seeded ones and `context` are all there", () => {
    expect(Object.keys(golden)).toEqual(["three", "moreThanThree", "two", "one", "zero", "unreachable", "seededThree", "seededOne", "seededPausedThree", "seededPausedOne", "context"]);
    expect(seededWelcome("Mira", [MEMORY, RUST, RAISE])).toBe(golden.seededThree);
    // DATA-416 Q3: one seeded intent is singular throughout, in both modes.
    expect(seededWelcome(null, [MEMORY])).toBe(golden.seededOne);
    expect(seededWelcome("Mira", [MEMORY, RUST, RAISE], "paused")).toBe(golden.seededPausedThree);
    expect(seededWelcome(null, [MEMORY], "paused")).toBe(golden.seededPausedOne);
    expect(listedWelcome("Mira", [MEMORY, DINNER, SURF])).toBe(golden.three);
    expect(listedWelcome(null, [MEMORY, DINNER])).toBe(golden.two);
    expect(listedWelcome("Mira", [MEMORY])).toBe(golden.one);
  });

  test("the timers this replay meets, read from the script: budget 50 s, seed wait 25 s, one create 20 s, reserve 5 s; a first welcome fits the control plane's 60 s", () => {
    expect({ BUDGET_MS, SEED_WAIT_MS, SEED_TIMEOUT_MS, RELIST_RESERVE_MS }).toEqual({ BUDGET_MS: 50_000, SEED_WAIT_MS: 25_000, SEED_TIMEOUT_MS: 20_000, RELIST_RESERVE_MS: 5_000 });
    // The wait outlasts one create, so a slow create still shows in the waiting run's welcome.
    expect(SEED_WAIT_MS).toBeGreaterThan(SEED_TIMEOUT_MS);
    // The script's Index time and a process's start fit inside the control plane's draft timeout.
    expect(BUDGET_MS + PROCESS_MARGIN_MS).toBeLessThanOrEqual(CP_DRAFT_TIMEOUT_MS);
  });
});

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
      `${rows.length} active (${key}): stdout is the fixture, one trailer line, exit 0; only list_intents; --draft writes nothing; by default the marker is claimed once`,
      async () => {
        resetStub(rows);
        if (nickname) writeProfile(nickname);
        const listed = Math.min(rows.length, 3);
        expectDraft(await draft("nothing"), golden[key], trailer("none", listed));
        expectReadsOnly(toolCalls(), 1);
        const calls = await claimOnce(golden[key]);
        expectReadsOnly(calls, 1);
        expectDraftWrites();
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "paused and archived intents are not active: with only those and nothing selected, the questions text",
    async () => {
      resetStub();
      stub.rows = [row(MEMORY, 1, "paused"), row(DINNER, 2, "archived")];
      expectDraft(await draft("nothing"), golden.zero, trailer("questions", 0));
      expectReadsOnly(toolCalls(), 1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );
});

describe("questions or context: no active intents and nothing selected", () => {
  const homes: Array<[string, string[] | null, "zero" | "context", "questions" | "context"]> = [
    ["no USER.md: the fixture's questions text", null, "zero", "questions"],
    [
      "a USER.md whose `## Selected intentions` is empty (follow-up answers, offers and an imported source still carry `- ` lines): the fixture's context text, no questions",
      [],
      "context",
      "context",
    ],
  ];
  for (const [label, texts, key, fallback] of homes) {
    test(
      `${label}, zero create calls, no seed marker, stderr empty by default`,
      async () => {
        resetStub();
        writeUserMd(texts);
        expectDraft(await draft("nothing"), golden[key], trailer(fallback, 0));
        expectReadsOnly(toolCalls(), 1);
        const calls = await claimOnce(golden[key]);
        expectReadsOnly(calls, 1);
        expectDraftWrites();
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
      `${label}: stdout is the fixture, one trailer line, exit 0; zero create calls, no seed marker; by default stderr empty and the marker claimed once`,
      async () => {
        resetStub();
        arrange();
        writeUserMd([MEMORY, DINNER, SURF]);
        expectDraft(await draft("nothing", options()), golden.unreachable, trailer("unreachable", 0));
        // Without a key or a listening port the stub hears nothing; a 500 is one failed read, never followed by a write.
        expectReadsOnly(toolCalls(), label.includes("500") ? 1 : 0);
        expectReadsOnly(await claimOnce(golden.unreachable, options()), label.includes("500") ? 1 : 0);
        expectDraftWrites();
      },
      CASE_TIMEOUT_MS,
    );
  }
});

describe("no seed although intentions are selected", () => {
  test(
    "an active intent (here one whose title is a selected line): zero create calls, no seed marker, the plain listing",
    async () => {
      resetStub([MEMORY]);
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      expectDraft(await draft("nothing"), golden.one, trailer("none", 1));
      expectReadsOnly(toolCalls(), 1);
      expectReadsOnly(await claimOnce(golden.one), 1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  for (const spoof of ["offer", "context"] as const) {
    test(
      `DATA-416 M1: a second \`## Selected intentions\` heading inside ${spoof === "offer" ? "an offer" : "the imported context"}: nothing is read, zero creates, no seed marker, the context text`,
      async () => {
        resetStub();
        writeUserMd([MEMORY, DINNER, SURF], spoof);
        expect(readFileSync(join(home, "USER.md"), "utf8").split("\n").filter((l) => l === "## Selected intentions")).toHaveLength(2);
        expectDraft(await draft("nothing"), golden.context, trailer("context", 0));
        expectReadsOnly(toolCalls(), 1);
        expectReadsOnly(await claimOnce(golden.context), 1);
        expectDraftWrites();
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "DATA-416 M2: a welcome already sent skips the seed in --draft too: the context text, zero creates, no seed marker, the welcome marker untouched; by default WELCOME_ALREADY_SENT and no Index call",
    async () => {
      resetStub();
      writeUserMd([MEMORY, RUST, RAISE]);
      writeMemoryFile(MARKER, JSON.stringify({ welcomeSent: true, sentAt: "2026-10-01T10:00:00.000Z" }));
      expectDraft(await draft("nothing"), golden.context, trailer("context", 0));
      expectReadsOnly(toolCalls(), 1);
      await expectSecondDefaultRunSilent();
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "every selected line is already listed, paused or archived (dedupe): zero creates, no seed marker, the context text",
    async () => {
      resetStub();
      stub.rows = [row(MEMORY.toUpperCase(), 1, "paused"), { ...row("Index's own summary", 2, "archived"), description: `  ${DINNER} ` }];
      writeUserMd([MEMORY, DINNER]);
      expectDraft(await draft("nothing"), golden.context, trailer("context", 0));
      expectReadsOnly(toolCalls(), 1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );
});

describe("seeded: zero active intents and selected lines in USER.md", () => {
  // The names and texts of welcome-texts.json seededOne and seededThree, so the bytes are compared with the pins.
  const cases: Array<[number, string | null, string[], string]> = [
    [1, null, [MEMORY], "seededOne"],
    [3, "Mira", [MEMORY, RUST, RAISE], "seededThree"],
    [5, "Mira", [MEMORY, RUST, RAISE, KONKANI, CHESS], "seededThree"],
  ];
  for (const [n, nickname, texts, key] of cases) {
    const seeded = texts.slice(0, 3);
    test(
      `${n} selected: create_intent({description, sourceType}) once per text, the first three, then the re-list; stdout is ${key}; trailer seeded ${seeded.length}, failed 0; --draft adds only the seed marker, done`,
      async () => {
        resetStub();
        if (nickname) writeProfile(nickname);
        writeUserMd(texts);
        const run = await seedingDraft();
        expectDraft(run, golden[key], trailer("none", seeded.length, seeded.length, 0));
        const calls = toolCalls();
        expect(names(calls)).toEqual(["list_intents", ...seeded.map(() => "create_intent"), "list_intents"]);
        expectSeedCalls(calls, seeded);
        expect(stub.rows.map((r) => r.summary).sort()).toEqual([...seeded].sort());
        expectSeedMarker({ selected: n, created: seeded.length, failed: 0 }, run.t0, run.t1);
        expectDraftWrites();
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "AV_WELCOME_SEED_MODE=paused: each created intent is paused with pause_intent({intentId}) of its own create's id, after its create; stdout is seededPausedThree",
    async () => {
      resetStub();
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, RAISE]);
      const run = await seedingDraft({ env: { AV_WELCOME_SEED_MODE: "paused" } });
      expectDraft(run, golden.seededPausedThree, trailer("none", 3, 3, 0));
      const calls = toolCalls();
      expectSeedCalls(calls, [MEMORY, RUST, RAISE], stub.rows.map((r) => r.id));
      for (const created of stub.rows) {
        const made = calls.findIndex((c) => c.name === "create_intent" && c.arguments?.description === created.summary);
        const paused = calls.findIndex((c) => c.name === "pause_intent" && c.arguments?.intentId === created.id);
        expect({ summary: created.summary, order: made >= 0 && paused > made }).toEqual({ summary: created.summary, order: true });
      }
      expect(stub.rows.map((r) => r.status)).toEqual(["paused", "paused", "paused"]);
      expectSeedMarker({ selected: 3, created: 3, failed: 0 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "AV_WELCOME_SEED_MODE=paused, one selected: create then pause_intent of its id, the singular paused text (seededPausedOne), trailer seeded 1",
    async () => {
      resetStub();
      writeUserMd([MEMORY]);
      const run = await seedingDraft({ env: { AV_WELCOME_SEED_MODE: "paused" } });
      expectDraft(run, golden.seededPausedOne, trailer("none", 1, 1, 0));
      expect(names(toolCalls())).toEqual(["list_intents", "create_intent", "pause_intent", "list_intents"]);
      expectSeedCalls(toolCalls(), [MEMORY], [stub.rows[0].id]);
      expect(stub.rows.map((r) => [r.summary, r.status])).toEqual([[MEMORY, "paused"]]);
      expectSeedMarker({ selected: 1, created: 1, failed: 0 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "the creates run at once: three creates answering after 1 s each take about 1 s, not 3",
    async () => {
      resetStub();
      stub.createDelayMs = 1000;
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, RAISE]);
      const run = await seedingDraft();
      expectDraft(run, golden.seededThree, trailer("none", 3, 3, 0));
      expect(run.t1 - run.t0).toBeLessThan(2500);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "dedupe: a selected line repeating an earlier one, or a paused or archived intent (summary or description), is skipped and not counted; the first three fresh lines are created",
    async () => {
      resetStub();
      stub.rows = [row(MEMORY.toUpperCase(), 1, "paused"), { ...row("Index's own summary", 2, "archived"), description: RUST }];
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, KONKANI, "  learning **KONKANI** ", CHESS, SURF, DINNER]);
      const run = await seedingDraft();
      expectDraft(run, seededWelcome("Mira", [KONKANI, CHESS, SURF]), trailer("none", 3, 3, 0));
      expectSeedCalls(toolCalls(), [KONKANI, CHESS, SURF]);
      // `selected` counts every line the profile selected, deduped ones included.
      expectSeedMarker({ selected: 7, created: 3, failed: 0 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "default mode: seeds, prints seededThree with stderr empty, adds memory/, the seed marker and the welcome marker; the second run calls Index not at all",
    async () => {
      resetStub();
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, RAISE]);
      const before = new Set(paths(snapshot()));
      const t0 = Date.now();
      const first = await spawn([]);
      const t1 = Date.now();
      expect(first).toEqual({ stdout: `${golden.seededThree}\n`, stderr: "", code: 0 });
      expectSeedCalls(toolCalls(), [MEMORY, RUST, RAISE]);
      expect(paths(snapshot()).filter((p) => !before.has(p)).sort()).toEqual(["memory", SEED_MARKER, MARKER].sort());
      expectSeedMarker({ selected: 3, created: 3, failed: 0 }, t0, t1);
      expectWelcomeMarker(t0, t1);
      await expectSecondDefaultRunSilent();
    },
    CASE_TIMEOUT_MS,
  );
});

describe("a create that fails: the others still go, and the failure is counted", () => {
  const failures: Array<[CreateFailure, number]> = [
    ["isError", 0],
    ["successFalse", 1],
    ["http500", 2],
  ];
  for (const [failure, which] of failures) {
    test(
      `the create of selected line ${which + 1} answers ${failure}: all three sent, two created and listed in the selected order, trailer seeded 2, failed 1; the marker says so`,
      async () => {
        resetStub();
        const texts = [MEMORY, DINNER, SURF];
        stub.failCreates.set(texts[which], failure);
        writeProfile("Mira");
        writeUserMd(texts);
        const run = await seedingDraft();
        const kept = texts.filter((_, i) => i !== which);
        expectDraft(run, seededWelcome("Mira", kept), trailer("none", 2, 2, 1));
        expectSeedCalls(toolCalls(), texts);
        expect(stub.rows.map((r) => r.summary).sort()).toEqual([...kept].sort());
        expectSeedMarker({ selected: 3, created: 2, failed: 1 }, run.t0, run.t1);
        expectDraftWrites();
      },
      CASE_TIMEOUT_MS,
    );
  }

  test(
    "every create fails: the context text, trailer seeded 0, failed 3; the marker is still claimed and done, so a second run does not try again",
    async () => {
      resetStub();
      for (const t of [MEMORY, DINNER, SURF]) stub.failCreates.set(t, "http500");
      writeUserMd([MEMORY, DINNER, SURF]);
      const run = await seedingDraft();
      expectDraft(run, golden.context, trailer("context", 0, 0, 3));
      expectSeedCalls(toolCalls(), [MEMORY, DINNER, SURF]);
      expectSeedMarker({ selected: 3, created: 0, failed: 3 }, run.t0, run.t1);
      const from = stub.fake.calls.length;
      expectDraft(await draft("nothing"), golden.context, trailer("context", 0));
      // The marker exists, so the second run lists once more (DATA-416 race 2) and creates nothing.
      expectReadsOnly(toolCalls(from), 2);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 S1: a create that landed in Index but whose answer was a gateway 504 counts as seeded once the re-list shows it",
    async () => {
      resetStub();
      stub.failCreates.set(RUST, "landed504");
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, RAISE]);
      const run = await seedingDraft();
      expectDraft(run, golden.seededThree, trailer("none", 3, 3, 0));
      expectSeedCalls(toolCalls(), [MEMORY, RUST, RAISE]);
      expectSeedMarker({ selected: 3, created: 3, failed: 0 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 S1, paused mode: the same landed-but-unanswered create is failed (it was never paused) and left out of the welcome; Index keeps it active",
    async () => {
      resetStub();
      stub.failCreates.set(RUST, "landed504");
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, RAISE]);
      const run = await seedingDraft({ env: { AV_WELCOME_SEED_MODE: "paused" } });
      expectDraft(run, seededWelcome("Mira", [MEMORY, RAISE], "paused"), trailer("none", 2, 2, 1));
      const landed = stub.rows.find((r) => r.summary === RUST)!;
      expectSeedCalls(toolCalls(), [MEMORY, RUST, RAISE], stub.rows.filter((r) => r !== landed).map((r) => r.id));
      // What the resident is left with: the unanswered one published, the other two paused.
      expect(stub.rows.map((r) => [r.summary, r.status]).sort()).toEqual([[MEMORY, "paused"], [RAISE, "paused"], [RUST, "active"]].sort());
      expectSeedMarker({ selected: 3, created: 2, failed: 1 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "paused mode, a pause that fails: the line counts as failed, nothing is retried, and the intent stays active in Index, so the welcome is today's listing of it",
    async () => {
      resetStub();
      stub.failPause = true;
      writeUserMd([MEMORY]);
      const run = await seedingDraft({ env: { AV_WELCOME_SEED_MODE: "paused" } });
      expectDraft(run, listedWelcome(null, [MEMORY]), trailer("none", 1, 0, 1));
      expect(names(toolCalls())).toEqual(["list_intents", "create_intent", "pause_intent", "list_intents"]);
      expectSeedCalls(toolCalls(), [MEMORY], [stub.rows[0].id]);
      expect(stub.rows.map((r) => [r.summary, r.status])).toEqual([[MEMORY, "active"]]);
      expectSeedMarker({ selected: 1, created: 0, failed: 1 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 S1: a create that landed but never answers times out (the script's own 20 s) and counts as seeded once the re-list shows it; the run ends inside the script's 50 s budget and the control plane's 60 s",
    async () => {
      resetStub();
      stub.failCreates.set(RUST, "landedHang");
      writeProfile("Mira");
      writeUserMd([MEMORY, RUST, RAISE]);
      const run = await seedingDraft();
      expectDraft(run, golden.seededThree, trailer("none", 3, 3, 0));
      expectSeedCalls(toolCalls(), [MEMORY, RUST, RAISE]);
      // The hung create is cut at WELCOME_SEED_TIMEOUT_MS (20 s); the whole run, both lists included, is bounded by
      // WELCOME_BUDGET_MS (50 s, every Index call of one run together), plus the process's own start.
      expect(run.t1 - run.t0).toBeGreaterThanOrEqual(SEED_TIMEOUT_MS - 2000);
      expect(run.t1 - run.t0).toBeLessThan(BUDGET_MS + PROCESS_MARGIN_MS);
      expect(run.t1 - run.t0).toBeLessThan(CP_DRAFT_TIMEOUT_MS);
      expectSeedMarker({ selected: 3, created: 3, failed: 0 }, run.t0, run.t1);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );
});

describe("once per box: a seed marker that exists stops every later create, across processes", () => {
  test(
    "a second --draft after a seed (the control plane's retry, a re-attach): no create, it lists twice (the marker exists: DATA-416 race 2), the plain listing, trailer seeded 0; the marker untouched",
    async () => {
      resetStub();
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      expect((await seedingDraft()).code).toBe(0);
      expect(creates(toolCalls())).toHaveLength(3);
      const from = stub.fake.calls.length;
      expectDraft(await draft("nothing"), golden.three, trailer("none", 3, 0, 0));
      expectReadsOnly(toolCalls(from), 2);
      // And the default mode: the plain listing, the welcome marker claimed once, still no create.
      expectReadsOnly(await claimOnce(golden.three), 2);
      expect(creates(stub.fake.calls)).toHaveLength(3);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "Index still lists nothing after the seed (so only the marker can stop it): the second --draft and a default run create nothing and skip the questions (signup context)",
    async () => {
      resetStub();
      stub.frozen = [];
      writeUserMd([MEMORY, DINNER, SURF]);
      const run = await seedingDraft();
      // The creates were answered but the re-list shows none: seeded, and the text falls back to the seeded titles.
      expectDraft(run, seededWelcome(null, [MEMORY, DINNER, SURF]), trailer("none", 3, 3, 0));
      const from = stub.fake.calls.length;
      expectDraft(await draft("nothing"), golden.context, trailer("context", 0));
      expectReadsOnly(toolCalls(from), 2);
      expectReadsOnly(await claimOnce(golden.context), 2);
      expect(creates(stub.fake.calls)).toHaveLength(3);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 S3: a marker without done (another run seeding) is waited for; when it gains done the run lists again and shows what was seeded, without creating (trailer seeded 0: C-1)",
    async () => {
      resetStub();
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      const claimed = { seededAt: "2026-10-11T04:30:00.000Z", selected: 3, created: 0, failed: 0 };
      writeMemoryFile(SEED_MARKER, `${JSON.stringify(claimed)}\n`);
      // The other run finishes after 1 s: its three intents are in Index, then its marker gets done.
      const other = setTimeout(() => {
        stub.rows.push(row(MEMORY, 0x200), row(DINNER, 0x201), row(SURF, 0x202));
        writeFileSync(join(home, SEED_MARKER), `${JSON.stringify({ ...claimed, created: 3, done: true })}\n`);
      }, 1000);
      try {
        const t0 = Date.now();
        const run = await spawn(draftArgv());
        const took = Date.now() - t0;
        expectDraft(run, golden.three, trailer("none", 3, 0, 0));
        expectReadsOnly(toolCalls(), 2);
        expect(took).toBeGreaterThanOrEqual(1000);
        expect(took).toBeLessThan(4000);
        expect(existsSync(join(home, MARKER))).toBe(false);
      } finally {
        clearTimeout(other);
      }
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 S3: a marker that never gains done is waited for the script's WELCOME_SEED_WAIT_MS (25 s), then the run lists again and gives the context text; no create, the marker untouched",
    async () => {
      resetStub();
      writeUserMd([MEMORY, DINNER, SURF]);
      writeMemoryFile(SEED_MARKER, '{"seededAt":"2026-10-11T04:30:00.000Z","selected":3,"created":0,"failed":0}\n');
      const t0 = Date.now();
      const run = await draft("nothing");
      const took = Date.now() - t0;
      expectDraft(run, golden.context, trailer("context", 0));
      expectReadsOnly(toolCalls(), 2);
      // The wait is WELCOME_SEED_WAIT_MS (it ends sooner only at the budget less the reserve, 45 s, which it never meets).
      expect(took).toBeGreaterThanOrEqual(SEED_WAIT_MS - 500);
      expect(took).toBeLessThan(Math.min(SEED_WAIT_MS, BUDGET_MS - RELIST_RESERVE_MS) + PROCESS_MARGIN_MS);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "a marker that is done, empty or not JSON: no create, no wait, one more list (DATA-416 race 2), the context text, the marker untouched",
    async () => {
      resetStub();
      writeUserMd([MEMORY, DINNER, SURF]);
      for (const body of ['{"seededAt":"2026-10-11T04:30:00.000Z","selected":3,"created":0,"failed":3,"done":true}\n', "", "seeded"]) {
        writeMemoryFile(SEED_MARKER, body);
        const from = stub.fake.calls.length;
        const t0 = Date.now();
        expectDraft(await draft("nothing"), golden.context, trailer("context", 0));
        expect({ body, fast: Date.now() - t0 < 3000 }).toEqual({ body, fast: true });
        expectReadsOnly(toolCalls(from), 2);
        expect(readFileSync(join(home, SEED_MARKER), "utf8")).toBe(body);
      }
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 race 2: a done marker and a first list that predates the other run's creates (1 of 3 active): the run lists again and the welcome shows all three; no create, no wait",
    async () => {
      resetStub([MEMORY]);
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      const done = '{"seededAt":"2026-10-11T04:30:00.000Z","selected":3,"created":3,"failed":0,"done":true}\n';
      writeMemoryFile(SEED_MARKER, done);
      // The other run's last two creates land right after this run's first list was answered.
      stub.afterList = () => stub.rows.push(row(DINNER, 0x201), row(SURF, 0x202));
      const t0 = Date.now();
      const run = await draft("nothing");
      expect(Date.now() - t0).toBeLessThan(3000);
      // Without the second list (W1 before its fix round 2) this was golden.one, the partial listing.
      expectDraft(run, golden.three, trailer("none", 3, 0, 0));
      expectReadsOnly(toolCalls(), 2);
      expect(stub.listed).toEqual([1, 3]);
      expect(readFileSync(join(home, SEED_MARKER), "utf8")).toBe(done);
      expectDraftWrites();
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "DATA-416 race 1: a run whose first list lands between another run's creates (1 of 3 active) looks at the marker first, waits for done and lists all three; three creates in all",
    async () => {
      resetStub();
      // The seeder's first create answers at once, the other two after 3 s: a window in which Index lists one of three.
      stub.createDelays = new Map([[DINNER, 3000], [SURF, 3000]]);
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      const t0 = Date.now();
      const seeding = spawn(draftArgv());
      while (stub.rows.length < 1 && Date.now() - t0 < 10_000) await Bun.sleep(20);
      expect(stub.rows.map((r) => r.summary)).toEqual([MEMORY]);
      const waiting = await spawn(draftArgv());
      const seeder = await seeding;
      const t1 = Date.now();
      // The seeder's first list (none), the waiting run's first list (one of three), then the two second lists (three).
      expect(stub.listed).toEqual([0, 1, 3, 3]);
      expect(creates(toolCalls())).toHaveLength(3);
      expectDraft(seeder, seededWelcome("Mira", [MEMORY, DINNER, SURF]), trailer("none", 3, 3, 0));
      // Before the fix round (the active count looked at before the marker) this was golden.one, the partial listing.
      expectDraft(waiting, listedWelcome("Mira", stub.rows.map((r) => r.summary)), trailer("none", 3, 0, 0));
      expectSeedMarker({ selected: 3, created: 3, failed: 0 }, t0, t1);
      expect(existsSync(join(home, MARKER))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "C-1, W1's documented behaviour: a --draft run that waited on another run's seed says intents_seeded 0 in its trailer while Index holds the three seeded intents (it lists them as today's listing, not the seeded text)",
    async () => {
      resetStub();
      stub.createDelayMs = 1500;
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      const t0 = Date.now();
      const seeding = spawn(draftArgv());
      // The seeder has claimed the marker (it exists, without done) before the waiting run starts.
      while (!existsSync(join(home, SEED_MARKER)) && Date.now() - t0 < 10_000) await Bun.sleep(20);
      expect(readFileSync(join(home, SEED_MARKER), "utf8")).not.toContain('"done"');
      const waiting = await spawn(draftArgv());
      const seeder = await seeding;
      expectDraft(seeder, seededWelcome("Mira", [MEMORY, DINNER, SURF]), trailer("none", 3, 3, 0));
      expect(stub.rows.map((r) => [r.summary, r.status]).sort()).toEqual([MEMORY, DINNER, SURF].map((t) => [t, "active"]).sort());
      expect(JSON.parse(waiting.stderr)).toEqual({ welcome: 1, fallback: "none", intents_listed: 3, intents_seeded: 0, seed_failed: 0 });
      expectDraft(waiting, listedWelcome("Mira", stub.rows.map((r) => r.summary)), trailer("none", 3, 0, 0));
      expect(creates(toolCalls())).toHaveLength(3);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "C-1 in paused mode (reported, not production): a run that waited on another run's paused seed lists no active intent, so it gives the context text, while Index holds the three paused drafts",
    async () => {
      resetStub();
      stub.createDelayMs = 1500;
      writeUserMd([MEMORY, DINNER, SURF]);
      const env = { AV_WELCOME_SEED_MODE: "paused" };
      const t0 = Date.now();
      const seeding = spawn(draftArgv(), { env });
      while (!existsSync(join(home, SEED_MARKER)) && Date.now() - t0 < 10_000) await Bun.sleep(20);
      const waiting = await spawn(draftArgv(), { env });
      const seeder = await seeding;
      expectDraft(seeder, seededWelcome(null, [MEMORY, DINNER, SURF], "paused"), trailer("none", 3, 3, 0));
      expect(stub.rows.map((r) => r.status)).toEqual(["paused", "paused", "paused"]);
      expectDraft(waiting, golden.context, trailer("context", 0, 0, 0));
      expect(creates(toolCalls())).toHaveLength(3);
    },
    CASE_TIMEOUT_MS,
  );

  test(
    "two --draft processes at once on one box: three creates in all; one run seeded them, the other created nothing, waited for done and lists all three (no partial listing)",
    async () => {
      resetStub();
      // Creates that take half a second, so the seed is still in progress when the other run looks at the marker.
      stub.createDelayMs = 500;
      writeProfile("Mira");
      writeUserMd([MEMORY, DINNER, SURF]);
      const t0 = Date.now();
      const both = await Promise.all([spawn(draftArgv()), spawn(draftArgv())]);
      const t1 = Date.now();
      expect(creates(toolCalls())).toHaveLength(3);
      expect(stub.rows.map((r) => r.summary).sort()).toEqual([MEMORY, DINNER, SURF].sort());
      const [seeder, other] = both[0].stderr === trailer("none", 3, 3, 0) ? both : [both[1], both[0]];
      expectDraft(seeder, seededWelcome("Mira", [MEMORY, DINNER, SURF]), trailer("none", 3, 3, 0));
      // The other run looked at the marker before the active count (DATA-416 race 1), waited for done and listed
      // again (race 2): all three, in Index's order, and intents_seeded 0 (C-1). The one window left is W1's
      // documented finding 4 (the marker claimed but not yet written: microseconds), never met here.
      expectDraft(other, listedWelcome("Mira", stub.rows.map((r) => r.summary)), trailer("none", 3, 0, 0));
      expect(stub.listed.slice(-2)).toEqual([3, 3]);
      expectSeedMarker({ selected: 3, created: 3, failed: 0 }, t0, t1);
      expect(existsSync(join(home, MARKER))).toBe(false);
    },
    CASE_TIMEOUT_MS,
  );
});
