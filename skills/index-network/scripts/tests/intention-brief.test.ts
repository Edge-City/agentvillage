/**
 * DATA-222: the morning brief's reminder (a count) of inferred intentions
 * awaiting approval and its receipt of those published on the resident's
 * behalf.
 *
 * The plugin's reader is faked (a function returning its JSON) except in the
 * last tests, which run the real reader from plugins/av-events with Python.
 * Index is the in-process fake; nothing reaches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildDailyBriefContext, type DailyBriefContext } from "../build-daily-brief-context";
import {
  READER_VERSION,
  RECEIPT_KEEP_DAYS,
  RECEIPT_LIST_LIMIT,
  RECEIPT_STATE_KEY,
  RECEIPT_WINDOW_DAYS,
  contextText,
  extractDigestReceiptIds,
  intentTextFrom,
  parseReaderAnswer,
  readIntentionBrief,
  recordReceipts,
  runPluginReader,
  settleReceiptMarkers,
  stripDigestReceiptMarkers,
  type ReaderRunner,
} from "../intention-brief";
import { sendDailyBrief, stripStrayDigestMarkers } from "../send-daily-brief";
import { stageDailyBrief } from "../stage-daily-brief";
import { sanitizeDigestUrls } from "../validate-digest-urls";
import { FAKE_MCP_URL, indexMcpFake, listOpportunitiesText, type ToolHandler } from "./index-mcp-fake";
import { pinDeliveryClock } from "./pin-clock";

pinDeliveryClock();

const DAY = "2026-10-12";
const NEXT = "2026-10-13";
const SWITCH_KEYS = ["AV_RECORD_INTENTION", "AV_APPROVAL_ENABLED", "AV_APPROVAL_URL"];
const ENV_KEYS = [...SWITCH_KEYS, "HERMES_HOME", "INDEX_API_KEY", "INDEX_MCP_URL", "EDGEOS_API_KEY", "EDGE_AGENT_CONTROL_PLANE_URL", "ADMIN_TOKEN", "HERMES_PYTHON"];
const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const dirs: string[] = [];
const PLUGIN_DIR = resolve(import.meta.dir, "../../../../plugins/av-events");

const P1 = "01900000-0000-7000-8000-000000000001";
const P2 = "01900000-0000-7000-8000-000000000002";
const INDEX_P1 = "aaaaaaaa-0000-4000-8000-000000000001";
const INDEX_P2 = "aaaaaaaa-0000-4000-8000-000000000002";

let home = "";

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "intention-brief-"));
  dirs.push(dir);
  return dir;
}

/** Switches on through the tenant's .env, as the cron's terminal would see them. */
function switchesOn(dir = home): void {
  writeFileSync(join(dir, ".env"), "AV_RECORD_INTENTION=1\nAV_APPROVAL_ENABLED=1\nAV_APPROVAL_URL=http://127.0.0.1:4680\n");
}

beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  home = tempDir();
  process.env.HERMES_HOME = home;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface FakeAnswer {
  status?: string;
  reason?: string | null;
  heldCount?: number;
  published?: unknown[];
  publishedCount?: number;
}

function answer(a: FakeAnswer = {}): string {
  const published = a.published ?? [];
  return JSON.stringify({
    v: READER_VERSION,
    status: a.status ?? "ok",
    reason: a.reason ?? null,
    heldCount: a.heldCount ?? 0,
    published,
    publishedCount: a.publishedCount ?? published.length,
    skipped: 0,
  });
}

function published(id: string, indexIntentId: string, approvedBy: "individual" | "rule" | null = "rule", publishedAt = "2026-10-11T21:00:00Z") {
  return { id, indexIntentId, publishedAt, approvedBy };
}

/** A reader that records each call and the receipted ids it was handed. */
function fakeReader(raw: string | ((receipted: string[]) => string)): ReaderRunner & { calls: number; handed: string[][] } {
  const run = ((_home: string, receipted: string[]) => {
    run.calls++;
    run.handed.push(receipted);
    return typeof raw === "string" ? raw : raw(receipted);
  }) as ReaderRunner & { calls: number; handed: string[][] };
  run.calls = 0;
  run.handed = [];
  return run;
}

/** `get_intent` answering from a table of Index id -> intent row. */
function getIntent(rows: Record<string, Record<string, unknown>>, seen: unknown[] = []): ToolHandler {
  return (args) => {
    seen.push(args);
    const row = rows[String(args.intentId)];
    if (!row) return { result: { content: [{ type: "text", text: "not found" }], isError: true } };
    return `Intent:\n\n${JSON.stringify({ success: true, intent: { id: args.intentId, status: "active", ...row } })}`;
  };
}

