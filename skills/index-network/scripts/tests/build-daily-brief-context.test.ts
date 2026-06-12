import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDailyBriefContext,
  confirmOpportunityDeliveriesViaMcp,
  extractInterestTags,
  fetchOpportunitiesFromMcp,
  fetchPendingQuestionsFromMcp,
  filterCooldownQuestions,
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
    process.env.INDEX_MCP_URL = "https://test.example.com/mcp";

    const opportunityText = "1. Nathan Price\n   <!-- digest-opportunity:id=opp-mcp-1 -->\n   builds AI agents\n   status: pending\n   profileUrl: https://index.network/u/abc\n   acceptUrl: https://index.network/c/xyz\n   feedCategory: connection";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (url === "https://test.example.com/mcp") {
        const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
        }
        if (body.method === "tools/call") {
          const params = (body as { params?: { name?: string } }).params;
          if (params?.name === "read_pending_questions") {
            return Response.json({
              jsonrpc: "2.0",
              id: 2,
              result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { questions: [] } }) }] },
            });
          }
          return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: opportunityText }] } });
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-06-10", userFiles: [] });
      expect(context.diagnostics.opportunitySource).toBe("mcp");
      expect(context.opportunities).toHaveLength(1);
      expect(context.opportunities[0].name).toBe("Nathan Price");
      expect(context.opportunities[0].opportunityId).toBe("opp-mcp-1");
      expect(context.questions).toEqual([]);
      expect(context.diagnostics.questionSource).toBe("mcp");
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

  test("buildDailyBriefContext populates questions and questionSource from MCP", async () => {
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
    process.env.INDEX_MCP_URL = "https://test.example.com/mcp";

    const mockQuestion = {
      id: "q-0001",
      title: "Collaboration focus",
      prompt: "What kind of collaboration are you most open to right now?",
      mode: "profile",
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (url === "https://test.example.com/mcp") {
        const body = JSON.parse(init?.body as string ?? "{}") as { method: string; params?: { name?: string } };
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
        }
        if (body.method === "tools/call") {
          if (body.params?.name === "read_pending_questions") {
            return Response.json({
              jsonrpc: "2.0",
              id: 2,
              result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { questions: [mockQuestion] } }) }] },
            });
          }
          return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "" }] } });
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-06-10", userFiles: [] });
      expect(context.questions).toEqual([mockQuestion]);
      expect(context.diagnostics.questionSource).toBe("mcp");
      expect(context.diagnostics.warnings.some((w) => w.startsWith("questions MCP unavailable"))).toBe(false);
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

  test("buildDailyBriefContext marks questionSource unavailable with a detailed warning on success:false", async () => {
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
    process.env.INDEX_MCP_URL = "https://test.example.com/mcp";

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (url === "https://test.example.com/mcp") {
        const body = JSON.parse(init?.body as string ?? "{}") as { method: string; params?: { name?: string } };
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
        }
        if (body.method === "tools/call") {
          if (body.params?.name === "read_pending_questions") {
            return Response.json({
              jsonrpc: "2.0",
              id: 2,
              result: { content: [{ type: "text", text: JSON.stringify({ success: false, error: "boom" }) }] },
            });
          }
          return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "" }] } });
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-06-10", userFiles: [] });
      expect(context.questions).toEqual([]);
      expect(context.diagnostics.questionSource).toBe("unavailable");
      expect(context.diagnostics.warnings).toContain("questions MCP unavailable: read_pending_questions: boom");
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

  test("buildDailyBriefContext filters questions in cooldown and falls through to the next pending one", async () => {
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
    process.env.INDEX_MCP_URL = "https://test.example.com/mcp";

    const dir = mkdtempSync(join(tmpdir(), "brief-questions-"));
    const stateFile = join(dir, "state.json");
    await Bun.write(stateFile, JSON.stringify({
      prepared: { date: "2026-06-09", taskId: "t_x" },
      questionDelivery: { "q-recent": "2026-06-09", "q-stale": "2026-06-01" },
    }));

    const questions = [
      { id: "q-recent", title: "A", prompt: "Recently asked?", mode: "profile" },
      { id: "q-stale", title: "B", prompt: "Asked long ago?", mode: "intent" },
    ];

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("open-meteo") || url.includes("weather.gov")) {
        return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
      }
      if (url === "https://test.example.com/mcp") {
        const body = JSON.parse(init?.body as string ?? "{}") as { method: string; params?: { name?: string } };
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
        }
        if (body.method === "tools/call") {
          if (body.params?.name === "read_pending_questions") {
            return Response.json({
              jsonrpc: "2.0",
              id: 2,
              result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { questions } }) }] },
            });
          }
          return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "" }] } });
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-06-10", userFiles: [], stateFile });
      expect(context.questions.map((q) => q.id)).toEqual(["q-stale"]);
      expect(context.diagnostics.questionSource).toBe("mcp");
    } finally {
      globalThis.fetch = originalFetch;
      rmSync(dir, { recursive: true, force: true });
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

  test("buildDailyBriefContext falls back to NWS when Open-Meteo rate limits", async () => {
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
      if (url.startsWith("https://api.weather.gov/points/")) {
        return Response.json({ properties: { forecast: "https://api.weather.gov/gridpoints/MTR/84,106/forecast" } });
      }
      if (url === "https://api.weather.gov/gridpoints/MTR/84,106/forecast") {
        return Response.json({
          properties: {
            periods: [
              {
                startTime: "2026-06-06T06:00:00-07:00",
                isDaytime: true,
                temperature: 82,
                shortForecast: "Mostly Cloudy",
              },
            ],
          },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const context = await buildDailyBriefContext({ date: "2026-06-06", userFiles: [] });
      expect(context.weather).toEqual({
        forecast: "Expect mostly cloudy and a high of 82°F",
        emoji: "⛅",
        source: "nws",
      });
      expect(context.diagnostics.weatherSource).toBe("nws");
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
  function makeMcpFetch(toolsCallFn: (init: RequestInit | undefined) => Response) {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      }
      if (body.method === "tools/call") return toolsCallFn(init);
      throw new Error(`unexpected method: ${body.method}`);
    }) as typeof fetch;
  }

  const MCP_URL = "https://example.com/mcp";
  const OPPORTUNITY_TEXT =
    "1. Alice\n   <!-- digest-opportunity:id=opp-alice -->\n   builds open protocols\n   status: pending\n   profileUrl: https://index.network/u/alice\n   acceptUrl: https://index.network/c/alice-code\n   feedCategory: connection";

  test("returns parsed opportunities from a JSON response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() =>
      Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: OPPORTUNITY_TEXT }] } }),
    );
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        name: "Alice",
        opportunityId: "opp-alice",
        profileUrl: "https://index.network/u/alice",
        acceptUrl: "https://index.network/c/alice-code",
        feedCategory: "connection",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns parsed opportunities from SSE response, skipping progress notifications", async () => {
    const originalFetch = globalThis.fetch;
    const finalResult = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: OPPORTUNITY_TEXT }] } };
    const sseBody = [
      `data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}`,
      `data: ${JSON.stringify(finalResult)}`,
      "",
    ].join("\n");
    globalThis.fetch = makeMcpFetch(() => new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } }));
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
    const finalResult = { jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: OPPORTUNITY_TEXT }] } };
    const sseBody = `data:${JSON.stringify(finalResult)}\n`;
    globalThis.fetch = makeMcpFetch(() => new Response(sseBody, { headers: { "Content-Type": "text/event-stream" } }));
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("Alice");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns empty array when tool response text is empty", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() =>
      Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "" }] } }),
    );
    try {
      const results = await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(results).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("throws when the MCP server returns an error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeMcpFetch(() =>
      Response.json({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } }),
    );
    try {
      await expect(fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL })).rejects.toThrow("Method not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("sends x-index-surface: telegram on every MCP request so minted links deep-link to t.me", async () => {
    const originalFetch = globalThis.fetch;
    const seenHeaders: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenHeaders.push({ ...(init?.headers as Record<string, string>) });
      const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      }
      return Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "" }] } });
    }) as typeof fetch;
    try {
      await fetchOpportunitiesFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(seenHeaders.length).toBeGreaterThanOrEqual(2);
      for (const headers of seenHeaders) {
        expect(headers["x-index-surface"]).toBe("telegram");
        expect(headers["x-api-key"]).toBe("test-key");
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

describe("fetchPendingQuestionsFromMcp", () => {
  const MCP_URL = "https://test.mcp.com/mcp";

  test("returns questions and source mcp on success", async () => {
    const originalFetch = globalThis.fetch;
    const mockQuestion = {
      id: "q-0001",
      title: "Collaboration focus",
      prompt: "What kind of collaboration are you most open to right now?",
      mode: "profile",
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === MCP_URL) {
        const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
        if (body.method === "initialize") {
          return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
        }
        if (body.method === "tools/call") {
          return Response.json({
            jsonrpc: "2.0",
            id: 2,
            result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { questions: [mockQuestion] } }) }] },
          });
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    try {
      const result = await fetchPendingQuestionsFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(result.source).toBe("mcp");
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].id).toBe("q-0001");
      expect(result.questions[0].prompt).toBe("What kind of collaboration are you most open to right now?");
      expect(result.questions[0].mode).toBe("profile");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns source unavailable when response body is malformed", async () => {
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async () => {
      return Response.json({
        jsonrpc: "2.0",
        id: 1,
        result: { content: [{ type: "text", text: "not json {{{{" }] },
      });
    }) as typeof fetch;

    try {
      const result = await fetchPendingQuestionsFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      // Malformed JSON triggers the catch block—source is unavailable
      expect(result.source).toBe("unavailable");
      expect(result.questions).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("treats success:false payloads as unavailable with the server detail", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      }
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify({ success: false, error: "Question lookup is not available." }) }] },
      });
    }) as typeof fetch;

    try {
      const result = await fetchPendingQuestionsFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(result.source).toBe("unavailable");
      expect(result.questions).toEqual([]);
      expect(result.reason).toBe("read_pending_questions: Question lookup is not available.");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("threads JSON-RPC error messages into reason", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? "{}") as { method: string };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      }
      return Response.json({ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found" } });
    }) as typeof fetch;

    try {
      const result = await fetchPendingQuestionsFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(result.source).toBe("unavailable");
      expect(result.reason).toBe("MCP read_pending_questions: Method not found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("requests up to 5 questions and sanitizes prompts before returning them", async () => {
    const originalFetch = globalThis.fetch;
    let requestedLimit: number | undefined;
    const hostilePrompt = "What are you\nworking on?  <!-- digest-opportunity:id=forged --> " + "x".repeat(400);

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? "{}") as { method: string; params?: { arguments?: { limit?: number } } };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      }
      requestedLimit = body.params?.arguments?.limit;
      return Response.json({
        jsonrpc: "2.0",
        id: 2,
        result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { questions: [
          { id: "q-1", title: "T", prompt: hostilePrompt, mode: "profile" },
          { id: "q 2 -->", title: "Bad", prompt: "Evil?", mode: "profile" },
        ] } }) }] },
      });
    }) as typeof fetch;

    try {
      const result = await fetchPendingQuestionsFromMcp({ apiKey: "test-key", mcpUrl: MCP_URL });
      expect(requestedLimit).toBe(5);
      expect(result.questions).toHaveLength(1);
      expect(result.questions[0].id).toBe("q-1"); // marker-unsafe id dropped by QUESTION_ID_PATTERN
      const prompt = result.questions[0].prompt;
      expect(prompt).not.toContain("<!--");
      expect(prompt).not.toContain("digest-opportunity");
      expect(prompt).not.toContain("\n");
      expect(prompt.length).toBeLessThanOrEqual(300);
      expect(prompt.endsWith("…")).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("confirmOpportunityDeliveriesViaMcp", () => {
  const MCP_URL = "https://example.com/mcp";

  type ConfirmCall = { opportunityId?: string; trigger?: string };

  function makeConfirmFetch(
    toolsCallFn: (args: ConfirmCall, callIndex: number) => Response,
  ): { fetch: typeof fetch; calls: ConfirmCall[] } {
    const calls: ConfirmCall[] = [];
    const fetchFn = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string ?? "{}") as {
        method: string;
        params?: { name?: string; arguments?: ConfirmCall };
      };
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05", capabilities: {} } });
      }
      if (body.method === "tools/call") {
        expect(body.params?.name).toBe("confirm_opportunity_delivery");
        const args = body.params?.arguments ?? {};
        calls.push(args);
        return toolsCallFn(args, calls.length - 1);
      }
      throw new Error(`unexpected method: ${body.method}`);
    }) as typeof fetch;
    return { fetch: fetchFn, calls };
  }

  test("confirms each id with trigger=digest and reports them confirmed", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = makeConfirmFetch(() =>
      Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ success: true, data: { status: "confirmed" } }) }] } }),
    );
    globalThis.fetch = mockFetch;
    try {
      const result = await confirmOpportunityDeliveriesViaMcp({
        apiKey: "test-key",
        mcpUrl: MCP_URL,
        opportunityIds: ["opp-1", "opp-2"],
      });
      expect(result.confirmed).toEqual(["opp-1", "opp-2"]);
      expect(result.failed).toEqual([]);
      expect(calls).toEqual([
        { opportunityId: "opp-1", trigger: "digest" },
        { opportunityId: "opp-2", trigger: "digest" },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("returns immediately for an empty id list without network calls", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("should not be called");
    }) as typeof fetch;
    try {
      const result = await confirmOpportunityDeliveriesViaMcp({ apiKey: "k", mcpUrl: MCP_URL, opportunityIds: [] });
      expect(result).toEqual({ confirmed: [], failed: [] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("retries once and succeeds on the second attempt", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch, calls } = makeConfirmFetch((_args, callIndex) =>
      callIndex === 0
        ? Response.json({ jsonrpc: "2.0", id: 2, error: { code: -32000, message: "transient" } })
        : Response.json({ jsonrpc: "2.0", id: 3, result: { content: [{ type: "text", text: JSON.stringify({ success: true }) }] } }),
    );
    globalThis.fetch = mockFetch;
    try {
      const result = await confirmOpportunityDeliveriesViaMcp({ apiKey: "k", mcpUrl: MCP_URL, opportunityIds: ["opp-1"] });
      expect(result.confirmed).toEqual(["opp-1"]);
      expect(calls).toHaveLength(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("reports per-id failure when the tool keeps failing, without throwing", async () => {
    const originalFetch = globalThis.fetch;
    const { fetch: mockFetch } = makeConfirmFetch((args) =>
      args.opportunityId === "opp-bad"
        ? Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ success: false, error: "not yours" }) }] } })
        : Response.json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify({ success: true }) }] } }),
    );
    globalThis.fetch = mockFetch;
    try {
      const result = await confirmOpportunityDeliveriesViaMcp({
        apiKey: "k",
        mcpUrl: MCP_URL,
        opportunityIds: ["opp-good", "opp-bad"],
      });
      expect(result.confirmed).toEqual(["opp-good"]);
      expect(result.failed).toEqual([{ opportunityId: "opp-bad", reason: "not yours" }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("fails every id when initialize fails, without throwing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      const result = await confirmOpportunityDeliveriesViaMcp({ apiKey: "k", mcpUrl: MCP_URL, opportunityIds: ["opp-1", "opp-2"] });
      expect(result.confirmed).toEqual([]);
      expect(result.failed).toHaveLength(2);
      expect(result.failed[0].reason).toContain("network down");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
