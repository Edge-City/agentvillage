import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";
import type { BriefQuestion } from "../build-daily-brief-context";

const originalCwd = process.cwd();

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "ask-questions-"));
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  const cwd = process.cwd();
  process.chdir(originalCwd);
  if (cwd !== originalCwd && cwd.includes("ask-questions-")) rmSync(cwd, { recursive: true, force: true });
});

const QUESTION_A: BriefQuestion = { id: "q-aaa", title: "Profile check", prompt: "What are you currently working on?", mode: "profile" };
const QUESTION_B: BriefQuestion = { id: "q-bbb", title: "Intent check", prompt: "What kind of collaborators are you looking for?", mode: "intent" };

function mockFetch(questions: BriefQuestion[], source: "mcp" | "unavailable" = "mcp") {
  return async (_opts: { apiKey: string; mcpUrl: string }) =>
    ({ questions, source, reason: source === "unavailable" ? "mock unavailable" : undefined });
}

describe("askQuestions", () => {
  test("returns silent when no API key is available", async () => {
    tempWorkspace();
    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "",
      fetchQuestions: mockFetch([QUESTION_A]),
    });
    expect(result).toEqual({ silent: true, reason: "no-api-key" });
  });

  test("returns silent when MCP is unavailable", async () => {
    tempWorkspace();
    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([], "unavailable"),
    });
    expect(result).toEqual({ silent: true, reason: "mock unavailable" });
  });

  test("returns silent when there are no pending questions", async () => {
    tempWorkspace();
    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([]),
    });
    expect(result).toEqual({ silent: true, reason: "no-pending-questions" });
  });

  test("returns silent when all questions are on cooldown", async () => {
    tempWorkspace();
    // Both questions delivered within the last 3 days
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "q-aaa": "2026-06-16", "q-bbb": "2026-06-15" },
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A, QUESTION_B]),
    });

    expect(result).toEqual({ silent: true, reason: "all-questions-on-cooldown" });
  });

  test("returns the first available question", async () => {
    tempWorkspace();

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A, QUESTION_B]),
    });

    expect(result).toEqual({ questionId: "q-aaa", prompt: "What are you currently working on?" });
  });

  test("skips questions on cooldown and picks the next available one", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "q-aaa": "2026-06-16" }, // 1 day ago — still on cooldown
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A, QUESTION_B]),
    });

    expect(result).toEqual({ questionId: "q-bbb", prompt: "What kind of collaborators are you looking for?" });
  });

  test("records delivery in state before returning the question", async () => {
    tempWorkspace();

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A]),
    });

    expect("silent" in result).toBe(false);
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.questionDelivery).toEqual({ "q-aaa": "2026-06-17" });
  });

  test("prunes expired cooldown entries and keeps recent ones when recording", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: {
        "q-old": "2026-06-10",   // 7 days ago — expired
        "q-recent": "2026-06-15", // 2 days ago — still within cooldown
      },
      signalElicitation: { lastAskedDate: "2026-06-16" }, // preserved
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A]),
    });

    expect("silent" in result).toBe(false);
    const state = JSON.parse(await Bun.file("state.json").text());
    // q-old pruned (> 3 days), q-recent kept, q-aaa added
    expect(state.questionDelivery).toEqual({
      "q-recent": "2026-06-15",
      "q-aaa": "2026-06-17",
    });
    // Unrelated state keys must not be touched
    expect(state.signalElicitation).toEqual({ lastAskedDate: "2026-06-16" });
  });

  test("treats a question delivered exactly on the cooldown boundary as available (>= 3 days)", async () => {
    tempWorkspace();
    // Delivered 3 days ago: daysBetween("2026-06-14", "2026-06-17") === 3 >= QUESTION_COOLDOWN_DAYS
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "q-aaa": "2026-06-14" },
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A]),
    });

    expect(result).toEqual({ questionId: "q-aaa", prompt: "What are you currently working on?" });
  });

  test("treats a question delivered 2 days ago as still on cooldown", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "q-aaa": "2026-06-15" }, // 2 days ago
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A]),
    });

    expect(result).toEqual({ silent: true, reason: "all-questions-on-cooldown" });
  });

  test("works without an existing state file (fresh install)", async () => {
    tempWorkspace();
    // No state.json exists

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A]),
    });

    expect(result).toEqual({ questionId: "q-aaa", prompt: "What are you currently working on?" });
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.questionDelivery).toEqual({ "q-aaa": "2026-06-17" });
  });

  test("never calls fetchQuestions when the API key is absent", async () => {
    tempWorkspace();
    let fetchCalled = false;
    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "",
      fetchQuestions: async (_opts) => {
        fetchCalled = true;
        return { questions: [QUESTION_A], source: "mcp" as const };
      },
    });
    expect(result).toEqual({ silent: true, reason: "no-api-key" });
    expect(fetchCalled).toBe(false);
  });

  test("future-dated delivery entry is kept in state and blocks re-delivery", async () => {
    tempWorkspace();
    // Clock skew: question recorded with a future date — should not be pruned
    // and should still block re-delivery (daysBetween is negative < QUESTION_COOLDOWN_DAYS).
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: { "q-aaa": "2026-06-18" }, // tomorrow
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A, QUESTION_B]),
    });

    // q-aaa is filtered out by filterCooldownQuestions (future-dated = within cooldown)
    expect(result).toEqual({ questionId: "q-bbb", prompt: "What kind of collaborators are you looking for?" });

    // q-aaa must be preserved in state (not pruned) — daysBetween("2026-06-18", "2026-06-17") = -1 < 3
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.questionDelivery["q-aaa"]).toBe("2026-06-18");
  });

  test("malformed questionDelivery in state falls back to empty and does not crash", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      questionDelivery: "not-an-object", // malformed
      signalElicitation: { lastAskedDate: "2026-06-16" },
    }));

    const result = await askQuestions({
      date: "2026-06-17",
      stateFile: "state.json",
      apiKey: "test-key",
      fetchQuestions: mockFetch([QUESTION_A]),
    });

    // Treats malformed delivery log as empty — question is available
    expect(result).toEqual({ questionId: "q-aaa", prompt: "What are you currently working on?" });
    const state = JSON.parse(await Bun.file("state.json").text());
    expect(state.questionDelivery).toEqual({ "q-aaa": "2026-06-17" });
    // Unrelated state keys must not be touched
    expect(state.signalElicitation).toEqual({ lastAskedDate: "2026-06-16" });
  });
});
