import { describe, expect, test } from "bun:test";

import type { BriefOpportunity } from "../build-daily-brief-context";
import {
  COOLDOWN_DAYS,
  MAX_ENTRIES,
  MAX_ENTRY_AGE_DAYS,
  MAX_SHOWINGS,
  OPPORTUNITY_DELIVERY_KEY,
  type DeliveryLog,
  applyCooldown,
  awaitsResident,
  deliveryLogChanged,
  isEligible,
  pendingListing,
  pruneDeliveryLog,
  readDeliveryLog,
  recordShowings,
} from "../delivery-state";

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

const DAY0 = "2026-10-12";

function card(id: string, extra: Partial<BriefOpportunity> = {}): BriefOpportunity {
  return { name: id, opportunityId: id, feedCategory: "connection", status: "pending", ...extra };
}

describe("the rule's numbers", () => {
  test("are 3 days and 3 showings, in one place", () => {
    expect(COOLDOWN_DAYS).toBe(3);
    expect(MAX_SHOWINGS).toBe(3);
    expect(OPPORTUNITY_DELIVERY_KEY).toBe("opportunityDelivery");
  });
});

describe("isEligible", () => {
  test("a card never shown is eligible", () => {
    expect(isEligible(undefined, DAY0)).toBe(true);
  });

  test("shown day 0: not eligible days 0, 1 and 2; eligible day 3", () => {
    const shown = { firstShown: DAY0, lastShown: DAY0, count: 1 };
    expect(isEligible(shown, DAY0)).toBe(false);
    expect(isEligible(shown, addDays(DAY0, 1))).toBe(false);
    expect(isEligible(shown, addDays(DAY0, 2))).toBe(false);
    expect(isEligible(shown, addDays(DAY0, 3))).toBe(true);
    expect(isEligible(shown, addDays(DAY0, 30))).toBe(true);
  });

  test("the cooldown runs from the LAST showing, not the first", () => {
    const shown = { firstShown: DAY0, lastShown: addDays(DAY0, 3), count: 2 };
    expect(isEligible(shown, addDays(DAY0, 5))).toBe(false);
    expect(isEligible(shown, addDays(DAY0, 6))).toBe(true);
  });

  test("a third showing is allowed; never a fourth", () => {
    expect(isEligible({ firstShown: DAY0, lastShown: DAY0, count: 2 }, addDays(DAY0, 3))).toBe(true);
    expect(isEligible({ firstShown: DAY0, lastShown: DAY0, count: 3 }, addDays(DAY0, 3))).toBe(false);
    expect(isEligible({ firstShown: DAY0, lastShown: DAY0, count: 3 }, addDays(DAY0, 59))).toBe(false);
    expect(isEligible({ firstShown: DAY0, lastShown: DAY0, count: 4 }, addDays(DAY0, 59))).toBe(false);
  });

  test("a last showing dated after today (clock skew) is not eligible", () => {
    expect(isEligible({ firstShown: DAY0, lastShown: addDays(DAY0, 1), count: 1 }, DAY0)).toBe(false);
  });

  test("the cooldown crosses a month end", () => {
    const shown = { firstShown: "2026-10-30", lastShown: "2026-10-30", count: 1 };
    expect(isEligible(shown, "2026-11-01")).toBe(false);
    expect(isEligible(shown, "2026-11-02")).toBe(true);
  });
});

describe("recordShowings", () => {
  test("first, second and third showings; the same day twice counts once", () => {
    let log: DeliveryLog = {};
    log = recordShowings(log, ["a"], DAY0);
    expect(log).toEqual({ a: { firstShown: DAY0, lastShown: DAY0, count: 1 } });
    expect(recordShowings(log, ["a"], DAY0)).toEqual(log);
    log = recordShowings(log, ["a"], addDays(DAY0, 3));
    log = recordShowings(log, ["a"], addDays(DAY0, 6));
    expect(log).toEqual({ a: { firstShown: DAY0, lastShown: addDays(DAY0, 6), count: 3 } });
  });

  test("does not change the log it was given", () => {
    const log: DeliveryLog = { a: { firstShown: DAY0, lastShown: DAY0, count: 1 } };
    const before = JSON.stringify(log);
    recordShowings(log, ["a", "b"], addDays(DAY0, 3));
    expect(JSON.stringify(log)).toBe(before);
  });

  test("an id that is not a valid id, or __proto__ inherited, is never recorded or read through", () => {
    const log = recordShowings({}, ["../x", "has space", ""], DAY0);
    expect(log).toEqual({});
    const proto = recordShowings({}, ["__proto__"], DAY0);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.hasOwn(proto, "__proto__")).toBe(true);
    expect(applyCooldown([card("constructor")], {}, DAY0).eligible).toHaveLength(1);
  });
});

