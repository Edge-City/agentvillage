#!/usr/bin/env bun
/**
 * Evening pass. Lists pending opportunities and returns one card the morning
 * brief and the daytime drops have not already sent today and that is not in
 * its cooldown or out of showings (delivery-state.ts): never-shown cards in
 * Index's order first, then the card shown longest ago. On the last village
 * day, if there is no such card, returns the local closeout line.
 *
 * Usage (from $HERMES_HOME):
 *   bun skills/index-network/scripts/ask-questions.ts [--state-file memory/heartbeat-state.json] [--date YYYY-MM-DD]
 *
 * A `--date` earlier than today's village date is a read-only rerun for
 * delivery state: it writes neither the delivery log nor `deliveredToday`.
 */

import { existsSync } from "node:fs";

import {
  attachIndexLinks,
  listOpportunitiesFromMcp,
  realVillageDate,
  resolveIndexApiKey,
  villageDate,
  type BriefOpportunity,
} from "./build-daily-brief-context";
import {
  OPPORTUNITY_DELIVERY_KEY,
  applyCooldown,
  deliveryLogChanged,
  isBackDated,
  pruneDeliveryLog,
  readDeliveryLog,
  recordShowings,
} from "./delivery-state";
import { indexMcpUrl } from "./index-mcp";
import { cleanName } from "./proactive-text";
import { writeStateFile } from "./state-file";

/** Last day of Edge City India 2026 (Oct 11 – Nov 1). */
const FINAL_REFLECTION_DATE = "2026-11-01";
const FINAL_REFLECTION_QUESTION_ID = `edge-closeout-final-reflection-${FINAL_REFLECTION_DATE}`;
const FINAL_REFLECTION_MORNING_QUESTION_ID = `daily-identity-${FINAL_REFLECTION_DATE}`;
const FINAL_REFLECTION_PROMPT =
  "Quick closeout check: did AgentVillage help you meet, message, or better understand anyone this week? Reply with one sentence.";

export interface EveningCard {
  name: string;
  headline: string;
  userUrl?: string;
  opportunityUrl?: string;
}

interface Closeout {
  prompt: string;
}

interface SilentResult {
  silent: true;
  reason: string;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function readState(path: string): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function deliveredIds(state: Record<string, unknown>, date: string): Set<string> {
  const delivered = state.deliveredToday;
  if (!delivered || typeof delivered !== "object" || Array.isArray(delivered)) return new Set();
  const row = delivered as { date?: unknown; ids?: unknown };
  if (row.date !== date || !Array.isArray(row.ids)) return new Set();
  return new Set(row.ids.filter((id): id is string => typeof id === "string"));
}

function questionDelivery(state: Record<string, unknown>): Record<string, string> {
  const raw = state.questionDelivery;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function cardFrom(opp: BriefOpportunity): EveningCard | null {
  const linked = attachIndexLinks(opp);
  if (!linked.name) return null;
  return {
    name: linked.name,
    headline: linked.headline || linked.mainText || "New match",
    userUrl: linked.userUrl,
    opportunityUrl: linked.opportunityUrl,
  };
}

export async function askQuestions(options: {
  date?: string;
  stateFile?: string;
  apiKey?: string;
} = {}): Promise<EveningCard | Closeout | SilentResult> {
  const date = options.date ?? villageDate();
  const stateFile = options.stateFile ?? "memory/heartbeat-state.json";
  const apiKey = options.apiKey ?? resolveIndexApiKey();
  let listed: Awaited<ReturnType<typeof listOpportunitiesFromMcp>> | null = null;
  if (apiKey) {
    try {
      listed = await listOpportunitiesFromMcp({ apiKey, mcpUrl: indexMcpUrl() });
    } catch {
      // An empty list still allows the last-day closeout.
    }
  }

  // Read the state only after the Index call, so a slow call never writes a
  // stale copy over another script's write.
  const state = await readState(stateFile);
  if (listed) {
    try {
      const { cards: fetched, listing } = listed;
      const seen = deliveredIds(state, date);
      // The read succeeded, so entries for cards no longer pending can go.
      const readOnly = isBackDated(date, realVillageDate());
      const log = pruneDeliveryLog(readDeliveryLog(state, date, realVillageDate()), date, listing);
      // A card whose name does not clean is never shown, so it must not take the slot (DATA-314 B1-fix F5).
      const unseen = fetched.filter((opp) => opp.opportunityId && !seen.has(opp.opportunityId) && cleanName(opp.name));
      const [chosen] = applyCooldown(unseen, log, date).eligible;
      if (chosen?.opportunityId) {
        if (!readOnly) {
          state.deliveredToday = { date, ids: [...seen, chosen.opportunityId] };
          state[OPPORTUNITY_DELIVERY_KEY] = pruneDeliveryLog(recordShowings(log, [chosen.opportunityId], date), date, listing);
          writeStateFile(stateFile, state);
        }
        const card = cardFrom(chosen);
        if (card) return card;
      } else if (!readOnly && deliveryLogChanged(state, log)) {
        state[OPPORTUNITY_DELIVERY_KEY] = log;
        writeStateFile(stateFile, state);
      }
    } catch {
      // An unwritable state file still allows the last-day closeout.
    }
  }

  if (date !== FINAL_REFLECTION_DATE) return { silent: true, reason: "nothing-waiting" };
  const delivered = questionDelivery(state);
  if (
    delivered[FINAL_REFLECTION_QUESTION_ID] === date ||
    delivered[FINAL_REFLECTION_MORNING_QUESTION_ID] === date
  ) {
    return { silent: true, reason: "final-reflection-already-delivered" };
  }
  state.questionDelivery = { ...delivered, [FINAL_REFLECTION_QUESTION_ID]: date };
  writeStateFile(stateFile, state);
  return { prompt: FINAL_REFLECTION_PROMPT };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await askQuestions({
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
