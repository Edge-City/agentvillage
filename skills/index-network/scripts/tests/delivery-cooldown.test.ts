/**
 * The card cooldown on every delivery path, end to end against the Index fake:
 * the morning brief (prepare, then send), the opportunity drop, the evening
 * card and the afternoon follow-up's "waiting on you" list (re-showings only).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";
import { OPPORTUNITY_DELIVERY_KEY } from "../delivery-state";
import { dropOpportunity } from "../drop-opportunity";
import { sendDailyBrief } from "../send-daily-brief";
import { FAKE_MCP_URL, type ToolHandler, pagedOpportunities } from "./index-mcp-fake";
import {
  DAY0,
  JON,
  MAYA,
  type Path,
  addDays,
  briefAndSend,
  briefIds,
  cleanUp,
  drop,
  evening,
  failing,
  fileText,
  followUp,
  followUpRaw,
  list,
  newStateFile,
  oppId,
  prepare,
  prepareIds,
  readLog,
  readState,
  row,
  withIndex,
} from "./delivery-paths";

afterEach(cleanUp);

const shown = (date: string, count = 1) => ({ firstShown: date, lastShown: date, count });

/** The paths that may give a card its first showing. */
const FIRST_SHOWING_PATHS: Array<[string, Path]> = [
  ["morning brief (prepare + send)", briefAndSend],
  ["opportunity drop", drop],
  ["evening card", evening],
];

describe.each(FIRST_SHOWING_PATHS)("%s", (_label, deliver) => {
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
    expect(readLog(file)?.[MAYA]).toEqual(shown(addDays(DAY0, 2)));
  });

  test("a failed Index read changes nothing and does not reset or advance the cooldown", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0), [JON]: shown(DAY0) }, dreaming: { lastRunDate: DAY0 } });
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

  test("the same-day dedupe applies on its own: a card delivered today stays out even with an empty log", async () => {
    const file = newStateFile({ deliveredToday: { date: DAY0, ids: [MAYA] }, [OPPORTUNITY_DELIVERY_KEY]: {} });
    expect(await deliver(DAY0, file, list(row("Maya", 1), row("Jon", 2)))).toEqual([JON]);
    expect(readLog(file)?.[MAYA]).toBeUndefined();
  });
});

