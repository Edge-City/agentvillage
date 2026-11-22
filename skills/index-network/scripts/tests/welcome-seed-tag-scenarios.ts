/**
 * F-28 (the seed tag): the welcome runs whose bytes AV_WELCOME_SEED_TAG must
 * leave exactly as main has them while it is off, and change only as the
 * design says while it is on (welcome-seed-tag.test.ts).
 *
 * Each scenario runs welcome.ts's own `main` in process (the module is passed
 * in, so the same scenarios run against any welcome.ts with that API) against
 * a stateful indexMcpFake: `list_intents` answers the current rows, a REST
 * create adds an active row (unless the scenario says otherwise),
 * `pause_intent` pauses one. The clock the script writes is pinned (NOW).
 * What a run leaves is recorded byte for byte:
 *   - `requests`: every request the fake received, in order: URL, HTTP
 *     method, headers, and the body exactly as sent (an MCP call's JSON-RPC
 *     `id`, a process-wide counter, is set to 0; nothing else is touched);
 *   - `files`: every file under `$HERMES_HOME/memory` (path and bytes);
 *   - `stdout` and `stderr` as `main` wrote them.
 *
 * fixtures/welcome-seed-tag-off.json holds these records as main 581056b7
 * printed them, made by running these scenarios against that commit's
 * welcome.ts before the seed tag existed. Made-up lines and ids only.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { type CreateReply, FAKE_API_KEY, type ToolHandler, createdReply, indexMcpFake } from "./index-mcp-fake";

/** The two functions of welcome.ts a scenario drives (its API since U-1a). */
export type WelcomeModule = Pick<typeof import("../welcome"), "main" | "welcomeRun">;

/** The clock every scenario pins (the seed marker's `seededAt`, a refused line's `at`, the reseed marker's name). */
export const NOW = new Date("2026-11-22T06:00:00.000Z");

/** Every variable a scenario reads or sets; each is cleared before and restored after a run. */
export const SCENARIO_VARS = [
  "INDEX_API_KEY",
  "INDEX_MCP_URL",
  "INDEX_API_URL",
  "AV_CONNECTIONS_URL",
  "HERMES_HOME",
  "AV_WELCOME_SEED_MODE",
  "AV_SEED_TRAILER_V2",
  "AV_WELCOME_REASON",
  "AV_WELCOME_SEED_TAG",
] as const;

/** The selected lines, made up. */
export const L1 = "Looking for people building agent memory";
export const L2 = "Hiring a founding engineer who loves Rust";
export const L3 = "Want advice on raising a seed round in India";
export const L4 = "Open to co-hosting a village dinner";
export const LINES = [L1, L2, L3, L4] as const;

