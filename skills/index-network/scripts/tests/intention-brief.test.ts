/**
 * DATA-222: the morning brief's reminder of inferred intentions awaiting
 * approval and its receipt of those published on the resident's behalf.
 *
 * The plugin's reader is faked (a function returning its JSON) except in the
 * last test, which runs the real reader from plugins/av-events with Python.
 * Index is the in-process fake; nothing reaches the network.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { buildDailyBriefContext, type DailyBriefContext } from "../build-daily-brief-context";
import {
  HELD_LIST_LIMIT,
  RECEIPT_KEEP_DAYS,
  RECEIPT_LIST_LIMIT,
  RECEIPT_STATE_KEY,
  extractDigestReceiptIds,
  intentTextsFrom,
  parseReaderAnswer,
  readIntentionBrief,
  recordReceipts,
  runPluginReader,
  stripDigestReceiptMarkers,
  type ReaderRunner,
} from "../intention-brief";
import { sendDailyBrief } from "../send-daily-brief";
import { stageDailyBrief } from "../stage-daily-brief";
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

const P1 = "01900000-0000-7000-8000-000000000001";
const P2 = "01900000-0000-7000-8000-000000000002";
const H1 = "01900000-0000-7000-8000-000000000011";
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
  held?: unknown[];
  heldCount?: number;
  published?: unknown[];
}

function answer(a: FakeAnswer = {}): string {
  const held = a.held ?? [];
  return JSON.stringify({
    v: 1,
    status: a.status ?? "ok",
    reason: a.reason ?? null,
    held,
    heldCount: a.heldCount ?? held.length,
    published: a.published ?? [],
  });
}

function heldItem(id: string, text: string, heldSince = "2026-10-11T20:00:00Z") {
  return { id, text, heldSince };
}

function published(id: string, indexIntentId: string, approvedBy: "individual" | "rule" = "rule", publishedAt = "2026-10-11T21:00:00Z") {
  return { id, indexIntentId, publishedAt, approvedBy };
}

/** A reader that records each call. */
function fakeReader(raw: string | (() => string)): ReaderRunner & { calls: number } {
  const run = ((_home: string) => {
    run.calls++;
    return typeof raw === "string" ? raw : raw();
  }) as ReaderRunner & { calls: number };
  run.calls = 0;
  return run;
}

const listIntents = (rows: unknown[]): ToolHandler => () => `Your signals:\n\n${JSON.stringify({ success: true, intents: rows })}`;

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

/** Stage `body` against `context`, then run the send with the card `status`. */
async function stageAndSend(file: string, context: DailyBriefContext, body: string, status = "ready", date = DAY) {
  const contextOut = join(home, "context.json");
  writeFileSync(contextOut, JSON.stringify(context));
  let staged = "";
  await stageDailyBrief({
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
  return sendDailyBrief({
    date,
    stateFile: file,
    outgoingFile: join(home, "outgoing.md"),
    hermes: (args) => {
      if (args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status, body: staged } });
      if (args[1] === "complete") return "completed";
      throw new Error(`unexpected hermes call: ${args.join(" ")}`);
    },
  });
}

function receiptLine(id: string, text: string): string {
  return `<!-- digest-receipt:id=${id} -->- ${text} (shared under your setting)`;
}

