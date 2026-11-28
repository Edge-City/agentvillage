import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runProactive } from "../proactive";
import { sendDailyBrief } from "../send-daily-brief";
import { dropOpportunity } from "../drop-opportunity";
import { followUp } from "../summarize-negotiations";
import { pendingAlert } from "../pending-alert";
import { postVillageRuntimeAllowed } from "../post-village-policy";
let home: string;
let oldHome: string | undefined;
let oldKey: string | undefined;
const originalFetch = globalThis.fetch;
let requests = 0;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-test-post-village-runtime-"));
  oldHome = process.env.HERMES_HOME; oldKey = process.env.INDEX_API_KEY;
  process.env.HERMES_HOME = home; process.env.INDEX_API_KEY = "synthetic-not-a-key";
  requests = 0;
  globalThis.fetch = (async () => { requests++; throw new Error("unexpected-network"); }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (oldHome === undefined) delete process.env.HERMES_HOME; else process.env.HERMES_HOME = oldHome;
  if (oldKey === undefined) delete process.env.INDEX_API_KEY; else process.env.INDEX_API_KEY = oldKey;
  rmSync(home, { recursive: true, force: true });
});
for (const action of ["prefetch", "brief", "drop-midday", "drop-evening", "negotiation", "pending", "tpl-brief", "tpl-digest-preview"] as const) {
  test(`OFF ${action} returns before context/fetch/model handoff`, async () => {
    let contexts = 0;
    const result = await runProactive(action, { home, buildContext: async () => { contexts++; throw new Error("context-called"); } });
    expect(result.woke).toBe(false); expect(result.reason).toBe("post-village-disabled");
    expect(contexts).toBe(0); expect(requests).toBe(0);
  });
}
for (const [name, run] of [
  ["daily_digest", () => sendDailyBrief()],
  ["opportunity_midday", () => dropOpportunity({ policyKey: "opportunity_midday" })],
  ["opportunity_evening", () => dropOpportunity({ policyKey: "opportunity_evening" })],
  ["negotiation_summary", () => followUp()],
  ["pending_alert", () => pendingAlert()],
] as const) test(`direct ${name} cannot bypass OFF`, async () => {
  expect(await run()).toEqual({ silent: true, reason: "post-village-disabled" }); expect(requests).toBe(0);
});
test("allow never overrides a resident/admin job hold", () => {
  mkdirSync(join(home, "av-events")); mkdirSync(join(home, "cron"));
  writeFileSync(join(home, "av-events/post-village-policy.json"), '{"version":1,"enabled":["daily_digest"]}');
  writeFileSync(join(home, "cron/jobs.json"), JSON.stringify({ jobs: [{ id: "aaaaaaaaaaaa", name: "Edge — daily digest", enabled: true }] }));
  writeFileSync(join(home, "av-events/job-holds.json"), JSON.stringify({ holds: { aaaaaaaaaaaa: "paused" }, by: { aaaaaaaaaaaa: "admin" } }));
  expect(postVillageRuntimeAllowed(home, "daily_digest")).toBe(false);
  expect(existsSync(join(home, "av-events/post-village-policy.json"))).toBe(true);
});

for (const action of ["prefetch", "brief", "tpl-brief"] as const) test(`revocation during real lock wait prevents ${action} context and state effects`, async () => {
  const { acquireStateLock } = await import("../state-lock");
  const { proactiveDir, PREFETCH_FILE } = await import("../proactive");
  mkdirSync(join(home, "av-events")); const policy = join(home, "av-events/post-village-policy.json");
  writeFileSync(policy, '{"version":1,"enabled":["daily_digest"]}');
  const held = await acquireStateLock(join(home, "memory/heartbeat-state.json")); let contexts = 0, revoked = false;
  try {
    const result = await runProactive(action, { home, now: () => new Date("2026-11-28T03:00:00Z"), lock: { sleep: async () => { writeFileSync(policy, '{"version":1,"enabled":[]}'); revoked = true; held.release(); } }, buildContext: async () => { contexts++; return {} as any; } });
    expect(revoked).toBe(true); expect(result.reason).toBe("post-village-disabled"); expect(contexts).toBe(0); expect(existsSync(join(proactiveDir(home), PREFETCH_FILE))).toBe(false); expect(existsSync(join(home, "memory/heartbeat-state.json"))).toBe(false);
  } finally { held.release(); }
});
test("follow-up revocation after opportunities avoids second fetch and all reporting ledger writes", async () => {
  const { indexMcpFake, FAKE_MCP_URL, listOpportunitiesText } = await import("./index-mcp-fake");
  mkdirSync(join(home, "av-events")); const policy = join(home, "av-events/post-village-policy.json"); writeFileSync(policy, '{"version":1,"enabled":["negotiation_summary"]}');
  const stateFile = join(home, "state.json"); writeFileSync(stateFile, '{}');
  const id = "bbbbbbbb-0000-4000-8000-000000000001";
  const fake = indexMcpFake({ tools: { list_opportunities: () => { writeFileSync(policy, '{"version":1,"enabled":[]}'); return listOpportunitiesText([{ id, url: `https://index.network/o/${id}`, status: "accepted", viewerRole: "party", headline: "Ana headline", summary: "Ana summary", peer: { name: "Ana", userId: "cccccccc-0000-4000-8000-000000000001", url: "https://index.network/u/cccccccc-0000-4000-8000-000000000001" } }]); } } });
  globalThis.fetch = fake.fetch;
  expect(await followUp({ home, stateFile, apiKey: "synthetic", mcpUrl: FAKE_MCP_URL })).toEqual({ silent: true, reason: "post-village-disabled" });
  expect(fake.calls.map((call) => call.name)).toEqual(["list_opportunities"]); expect(readFileSync(stateFile, "utf8")).toBe('{}');
});