/** The id the fake names for its nth create (made up, uuid form). */
export const idFor = (n: number) => `dddddddd-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

type Row = { id: string; summary: string; status: string };

/**
 * How the fake answers the nth create of `description`: `created` (default:
 * a new active row and a 200 naming its id), `id`: a new active row and a 200
 * naming this id instead (malformed, upper-case, repeated), `landedNoId`: a
 * new active row and a 200 naming no id, `noIdNotLanded`: a 200 naming no id
 * and no row, or any other reply as is (no row).
 */
export type CreatePlan = "created" | { id: string } | "landedNoId" | "noIdNotLanded" | CreateReply;

export type Scenario = {
  /** After `--home <tmp>`. */
  argv: string[];
  /** The selected intentions written into USER.md (none: no USER.md). */
  lines?: string[];
  /** Index's rows before the run. */
  rows?: Row[];
  /** No Index key (no call). */
  noKey?: true;
  /** Variables set for the run besides the key and URL. */
  env?: Record<string, string>;
  /** Files written under `$HERMES_HOME` before the run (path: bytes). */
  files?: Record<string, string>;
  create?: (n: number, description: string) => CreatePlan;
};

/** Index refusing a line: the non-2xx `intent_needs_revision` body (fixtures/index-create-direct.json notInSource). */
export const REFUSED: CreateReply = {
  status: 422,
  body: { success: false, code: "intent_needs_revision", error: "The signal needs revision before it can be created.", feedback: "Say who you want to meet.", recovery: [] },
};

const DONE_MARKER = `${JSON.stringify({ seededAt: "2026-11-21T06:00:00.000Z", selected: 1, created: 1, failed: 0, done: true, ids: [idFor(0x900)] })}\n`;
const RESEED_RAN = `${JSON.stringify({ reseededAt: "2026-11-21T06:00:00.000Z", selected: 1, created: 1, failed: 0, codes: [] })}\n`;

/**
 * The scenarios: the first seed (every outcome a create can have), the paused
 * seed, the default mode, the extra trailer keys, the runs that create
 * nothing, and `--reseed` (real, refused, dry run, already ran).
 */
export const SCENARIOS: Record<string, Scenario> = {
  seedThree: { argv: ["--draft"], lines: [...LINES] },
  seedOneDefaultMode: { argv: [], lines: [L1] },
  seedPaused: { argv: ["--draft"], lines: [L1, L2], env: { AV_WELCOME_SEED_MODE: "paused" } },
  refusedLine: { argv: ["--draft"], lines: [L1, L2, L3], create: (n) => (n === 2 ? REFUSED : "created") },
  allRefused: { argv: ["--draft"], lines: [L1, L2], create: () => REFUSED },
  noIdLanded: { argv: ["--draft"], lines: [L1, L2], create: (n) => (n === 1 ? "landedNoId" : "created") },
  noIdNotLanded: { argv: ["--draft"], lines: [L1], create: () => "noIdNotLanded" },
  failedCreate: { argv: ["--draft"], lines: [L1, L2], create: (n) => (n === 1 ? { status: 500, body: { error: "Failed to create intent" } } : "created") },
  malformedIds: {
    argv: ["--draft"],
    lines: [L1, L2, L3],
    // Not an id Index issues (welcome.ts keeps none: index-mcp.ts INTENT_ID), too long, and an upper-case uuid (kept as named).
    create: (n) => ({ id: ["not an id!", "a".repeat(33), "EEEEEEEE-0000-4000-8000-00000000000A"][n - 1]! }),
  },
  duplicateIds: { argv: ["--draft"], lines: [L1, L2, L3], create: (n) => ({ id: n === 3 ? idFor(0x300) : "ffffffff-0000-4000-8000-000000000001" }) },
  caseDuplicateIds: { argv: ["--draft"], lines: [L1, L2], create: (n) => ({ id: n === 1 ? "ABCDEF0123456789" : "abcdef0123456789" }) },
  shortHexId: { argv: ["--draft"], lines: [L1], create: () => ({ id: "abcd" }) },
  v2AndReason: {
    argv: ["--draft"],
    lines: [L1, L2],
    env: { AV_SEED_TRAILER_V2: "1", AV_WELCOME_REASON: "1" },
    create: (n) => (n === 2 ? { status: 500, body: { error: "Failed to create intent" } } : "created"),
  },
  listed: { argv: ["--draft"], lines: [L1], rows: [{ id: idFor(0x800), summary: "Already an intent of mine", status: "active" }] },
  unreachableNoKey: { argv: ["--draft"], lines: [L1], noKey: true, env: { AV_WELCOME_REASON: "1" } },
  markerExists: { argv: ["--draft"], lines: [L1], files: { "memory/welcome-seed.json": DONE_MARKER } },
  reseed: { argv: ["--reseed"], lines: [L1, L2, L3] },
  reseedRefused: { argv: ["--reseed"], lines: [L1, L2], create: (n) => (n === 1 ? REFUSED : "created") },
  reseedDryRun: { argv: ["--reseed", "--dry-run"], lines: [L1, L2] },
  reseedAlreadyRan: { argv: ["--reseed"], lines: [L1], files: { "memory/welcome-reseed-2026-11-21T06-00-00-000Z.json": RESEED_RAN } },
};

export type Request = { url: string; method: string; headers: Record<string, string>; body: string };
export type Record_ = { stdout: string; stderr: string; requests: Request[]; files: Record<string, string> };

function profile(lines: string[]): string {
  return ["# Participant profile", "Name: Test Resident", "", "## Selected intentions", ...lines.map((l) => `- [meet] ${l}`), "", "## Follow-up preferences", ""].join("\n");
}

function filesUnder(root: string, dir: string, out: Record<string, string>): void {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) filesUnder(root, path, out);
    else out[relative(root, path)] = readFileSync(path, "utf8");
  }
}

/**
 * Run `scenario` against `W` with `vars` set too (the switch under test, in
 * the environment) and `dotenv` written to `$HERMES_HOME/.env` when given.
 * Returns what the run left. Restores the environment; removes its home.
 */
export async function runScenario(W: WelcomeModule, scenario: Scenario, vars: Record<string, string> = {}, dotenv?: string): Promise<Record_> {
  const saved: Record<string, string | undefined> = {};
  for (const key of SCENARIO_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const home = mkdtempSync(join(tmpdir(), "av-welcome-seed-tag-"));
  try {
    if (scenario.lines) writeFileSync(join(home, "USER.md"), profile(scenario.lines));
    for (const [path, body] of Object.entries(scenario.files ?? {})) {
      mkdirSync(dirname(join(home, path)), { recursive: true });
      writeFileSync(join(home, path), body);
    }
    if (dotenv !== undefined) writeFileSync(join(home, ".env"), dotenv);

    const rows: Row[] = (scenario.rows ?? []).map((r) => ({ ...r }));
    const tools: Record<string, ToolHandler> = {
      list_intents: () => `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, pagination: { limit: 20, offset: 0, count: rows.length } }, null, 2)}`,
      pause_intent: (args) => {
        const row = rows.find((r) => r.id === String(args.intentId));
        if (row) row.status = "paused";
        return `${JSON.stringify({ success: true, data: { intentId: args.intentId, status: "paused", changed: true } })}`;
      },
    };
    const fake = indexMcpFake({
      tools,
      create: (body, n) => {
        const description = String(body.description);
        const plan = scenario.create?.(n, description) ?? "created";
        const land = (id: string) => rows.push({ id, summary: description, status: "active" });
        if (plan === "created") {
          land(idFor(0x100 + n));
          return createdReply(idFor(0x100 + n));
        }
        if (plan === "landedNoId") {
          land(idFor(0x700 + n));
          return { status: 200, body: { success: true } };
        }
        if (plan === "noIdNotLanded") return { status: 200, body: { success: true } };
        if ("id" in plan) {
          land(plan.id);
          return createdReply(plan.id);
        }
        return plan;
      },
    });
    const requests: Request[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((value, key) => {
        headers[key] = value;
      });
      const raw = String(init?.body ?? "");
      // An MCP call's JSON-RPC id is a process-wide counter: 0 here, the rest as sent.
      const body = raw.startsWith('{"jsonrpc":"2.0","id":') ? raw.replace(/^\{"jsonrpc":"2\.0","id":\d+,/, '{"jsonrpc":"2.0","id":0,') : raw;
      requests.push({ url: String(input), method: String(init?.method ?? "GET"), headers, body });
      return fake.fetch(input, init);
    }) as typeof globalThis.fetch;

    process.env.INDEX_API_KEY = scenario.noKey ? "" : FAKE_API_KEY;
    process.env.INDEX_MCP_URL = fake.url;
    for (const [k, v] of Object.entries({ ...scenario.env, ...vars })) process.env[k] = v;

    let stdout = "";
    let stderr = "";
    await W.main(["--home", home, ...scenario.argv], { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s) }, (argv) =>
      W.welcomeRun(argv, { fetch, timeoutMs: 200, now: NOW }),
    );
    const files: Record<string, string> = {};
    filesUnder(home, join(home, "memory"), files);
    return { stdout, stderr, requests, files };
  } finally {
    rmSync(home, { recursive: true, force: true });
    for (const key of SCENARIO_VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}
