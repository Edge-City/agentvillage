import { describe, expect, test } from "bun:test";

import { composeDailyBrief } from "../stage-daily-brief";
import type { DailyBriefContext } from "../build-daily-brief-context";

const baseContext: DailyBriefContext = {
  date: "2026-06-04",
  displayDate: "Thursday, June 4",
  timezone: "America/Los_Angeles",
  announcements: [],
  highlightedEvents: [],
  interestEvents: [],
  opportunities: [],
  connectionOpportunities: [],
  communityOpportunities: [],
  diagnostics: {
    announcementsSource: "unavailable",
    calendarSource: "unavailable",
    opportunitySource: "unavailable",
    warnings: [],
    interestTags: [],
  },
};

describe("composeDailyBrief", () => {
  test("renders real calendar content instead of calendar-unavailable fallback", () => {
    const { body } = composeDailyBrief({
      ...baseContext,
      highlightedEvents: [
        {
          id: "event-1",
          title: "GNOSIS Journey",
          startTime: "2026-06-04T16:00:00Z",
          timePacific: "9:00 AM",
          venue: "The Hub",
          eventUrl: "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          tags: [],
          highlighted: true,
          reasonHint: "Highlighted by the EdgeOS calendar.",
        },
      ],
      diagnostics: { ...baseContext.diagnostics, calendarSource: "edgeos" },
    });

    expect(body).toContain("🌞 Good morning from Edge Esmeralda. It is Thursday, June 4");
    expect(body).toContain("**The calendar today:**");
    expect(body).toContain("9:00 AM — [GNOSIS Journey](https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) at The Hub");
    expect(body).not.toContain("PDT");
    expect(body).not.toContain("Highlighted by the EdgeOS calendar");
    expect(body).not.toContain("I couldn't check the live calendar this morning");
    expect(body).not.toContain("\\n");
    expect(body).not.toContain("\\ud83c");
  });

  test("renders opportunities with digest markers and collects ids", () => {
    const { body, opportunityIds } = composeDailyBrief({
      ...baseContext,
      opportunities: [
        {
          name: "Maya",
          opportunityId: "opp-1",
          mainText: "You both care about privacy-preserving agents",
          profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
          acceptUrl: "https://protocol.index.network/c/abc123",
          feedCategory: "connection",
        },
      ],
      connectionOpportunities: [
        {
          name: "Maya",
          opportunityId: "opp-1",
          mainText: "You both care about privacy-preserving agents",
          profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
          acceptUrl: "https://protocol.index.network/c/abc123",
          feedCategory: "connection",
        },
      ],
    });

    expect(opportunityIds).toEqual(["opp-1"]);
    expect(body).toContain("<!-- digest-opportunity:id=opp-1 -->[Maya]");
    expect(body).toContain("[Say hi](https://protocol.index.network/c/abc123)");
  });

  test("renders common digest opportunity reasons as concise user-facing prose", () => {
    const opportunities = [
      {
        name: "Seref Yarar",
        opportunityId: "opp-seref",
        mainText: "Seref Yarar's profile indicates strong expertise in AI, especially in user profiling and modeling, and he is involved with arXiv publications on these topics, suggesting deep engagement with advanced AI concepts relevant to the discoverer's query.",
        profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
        acceptUrl: "https://protocol.index.network/c/seref",
        feedCategory: "connection",
      },
      {
        name: "Seren Sandikci",
        opportunityId: "opp-seren",
        mainText: "The discoverer, Seren, is seeking feedback and deep technical or design insights on 'protocol design'. Yankı is a tech professional with engineering expertise, focusing on back-end development and full-stack development.",
        profileUrl: "https://index.network/u/22222222-2222-2222-2222-222222222222",
        acceptUrl: "https://protocol.index.network/c/seren",
        feedCategory: "connection",
      },
      {
        name: "Helen Huang",
        opportunityId: "opp-helen",
        mainText: "The discoverer, Helen, is building 'portable digital identity of character and behavior through gameplay' and is seeking research collaboration. you, the candidate, is a tech professional with engineering expertise focusing on back-end development.",
        profileUrl: "https://index.network/u/33333333-3333-3333-3333-333333333333",
        acceptUrl: "https://protocol.index.network/c/helen",
        feedCategory: "connection",
      },
    ];

    const { body } = composeDailyBrief({
      ...baseContext,
      opportunities,
      connectionOpportunities: opportunities,
    });

    expect(body).toContain("Seref has strong AI expertise. [Say hi]");
    expect(body).toContain("Seren wants feedback on protocol design. [Say hi]");
    expect(body).toContain("Helen is building portable digital identity of character and behavior through gameplay. [Say hi]");
    expect(body).not.toContain("profile indicates");
    expect(body).not.toContain("Yankı is a tech professional");
    expect(body).not.toContain("you are a tech professional");
  });

  test("keeps digest opportunity bullets short and drops raw presenter artifacts", () => {
    const longReason = "The discoverer, Helen, is building portable digital identity through gameplay and is seeking research collaboration. you, the candidate, is a tech professional with engineering expertise focusing on back-end development and has an intent to meet researchers. While their location is elsewhere, remote collaboration makes this less of a barrier.";
    const opportunities = Array.from({ length: 4 }, (_, idx) => ({
      name: `Person ${idx + 1}`,
      opportunityId: `opp-${idx + 1}`,
      mainText: longReason,
      profileUrl: `https://index.network/u/11111111-1111-1111-1111-11111111111${idx}`,
      acceptUrl: `https://protocol.index.network/c/abc12${idx}`,
      feedCategory: "connection",
    }));

    const { body, opportunityIds } = composeDailyBrief({
      ...baseContext,
      opportunities,
      connectionOpportunities: opportunities,
    });

    expect(opportunityIds).toEqual(["opp-1", "opp-2", "opp-3"]);
    expect(body).toContain("Person 1");
    expect(body).toContain("Person 3");
    expect(body).not.toContain("Person 4");
    expect(body).not.toContain("The discoverer");
    expect(body).not.toContain("candidate");
    expect(body).not.toContain("remote collaboration");
    const bullets = body.split("\n").filter((line) => line.startsWith("- <!-- digest-opportunity"));
    expect(bullets).toHaveLength(3);
    expect(bullets.every((line) => line.length < 360)).toBe(true);
  });
});
