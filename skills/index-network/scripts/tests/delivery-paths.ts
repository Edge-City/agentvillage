/**
 * Shared harness for the card-cooldown tests: runs each delivery path end to
 * end against the Index fake (never the network) on a temp state file, and
 * reports which opportunity ids it delivered.
 *
 *   briefAndSend  the morning brief: prepare, stage every card it offers (as
 *                 the prompt's markers would), send
 *   drop          one opportunity drop (12:00 and 17:00)
 *   followUp      the 14:00 follow-up's "waiting on you" list
 *   evening       the 19:00 evening card
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { askQuestions } from "../ask-questions";
import { buildDailyBriefContext, type DailyBriefContext } from "../build-daily-brief-context";
import { OPPORTUNITY_DELIVERY_KEY, type DeliveryLog } from "../delivery-state";
import { dropOpportunity } from "../drop-opportunity";
import { sendDailyBrief } from "../send-daily-brief";
import { main as followUpMain } from "../summarize-negotiations";
import { FAKE_MCP_URL, type ToolHandler, indexMcpFake, listOpportunitiesText } from "./index-mcp-fake";

export const DAY0 = "2026-10-12";
const ENV_KEYS = ["INDEX_API_KEY", "INDEX_MCP_URL", "EDGEOS_API_KEY", "EDGE_AGENT_CONTROL_PLANE_URL", "ADMIN_TOKEN"];

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function oppId(n: number): string {
  return `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export const MAYA = oppId(1);
export const JON = oppId(2);

/** A pending direct-conversation row with id oppId(n). */
export function row(name: string, n: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const userId = `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
  return {
    id: oppId(n),
    url: `https://index.network/o/${oppId(n)}`,
    status: "pending",
    viewerRole: "party",
    headline: `${name} headline`,
    summary: `${name} summary`,
    peer: { name, userId, url: `https://index.network/u/${userId}` },
    ...extra,
  };
}

/** Every row, whatever the request asked for, with no pagination object. */
export const list = (...rows: unknown[]): ToolHandler => () => listOpportunitiesText(rows);
export const failing: ToolHandler = () => ({ result: { content: [{ type: "text", text: "private detail" }], isError: true } });

const dirs: string[] = [];
const originalFetch = globalThis.fetch;
const originalArgv = process.argv;

/** Call from afterEach. */
export function cleanUp(): void {
  globalThis.fetch = originalFetch;
  process.argv = originalArgv;
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
}

export function newStateFile(state?: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "delivery-cooldown-"));
  dirs.push(dir);
  const file = join(dir, "state.json");
  if (state) writeFileSync(file, JSON.stringify(state, null, 2));
  return file;
}

export function readState(file: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function readLog(file: string): DeliveryLog | undefined {
  return readState(file)[OPPORTUNITY_DELIVERY_KEY] as DeliveryLog | undefined;
}

export function fileText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Point the scripts at the fake Index (and nothing else) while `run` runs. */
export async function withIndex<T>(listOpportunities: ToolHandler, run: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  delete process.env.EDGEOS_API_KEY;
  delete process.env.EDGE_AGENT_CONTROL_PLANE_URL;
  delete process.env.ADMIN_TOKEN;
  process.env.INDEX_API_KEY = "test-key";
  process.env.INDEX_MCP_URL = FAKE_MCP_URL;
  const fake = indexMcpFake({ tools: { list_opportunities: listOpportunities } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("open-meteo")) return new Response("unavailable", { status: 503 });
    return fake.fetch(input, init);
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

export function idFromUrl(url: unknown): string {
  return typeof url === "string" ? url.split("/o/")[1] ?? "" : "";
}

export function briefIds(context: DailyBriefContext): string[] {
  return context.opportunities.map((opp) => opp.opportunityId ?? "");
}

export async function prepare(date: string, file: string, handler: ToolHandler): Promise<DailyBriefContext> {
  return withIndex(handler, () => buildDailyBriefContext({ date, stateFile: file, userFiles: [] }));
}

/** The brief reads Index at prepare; its send makes no Index call. */
export async function prepareIds(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  return briefIds(await prepare(date, file, handler));
}

export async function briefAndSend(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const context = await prepare(date, file, handler);
  const ids = briefIds(context);
  const state = readState(file);
  state.prepared = { date, taskId: "t_digest", opportunityIds: ids };
  writeFileSync(file, JSON.stringify(state, null, 2));
  const result = await sendDailyBrief({
    date,
    stateFile: file,
    outgoingFile: join(file, "..", "outgoing.md"),
    hermes: (args) => {
      if (args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body: "brief" } });
      if (args[1] === "complete") return "completed";
      throw new Error(`unexpected hermes call: ${args.join(" ")}`);
    },
  });
  if ("silent" in result) throw new Error(`send was silent: ${result.reason}`);
  return ids;
}

export async function drop(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const result = await withIndex(handler, () => dropOpportunity({ date, stateFile: file, apiKey: "test-key", mcpUrl: FAKE_MCP_URL }));
  return "silent" in result ? [] : [result.opportunity.opportunityId ?? ""];
}

export async function evening(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const result = await withIndex(handler, () => askQuestions({ date, stateFile: file, apiKey: "test-key" }));
  return "name" in result ? [idFromUrl(result.opportunityUrl)] : [];
}

export async function followUpRaw(date: string, file: string, handler: ToolHandler): Promise<string> {
  process.argv = [...originalArgv.slice(0, 2), "--state-file", file, "--date", date];
  let out = "";
  const write = { out: process.stdout.write, err: process.stderr.write };
  process.stdout.write = ((chunk: string) => {
    out += chunk;
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  try {
    await withIndex(handler, () => followUpMain());
  } finally {
    process.stdout.write = write.out;
    process.stderr.write = write.err;
    process.argv = originalArgv;
  }
  return out;
}

export async function followUp(date: string, file: string, handler: ToolHandler): Promise<string[]> {
  const out = await followUpRaw(date, file, handler);
  if (out === "[SILENT]") return [];
  return JSON.parse(out).needsAttention.map((card: { opportunityUrl?: string }) => idFromUrl(card.opportunityUrl));
}

export type Path = (date: string, file: string, handler: ToolHandler) => Promise<string[]>;