describe("the follow-up's waiting-on-you list: re-showings only", () => {
  test("never a card's first showing; re-shown day 3 and day 6 after a day-0 drop; never a fourth", async () => {
    const file = newStateFile();
    const maya = list(row("Maya", 1));
    expect(await followUp(DAY0, file, maya)).toEqual([]);
    expect(readLog(file)).toBeUndefined();
    expect(await drop(DAY0, file, maya)).toEqual([MAYA]);
    const shownOn: number[] = [];
    for (const day of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 20]) {
      if ((await followUp(addDays(DAY0, day), file, maya)).includes(MAYA)) shownOn.push(day);
    }
    expect(shownOn).toEqual([3, 6]);
    expect(readLog(file)?.[MAYA]).toEqual({ firstShown: DAY0, lastShown: addDays(DAY0, 6), count: 3 });
  });

  test("a card it lists joins today's deliveredToday, so the drop and the evening card skip it", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -3)) }, deliveredToday: { date: DAY0, ids: [JON] } });
    const both = list(row("Maya", 1), row("Jon", 2));
    expect(await followUp(DAY0, file, both)).toEqual([MAYA]);
    expect(readState(file).deliveredToday).toEqual({ date: DAY0, ids: [JON, MAYA] });
    expect(await drop(DAY0, file, both)).toEqual([]);
    expect(await evening(DAY0, file, both)).toEqual([]);
  });

  test("the same-day dedupe applies on its own: an eligible re-showing delivered today is not listed", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -3)) }, deliveredToday: { date: DAY0, ids: [MAYA] } });
    expect(await followUpRaw(DAY0, file, list(row("Maya", 1)))).toBe("[SILENT]");
    expect(readLog(file)?.[MAYA]).toEqual(shown(addDays(DAY0, -3)));
  });

  test("at most three, oldest last showing first; the rest stay eligible for the evening card", async () => {
    const log = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [oppId(n), shown(addDays(DAY0, -3 - n))]));
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log });
    const rows = list(...[1, 2, 3, 4, 5, 6].map((n) => row(`P${n}`, n)));
    expect(await followUp(DAY0, file, rows)).toEqual([oppId(5), oppId(4), oppId(3)]);
    expect(readLog(file)?.[oppId(2)]).toEqual(log[oppId(2)]);
    // The evening card takes the never-shown card first, the next day's drop the next re-showing.
    expect(await evening(DAY0, file, rows)).toEqual([oppId(6)]);
    expect(await drop(addDays(DAY0, 1), file, rows)).toEqual([oppId(2)]);
  });

  test("a card that leaves the pending list is forgotten and comes back as new, for the other paths", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0), [JON]: shown(DAY0) } });
    expect(await followUp(addDays(DAY0, 3), file, list(row("Jon", 2)))).toEqual([JON]);
    expect(Object.keys(readLog(file) ?? {})).toEqual([JON]);
    expect(await followUp(addDays(DAY0, 4), file, list(row("Maya", 1), row("Jon", 2)))).toEqual([]);
    expect(await drop(addDays(DAY0, 4), file, list(row("Maya", 1), row("Jon", 2)))).toEqual([MAYA]);
  });

  test("a failed Index read changes nothing", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } });
    const before = fileText(file);
    expect(await followUpRaw(addDays(DAY0, 3), file, failing)).toBe("[SILENT]");
    expect(fileText(file)).toBe(before);
    expect(await followUp(addDays(DAY0, 3), file, list(row("Maya", 1)))).toEqual([MAYA]);
  });

  test("a pending card marked negotiating is listed with the agents talking, never as waiting on you", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -3)), [JON]: shown(addDays(DAY0, -3)) } });
    const out = await followUpRaw(DAY0, file, list(row("Maya", 1, { negotiating: true }), row("Jon", 2), row("Ana", 3, { status: "negotiating" })));
    const parsed = JSON.parse(out);
    expect(parsed.needsAttention.map((c: { name: string }) => c.name)).toEqual(["Jon"]);
    expect(parsed.waiting.map((c: { name: string }) => c.name)).toEqual(["Maya", "Ana"]);
    expect(Object.keys(parsed.waiting[0]).sort()).toEqual(["headline", "name", "opportunityUrl", "summary", "userUrl"]);
    expect(readLog(file)?.[MAYA]).toEqual(shown(addDays(DAY0, -3)));
  });

  test("only negotiating cards pending: silent, as when only agents are talking", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -3)) } });
    expect(await followUpRaw(DAY0, file, list(row("Maya", 1, { negotiating: true })))).toBe("[SILENT]");
  });

  test("an accepted card is still reported while every pending card cools down", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } });
    const parsed = JSON.parse(await followUpRaw(addDays(DAY0, 1), file, list(row("Maya", 1), row("Ana", 3, { status: "accepted" }))));
    expect(parsed.needsAttention).toEqual([]);
    expect(parsed.newlyResolved.map((c: { name: string }) => c.name)).toEqual(["Ana"]);
    expect(readLog(file)?.[MAYA]?.count).toBe(1);
    expect(readState(file).deliveredToday).toBeUndefined();
  });

  test("an accepted or negotiating-status row is not pending: its entry goes on a complete read", async () => {
    const file = newStateFile({
      [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0), [JON]: shown(DAY0), [oppId(3)]: shown(DAY0) },
    });
    await followUpRaw(
      addDays(DAY0, 1),
      file,
      list(row("Maya", 1), row("Jon", 2, { status: "negotiating" }), row("Ana", 3, { status: "accepted" })),
    );
    expect(Object.keys(readLog(file) ?? {})).toEqual([MAYA]);
  });

  test("a full page (50 rows, no pagination object) may be cut short, so absent cards are kept", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`P${i}`, 100 + i));
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3), [oppId(100)]: shown(DAY0) } });
    expect(await followUp(addDays(DAY0, 3), file, list(...rows))).toEqual([oppId(100)]);
    expect(readLog(file)?.[MAYA]).toEqual(shown(DAY0, 3));
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
    expect(await followUp(addDays(DAY0, 3), file, maya)).toEqual([]);
    expect(await evening(addDays(DAY0, 3), file, maya)).toEqual([]);
    expect(readLog(file)?.[MAYA]).toEqual({ firstShown: DAY0, lastShown: addDays(DAY0, 3), count: 2 });
  });

  test("the follow-up's re-showing counts for the drops and the evening card", async () => {
    const file = newStateFile();
    const maya = list(row("Maya", 1));
    expect(await drop(DAY0, file, maya)).toEqual([MAYA]);
    expect(await followUp(addDays(DAY0, 3), file, maya)).toEqual([MAYA]);
    expect(await evening(addDays(DAY0, 3), file, maya)).toEqual([]);
    expect(await drop(addDays(DAY0, 5), file, maya)).toEqual([]);
    expect(await drop(addDays(DAY0, 6), file, maya)).toEqual([MAYA]);
    expect(await evening(addDays(DAY0, 9), file, maya)).toEqual([]);
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

describe("a card that goes pending, then negotiating, then pending again", () => {
  test("status negotiating: absent from a complete pending read, so forgotten; pending again it is new", async () => {
    const file = newStateFile();
    const pending = pagedOpportunities([row("Maya", 1)]);
    const negotiating = pagedOpportunities([row("Maya", 1, { status: "negotiating" })]);
    expect(await drop(DAY0, file, pending)).toEqual([MAYA]);
    expect(await drop(addDays(DAY0, 1), file, negotiating)).toEqual([]);
    expect(readLog(file)?.[MAYA]).toBeUndefined();
    expect(await drop(addDays(DAY0, 2), file, pending)).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]).toEqual(shown(addDays(DAY0, 2)));
  });

  test("status negotiating seen by the follow-up's read is forgotten the same way", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } });
    expect(await followUp(addDays(DAY0, 1), file, pagedOpportunities([row("Maya", 1, { status: "negotiating" })]))).toEqual([]);
    expect(readLog(file)?.[MAYA]).toBeUndefined();
  });

  test("the negotiating flag: still pending, so the entry and its clock are kept; never offered while flagged", async () => {
    const file = newStateFile();
    const plain = pagedOpportunities([row("Maya", 1)]);
    const flagged = pagedOpportunities([row("Maya", 1, { negotiating: true })]);
    expect(await drop(DAY0, file, plain)).toEqual([MAYA]);
    for (const day of [1, 2, 3, 4]) {
      expect(await drop(addDays(DAY0, day), file, flagged)).toEqual([]);
      expect(await followUp(addDays(DAY0, day), file, flagged)).toEqual([]);
    }
    expect(readLog(file)?.[MAYA]).toEqual(shown(DAY0));
    expect(await drop(addDays(DAY0, 5), file, plain)).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]).toEqual({ firstShown: DAY0, lastShown: addDays(DAY0, 5), count: 2 });
  });
});

