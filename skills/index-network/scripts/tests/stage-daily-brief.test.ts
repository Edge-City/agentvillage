import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageDailyBrief } from "../stage-daily-brief";
import type { DailyBriefContext } from "../build-daily-brief-context";

const TODAY = "2026-06-15";
const tmpDirs: string[] = [];

const baseContext: DailyBriefContext = {
  date: TODAY,
  displayDate: "Monday, June 15",
  timezone: "America/Los_Angeles",
  announcements: [],
  rsvpEvents: [],
  highlightedEvents: [
    {
      id: "event-1",
      title: "Creative AI Crit",
      startTime: "2026-06-15T16:00:00Z",
      timePacific: "9:00 AM",
      venue: "Studio",
      eventUrl: "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      tags: ["Creative AI & Technologies"],
      highlighted: true,
      reasonHint: "Highlighted by the EdgeOS calendar.",
    },
  ],
  interestEvents: [],
  opportunities: [
    {
      name: "Maya",
      opportunityId: "opp-1",
      mainText: "Maya is working on memory tools.",
      profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
      acceptUrl: "https://protocol.index.network/c/abc123",
      feedCategory: "connection",
    },
  ],
  connectionOpportunities: [],
  communityOpportunities: [],
  userModel: {
    phrases: ["I build memory tools with restrained product taste"],
    interestTags: ["Creative AI & Technologies"],
  },
  questions: [
    {
      id: "q-1",
      title: "Identity read",
      prompt: "What would be a sharper way to say what you want people here to understand about your work?",
      mode: "profile",
    },
  ],
  diagnostics: {
    announcementsSource: "unavailable",
    calendarSource: "edgeos",
    rsvpSource: "unavailable",
    opportunitySource: "mcp",
    questionSource: "mcp",
    warnings: [],
    interestTags: ["Creative AI & Technologies"],
  },
};

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "stage-brief-"));
  tmpDirs.push(dir);
  return dir;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("stageDailyBrief prompt-led staging guardrails", () => {
  test("stages a prompt-authored stdin body without requiring a body file", async () => {
    const dir = makeTmp();
    const stateFile = join(dir, "heartbeat-state.json");
    const contextOut = join(dir, "daily-brief-context.json");
    await writeJson(stateFile, {});
    await writeJson(contextOut, baseContext);
    const body = [
      "Good morning from Edge Esmeralda.",
      "",
      "Creative AI Crit makes today less about tools in general and more about whether your memory work reads as product taste or infrastructure.",
      "",
      "<!-- digest-question:id=daily-identity-2026-06-15 -->**One for you:** Which part of that read feels most like you, and which part should I stop carrying forward?",
    ].join("\n");

    const calls: string[][] = [];
    const hermes = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "kanban" && args[1] === "create") return JSON.stringify({ task: { id: "t_stdin" } });
      return "{}";
    };

    const result = await stageDailyBrief({ date: TODAY, stateFile, contextOut, body, hermes });

    expect(result.taskId).toBe("t_stdin");
    expect(result.questionIds).toEqual(["daily-identity-2026-06-15"]);
    expect(calls[0]?.[4]).toBe(result.body);
  });

  test("stages a prompt-authored body file, validates markers, blocks review, and records ids", async () => {
    const dir = makeTmp();
    const stateFile = join(dir, "heartbeat-state.json");
    const contextOut = join(dir, "daily-brief-context.json");
    const bodyFile = join(dir, "brief.md");
    await writeJson(stateFile, {});
    await writeJson(contextOut, baseContext);
    await Bun.write(bodyFile, [
      "Good morning from Edge Esmeralda.",
      "",
      "Creative AI Crit looks like the main test of the day: whether your work is best understood as memory infrastructure or as curation with product taste.",
      "",
      "<!-- digest-opportunity:id=opp-1 -->[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111) is nearby enough to that thread to be worth a light hello. [Say hi](https://protocol.index.network/c/abc123).",
      "",
      "This is a provisional read; correct the part that is off.",
      "",
      "<!-- digest-question:id=q-1 -->**One for you:** What would be a sharper way to say what you want people here to understand about your work?",
    ].join("\n"));

    const calls: string[][] = [];
    const hermes = async (args: string[]): Promise<string> => {
      calls.push(args);
      if (args[0] === "kanban" && args[1] === "create") return JSON.stringify({ task: { id: "t_new" } });
      return "{}";
    };

    const result = await stageDailyBrief({ date: TODAY, stateFile, contextOut, bodyFile, hermes });

    expect(result.taskId).toBe("t_new");
    expect(result.opportunityIds).toEqual(["opp-1"]);
    expect(result.questionIds).toEqual(["q-1"]);
    expect(calls[0]).toEqual([
      "kanban",
      "create",
      `Morning digest — ${TODAY}`,
      "--body",
      result.body,
      "--idempotency-key",
      `digest-${TODAY}`,
      "--json",
    ]);
    expect(calls[1]).toEqual(["kanban", "block", "t_new", `review-required: morning brief — ${TODAY}`]);

    const state = JSON.parse(await Bun.file(stateFile).text()) as { prepared: Record<string, unknown> };
    expect(state.prepared).toMatchObject({
      date: TODAY,
      taskId: "t_new",
      opportunityIds: ["opp-1"],
      questionIds: ["q-1"],
    });
  });

  test("sanitizes fabricated markdown and bare URLs before staging", async () => {
    const dir = makeTmp();
    const stateFile = join(dir, "heartbeat-state.json");
    const contextOut = join(dir, "daily-brief-context.json");
    const bodyFile = join(dir, "brief.md");
    await writeJson(stateFile, {});
    await writeJson(contextOut, baseContext);
    await Bun.write(bodyFile, [
      "Good morning.",
      "[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111) is relevant.",
      "[Fake accept](https://index.network/accept/123) and https://index.network/accept/456.",
      "<!-- digest-question:id=daily-identity-2026-06-15 -->**One for you:** Which part of this read feels most like you?",
    ].join("\n"));

    const hermes = async (args: string[]): Promise<string> => {
      if (args[0] === "kanban" && args[1] === "create") return JSON.stringify({ task: { id: "t_new" } });
      return "{}";
    };

    const result = await stageDailyBrief({ date: TODAY, stateFile, contextOut, bodyFile, hermes });

    expect(result.body).toContain("[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111)");
    expect(result.body).toContain("Fake accept and .");
    expect(result.body).not.toContain("/accept/123");
    expect(result.body).not.toContain("/accept/456");
    expect(result.questionIds).toEqual(["daily-identity-2026-06-15"]);
  });

  test("rejects body files with opportunity markers not present in context", async () => {
    const dir = makeTmp();
    const stateFile = join(dir, "heartbeat-state.json");
    const contextOut = join(dir, "daily-brief-context.json");
    const bodyFile = join(dir, "brief.md");
    await writeJson(stateFile, {});
    await writeJson(contextOut, baseContext);
    await Bun.write(bodyFile, "<!-- digest-opportunity:id=opp-forged -->Forged person");

    const calls: string[][] = [];
    const hermes = async (args: string[]): Promise<string> => {
      calls.push(args);
      return "{}";
    };

    await expect(stageDailyBrief({ date: TODAY, stateFile, contextOut, bodyFile, hermes }))
      .rejects
      .toThrow("unknown opportunity marker");
    expect(calls).toEqual([]);
  });

  test("requires stdin or a body file when no protected digest already exists", async () => {
    const dir = makeTmp();
    const stateFile = join(dir, "heartbeat-state.json");
    const contextOut = join(dir, "daily-brief-context.json");
    await writeJson(stateFile, {});
    await writeJson(contextOut, baseContext);

    await expect(stageDailyBrief({ date: TODAY, stateFile, contextOut, hermes: async () => "{}" }))
      .rejects
      .toThrow("requires --body-stdin or --body-file");
  });

});
