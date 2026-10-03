/**
 * The card cooldown on every delivery path, end to end against the Index fake:
 * the morning brief (prepare, then send), the opportunity drop, the evening
 * card and the afternoon follow-up's "waiting on you" list.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";
import { buildDailyBriefContext, type DailyBriefContext } from "../build-daily-brief-context";
import { OPPORTUNITY_DELIVERY_KEY, type DeliveryLog } from "../delivery-state";
import { dropOpportunity } from "../drop-opportunity";
import { sendDailyBrief } from "../send-daily-brief";
import { main as followUpMain } from "../summarize-negotiations";
import { FAKE_MCP_URL, type ToolHandler, indexMcpFake, listOpportunitiesText } from "./index-mcp-fake";

const DAY0 = "2026-10-12";
const ENV_KEYS = ["INDEX_API_KEY", "INDEX_MCP_URL", "EDGEOS_API_KEY", "EDGE_AGENT_CONTROL_PLANE_URL", "ADMIN_TOKEN"];

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function oppId(n: number): string {
  return `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const MAYA = oppId(1);
const JON = oppId(2);

function row(name: string, n: number, extra: Record<string, unknown> = {}) {
  const userId = `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id: oppId(n),
    url: `https://index.network/o/${oppId(n)}`,
    status: "pending",
    viewerRole: "party",
    headline: `${name} headline`,
    summary: `${name} summary`,
    peer: { name, userId, url: `https://index.network/u/${userId}` },
    ...extra,
  };
}

const list = (...rows: unknown[]): ToolHandler => () => listOpportunitiesText(rows);
const failing: ToolHandler = () => ({ result: { content: [{ type: "text", text: "private detail" }], isError: true } });

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalArgv = process.argv;

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.argv = originalArgv;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function newStateFile(state?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "delivery-cooldown-"));
  dirs.push(dir);
  const file = join(dir, "state.json");
  if (state) writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

function readState(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

function readLog(file: string): DeliveryLog | undefined {
  return readState(file)[OPPORTUNITY_DELIVERY_KEY] as DeliveryLog | undefined;
}

function fileText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Point the scripts at the fake Index (and nothing else) while `run` runs. */
async function withIndex<T>(listOpportunities: ToolHandler, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.EDGEOS_API_KEY;
  delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
  delete process.env.ADMIN_TOKEN;
  process.env.INDEX_API_KEY = "test-key";
  process.env.INDEX_MCP_URL = FAKE_MCP_URL;
  const fake = indexMcpFake({ tools: { list_opportunities: listOpportunities } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("open-meteo")) return new Response("unavailable", { status: 503 });
    return fake.fetch(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function idFromUrl(url: unknown): string {
  return typeof url === "string" ? url.split("/o/")[1] ?? "" : "";
}

function briefIds(context: DailyBriefContext): string[] {
  return context.opportunities.map((opp) => opp.opportunityId ?? "");
}

async function prepare(date: string, file: string, handler: ToolHandler): Promise<DailyBriefContext> {
  return withIndex(handler, () => buildDailyBriefContext({ date, stateFile: file, userFiles: [] }));
}

/** Prepare the brief, stage every card it offers (as the prompt's markers would), and send it. */
async function briefAndSend(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const context = await prepare(date, file, handler);
  const ids = briefIds(context);
  const state = readState(file);
  state.prepared = { date, taskId: "t_digest", opportunityIds: ids };
  writeFileSync(file, JSON.stringify(state, null, 2));
  const result = await sendDailyBrief({
    date,
    stateFile: file,
    outgoingFile: join(file, "..", "outgoing.md"),
    hermes: (args) => {
      if (args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body: "brief" } });
      if (args[1] === "complete") return "completed";
      throw new Error(`unexpected hermes call: ${args.join(" ")}`);
    },
  });
  if ("silent" in result) throw new Error(`send was silent: ${result.reason}`);
  return ids;
}

async function drop(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const result = await withIndex(handler, () => dropOpportunity({ date, stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL }));
  return "silent" in result ? [] : [result.opportunity.opportunityId ?? ""];
}

async function evening(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const result = await withIndex(handler, () => askQuestions({ date, stateFile: file, apiKey: "test-key" }));
  return "name" in result ? [idFromUrl(result.opportunityUrl)] : [];
}

async function followUpRaw(date: string, file: string, handler: ToolHandler): Promise<string> {
  process.argv = [...originalArgv.slice(0, 2), "--state-file", file, "--date", date];
  let out = "";
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await withIndex(handler, () => followUpMain());
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
  }
  return out;
}

