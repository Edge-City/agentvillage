import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";
import { FAKE_MCP_URL, indexMcpFake, listOpportunitiesText } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;
const originalMcpUrl = process.env.INDEX_MCP_URL;
const MCP_URL = FAKE_MCP_URL;

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
  return listOpportunitiesText(cards);
}

function mockList(text: string) {
  process.env.INDEX_MCP_URL = MCP_URL;
  const fake = indexMcpFake({ tools: { list_opportunities: () => text } });
  globalThis.fetch = fake.fetch;
  return fake;
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
    const fake = mockList(listText([
      card("Maya", "memory systems", "opp-maya", MAYA_ID),
      card("Jon", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
    expect(fake.calls.map((call) => [call.method, call.name, call.status])).toEqual([["tools/call", "list_opportunities", 200]]);
  });

  test("returns silent, recording nothing, when the tool reports an error", async () => {
    tempWorkspace();
    process.env.INDEX_MCP_URL = MCP_URL;
    const text = listText([card("Maya", "memory systems", "opp-maya", MAYA_ID)]);
    globalThis.fetch = indexMcpFake({
      tools: { list_opportunities: () => ({ result: { content: [{ type: "text", text }], isError: true } }) },
    }).fetch;
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
    expect(await Bun.file("state.json").exists()).toBe(false);
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

describe("askQuestions against Index's answers", () => {
  for (const input of failureInputs("opportunities")) {
    test(`${input.label}: silent and records nothing`, async () => {
      tempWorkspace();
      const before = JSON.stringify({ deliveredToday: { date: "2026-06-17", ids: [] } });
      await Bun.write("state.json", before);
      process.env.INDEX_MCP_URL = MCP_URL;
      globalThis.fetch = indexMcpFake({ tools: { list_opportunities: input.handler } }).fetch;
      const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
      expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
      expect(await Bun.file("state.json").text()).toBe(before);
    });

    test(`${input.label}: on the last day, the closeout behaves as for an unreachable Index`, async () => {
      tempWorkspace();
      process.env.INDEX_MCP_URL = MCP_URL;
      globalThis.fetch = (() => {
        throw new Error("down");
      }) as unknown as typeof fetch;
      const unreachable = await askQuestions({ date: "2026-11-01", stateFile: "a.json", apiKey: "test-key" });
      globalThis.fetch = indexMcpFake({ tools: { list_opportunities: input.handler } }).fetch;
      const failed = await askQuestions({ date: "2026-11-01", stateFile: "b.json", apiKey: "test-key" });
      expect(failed).toEqual(unreachable);
      expect("prompt" in failed).toBe(true);
      expect(await Bun.file("b.json").text()).toBe(await Bun.file("a.json").text());
      expect(JSON.parse(await Bun.file("b.json").text()).deliveredToday).toBeUndefined();
    });
  }

  test("deliveredToday dated yesterday leaves its card eligible today", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ deliveredToday: { date: "2026-06-16", ids: ["opp-maya"] } }));
    mockList(listText([
      card("Maya", "memory systems", "opp-maya", MAYA_ID),
      card("Jon", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
    expect(JSON.parse(await Bun.file("state.json").text()).deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-maya"] });
  });

  test("the evening card carries only Index links of their kind", async () => {
    tempWorkspace();
    mockList(listText([{
      id: "opp-maya",
      url: "https://evil.fake.test/o/opp-maya",
      status: "pending",
      headline: "memory systems",
      summary: "memory systems",
      peer: { name: "Maya", userId: "../../x", url: "javascript:alert(1)" },
    }] as unknown as ReturnType<typeof card>[]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ name: "Maya", headline: "memory systems", opportunityUrl: "https://index.network/o/opp-maya" });
  });

  test("a card without a valid id is never the evening card", async () => {
    tempWorkspace();
    mockList(listText([
      { id: "../../x", url: "https://index.network/o/x", status: "pending", viewerRole: "party", headline: "h", peer: { name: "Bad Path" } },
      { url: "https://index.network/o/y", status: "pending", viewerRole: "party", headline: "h", peer: { name: "No Id" } },
      { id: "has space", status: "pending", viewerRole: "agent", headline: "h", peer: { name: "Space Id" } },
    ] as unknown as ReturnType<typeof card>[]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
    expect(await Bun.file("state.json").exists()).toBe(false);
  });
});