/** buildDailyBriefContext against the fake Index (and nothing else), the way the prepare pass runs it. */
async function prepare(stateFile: string, reader: ReaderRunner, tools: Record<string, ToolHandler> = {}, date = DAY) {
  process.env.INDEX_API_KEY = "test-key";
  process.env.INDEX_MCP_URL = FAKE_MCP_URL;
  const fake = indexMcpFake({ tools: { list_opportunities: () => listOpportunitiesText([]), ...tools } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("open-meteo")) return new Response("unavailable", { status: 503 });
    return fake.fetch(input, init);
  }) as typeof fetch;
  try {
    const context = await buildDailyBriefContext({ date, stateFile, userFiles: [], intentions: { reader, hermesHome: home } });
    return { context, calls: fake.calls.map((call) => call.name) };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function stateFileWith(state: Record<string, unknown>): string {
  const file = join(home, "state.json");
  writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

function readState(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8"));
}

interface SendOptions {
  status?: string;
  date?: string;
  /** Replace the Kanban body before the send (an operator's edit). */
  edit?: (staged: string) => string;
  complete?: () => string;
}

/** Stage `body` against `context`, then run the send. */
async function stageAndSend(file: string, context: DailyBriefContext, body: string, options: SendOptions = {}) {
  const date = options.date ?? DAY;
  const contextOut = join(home, "context.json");
  writeFileSync(contextOut, JSON.stringify(context));
  let staged = "";
  const stage = await stageDailyBrief({
    date,
    stateFile: file,
    contextOut,
    body,
    hermes: (args) => {
      if (args[1] === "create") {
        staged = args[4];
        return JSON.stringify({ task: { id: "t_digest" } });
      }
      if (args[1] === "promote") return "promoted";
      if (args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready" } });
      throw new Error(`unexpected hermes call: ${args.join(" ")}`);
    },
  });
  const sendBody = options.edit ? options.edit(staged) : staged;
  const send = await sendDailyBrief({
    date,
    stateFile: file,
    outgoingFile: join(home, "outgoing.md"),
    hermes: (args) => {
      if (args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: options.status ?? "ready", body: sendBody } });
      if (args[1] === "complete") return options.complete ? options.complete() : "completed";
      throw new Error(`unexpected hermes call: ${args.join(" ")}`);
    },
  });
  return { stage, send, staged };
}

function receiptLine(id: string, text: string): string {
  return `<!-- digest-receipt:id=${id} -->- ${text} (under your setting)`;
}

describe("inert when off or empty", () => {
  test("AV_RECORD_INTENTION off: the reader never runs and both parts are empty", async () => {
    const reader = fakeReader(answer({ heldCount: 2, published: [published(P1, INDEX_P1)] }));
    writeFileSync(join(home, ".env"), "AV_RECORD_INTENTION=0\nAV_APPROVAL_ENABLED=1\nAV_APPROVAL_URL=http://127.0.0.1:4680\n");
    const brief = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(brief).toEqual({ heldForApprovalCount: 0, sharedOnYourBehalf: [], sharedOnYourBehalfMore: 0, source: "off" });
    expect(reader.calls).toBe(0);
  });

  test("the approval path off: the reader never runs", async () => {
    const reader = fakeReader(answer({ heldCount: 2 }));
    writeFileSync(join(home, ".env"), "AV_RECORD_INTENTION=1\nAV_APPROVAL_ENABLED=1\n");
    expect((await readIntentionBrief({ state: {}, hermesHome: home, reader })).source).toBe("off");
    process.env.AV_APPROVAL_URL = "http://127.0.0.1:4680";
    process.env.AV_APPROVAL_ENABLED = ""; // blank in the process environment wins over the dotfile
    expect((await readIntentionBrief({ state: {}, hermesHome: home, reader })).source).toBe("off");
    expect(reader.calls).toBe(0);
  });

  test("the reader answering `off` gives empty parts, whatever else its answer holds", async () => {
    switchesOn();
    const reader = fakeReader(answer({ status: "off", reason: "approval_off", heldCount: 4, published: [published(P1, INDEX_P1)] }));
    const brief = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(brief).toEqual({ heldForApprovalCount: 0, sharedOnYourBehalf: [], sharedOnYourBehalfMore: 0, source: "off" });
    expect(reader.calls).toBe(1);
  });

  test("off, the brief context has the empty parts and Index is not asked about intentions", async () => {
    const file = stateFileWith({ deliveredToday: { date: DAY, ids: [] } });
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1)] }));
    const { context, calls } = await prepare(file, reader, { get_intent: getIntent({}) });
    expect(context.heldForApprovalCount).toBe(0);
    expect(context.sharedOnYourBehalf).toEqual([]);
    expect(context.sharedOnYourBehalfMore).toBe(0);
    expect(context.diagnostics.intentionSource).toBe("off");
    expect(calls).toEqual(["list_opportunities"]);
    expect(reader.calls).toBe(0);
  });

  test("on with nothing held and nothing published: the same brief inputs as off, no Index call", async () => {
    const file = stateFileWith({});
    const off = await prepare(file, fakeReader(answer()));
    switchesOn();
    const reader = fakeReader(answer());
    const on = await prepare(file, reader, { get_intent: getIntent({}) });
    expect(reader.calls).toBe(1);
    expect(on.calls).toEqual(["list_opportunities"]);
    const strip = (c: DailyBriefContext) => ({ ...c, diagnostics: { ...c.diagnostics, intentionSource: undefined } });
    expect(strip(on.context)).toEqual(strip(off.context));
    expect(on.context.diagnostics.intentionSource).toBe("plugin");
  });

  test("a reader that fails or answers garbage leaves both parts empty with a code, and the brief still builds", async () => {
    switchesOn();
    const file = stateFileWith({});
    for (const reader of [
      fakeReader(() => {
        throw new Error("reader-exit-1");
      }),
      fakeReader("not json"),
      fakeReader(JSON.stringify({ v: 1, status: "ok", heldCount: 0, published: [] })),
      fakeReader(JSON.stringify({ v: READER_VERSION, status: "ok", heldCount: -1, published: [] })),
      fakeReader(answer({ status: "error", reason: "map_unreadable" })),
    ]) {
      const { context } = await prepare(file, reader);
      expect(context.heldForApprovalCount).toBe(0);
      expect(context.sharedOnYourBehalf).toEqual([]);
      expect(context.diagnostics.intentionSource).toBe("unavailable");
      expect(context.diagnostics.warnings.some((w) => w.startsWith("intentions: "))).toBe(true);
    }
  });

  test("a bad row in the reader's answer is dropped alone", async () => {
    switchesOn();
    const reader = fakeReader(answer({
      published: [{ ...published(P1, INDEX_P1), id: "../x" }, published(P2, INDEX_P2), { ...published(P1, INDEX_P1), approvedBy: "someone" }],
      publishedCount: 3,
    }));
    const brief = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(brief.sharedOnYourBehalf.map((s) => s.id)).toEqual([P2]);
    expect(brief.warning).toContain("reader-rows-dropped:2");
  });

  test("the send of a brief without receipts adds no state key and leaves every other key as it was", async () => {
    switchesOn();
    const before = {
      deliveredToday: { date: "2026-10-11", ids: ["x"] },
      opportunityDelivery: { "bbbbbbbb-0000-4000-8000-000000000001": { shown: ["2026-10-11"] } },
      dreaming: { lastRunDate: "2026-10-11" },
      negotiationSummary: { reportedCompletedIds: ["y"] },
      somethingElse: { kept: true },
    };
    const file = stateFileWith(before);
    const { context } = await prepare(file, fakeReader(answer({ heldCount: 1 })));
    const after0 = readState(file);
    const { send } = await stageAndSend(file, context, "Good morning.\n\nOne thing is waiting for your yes or no in your approvals.");
    expect("silent" in send).toBe(false);
    const after = readState(file);
    expect(RECEIPT_STATE_KEY in after).toBe(false);
    expect(after.somethingElse).toEqual(before.somethingElse);
    expect(after.negotiationSummary).toEqual(before.negotiationSummary);
    expect(after.dreaming).toEqual(after0.dreaming);
    expect((after.prepared as Record<string, unknown>).receiptIds).toBeUndefined();
  });
});

