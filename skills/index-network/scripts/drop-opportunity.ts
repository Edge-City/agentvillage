#!/usr/bin/env bun
/**
 * Deterministically pick and deliver ONE extra opportunity between morning briefs.
 *
 * The morning digest delivers the full brief once a day; this powers the lighter
 * mid-day / evening "opportunity drop" crons that surface a single fresh
 * opportunity. It owns selection and dedup so the prompt only has to render
 * the one card it returns:
 *
 *   - Reads today's `deliveredToday` set from `memory/heartbeat-state.json` and
 *     filters it out of `list_opportunities`, so a drop never repeats anything the
 *     morning brief (or an earlier drop) already sent that day, and vice versa.
 *   - Leaves out cards still in their cooldown or shown as often as they will
 *     be, and cards Index marks `negotiating` (delivery-state.ts).
 *   - Picks the single best of the rest (never shown before shown on an
 *     earlier day, oldest showing first, then fresh over re-show, then highest
 *     confidence).
 *   - Records its id in the same `deliveredToday` set, exactly like the daily
 *     send, and counts one showing in the delivery log. That local state is
 *     the record of what was delivered.
 *
 * Prints `[SILENT]` when there is nothing new to send, otherwise one JSON object
 * describing the chosen opportunity for the prompt to render.
 *
 * A `--date` earlier than today's village date is a read-only rerun: it picks
 * as it would have, but writes no delivery state.
 */

import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  type BriefOpportunity,
  attachIndexLinks,
  filterDedupedOpportunities,
  listOpportunitiesFromMcp,
  realVillageDate,
  villageDate,
  resolveIndexApiKey,
} from "./build-daily-brief-context";
import {
  type DeliveryLog,
  OPPORTUNITY_DELIVERY_KEY,
  applyCooldown,
  compareForDelivery,
  deliveryLogChanged,
  isBackDated,
  pruneDeliveryLog,
  readDeliveryLog,
  recordShowings,
} from "./delivery-state";
import { indexMcpUrl } from "./index-mcp";

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

/**
 * Never shown before shown on an earlier day (oldest showing first), then
 * fresh opportunities before cooldown re-shows, then most confident first.
 */
function pickBest(opportunities: BriefOpportunity[], log: DeliveryLog): BriefOpportunity | undefined {
  const byDelivery = compareForDelivery(log);
  return [...opportunities].sort((a, b) => {
    const delivery = byDelivery(a, b);
    if (delivery !== 0) return delivery;
    if (Boolean(a.redelivery) !== Boolean(b.redelivery)) return a.redelivery ? 1 : -1;
    return (b.confidence ?? 0) - (a.confidence ?? 0);
  })[0];
}

export async function dropOpportunity(options: {
  date?: string;
  stateFile?: string;
  apiKey?: string;
  mcpUrl?: string;
  listOpportunities?: typeof listOpportunitiesFromMcp;
} = {}): Promise<DropResult | SilentResult> {
  const date = options.date ?? villageDate();
  const stateFile = resolveHermesPath(options.stateFile ?? "memory/heartbeat-state.json");
  const apiKey = options.apiKey ?? resolveIndexApiKey();
  if (!apiKey) return { silent: true, reason: "no-api-key" };
  const mcpUrl = options.mcpUrl ?? indexMcpUrl();

  const { cards: fetched, listing } = await (options.listOpportunities ?? listOpportunitiesFromMcp)({ apiKey, mcpUrl });

  const state = await readJsonObject(stateFile);
  const deliveredToday =
    state.deliveredToday && typeof state.deliveredToday === "object" && !Array.isArray(state.deliveredToday)
      ? (state.deliveredToday as Record<string, unknown>)
      : {};
  const deliveredIds = new Set(deliveredToday.date === date ? stringArray(deliveredToday.ids) : []);

  // The read succeeded, so entries for cards no longer pending can go.
  const readOnly = isBackDated(date, realVillageDate());
  const log = pruneDeliveryLog(readDeliveryLog(state, date, realVillageDate()), date, listing);
  const candidates = filterDedupedOpportunities(fetched, deliveredIds).filter((opp) => opp.opportunityId);
  const chosen = pickBest(applyCooldown(candidates, log, date).eligible, log);
  if (!chosen?.opportunityId) {
    if (!readOnly && deliveryLogChanged(state, log)) {
      state[OPPORTUNITY_DELIVERY_KEY] = log;
      await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);
    }
    return { silent: true, reason: "nothing-new" };
  }

  // Reserve the id in the shared per-day set BEFORE delivery so a retry or the
  // morning brief never double-sends it. This mirrors the daily send's bookkeeping.
  state.deliveredToday = {
    date,
    ids: Array.from(new Set([...deliveredIds, chosen.opportunityId])),
  };
  state[OPPORTUNITY_DELIVERY_KEY] = pruneDeliveryLog(recordShowings(log, [chosen.opportunityId], date), date, listing);
  if (!readOnly) await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);

  return { opportunity: attachIndexLinks(chosen) };
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