async function followUp(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const out = await followUpRaw(date, file, handler);
  if (out === "[SILENT]") return [];
  return JSON.parse(out).needsAttention.map((card: { opportunityUrl?: string }) => idFromUrl(card.opportunityUrl));
}

type Path = (date: string, file: string, handler: ToolHandler) => Promise<string[]>;
const PATHS: Array<[string, Path]> = [
  ["morning brief (prepare + send)", briefAndSend],
  ["opportunity drop", drop],
  ["evening card", evening],
  ["follow-up waiting-on-you list", followUp],
];

/** The brief reads Index at prepare; its send makes no Index call. */
async function prepareIds(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  return briefIds(await prepare(date, file, handler));
}

describe.each(PATHS)("%s", (_label, deliver) => {
  const read = deliver === briefAndSend ? prepareIds : deliver;

  test("shown day 0; not days 1 and 2; again day 3; third time day 6; never a fourth", async () => {
    const file = newStateFile();
    const maya = list(row("Maya", 1));
    const shownOn: number[] = [];
    for (const day of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 20, 40]) {
      if ((await deliver(addDays(DAY0, day), file, maya)).includes(MAYA)) shownOn.push(day);
    }
    expect(shownOn).toEqual([0, 3, 6]);
    expect(readLog(file)?.[MAYA]).toEqual({ firstShown: DAY0, lastShown: addDays(DAY0, 6), count: 3 });
  });

  test("a card that leaves the pending list is forgotten; the same id coming back is new", async () => {
    const file = newStateFile();
    expect(await deliver(DAY0, file, list(row("Maya", 1)))).toEqual([MAYA]);
    expect(await deliver(addDays(DAY0, 1), file, list(row("Jon", 2)))).toEqual([JON]);
    expect(Object.keys(readLog(file) ?? {})).toEqual([JON]);
    expect(await deliver(addDays(DAY0, 2), file, list(row("Maya", 1), row("Jon", 2)))).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]).toEqual({ firstShown: addDays(DAY0, 2), lastShown: addDays(DAY0, 2), count: 1 });
  });

  test("a failed Index read changes nothing and does not reset or advance the cooldown", async () => {
    const shown = { firstShown: DAY0, lastShown: DAY0, count: 1 };
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown, [JON]: shown }, dreaming: { lastRunDate: DAY0 } });
    const before = fileText(file);
    for (const day of [1, 3]) {
      expect(await read(addDays(DAY0, day), file, failing).catch(() => [])).toEqual([]);
      expect(fileText(file)).toBe(before);
    }
    expect(await deliver(addDays(DAY0, 3), file, list(row("Maya", 1)))).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]?.count).toBe(2);
  });

  test("a card Index marks negotiating: true is never offered or recorded", async () => {
    const file = newStateFile();
    const rows = list(row("Maya", 1, { negotiating: true }), row("Jon", 2));
    expect(await deliver(DAY0, file, rows)).toEqual([JON]);
    for (const day of [1, 3, 6, 9]) expect(await deliver(addDays(DAY0, day), file, rows)).not.toContain(MAYA);
    expect(Object.keys(readLog(file) ?? {})).toEqual([JON]);
  });
});