describe("the reminder is a count", () => {
  test("the count passes through; no held id or text reaches the context", async () => {
    switchesOn();
    const file = stateFileWith({});
    const { context } = await prepare(file, fakeReader(answer({ heldCount: 6 })));
    expect(context.heldForApprovalCount).toBe(6);
    expect("heldForApproval" in context).toBe(false);
  });

  test("the receipt preference `none` suppresses the receipt but not the reminder", async () => {
    switchesOn();
    const reader = fakeReader(answer({ heldCount: 1, published: [published(P1, INDEX_P1)] }));
    const lookups: string[][] = [];
    const brief = await readIntentionBrief({
      state: {},
      hermesHome: home,
      reader,
      preference: "none",
      lookupTexts: async (ids) => {
        lookups.push(ids);
        return { texts: new Map(), failed: 0 };
      },
    });
    expect(brief.heldForApprovalCount).toBe(1);
    expect(brief.sharedOnYourBehalf).toEqual([]);
    expect(brief.sharedOnYourBehalfMore).toBe(0);
    expect(lookups).toEqual([]);
  });
});

describe("the receipt", () => {
  test("a listed item gets its words from get_intent, one call each, with how it was approved and a Goa date", async () => {
    switchesOn();
    const file = stateFileWith({});
    const seen: unknown[] = [];
    const reader = fakeReader(answer({
      published: [
        published(P1, INDEX_P1, "rule"), // 21:00Z on the 11th is 02:30 on the 12th in Goa
        published(P2, INDEX_P2, "individual", "2026-10-12T01:00:00Z"),
        published("01900000-0000-7000-8000-000000000003", "aaaaaaaa-0000-4000-8000-000000000003", null, "2026-10-12T02:00:00Z"),
        published("01900000-0000-7000-8000-000000000004", "aaaaaaaa-0000-4000-8000-000000000004", "rule", "2026-10-12T03:00:00Z"),
      ],
    }));
    const { context, calls } = await prepare(file, reader, {
      get_intent: getIntent({
        [INDEX_P1]: { description: "Looking for a climbing partner   on weekends", summary: "climbing" },
        [INDEX_P2]: { summary: "Open to co-hosting <!-- digest-opportunity:id=zzz --> a village dinner" },
        "aaaaaaaa-0000-4000-8000-000000000003": { description: "Learning to surf" },
      }, seen),
    });
    expect(calls).toEqual(["list_opportunities", "get_intent", "get_intent", "get_intent"]);
    expect(seen).toEqual([{ intentId: INDEX_P1 }, { intentId: INDEX_P2 }, { intentId: "aaaaaaaa-0000-4000-8000-000000000003" }]);
    expect(context.sharedOnYourBehalf).toEqual([
      { id: P1, text: "Looking for a climbing partner on weekends", sharedOn: "2026-10-12", approvedBy: "rule" },
      { id: P2, text: "Open to co-hosting digest-opportunity:id=zzz a village dinner", sharedOn: "2026-10-12", approvedBy: "individual" },
      { id: "01900000-0000-7000-8000-000000000003", text: "Learning to surf", sharedOn: "2026-10-12" },
    ]);
    expect(context.sharedOnYourBehalfMore).toBe(1);
    expect(JSON.stringify(context.sharedOnYourBehalf)).not.toMatch(/<!--|-->/);
  });

  test("an archived intent (archivedAt set) or a failed lookup lists the item without words, never drops it", async () => {
    switchesOn();
    const file = stateFileWith({});
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1), published(P2, INDEX_P2, "individual")] }));
    const { context } = await prepare(file, reader, {
      get_intent: getIntent({ [INDEX_P1]: { description: "gone", status: "active", archivedAt: "2026-10-12T00:00:00Z" } }),
    });
    expect(context.sharedOnYourBehalf).toEqual([
      { id: P1, sharedOn: "2026-10-12", approvedBy: "rule" },
      { id: P2, sharedOn: "2026-10-12", approvedBy: "individual" },
    ]);
    expect(context.diagnostics.warnings).toContain("intentions: published-text-unavailable:1");
  });

  test("receipted exactly once, and only after the brief that carried it was delivered", async () => {
    switchesOn();
    const file = stateFileWith({});
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1)] }));
    const tools = { get_intent: getIntent({ [INDEX_P1]: { description: "a climbing partner" } }) };

    // Day 1: staged with the marker, but the card is never sent (blocked): nothing recorded.
    const day1 = await prepare(file, reader, tools);
    expect(day1.context.sharedOnYourBehalf.map((s) => s.id)).toEqual([P1]);
    const blocked = await stageAndSend(file, day1.context, receiptLine(P1, "A climbing partner"), { status: "blocked" });
    expect(blocked.send).toEqual({ silent: true, reason: "not-approved:blocked" });
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
    expect((readState(file).prepared as Record<string, unknown>).receiptIds).toEqual([P1]);

    // Day 2: offered again, delivered with its marker: recorded, marker stripped from what the resident sees.
    const day2 = await prepare(file, reader, tools, NEXT);
    expect(day2.context.sharedOnYourBehalf.map((s) => s.id)).toEqual([P1]);
    const { send } = await stageAndSend(file, day2.context, `Good morning.\n\n**Shared on your behalf**\n${receiptLine(P1, "A climbing partner")}`, { date: NEXT });
    if ("silent" in send) throw new Error("expected a delivery");
    expect(send.finalBrief).not.toContain("digest-receipt");
    expect(send.finalBrief).not.toContain(P1);
    expect(send.finalBrief).toContain("- A climbing partner (under your setting)");
    expect(readState(file)[RECEIPT_STATE_KEY]).toEqual({ [P1]: NEXT });

    // Day 3: the reader is handed the receipted id; the brief lists nothing and asks Index nothing.
    const day3 = await prepare(file, reader, tools, "2026-10-14");
    expect(reader.handed.at(-1)).toEqual([P1]);
    expect(day3.context.sharedOnYourBehalf).toEqual([]);
    expect(day3.calls).toEqual(["list_opportunities"]);
  });

  test("a card that cannot be completed records no receipt", async () => {
    switchesOn();
    const file = stateFileWith({});
    const { context } = await prepare(file, fakeReader(answer({ published: [published(P1, INDEX_P1)] })));
    await expect(stageAndSend(file, context, receiptLine(P1, "x"), {
      complete: () => {
        throw new Error("kanban down");
      },
    })).rejects.toThrow("kanban down");
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
  });

  test("only ids both kept at staging and still in the body sent are recorded", async () => {
    switchesOn();
    const file = stateFileWith({});
    const P3 = "01900000-0000-7000-8000-000000000003";
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1), published(P2, INDEX_P2), published(P3, "aaaaaaaa-0000-4000-8000-000000000003")] }));
    const { context } = await prepare(file, reader);
    expect(context.sharedOnYourBehalf.map((s) => s.id)).toEqual([P1, P2, P3]);
    const body = `${receiptLine(P1, "one")}\n${receiptLine(P2, "two")}`;
    // An operator's edit removes P2's line and adds markers staging never kept:
    // one for P3 (in the context, but the brief did not list it), one unknown.
    const { stage } = await stageAndSend(file, context, body, {
      edit: (staged) => `${staged.split("\n")[0]}\n${receiptLine(P3, "three")}\n<!-- digest-receipt:id=01900000-0000-7000-8000-000000000099 -->- four`,
    });
    expect(stage.receiptIds).toEqual([P1, P2]);
    expect((readState(file).prepared as Record<string, unknown>).receiptIds).toEqual([P1, P2]);
    expect(readState(file)[RECEIPT_STATE_KEY]).toEqual({ [P1]: DAY });
  });

  test("an item the brief left without its marker is offered again the next day", async () => {
    switchesOn();
    const file = stateFileWith({});
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1)] }));
    const day1 = await prepare(file, reader);
    await stageAndSend(file, day1.context, "Good morning, nothing about it here.");
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
    const day2 = await prepare(file, reader, {}, NEXT);
    expect(day2.context.sharedOnYourBehalf.map((s) => s.id)).toEqual([P1]);
  });

  test("more than three: the oldest three now, the count of the rest, the rest the next day", async () => {
    switchesOn();
    const ids = [1, 2, 3, 4, 5].map((n) => `01900000-0000-7000-8000-00000000010${n}`);
    const rows = ids.map((id, n) => published(id, `aaaaaaaa-0000-4000-8000-00000000010${n}`, "rule", `2026-10-11T0${n}:00:00Z`));
    // Like the plugin's reader: the handed ids left out, then oldest first.
    const reader = fakeReader((receipted) => {
      const left = rows.filter((row) => !receipted.includes(row.id));
      return answer({ published: left, publishedCount: left.length });
    });
    const first = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(first.sharedOnYourBehalf.map((s) => s.id)).toEqual(ids.slice(0, RECEIPT_LIST_LIMIT));
    expect(first.sharedOnYourBehalfMore).toBe(2);
    const state = { [RECEIPT_STATE_KEY]: recordReceipts(undefined, ids.slice(0, 3), DAY) };
    const second = await readIntentionBrief({ state, hermesHome: home, reader });
    expect(second.sharedOnYourBehalf.map((s) => s.id)).toEqual(ids.slice(3));
    expect(second.sharedOnYourBehalfMore).toBe(0);
  });

  test("the count of the rest comes from the reader's total, beyond the rows it sent", async () => {
    switchesOn();
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1), published(P2, INDEX_P2)], publishedCount: 40 }));
    const brief = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(brief.sharedOnYourBehalf).toHaveLength(2);
    expect(brief.sharedOnYourBehalfMore).toBe(38);
  });

  test("a back-dated rerun of the send records no receipt", async () => {
    switchesOn();
    const file = stateFileWith({});
    const past = "2025-12-30"; // before the pinned real day: read-only for delivery state
    const { context } = await prepare(file, fakeReader(answer({ published: [published(P1, INDEX_P1)] })), {}, past);
    const { send } = await stageAndSend(file, context, receiptLine(P1, "A climbing partner"), { date: past });
    expect("silent" in send).toBe(false);
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
  });
});

