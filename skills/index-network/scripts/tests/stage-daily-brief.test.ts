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
          timePacific: "9:00 AM PDT",
          venue: "The Hub",
          tags: [],
          highlighted: true,
          reasonHint: "Highlighted by the EdgeOS calendar.",
        },
      ],
      diagnostics: { ...baseContext.diagnostics, calendarSource: "edgeos" },
    });

    expect(body).toContain("🌞 Good morning from Edge Esmeralda. It is Thursday, June 4");
    expect(body).toContain("**The calendar today:**");
    expect(body).toContain("9:00 AM PDT — GNOSIS Journey at The Hub");
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
    expect(body).toContain("[say hi](https://protocol.index.network/c/abc123)");
  });
});