describe("ordering", () => {
  const log = {
    [oppId(1)]: shown(addDays(DAY0, -6)),
    [oppId(3)]: { firstShown: addDays(DAY0, -9), lastShown: addDays(DAY0, -4), count: 2 },
    [oppId(5)]: shown(addDays(DAY0, -1)),
  };
  // Index's order: C(3), A(1), B(2), E(5, cooling), D(4)
  const rows = list(row("C", 3), row("A", 1), row("B", 2), row("E", 5), row("D", 4));

  test("brief: never shown first in Index's order, then the oldest showing; still capped at three", async () => {
    const context = await prepare(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows);
    expect(context.connectionOpportunities.map((opp) => opp.name)).toEqual(["B", "D", "A"]);
    expect(context.connectionsStillWaiting).toBe(1);
    expect(context.moreWaitingThanListed).toBe(false);
  });

  test("drop and evening card pick the first never-shown card; the follow-up only the re-showings", async () => {
    expect(await drop(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows)).toEqual([oppId(2)]);
    expect(await evening(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows)).toEqual([oppId(2)]);
    expect(await followUp(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), rows)).toEqual([oppId(1), oppId(3)]);
  });

  test("with nothing new, the re-showing whose last showing is oldest goes first", async () => {
    const onlyShown = list(row("C", 3), row("A", 1));
    expect(await drop(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), onlyShown)).toEqual([oppId(1)]);
    expect(await evening(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: log }), onlyShown)).toEqual([oppId(1)]);
  });
});

