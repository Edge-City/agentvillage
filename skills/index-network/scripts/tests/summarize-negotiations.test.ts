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
    counterpartyId: "user-b",
    role: "source",
    turnCount: 2,
    status: "active",
    isUsersTurn: true,
    isContinuation: false,
    priorTurnCount: 0,
    latestAction: "propose",
    latestMessagePreview: "Looking forward to exploring overlap.",
    createdAt: NOW,
    updatedAt: NOW,
    indexContext: { networkId: "net-1", prompt: "A community for frontier AI researchers." },
    recentTurns: [
      { turnNumber: 1, speaker: "source", role: "own", action: "propose", message: "Interested in your AI safety work." },
      { turnNumber: 2, speaker: "candidate", role: "other", action: "counter", message: "Happy to explore. What specifically?" },
    ],
    outcome: null,
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
  test("returns silent when the fetcher throws (non-fatal MCP failure)", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => { throw new Error("MCP unreachable"); },
      stateFile: "state.json",
    });

    expect(result).toEqual({ silent: true, reason: "mcp-fetch-failed" });
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
    const neg = makeNegotiation({ status: "completed", isUsersTurn: false });
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
      status: "completed",
      isUsersTurn: false,
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

  test("places active + isUsersTurn negotiations in needsAttention", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ status: "active", isUsersTurn: true });

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

  test("places active + !isUsersTurn negotiations in waiting", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ status: "active", isUsersTurn: false });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.waiting).toHaveLength(1);
    expect(result.context.waiting[0].id).toBe(neg.id);
    expect(result.context.needsAttention).toHaveLength(0);
  });

  test("places waiting_for_agent + isUsersTurn in needsAttention", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ status: "waiting_for_agent", isUsersTurn: true });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.needsAttention).toHaveLength(1);
  });

  test("surfaces recently completed negotiations not yet reported", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({
      status: "completed",
      isUsersTurn: false,
      updatedAt: NOW,
      outcome: { hasOpportunity: true, reasoning: "Strong alignment found.", turnCount: 4 },
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
    expect(result.context.newlyResolved[0].outcome?.hasOpportunity).toBe(true);
  });

  test("persists newly reported completed IDs to the state file", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      negotiationSummary: { reportedCompletedIds: ["old-id"] },
    }));
    const neg = makeNegotiation({ id: "bbbbbbbb-0000-0000-0000-000000000002", status: "completed", isUsersTurn: false, updatedAt: NOW });

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
    const neg = makeNegotiation({ status: "active", isUsersTurn: true });

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

  test("does not mutate state when returning silent (MCP failure)", async () => {
    tempWorkspace();
    const initial = { prepared: { date: "2026-06-17", taskId: "t_digest" } };
    await Bun.write("state.json", JSON.stringify(initial));

    await summarizeNegotiations({
      fetchNegotiations: async () => { throw new Error("MCP unreachable"); },
      stateFile: "state.json",
    });

    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state).toEqual(initial);
  });

  test("narrative fields are passed through to the context output", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({
      status: "active",
      isUsersTurn: true,
      indexContext: { networkId: "net-1", prompt: "Frontier AI research community." },
      recentTurns: [
        { turnNumber: 1, speaker: "source", role: "own", action: "propose", message: "Interested in your work." },
      ],
    });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent");
    const item = result.context.needsAttention[0];
    expect(item.indexContext?.prompt).toBe("Frontier AI research community.");
    expect(item.recentTurns).toHaveLength(1);
    expect(item.recentTurns[0].action).toBe("propose");
  });

  test("handles missing state file gracefully (treats as empty)", async () => {
    tempWorkspace();
    // No state.json written — file does not exist
    const neg = makeNegotiation({ status: "active", isUsersTurn: true });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect("silent" in result).toBe(false);
  });

  test("mixed bag: categorises correctly across all three groups", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");

    const attention = makeNegotiation({ id: "aaa-1", status: "active", isUsersTurn: true });
    const waiting = makeNegotiation({ id: "aaa-2", status: "active", isUsersTurn: false });
    const resolved = makeNegotiation({ id: "aaa-3", status: "completed", isUsersTurn: false, updatedAt: NOW });
    const alreadyReported = makeNegotiation({ id: "aaa-4", status: "completed", isUsersTurn: false, updatedAt: NOW });
    const stale = makeNegotiation({ id: "aaa-5", status: "completed", isUsersTurn: false, updatedAt: EIGHT_DAYS_AGO });

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
