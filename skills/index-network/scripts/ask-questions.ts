#!/usr/bin/env bun
/**
 * Evening pass. Lists pending opportunities and returns one card the morning
 * brief and the daytime drops have not already sent today. On the last village
 * day, if that list is empty, returns the local closeout line.
 *
 * Usage (from $HERMES_HOME):
 *   bun skills/index-network/scripts/ask-questions.ts [--state-file memory/heartbeat-state.json]
 */

import { existsSync } from "node:fs";

import {
  attachIndexLinks,
  fetchOpportunitiesFromMcp,
  resolveIndexApiKey,
  villageDate,
  type BriefOpportunity,
} from "./build-daily-brief-context";

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
  const state = await readState(stateFile);
  const seen = deliveredIds(state, date);

  const apiKey = options.apiKey ?? resolveIndexApiKey();
  if (apiKey) {
    try {
      const mcpUrl = process.env.INDEX_MCP_URL?.trim() || "https://protocol.index.network/mcp";
      const fetched = await fetchOpportunitiesFromMcp({ apiKey, mcpUrl });
      const chosen = fetched.find((opp) => opp.opportunityId && !seen.has(opp.opportunityId));
      if (chosen?.opportunityId) {
        state.deliveredToday = { date, ids: [...seen, chosen.opportunityId] };
        await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);
        const card = cardFrom(chosen);
        if (card) return card;
      }
    } catch {
      // An empty list still allows the last-day closeout.
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
  await Bun.write(stateFile, `${JSON.stringify(state, null, 2)}\n`);
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