describe("pruning on reads", () => {
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

  test("a full page (50 rows, no pagination object) may be cut short, so absent cards are kept", async () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`P${i}`, 100 + i));
    for (const path of [drop, evening, prepareIds]) {
      const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
      expect((await path(addDays(DAY0, 1), file, list(...rows)))[0]).toBe(oppId(100));
      expect(readLog(file)?.[MAYA]).toEqual(shown(DAY0, 3));
    }
  });

  test("49 rows is a complete read: absent cards go", async () => {
    const rows = Array.from({ length: 49 }, (_, i) => row(`P${i}`, 100 + i));
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
    expect(await drop(addDays(DAY0, 1), file, list(...rows))).toEqual([oppId(100)]);
    expect(readLog(file)?.[MAYA]).toBeUndefined();
  });

  test("pagination contradicting the row count keeps absent cards; agreeing with it does not", async () => {
    const page = (pagination: unknown): ToolHandler => () =>
      `Waiting on you:\n\n${JSON.stringify({ success: true, opportunities: [row("Jon", 2)], pagination })}`;
    for (const [pagination, kept] of [
      [{ limit: 50, offset: 0, count: 25 }, true],
      [{ limit: 20, offset: 0, count: 1 }, true],
      [{ limit: 50, offset: 0, count: 1 }, false],
    ] as const) {
      const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
      expect(await drop(addDays(DAY0, 1), file, page(pagination))).toEqual([JON]);
      expect(readLog(file)?.[MAYA] !== undefined).toBe(kept);
    }
  });

  test("an entry 60 days old is forgotten, so its card is new again", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0, 3) } });
    expect(await drop(addDays(DAY0, 59), file, list(row("Maya", 1)))).toEqual([]);
    expect(await drop(addDays(DAY0, 60), file, list(row("Maya", 1)))).toEqual([MAYA]);
    expect(readLog(file)?.[MAYA]?.count).toBe(1);
  });

  test("an entry dated more than a day ahead is dropped on read, so it cannot block a card forever", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, 30), 3), [JON]: shown(addDays(DAY0, 1)) } });
    expect(await drop(DAY0, file, list(row("Maya", 1), row("Jon", 2)))).toEqual([MAYA]);
    expect(readLog(file)).toEqual({ [MAYA]: shown(DAY0), [JON]: shown(addDays(DAY0, 1)) });
  });
});