describe("readDeliveryLog", () => {
  test("a state file from before the log: today's deliveredToday ids count as shown once today", () => {
    const state = {
      deliveredToday: { date: DAY0, ids: ["a", "b", 7] },
      questionDelivery: { q: DAY0 },
      pendingDeliveryConfirms: ["a"],
    };
    expect(readDeliveryLog(state)).toEqual({
      a: { firstShown: DAY0, lastShown: DAY0, count: 1 },
      b: { firstShown: DAY0, lastShown: DAY0, count: 1 },
    });
  });

  test("no deliveredToday, or a malformed one, reads as empty", () => {
    expect(readDeliveryLog({})).toEqual({});
    expect(readDeliveryLog({ deliveredToday: "x" })).toEqual({});
    expect(readDeliveryLog({ deliveredToday: { date: "yesterday", ids: ["a"] } })).toEqual({});
    expect(readDeliveryLog({ deliveredToday: { date: DAY0 } })).toEqual({});
  });

  test("a malformed map reads as empty, and deliveredToday is then not used", () => {
    for (const bad of [null, "x", 3, [], [{ a: 1 }], true]) {
      expect(readDeliveryLog({ [OPPORTUNITY_DELIVERY_KEY]: bad, deliveredToday: { date: DAY0, ids: ["a"] } })).toEqual({});
    }
  });

  test("a malformed entry is dropped alone", () => {
    const good = { firstShown: DAY0, lastShown: DAY0, count: 2 };
    const state = {
      [OPPORTUNITY_DELIVERY_KEY]: {
        good,
        noCount: { firstShown: DAY0, lastShown: DAY0 },
        zero: { firstShown: DAY0, lastShown: DAY0, count: 0 },
        fraction: { firstShown: DAY0, lastShown: DAY0, count: 1.5 },
        stringCount: { firstShown: DAY0, lastShown: DAY0, count: "2" },
        badDate: { firstShown: "2026-02-30", lastShown: DAY0, count: 1 },
        reversed: { firstShown: addDays(DAY0, 1), lastShown: DAY0, count: 1 },
        notObject: "x",
        "bad id": good,
      },
    };
    expect(readDeliveryLog(state)).toEqual({ good });
  });
});

describe("awaitsResident and applyCooldown", () => {
  test("negotiating: true is not waiting on the resident: neither eligible nor held", () => {
    expect(awaitsResident(card("a"))).toBe(true);
    expect(awaitsResident(card("a", { negotiating: true }))).toBe(false);
    const result = applyCooldown([card("a", { negotiating: true }), card("b")], {}, DAY0);
    expect(result.eligible.map((c) => c.opportunityId)).toEqual(["b"]);
    expect(result.held).toEqual([]);
  });

  test("never shown first in the given order, then re-showings oldest last showing first; the rest held", () => {
    const log: DeliveryLog = {
      a: { firstShown: addDays(DAY0, -6), lastShown: addDays(DAY0, -6), count: 1 },
      c: { firstShown: addDays(DAY0, -9), lastShown: addDays(DAY0, -4), count: 2 },
      e: { firstShown: addDays(DAY0, -1), lastShown: addDays(DAY0, -1), count: 1 },
      f: { firstShown: addDays(DAY0, -20), lastShown: addDays(DAY0, -10), count: 3 },
      g: { firstShown: addDays(DAY0, -8), lastShown: addDays(DAY0, -8), count: 1 },
    };
    const cards = ["c", "a", "b", "e", "f", "d", "g"].map((id) => card(id));
    const { eligible, held } = applyCooldown(cards, log, DAY0);
    expect(eligible.map((c) => c.opportunityId)).toEqual(["b", "d", "g", "a", "c"]);
    expect(held.map((c) => c.opportunityId)).toEqual(["e", "f"]);
  });

  test("a card without an id stays eligible, as before the rule", () => {
    expect(applyCooldown([{ name: "No Id" }], {}, DAY0).eligible).toHaveLength(1);
  });
});