describe("inert when off or empty", () => {
  test("AV_RECORD_INTENTION off: the reader never runs and both lists are empty", async () => {
    const reader = fakeReader(answer({ held: [heldItem(H1, "a climbing partner")], published: [published(P1, INDEX_P1)] }));
    writeFileSync(join(home, ".env"), "AV_RECORD_INTENTION=0\nAV_APPROVAL_ENABLED=1\nAV_APPROVAL_URL=http://127.0.0.1:4680\n");
    const brief = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(brief).toEqual({ heldForApproval: [], heldForApprovalCount: 0, sharedOnYourBehalf: [], sharedOnYourBehalfMore: 0, source: "off" });
    expect(reader.calls).toBe(0);
  });

  test("the approval path off: the reader never runs", async () => {
    const reader = fakeReader(answer({ held: [heldItem(H1, "a climbing partner")] }));
    writeFileSync(join(home, ".env"), "AV_RECORD_INTENTION=1\nAV_APPROVAL_ENABLED=1\n");
    expect((await readIntentionBrief({ state: {}, hermesHome: home, reader })).source).toBe("off");
    process.env.AV_APPROVAL_URL = "http://127.0.0.1:4680";
    process.env.AV_APPROVAL_ENABLED = ""; // blank in the process environment wins over the dotfile
    expect((await readIntentionBrief({ state: {}, hermesHome: home, reader })).source).toBe("off");
    expect(reader.calls).toBe(0);
  });

  test("off, the brief context is the context without these features, and Index is not asked for intentions", async () => {
    const file = stateFileWith({ deliveredToday: { date: DAY, ids: [] } });
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1)] }));
    const { context, calls } = await prepare(file, reader, { list_intents: listIntents([]) });
    expect(context.heldForApproval).toEqual([]);
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
    const on = await prepare(file, reader, { list_intents: listIntents([]) });
    expect(reader.calls).toBe(1);
    expect(on.calls).toEqual(["list_opportunities"]);
    const strip = (c: DailyBriefContext) => ({ ...c, diagnostics: { ...c.diagnostics, intentionSource: undefined } });
    expect(strip(on.context)).toEqual(strip(off.context));
    expect(on.context.diagnostics.intentionSource).toBe("plugin");
  });

  test("a reader that fails or answers garbage leaves both lists empty with a code, and the brief still builds", async () => {
    switchesOn();
    const file = stateFileWith({});
    for (const reader of [
      fakeReader(() => {
        throw new Error("reader-exit-1");
      }),
      fakeReader("not json"),
      fakeReader(JSON.stringify({ v: 2, status: "ok", held: [], heldCount: 0, published: [] })),
      fakeReader(answer({ held: [{ id: "../x", text: "t", heldSince: "2026-10-11T20:00:00Z" }] })),
      fakeReader(answer({ status: "error", reason: "map_unreadable" })),
    ]) {
      const { context } = await prepare(file, reader);
      expect(context.heldForApproval).toEqual([]);
      expect(context.sharedOnYourBehalf).toEqual([]);
      expect(context.diagnostics.intentionSource).toBe("unavailable");
      expect(context.diagnostics.warnings.some((w) => w.startsWith("intentions: "))).toBe(true);
    }
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
    const { context } = await prepare(file, fakeReader(answer({ held: [heldItem(H1, "a climbing partner")] })));
    const after0 = readState(file);
    const result = await stageAndSend(file, context, "Good morning.\n\nStill waiting on your yes or no: a climbing partner.");
    expect("silent" in result).toBe(false);
    const after = readState(file);
    expect(RECEIPT_STATE_KEY in after).toBe(false);
    expect(after.somethingElse).toEqual(before.somethingElse);
    expect(after.negotiationSummary).toEqual(before.negotiationSummary);
    expect(after.dreaming).toEqual(after0.dreaming);
    expect((after.prepared as Record<string, unknown>).receiptIds).toBeUndefined();
  });
});

