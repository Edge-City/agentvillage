/**
 * P1-fix S5: every proactive agent job's Script Output names the agent: `agentName` is the
 * resident's nickname from $HERMES_HOME/av-profile.json, read through the agent-profile skill's
 * reader (the control plane's whole nickname rule), else "Edge". Each job's prompt says to use it.
 * Only the name reaches these jobs: never the resident's about me, interests or preferences.
 *
 *   bun test skills/index-network/scripts/tests/proactive-agent-name.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BriefOpportunity, DailyBriefContext } from "../build-daily-brief-context";
import { type AgentAction, type ProactiveOptions, agentNameFor, runProactive } from "../proactive";

const MORNING = new Date("2026-10-12T02:30:00Z"); // 08:00 IST
const SKILLS = join(import.meta.dir, "..", "..", "..");
const ABOUT = "SECRET-ABOUT-ME-TEXT";
const INTEREST = "SECRET-INTEREST";

let home: string;
const saved = { ...process.env };
const VARS = ["AV_CONNECTIONS_URL", "AV_RECORD_INTENTION", "AV_APPROVAL_ENABLED", "AV_APPROVAL_URL", "AV_PORTAL_URL", "AV_TEAM_TENANT"];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-proactive-name-"));
  mkdirSync(join(home, "memory"), { recursive: true });
  for (const key of VARS) delete process.env[key];
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function card(name: string, id: string): BriefOpportunity {
  return { name, opportunityId: id, mainText: "x", headline: "x", userUrl: `https://index.network/u/${id}`, opportunityUrl: `https://index.network/o/${id}`, feedCategory: "connection" };
}

function context(): DailyBriefContext {
  return {
    date: "2026-10-12", displayDate: "Monday, October 12", timezone: "Asia/Kolkata", announcements: [], rsvpEvents: [], highlightedEvents: [], interestEvents: [],
    opportunities: [], connectionOpportunities: [card("Maya Rao", "op1")], communityOpportunities: [], connectionsStillWaiting: 0, moreWaitingThanListed: false,
    eligibleMatchCount: 1, userModel: { phrases: [], interestTags: [] }, weather: null, questions: [],
    diagnostics: { announcementsSource: "control-plane", calendarSource: "edgeos", rsvpSource: "edgeos", opportunitySource: "mcp", weatherSource: "none", dreamingFresh: true, warnings: [], interestTags: [] },
  } as unknown as DailyBriefContext;
}

function options(over: Partial<ProactiveOptions> = {}): ProactiveOptions {
  return {
    home,
    now: () => MORNING,
    lock: { waitMs: 50, pollMs: 5 },
    buildContext: async () => context(),
    approvals: () => 0,
    drop: async () => ({ opportunity: card("Arjun", "op2") }),
    evening: async () => ({ name: "Lena", headline: "x", userUrl: "https://index.network/u/l", opportunityUrl: "https://index.network/o/l" }),
    followUp: (async () => ({ signals: [], needsAttention: [{ name: "Maya Rao", userUrl: "https://index.network/u/n0", opportunityUrl: "https://index.network/o/n0" }], waiting: [], newlyResolved: [] })) as never,
    ...over,
  };
}

const writeProfile = (doc: unknown) => writeFileSync(join(home, "av-profile.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
const GOOD = { version: 1, nickname: "Mira", about_me: ABOUT, interests: [INTEREST], preferences: { tone: "warm" }, updated_at: "2026-10-06T03:00:01.123Z" };

/** The Script Output object (every line but the wake line). */
function output(lines: string[]): Record<string, unknown> {
  return JSON.parse(lines.slice(0, -1).join("\n"));
}

const FILES: [string, () => void, string][] = [
  ["a good file", () => writeProfile(GOOD), "Mira"],
  ["no file", () => {}, "Edge"],
  ["a file that is not JSON", () => writeProfile("{not json"), "Edge"],
  ["a refused nickname (reserved)", () => writeProfile({ ...GOOD, nickname: "System" }), "Edge"],
  ["a refused nickname (a Cyrillic A in Admin)", () => writeProfile({ ...GOOD, nickname: "\u0410dmin" }), "Edge"],
  ["another version", () => writeProfile({ ...GOOD, version: 2 }), "Edge"],
];

const ACTIONS: AgentAction[] = ["brief", "drop-midday", "drop-evening", "negotiation", "evening", "tpl-brief", "tpl-digest-preview", "tpl-evening-ask"];

describe("agentName in every proactive agent job's Script Output", () => {
  for (const action of ACTIONS) {
    test.each(FILES)(`${action}: %s -> %s`, async (_, write, expected) => {
      write();
      const result = await runProactive(action, options());
      expect(result.woke).toBe(true);
      const view = output(result.lines);
      expect(Object.keys(view)[0]).toBe("agentName");
      expect(view.agentName).toBe(expected);
      // Only the name: nothing the resident wrote about themselves reaches these jobs.
      const text = result.lines.join("\n");
      expect(text).not.toContain(ABOUT);
      expect(text).not.toContain(INTEREST);
    });
  }

  test("a team tenant's preview carries the name too", async () => {
    process.env.AV_TEAM_TENANT = "1";
    writeProfile(GOOD);
    const result = await runProactive("brief", options({ preview: true }));
    expect(result.woke).toBe(true);
    expect(output(result.lines).agentName).toBe("Mira");
  });

  test("agentNameFor: a missing home, an unreadable file, or a name the cron scanner would block is Edge", () => {
    expect(agentNameFor(join(home, "nowhere"))).toBe("Edge");
    mkdirSync(join(home, "av-profile.json"));
    expect(agentNameFor(home)).toBe("Edge");
    rmSync(join(home, "av-profile.json"), { recursive: true });
    writeProfile(GOOD);
    expect(agentNameFor(home)).toBe("Mira");
  });
});

describe("the prompts that write to the resident take the name from the Script Output", () => {
  const PROMPTS = [
    "edge-esmeralda/prompts/brief.md",
    "edge-esmeralda/prompts/opportunity-drop.md",
    "edge-esmeralda/prompts/ask-questions.md",
    "edge-esmeralda/prompts/negotiation-summary.md",
  ];
  test.each(PROMPTS)("%s", (file) => {
    const text = readFileSync(join(SKILLS, file), "utf8");
    const first = text.split("\n")[0];
    expect(first.startsWith("You are Edge,")).toBe(false);
    expect(first).toContain("`agentName`");
    expect(first).toContain("Edge City India");
    expect(first).toContain("(Edge when it is missing)");
  });
});
