#!/usr/bin/env bun
/**
 * Build the afternoon follow-up for the check-in cron, then output structured
 * context for the LLM to narrate.
 *
 * main() lists the user's opportunities (list_opportunities: pending,
 * negotiating and accepted) and signals (list_intents), and splits the cards
 * into three groups: needs-attention (pending, waiting on the user), waiting
 * (negotiating, agents still talking), and newly-resolved (accepted, not yet
 * reported). Tracks reported ids in heartbeat-state.json under
 * negotiationSummary.reportedCompletedIds so the user is never told about the
 * same connection twice.
 *
 * The needs-attention list puts pending cards in front of the user like any
 * other delivery, so it follows the card cooldown (delivery-state.ts): it
 * lists only pending cards not already sent today and not in their cooldown
 * or out of showings, and counts one showing for each card it lists. A
 * pending card Index marks `negotiating: true` is listed with the agents
 * talking, never as waiting on the user.
 *
 * Outputs either exactly `[SILENT]` (nothing to report) or a JSON object that
 * the cron prompt feeds to the LLM for the structured report:
 *
 *   { signals: [...], needsAttention: [...], waiting: [...], newlyResolved: [...] }
 *
 * summarizeNegotiations() is the earlier per-negotiation categoriser. It takes
 * injected fetchers, and main() does not call it.
 *
 * Usage (from $HERMES_HOME):
 *   bun skills/index-network/scripts/summarize-negotiations.ts \
 *     [--state-file memory/heartbeat-state.json]
 */

import { existsSync } from "node:fs";

import {
  attachIndexLinks,
  indexLink,
  parseListedOpportunitiesCounted,
  resolveIndexApiKey,
  villageDate,
  type BriefOpportunity,
} from "./build-daily-brief-context";
import {
  OPPORTUNITY_DELIVERY_KEY,
  applyCooldown,
  awaitsResident,
  deliveryLogChanged,
  pendingListing,
  pruneDeliveryLog,
  readDeliveryLog,
  recordShowings,
  type PendingListing,
} from "./delivery-state";
import { callIndexTool, indexMcpUrl, toolJsonArray, toolJsonObject } from "./index-mcp";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RecentTurn {
  turnNumber: number;
  speaker: "source" | "candidate";
  role: "own" | "other";
  action: string;
  message: string | null;
}

export interface NegotiationItem {
  id: string;
  counterpartyId: string;
  /**
   * Human-readable counterparty name, resolved post-fetch by the injected ProfileResolver.
   * Undefined until resolution runs; null when the counterparty has no profile
   * (or resolution failed). The prompt falls back to indexContext when absent.
   */
  counterpartyName?: string | null;
  role: "source" | "candidate";
  turnCount: number;
  status: "active" | "waiting_for_agent" | "completed" | string;
  isUsersTurn: boolean;
  isContinuation: boolean;
  priorTurnCount: number;
  latestAction: string | null;
  latestMessagePreview: string | null;
  createdAt: string;
  updatedAt: string;
  // narrative-mode extras
  indexContext: { networkId: string; prompt?: string } | null;
  recentTurns: RecentTurn[];
  outcome: {
    hasOpportunity: boolean;
    agreedRoles?: unknown;
    reasoning: string;
    turnCount: number;
    reason?: string;
  } | null;
}

/** A single signal (intent) the user has registered, condensed for the report. */
export interface SignalItem {
  id: string;
  summary: string;
}

export interface NegotiationSummaryState {
  reportedCompletedIds?: string[];
}

export type NegotiationFetcher = () => Promise<NegotiationItem[]>;

/** Fetches the authenticated user's own active signals (intents). */
export type SignalFetcher = () => Promise<SignalItem[]>;

/** Resolves a counterparty userId to a display name, or null when unavailable. */
export type ProfileResolver = (userId: string) => Promise<string | null>;

export interface NegotiationContext {
  signals: SignalItem[];
  needsAttention: NegotiationItem[];
  waiting: NegotiationItem[];
  newlyResolved: NegotiationItem[];
}

export interface ContextResult {
  context: NegotiationContext;
}

