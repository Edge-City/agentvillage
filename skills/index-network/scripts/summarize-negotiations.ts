#!/usr/bin/env bun
/**
 * Read current negotiations and their turn logs for the afternoon check-in.
 * Categorize using server guidance and retain local notification deduplication.
 * The hosted agent remains responsible for participation; this script only reads.
 */

import { existsSync } from "node:fs";

import { resolveIndexApiKey } from "./build-daily-brief-context";

import { callIndex } from "./index.client";

/** Current negotiation detail, including the server's available actions. */
export interface NegotiationItem {
  id: string;
  opportunityId: string;
  intentId: string;
  awaitingUserId: string | null;
  outcome: "agreed" | "declined" | "closed" | null;
  settledAt: string | null;
  turnCount: number;
  createdAt: string;
  updatedAt: string;
  counterparty: { userId: string; intentId: string; name: string | null; statement: string };
  turns: Array<{ turnIndex: number; seatUserId: string; action: string; message: string; createdAt: string }>;
  protocol: { availableActions: string[]; blockedReason: string | null; maxTurns: number; messageLimit: number };
}

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

/** Read each negotiation directly by opportunity ID, preserving its guidance. */
export function buildCliFetcher(apiKey: string, apiUrl: string): NegotiationFetcher {
  return async () => {
    const connection = { apiKey, apiUrl };
    const list = await callIndex<Array<{ opportunityId: string }>>(connection, ["negotiation", "list"]);
    const details: NegotiationItem[] = [];
    for (const item of list) details.push(await callIndex<NegotiationItem>(connection, ["negotiation", "show", item.opportunityId]));
    return details;
  };
}

/** Read active signals using the current list contract. */
export function buildCliSignalFetcher(apiKey: string, apiUrl: string): SignalFetcher {
  return async () => {
    const result = await callIndex<{ intents: Array<{ id: string; summary: string | null; payload: string }> }>(
      { apiKey, apiUrl }, ["intent", "list"],
    );
    return result.intents.map((intent) => ({ id: intent.id, summary: intent.summary || intent.payload }));
  };
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
}): Promise<ContextResult | SilentResult> {
  const { fetchNegotiations, stateFile, recentDays = 7, fetchSignals } = opts;

  let allNegotiations: NegotiationItem[];
  try {
    allNegotiations = await fetchNegotiations();
  } catch (err) {
    process.stderr.write(
      `negotiation-summary: CLI fetch failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { silent: true, reason: "cli-fetch-failed" };
  }

  // ── Categorize ─────────────────────────────────────────────────────────────

  const needsAttention = allNegotiations.filter(
    (n) => n.settledAt === null && n.protocol.availableActions.length > 0,
  );
  const waiting = allNegotiations.filter(
    (n) => n.settledAt === null && n.protocol.availableActions.length === 0,
  );
  const completed = allNegotiations.filter((n) => n.settledAt !== null);

  // ── State: deduplicate reported completed IDs ───────────────────────────────

  const state = await readJsonObject(stateFile);
  const summaryState = (state.negotiationSummary ?? {}) as NegotiationSummaryState;
  const alreadyReported = new Set(summaryState.reportedCompletedIds ?? []);

  const newlyResolved = completed.filter(
    (n) => n.outcome === "agreed" && !alreadyReported.has(n.id) && updatedWithinDays(n.updatedAt, recentDays),
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

  // ── Enrich: signals (best-effort) ──────────────────────
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

  return { context: { signals, needsAttention, waiting, newlyResolved } };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = argValue(args, "--state-file") ?? "memory/heartbeat-state.json";

  const apiKey = resolveIndexApiKey();
  if (!apiKey) {
    process.stdout.write("[SILENT]");
    return;
  }

  const apiUrl = process.env.INDEX_API_URL?.trim() || "https://protocol.index.network";
  const fetchNegotiations = buildCliFetcher(apiKey, apiUrl);
  const fetchSignals = buildCliSignalFetcher(apiKey, apiUrl);

  const result = await summarizeNegotiations({
    fetchNegotiations,
    stateFile,
    fetchSignals,
  });

  if ("silent" in result) {
    process.stdout.write("[SILENT]");
  } else {
    process.stdout.write(JSON.stringify(result.context));
  }
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
