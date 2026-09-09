import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type NegotiationItem,
  summarizeNegotiations,
  updatedWithinDays,
} from "../summarize-negotiations";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date().toISOString();
const EIGHT_DAYS_AGO = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

function makeNegotiation(overrides: Partial<NegotiationItem> = {}): NegotiationItem {
  return {
    id: "aaaaaaaa-0000-0000-0000-000000000001",
    opportunityId: "opp-1",
    intentId: "intent-1",
    awaitingUserId: "user-a",
    turnCount: 2,
    createdAt: NOW,
    updatedAt: NOW,
    counterparty: { userId: "user-b", intentId: "intent-b", name: "Ada", statement: "AI safety research" },
    turns: [
      { turnIndex: 0, seatUserId: "user-a", action: "propose", message: "Interested in your AI safety work.", createdAt: NOW },
      { turnIndex: 1, seatUserId: "user-b", action: "counter", message: "Happy to explore. What specifically?", createdAt: NOW },
    ],
    protocol: { availableActions: ["counter", "accept", "decline"], blockedReason: null, maxTurns: 12, messageLimit: 4000 },
    outcome: null,
    settledAt: null,
    ...overrides,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const originalCwd = process.cwd();

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "summarize-negotiations-"));
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  const cwd = process.cwd();
  process.chdir(originalCwd);
  if (cwd !== originalCwd && cwd.includes("summarize-negotiations-")) {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ── updatedWithinDays ─────────────────────────────────────────────────────────

describe("updatedWithinDays", () => {
  test("returns true for a timestamp updated just now", () => {
    expect(updatedWithinDays(NOW, 7)).toBe(true);
  });

  test("returns false for a timestamp updated 8 days ago with a 7-day window", () => {
    expect(updatedWithinDays(EIGHT_DAYS_AGO, 7)).toBe(false);
  });

  test("returns true for a timestamp at exactly the boundary (just inside)", () => {
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
    expect(updatedWithinDays(sixDaysAgo, 7)).toBe(true);
  });
});

// ── summarizeNegotiations ─────────────────────────────────────────────────────

describe("summarizeNegotiations", () => {
  test("returns silent when the fetcher throws (non-fatal CLI failure)", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => { throw new Error("CLI unreachable"); },
      stateFile: "state.json",
    });

    expect(result).toEqual({ silent: true, reason: "cli-fetch-failed" });
  });

  test("returns silent when there are no negotiations at all", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [],
      stateFile: "state.json",
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
  });

  test("returns silent when all negotiations are completed and already reported", async () => {
    tempWorkspace();
    const neg = makeNegotiation({ settledAt: NOW, outcome: "agreed" });
    await Bun.write("state.json", JSON.stringify({
      negotiationSummary: { reportedCompletedIds: [neg.id] },
    }));

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
  });

  test("returns silent when completed negotiations are older than recentDays", async () => {
    tempWorkspace();
    const neg = makeNegotiation({
      settledAt: NOW,
      updatedAt: EIGHT_DAYS_AGO,
    });
    await Bun.write("state.json", "{}");

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      recentDays: 7,
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
  });

  test("places open actionable negotiations in needsAttention", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ settledAt: null });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.needsAttention).toHaveLength(1);
    expect(result.context.needsAttention[0].id).toBe(neg.id);
    expect(result.context.waiting).toHaveLength(0);
    expect(result.context.newlyResolved).toHaveLength(0);
  });

  test("returns silent when only open blocked negotiations are waiting", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ settledAt: null, protocol: { availableActions: [], blockedReason: "not_your_turn", maxTurns: 12, messageLimit: 4000 } });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
  });

  test("includes open blocked negotiations as context when another item is actionable", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const attention = makeNegotiation({ id: "aaa-1", settledAt: null });
    const waiting = makeNegotiation({ id: "aaa-2", settledAt: null, protocol: { availableActions: [], blockedReason: "not_your_turn", maxTurns: 12, messageLimit: 4000 } });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [attention, waiting],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.needsAttention).toHaveLength(1);
    expect(result.context.waiting).toHaveLength(1);
    expect(result.context.waiting[0].id).toBe(waiting.id);
  });

  test("surfaces recently completed negotiations not yet reported", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({
      settledAt: NOW,
      updatedAt: NOW,
      outcome: "agreed",
    });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      recentDays: 7,
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.newlyResolved).toHaveLength(1);
    expect(result.context.newlyResolved[0].id).toBe(neg.id);
    expect(result.context.newlyResolved[0].outcome).toBe("agreed");
  });

  test("returns silent for recently completed negotiations that produced no opportunity", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({
      settledAt: NOW,
      updatedAt: NOW,
      outcome: "declined",
    });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      recentDays: 7,
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
  });

  test("persists newly reported completed IDs to the state file", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      negotiationSummary: { reportedCompletedIds: ["old-id"] },
    }));
    const neg = makeNegotiation({ id: "bbbbbbbb-0000-0000-0000-000000000002", settledAt: NOW, outcome: "agreed", updatedAt: NOW });

    await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      recentDays: 7,
    });

    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.negotiationSummary.reportedCompletedIds).toContain("old-id");
    expect(state.negotiationSummary.reportedCompletedIds).toContain(neg.id);
  });

  test("preserves sibling state keys when updating negotiationSummary", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-17", taskId: "t_digest" },
      deliveredToday: { date: "2026-06-17", ids: ["opp-1"] },
    }));
    const neg = makeNegotiation({ settledAt: null });

    await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.prepared).toEqual({ date: "2026-06-17", taskId: "t_digest" });
    expect(state.deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-1"] });
  });

  test("does not mutate state when returning silent (no negotiations)", async () => {
    tempWorkspace();
    const initial = { prepared: { date: "2026-06-17", taskId: "t_digest" } };
    await Bun.write("state.json", JSON.stringify(initial));

    await summarizeNegotiations({
      fetchNegotiations: async () => [],
      stateFile: "state.json",
    });

    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state).toEqual(initial);
  });

  test("does not mutate state when returning silent (CLI failure)", async () => {
    tempWorkspace();
    const initial = { prepared: { date: "2026-06-17", taskId: "t_digest" } };
    await Bun.write("state.json", JSON.stringify(initial));

    await summarizeNegotiations({
      fetchNegotiations: async () => { throw new Error("CLI unreachable"); },
      stateFile: "state.json",
    });

    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state).toEqual(initial);
  });

  test("narrative fields are passed through to the context output", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({
      settledAt: null,
      turns: [
        { turnIndex: 0, seatUserId: "user-a", action: "propose", message: "Interested in your work.", createdAt: NOW },
      ],
    });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    const item = result.context.needsAttention[0];
    expect(item.counterparty.name).toBe("Ada");
    expect(item.turns).toHaveLength(1);
    expect(item.turns[0].action).toBe("propose");
  });

  test("handles missing state file gracefully (treats as empty)", async () => {
    tempWorkspace();
    // No state.json written — file does not exist
    const neg = makeNegotiation({ settledAt: null });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
  });

  test("defaults signals to empty and preserves the server counterparty", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ settledAt: null });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.signals).toEqual([]);
    expect(result.context.needsAttention[0].counterparty.name).toBe("Ada");
  });

  test("includes fetched signals in the context output", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ settledAt: null });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      fetchSignals: async () => [
        { id: "sig-1", summary: "Looking for AI safety collaborators." },
        { id: "sig-2", summary: "Exploring frontier compute access." },
      ],
    });

    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.signals).toHaveLength(2);
    expect(result.context.signals[0].summary).toBe("Looking for AI safety collaborators.");
  });

  test("degrades to empty signals when the signal fetcher throws", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ settledAt: null });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      fetchSignals: async () => { throw new Error("intents unreachable"); },
    });

    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.signals).toEqual([]);
    expect(result.context.needsAttention).toHaveLength(1);
  });

  test("does not fetch signals on a silent run", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    let signalCalls = 0;

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [],
      stateFile: "state.json",
      fetchSignals: async () => { signalCalls++; return []; },
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
    expect(signalCalls).toBe(0);
  });

  test("mixed bag: categorises correctly across all three groups", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");

    const attention = makeNegotiation({ id: "aaa-1", settledAt: null });
    const waiting = makeNegotiation({ id: "aaa-2", settledAt: null, protocol: { availableActions: [], blockedReason: "not_your_turn", maxTurns: 12, messageLimit: 4000 } });
    const resolved = makeNegotiation({ id: "aaa-3", settledAt: NOW, outcome: "agreed", updatedAt: NOW });
    const alreadyReported = makeNegotiation({ id: "aaa-4", settledAt: NOW, outcome: "agreed", updatedAt: NOW });
    const stale = makeNegotiation({ id: "aaa-5", settledAt: NOW, outcome: "agreed", updatedAt: EIGHT_DAYS_AGO });

    await Bun.write("state.json", JSON.stringify({
      negotiationSummary: { reportedCompletedIds: [alreadyReported.id] },
    }));

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [attention, waiting, resolved, alreadyReported, stale],
      stateFile: "state.json",
      recentDays: 7,
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.needsAttention.map((n) => n.id)).toEqual(["aaa-1"]);
    expect(result.context.waiting.map((n) => n.id)).toEqual(["aaa-2"]);
    expect(result.context.newlyResolved.map((n) => n.id)).toEqual(["aaa-3"]);
  });
});