test("direct brief revocation during awaited task completion withholds public body", async () => {
  mkdirSync(join(home, "av-events")); const policy = join(home, "av-events/post-village-policy.json"); writeFileSync(policy, '{"version":1,"enabled":["daily_digest"]}');
  const stateFile = join(home, "state.json"); writeFileSync(stateFile, JSON.stringify({ prepared: { date: "2026-11-28", taskId: "t_digest", opportunityIds: ["opp-1"] } }));
  let completed = false;
  const result = await sendDailyBrief({ home, date: "2026-11-28", stateFile, outgoingFile: join(home, "outgoing.md"), hermes: async (args) => {
    if (args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body: "🌞 Good morning\nA current brief." } });
    if (args[1] === "complete") { completed = true; writeFileSync(policy, '{"version":1,"enabled":[]}'); return "completed"; }
    throw new Error("unexpected-hermes");
  } });
  expect(completed).toBe(true); expect(result).toEqual({ silent: true, reason: "post-village-disabled" }); expect(JSON.parse(readFileSync(stateFile, "utf8")).deliveredToday.ids).toContain("opp-1");
});

test("revocation during awaited prefetch build prevents its artifact", async () => {
  const { proactiveDir, PREFETCH_FILE } = await import("../proactive");
  mkdirSync(join(home, "av-events")); const policy = join(home, "av-events/post-village-policy.json"); writeFileSync(policy, '{"version":1,"enabled":["daily_digest"]}');
  let contexts = 0;
  const result = await runProactive("prefetch", { home, buildContext: async () => { contexts++; writeFileSync(policy, '{"version":1,"enabled":[]}'); return {} as any; } });
  expect(contexts).toBe(1); expect(result.reason).toBe("post-village-disabled"); expect(existsSync(join(proactiveDir(home), PREFETCH_FILE))).toBe(false);
});
test("revocation during awaited pending action prevents action flags and day ledger", async () => {
  mkdirSync(join(home, "av-events")); const policy = join(home, "av-events/post-village-policy.json"); writeFileSync(policy, '{"version":1,"enabled":["pending_alert"]}');
  const state = join(home, "memory/heartbeat-state.json"); mkdirSync(join(home, "memory")); writeFileSync(state, '{}');
  let calls = 0;
  // A fixed clock inside the pending alert's delivery window (08:00 to 22:00 Asia/Kolkata): on the real clock this
  // test failed every day from 16:30Z to 02:30Z, when the run is "outside-window" before the action is ever called.
  const result = await runProactive("pending", { home, now: () => new Date("2026-11-28T03:00:00Z"), pending: async () => { calls++; writeFileSync(policy, '{"version":1,"enabled":[]}'); return { silent: true, reason: "none" }; } });
  expect(calls).toBe(1); expect(result.reason).toBe("post-village-disabled"); expect(readFileSync(state, "utf8")).toBe('{}');
});

test("legacy injected negotiation categorizer retains its pure helper contract", async () => {
  const { summarizeNegotiations } = await import("../summarize-negotiations");
  const stateFile = join(home, "legacy-summary.json");
  expect(await summarizeNegotiations({ fetchNegotiations: async () => [], stateFile })).toEqual({ silent: true, reason: "nothing-to-report" });
  expect(existsSync(stateFile)).toBe(false);
});