describe("cross-path", () => {
  test("a card the brief sent waits out its cooldown on every other path", async () => {
    const file = newStateFile();
    const maya = list(row("Maya", 1));
    expect(await briefAndSend(DAY0, file, maya)).toEqual([MAYA]);
    expect(await drop(DAY0, file, maya)).toEqual([]);
    expect(await followUp(addDays(DAY0, 1), file, maya)).toEqual([]);
    expect(await drop(addDays(DAY0, 1), file, maya)).toEqual([]);
    expect(await evening(addDays(DAY0, 2), file, maya)).toEqual([]);
    expect(await drop(addDays(DAY0, 3), file, maya)).toEqual([MAYA]);
    expect(await evening(addDays(DAY0, 3), file, maya)).toEqual([]);
    expect(readLog(file)?.[MAYA]).toEqual({ firstShown: DAY0, lastShown: addDays(DAY0, 3), count: 2 });
  });

  test("the follow-up's listing counts as a showing for the drops and the evening card", async () => {
    const file = newStateFile();
    const maya = list(row("Maya", 1));
    expect(await followUp(DAY0, file, maya)).toEqual([MAYA]);
    expect(await evening(DAY0, file, maya)).toEqual([]);
    expect(await drop(addDays(DAY0, 2), file, maya)).toEqual([]);
  });

  test("only the send records the brief's cards: a prepare alone shows nothing", async () => {
    const file = newStateFile({ dreaming: { lastRunDate: addDays(DAY0, -1) } });
    const maya = list(row("Maya", 1));
    expect(briefIds(await prepare(DAY0, file, maya))).toEqual([MAYA]);
    expect(readLog(file)).toBeUndefined();
    expect(briefIds(await prepare(addDays(DAY0, 1), file, maya))).toEqual([MAYA]);
    expect(await briefAndSend(addDays(DAY0, 1), file, maya)).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]?.count).toBe(1);
  });

  test("a same-day retry of the send counts one showing", async () => {
    const file = newStateFile();
    await briefAndSend(DAY0, file, list(row("Maya", 1)));
    await briefAndSend(DAY0, file, list(row("Maya", 1), row("Jon", 2)));
    expect(readLog(file)?.[MAYA]?.count).toBe(1);
  });
});

describe("ordering", () => {
  const log = {
    [oppId(1)]: { firstShown: addDays(DAY0, -6), lastShown: addDays(DAY0, -6), count: 1 },
    [oppId(3)]: { firstShown: addDays(DAY0, -9), lastShown: addDays(DAY0, -4), count: 2 },
    [oppId(5)]: { firstShown: addDays(DAY0, -1), lastShown: addDays(DAY0, -1), count: 1 },
  };
  // Index's order: C(3), A(1), B(2), E(5, cooling), D(4)
  const rows = list(row("C", 3), row("A", 1), row("B", 2), row("E", 5), row("D", 4));

  test("brief: never shown first in Index's order, then the oldest showing; still capped at three", async () => {
    const context = await prepare(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows);
    expect(context.connectionOpportunities.map((opp) => opp.name)).toEqual(["B", "D", "A"]);
    expect(context.connectionsStillWaiting).toBe(1);
  });

  test("drop and evening card pick the first never-shown card", async () => {
    expect(await drop(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows)).toEqual([oppId(2)]);
    expect(await evening(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows)).toEqual([oppId(2)]);
  });

  test("with nothing new, the re-showing whose last showing is oldest goes first", async () => {
    const onlyShown = list(row("C", 3), row("A", 1));
    expect(await drop(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), onlyShown)).toEqual([oppId(1)]);
    expect(await evening(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), onlyShown)).toEqual([oppId(1)]);
    expect(await followUp(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), onlyShown)).toEqual([oppId(1), oppId(3)]);
  });
});

describe("pruning on reads", () => {
  const shown = (date: string, count = 1) => ({ firstShown: date, lastShown: date, count });

  test("the brief's prepare drops entries for cards no longer pending, and touches nothing else", async () => {
    const file = newStateFile({
      [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0), [JON]: shown(DAY0) },
      dreaming: { lastRunDate: addDays(DAY0, 1) },
      memorySignals: { lastRun: "x" },
    });
    await prepare(addDays(DAY0, 1), file, list(row("Jon", 2)));
    expect(readState(file)).toEqual({
      [OPPORTUNITY_DELIVERY_KEY]: { [JON]: shown(DAY0) },
      dreaming: { lastRunDate: addDays(DAY0, 1) },
      memorySignals: { lastRun: "x" },
    });
  });

  test("a silent run still forgets finished cards", async () => {
    for (const path of [drop, evening, followUp]) {
      const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0), [JON]: shown(DAY0) }, other: 1 });
      expect(await path(addDays(DAY0, 1), file, list(row("Jon", 2)))).toEqual([]);
      expect(readState(file)).toEqual({ [OPPORTUNITY_DELIVERY_KEY]: { [JON]: shown(DAY0) }, other: 1 });
    }
  });

  test("a full page (20 rows) may be cut short, so absent cards are kept", async () => {
    const rows = Array.from({ length: 20 }, (_, i) => row(`P${i}`, 100 + i));
    for (const path of [drop, evening]) {
      const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
      expect(await path(addDays(DAY0, 1), file, list(...rows))).toEqual([oppId(100)]);
      expect(readLog(file)?.[MAYA]).toEqual(shown(DAY0, 3));
    }
  });

  test("pagination reporting more rows than came back keeps absent cards", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
    const text = `Waiting on you:\n\n${JSON.stringify({ success: true, opportunities: [row("Jon", 2)], pagination: { page: 1, limit: 20, total: 25 } })}`;
    expect(await drop(addDays(DAY0, 1), file, () => text)).toEqual([JON]);
    expect(readLog(file)?.[MAYA]).toEqual(shown(DAY0, 3));
  });

  test("an entry 60 days old is forgotten, so its card is new again", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
    expect(await drop(addDays(DAY0, 59), file, list(row("Maya", 1)))).toEqual([]);
    expect(await drop(addDays(DAY0, 60), file, list(row("Maya", 1)))).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]?.count).toBe(1);
  });
});

