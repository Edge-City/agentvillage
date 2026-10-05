import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IndexMcpError } from "../index-mcp";
import {
  type NegotiationItem,
  failureCode,
  main,
  summarizeNegotiations,
  updatedWithinDays,
} from "../summarize-negotiations";
import { FAKE_MCP_URL, type ToolHandler, indexMcpFake, listOpportunitiesText } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";
import { pinDeliveryClock } from "./pin-clock";

pinDeliveryClock();

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

describe("F14: failures are logged as codes, never messages", () => {
  test("failureCode: an Index error's code, else the error's class", () => {
    expect(failureCode(new IndexMcpError("mcp-tool-error"))).toBe("mcp-tool-error");
    expect(failureCode(new IndexMcpError("mcp-http-503"))).toBe("mcp-http-503");
    expect(failureCode(new TypeError("secret detail https://evil.example"))).toBe("TypeError");
    expect(failureCode("a string")).toBe("string");
  });

  test("a fetch that throws with a message writes only its class to stderr", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    let err = "";
    const write = process.stderr.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    try {
      await summarizeNegotiations({
        fetchNegotiations: async () => { throw new Error("secret detail from the server"); },
        stateFile: "state.json",
      });
    } finally {
      process.stderr.write = write;
    }
    expect(err).toBe("negotiation-summary: MCP fetch failed — Error\n");
  });
});

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

  test("returns silent when only active + !isUsersTurn negotiations are waiting", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ status: "active", isUsersTurn: false });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
  });

  test("includes active + !isUsersTurn negotiations as context when another item is actionable", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const attention = makeNegotiation({ id: "aaa-1", status: "active", isUsersTurn: true });
    const waiting = makeNegotiation({ id: "aaa-2", status: "active", isUsersTurn: false });

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

  test("returns silent for recently completed negotiations that produced no opportunity", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({
      status: "completed",
      isUsersTurn: false,
      updatedAt: NOW,
      outcome: { hasOpportunity: false, reasoning: "No strong overlap.", turnCount: 4 },
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
    const neg = makeNegotiation({
      id: "bbbbbbbb-0000-0000-0000-000000000002",
      status: "completed",
      isUsersTurn: false,
      updatedAt: NOW,
      outcome: { hasOpportunity: true, reasoning: "Strong alignment found.", turnCount: 4 },
    });

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

  test("defaults signals to empty and leaves names unresolved when no enrichers passed", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ status: "active", isUsersTurn: true });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
    });

    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.signals).toEqual([]);
    expect(result.context.needsAttention[0].counterpartyName).toBeUndefined();
  });

  test("includes fetched signals in the context output", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const neg = makeNegotiation({ status: "active", isUsersTurn: true });

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
    const neg = makeNegotiation({ status: "active", isUsersTurn: true });

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [neg],
      stateFile: "state.json",
      fetchSignals: async () => { throw new Error("intents unreachable"); },
    });

    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.signals).toEqual([]);
    expect(result.context.needsAttention).toHaveLength(1);
  });

  test("resolves counterparty names across all reported buckets, deduping calls", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    const a = makeNegotiation({ id: "aaa-1", counterpartyId: "user-x", status: "active", isUsersTurn: true });
    const b = makeNegotiation({ id: "aaa-2", counterpartyId: "user-y", status: "active", isUsersTurn: false });
    const c = makeNegotiation({
      id: "aaa-3",
      counterpartyId: "user-x",
      status: "completed",
      isUsersTurn: false,
      updatedAt: NOW,
      outcome: { hasOpportunity: true, reasoning: "Strong alignment found.", turnCount: 4 },
    });

    const calls: string[] = [];
    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [a, b, c],
      stateFile: "state.json",
      recentDays: 7,
      resolveProfile: async (userId) => {
        calls.push(userId);
        return userId === "user-x" ? "Ada Lovelace" : null;
      },
    });

    if ("silent" in result) throw new Error("unexpected silent");
    expect(result.context.needsAttention[0].counterpartyName).toBe("Ada Lovelace");
    expect(result.context.waiting[0].counterpartyName).toBeNull();
    expect(result.context.newlyResolved[0].counterpartyName).toBe("Ada Lovelace");
    // user-x appears twice but is resolved once (dedup by id)
    expect(calls.sort()).toEqual(["user-x", "user-y"]);
  });

  test("does not fetch signals or resolve names on a silent run", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");
    let signalCalls = 0;
    let profileCalls = 0;

    const result = await summarizeNegotiations({
      fetchNegotiations: async () => [],
      stateFile: "state.json",
      fetchSignals: async () => { signalCalls++; return []; },
      resolveProfile: async () => { profileCalls++; return null; },
    });

    expect(result).toEqual({ silent: true, reason: "nothing-to-report" });
    expect(signalCalls).toBe(0);
    expect(profileCalls).toBe(0);
  });

  test("mixed bag: categorises correctly across all three groups", async () => {
    tempWorkspace();
    await Bun.write("state.json", "{}");

    const attention = makeNegotiation({ id: "aaa-1", status: "active", isUsersTurn: true });
    const waiting = makeNegotiation({ id: "aaa-2", status: "active", isUsersTurn: false });
    const resolved = makeNegotiation({
      id: "aaa-3",
      status: "completed",
      isUsersTurn: false,
      updatedAt: NOW,
      outcome: { hasOpportunity: true, reasoning: "Strong alignment found.", turnCount: 4 },
    });
    const alreadyReported = makeNegotiation({
      id: "aaa-4",
      status: "completed",
      isUsersTurn: false,
      updatedAt: NOW,
      outcome: { hasOpportunity: true, reasoning: "Already reported.", turnCount: 3 },
    });
    const stale = makeNegotiation({
      id: "aaa-5",
      status: "completed",
      isUsersTurn: false,
      updatedAt: EIGHT_DAYS_AGO,
      outcome: { hasOpportunity: true, reasoning: "Too old.", turnCount: 3 },
    });

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

// ── main(): the live follow-up path ───────────────────────────────────────────

describe("main", () => {
  const saved = { key: process.env.INDEX_API_KEY, url: process.env.INDEX_MCP_URL, argv: process.argv, fetch: globalThis.fetch };

  afterEach(() => {
    if (saved.key === undefined) delete process.env.INDEX_API_KEY;
    else process.env.INDEX_API_KEY = saved.key;
    if (saved.url === undefined) delete process.env.INDEX_MCP_URL;
    else process.env.INDEX_MCP_URL = saved.url;
    process.argv = saved.argv;
    globalThis.fetch = saved.fetch;
  });

  function opp(name: string, status: string, n: number) {
    const id = `bbbbbbbb-0000-4000-8000-00000000000${n}`;
    const userId = `cccccccc-0000-4000-8000-00000000000${n}`;
    return {
      id,
      url: `https://index.network/o/${id}`,
      status,
      viewerRole: "party",
      headline: `${name} headline`,
      summary: `${name} summary`,
      peer: { name, userId, url: `https://index.network/u/${userId}` },
    };
  }

  // The follow-up lists only re-showings: cards already shown, now past their cooldown.
  const DATE = "2026-10-12";
  const MAYA_SHOWN = JSON.stringify({
    opportunityDelivery: { "bbbbbbbb-0000-4000-8000-000000000001": { firstShown: "2026-10-09", lastShown: "2026-10-09", count: 1 } },
  });

  async function run(tools: Record<string, ToolHandler>, state?: string) {
    tempWorkspace();
    if (state !== undefined) await Bun.write("state.json", state);
    process.env.INDEX_API_KEY = "test-key";
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    process.argv = [...saved.argv.slice(0, 2), "--state-file", "state.json", "--date", DATE];
    const fake = indexMcpFake({ tools });
    globalThis.fetch = fake.fetch;
    let out = "";
    let err = "";
    const write = { out: process.stdout.write, err: process.stderr.write };
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
    try {
      await main();
    } finally {
      process.stdout.write = write.out;
      process.stderr.write = write.err;
    }
    return { out, err, fake };
  }

  test("lists opportunities and signals through the current revision and groups the cards", async () => {
    const { out, fake } = await run({
      list_opportunities: () => listOpportunitiesText([opp("Maya", "pending", 1), opp("Jon", "negotiating", 2), opp("Ana", "accepted", 3)]),
    }, MAYA_SHOWN);
    expect(fake.calls.map((call) => [call.method, call.name, call.arguments, call.status])).toEqual([
      ["tools/call", "list_opportunities", { statuses: ["pending", "negotiating", "accepted"], limit: 50 }, 200],
      ["tools/call", "list_intents", { limit: 20 }, 200],
    ]);
    const parsed = JSON.parse(out);
    expect(parsed.signals).toEqual([
      { summary: "Looking for people building agent memory", url: "https://index.network/i/aaaaaaaa-0000-4000-8000-000000000001" },
      { summary: "Open to co-hosting a village dinner", url: "https://index.network/i/aaaaaaaa-0000-4000-8000-000000000002" },
    ]);
    expect(parsed.needsAttention.map((card: { name: string }) => card.name)).toEqual(["Maya"]);
    expect(parsed.waiting.map((card: { name: string }) => card.name)).toEqual(["Jon"]);
    expect(parsed.newlyResolved).toEqual([{
      name: "Ana",
      headline: "Ana headline",
      summary: "Ana summary",
      userUrl: "https://index.network/u/cccccccc-0000-4000-8000-000000000003",
      opportunityUrl: "https://index.network/o/bbbbbbbb-0000-4000-8000-000000000003",
    }]);
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.negotiationSummary.reportedCompletedIds).toEqual(["bbbbbbbb-0000-4000-8000-000000000003"]);
  });

  test("F5: a card whose name does not clean is neither listed, counted as a showing, nor recorded as reported", async () => {
    const shown = JSON.stringify({
      opportunityDelivery: {
        "bbbbbbbb-0000-4000-8000-000000000001": { firstShown: "2026-10-09", lastShown: "2026-10-09", count: 1 },
        "bbbbbbbb-0000-4000-8000-000000000002": { firstShown: "2026-10-09", lastShown: "2026-10-09", count: 1 },
      },
    });
    const { out } = await run({
      list_opportunities: () => listOpportunitiesText([opp("rm -rf", "pending", 1), opp("S.Ravi", "pending", 2), opp("***", "accepted", 3), opp("Ana", "accepted", 4)]),
    }, shown);
    const parsed = JSON.parse(out);
    expect(parsed.needsAttention.map((card: { name: string }) => card.name)).toEqual(["S.Ravi"]);
    expect(parsed.newlyResolved.map((card: { name: string }) => card.name)).toEqual(["Ana"]);
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.deliveredToday).toEqual({ date: DATE, ids: ["bbbbbbbb-0000-4000-8000-000000000002"] });
    expect(state.opportunityDelivery["bbbbbbbb-0000-4000-8000-000000000001"].count).toBe(1);
    expect(state.negotiationSummary.reportedCompletedIds).toEqual(["bbbbbbbb-0000-4000-8000-000000000004"]);
  });

  test("a failed Index call is silent, with only a code on stderr", async () => {
    const { out, err } = await run({
      list_opportunities: () => ({ result: { content: [{ type: "text", text: "private detail" }], isError: true } }),
    });
    expect(out).toBe("[SILENT]");
    expect(err).toContain("mcp-tool-error");
    expect(err).not.toContain("private detail");
    expect(err).not.toContain("test-key");
  });

  const STATE = JSON.stringify({ negotiationSummary: { reportedCompletedIds: ["older"] } });
  const goodOpportunities = () => listOpportunitiesText([opp("Maya", "pending", 1), opp("Ana", "accepted", 3)]);

  for (const input of failureInputs("opportunities")) {
    test(`list_opportunities, ${input.label}: silent, ${input.code} on stderr, nothing recorded`, async () => {
      const { out, err } = await run({ list_opportunities: input.handler }, STATE);
      expect(out).toBe("[SILENT]");
      expect(err).toContain(input.code);
      expect(await Bun.file("state.json").text()).toBe(STATE);
    });
  }

  for (const input of failureInputs("intents")) {
    test(`list_intents, ${input.label}: silent, ${input.code} on stderr, nothing recorded`, async () => {
      const { out, err } = await run({ list_opportunities: goodOpportunities, list_intents: input.handler }, STATE);
      expect(out).toBe("[SILENT]");
      expect(err).toContain(input.code);
      expect(await Bun.file("state.json").text()).toBe(STATE);
    });
  }

  test("follow-up cards and signals carry only Index links of their kind", async () => {
    const { out } = await run({
      list_opportunities: () => listOpportunitiesText([{
        id: "bbbbbbbb-0000-4000-8000-000000000001",
        url: "https://evil.fake.test/o/x",
        status: "pending",
        headline: "h",
        peer: { name: "Maya", userId: "../x", url: "javascript:alert(1)" },
      }]),
      list_intents: () => `Your signals:\n\n${JSON.stringify({
        success: true,
        intents: [
          { id: "aaaaaaaa-0000-4000-8000-000000000001", summary: "rebuilt", url: "javascript:alert(1)" },
          { id: "../../x", summary: "dropped", url: "https://evil.fake.test/i/x" },
        ],
        totalWaitingOpportunities: 1,
        pagination: { limit: 20, offset: 0, count: 2 },
      })}`,
    }, MAYA_SHOWN);
    const parsed = JSON.parse(out);
    expect(parsed.needsAttention).toEqual([{
      name: "Maya",
      headline: "h",
      summary: "h",
      opportunityUrl: "https://index.network/o/bbbbbbbb-0000-4000-8000-000000000001",
    }]);
    expect(parsed.signals).toEqual([
      { summary: "rebuilt", url: "https://index.network/i/aaaaaaaa-0000-4000-8000-000000000001" },
      { summary: "dropped" },
    ]);
  });

  test("a card without a valid id is left out of the follow-up", async () => {
    const rows = [
      { id: "../../x", url: "https://index.network/o/x", status: "pending", viewerRole: "party", headline: "h", peer: { name: "Bad Path" } },
      { url: "https://index.network/o/y", status: "pending", viewerRole: "party", headline: "h", peer: { name: "No Id" } },
      { id: "has space", status: "pending", viewerRole: "agent", headline: "h", peer: { name: "Space Id" } },
    ];
    const only = await run({ list_opportunities: () => listOpportunitiesText(rows) }, STATE);
    expect(only.out).toBe("[SILENT]");
    expect(await Bun.file("state.json").text()).toBe(STATE);
    const mixed = await run({ list_opportunities: () => listOpportunitiesText([...rows, opp("Maya", "pending", 1)]) }, MAYA_SHOWN);
    expect(JSON.parse(mixed.out).needsAttention.map((c: { name: string }) => c.name)).toEqual(["Maya"]);
  });
});
