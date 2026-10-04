import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dropOpportunity } from "../drop-opportunity";
import { FAKE_MCP_URL, indexMcpFake, listOpportunitiesText } from "./index-mcp-fake";
import { failureInputs } from "./index-failure-inputs";
import { pinDeliveryClock } from "./pin-clock";

pinDeliveryClock();

const MAYA_OPP = "bbbbbbbb-0000-4000-8000-000000000001";
const JON_OPP = "bbbbbbbb-0000-4000-8000-000000000002";

const originalFetch = globalThis.fetch;
const dirs: string[] = [];

function stateFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "drop-opportunity-"));
  dirs.push(dir);
  return join(dir, "state.json");
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe("dropOpportunity", () => {
  test("drops the best card not delivered today, records it locally, and makes only the list call", async () => {
    const file = stateFile();
    // An empty delivery log, so only the same-day dedupe keeps Maya out.
    await Bun.write(file, JSON.stringify({ deliveredToday: { date: "2026-10-12", ids: [MAYA_OPP] }, dreaming: { lastRunDate: "2026-10-12" }, opportunityDelivery: {} }));
    const fake = indexMcpFake();
    globalThis.fetch = fake.fetch;

    const result = await dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL });

    if ("silent" in result) throw new Error(`unexpected silent result: ${result.reason}`);
    expect(result.opportunity).toMatchObject({
      name: "Jon",
      opportunityId: JON_OPP,
      opportunityUrl: `https://index.network/o/${JON_OPP}`,
      userUrl: "https://index.network/u/cccccccc-0000-4000-8000-000000000002",
    });
    expect(fake.calls.map((call) => [call.method, call.name, call.status])).toEqual([["tools/call", "list_opportunities", 200]]);
    const state = JSON.parse(await Bun.file(file).text());
    expect(state.deliveredToday).toEqual({ date: "2026-10-12", ids: [MAYA_OPP, JON_OPP] });
    expect(state.dreaming).toEqual({ lastRunDate: "2026-10-12" });
  });

  test("is silent when everything listed was already delivered today", async () => {
    const file = stateFile();
    await Bun.write(file, JSON.stringify({ deliveredToday: { date: "2026-10-12", ids: [MAYA_OPP, JON_OPP] }, opportunityDelivery: {} }));
    globalThis.fetch = indexMcpFake().fetch;

    const result = await dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL });

    expect(result).toEqual({ silent: true, reason: "nothing-new" });
  });

  test("is silent without a key and never calls out", async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      throw new Error("no call expected");
    }) as unknown as typeof fetch;

    const result = await dropOpportunity({ date: "2026-10-12", stateFile: stateFile(), apiKey: "" });

    expect(result).toEqual({ silent: true, reason: "no-api-key" });
    expect(called).toBe(false);
  });

  test("an Index failure rejects with a code and records nothing", async () => {
    const file = stateFile();
    globalThis.fetch = indexMcpFake({
      tools: { list_opportunities: () => ({ result: { content: [{ type: "text", text: "private detail" }], isError: true } }) },
    }).fetch;

    await expect(
      dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL }),
    ).rejects.toThrow("mcp-tool-error");
    expect(existsSync(file)).toBe(false);
  });
});

describe("dropOpportunity against Index's answers", () => {
  for (const input of failureInputs("opportunities")) {
    test(`${input.label}: rejects with ${input.code} and records nothing`, async () => {
      const file = stateFile();
      const before = JSON.stringify({ deliveredToday: { date: "2026-10-12", ids: [] } });
      await Bun.write(file, before);
      globalThis.fetch = indexMcpFake({ tools: { list_opportunities: input.handler } }).fetch;
      await expect(
        dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL }),
      ).rejects.toThrow(input.code);
      expect(await Bun.file(file).text()).toBe(before);
    });
  }

  test("deliveredToday dated yesterday is no same-day dedupe: with an empty delivery log its card is eligible today", async () => {
    const file = stateFile();
    await Bun.write(file, JSON.stringify({ deliveredToday: { date: "2026-10-11", ids: [MAYA_OPP] }, opportunityDelivery: {} }));
    globalThis.fetch = indexMcpFake().fetch;
    const result = await dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL });
    if ("silent" in result) throw new Error(`unexpected silent result: ${result.reason}`);
    expect(result.opportunity.opportunityId).toBe(MAYA_OPP);
    expect(JSON.parse(await Bun.file(file).text()).deliveredToday).toEqual({ date: "2026-10-12", ids: [MAYA_OPP] });
  });

  test("the dropped card carries only Index links of their kind", async () => {
    globalThis.fetch = indexMcpFake({
      tools: {
        list_opportunities: () => listOpportunitiesText([{
          id: MAYA_OPP,
          url: "javascript:alert(1)",
          status: "pending",
          headline: "h",
          peer: { name: "Maya", userId: "../../x", url: "https://evil.fake.test/u/cccccccc-0000-4000-8000-000000000001" },
        }]),
      },
    }).fetch;
    const result = await dropOpportunity({ date: "2026-10-12", stateFile: stateFile(), apiKey: "test-key", mcpUrl: FAKE_MCP_URL });
    if ("silent" in result) throw new Error(`unexpected silent result: ${result.reason}`);
    expect(result.opportunity.opportunityUrl).toBe(`https://index.network/o/${MAYA_OPP}`);
    for (const key of ["userUrl", "userId", "profileUrl"] as const) expect(key in result.opportunity).toBe(false);
  });

  test("a card without a valid id is never dropped, and is not selected over a valid one", async () => {
    const rows = [
      { id: "../../x", url: "https://index.network/o/x", status: "pending", viewerRole: "party", headline: "h", peer: { name: "Bad Path" } },
      { url: "https://index.network/o/y", status: "pending", viewerRole: "party", headline: "h", peer: { name: "No Id" } },
      { id: "has space", status: "pending", viewerRole: "agent", headline: "h", peer: { name: "Space Id" } },
    ];
    const file = stateFile();
    globalThis.fetch = indexMcpFake({ tools: { list_opportunities: () => listOpportunitiesText(rows) } }).fetch;
    expect(await dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL })).toEqual({
      silent: true,
      reason: "nothing-new",
    });
    expect(existsSync(file)).toBe(false);
    globalThis.fetch = indexMcpFake({
      tools: { list_opportunities: () => listOpportunitiesText([...rows, { id: JON_OPP, url: `https://index.network/o/${JON_OPP}`, status: "pending", headline: "h", peer: { name: "Jon" } }]) },
    }).fetch;
    const result = await dropOpportunity({ date: "2026-10-12", stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL });
    if ("silent" in result) throw new Error(`unexpected silent result: ${result.reason}`);
    expect(result.opportunity.opportunityId).toBe(JON_OPP);
    expect(JSON.parse(await Bun.file(file).text()).deliveredToday).toEqual({ date: "2026-10-12", ids: [JON_OPP] });
  });
});