describe("state files", () => {
  const OLD = {
    deliveredToday: { date: DAY0, ids: [MAYA] },
    questionDelivery: { "q-1": DAY0 },
    pendingDeliveryConfirms: [MAYA],
    dreaming: { lastRunDate: DAY0 },
    memorySignals: { lastRunDate: DAY0, cursor: 4 },
    negotiationSummary: { reportedCompletedIds: ["older"] },
    prepared: { date: DAY0, taskId: "t_old", opportunityIds: [MAYA] },
  };
  const both = list(row("Maya", 1), row("Jon", 2));

  test("a file from before the log: today's card is not sent again on any path, and siblings survive", async () => {
    for (const path of [drop, evening, followUp]) {
      const file = newStateFile(OLD);
      expect(await path(DAY0, file, both)).toEqual([JON]);
      const state = readState(file);
      for (const [key, value] of Object.entries(OLD)) {
        if (key !== "deliveredToday") expect(state[key]).toEqual(value);
      }
      expect(readLog(file)?.[MAYA]).toEqual({ firstShown: DAY0, lastShown: DAY0, count: 1 });
    }
    const context = await prepare(DAY0, newStateFile(OLD), both);
    expect(briefIds(context)).toEqual([JON]);
  });

  test("a file from before the log: the card the old version sent waits out its cooldown", async () => {
    const file = newStateFile(OLD);
    expect(await drop(addDays(DAY0, 1), file, list(row("Maya", 1)))).toEqual([]);
    expect(await drop(addDays(DAY0, 3), file, list(row("Maya", 1)))).toEqual([MAYA]);
    expect(readState(file).pendingDeliveryConfirms).toEqual([MAYA]);
  });

  test("the send reads an old file without error and keeps every sibling key", async () => {
    const file = newStateFile({ ...OLD, prepared: { date: DAY0, taskId: "t_digest", opportunityIds: [JON] } });
    const result = await sendDailyBrief({
      date: DAY0,
      stateFile: file,
      outgoingFile: join(file, "..", "outgoing.md"),
      hermes: (args) => (args[1] === "show" ? JSON.stringify({ task: { status: "ready", body: "b" } }) : "ok"),
    });
    expect("silent" in result).toBe(false);
    const state = readState(file);
    expect(state.deliveredToday).toEqual({ date: DAY0, ids: [MAYA, JON] });
    expect(state.pendingDeliveryConfirms).toEqual([MAYA]);
    expect(state.memorySignals).toEqual(OLD.memorySignals);
    expect(state.negotiationSummary).toEqual(OLD.negotiationSummary);
    expect(state.dreaming).toEqual(OLD.dreaming);
    expect(readLog(file)).toEqual({
      [MAYA]: { firstShown: DAY0, lastShown: DAY0, count: 1 },
      [JON]: { firstShown: DAY0, lastShown: DAY0, count: 1 },
    });
  });

  test("a malformed map resets to empty without touching sibling keys", async () => {
    for (const bad of ["garbage", [MAYA], null, { [MAYA]: { count: "x" } }]) {
      for (const path of [drop, evening, followUp, briefAndSend]) {
        const siblings = { questionDelivery: { "q-1": DAY0 }, memorySignals: { cursor: 1 }, deliveredToday: { date: addDays(DAY0, -1), ids: [MAYA] } };
        const file = newStateFile({ ...siblings, [OPPORTUNITY_DELIVERY_KEY]: bad });
        expect(await path(DAY0, file, list(row("Maya", 1)))).toEqual([MAYA]);
        const state = readState(file);
        expect(state.questionDelivery).toEqual(siblings.questionDelivery);
        expect(state.memorySignals).toEqual(siblings.memorySignals);
        expect(readLog(file)).toEqual({ [MAYA]: { firstShown: DAY0, lastShown: DAY0, count: 1 } });
      }
    }
  });
});