describe("the reminder", () => {
  test("held items are listed oldest first, at most three, with the total count and village dates", async () => {
    switchesOn();
    const held = [
      heldItem(H1, "a climbing partner on weekends", "2026-10-10T19:00:00Z"), // 00:30 on the 11th in Goa
      heldItem("01900000-0000-7000-8000-000000000012", "someone to practise Konkani with"),
      heldItem("01900000-0000-7000-8000-000000000013", "a cofounder for a solar project"),
      heldItem("01900000-0000-7000-8000-000000000014", "a fourth thing"),
    ];
    const brief = await readIntentionBrief({ state: {}, hermesHome: home, reader: fakeReader(answer({ held, heldCount: 6 })) });
    expect(brief.heldForApproval).toHaveLength(HELD_LIST_LIMIT);
    expect(brief.heldForApproval[0]).toEqual({ text: "a climbing partner on weekends", heldSince: "2026-10-11" });
    expect(brief.heldForApprovalCount).toBe(6);
    // No id reaches the context for a held item: nothing in the brief refers to it.
    expect(JSON.stringify(brief.heldForApproval)).not.toContain(H1);
  });

  test("a held item stays in the reminder every day until the reader stops returning it (answered, withdrawn or expired)", async () => {
    switchesOn();
    const file = stateFileWith({});
    const still = fakeReader(answer({ held: [heldItem(H1, "a climbing partner")] }));
    const day1 = await prepare(file, still);
    await stageAndSend(file, day1.context, "Still waiting on your yes or no: a climbing partner.");
    const day2 = await prepare(file, still, {}, NEXT);
    expect(day2.context.heldForApproval.map((h) => h.text)).toEqual(["a climbing partner"]);
    const answered = await prepare(file, fakeReader(answer()), {}, NEXT);
    expect(answered.context.heldForApproval).toEqual([]);
  });

  test("the receipt preference `none` suppresses the receipt but not the reminder", async () => {
    switchesOn();
    const reader = fakeReader(answer({ held: [heldItem(H1, "a climbing partner")], published: [published(P1, INDEX_P1)] }));
    const lookups: string[][] = [];
    const brief = await readIntentionBrief({
      state: {},
      hermesHome: home,
      reader,
      preference: "none",
      lookupTexts: async (ids) => {
        lookups.push(ids);
        return new Map();
      },
    });
    expect(brief.heldForApproval.map((h) => h.text)).toEqual(["a climbing partner"]);
    expect(brief.sharedOnYourBehalf).toEqual([]);
    expect(brief.sharedOnYourBehalfMore).toBe(0);
    expect(lookups).toEqual([]);
  });
});

