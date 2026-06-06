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

  test("renders digest-ready presenter summaries and linkifies the person name", () => {
    const opportunities = [
      {
        name: "Seref Yarar",
        opportunityId: "opp-seref",
        mainText: "You might like meeting Seref because his protocol work overlaps with your interest in advanced AI concepts.",
        profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
        acceptUrl: "https://protocol.index.network/c/seref",
        feedCategory: "connection",
        confidence: 72,
      },
      {
        name: "Seren Sandikci",
        opportunityId: "opp-seren",
        mainText: "You might like meeting Seren because she wants protocol design feedback and your engineering expertise is directly relevant.",
        profileUrl: "https://index.network/u/22222222-2222-2222-2222-222222222222",
        acceptUrl: "https://protocol.index.network/c/seren",
        feedCategory: "connection",
        confidence: 91,
      },
      {
        name: "Helen Huang",
        opportunityId: "opp-helen",
        mainText: "You might like meeting Helen because her digital identity work overlaps with your backend development background.",
        profileUrl: "https://index.network/u/33333333-3333-3333-3333-333333333333",
        acceptUrl: "https://protocol.index.network/c/helen",
        feedCategory: "connection",
        confidence: 85,
      },
    ];

    const { body } = composeDailyBrief({
      ...baseContext,
      opportunities,
      connectionOpportunities: opportunities,
    });

    // Seren has the highest confidence (91) — she should be the one picked.
    expect(body).toContain("You might like meeting [Seren Sandikci](https://index.network/u/22222222-2222-2222-2222-222222222222) because she wants protocol design feedback and your engineering expertise is directly relevant. [Say hi]");
    expect(body).not.toContain("Seref");
    expect(body).not.toContain("Helen");
  });

  test("prefixes the linked name when presenter summary omits it", () => {
    const { body } = composeDailyBrief({
      ...baseContext,
      opportunities: [
        {
          name: "Paul McKellar",
          opportunityId: "opp-paul",
          mainText: "Worth meeting because his online trust work overlaps with your AI orchestration interests.",
          profileUrl: "https://index.network/u/paul",
          acceptUrl: "https://protocol.index.network/c/paul",
          feedCategory: "connection",
        },
      ],
      connectionOpportunities: [
        {
          name: "Paul McKellar",
          opportunityId: "opp-paul",
          mainText: "Worth meeting because his online trust work overlaps with your AI orchestration interests.",
          profileUrl: "https://index.network/u/paul",
          acceptUrl: "https://protocol.index.network/c/paul",
          feedCategory: "connection",
        },
      ],
    });

    expect(body).toContain("[Paul McKellar](https://index.network/u/paul) — Worth meeting because his online trust work overlaps with your AI orchestration interests. [Say hi]");
  });

  test("sorts opportunities by confidence descending before applying limit", () => {
    // 4 opportunities, all with confidence. Person 4 has highest, Person 1 lowest.
    const opportunities = Array.from({ length: 4 }, (_, idx) => ({
      name: `Person ${idx + 1}`,
      opportunityId: `opp-${idx + 1}`,
      mainText: "Shared interests in distributed systems.",
      profileUrl: `https://index.network/u/11111111-1111-1111-1111-11111111111${idx}`,
      acceptUrl: `https://protocol.index.network/c/abc12${idx}`,
      feedCategory: "connection",
      confidence: 10 * (idx + 1), // Person 1=10, Person 4=40
    }));

    const { body, opportunityIds } = composeDailyBrief({
      ...baseContext,
      opportunities,
      connectionOpportunities: opportunities,
    });

    // Person 4 has the highest confidence (40) — should be the one picked
    expect(opportunityIds).toEqual(["opp-4"]);
    expect(body).toContain("Person 4");
    expect(body).not.toContain("Person 1");
    expect(body).not.toContain("Person 2");
    expect(body).not.toContain("Person 3");
  });

  test("sorts community opportunities by confidence before limit", () => {
    const opportunities = [
      { name: "Low", opportunityId: "comm-low", mainText: "Needs a mentor.", profileUrl: "https://index.network/u/low", acceptUrl: "https://index.network/c/low", feedCategory: "connector-flow", confidence: 35 },
      { name: "High", opportunityId: "comm-high", mainText: "Looking for legal advice.", profileUrl: "https://index.network/u/high", acceptUrl: "https://index.network/c/high", feedCategory: "connector-flow", confidence: 88 },
      { name: "Mid", opportunityId: "comm-mid", mainText: "Seeking co-founder.", profileUrl: "https://index.network/u/mid", acceptUrl: "https://index.network/c/mid", feedCategory: "connector-flow", confidence: 60 },
    ];

    const { body, opportunityIds } = composeDailyBrief({
      ...baseContext,
      opportunities,
      communityOpportunities: opportunities,
    });

    // "High" has the highest confidence (88) — should be the one picked
    expect(opportunityIds).toEqual(["comm-high"]);
    expect(body).toContain("High");
    expect(body).not.toContain("Low");
  });

  test("greeting includes weather when available and omits trailing period without weather", () => {
    // Without weather — should match exemplar (no trailing period)
    const { body: noWeather } = composeDailyBrief(baseContext);
    expect(noWeather.split("\n")[0]).toBe("🌞 Good morning from Edge Esmeralda. It is Thursday, June 4");

    // With weather — should append weather sentence with period
    const { body: withWeather } = composeDailyBrief({
      ...baseContext,
      weather: { forecast: "Expect sunshine and a high of 75°F", emoji: "☀️", source: "open-meteo" },
    });
    expect(withWeather).toContain("☀️ Expect sunshine and a high of 75°F.");

    // Weather unavailable — should fall back to no-weather format
    const { body: weatherDown } = composeDailyBrief({
      ...baseContext,
      weather: { forecast: "", emoji: "", source: "unavailable" },
    });
    expect(weatherDown.split("\n")[0]).toBe("🌞 Good morning from Edge Esmeralda. It is Thursday, June 4");
  });
});