describe("the brief when everything pending was already shown", () => {
  const shown = (date: string, count = 1) => ({ firstShown: date, lastShown: date, count });

  test("no cards, a fresh list, and the count of conversations still waiting", async () => {
    const file = newStateFile({
      [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -1)), [oppId(3)]: shown(addDays(DAY0, -5), 3) },
    });
    const context = await prepare(
      DAY0,
      file,
      list(row("Maya", 1), row("Ana", 3), row("Neg", 4, { negotiating: true }), row("Jon", 2, { viewerRole: "agent" })),
    );
    expect(context.diagnostics.opportunitySource).toBe("mcp");
    expect(context.diagnostics.dreamingFresh).toBe(true);
    expect(context.connectionOpportunities).toEqual([]);
    expect(context.connectionsStillWaiting).toBe(2);
    expect(context.communityOpportunities.map((opp) => opp.name)).toEqual(["Jon"]);
  });

  test("nothing pending at all: zero still waiting", async () => {
    const context = await prepare(DAY0, newStateFile(), list());
    expect(context.connectionOpportunities).toEqual([]);
    expect(context.connectionsStillWaiting).toBe(0);
  });

  test("a failed read: zero still waiting, and the brief knows the list did not succeed", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -1)) } });
    const context = await prepare(DAY0, file, failing);
    expect(context.diagnostics.dreamingFresh).toBe(false);
    expect(context.connectionsStillWaiting).toBe(0);
  });

  test("the drop and the evening card stay silent; the Nov 1 closeout still comes", async () => {
    const lastDay = "2026-11-01";
    const cooling = { [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(lastDay, -1)) } };
    expect(await withIndex(list(row("Maya", 1)), () => dropOpportunity({ date: DAY0, stateFile: newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } }), apiKey: "k", mcpUrl: FAKE_MCP_URL }))).toEqual({
      silent: true,
      reason: "nothing-new",
    });
    expect(await withIndex(list(row("Maya", 1)), () => askQuestions({ date: DAY0, stateFile: newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } }), apiKey: "k" }))).toEqual({
      silent: true,
      reason: "nothing-waiting",
    });
    const file = newStateFile(cooling);
    const closeout = await withIndex(list(row("Maya", 1)), () => askQuestions({ date: lastDay, stateFile: file, apiKey: "k" }));
    expect(closeout).toEqual({
      prompt: "Quick closeout check: did AgentVillage help you meet, message, or better understand anyone this week? Reply with one sentence.",
    });
    expect(readLog(file)).toEqual(cooling[OPPORTUNITY_DELIVERY_KEY]);
  });
});

describe("the follow-up", () => {
  test("a pending card marked negotiating is listed with the agents talking, never as waiting on you", async () => {
    const file = newStateFile();
    const out = await followUpRaw(DAY0, file, list(row("Maya", 1, { negotiating: true }), row("Jon", 2), row("Ana", 3, { status: "negotiating" })));
    const parsed = JSON.parse(out);
    expect(parsed.needsAttention.map((c: { name: string }) => c.name)).toEqual(["Jon"]);
    expect(parsed.waiting.map((c: { name: string }) => c.name)).toEqual(["Maya", "Ana"]);
    expect(Object.keys(parsed.waiting[0]).sort()).toEqual(["headline", "name", "opportunityUrl", "summary", "userUrl"]);
  });

  test("only negotiating cards pending: silent, as when only agents are talking", async () => {
    expect(await followUpRaw(DAY0, newStateFile(), list(row("Maya", 1, { negotiating: true })))).toBe("[SILENT]");
  });

  test("an accepted card is still reported while every pending card cools down", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: { firstShown: DAY0, lastShown: DAY0, count: 1 } } });
    const parsed = JSON.parse(await followUpRaw(addDays(DAY0, 1), file, list(row("Maya", 1), row("Ana", 3, { status: "accepted" }))));
    expect(parsed.needsAttention).toEqual([]);
    expect(parsed.newlyResolved.map((c: { name: string }) => c.name)).toEqual(["Ana"]);
    expect(readLog(file)?.[MAYA]?.count).toBe(1);
  });
});