describe("the receipt", () => {
  test("a published item is listed with its words from Index and how it was approved", async () => {
    switchesOn();
    const file = stateFileWith({});
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1, "rule"), published(P2, INDEX_P2, "individual", "2026-10-12T01:00:00Z")] }));
    const { context, calls } = await prepare(file, reader, {
      list_intents: listIntents([
        { id: INDEX_P1, description: "Looking for a climbing partner   on weekends", summary: "climbing" },
        { id: INDEX_P2, summary: "Open to co-hosting a village dinner" },
        { id: "aaaaaaaa-0000-4000-8000-000000000009", description: "someone else's words are never asked for" },
      ]),
    });
    expect(calls).toEqual(["list_opportunities", "list_intents"]);
    expect(context.sharedOnYourBehalf).toEqual([
      { id: P1, text: "Looking for a climbing partner on weekends", sharedOn: "2026-10-12", approvedBy: "rule" },
      { id: P2, text: "Open to co-hosting a village dinner", sharedOn: "2026-10-12", approvedBy: "individual" },
    ]);
    expect(JSON.stringify(context)).not.toContain("someone else's words");
  });

  test("Index unavailable or the row archived: the item is listed without words, never dropped", async () => {
    switchesOn();
    const file = stateFileWith({});
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1)] }));
    const failing = await prepare(file, reader, { list_intents: () => ({ result: { content: [{ type: "text", text: "x" }], isError: true } }) });
    expect(failing.context.sharedOnYourBehalf).toEqual([{ id: P1, sharedOn: "2026-10-12", approvedBy: "rule" }]);
    expect(failing.context.diagnostics.warnings.some((w) => w.includes("published text unavailable"))).toBe(true);
    const archived = await prepare(file, reader, { list_intents: listIntents([{ id: INDEX_P1, description: "gone", status: "archived" }]) });
    expect(archived.context.sharedOnYourBehalf).toEqual([{ id: P1, sharedOn: "2026-10-12", approvedBy: "rule" }]);
  });

  test("receipted exactly once, and only after the brief that carried it was delivered", async () => {
    switchesOn();
    const file = stateFileWith({});
    const reader = fakeReader(answer({ published: [published(P1, INDEX_P1)] }));
    const tools = { list_intents: listIntents([{ id: INDEX_P1, description: "a climbing partner" }]) };

    // Day 1: staged with the marker, but the card is never sent (blocked): nothing recorded.
    const day1 = await prepare(file, reader, tools);
    expect(day1.context.sharedOnYourBehalf.map((s) => s.id)).toEqual([P1]);
    const blocked = await stageAndSend(file, day1.context, receiptLine(P1, "A climbing partner"), "blocked");
    expect(blocked).toEqual({ silent: true, reason: "not-approved:blocked" });
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
    expect((readState(file).prepared as Record<string, unknown>).receiptIds).toEqual([P1]);

    // Day 2: offered again, delivered with its marker: recorded, marker stripped from what the resident sees.
    const day2 = await prepare(file, reader, tools, NEXT);
    expect(day2.context.sharedOnYourBehalf.map((s) => s.id)).toEqual([P1]);
    const sent = await stageAndSend(file, day2.context, `Good morning.\n\n**Shared on your behalf**\n${receiptLine(P1, "A climbing partner")}`, "ready", NEXT);
    if ("silent" in sent) throw new Error("expected a delivery");
    expect(sent.finalBrief).not.toContain("digest-receipt");
    expect(sent.finalBrief).not.toContain(P1);
    expect(sent.finalBrief).toContain("- A climbing partner (shared under your setting)");
    expect(readState(file)[RECEIPT_STATE_KEY]).toEqual({ [P1]: NEXT });

    // Day 3: the reader still returns it (within its week), the brief does not.
    const day3 = await prepare(file, reader, tools, "2026-10-14");
    expect(day3.context.sharedOnYourBehalf).toEqual([]);
    expect(day3.calls).toEqual(["list_opportunities"]);
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
    const reader = fakeReader(answer({ published: ids.map((id, n) => published(id, `aaaaaaaa-0000-4000-8000-00000000010${n}`, "rule", `2026-10-11T0${n}:00:00Z`)) }));
    const first = await readIntentionBrief({ state: {}, hermesHome: home, reader });
    expect(first.sharedOnYourBehalf.map((s) => s.id)).toEqual(ids.slice(0, RECEIPT_LIST_LIMIT));
    expect(first.sharedOnYourBehalfMore).toBe(2);
    const state = { [RECEIPT_STATE_KEY]: recordReceipts(undefined, ids.slice(0, 3), DAY) };
    const second = await readIntentionBrief({ state, hermesHome: home, reader });
    expect(second.sharedOnYourBehalf.map((s) => s.id)).toEqual(ids.slice(3));
    expect(second.sharedOnYourBehalfMore).toBe(0);
  });

  test("a back-dated rerun of the send records no receipt", async () => {
    switchesOn();
    const file = stateFileWith({});
    const past = "2025-12-30"; // before the pinned real day: read-only for delivery state
    const { context } = await prepare(file, fakeReader(answer({ published: [published(P1, INDEX_P1)] })), {}, past);
    const sent = await stageAndSend(file, context, receiptLine(P1, "A climbing partner"), "ready", past);
    expect("silent" in sent).toBe(false);
    expect(RECEIPT_STATE_KEY in readState(file)).toBe(false);
  });

  test("staging refuses a receipt marker for an id the context does not hold", async () => {
    switchesOn();
    const file = stateFileWith({});
    const { context } = await prepare(file, fakeReader(answer({ published: [published(P1, INDEX_P1)] })));
    await expect(stageAndSend(file, context, receiptLine(P2, "made up"))).rejects.toThrow("unknown receipt marker id(s)");
  });
});