describe("every path lists 50, and the brief tells a cut-short list apart (60 old cards and one new)", () => {
  const OLD = Array.from({ length: 60 }, (_, i) => row(`Old${i}`, 100 + i));
  const NEW = row("New", 1);
  const oldLog = Object.fromEntries(OLD.map((r) => [r.id as string, shown(addDays(DAY0, -1))]));

  test("the new card beyond the page: no cards, no count, and the brief says more are waiting", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: oldLog });
    const context = await prepare(DAY0, file, pagedOpportunities([...OLD, NEW]));
    expect(context.connectionOpportunities).toEqual([]);
    expect(context.connectionsStillWaiting).toBe(0);
    expect(context.moreWaitingThanListed).toBe(true);
    expect(Object.keys(readLog(file) ?? {})).toHaveLength(60);
  });

  test("the new card inside the page reaches every first-showing path; the brief still says the list was cut short", async () => {
    const context = await prepare(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: oldLog }), pagedOpportunities([NEW, ...OLD]));
    expect(briefIds(context)).toEqual([MAYA]);
    expect(context.moreWaitingThanListed).toBe(true);
    expect(context.connectionsStillWaiting).toBe(0);
    expect(await drop(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: oldLog }), pagedOpportunities([NEW, ...OLD]))).toEqual([MAYA]);
    expect(await evening(DAY0, newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: oldLog }), pagedOpportunities([NEW, ...OLD]))).toEqual([MAYA]);
  });

  test("every path asks Index for 50", async () => {
    const limits: unknown[] = [];
    const handler = pagedOpportunities([NEW]);
    const spy: ToolHandler = (args, request) => {
      limits.push(args.limit);
      return handler(args, request);
    };
    await prepare(DAY0, newStateFile(), spy);
    await drop(DAY0, newStateFile(), spy);
    await evening(DAY0, newStateFile(), spy);
    await followUp(DAY0, newStateFile(), spy);
    expect(limits).toEqual([50, 50, 50, 50]);
  });

  test("a complete list: the count, and no cut-short flag", async () => {
    const ten = OLD.slice(0, 10);
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: Object.fromEntries(ten.map((r) => [r.id as string, shown(addDays(DAY0, -1))])) });
    const context = await prepare(DAY0, file, pagedOpportunities(ten));
    expect(context.connectionOpportunities).toEqual([]);
    expect(context.connectionsStillWaiting).toBe(10);
    expect(context.moreWaitingThanListed).toBe(false);
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

  function expectSiblings(file: string): void {
    const state = readState(file);
    for (const [key, value] of Object.entries(OLD)) {
      if (key !== "deliveredToday") expect(state[key]).toEqual(value);
    }
  }

  test("a file from before the log: today's card is not sent again on any path, and siblings survive", async () => {
    for (const path of [drop, evening]) {
      const file = newStateFile(OLD);
      expect(await path(DAY0, file, both)).toEqual([JON]);
      expectSiblings(file);
      expect(readLog(file)?.[MAYA]).toEqual(shown(DAY0));
    }
    const file = newStateFile(OLD);
    expect(await followUp(DAY0, file, both)).toEqual([]);
    expectSiblings(file);
    expect(readState(file).deliveredToday).toEqual(OLD.deliveredToday);
    expect(briefIds(await prepare(DAY0, newStateFile(OLD), both))).toEqual([JON]);
  });

  test("a file from before the log: the card the old version sent waits out its cooldown, then the follow-up may re-show it", async () => {
    const file = newStateFile(OLD);
    expect(await drop(addDays(DAY0, 1), file, list(row("Maya", 1)))).toEqual([]);
    expect(await followUp(addDays(DAY0, 3), file, list(row("Maya", 1)))).toEqual([MAYA]);
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
    expect(readLog(file)).toEqual({ [MAYA]: shown(DAY0), [JON]: shown(DAY0) });
  });

  test("a malformed map resets to empty without touching sibling keys", async () => {
    const siblings = { questionDelivery: { "q-1": DAY0 }, memorySignals: { cursor: 1 }, deliveredToday: { date: addDays(DAY0, -1), ids: [MAYA] } };
    for (const bad of ["garbage", [MAYA], null, { [MAYA]: { count: "x" } }]) {
      for (const path of [drop, evening, briefAndSend]) {
        const file = newStateFile({ ...siblings, [OPPORTUNITY_DELIVERY_KEY]: bad });
        expect(await path(DAY0, file, list(row("Maya", 1)))).toEqual([MAYA]);
        const state = readState(file);
        expect(state.questionDelivery).toEqual(siblings.questionDelivery);
        expect(state.memorySignals).toEqual(siblings.memorySignals);
        expect(readLog(file)).toEqual({ [MAYA]: shown(DAY0) });
      }
      const file = newStateFile({ ...siblings, [OPPORTUNITY_DELIVERY_KEY]: bad });
      expect(await followUp(DAY0, file, list(row("Maya", 1)))).toEqual([]);
      expect(readState(file)).toEqual({ ...siblings, [OPPORTUNITY_DELIVERY_KEY]: {} });
    }
  });
});

