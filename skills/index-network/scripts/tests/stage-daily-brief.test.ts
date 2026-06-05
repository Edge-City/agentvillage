import { describe, expect, test } from "bun:test";

import { composeDailyBrief } from "../stage-daily-brief";
import type { DailyBriefContext } from "../build-daily-brief-context";

const baseContext: DailyBriefContext = {
  date: "2026-06-04",
  displayDate: "Thursday, June 4",
  timezone: "America/Los_Angeles",
  announcements: [],
  rsvpEvents: [],
  highlightedEvents: [],
  interestEvents: [],
  opportunities: [],
  connectionOpportunities: [],
  communityOpportunities: [],
  diagnostics: {
    announcementsSource: "unavailable",
    calendarSource: "unavailable",
    rsvpSource: "unavailable",
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
    expect(body).toContain("**A few things on today:**");
    expect(body).toContain("9:00 AM — [GNOSIS Journey](https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa) at The Hub");
    expect(body).not.toContain("PDT");
    expect(body).not.toContain("Highlighted by the EdgeOS calendar");
    expect(body).not.toContain("I couldn't check the live calendar this morning");
    expect(body).not.toContain("\\n");
    expect(body).not.toContain("\\ud83c");
  });

  test("renders an RSVP section and excludes RSVPed events from the discovery list", () => {
    const rsvped = {
      id: "event-rsvp",
      title: "Qi Gong",
      startTime: "2026-06-04T15:00:00Z",
      timePacific: "8:00 AM",
      venue: "Plaza",
      eventUrl: "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
      tags: [],
      highlighted: true,
      reasonHint: "You RSVPed to this.",
    };
    const otherHighlighted = {
      id: "event-1",
      title: "GNOSIS Journey",
      startTime: "2026-06-04T16:00:00Z",
      timePacific: "9:00 AM",
      venue: "The Hub",
      eventUrl: "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      tags: [],
      highlighted: true,
      reasonHint: "Highlighted by the EdgeOS calendar.",
    };

    const { body } = composeDailyBrief({
      ...baseContext,
      rsvpEvents: [rsvped],
      highlightedEvents: [rsvped, otherHighlighted],
      diagnostics: { ...baseContext.diagnostics, calendarSource: "edgeos", rsvpSource: "edgeos" },
    });

    expect(body).toContain("**On your calendar today (your RSVPs):**");
    expect(body).toContain("8:00 AM — [Qi Gong]");
    expect(body).toContain("**Also on today:**");
    expect(body).toContain("That's a selection, not the whole day — ask me for the full calendar anytime.");
    // Qi Gong is an RSVP, so it must not also appear in the discovery list.
    expect(body.match(/Qi Gong/g) ?? []).toHaveLength(1);
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
    expect(body).toContain("**People worth meeting today:**");
    expect(body).not.toContain("Potential connections via Index Network");
    expect(body).toContain("<!-- digest-opportunity:id=opp-1 -->[Maya]");
    expect(body).toContain("[Say hi](https://protocol.index.network/c/abc123)");
  });

  test("renders common digest opportunity reasons as concise user-facing prose", () => {
    const opportunities = [
      {
        name: "Seref Yarar",
        opportunityId: "opp-seref",
        mainText: "Seref has deep expertise in AI, especially in user profiling and modeling, with arXiv publications on these topics. His work aligns with your interest in advanced AI concepts.",
        profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
        acceptUrl: "https://protocol.index.network/c/seref",
        feedCategory: "connection",
      },
      {
        name: "Seren Sandikci",
        opportunityId: "opp-seren",
        mainText: "Seren is seeking feedback on protocol design and would benefit from your engineering expertise. You both share an interest in decentralized systems.",
        profileUrl: "https://index.network/u/22222222-2222-2222-2222-222222222222",
        acceptUrl: "https://protocol.index.network/c/seren",
        feedCategory: "connection",
      },
      {
        name: "Helen Huang",
        opportunityId: "opp-helen",
        mainText: "Helen is building a portable digital identity system through gameplay and is seeking research collaboration. Your background in back-end development could be a great fit.",
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

    expect(body).toContain("Seref has deep expertise in AI, especially in user profiling and modeling, with arXiv publications on these topics. [Say hi]");
    expect(body).toContain("Seren is seeking feedback on protocol design and would benefit from your engineering expertise. [Say hi]");
    expect(body).toContain("Helen is building a portable digital identity system through gameplay and is seeking research collaboration. [Say hi]");
  });

  test("keeps digest opportunity bullets short and drops raw presenter artifacts", () => {
    const longReason = "Helen is building a portable digital identity system through gameplay and is seeking research collaboration. Your background in full-stack development and experience with identity protocols makes you a strong fit for her project needs.";
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
    const bullets = body.split("\n").filter((line) => line.startsWith("- <!-- digest-opportunity"));
    expect(bullets).toHaveLength(3);
    expect(bullets.every((line) => line.length < 360)).toBe(true);
  });
});
