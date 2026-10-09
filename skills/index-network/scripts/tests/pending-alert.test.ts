/**
 * DATA-430 (overlay half): the pending-opportunity alert's pick (pending-alert.ts) over Index's
 * recorded reply shape (index-mcp-fake.ts): the first run seeds the ledger silently, a newly
 * pending card is alerted exactly once, a card that leaves the list is pruned and alerts again
 * when it comes back, negotiating cards never alert, at most three per run, a failed read writes
 * nothing, and a read-only run writes nothing. Every id and name is invented.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_ALERTS_PER_RUN, PENDING_ALERTS_KEY, RESPOND_BY_WORDS, pendingAlert, planPendingAlerts, readPendingLedger, respondByText } from "../pending-alert";
import { pendingView } from "../proactive";
import { FAKE_API_KEY, FAKE_MCP_URL, type ToolHandler, indexMcpFake, pagedOpportunities } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function stateFile(initial?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pending-alert-"));
  dirs.push(dir);
  const file = join(dir, "heartbeat-state.json");
  if (initial !== undefined) writeFileSync(file, typeof initial === "string" ? initial : JSON.stringify(initial));
  return file;
}

function readState(file: string): Record<string, any> {
  return JSON.parse(readFileSync(file, "utf8"));
}

const id = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
const user = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(n: number, name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: id(n),
    url: `https://index.network/o/${id(n)}`,
    status: "pending",
    viewerRole: "party",
    headline: "h",
    summary: "s",
    acceptUrl: `https://index.network/o/${id(n)}?action=accept&viewer=viewer${n}&sig=sig${n}`,
    peer: { name, userId: user(n), url: `https://index.network/u/${user(n)}` },
    ...extra,
  };
}

function serve(rows: Array<Record<string, unknown>> | ToolHandler) {
  const fake = indexMcpFake({ tools: { list_opportunities: typeof rows === "function" ? rows : pagedOpportunities(rows) } });
  globalThis.fetch = fake.fetch;
  return fake;
}

const T0 = new Date("2026-10-12T04:20:00Z");
const T1 = new Date("2026-10-12T05:20:00Z");
const T2 = new Date("2026-10-12T06:20:00Z");
const T3 = new Date("2026-10-12T07:20:00Z");

const run = (file: string, now: Date, extra: Parameters<typeof pendingAlert>[0] = {}) =>
  pendingAlert({ stateFile: file, now, apiKey: FAKE_API_KEY, mcpUrl: FAKE_MCP_URL, ...extra });

describe("pendingAlert", () => {
  test("first run with three pending cards: the ledger is seeded as already alerted, nothing is sent, sibling keys stay", async () => {
    const file = stateFile({ deliveredToday: { date: "2026-10-12", ids: [] }, proactiveRuns: { brief: "2026-10-12" } });
    serve([row(1, "Asha"), row(2, "Bilal"), row(3, "Chen")]);
    expect(await run(file, T0)).toEqual({ silent: true, reason: "seeded" });
    const state = readState(file);
    expect(state[PENDING_ALERTS_KEY]).toEqual({
      [id(1)]: { firstSeen: T0.toISOString(), alertedAt: T0.toISOString() },
      [id(2)]: { firstSeen: T0.toISOString(), alertedAt: T0.toISOString() },
      [id(3)]: { firstSeen: T0.toISOString(), alertedAt: T0.toISOString() },
    });
    expect(state.deliveredToday).toEqual({ date: "2026-10-12", ids: [] });
    expect(state.proactiveRuns).toEqual({ brief: "2026-10-12" });
  });

  test("first run with an empty list still writes the key, so the next new card is alerted", async () => {
    const file = stateFile();
    serve([]);
    expect(await run(file, T0)).toEqual({ silent: true, reason: "seeded" });
    expect(readState(file)[PENDING_ALERTS_KEY]).toEqual({});
    serve([row(4, "Dina")]);
    const result = await run(file, T1);
    if ("silent" in result) throw new Error(result.reason);
    expect(result.cards.map((c) => c.opportunityId)).toEqual([id(4)]);
  });

  test("a new pending id alerts exactly once, with the right Script Output; the next run is silent", async () => {
    const file = stateFile();
    serve([row(1, "Asha"), row(2, "Bilal"), row(3, "Chen")]);
    await run(file, T0);
    serve([row(1, "Asha"), row(2, "Bilal"), row(3, "Chen"), row(4, "Dina")]);
    const result = await run(file, T1);
    if ("silent" in result) throw new Error(result.reason);
    expect(result.cards.map((c) => [c.opportunityId, c.firstSeen])).toEqual([[id(4), T1.toISOString()]]);
    expect(readState(file)[PENDING_ALERTS_KEY][id(4)]).toEqual({ firstSeen: T1.toISOString(), alertedAt: T1.toISOString() });

    const { view } = pendingView(result.cards, T1);
    expect(view).toEqual({
      job: "pending-opportunity",
      cards: [
        {
          name: "Dina",
          profileUrl: `https://agents.edgecity.live/rolodex?person=${user(4)}`,
          appUrl: `https://agents.edgecity.live/intents?opportunity=${id(4)}`,
          acceptUrl: `https://index.network/o/${id(4)}?action=accept&viewer=viewer4&sig=sig4&surface=telegram`,
          opportunityId: id(4),
          firstSeen: T1.toISOString(),
          // The recorded row carries no deadline field: never invented.
          respondBy: null,
        },
      ],
    });

    expect(await run(file, T2)).toEqual({ silent: true, reason: "nothing-new" });
    expect(await run(file, T3)).toEqual({ silent: true, reason: "nothing-new" });
  });

  test("a card that leaves the pending list is pruned on a complete read and, coming back, alerts again", async () => {
    const file = stateFile();
    serve([row(1, "Asha"), row(2, "Bilal")]);
    await run(file, T0);
    serve([row(1, "Asha")]);
    expect(await run(file, T1)).toEqual({ silent: true, reason: "nothing-new" });
    expect(Object.keys(readState(file)[PENDING_ALERTS_KEY])).toEqual([id(1)]);
    serve([row(1, "Asha"), row(2, "Bilal")]);
    const back = await run(file, T2);
    if ("silent" in back) throw new Error(back.reason);
    expect(back.cards.map((c) => c.opportunityId)).toEqual([id(2)]);
  });

  test("a cut-short read (a full page) never prunes an absent card", async () => {
    const file = stateFile({ [PENDING_ALERTS_KEY]: { [id(900)]: { firstSeen: T0.toISOString(), alertedAt: T0.toISOString() } } });
    const rows = Array.from({ length: 50 }, (_, i) => row(i + 1, `Person${i + 1}`));
    serve(rows);
    await run(file, T1);
    expect(readState(file)[PENDING_ALERTS_KEY][id(900)]).toEqual({ firstSeen: T0.toISOString(), alertedAt: T0.toISOString() });
  });

  test("a negotiating card never alerts; an alerted card seen negotiating is dropped, and alerts again once it awaits the resident", async () => {
    const file = stateFile();
    serve([row(1, "Asha")]);
    await run(file, T0);
    serve([row(1, "Asha", { negotiating: true }), row(2, "Bilal", { negotiating: true })]);
    expect(await run(file, T1)).toEqual({ silent: true, reason: "nothing-new" });
    expect(readState(file)[PENDING_ALERTS_KEY]).toEqual({});
    serve([row(1, "Asha"), row(2, "Bilal", { negotiating: true })]);
    const result = await run(file, T2);
    if ("silent" in result) throw new Error(result.reason);
    expect(result.cards.map((c) => c.opportunityId)).toEqual([id(1)]);
  });

  test("more than three new cards: three are sent, the oldest first, the rest are recorded as not alerted and go next run", async () => {
    expect(MAX_ALERTS_PER_RUN).toBe(3);
    // One seen in an earlier run but never alerted (the slots were full), then four more.
    const file = stateFile({ [PENDING_ALERTS_KEY]: { [id(5)]: { firstSeen: T0.toISOString(), alertedAt: null } } });
    serve([row(1, "Asha"), row(2, "Bilal"), row(3, "Chen"), row(4, "Dina"), row(5, "Eve")]);
    const first = await run(file, T1);
    if ("silent" in first) throw new Error(first.reason);
    expect(first.cards.map((c) => c.opportunityId)).toEqual([id(5), id(1), id(2)]);
    const ledger = readState(file)[PENDING_ALERTS_KEY];
    expect(ledger[id(3)]).toEqual({ firstSeen: T1.toISOString(), alertedAt: null });
    expect(ledger[id(4)]).toEqual({ firstSeen: T1.toISOString(), alertedAt: null });
    const second = await run(file, T2);
    if ("silent" in second) throw new Error(second.reason);
    expect(second.cards.map((c) => [c.opportunityId, c.firstSeen])).toEqual([[id(3), T1.toISOString()], [id(4), T1.toISOString()]]);
    expect(await run(file, T3)).toEqual({ silent: true, reason: "nothing-new" });
  });

  test("a card whose name does not clean takes no slot and is never alerted", async () => {
    const file = stateFile({ [PENDING_ALERTS_KEY]: {} });
    serve([row(1, "​"), row(2, "Bilal")]);
    const result = await run(file, T1);
    if ("silent" in result) throw new Error(result.reason);
    expect(result.cards.map((c) => c.opportunityId)).toEqual([id(2)]);
    expect(readState(file)[PENDING_ALERTS_KEY][id(1)]).toEqual({ firstSeen: T1.toISOString(), alertedAt: null });
  });

  for (const failure of failureInputs("opportunities")) {
    test(`a failed Index read writes nothing and is silent: ${failure.label}`, async () => {
      const before = JSON.stringify({ [PENDING_ALERTS_KEY]: { [id(1)]: { firstSeen: T0.toISOString(), alertedAt: T0.toISOString() } }, other: 1 });
      const file = stateFile(before);
      serve(failure.handler);
      expect(await run(file, T1)).toEqual({ silent: true, reason: "index-unavailable" });
      expect(readFileSync(file, "utf8")).toBe(before);
    });
  }

  test("a failed Index read on a box with no state file creates none", async () => {
    const file = stateFile();
    serve(failureInputs("opportunities")[0].handler);
    expect(await run(file, T1)).toEqual({ silent: true, reason: "index-unavailable" });
    expect(existsSync(file)).toBe(false);
  });

  test("run alone, a state file that is not a JSON object is never written over", async () => {
    const file = stateFile("{not json");
    serve([row(1, "Asha")]);
    expect(await run(file, T1)).toEqual({ silent: true, reason: "state-unreadable" });
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  test("the read-only rerun picks as a real run would and writes nothing", async () => {
    const before = JSON.stringify({ [PENDING_ALERTS_KEY]: { [id(1)]: { firstSeen: T0.toISOString(), alertedAt: T0.toISOString() } } });
    const file = stateFile(before);
    serve([row(1, "Asha"), row(2, "Bilal")]);
    const result = await run(file, T1, { readOnly: true });
    if ("silent" in result) throw new Error(result.reason);
    expect(result.cards.map((c) => c.opportunityId)).toEqual([id(2)]);
    expect(readFileSync(file, "utf8")).toBe(before);
    // A first run read-only: silent, and still nothing written.
    const fresh = stateFile();
    expect(await run(fresh, T1, { readOnly: true })).toEqual({ silent: true, reason: "seeded" });
    expect(existsSync(fresh)).toBe(false);
  });

  test("no API key: silent, nothing read or written", async () => {
    const file = stateFile();
    const fake = serve([row(1, "Asha")]);
    expect(await pendingAlert({ stateFile: file, now: T1, apiKey: "", mcpUrl: FAKE_MCP_URL })).toEqual({ silent: true, reason: "no-api-key" });
    expect(fake.calls).toHaveLength(0);
    expect(existsSync(file)).toBe(false);
  });
});

describe("the ledger and the plan", () => {
  const listing = (ids: string[], complete = true) => ({ complete, pendingIds: new Set(ids) });

  test("readPendingLedger: absent or not an object is a first run; a bad entry is dropped alone", () => {
    expect(readPendingLedger({})).toBeNull();
    expect(readPendingLedger({ [PENDING_ALERTS_KEY]: [] })).toBeNull();
    expect(readPendingLedger({ [PENDING_ALERTS_KEY]: "x" })).toBeNull();
    const ok = { firstSeen: T0.toISOString(), alertedAt: null };
    expect(
      readPendingLedger({
        [PENDING_ALERTS_KEY]: { good: ok, "bad id!": ok, noSeen: { alertedAt: null }, badAlerted: { firstSeen: T0.toISOString(), alertedAt: "yesterday" } },
      }),
    ).toEqual({ good: ok });
  });

  test("a card listed with another status is not pending; a card without an id is never tracked", () => {
    const cards = [
      { name: "Asha", opportunityId: "a1", status: "accepted" },
      { name: "Bilal", status: "pending" },
      { name: "Chen", opportunityId: "c1", status: "Pending" },
    ];
    const plan = planPendingAlerts({}, cards, listing(["c1"]), T1.toISOString());
    expect(plan.due.map((d) => d.opportunityId)).toEqual(["c1"]);
    expect(Object.keys(plan.ledger)).toEqual(["c1"]);
  });

  test("the ledger is capped, alerted entries going first", () => {
    const ledger = Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`x${i}`, { firstSeen: new Date(T0.getTime() + i * 1000).toISOString(), alertedAt: T0.toISOString() }]));
    const plan = planPendingAlerts(ledger, [{ name: "Asha", opportunityId: "new1", status: "pending" }], listing([], false), T1.toISOString(), 0);
    expect(Object.keys(plan.ledger)).toHaveLength(200);
    expect(plan.ledger.new1).toEqual({ firstSeen: T1.toISOString(), alertedAt: null });
    expect(plan.ledger.x0).toBeUndefined();
  });
});

describe("respondBy: the deadline's words (DATA-430; the app's pending card uses the same)", () => {
  // 15:00 IST on Monday 2026-10-12.
  const now = new Date("2026-10-12T09:30:00Z");

  test("the same village day: `by 6:30 pm today`; another day: `by Fri 6:30 pm`", () => {
    expect(respondByText("2026-10-12T13:00:00Z", now)).toBe("by 6:30 pm today");
    expect(respondByText("2026-10-16T13:00:00Z", now)).toBe("by Fri 6:30 pm");
    // After midnight village time is the next day, even though it is the same UTC day.
    expect(respondByText("2026-10-12T19:00:00Z", now)).toBe("by Tue 12:30 am");
    expect(RESPOND_BY_WORDS.today("6:30 pm")).toBe("by 6:30 pm today");
    expect(RESPOND_BY_WORDS.otherDay("Fri", "6:30 pm")).toBe("by Fri 6:30 pm");
  });

  test("a past or present deadline, garbage or none: no words", () => {
    expect(respondByText("2026-10-12T09:00:00Z", now)).toBeNull();
    expect(respondByText(now.toISOString(), now)).toBeNull();
    expect(respondByText("soon", now)).toBeNull();
    expect(respondByText(undefined, now)).toBeNull();
    expect(respondByText(1760000000000, now)).toBeNull();
  });

  test("a card carrying a future deadline gets its words in the Script Output", () => {
    const card = { name: "Asha", opportunityId: "a1", status: "pending", respondBy: "2026-10-12T13:00:00Z" };
    const { view } = pendingView([{ card, opportunityId: "a1", firstSeen: T0.toISOString() }], now);
    expect((view as any).cards[0].respondBy).toBe("by 6:30 pm today");
  });
});