describe("the brief when everything pending was already shown", () => {
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
    expect(context.moreWaitingThanListed).toBe(false);
    expect(context.communityOpportunities.map((opp) => opp.name)).toEqual(["Jon"]);
  });

  test("nothing pending at all: zero still waiting", async () => {
    const context = await prepare(DAY0, newStateFile(), list());
    expect(context.connectionOpportunities).toEqual([]);
    expect(context.connectionsStillWaiting).toBe(0);
    expect(context.moreWaitingThanListed).toBe(false);
  });

  test("a failed read: zero still waiting, and the brief knows the list did not succeed", async () => {
    const file = newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -1)) } });
    const context = await prepare(DAY0, file, failing);
    expect(context.diagnostics.dreamingFresh).toBe(false);
    expect(context.connectionsStillWaiting).toBe(0);
    expect(context.moreWaitingThanListed).toBe(false);
  });

  test("the drop and the evening card stay silent; the Nov 1 closeout still comes", async () => {
    const lastDay = "2026-11-01";
    const cooling = { [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(lastDay, -1)) } };
    const maya = list(row("Maya", 1));
    expect(
      await withIndex(maya, () =>
        dropOpportunity({ date: DAY0, stateFile: newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } }), apiKey: "k", mcpUrl: FAKE_MCP_URL }),
      ),
    ).toEqual({ silent: true, reason: "nothing-new" });
    expect(
      await withIndex(maya, () => askQuestions({ date: DAY0, stateFile: newStateFile({ [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(DAY0) } }), apiKey: "k" })),
    ).toEqual({ silent: true, reason: "nothing-waiting" });
    const file = newStateFile(cooling);
    const closeout = await withIndex(maya, () => askQuestions({ date: lastDay, stateFile: file, apiKey: "k" }));
    expect(closeout).toEqual({
      prompt: "Quick closeout check: did AgentVillage help you meet, message, or better understand anyone this week? Reply with one sentence.",
    });
    expect(readLog(file)).toEqual(cooling[OPPORTUNITY_DELIVERY_KEY]);
  });
});

describe("a slow Index call never writes back a stale state copy", () => {
  for (const [label, path] of [["evening card", evening], ["drop", drop], ["follow-up", followUp]] as const) {
    test(label, async () => {
      const log = { [OPPORTUNITY_DELIVERY_KEY]: { [MAYA]: shown(addDays(DAY0, -3)) } };
      const file = newStateFile({ memorySignals: { cursor: 1 }, ...log });
      const slow: ToolHandler = async (args, request) => {
        // Another script writes while the list call is in flight.
        await Bun.write(file, JSON.stringify({ memorySignals: { cursor: 2 }, questionDelivery: { "q-9": DAY0 }, ...log }));
        return list(row("Maya", 1))(args, request);
      };
      expect(await path(DAY0, file, slow)).toEqual([MAYA]);
      const state = readState(file);
      expect(state.memorySignals).toEqual({ cursor: 2 });
      expect(state.questionDelivery).toEqual({ "q-9": DAY0 });
    });
  }
});