export interface SilentResult {
  silent: true;
  reason: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

/**
 * Whether a negotiation was updated within the last `withinDays` calendar days.
 * Used to suppress stale completed negotiations on first run after install.
 */
export function updatedWithinDays(updatedAt: string, withinDays: number): boolean {
  const updatedMs = new Date(updatedAt).getTime();
  const cutoffMs = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return updatedMs >= cutoffMs;
}

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await Bun.file(path).text()) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export async function writeJsonObject(path: string, data: Record<string, unknown>): Promise<void> {
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ── Core logic (injectable) ───────────────────────────────────────────────────

/**
 * Fetch, deduplicate, and categorise negotiations for the afternoon cron.
 *
 * @param fetchNegotiations - Injectable fetcher; throws on unrecoverable errors.
 * @param stateFile - Path to heartbeat-state.json for tracking reported IDs.
 * @param recentDays - How many days back a completed negotiation is still "new".
 *   Defaults to 7. Override in tests to avoid time-dependent fixtures.
 */
export async function summarizeNegotiations(opts: {
  fetchNegotiations: NegotiationFetcher;
  stateFile: string;
  recentDays?: number;
  /** Optional: fetch the user's own signals. Failures degrade to no signals. */
  fetchSignals?: SignalFetcher;
  /** Optional: resolve counterparty userId → name. Failures degrade to no name. */
  resolveProfile?: ProfileResolver;
}): Promise<ContextResult | SilentResult> {
  const { fetchNegotiations, stateFile, recentDays = 7, fetchSignals, resolveProfile } = opts;

  let allNegotiations: NegotiationItem[];
  try {
    allNegotiations = await fetchNegotiations();
  } catch (err) {
    process.stderr.write(
      `negotiation-summary: MCP fetch failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { silent: true, reason: "mcp-fetch-failed" };
  }

  // ── Categorize ─────────────────────────────────────────────────────────────

  const needsAttention = allNegotiations.filter(
    (n) => (n.status === "active" || n.status === "waiting_for_agent") && n.isUsersTurn,
  );
  const waiting = allNegotiations.filter(
    (n) => (n.status === "active" || n.status === "waiting_for_agent") && !n.isUsersTurn,
  );
  const completed = allNegotiations.filter((n) => n.status === "completed");

  // ── State: deduplicate reported completed IDs ───────────────────────────────

  const state = await readJsonObject(stateFile);
  const summaryState = (state.negotiationSummary ?? {}) as NegotiationSummaryState;
  const alreadyReported = new Set(summaryState.reportedCompletedIds ?? []);

  const newlyResolved = completed.filter(
    (n) => n.outcome?.hasOpportunity === true && !alreadyReported.has(n.id) && updatedWithinDays(n.updatedAt, recentDays),
  );

  // ── Silent gate ─────────────────────────────────────────────────────────────

  if (needsAttention.length === 0 && newlyResolved.length === 0) {
    return { silent: true, reason: "nothing-to-report" };
  }

  // ── Persist newly reported IDs before returning ─────────────────────────────

  const updatedReportedIds = [...alreadyReported, ...newlyResolved.map((n) => n.id)];
  const updatedState: Record<string, unknown> = {
    ...state,
    negotiationSummary: {
      ...summaryState,
      reportedCompletedIds: updatedReportedIds,
    } satisfies NegotiationSummaryState,
  };
  await writeJsonObject(stateFile, updatedState);

  // ── Enrich: signals + counterparty names (best-effort) ──────────────────────
  // Only runs once we've decided there's something to report, so we never pay
  // for these calls on a silent run.

  let signals: SignalItem[] = [];
  if (fetchSignals) {
    try {
      signals = await fetchSignals();
    } catch (err) {
      process.stderr.write(
        `negotiation-summary: signal fetch failed — ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const reported = [...needsAttention, ...waiting, ...newlyResolved];
  if (resolveProfile) {
    const uniqueIds = [...new Set(reported.map((n) => n.counterpartyId).filter(Boolean))];
    const names = new Map<string, string | null>();
    for (const id of uniqueIds) {
      names.set(id, await resolveProfile(id));
    }
    for (const n of reported) {
      n.counterpartyName = names.get(n.counterpartyId) ?? null;
    }
  }

  return { context: { signals, needsAttention, waiting, newlyResolved } };
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface FollowUpCard {
  name: string;
  headline: string;
  summary: string;
  userUrl?: string;
  opportunityUrl?: string;
}

function followUpCard(opp: BriefOpportunity): FollowUpCard | null {
  const linked = attachIndexLinks(opp);
  if (!linked.name) return null;
  const headline = linked.headline || linked.mainText || "New match";
  return {
    name: linked.name,
    headline,
    summary: linked.mainText || headline,
    userUrl: linked.userUrl,
    opportunityUrl: linked.opportunityUrl,
  };
}

/** The user's live signals from a `list_intents` result; throws like parseListedOpportunities. */
function intentsFrom(text: string): Array<{ summary: string; url?: string }> {
  return toolJsonArray(text, "intents").flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const intent = row as { id?: unknown; summary?: unknown; description?: unknown; url?: unknown; status?: unknown };
    if (intent.status === "archived") return [];
    const summary = (typeof intent.summary === "string" ? intent.summary : typeof intent.description === "string" ? intent.description : "").trim();
    if (!summary) return [];
    const url = indexLink("i", typeof intent.url === "string" ? intent.url : undefined, typeof intent.id === "string" ? intent.id : undefined);
    return [{ summary, url }];
  });
}

/** The page size the follow-up asks Index for. */
const FOLLOW_UP_LIST_LIMIT = 50;

function deliveredTodayIds(state: Record<string, unknown>, date: string): Set<string> {
  const delivered = state.deliveredToday;
  if (!delivered || typeof delivered !== "object" || Array.isArray(delivered)) return new Set();
  const row = delivered as { date?: unknown; ids?: unknown };
  if (row.date !== date || !Array.isArray(row.ids)) return new Set();
  return new Set(row.ids.filter((id): id is string => typeof id === "string"));
}

export async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = argValue(args, "--state-file") ?? "memory/heartbeat-state.json";
  const date = argValue(args, "--date") ?? villageDate();

  const apiKey = resolveIndexApiKey();
  if (!apiKey) {
    process.stdout.write("[SILENT]");
    return;
  }

  const target = { apiKey, mcpUrl: indexMcpUrl() };
  let cards: BriefOpportunity[] = [];
  let listing: PendingListing;
  let signals: Array<{ summary: string; url?: string }> = [];
  try {
    const opportunityText = await callIndexTool(target, "list_opportunities", {
      statuses: ["pending", "negotiating", "accepted"],
      limit: FOLLOW_UP_LIST_LIMIT,
    });
    const listed = parseListedOpportunitiesCounted(opportunityText);
    cards = listed.cards;
    listing = pendingListing({
      pendingIds: listed.pendingIds,
      rowCount: listed.rowCount,
      requestedLimit: FOLLOW_UP_LIST_LIMIT,
      pagination: toolJsonObject(opportunityText)?.root.pagination,
    });
    const intentText = await callIndexTool(target, "list_intents", { limit: 20 });
    signals = intentsFrom(intentText);
  } catch (err) {
    process.stderr.write(
      `negotiation-summary: MCP fetch failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stdout.write("[SILENT]");
    return;
  }

  const state = await readJsonObject(stateFile);
  const summaryState = (state.negotiationSummary ?? {}) as NegotiationSummaryState;
  const alreadyReported = new Set(summaryState.reportedCompletedIds ?? []);

  // Both reads succeeded, so entries for cards no longer pending can go.
  const log = pruneDeliveryLog(readDeliveryLog(state), date, listing);
  const sentToday = deliveredTodayIds(state, date);
  const pending = cards.filter((card) => card.status === "pending");
  const due = applyCooldown(
    pending.filter((card) => !card.opportunityId || !sentToday.has(card.opportunityId)),
    log,
    date,
  ).eligible.filter((card) => followUpCard(card));
  const needsAttention = due.map(followUpCard).filter((card): card is FollowUpCard => Boolean(card));
  const waiting = cards
    .filter((card) => card.status === "negotiating" || (card.status === "pending" && !awaitsResident(card)))
    .map(followUpCard)
    .filter((card): card is FollowUpCard => Boolean(card));
  const newAccepted = cards.filter((card) => card.status === "accepted" && card.opportunityId && !alreadyReported.has(card.opportunityId));
  const newlyResolved = newAccepted.map(followUpCard).filter((card): card is FollowUpCard => Boolean(card));

  if (needsAttention.length === 0 && newlyResolved.length === 0) {
    if (deliveryLogChanged(state, log)) await writeJsonObject(stateFile, { ...state, [OPPORTUNITY_DELIVERY_KEY]: log });
    process.stdout.write("[SILENT]");
    return;
  }

  const shownIds = due.map((card) => card.opportunityId).filter((id): id is string => Boolean(id));
  const nextLog = pruneDeliveryLog(recordShowings(log, shownIds, date), date, listing);
  await writeJsonObject(stateFile, {
    ...state,
    negotiationSummary: {
      ...summaryState,
      reportedCompletedIds: [...alreadyReported, ...newAccepted.map((card) => card.opportunityId).filter((id): id is string => Boolean(id))],
    },
    ...(deliveryLogChanged(state, nextLog) ? { [OPPORTUNITY_DELIVERY_KEY]: nextLog } : {}),
  });

  process.stdout.write(JSON.stringify({ signals, needsAttention, waiting, newlyResolved }));
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `negotiation-summary: fatal — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stdout.write("[SILENT]");
    process.exit(0);
  });
}
