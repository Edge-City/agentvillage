import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INTRO_REASON_MAX, REFLECTION_PROMPTS, askQuestions, introReason, reflectionPromptFor } from "../ask-questions";
import { FAKE_MCP_URL, indexMcpFake, listOpportunitiesText } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";
import { pinDeliveryClock } from "./pin-clock";

pinDeliveryClock();

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
  reason: "memory systems",
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

  test("F5: skips a card whose name does not clean: it takes no slot and is not recorded as shown", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ opportunityDelivery: {} }));
    mockList(listText([
      card("rm -rf", "memory systems", "opp-bad", MAYA_ID),
      card("R.Krishnan", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toMatchObject({ name: "R.Krishnan", opportunityUrl: "https://index.network/o/opp-jon" });
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-jon"] });
    expect(Object.keys(state.opportunityDelivery)).toEqual(["opp-jon"]);
  });

  test("skips a card already delivered today", async () => {
    tempWorkspace();
    // An empty delivery log, so only the same-day dedupe keeps Maya out.
    await Bun.write("state.json", JSON.stringify({
      deliveredToday: { date: "2026-06-17", ids: ["opp-maya"] },
      opportunityDelivery: {},
    }));
    mockList(listText([
      card("Maya", "memory systems", "opp-maya", MAYA_ID),
      card("Jon", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual({
      name: "Jon",
      reason: "village tools",
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

  test("deliveredToday dated yesterday is no same-day dedupe: with an empty delivery log its card is eligible today", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ deliveredToday: { date: "2026-06-16", ids: ["opp-maya"] }, opportunityDelivery: {} }));
    mockList(listText([
      card("Maya", "memory systems", "opp-maya", MAYA_ID),
      card("Jon", "village tools", "opp-jon", JON_ID),
    ]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
    expect(JSON.parse(await Bun.file("state.json").text()).deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-maya"] });
  });

  test("a card whose links are not Index links of their kind has no way to reach them, so it is not the evening card", async () => {
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
    expect(result).toEqual({ silent: true, reason: "nothing-waiting" });
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

  test("a card with no reason is passed over and spends no showing; the next card with one is the evening card", async () => {
    tempWorkspace();
    mockList(listText([card("Jon", "", "opp-jon", JON_ID), card("Maya", "memory systems", "opp-maya", MAYA_ID)]));
    const result = await askQuestions({ date: "2026-06-17", stateFile: "state.json", apiKey: "test-key" });
    expect(result).toEqual(MAYA_CARD);
    expect(JSON.parse(await Bun.file("state.json").text()).deliveredToday).toEqual({ date: "2026-06-17", ids: ["opp-maya"] });
  });
});

describe("introReason: Index's headline as one plain, short line", () => {
  test("links, handles, markup and line breaks are gone; the cut is at a word, at most INTRO_REASON_MAX", () => {
    expect(introReason({ headline: "**Both** into\nmemory systems, see https://x.example @maya" })).toBe("Both into memory systems, see maya");
    const long = introReason({ headline: "word ".repeat(60) })!;
    expect([...long].length).toBeLessThanOrEqual(INTRO_REASON_MAX);
    expect(long.endsWith("word\u2026")).toBe(true);
  });

  test("falls back to the main text; null when neither has visible text", () => {
    expect(introReason({ headline: "", mainText: "climate tools" })).toBe("climate tools");
    expect(introReason({ headline: "  ", mainText: undefined })).toBeNull();
    expect(introReason({})).toBeNull();
  });
});

describe("reflectionPromptFor: the script, not the model, rotates the journaling prompt", () => {
  test("the same date always gets the same prompt", () => {
    expect(reflectionPromptFor("2026-10-12")).toBe(reflectionPromptFor("2026-10-12"));
  });

  test("consecutive days walk the whole list before repeating", () => {
    const days = Array.from({ length: REFLECTION_PROMPTS.length }, (_, i) => reflectionPromptFor(`2026-10-${String(11 + i).padStart(2, "0")}`));
    expect(new Set(days).size).toBe(REFLECTION_PROMPTS.length);
    expect(reflectionPromptFor("2026-10-11")).toBe(reflectionPromptFor(`2026-10-${11 + REFLECTION_PROMPTS.length}`));
  });

  test("a malformed date still gets a prompt", () => {
    expect(REFLECTION_PROMPTS).toContain(reflectionPromptFor("not-a-date"));
  });
});
