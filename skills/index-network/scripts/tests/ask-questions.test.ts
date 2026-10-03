import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";

// 1a040b9 turned the evening pass from "ask one pending question" into "send one
// pending opportunity the morning brief and the daytime drops have not sent
// today", with the last-day closeout as the fallback. These tests cover that
// contract. Index is faked through globalThis.fetch at INDEX_MCP_URL; no test
// reaches the network.

const MCP_URL = "https://test.example.com/mcp";
const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalMcpUrl = process.env.INDEX_MCP_URL;

const FINAL_DAY = "2026-11-01";
const CLOSEOUT_ID = `edge-closeout-final-reflection-${FINAL_DAY}`;
const CLOSEOUT_PROMPT =
  "Quick closeout check: did AgentVillage help you meet, message, or better understand anyone this week? Reply with one sentence.";

const MAYA_ID = "11111111-1111-1111-1111-111111111111";
const LEO_ID = "22222222-2222-2222-2222-222222222222";

function opportunity(id: string, name: string, userId: string, headline: string) {
  return { id, status: "pending", headline, summary: `${headline}.`, viewerRole: "party", peer: { name, userId } };
}

const OPP_A = opportunity("opp-aaa", "Maya", MAYA_ID, "both building agent memory");
const OPP_B = opportunity("opp-bbb", "Leo", LEO_ID, "both running village dinners");

interface FakeIndex {
  toolCalls: Array<{ name?: string; arguments?: unknown }>;
  requests: number;
}

/** Fake Index MCP: answers initialize and list_opportunities with `rows`, or fails with `status`. */
function fakeIndex(rows: unknown[], status = 200): FakeIndex {
  const seen: FakeIndex = { toolCalls: [], requests: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url !== MCP_URL) throw new Error(`unexpected fetch: ${url}`);
    seen.requests += 1;
    if (status !== 200) return new Response("nope", { status, statusText: "Bad Request" });
    const body = JSON.parse((init?.body as string) ?? "{}") as {
      method: string;
      params?: { name?: string; arguments?: unknown };
    };
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { capabilities: {} } });
    }
    seen.toolCalls.push({ name: body.params?.name, arguments: body.params?.arguments });
    const text = `You have ${rows.length} opportunities.\n\n${JSON.stringify({ opportunities: rows })}`;
    return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } });
  }) as typeof fetch;
  return seen;
}

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-questions-"));
  process.chdir(dir);
  return dir;
}

async function readState(): Promise<Record<string, unknown>> {
  return JSON.parse(await Bun.file("state.json").text());
}

beforeEach(() => {
  process.env.INDEX_MCP_URL = MCP_URL;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMcpUrl === undefined) delete process.env.INDEX_MCP_URL;
  else process.env.INDEX_MCP_URL = originalMcpUrl;
  const cwd = process.cwd();
  process.chdir(originalCwd);
  if (cwd !== originalCwd && cwd.includes("ask-questions-")) rmSync(cwd, { recursive: true, force: true });
});

describe("askQuestions", () => {
  test("returns silent and never calls Index when no API key is available", async () => {
    tempWorkspace();
    const index = fakeIndex([OPP_A]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
    expect(index.requests).toBe(0);
  });

  test("returns silent when Index is unavailable", async () => {
    tempWorkspace();
    fakeIndex([OPP_A], 400);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
  });

  test("returns silent when nothing is pending", async () => {
    tempWorkspace();
    fakeIndex([]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
  });

  test("lists pending opportunities through list_opportunities", async () => {
    tempWorkspace();
    const index = fakeIndex([OPP_A]);
    await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(index.toolCalls).toEqual([{ name: "list_opportunities", arguments: { statuses: ["pending"], limit: 20 } }]);
  });

  test("returns the first pending card with person and opportunity links built from returned ids", async () => {
    tempWorkspace();
    fakeIndex([OPP_A, OPP_B]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({
      name: "Maya",
      headline: "both building agent memory",
      userUrl: `https://index.network/u/${MAYA_ID}`,
      opportunityUrl: "https://index.network/o/opp-aaa",
    });
  });

  test("skips a card already sent today and picks the next one", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ deliveredToday: { date: "2026-06-17", ids: ["opp-aaa"] } }));
    fakeIndex([OPP_A, OPP_B]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toMatchObject({ name: "Leo" });
  });

  test("returns silent when every pending card was already sent today", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ deliveredToday: { date: "2026-06-17", ids: ["opp-aaa", "opp-bbb"] } }));
    fakeIndex([OPP_A, OPP_B]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
  });

  test("a delivery list from another day does not block today's card", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ deliveredToday: { date: "2026-06-16", ids: ["opp-aaa"] } }));
    fakeIndex([OPP_A]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toMatchObject({ name: "Maya" });
    expect((await readState()).deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-aaa"] });
  });

  test("records the card in deliveredToday before returning it and keeps sibling state keys", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      deliveredToday: { date: "2026-06-17", ids: ["opp-morning"] },
      questionDelivery: { "q-old": "2026-06-10" },
      signalElicitation: { lastAskedDate: "2026-06-16" },
    }));
    fakeIndex([OPP_A]);
    await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    const state = await readState();
    expect(state.deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-morning", "opp-aaa"] });
    expect(state.questionDelivery).toEqual({ "q-old": "2026-06-10" });
    expect(state.signalElicitation).toEqual({ lastAskedDate: "2026-06-16" });
  });

  test("works without an existing state file (fresh install)", async () => {
    tempWorkspace();
    fakeIndex([OPP_A]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toMatchObject({ name: "Maya" });
    expect((await readState()).deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-aaa"] });
  });

  test("malformed state falls back to empty and does not crash", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ deliveredToday: "not-an-object", questionDelivery: "nope" }));
    fakeIndex([OPP_A]);
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toMatchObject({ name: "Maya" });
  });

  test("returns the final closeout reflection on the last village day without calling Index", async () => {
    tempWorkspace();
    const index = fakeIndex([OPP_A]);
    const result = await askQuestions({ date: FINAL_DAY, stateFile: "state.json", apiKey: "" });
    expect(result).toEqual({ prompt: CLOSEOUT_PROMPT });
    expect(index.requests).toBe(0);
    expect((await readState()).questionDelivery).toEqual({ [CLOSEOUT_ID]: FINAL_DAY });
  });

  test("on the last village day a pending card still goes first", async () => {
    tempWorkspace();
    fakeIndex([OPP_A]);
    const result = await askQuestions({ date: FINAL_DAY, stateFile: "state.json", apiKey: "test-key" });
    expect(result).toMatchObject({ name: "Maya" });
  });

  test("on the last village day an unavailable Index still yields the closeout", async () => {
    tempWorkspace();
    fakeIndex([], 400);
    const result = await askQuestions({ date: FINAL_DAY, stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ prompt: CLOSEOUT_PROMPT });
  });

  test("does not repeat final closeout reflection after it is recorded", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ questionDelivery: { [CLOSEOUT_ID]: FINAL_DAY } }));
    fakeIndex([]);
    const result = await askQuestions({ date: FINAL_DAY, stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "final-reflection-already-delivered" });
  });

  test("does not repeat final closeout reflection after the morning brief recorded it", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ questionDelivery: { [`daily-identity-${FINAL_DAY}`]: FINAL_DAY } }));
    fakeIndex([]);
    const result = await askQuestions({ date: FINAL_DAY, stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "final-reflection-already-delivered" });
  });
});