describe("pruneDeliveryLog", () => {
  const entry = (lastShown: string, count = 1) => ({ firstShown: lastShown, lastShown, count });

  test("a complete listing drops entries for cards no longer pending", () => {
    const log = { a: entry(DAY0), b: entry(DAY0) };
    expect(pruneDeliveryLog(log, DAY0, { complete: true, pendingIds: new Set(["a"]) })).toEqual({ a: entry(DAY0) });
  });

  test("a cut-short listing, or none, never drops an entry for being absent", () => {
    const log = { a: entry(DAY0), b: entry(DAY0) };
    expect(pruneDeliveryLog(log, DAY0, { complete: false, pendingIds: new Set(["a"]) })).toEqual(log);
    expect(pruneDeliveryLog(log, DAY0, null)).toEqual(log);
  });

  test(`an entry last shown ${MAX_ENTRY_AGE_DAYS} days ago or more goes; one day younger stays`, () => {
    const log = {
      old: entry(addDays(DAY0, -MAX_ENTRY_AGE_DAYS)),
      young: entry(addDays(DAY0, -(MAX_ENTRY_AGE_DAYS - 1)), 3),
      future: entry(addDays(DAY0, 2)),
    };
    expect(Object.keys(pruneDeliveryLog(log, DAY0, null))).toEqual(["young", "future"]);
  });

  test(`the log never holds more than ${MAX_ENTRIES} entries, oldest dropped first`, () => {
    const log: DeliveryLog = {};
    for (let i = 0; i < MAX_ENTRIES + 5; i++) log[`id${i}`] = entry(addDays(DAY0, -(i % 50)));
    const pruned = pruneDeliveryLog(log, DAY0, null);
    expect(Object.keys(pruned)).toHaveLength(MAX_ENTRIES);
    const kept = Object.values(pruned).map((s) => s.lastShown);
    const dropped = Object.keys(log).filter((id) => !Object.hasOwn(pruned, id)).map((id) => log[id].lastShown);
    expect(dropped).toHaveLength(5);
    for (const d of dropped) for (const k of kept) expect(d <= k).toBe(true);
  });

  test("over the cap, entries absent from a cut-short listing (finished) go before older pending ones", () => {
    const log: DeliveryLog = {};
    for (let i = 0; i < MAX_ENTRIES; i++) log[`p${i}`] = entry(addDays(DAY0, -40));
    log.finishedNew = entry(DAY0);
    log.finishedNewer = entry(DAY0);
    const pendingIds = new Set(Object.keys(log).filter((id) => id.startsWith("p")));
    const pruned = pruneDeliveryLog(log, DAY0, { complete: false, pendingIds });
    expect(Object.keys(pruned)).toHaveLength(MAX_ENTRIES);
    expect("finishedNew" in pruned || "finishedNewer" in pruned).toBe(false);
  });
});

describe("pendingListing", () => {
  test("complete only when fewer rows came back than asked for and pagination reports no more", () => {
    expect(pendingListing({ pendingIds: ["a"], rowCount: 1, requestedLimit: 20 }).complete).toBe(true);
    expect(pendingListing({ pendingIds: [], rowCount: 0, requestedLimit: 20, pagination: { page: 1, limit: 20, total: 0 } }).complete).toBe(true);
    expect(pendingListing({ pendingIds: ["a"], rowCount: 20, requestedLimit: 20 }).complete).toBe(false);
    expect(pendingListing({ pendingIds: ["a"], rowCount: 5, requestedLimit: 20, pagination: { total: 30 } }).complete).toBe(false);
  });
});

describe("deliveryLogChanged", () => {
  test("no key and nothing to write is no change; anything else compares the stored value", () => {
    expect(deliveryLogChanged({}, {})).toBe(false);
    expect(deliveryLogChanged({}, { a: { firstShown: DAY0, lastShown: DAY0, count: 1 } })).toBe(true);
    expect(deliveryLogChanged({ [OPPORTUNITY_DELIVERY_KEY]: {} }, {})).toBe(false);
    expect(deliveryLogChanged({ [OPPORTUNITY_DELIVERY_KEY]: "x" }, {})).toBe(true);
  });
});