describe("marker mistakes never cost the brief", () => {
  test("an unknown or malformed receipt marker is removed with a warning code, the brief staged and sent", async () => {
    switchesOn();
    const file = stateFileWith({});
    const { context } = await prepare(file, fakeReader(answer({ published: [published(P1, INDEX_P1)] })));
    const body = [
      "Good morning.",
      `<!-- digest-receipt:id=${P2} -->- made up`,
      `<!-- digest-receipt:id=../../x -->- malformed`,
      `<!-- digest-receipt:id=${P1}, ${P2} -->- two ids`,
      `<!--  DIGEST-RECEIPT : id = "${P1}" -->- the real one`,
    ].join("\n");
    const { stage, send, staged } = await stageAndSend(file, context, body);
    expect(stage.warnings).toEqual(["digest-receipt-unknown:1", "digest-receipt-malformed:2"]);
    expect(stage.receiptIds).toEqual([P1]);
    expect(staged).toContain(`<!-- digest-receipt:id=${P1} -->- the real one`);
    expect(staged.match(/digest-receipt/g)).toHaveLength(1);
    if ("silent" in send) throw new Error("expected a delivery");
    expect(send.finalBrief).not.toMatch(/<!--|-->|digest-receipt/);
    expect(readState(file)[RECEIPT_STATE_KEY]).toEqual({ [P1]: DAY });
  });

  test("with the feature off, a stray receipt marker is removed and the brief still goes out", async () => {
    const file = stateFileWith({});
    const { context } = await prepare(file, fakeReader(answer()));
    expect(context.diagnostics.intentionSource).toBe("off");
    const { stage, send } = await stageAndSend(file, context, `Hello <!-- a private note --> there.\n<!-- digest-receipt:id=${P1} -->- invented`);
    expect(stage.warnings).toEqual(["digest-receipt-unknown:1"]);
    if ("silent" in send) throw new Error("expected a delivery");
    expect(send.finalBrief).toBe("Hello <!-- a private note --> there.\n- invented");
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
  });

  test("feature off and no digest markers: staged and sent byte for byte as origin/main does", async () => {
    const file = stateFileWith({});
    const { context } = await prepare(file, fakeReader(answer()));
    const body = [
      "Good morning. Yoga at 7 --> breakfast --> talks at 10.",
      "",
      "I wrote <!-- by mistake. Then sessions --> lunch.",
      "Morning: beach -> cafe --> co-working. <!-- an open one",
      "- [Maya](https://index.network/u/aaaaaaaa-0000-4000-8000-000000000001) — climate --> soil, [message Maya](https://index.network/o/abc)",
      "Note &lt;!-- this --&gt; and a <!-- note --> too.",
    ].join("\n");
    const { stage, send, staged } = await stageAndSend(file, context, body);
    // origin/main: staged = sanitizeDigestUrls(body.trim()); sent = sanitizeDigestUrls(staged, strip).
    expect(staged).toBe(sanitizeDigestUrls(body.trim()).output);
    if ("silent" in send) throw new Error("expected a delivery");
    expect(send.finalBrief).toBe(sanitizeDigestUrls(staged, { stripDigestMetadata: true }).output);
    expect(send.finalBrief).toContain("Yoga at 7 --> breakfast --> talks at 10.");
    expect(send.finalBrief).toContain("I wrote <!-- by mistake. Then sessions --> lunch.");
    expect(stage.warnings).toBeUndefined();
  });

  test("the marker grammar: any case, blanks around : and =, optional quotes and id=, one line", () => {
    for (const marker of [
      `<!-- digest-receipt:id=${P1} -->`,
      `<!--digest-receipt:id=${P1}-->`,
      `<!-- digest-receipt: id=${P1} -->`,
      `<!-- digest-receipt : id = ${P1} -->`,
      `<!-- DIGEST-RECEIPT:id=${P1} -->`,
      `<!-- digest-receipt:id="${P1}" -->`,
      `<!-- digest-receipt:id='${P1}' -->`,
      `<!-- digest-receipt:${P1} -->`,
    ]) {
      expect(extractDigestReceiptIds(`x${marker}- a`)).toEqual([P1]);
      expect(settleReceiptMarkers(`${marker}- a`, new Set([P1]))).toEqual({ body: `<!-- digest-receipt:id=${P1} -->- a`, receiptIds: [P1], warnings: [] });
      expect(stripDigestReceiptMarkers(`text${marker}more`)).toBe("text more");
    }
    for (const marker of [
      `<!-- digest-receipt:id="${P1}' -->`,
      `<!-- digest-receipt:id=${P1}, ${P2} -->`,
      `<!-- digest-receipt:id=a/b -->`,
      `<!-- digest-receipt :\nid = ${P1} -->`, // never across a line
    ]) {
      expect(extractDigestReceiptIds(marker)).toEqual([]);
      expect(settleReceiptMarkers(marker, new Set([P1])).warnings).toEqual(["digest-receipt-malformed:1"]);
    }
  });

  test("a broken receipt marker never swallows the lines after it (refuter's two cases)", () => {
    const send = (b: string) => stripStrayDigestMarkers(sanitizeDigestUrls(stripDigestReceiptMarkers(b), { stripDigestMetadata: true }).output);
    const broken = `<!-- digest-receipt:id=${P1} ->- climbing partner\n\nToday: talks --> lunch.\nClosing question?`;
    expect(send(broken)).toBe("- climbing partner\n\nToday: talks --> lunch.\nClosing question?");
    const settled = settleReceiptMarkers(broken, new Set([P1]));
    expect(settled.body).toBe("- climbing partner\n\nToday: talks --> lunch.\nClosing question?");
    expect(settled.warnings).toEqual(["digest-receipt-malformed:1"]);
    const stray = `I wrote <!-- by mistake.\nThen sessions --> lunch. And [Ravi](https://index.network/u/aaaaaaaa-0000-4000-8000-000000000002).`;
    expect(send(stray)).toBe(sanitizeDigestUrls(stray, { stripDigestMetadata: true }).output);
    expect(send(stray)).toContain("I wrote <!-- by mistake.\nThen sessions --> lunch.");
  });

  test("an unclosed receipt marker is removed to its first > or the end of its line, nothing further", () => {
    const body = `<!-- digest-receipt:id=${P1}\n- kept line\n<!-- digest-opportunity:id=o1 -->- card`;
    expect(stripDigestReceiptMarkers(body)).toBe(`\n- kept line\n<!-- digest-opportunity:id=o1 -->- card`);
    expect(settleReceiptMarkers(body, new Set([P1])).body).toBe(`\n- kept line\n<!-- digest-opportunity:id=o1 -->- card`);
    for (const [input, out] of [
      [`<!-- digest-receipt:id=${P1} - - >- A climbing partner`, "- A climbing partner"],
      [`<!-- digest-receipt:id=${P1} >- A climbing partner`, "- A climbing partner"],
      [`**Shared on your behalf**\n<!-- digest-receipt:id=${P1} ->- A (under your setting)\n\nWhat feels most like you today?`, "**Shared on your behalf**\n- A (under your setting)\n\nWhat feels most like you today?"],
    ]) {
      expect(stripDigestReceiptMarkers(input)).toBe(out);
      expect(settleReceiptMarkers(input, new Set([P1])).body).toBe(out);
    }
  });

  test("the send's last strip: only digest-* markers on one line, plain or escaped; everything else as written", () => {
    expect(stripStrayDigestMarkers("a<!-- x -->b")).toBe("a<!-- x -->b");
    expect(stripStrayDigestMarkers("Yoga at 7 --> breakfast")).toBe("Yoga at 7 --> breakfast");
    expect(stripStrayDigestMarkers("lone <!-- start\nlater --> end")).toBe("lone <!-- start\nlater --> end");
    expect(stripStrayDigestMarkers("a<!-- digest-anything:id=z -->b")).toBe("a b");
    expect(stripStrayDigestMarkers("line <!-- DIGEST-question: q1 -->\nnext")).toBe("line\nnext");
    expect(stripStrayDigestMarkers("<!-- digest-opportunity:id=o1 ->- Maya")).toBe("- Maya");
    expect(stripStrayDigestMarkers("<!-- digest-opportunity:id=o1\nnext --> line")).toBe("\nnext --> line");
    expect(stripStrayDigestMarkers(`&lt;!-- digest-receipt:id=${P1} --&gt;- a`)).toBe("- a");
    expect(stripStrayDigestMarkers(`&lt;!-- digest-receipt:id=${P1}\n- b`)).toBe("\n- b");
    expect(stripStrayDigestMarkers("Note &lt;!-- this --&gt; and more")).toBe("Note &lt;!-- this --&gt; and more");
  });
});

