/**
 * DATA-372: the daily digest names only interests the resident stated.
 *
 *   - Tags are matched on whole words (keywordPattern): "We are here" is not
 *     Spatial Computing, "the lab results" is not Bio & Neuro, and no word this
 *     product writes into every resident's memory (agent, Index Network, Edge
 *     City, research consent) tags anyone.
 *   - Profile first (resolveInterests): when av-profile.json states interests,
 *     the brief's `you.interests` is exactly those, in their order; the memory
 *     files are searched for tags only when the profile states none.
 *   - brief.md tells the model to name only the listed interests.
 *
 *   bun test skills/index-network/scripts/tests/digest-interests.test.ts
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type BriefOpportunity,
  type DailyBriefContext,
  buildDailyBriefContext,
  dedupeInterests,
  extractInterestTags,
  extractUserModelPhrases,
  hasKeyword,
  resolveInterests,
} from "../build-daily-brief-context";
import { type ProactiveOptions, runProactive, statedInterestsFor } from "../proactive";

const MORNING = new Date("2026-10-12T02:30:00Z"); // 08:00 IST
const DATE = "2026-10-12";
const SKILLS = join(import.meta.dir, "..", "..", "..");

describe("extractInterestTags matches whole words only", () => {
  test.each([
    ["We are here", []],
    ["the lab results", []],
    ["I work on AR headsets", ["Spatial Computing"]],
    ["AI/ML pipelines", ["AI"]],
  ] as const)("%p -> %p", (text, expected) => {
    expect(extractInterestTags(text)).toEqual([...expected]);
  });

  test("ordinary prose and this product's own words tag nothing", () => {
    const prose = [
      "We are planning a year of travel; Carter said he would start early and email the main group.",
      "My bio is in the profile. Part of the lab results came back. The market is far.",
      "Your agent Edge is set up. Index Network connections are on. Research consent given.",
      "Arrived at Edge City in Mandrem; staying in town near the beach.",
      "It is a state-of-the-art venue with a state of the art stage.",
    ].join("\n");
    expect(extractInterestTags(prose)).toEqual([]);
  });

  test("substrings of longer words never count", () => {
    for (const text of ["are", "year", "carter", "learned", "said", "email", "start", "party", "biome", "label", "bios", "xray", "vrooms"]) {
      expect({ text, tags: extractInterestTags(text) }).toEqual({ text, tags: [] });
    }
  });

  test("separators: - / _ and punctuation split words, case does not matter, a plural s is allowed", () => {
    expect(extractInterestTags("AI-first tools")).toEqual(["AI"]);
    expect(extractInterestTags("my_ai_notes")).toEqual(["AI"]);
    expect(extractInterestTags("(AI)")).toEqual(["AI"]);
    expect(extractInterestTags("SPATIAL COMPUTING")).toEqual(["Spatial Computing"]);
    expect(extractInterestTags("machine-learning")).toEqual(expect.arrayContaining(["AI"]));
    expect(extractInterestTags("AR/VR")).toEqual(["Spatial Computing"]);
    expect(extractInterestTags("augmented reality glasses")).toEqual(["Spatial Computing"]);
    expect(extractInterestTags("d/acc")).toEqual(["d/acc"]);
    expect(extractInterestTags("zero-knowledge proofs and ZK rollups")).toEqual(["Privacy"]);
    expect(extractInterestTags("decentralized protocols")).toEqual(["Decentralized Tech"]);
  });

  test("a tag's own name counts as one of its words", () => {
    expect(extractInterestTags("New Urbanism")).toEqual(["New Urbanism"]);
    expect(extractInterestTags("food systems")).toEqual(["Food Systems"]);
  });

  test("hasKeyword: letters and digits in any script are word characters", () => {
    expect(hasKeyword("AI/ML", "ai")).toBe(true);
    expect(hasKeyword("ai2", "ai")).toBe(false);
    expect(hasKeyword("éai", "ai")).toBe(false);
    expect(hasKeyword("AI's take", "ai")).toBe(true);
    expect(hasKeyword("real-estate", "real estate")).toBe(true);
    expect(hasKeyword("realestate", "real estate")).toBe(false);
  });

  test("the bare 'ar' is gone: AR on its own no longer tags Spatial Computing", () => {
    expect(extractInterestTags("AR")).toEqual([]);
    expect(extractInterestTags("ar glasses")).toEqual(["Spatial Computing"]);
  });

  test("notes and event scoring use the same whole-word rule", () => {
    const text = ["We are here for the month.", "I tinker with VR rigs on weekends.", "A state of the art kitchen."].join("\n");
    expect(extractUserModelPhrases(text, ["Spatial Computing", "Art & Culture"])).toEqual(["I tinker with VR rigs on weekends."]);
  });
});

describe("resolveInterests: the profile first, the memory files only when it states none", () => {
  const MEMORY = "I tinker with VR rigs and care about climate.";

  test("stated interests are exactly what the brief names, deduplicated, in the profile's order", () => {
    const out = resolveInterests(["Soil health", "AI safety", "  soil  HEALTH ", "", "Poetry"], MEMORY);
    expect(out.statedInterests).toEqual(["Soil health", "AI safety", "Poetry"]);
    expect(out.interestSource).toBe("profile");
    // Tags for picking events come from the stated words alone: nothing from the memory text (VR, climate).
    expect(out.interestTags).toEqual(["AI", "Health & Longevity"]);
    expect(out.interestTags).not.toContain("Spatial Computing");
    expect(out.interestTags).not.toContain("Energy & Climate");
  });

  test("an empty profile list falls back to the memory files", () => {
    for (const stated of [[], undefined, ["", "   "]]) {
      const out = resolveInterests(stated, MEMORY);
      expect(out.statedInterests).toEqual([]);
      expect(out.interestSource).toBe("memory");
      expect(out.interestTags).toEqual(["Energy & Climate", "Spatial Computing"]);
    }
  });

  test("no stated interests and no keyword in memory: none", () => {
    expect(resolveInterests([], "We are here")).toEqual({ statedInterests: [], interestTags: [], interestSource: "none" });
  });

  test("dedupeInterests ignores anything that is not a string", () => {
    expect(dedupeInterests(["Music", 3, null, "music", "Film"] as unknown[])).toEqual(["Music", "Film"]);
  });
});

describe("buildDailyBriefContext carries the stated interests", () => {
  let dir: string;
  const originalFetch = globalThis.fetch;
  const saved = { ...process.env };
  const VARS = ["EDGEOS_API_KEY", "EDGE_AGENT_CONTROL_PLANE_URL", "ADMIN_TOKEN", "INDEX_API_KEY", "HERMES_HOME"];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "av-digest-interests-"));
    for (const key of VARS) delete process.env[key];
    process.env.HERMES_HOME = dir;
    globalThis.fetch = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    rmSync(dir, { recursive: true, force: true });
    for (const key of VARS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("profile branch: statedInterests set, tags from them, source profile", async () => {
    const user = join(dir, "USER.md");
    writeFileSync(user, "We are here. I tinker with VR rigs.\n");
    const context = await buildDailyBriefContext({ date: DATE, userFiles: [user], statedInterests: ["Regenerative farming", "Jazz"] });
    expect(context.userModel?.statedInterests).toEqual(["Regenerative farming", "Jazz"]);
    expect(context.userModel?.interestTags).toEqual(["Food Systems"]);
    expect(context.diagnostics.interestSource).toBe("profile");
  });

  test("fallback branch: no stated interests, tags from the memory files", async () => {
    const user = join(dir, "USER.md");
    writeFileSync(user, "We are here. I tinker with VR rigs.\n");
    const context = await buildDailyBriefContext({ date: DATE, userFiles: [user] });
    expect(context.userModel?.statedInterests).toEqual([]);
    expect(context.userModel?.interestTags).toEqual(["Spatial Computing"]);
    expect(context.diagnostics.interestSource).toBe("memory");
  });
});

describe("the morning brief's you.interests", () => {
  let home: string;
  const saved = { ...process.env };
  const VARS = ["AV_CONNECTIONS_URL", "AV_RECORD_INTENTION", "AV_APPROVAL_ENABLED", "AV_APPROVAL_URL", "AV_PORTAL_URL", "AV_TEAM_TENANT"];

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "av-digest-brief-"));
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

  const card: BriefOpportunity = {
    name: "Maya Rao", opportunityId: "op1", mainText: "x", headline: "x",
    userUrl: "https://index.network/u/op1", opportunityUrl: "https://index.network/o/op1", feedCategory: "connection",
  };

  /** A context as buildDailyBriefContext would build it from the options it is given (no network). */
  function contextFrom(opts: { statedInterests?: string[] }, memoryText: string): DailyBriefContext {
    const { statedInterests, interestTags, interestSource } = resolveInterests(opts.statedInterests, memoryText);
    return {
      date: DATE, displayDate: "Monday, October 12", timezone: "Asia/Kolkata", announcements: [], rsvpEvents: [], highlightedEvents: [], interestEvents: [],
      opportunities: [], connectionOpportunities: [card], communityOpportunities: [], connectionsStillWaiting: 0, moreWaitingThanListed: false,
      eligibleMatchCount: 1, userModel: { phrases: [], interestTags, statedInterests, interestSource }, questions: [],
      diagnostics: { announcementsSource: "unavailable", calendarSource: "unavailable", rsvpSource: "unavailable", opportunitySource: "mcp", dreamingFresh: true, warnings: [], interestTags, interestSource },
    } as DailyBriefContext;
  }

  function options(memoryText: string, seen: { statedInterests?: string[] }[] = []): ProactiveOptions {
    return {
      home,
      now: () => MORNING,
      lock: { waitMs: 50, pollMs: 5 },
      buildContext: async (opts) => {
        seen.push(opts ?? {});
        return contextFrom(opts ?? {}, memoryText);
      },
      approvals: () => 0,
    };
  }

  const writeProfile = (doc: unknown) => writeFileSync(join(home, "av-profile.json"), JSON.stringify(doc));
  const profile = (interests: unknown) => ({ version: 1, nickname: "Mira", about_me: "ABOUT-ME-TEXT", interests, preferences: {}, updated_at: "2026-10-06T03:00:01.123Z" });

  function you(lines: string[]): { interests: string[] } {
    return JSON.parse(lines.slice(0, -1).join("\n")).you;
  }

  test("a profile with interests: exactly those, in order, deduplicated; nothing from memory; no about me", async () => {
    writeProfile(profile(["Soil health", "Jazz", "soil health", "d/acc"]));
    const seen: { statedInterests?: string[] }[] = [];
    const result = await runProactive("brief", options("We are here. I tinker with VR rigs.", seen));
    expect(result.woke).toBe(true);
    expect(seen[0]?.statedInterests).toEqual(["Soil health", "Jazz", "soil health", "d/acc"]);
    // Stated text takes the stricter cleaner: a slash gets spaces (never a /command).
    expect(you(result.lines).interests).toEqual(["Soil health", "Jazz", "d / acc"]);
    expect(result.lines.join("\n")).not.toContain("ABOUT-ME-TEXT");
  });

  test("a profile with no interests: the memory tags, whole words only", async () => {
    writeProfile(profile([]));
    const result = await runProactive("brief", options("We are here. I tinker with VR rigs."));
    expect(you(result.lines).interests).toEqual(["Spatial Computing"]);
  });

  test("no profile and prose with no interest word: the list is empty", async () => {
    const result = await runProactive("brief", options("We are here. Carter said the market starts early."));
    expect(you(result.lines).interests).toEqual([]);
  });

  test("the template brief takes the same path", async () => {
    writeProfile(profile(["Poetry"]));
    const result = await runProactive("tpl-brief", options("I tinker with VR rigs."));
    expect(you(result.lines).interests).toEqual(["Poetry"]);
  });

  test("statedInterestsFor: missing, ignored or over-long lists are empty, never a throw", () => {
    expect(statedInterestsFor(join(home, "nowhere"))).toEqual([]);
    writeFileSync(join(home, "av-profile.json"), "{not json");
    expect(statedInterestsFor(home)).toEqual([]);
    writeProfile(profile(Array.from({ length: 13 }, (_, i) => `Interest ${i}`)));
    expect(statedInterestsFor(home)).toEqual([]);
    writeProfile(profile(["Music", "Film"]));
    expect(statedInterestsFor(home)).toEqual(["Music", "Film"]);
  });
});

describe("brief.md tells the model to name only the listed interests", () => {
  const prompt = readFileSync(join(SKILLS, "index-network/prompts/brief.md"), "utf8");

  test("the sentence is there", () => {
    expect(prompt).toContain(
      "Name an interest only when it is in `you.interests`, in its own words, and never name, guess or add any other; when `you.interests` is empty, name no interest.",
    );
  });

  test("it sits in the Today item, after the sentence it sharpens", () => {
    const line = prompt.split("\n").find((l) => l.startsWith("2. Today"));
    expect(line).toBeDefined();
    expect(line!.indexOf("lightly held sense")).toBeLessThan(line!.indexOf("Name an interest only when"));
  });
});
