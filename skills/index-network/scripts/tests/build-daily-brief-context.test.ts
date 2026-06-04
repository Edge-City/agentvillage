import { describe, expect, test } from "bun:test";

import {
  extractInterestTags,
  filterDedupedOpportunities,
  formatPacificTime,
  pacificDayBounds,
  parseOpportunityTranscript,
  selectEvents,
} from "../build-daily-brief-context";

describe("build-daily-brief-context helpers", () => {
  test("extractInterestTags maps user text to EdgeOS tags", () => {
    expect(extractInterestTags("I build AI agents for longevity research and decentralized protocols"))
      .toEqual(expect.arrayContaining(["AI", "Health & Longevity", "Decentralized Tech"]));
  });

  test("selectEvents puts highlighted events first and fills with interest events", () => {
    const events = [
      {
        id: "e1",
        title: "Breakfast",
        start_time: "2026-06-04T16:00:00Z",
        highlighted: true,
        tags: ["Wellbeing"],
        venue_title: "Plaza",
      },
      {
        id: "e2",
        title: "AI Agents Salon",
        start_time: "2026-06-04T20:00:00Z",
        highlighted: false,
        tags: ["AI"],
      },
      {
        id: "e3",
        title: "Community Dinner",
        start_time: "2026-06-05T01:00:00Z",
        highlighted: true,
        tags: [],
      },
      {
        id: "e4",
        title: "Unrelated Late Jam",
        start_time: "2026-06-05T03:00:00Z",
        highlighted: false,
        tags: [],
      },
    ];

    const selected = selectEvents(events, ["AI"]);

    expect(selected.highlightedEvents.map((event) => event.id)).toEqual(["e1", "e3"]);
    expect(selected.interestEvents.map((event) => event.id)).toEqual(["e2"]);
  });

  test("selectEvents falls back when no events are highlighted", () => {
    const events = [
      { id: "e1", title: "AI Agents", start_time: "2026-06-04T16:00:00Z", highlighted: false, tags: ["AI"] },
      { id: "e2", title: "Protocol Design", start_time: "2026-06-04T17:00:00Z", highlighted: false, tags: ["Decentralized Tech"] },
      { id: "e3", title: "Lunch", start_time: "2026-06-04T19:00:00Z", highlighted: false, tags: [] },
    ];

    const selected = selectEvents(events, ["AI", "Decentralized Tech"]);

    expect(selected.highlightedEvents).toEqual([]);
    expect(selected.interestEvents.map((event) => event.id)).toEqual(["e1", "e2", "e3"]);
  });

  test("parseOpportunityTranscript reads MCP prose cards", () => {
    const parsed = parseOpportunityTranscript(`Here are your opportunities:\n\n1. Nathan Price\n   <!-- digest-opportunity:id=opp-direct-1 -->\n   builds the intelligence layer for human aging\n   status: pending\n   profileUrl: https://index.network/u/11111111-1111-1111-1111-111111111111\n   acceptUrl: https://index.network/c/abc123\n   feedCategory: connection\n\n2. Remi\n   <!-- digest-opportunity:id=opp-intro-1 -->\n   looking for a systems engineer\n   status: latent\n   profileUrl: https://index.network/u/22222222-2222-2222-2222-222222222222\n   acceptUrl: https://index.network/c/def456\n   feedCategory: connector-flow`);

    expect(parsed).toEqual([
      {
        name: "Nathan Price",
        opportunityId: "opp-direct-1",
        mainText: "builds the intelligence layer for human aging",
        status: "pending",
        profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
        acceptUrl: "https://index.network/c/abc123",
        feedCategory: "connection",
      },
      {
        name: "Remi",
        opportunityId: "opp-intro-1",
        mainText: "looking for a systems engineer",
        status: "latent",
        profileUrl: "https://index.network/u/22222222-2222-2222-2222-222222222222",
        acceptUrl: "https://index.network/c/def456",
        feedCategory: "connector-flow",
      },
    ]);
  });

  test("filterDedupedOpportunities keeps cards without ids and drops delivered ids", () => {
    expect(
      filterDedupedOpportunities(
        [{ name: "A", opportunityId: "opp-1" }, { name: "B" }, { name: "C", opportunityId: "opp-2" }],
        new Set(["opp-1"]),
      ).map((opp) => opp.name),
    ).toEqual(["B", "C"]);
  });

  test("formatPacificTime renders Pacific time without a timezone suffix", () => {
    expect(formatPacificTime("2026-06-04T16:30:00Z")).toBe("9:30 AM");
    expect(formatPacificTime("2026-12-04T17:30:00Z")).toBe("9:30 AM");
  });

  test("pacificDayBounds respects daylight saving offsets", () => {
    expect(pacificDayBounds("2026-06-04")).toEqual({
      startIso: "2026-06-04T07:00:00.000Z",
      endIso: "2026-06-05T07:00:00.000Z",
    });
    expect(pacificDayBounds("2026-12-04")).toEqual({
      startIso: "2026-12-04T08:00:00.000Z",
      endIso: "2026-12-05T08:00:00.000Z",
    });
  });
});
