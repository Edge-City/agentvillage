import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalMcpUrl = process.env.INDEX_MCP_URL;
const MCP_URL = "https://test.example.com/mcp";

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-questions-"));
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  const cwd = process.cwd();
  process.chdir(originalCwd);
  if (cwd !== originalCwd && cwd.includes("ask-questions-")) rmSync(cwd, { recursive: true, force: true });
  globalThis.fetch = originalFetch;
  if (originalMcpUrl === undefined) delete process.env.INDEX_MCP_URL;
  else process.env.INDEX_MCP_URL = originalMcpUrl;
});

const MAYA_ID = "11111111-1111-1111-1111-111111111111";
const JON_ID = "22222222-2222-2222-2222-222222222222";

function card(name: string, headline: string, id: string, userId: string) {
  return {
    id,
    url: `https://index.network/o/${id}`,
    status: "pending",
    headline,
    summary: headline,
    peer: { name, userId, url: `https://index.network/u/${userId}` },
  };
}

function listText(cards: ReturnType<typeof card>[]): string {
  return JSON.stringify({ success: true, opportunities: cards });
}

function mockList(text: string) {
  process.env.INDEX_MCP_URL = MCP_URL;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
    if (body.method === "initialize") {
      return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
    }
    if (body.method === "tools/call") {
      return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text }] } });
    }
    throw new Error(`unexpected method: ${body.method}`);
  }) as typeof fetch;
}

const MAYA_CARD = {
  name: "Maya",
  headline: "memory systems",
  userUrl: `https://index.network/u/${MAYA_ID}`,
  opportunityUrl: "https://index.network/o/opp-maya",
};

describe("askQuestions", () => {
  test("returns silent when no API key is available", async () => {
    tempWorkspace();
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("fetch");
    }) as typeof fetch;
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
    expect(called).toBe(false);
  });

  test("returns silent when the opportunity fetch throws", async () => {
    tempWorkspace();
    process.env.INDEX_MCP_URL = MCP_URL;
    globalThis.fetch = (() => {
      throw new Error("mcp down");
    }) as typeof fetch;
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
  });

  test("returns silent when no pending card is waiting", async () => {
    tempWorkspace();
    mockList(listText([]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
  });

  test("returns the first pending card", async () => {
    tempWorkspace();
    mockList(listText([
      card("Maya", "memory systems", "opp-maya", MAYA_ID),
      card("Jon", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
  });

  test("skips a card already delivered today", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      deliveredToday: { date: "2026-06-17", ids: ["opp-maya"] },
    }));
    mockList(listText([
      card("Maya", "memory systems", "opp-maya", MAYA_ID),
      card("Jon", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({
      name: "Jon",
      headline: "village tools",
      userUrl: `https://index.network/u/${JON_ID}`,
      opportunityUrl: "https://index.network/o/opp-jon",
    });
  });

  test("records the card id before returning it", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      signalElicitation: { lastAskedDate: "2026-06-16" },
    }));
    mockList(listText([card("Maya", "memory systems", "opp-maya", MAYA_ID)]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-maya"] });
    expect(state.signalElicitation).toEqual({ lastAskedDate: "2026-06-16" });
  });

  test("works without an existing state file", async () => {
    tempWorkspace();
    mockList(listText([card("Maya", "memory systems", "opp-maya", MAYA_ID)]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-maya"] });
  });

  test("returns the final closeout line when nothing is waiting", async () => {
    tempWorkspace();
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      throw new Error("fetch");
    }) as typeof fetch;
    const result = await askQuestions({ date: "2026-11-01", stateFile: "state.json", apiKey: "" });
    expect(result).toEqual({
      prompt: "Quick closeout check: did AgentVillage help you meet, message, or better understand anyone this week? Reply with one sentence.",
    });
    expect(called).toBe(false);
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.questionDelivery).toEqual({
      "edge-closeout-final-reflection-2026-11-01": "2026-11-01",
    });
  });

  test("does not repeat final closeout reflection after it is recorded", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "edge-closeout-final-reflection-2026-11-01": "2026-11-01" },
    }));
    mockList(listText([]));
    const result = await askQuestions({ date: "2026-11-01", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "final-reflection-already-delivered" });
  });

  test("does not repeat final closeout reflection after the morning brief recorded it", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "daily-identity-2026-11-01": "2026-11-01" },
    }));
    mockList(listText([]));
    const result = await askQuestions({ date: "2026-11-01", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "final-reflection-already-delivered" });
  });
});
