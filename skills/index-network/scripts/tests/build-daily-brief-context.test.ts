import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  attachIndexLinks,
  buildDailyBriefContext,
  extractInterestTags,
  extractUserModelPhrases,
  fetchOpportunitiesFromMcp,
  filterCooldownQuestions,
  filterActionableOpportunities,
  filterDedupedOpportunities,
  formatVillageTime,
  villageDayBounds,
  parseOpportunityTranscript,
  selectEvents,
} from "../build-daily-brief-context";
import { FAKE_MCP_URL, FIXTURE, indexMcpFake, listOpportunitiesText, type ToolHandler } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";

describe("build-daily-brief-context helpers", () => {
  test("extractInterestTags maps user text to EdgeOS tags", () => {
    expect(extractInterestTags("I build AI agents for longevity research and decentralized protocols"))
      .toEqual(expect.arrayContaining(["AI", "Health & Longevity", "Decentralized Tech"]));
  });

  test("extractUserModelPhrases keeps concise note text tied to selected interests", () => {
    const text = [
      "# USER",
      "I build AI agents for civic coordination.",
      "I work on AI bias measurement.",
      "A very long line about privacy ".repeat(12),
      "Website: https://example.com",
      "I care about privacy-preserving protocols.",
    ].join("\n");

    expect(extractUserModelPhrases(text, ["AI", "Privacy", "Governance & Coordination"])).toEqual([
      "I build AI agents for civic coordination.",
      "I care about privacy-preserving protocols.",
    ]);
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
    const parsed = parseOpportunityTranscript(`Here are your opportunities:\n\n1. Nathan Price\n   <!-- digest-opportunity:id=opp-direct-1 -->\n   builds the intelligence layer for human aging\n   status: pending\n   profileUrl: https://index.network/u/11111111-1111-1111-1111-111111111111\n   acceptUrl: https://index.network/c/abc123\n   negotiationUrl: https://index.network/chat/99999999-9999-9999-9999-999999999999\n   feedCategory: connection\n\n2. Remi\n   <!-- digest-opportunity:id=opp-intro-1 -->\n   looking for a systems engineer\n   status: latent\n   profileUrl: https://index.network/u/22222222-2222-2222-2222-222222222222\n   acceptUrl: https://index.network/c/def456\n   feedCategory: connector-flow`);

    expect(parsed).toEqual([
      {
        name: "Nathan Price",
        opportunityId: "opp-direct-1",
        mainText: "builds the intelligence layer for human aging",
        status: "pending",
        profileUrl: "https://index.network/u/11111111-1111-1111-1111-111111111111",
        acceptUrl: "https://index.network/c/abc123",
        negotiationUrl: "https://index.network/chat/99999999-9999-9999-9999-999999999999",
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

  test("parseOpportunityTranscript unwraps direct MCP JSON tool results", () => {
    const result = {
      success: true,
      data: {
        found: true,
        count: 1,
        message: `You have 1 opportunity.\n\n1. Nathan Price\n   <!-- digest-opportunity:id=opp-direct-1 -->\n   builds the intelligence layer for human aging\n   status: pending\n   profileUrl: https://index.network/u/11111111-1111-1111-1111-111111111111\n   acceptUrl: https://index.network/c/abc123\n   feedCategory: connection`,
      },
    };

    const parsed = parseOpportunityTranscript(JSON.stringify(result));

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
    ]);
  });

  test("parseOpportunityTranscript tolerates malformed MCP wrappers with escaped message JSON", () => {
    const malformed = `{"success":true,"data":{"message":"You have 1 opportunity.\\n\\n1. Athena Aktipis\\n   <!-- digest-opportunity:id=opp-athena -->\\n   Athena is seeking collaboration.\\n   status: draft\\n   profileUrl: https://index.network/u/athena\\n   acceptUrl: https://protocol.index.network/c/athena\\n   feedCategory: connection\\n   confidence: 85"}},path:`;

    expect(parseOpportunityTranscript(malformed)).toEqual([
      {
        name: "Athena Aktipis",
        opportunityId: "opp-athena",
        mainText: "Athena is seeking collaboration.",
        status: "draft",
        profileUrl: "https://index.network/u/athena",
        acceptUrl: "https://protocol.index.network/c/athena",
        feedCategory: "connection",
        confidence: 85,
      },
    ]);
  });

  test("parseOpportunityTranscript parses confidence as a number and ignores invalid values", () => {
    const parsed = parseOpportunityTranscript(`1. Alice
   <!-- digest-opportunity:id=alice -->
   builds agents
   status: draft
   profileUrl: https://index.network/u/alice
   confidence: 92

2. Bob
   <!-- digest-opportunity:id=bob -->
   seeks collaborators
   status: draft
   confidence: not-a-number

3. Carol
   <!-- digest-opportunity:id=carol -->
   no confidence field at all`);

    expect(parsed[0]).toMatchObject({ name: "Alice", confidence: 92 });
    expect(parsed[1]).toMatchObject({ name: "Bob" });
    expect(parsed[1].confidence).toBeUndefined();
    expect(parsed[2]).toMatchObject({ name: "Carol" });
    expect(parsed[2].confidence).toBeUndefined();
  });

  test("parseOpportunityTranscript parses the redelivery flag as a boolean", () => {
    const parsed = parseOpportunityTranscript(`1. Alice
   <!-- digest-opportunity:id=alice -->
   builds agents
   status: pending
   redelivery: true

2. Bob
   <!-- digest-opportunity:id=bob -->
   seeks collaborators
   status: pending

3. Carol
   <!-- digest-opportunity:id=carol -->
   odd value
   redelivery: yes-ish`);

    expect(parsed[0]).toMatchObject({ name: "Alice", redelivery: true });
    expect(parsed[1].redelivery).toBeUndefined();
    expect(parsed[2].redelivery).toBe(false);
  });

  test("filterDedupedOpportunities keeps cards without ids and drops delivered ids", () => {
    expect(
      filterDedupedOpportunities(
        [{ name: "A", opportunityId: "opp-1" }, { name: "B" }, { name: "C", opportunityId: "opp-2" }],
        new Set(["opp-1"]),
      ).map((opp) => opp.name),
    ).toEqual(["B", "C"]);
  });

  test("filterActionableOpportunities drops stalled/expired/rejected cards, keeps actionable and status-less ones", () => {
    expect(
      filterActionableOpportunities([
        { name: "A", status: "pending" },
        { name: "B", status: "stalled" },
        { name: "C", status: "expired" },
        { name: "D", status: "rejected" },
        { name: "E", status: "draft" },
        { name: "F", status: "latent" },
        { name: "G" },
        { name: "H", status: " Pending " },
        { name: "I", status: "accepted" },
        { name: "J", status: "negotiating" },
      ]).map((opp) => opp.name),
    ).toEqual(["A", "E", "F", "G", "H"]);
  });

  test("formatVillageTime renders Goa (IST) time without a timezone suffix", () => {
    expect(formatVillageTime("2026-10-15T16:30:00Z")).toBe("10:00 PM");
    expect(formatVillageTime("2026-10-16T03:30:00Z")).toBe("9:00 AM");
  });

  test("villageDayBounds uses the IST (UTC+5:30) calendar day", () => {
    expect(villageDayBounds("2026-10-15")).toEqual({
      startIso: "2026-10-14T18:30:00.000Z",
      endIso: "2026-10-15T18:30:00.000Z",
    });
    expect(villageDayBounds("2026-11-01")).toEqual({
      startIso: "2026-10-31T18:30:00.000Z",
      endIso: "2026-11-01T18:30:00.000Z",
    });
  });

  test("buildDailyBriefContext sets opportunitySource to mcp when INDEX_API_KEY is set", async () => {
    const originalFetch = globalThis.fetch;
    const originalApiKey = process.env.INDEX_API_KEY;
    const originalMcpUrl = process.env.INDEX_MCP_URL;
    const originalEdgeosKey = process.env.EDGEOS_API_KEY;
    const originalControlPlaneUrl = process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    const originalAdminToken = process.env.ADMIN_TOKEN;
    delete process.env.EDGEOS_API_KEY;
    delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    delete process.env.ADMIN_TOKEN;
    process.env.INDEX_API_KEY = "test-key";
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;

    const opportunityText = listOpportunitiesText([{
      id: "opp-mcp-1",
      url: "https://index.network/o/opp-mcp-1",
      status: "pending",
      viewerRole: "party",
      headline: "builds AI agents",
      summary: "builds AI agents",
      peer: { name: "Nathan Price", userId: "dddddddd-0000-4000-8000-000000000001", url: "https://index.network/u/dddddddd-0000-4000-8000-000000000001" },
    }]);
    const fake = indexMcpFake({ tools: { list_opportunities: () => opportunityText } });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      return fake.fetch(input, init);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-06-10", userFiles: [] });
      expect(context.diagnostics.opportunitySource).toBe("mcp");
      expect(context.opportunities).toHaveLength(1);
      expect(context.opportunities[0].name).toBe("Nathan Price");
      expect(context.opportunities[0].opportunityId).toBe("opp-mcp-1");
      expect(context.questions).toEqual([]);
      expect(context.diagnostics.questionSource).toBe("unavailable");
      expect(fake.calls.map((call) => [call.method, call.name, call.status])).toEqual([["tools/call", "list_opportunities", 200]]);
    } finally {
      globalThis.fetch = originalFetch;
      if (originalApiKey === undefined) delete process.env.INDEX_API_KEY;
      else process.env.INDEX_API_KEY = originalApiKey;
      if (originalMcpUrl === undefined) delete process.env.INDEX_MCP_URL;
      else process.env.INDEX_MCP_URL = originalMcpUrl;
      if (originalEdgeosKey === undefined) delete process.env.EDGEOS_API_KEY;
      else process.env.EDGEOS_API_KEY = originalEdgeosKey;
      if (originalControlPlaneUrl === undefined) delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
      else process.env.EDGE_AGENT_CONTROL_PLANE_URL = originalControlPlaneUrl;
      if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = originalAdminToken;
    }
  });

  test("buildDailyBriefContext reports a refused Index call as a coded warning, never an empty mcp list", async () => {
    const originalFetch = globalThis.fetch;
    const saved = Object.fromEntries(
      ["INDEX_API_KEY", "INDEX_MCP_URL", "EDGEOS_API_KEY", "EDGE_AGENT_CONTROL_PLANE_URL", "ADMIN_TOKEN"].map((key) => [key, process.env[key]]),
    );
    delete process.env.EDGEOS_API_KEY;
    delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    delete process.env.ADMIN_TOKEN;
    process.env.INDEX_API_KEY = "test-key";
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    const fake = indexMcpFake({
      tools: { list_opportunities: () => ({ result: { content: [{ type: "text", text: "private detail" }], isError: true } }) },
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) return new Response("unavailable", { status: 503 });
      return fake.fetch(input, init);
    }) as typeof fetch;
    try {
      const context = await buildDailyBriefContext({ date: "2026-06-10", userFiles: [] });
      expect(context.diagnostics.opportunitySource).toBe("unavailable");
      expect(context.opportunities).toEqual([]);
      expect(context.diagnostics.warnings).toContain("opportunities MCP unavailable: mcp-tool-error");
      expect(context.diagnostics.warnings.join("\n")).not.toContain("private detail");
      expect(context.diagnostics.warnings.join("\n")).not.toContain("test-key");
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  test("buildDailyBriefContext requests the Mandrem forecast in Celsius and IST", async () => {
    const originalFetch = globalThis.fetch;
    const originalEdgeosKey = process.env.EDGEOS_API_KEY;
    const originalControlPlaneUrl = process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    const originalAdminToken = process.env.ADMIN_TOKEN;
    const originalApiKey = process.env.INDEX_API_KEY;
    delete process.env.EDGEOS_API_KEY;
    delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    delete process.env.ADMIN_TOKEN;
    delete process.env.INDEX_API_KEY;

    let weatherParams: URLSearchParams | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.hostname === "api.open-meteo.com") {
        weatherParams = url.searchParams;
        return Response.json({ daily: { temperature_2m_max: [31.4], weather_code: [2] } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-10-15", userFiles: [] });
      expect(weatherParams?.get("latitude")).toBe("15.66");
      expect(weatherParams?.get("longitude")).toBe("73.71");
      expect(weatherParams?.get("temperature_unit")).toBe("celsius");
      expect(weatherParams?.get("timezone")).toBe("Asia/Kolkata");
      expect(weatherParams?.get("start_date")).toBe("2026-10-15");
      expect(context.weather).toEqual({
        forecast: "Expect partly cloudy skies and a high of 31°C",
        emoji: "⛅",
        source: "open-meteo",
      });
      expect(context.timezone).toBe("Asia/Kolkata");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEdgeosKey === undefined) delete process.env.EDGEOS_API_KEY;
      else process.env.EDGEOS_API_KEY = originalEdgeosKey;
      if (originalControlPlaneUrl === undefined) delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
      else process.env.EDGE_AGENT_CONTROL_PLANE_URL = originalControlPlaneUrl;
      if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = originalAdminToken;
      if (originalApiKey === undefined) delete process.env.INDEX_API_KEY;
      else process.env.INDEX_API_KEY = originalApiKey;
    }
  });

  test("buildDailyBriefContext omits weather when Open-Meteo fails", async () => {
    const originalFetch = globalThis.fetch;
    const originalEdgeosKey = process.env.EDGEOS_API_KEY;
    const originalControlPlaneUrl = process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    const originalAdminToken = process.env.ADMIN_TOKEN;
    const originalApiKey = process.env.INDEX_API_KEY;
    delete process.env.EDGEOS_API_KEY;
    delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    delete process.env.ADMIN_TOKEN;
    delete process.env.INDEX_API_KEY;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("https://api.open-meteo.com/")) {
        return new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-10-15", userFiles: [] });
      expect(context.weather).toBeUndefined();
      expect(context.diagnostics.weatherSource).toBe("unavailable");
      expect(context.diagnostics.warnings).toContain("open-meteo weather unavailable: 429 Too Many Requests");
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEdgeosKey === undefined) delete process.env.EDGEOS_API_KEY;
      else process.env.EDGEOS_API_KEY = originalEdgeosKey;
      if (originalControlPlaneUrl === undefined) delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
      else process.env.EDGE_AGENT_CONTROL_PLANE_URL = originalControlPlaneUrl;
      if (originalAdminToken === undefined) delete process.env.ADMIN_TOKEN;
      else process.env.ADMIN_TOKEN = originalAdminToken;
      if (originalApiKey === undefined) delete process.env.INDEX_API_KEY;
      else process.env.INDEX_API_KEY = originalApiKey;
    }
  });
});

describe("fetchOpportunitiesFromMcp", () => {
  function makeMcpFetch(listOpportunities: ToolHandler) {
    return indexMcpFake({ tools: { list_opportunities: listOpportunities } }).fetch;
  }

  const MCP_URL = FAKE_MCP_URL;
  const ALICE_USER = "eeeeeeee-0000-4000-8000-000000000001";
  const OPPORTUNITY_TEXT = listOpportunitiesText([{
    id: "opp-alice",
    url: "https://index.network/o/opp-alice",
    status: "pending",
    viewerRole: "party",
    headline: "builds open protocols",
    summary: "builds open protocols",
    peer: { name: "Alice", userId: ALICE_USER, url: `https://index.network/u/${ALICE_USER}` },
  }]);

  test("returns parsed opportunities from a JSON response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() => OPPORTUNITY_TEXT);
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "Alice",
        opportunityId: "opp-alice",
        profileUrl: `https://index.network/u/${ALICE_USER}`,
        opportunityUrl: "https://index.network/o/opp-alice",
        feedCategory: "connection",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reads the live list_opportunities text: markdown lead, blank line, JSON", async () => {
    const originalFetch = globalThis.fetch;
    const fake = indexMcpFake();
    globalThis.fetch = fake.fetch;
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results.map((opp) => [opp.name, opp.status, opp.feedCategory])).toEqual([
        ["Maya", "pending", "connection"],
        ["Jon", "pending", "connector-flow"],
      ]);
      expect(results[0]).toMatchObject({
        opportunityId: "bbbbbbbb-0000-4000-8000-000000000001",
        opportunityUrl: "https://index.network/o/bbbbbbbb-0000-4000-8000-000000000001",
        userUrl: "https://index.network/u/cccccccc-0000-4000-8000-000000000001",
        headline: "memory systems",
      });
      expect(fake.calls.map((call) => [call.method, call.name, call.arguments])).toEqual([
        ["tools/call", "list_opportunities", { statuses: ["pending"], limit: 20 }],
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns parsed opportunities from SSE response, skipping progress notifications", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch((_args, { id }) => {
      const finalResult = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: OPPORTUNITY_TEXT }] } };
      const sseBody = [
        `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}`,
        "",
        `data: ${JSON.stringify(finalResult)}`,
        "",
      ].join("\n");
      return { response: new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } }) };
    });
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("handles SSE data: lines without a space after the colon", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch((_args, { id }) => {
      const finalResult = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: OPPORTUNITY_TEXT }] } };
      return { response: new Response(`data:${JSON.stringify(finalResult)}\n`, { headers: { "Content-Type": "text/event-stream" } }) };
    });
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("the empty-list object is [], and an empty text is mcp-unparsed", async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = makeMcpFetch(() => FIXTURE.responses.listOpportunitiesEmpty.result.content[0].text);
      expect(await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).toEqual([]);
      globalThis.fetch = makeMcpFetch(() => "");
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("mcp-unparsed");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("an onboarding-gated success:false after a markdown lead is the setup-required diagnostic", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() =>
      `Could not list opportunities:\n\n${JSON.stringify({ success: false, error: "Onboarding required", message: "This user has not completed onboarding." }, null, 2)}`,
    );
    try {
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("setup required before people suggestions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("any other success:false is mcp-tool-error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() => `Could not list:\n\n${JSON.stringify({ success: false, error: "internal", message: "try later" })}`);
    try {
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("mcp-tool-error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws setup-required diagnostic when opportunity tool is onboarding-gated", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() =>
      JSON.stringify({ success: false, error: "Onboarding required", message: "This user has not completed onboarding." }),
    );
    try {
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("setup required before people suggestions");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when the MCP server returns an error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch((_args, { id }) => ({
      response: Response.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } }),
    }));
    try {
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("mcp-rpc-error:-32601");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when the tool reports an error, rather than returning an empty list", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() => ({
      result: { content: [{ type: "text", text: "something went wrong" }], isError: true, resultType: "complete" },
    }));
    try {
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("mcp-tool-error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends x-index-surface: telegram on every MCP request so minted links deep-link to t.me", async () => {
    const originalFetch = globalThis.fetch;
    const fake = indexMcpFake({ tools: { list_opportunities: () => FIXTURE.responses.listOpportunitiesEmpty.result.content[0].text } });
    globalThis.fetch = fake.fetch;
    try {
      await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      // One request: the revision has no handshake.
      expect(fake.calls).toHaveLength(1);
      for (const call of fake.calls) {
        expect(call.headers["x-index-surface"]).toBe("telegram");
        expect(call.headers["x-api-key"]).toBe("test-key");
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("filterCooldownQuestions", () => {
  const q = (id: string) => ({ id, title: "t", prompt: "p?", mode: "profile" });

  test("keeps undelivered ids, drops within-cooldown and future-dated, re-offers at the boundary", () => {
    const delivery = {
      "q-yesterday": "2026-06-09", // 1 day ago  → dropped
      "q-boundary": "2026-06-07",  // 3 days ago → re-offered
      "q-future": "2026-06-11",    // clock skew → dropped
    };
    const out = filterCooldownQuestions(
      [q("q-new"), q("q-yesterday"), q("q-boundary"), q("q-future")],
      delivery,
      "2026-06-10",
    );
    expect(out.map((x) => x.id)).toEqual(["q-new", "q-boundary"]);
  });
});

describe("buildDailyBriefContext against Index's answers", () => {
  const MAYA_OPP = "bbbbbbbb-0000-4000-8000-000000000001";
  const ENV_KEYS = ["INDEX_API_KEY", "INDEX_MCP_URL", "EDGEOS_API_KEY", "EDGE_AGENT_CONTROL_PLANE_URL", "ADMIN_TOKEN"];

  async function runBrief(listOpportunities: ToolHandler | undefined, state: Record<string, unknown> | null, date = "2026-10-12") {
    const dir = mkdtempSync(join(tmpdir(), "brief-index-"));
    const stateFile = join(dir, "state.json");
    if (state) writeFileSync(stateFile, JSON.stringify(state));
    const before = state ? readFileSync(stateFile, "utf8") : null;
    const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
    const originalFetch = globalThis.fetch;
    delete process.env.EDGEOS_API_KEY;
    delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
    delete process.env.ADMIN_TOKEN;
    process.env.INDEX_API_KEY = "test-key";
    process.env.INDEX_MCP_URL = FAKE_MCP_URL;
    const fake = indexMcpFake(listOpportunities ? { tools: { list_opportunities: listOpportunities } } : {});
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) return new Response("unavailable", { status: 503 });
      return fake.fetch(input, init);
    }) as typeof fetch;
    try {
      const context = await buildDailyBriefContext({ date, stateFile, userFiles: [] });
      const after = existsSync(stateFile) ? readFileSync(stateFile, "utf8") : null;
      return { context, before, after };
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const input of failureInputs("opportunities")) {
    test(`${input.label}: unavailable, not fresh, no state write`, async () => {
      const state = { deliveredToday: { date: "2026-10-12", ids: [] }, dreaming: { lastRunDate: "2026-10-11" } };
      const { context, before, after } = await runBrief(input.handler, state);
      expect(context.diagnostics.opportunitySource).toBe("unavailable");
      expect(context.diagnostics.dreamingFresh).toBe(false);
      expect(context.opportunities).toEqual([]);
      expect(context.diagnostics.warnings).toContain(`opportunities MCP unavailable: ${input.code}`);
      expect(after).toBe(before);
    });
  }

  test("the empty-list object is a fresh, empty mcp list and records the dreaming date", async () => {
    const { context, after } = await runBrief(() => FIXTURE.responses.listOpportunitiesEmpty.result.content[0].text, { dreaming: { lastRunDate: "2026-10-11" } });
    expect(context.diagnostics.opportunitySource).toBe("mcp");
    expect(context.diagnostics.dreamingFresh).toBe(true);
    expect(context.opportunities).toEqual([]);
    expect(JSON.parse(after ?? "{}").dreaming).toEqual({ lastRunDate: "2026-10-12" });
  });

  test("a markdown lead line starting with { does not hide the cards", async () => {
    const fixtureText = FIXTURE.responses.listOpportunities.result.content[0].text;
    const { context } = await runBrief(() => `{Heads up} two people are waiting:\n${fixtureText}`, null);
    expect(context.diagnostics.opportunitySource).toBe("mcp");
    expect(context.connectionOpportunities.map((opp) => opp.name)).toEqual(["Maya"]);
    expect(context.communityOpportunities.map((opp) => opp.name)).toEqual(["Jon"]);
  });

  test("deliveredToday dated yesterday leaves its card eligible; dated today it does not", async () => {
    const yesterday = await runBrief(undefined, { deliveredToday: { date: "2026-10-11", ids: [MAYA_OPP] } });
    expect(yesterday.context.connectionOpportunities.map((opp) => opp.opportunityId)).toEqual([MAYA_OPP]);
    const today = await runBrief(undefined, { deliveredToday: { date: "2026-10-12", ids: [MAYA_OPP] } });
    expect(today.context.connectionOpportunities).toEqual([]);
  });

  test("links on brief cards are Index links of their kind, or rebuilt, or dropped", async () => {
    const { context } = await runBrief(() => listOpportunitiesText([{
      id: MAYA_OPP,
      url: "javascript:alert(1)",
      status: "pending",
      viewerRole: "party",
      headline: "h",
      peer: { name: "Maya", userId: "../../etc/passwd", url: "https://evil.fake.test/u/cccccccc-0000-4000-8000-000000000001" },
    }]), null);
    const [card] = context.connectionOpportunities;
    expect(card.opportunityUrl).toBe(`https://index.network/o/${MAYA_OPP}`);
    expect(card.userUrl).toBeUndefined();
    expect(card.userId).toBeUndefined();
    expect(card.profileUrl).toBeUndefined();
  });
});

describe("attachIndexLinks", () => {
  const OPP = "bbbbbbbb-0000-4000-8000-000000000001";
  const USER = "cccccccc-0000-4000-8000-000000000001";

  test("keeps Index links of the right kind", () => {
    const card = attachIndexLinks({
      name: "A",
      opportunityId: OPP,
      opportunityUrl: `https://index.network/o/${OPP}`,
      userId: USER,
      userUrl: `https://index.network/u/${USER}`,
      intentId: "int-1",
      intentUrl: "https://index.network/i/int-1",
    });
    expect(card).toMatchObject({
      opportunityUrl: `https://index.network/o/${OPP}`,
      userUrl: `https://index.network/u/${USER}`,
      intentUrl: "https://index.network/i/int-1",
    });
  });

  test("rebuilds a hostile or foreign link from a valid id", () => {
    for (const bad of [
      "javascript:alert(1)",
      `https://evil.fake.test/o/${OPP}`,
      `http://index.network/o/${OPP}`,
      `https://index.network.evil.fake.test/o/${OPP}`,
      `https://index.network/u/${OPP}`,
      `https://index.network/o/${OPP}/../../admin`,
      `https://index.network/o/${OPP}?next=https://evil.fake.test`,
    ]) {
      const card = attachIndexLinks({ name: "A", opportunityId: OPP, opportunityUrl: bad });
      expect(card.opportunityUrl).toBe(`https://index.network/o/${OPP}`);
    }
    for (const bad of ["javascript:alert(1)", `https://evil.fake.test/u/${USER}`, `https://index.network/o/${USER}`, "https://index.network/u/../x"]) {
      const card = attachIndexLinks({ name: "A", userId: USER, userUrl: bad, profileUrl: bad, intentId: "int-1", intentUrl: bad });
      expect(card.userUrl).toBe(`https://index.network/u/${USER}`);
      expect(card.intentUrl).toBe("https://index.network/i/int-1");
      expect(card.profileUrl).toBeUndefined();
    }
  });

  test("drops a link and an id when neither is valid", () => {
    const card = attachIndexLinks({
      name: "A",
      opportunityId: "../../admin",
      opportunityUrl: "https://index.network/o/../../admin",
      userId: "not-a-uuid",
      userUrl: "javascript:alert(1)",
      profileUrl: "https://evil.fake.test/u/x",
      intentId: "a/b",
      intentUrl: "https://index.network/i/a/b",
    });
    for (const key of ["opportunityId", "opportunityUrl", "userId", "userUrl", "profileUrl", "intentId", "intentUrl"] as const) {
      expect(key in card).toBe(false);
    }
    expect(card.name).toBe("A");
  });
});