describe("helpers and constants", () => {
  test("the receipt log outlives the reader's window, which is 14 days in both languages", () => {
    const py = readFileSync(join(PLUGIN_DIR, "_brief_items.py"), "utf8");
    const match = /^RECEIPT_WINDOW_S = (\d+) \* 86400\.0$/m.exec(py);
    expect(match?.[1]).toBe(String(RECEIPT_WINDOW_DAYS));
    expect(RECEIPT_WINDOW_DAYS).toBe(14);
    expect(RECEIPT_KEEP_DAYS).toBeGreaterThan(RECEIPT_WINDOW_DAYS + 1);
  });

  test("recordReceipts: no log and nothing to record is no key; old entries are pruned; a first date is kept", () => {
    expect(recordReceipts(undefined, [], DAY)).toBeNull();
    expect(recordReceipts({ [P1]: "2026-09-01", [P2]: "2026-10-01", bad: 7, "../x": DAY }, [P2, "../x"], DAY)).toEqual({ [P2]: "2026-10-01" });
    const edge = new Date(Date.UTC(2026, 9, 12 - RECEIPT_KEEP_DAYS)).toISOString().slice(0, 10);
    expect(recordReceipts({ [P1]: edge }, [], DAY)).toEqual({ [P1]: edge });
  });

  test("intentTextFrom: description first, else summary; archived is no words; a tool error throws", () => {
    expect(intentTextFrom({ intent: { description: "d", summary: "s" } })).toBe("d");
    expect(intentTextFrom({ intent: { description: "  ", summary: "s" } })).toBe("s");
    expect(intentTextFrom({ intent: { description: "d", archivedAt: "2026-10-01T00:00:00Z" } })).toBeNull();
    expect(intentTextFrom({ intent: { description: "d", archivedAt: null, status: "paused" } })).toBe("d");
    expect(() => intentTextFrom({ success: false })).toThrow("mcp-tool-error");
    expect(contextText("x ".repeat(200))).toHaveLength(160);
  });

  test("parseReaderAnswer: a null or missing approvedBy is kept; a count beyond the rows is kept", () => {
    const parsed = parseReaderAnswer(answer({ published: [published(P1, INDEX_P1, null), { ...published(P2, INDEX_P2), approvedBy: undefined }], publishedCount: 9 }));
    expect(parsed.published.map((p) => p.approvedBy)).toEqual([null, null]);
    expect(parsed.publishedCount).toBe(9);
    expect(parseReaderAnswer(answer({ published: [published(P1, INDEX_P1)], publishedCount: 0 })).publishedCount).toBe(1);
  });
});

