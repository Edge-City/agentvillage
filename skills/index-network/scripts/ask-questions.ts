#!/usr/bin/env bun
/**
 * Evening pass. Lists pending opportunities and returns one card the morning
 * brief and the daytime drops have not already sent today and that is not in
 * its cooldown or out of showings (delivery-state.ts): never-shown cards in
 * Index's order first, then the card shown longest ago. Only a card the
 * evening can introduce counts: a clean name, a reason (introReason) and a
 * profile or accept link. On the last village day, if there is no such card,
 * returns the local closeout line. The evening check-in itself (proactive.ts
 * eveningView) goes out with or without a card; its journaling prompt is
 * reflectionPromptFor(date).
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
import { cleanName, cleanTitle } from "./proactive-text";
import { writeStateFile } from "./state-file";

/** Last day of Edge City India 2026 (Oct 11 – Nov 1). */
const FINAL_REFLECTION_DATE = "2026-11-01";
const FINAL_REFLECTION_QUESTION_ID = `edge-closeout-final-reflection-${FINAL_REFLECTION_DATE}`;
const FINAL_REFLECTION_MORNING_QUESTION_ID = `daily-identity-${FINAL_REFLECTION_DATE}`;
const FINAL_REFLECTION_PROMPT =
  "Quick closeout check: did AgentVillage help you meet, message, or better understand anyone this week? Reply with one sentence.";

/**
 * Carter's switch for the evening introduction. The intro's "why" is Index's
 * card headline: third-party text, a deliberate exception to proactive.ts's
 * no-third-party-text rule, passed only through introReason (cleanTitle, one
 * line, at most INTRO_REASON_MAX, scanned). false: no card is picked, so the
 * evening is the check-in alone and no card spends a showing.
 */
export const EVENING_INTROS_ENABLED = true;

/** The longest intro reason, in code points, cut at a word. */
export const INTRO_REASON_MAX = 120;

/**
 * Why the resident might enjoy meeting the person on `card`, or null (no
 * intro): the card's headline (else its main text) as one plain line with no
 * link, handle, markup or control character (cleanTitle), cut at a word to
 * INTRO_REASON_MAX; null when nothing survives or Hermes's scanner would block it.
 */
export function introReason(card: { headline?: unknown; mainText?: unknown }): string | null {
  // "New match" is the card parser's placeholder for a card with no text (build-daily-brief-context.ts): no reason.
  const mainText = card.mainText === "New match" ? undefined : card.mainText;
  return cleanTitle(card.headline, INTRO_REASON_MAX, "word") ?? cleanTitle(mainText, INTRO_REASON_MAX, "word");
}

/**
 * The evening check-in's journaling prompts. One is chosen per village date
 * (reflectionPromptFor), so the script, not the model, rotates them.
 */
export const REFLECTION_PROMPTS = Object.freeze([
  "What's one thing from today you're grateful for?",
  "Who did you enjoy talking to today, and what stuck with you?",
  "What surprised you today?",
  "What's one small moment from today you'd like to remember?",
  "What gave you energy today, and what drained it?",
  "What's something you learned today, from a person or a place?",
  "If today had a title, what would it be?",
] as const);

/** The prompt for `date` (YYYY-MM-DD): consecutive days walk the list in order. */
export function reflectionPromptFor(date: string): string {
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
  const n = REFLECTION_PROMPTS.length;
  return REFLECTION_PROMPTS[Number.isFinite(day) ? ((day % n) + n) % n : 0];
}

export interface EveningCard {
  name: string;
  /** introReason of the card: never null on a card askQuestions returns. */
  reason: string;
  userUrl?: string;
  opportunityUrl?: string;
  acceptUrl?: string;
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

/** The card as the evening shows it, or null when it has no clean name, no reason or no way to reach them. */
function cardFrom(opp: BriefOpportunity): EveningCard | null {
  const linked = attachIndexLinks(opp);
  const reason = introReason(linked);
  if (!cleanName(linked.name) || !reason || !(linked.acceptUrl || linked.userUrl)) return null;
  return {
    name: linked.name,
    reason,
    userUrl: linked.userUrl,
    opportunityUrl: linked.opportunityUrl,
    ...(linked.acceptUrl ? { acceptUrl: linked.acceptUrl } : {}),
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
  if (apiKey && EVENING_INTROS_ENABLED) {
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
      // A card the evening cannot introduce (no clean name, no reason, no link) is never shown, so it must not take the slot (DATA-314 B1-fix F5).
      const unseen = fetched.filter((opp) => opp.opportunityId && !seen.has(opp.opportunityId) && cardFrom(opp));
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