describe("helpers", () => {
  test("markers: extracted in order once each, stripped without leaving gaps", () => {
    const body = `a\n<!-- digest-receipt:id=${P1} -->- one\n- two <!-- digest-receipt:id=${P2} -->x\n<!-- digest-receipt:${P1} -->`;
    expect(extractDigestReceiptIds(body)).toEqual([P1, P2]);
    expect(stripDigestReceiptMarkers(body)).toBe("a\n- one\n- two x\n");
  });

  test("recordReceipts: no log and nothing to record is no key; old entries are pruned; a first date is kept", () => {
    expect(recordReceipts(undefined, [], DAY)).toBeNull();
    const old = "2026-09-20";
    expect(recordReceipts({ [P1]: old, [P2]: "2026-10-01", bad: 7 }, [P2, "../x"], DAY)).toEqual({ [P2]: "2026-10-01" });
    const edge = new Date(Date.UTC(2026, 9, 12 - RECEIPT_KEEP_DAYS)).toISOString().slice(0, 10);
    expect(recordReceipts({ [P1]: edge }, [], DAY)).toEqual({ [P1]: edge });
  });

  test("intentTextsFrom keeps only the asked ids and shortens long words", () => {
    const long = "x ".repeat(200);
    const out = intentTextsFrom([{ id: INDEX_P1, description: long }, { id: INDEX_P2, summary: "s" }, "junk"], [INDEX_P1]);
    expect([...out.keys()]).toEqual([INDEX_P1]);
    expect(out.get(INDEX_P1)?.length).toBe(160);
    expect(out.get(INDEX_P1)?.endsWith("…")).toBe(true);
  });

  test("parseReaderAnswer refuses bad shapes", () => {
    expect(() => parseReaderAnswer(answer({ published: [{ ...published(P1, INDEX_P1), approvedBy: "someone" }] }))).toThrow("reader-unparsed");
    expect(() => parseReaderAnswer(answer({ published: [{ ...published(P1, INDEX_P1), publishedAt: "yesterday" }] }))).toThrow("reader-unparsed");
    expect(() => parseReaderAnswer(answer({ held: [{ ...heldItem(H1, "   ") }] }))).toThrow("reader-unparsed");
    expect(parseReaderAnswer(answer({ held: [heldItem(H1, "t")], heldCount: 0 })).heldCount).toBe(1);
  });
});

describe("the real reader", () => {
  const python = Bun.which("python3");
  test.skipIf(!python)("runs the plugin's reader from $HERMES_HOME/plugins and reads what the plugin wrote", async () => {
    process.env.HERMES_PYTHON = python as string;
    switchesOn();
    mkdirSync(join(home, "plugins"), { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../../../../plugins/av-events"), join(home, "plugins", "av-events"));
    mkdirSync(join(home, "av-events"), { recursive: true });
    const now = Date.now() / 1000;
    const cls = "intent.publish.inferred.index";
    writeFileSync(join(home, "av-events", "intentions.json"), JSON.stringify({
      v: 1,
      publishes: [],
      intentions: {
        [H1]: { published: false, source: "ambient", approval: { class: cls, key: `${cls}:${H1}`, payload: JSON.stringify({ text: "a climbing partner" }), state: "requested", opened_at: now - 60, updated_at: now - 60 } },
        [P1]: { published: true, source: "ambient", index_intent_id: INDEX_P1, approval: { class: cls, key: `${cls}:${P1}`, state: "published", authorization: "policy", updated_at: now - 30 } },
      },
    }));
    const raw = runPluginReader(home);
    const parsed = parseReaderAnswer(raw);
    expect(parsed.status).toBe("ok");
    expect(parsed.held.map((h) => [h.id, h.text])).toEqual([[H1, "a climbing partner"]]);
    expect(parsed.published.map((p) => [p.id, p.indexIntentId, p.approvedBy])).toEqual([[P1, INDEX_P1, "rule"]]);
  });
});
