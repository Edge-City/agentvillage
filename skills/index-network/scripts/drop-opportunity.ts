#!/usr/bin/env bun
/**
 * Deterministically pick and deliver ONE extra opportunity between morning briefs.
 *
 * The morning digest delivers the full brief once a day; this powers the lighter
 * mid-day / evening "opportunity drop" crons that surface a single fresh
 * opportunity. It owns selection, dedup, and ledger confirmation so the prompt
 * only has to render the one card it returns:
 *
 *   - Reads today's `deliveredToday` set from `memory/heartbeat-state.json` and
 *     filters it out of `list_opportunities`, so a drop never repeats anything the
 *     morning brief (or an earlier drop) already sent that day, and vice versa.
 *   - Picks the single best undelivered opportunity (fresh over re-show, then
 *     highest confidence).
 *   - Records its id in the same `deliveredToday` set and confirms delivery on the
 *     Index ledger, exactly like the daily send.
 *
 * Prints `[SILENT]` when there is nothing new to send, otherwise one JSON object
 * describing the chosen opportunity for the prompt to render.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  type BriefOpportunity,
  confirmOpportunityDeliveriesViaMcp,
  fetchOpportunitiesFromMcp,
  filterDedupedOpportunities,
  pacificDate,
  resolveIndexApiKey,
} from "./build-daily-brief-context";

interface DropResult {
  opportunity: BriefOpportunity;
}

interface SilentResult {
  silent: true;
  reason: string;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || "/opt/data";
}

function resolveHermesPath(path: string): string {
  return isAbsolute(path) ? path : join(hermesHome(), path);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Fresh opportunities before cooldown re-shows, then most confident first. */
function pickBest(opportunities: BriefOpportunity[]): BriefOpportunity | undefined {
  return [...opportunities].sort((a, b) => {
    if (Boolean(a.redelivery) !== Boolean(b.redelivery)) return a.redelivery ? 1 : -1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

export async function dropOpportunity(options: {
  date?: string;
  stateFile?: string;
  apiKey?: string;
  mcpUrl?: string;
  fetchOpportunities?: typeof fetchOpportunitiesFromMcp;
  confirmDeliveries?: (opportunityIds: string[]) => Promise<unknown>;
} = {}): Promise<DropResult | SilentResult> {
  const date = options.date ?? pacificDate();
  const stateFile = resolveHermesPath(options.stateFile ?? "memory/heartbeat-state.json");
  const apiKey = options.apiKey ?? resolveIndexApiKey();
  if (!apiKey) return { silent: true, reason: "no-api-key" };
  const mcpUrl = options.mcpUrl ?? process.env.INDEX_MCP_URL?.trim() ?? "https://protocol.index.network/mcp";

  const fetched = options.fetchOpportunities
    ? await options.fetchOpportunities({ apiKey, mcpUrl })
    : await fetchOpportunitiesFromMcp({ apiKey, mcpUrl });

  const state = await readJsonObject(stateFile);
  const deliveredToday =
    state.deliveredToday && typeof state.deliveredToday === "object" && !Array.isArray(state.deliveredToday)
      ? (state.deliveredToday as Record<string, unknown>)
      : {};
  const deliveredIds = new Set(deliveredToday.date === date ? stringArray(deliveredToday.ids) : []);

  const candidates = filterDedupedOpportunities(fetched, deliveredIds).filter((opp) => opp.opportunityId);
  const chosen = pickBest(candidates);
  if (!chosen?.opportunityId) return { silent: true, reason: "nothing-new" };

  // Reserve the id in the shared per-day set BEFORE delivery so a retry or the
  // morning brief never double-sends it. This mirrors the daily send's bookkeeping.
  state.deliveredToday = {
    date,
    ids: Array.from(new Set([...deliveredIds, chosen.opportunityId])),
  };
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  const confirm = options.confirmDeliveries
    ? options.confirmDeliveries
    : (ids: string[]) => confirmOpportunityDeliveriesViaMcp({ apiKey, mcpUrl, opportunityIds: ids });
  try {
    await confirm([chosen.opportunityId]);
  } catch {
    // Ledger confirm is best-effort; the drop still ships. The id is already
    // recorded in deliveredToday so it will not resurface today.
  }

  return { opportunity: chosen };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await dropOpportunity({
    date: argValue(args, "--date"),
    stateFile: argValue(args, "--state-file"),
  });

  if ("silent" in result) {
    process.stdout.write("[SILENT]\n");
    return;
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  await main();
}