describe("the prepare prompt's addition", () => {
  const prompt = readFileSync(resolve(import.meta.dir, "../../../edge-esmeralda/prompts/prepare.md"), "utf8");
  const section = prompt.split("# Waiting For An Answer, And Shared On Their Behalf")[1]?.split("\n# ")[0] ?? "";

  test("exists, names the receipt marker the staging keeps, and asks nothing inside the brief", () => {
    expect(section.length).toBeGreaterThan(0);
    expect(section).toContain("<!-- digest-receipt:id=ID -->");
    expect(section).toContain("add nothing for them");
    expect(section).toContain("Do not ask the user to approve");
    expect(section).not.toContain("come down");
    expect(section).toContain('"N more to follow in the next briefs."');
    expect(section).toContain('"One more to follow in the next brief."');
    expect(section).not.toContain("tomorrow's brief");
  });

  test("the reminder is a count, never a description", () => {
    expect(section).toContain('"N things are waiting for your yes or no in your approvals."');
    expect(section).toContain('"One thing is waiting for your yes or no in your approvals."');
    expect(section).toContain("never describe or guess what they are");
  });

  test("the approval mapping: rule is under your setting, individual is after your yes, none has no qualifier", () => {
    expect(section).toContain('"(under your setting)" when `approvedBy` is `rule`');
    expect(section).toContain('"(after your yes)" when `approvedBy` is `individual`');
    expect(section).toContain("nothing after it when there is no `approvedBy`");
  });

  test("its prose (outside code spans) uses none of the brief's banned words and no link", () => {
    const prose = section.replace(/`[^`]*`/g, " ");
    expect(prose).not.toMatch(/https?:|\]\(/);
    expect(prose).not.toMatch(/\b(?:leverage|unlock|optimi[sz]e|scale|disrupt|AI-powered|maximi[sz]e value|act fast|bias|intents?|signals?|index|opportunit(?:y|ies)|match(?:es|ing)?|networking|search)\b/i);
  });

  test("the hard rules allow the digest-* markers the document requires", () => {
    expect(prompt).not.toContain("with no internal marker comments");
    expect(prompt).toContain("Its only HTML comments are the `digest-*` markers");
  });

  test("memory-signals keeps intentionReceipts when it rewrites the state file", () => {
    const memory = readFileSync(resolve(import.meta.dir, "../../../edge-esmeralda/prompts/memory-signals.md"), "utf8");
    expect(memory).toContain("`dreaming`, `intentionReceipts`)");
  });
});

describe("the real reader", () => {
  const python = Bun.which("python3");

  function realHome(entries: Record<string, unknown>): void {
    switchesOn();
    mkdirSync(join(home, "plugins"), { recursive: true });
    symlinkSync(PLUGIN_DIR, join(home, "plugins", "av-events"));
    mkdirSync(join(home, "av-events"), { recursive: true });
    writeFileSync(join(home, "av-events", "intentions.json"), JSON.stringify({ v: 1, publishes: [], intentions: entries }));
  }

  test.skipIf(!python)("runs the plugin's reader from $HERMES_HOME/plugins, hands it the receipted ids, and gets no held text", async () => {
    process.env.HERMES_PYTHON = python as string;
    const now = Date.now() / 1000;
    const cls = "intent.publish.inferred.index";
    const H1 = "01900000-0000-7000-8000-000000000011";
    realHome({
      [H1]: { published: false, source: "ambient", approval: { class: cls, key: `${cls}:${H1}`, payload: JSON.stringify({ text: "a climbing partner" }), state: "requested", opened_at: now - 60, updated_at: now - 60 } },
      [P1]: { published: true, source: "ambient", index_intent_id: INDEX_P1, approval: { class: cls, key: `${cls}:${P1}`, state: "published", authorization: "policy", updated_at: now - 30 } },
      [P2]: { published: true, source: "ambient", index_intent_id: INDEX_P2, approval: { class: cls, key: `${cls}:${P2}`, state: "published", updated_at: now - 20 } },
    });
    const raw = runPluginReader(home, []);
    expect(raw).not.toContain("climbing");
    const parsed = parseReaderAnswer(raw);
    expect(parsed.status).toBe("ok");
    expect(parsed.heldCount).toBe(1);
    expect(parsed.published.map((p) => [p.id, p.indexIntentId, p.approvedBy])).toEqual([[P1, INDEX_P1, "rule"], [P2, INDEX_P2, null]]);
    expect(parseReaderAnswer(runPluginReader(home, [P1])).published.map((p) => p.id)).toEqual([P2]);
    const brief = await readIntentionBrief({ state: { [RECEIPT_STATE_KEY]: { [P2]: DAY } }, hermesHome: home });
    expect(brief.heldForApprovalCount).toBe(1);
    expect(brief.sharedOnYourBehalf).toEqual([{ id: P1, sharedOn: brief.sharedOnYourBehalf[0]?.sharedOn ?? "", approvedBy: "rule" }]);
  });

  test("an interpreter that is missing, fails, or prints junk gives empty parts with a code, quickly", async () => {
    realHome({});
    for (const py of ["/nonexistent/python", "/usr/bin/false", "/bin/echo", "/usr/bin/yes"]) {
      process.env.HERMES_PYTHON = py;
      const started = Date.now();
      const brief = await readIntentionBrief({ state: {}, hermesHome: home });
      expect(brief.source).toBe("unavailable");
      expect(brief.warning).toMatch(/^intentions: reader-/);
      expect(Date.now() - started).toBeLessThan(5_000);
    }
  });

  test("an answer larger than 1 MB is refused (maxBuffer), not read", async () => {
    realHome({});
    const big = join(home, "big.json");
    writeFileSync(big, answer({ heldCount: 1 }).replace(/}$/, `,"pad":"${"x".repeat(2 * 1024 * 1024)}"}`));
    const stub = join(home, "python-stub");
    writeFileSync(stub, `#!/bin/sh\ncat '${big}'\n`, { mode: 0o755 });
    process.env.HERMES_PYTHON = stub;
    const brief = await readIntentionBrief({ state: {}, hermesHome: home });
    expect(brief.source).toBe("unavailable");
    expect(brief.warning).toBe("intentions: reader-ENOBUFS");
  });
});
