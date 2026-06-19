#!/usr/bin/env bun
/**
 * Fetch and filter the authenticated user's negotiations for the afternoon
 * check-in cron, then output structured context for the LLM to narrate.
 *
 * Calls list_negotiations with detail:"narrative" to receive indexContext,
 * recentTurns, and outcome in one round-trip. Separates negotiations into
 * three groups: needs-attention (active, user's turn), waiting (active, other
 * side's turn), and newly-resolved (completed, recently updated, not yet
 * reported). Tracks reported completed IDs in heartbeat-state.json so the user
 * is never spammed about the same concluded negotiation twice.
 *
 * Outputs either exactly `[SILENT]` (nothing to report) or a JSON object that
 * the cron prompt feeds to the LLM for the structured report:
 *
 *   { signals: [...], needsAttention: [...], waiting: [...], newlyResolved: [...] }
 *
 * When there is something to report, it additionally fetches the user's own
 * active signals (read_intents) and resolves each negotiation's counterparty to
 * a display name (read_user_contexts). Both enrichments are best-effort: a
 * failure degrades to empty signals / null names rather than aborting.
 *
 * Usage (from $HERMES_HOME):
 *   bun skills/index-network/scripts/summarize-negotiations.ts \
 *     [--state-file memory/heartbeat-state.json]
 */

import { existsSync } from "node:fs";

import { resolveIndexApiKey } from "./build-daily-brief-context";

// ── MCP plumbing ──────────────────────────────────────────────────────────────

type McpJsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
};

type McpToolResult = {
  content?: Array<{ type: string; text?: string }>;
};

async function postMcpMessage(
  mcpUrl: string,
  apiKey: string,
  body: unknown,
): Promise<McpJsonRpcResponse> {
  const res = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "x-api-key": apiKey,
      "x-index-surface": "telegram",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${res.statusText}`);

  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    let response: McpJsonRpcResponse | null = null;
    for (const line of text.split("\n")) {
      const dataLine = line.startsWith("data: ")
        ? line.slice(6)
        : line.startsWith("data:")
          ? line.slice(5)
          : null;
      if (dataLine !== null) {
        try {
          const msg = JSON.parse(dataLine) as McpJsonRpcResponse;
          if ("result" in msg || "error" in msg) response = msg;
        } catch {
          // skip non-JSON or comment lines
        }
      }
    }
    if (response) return response;
    throw new Error("no JSON-RPC response in MCP SSE stream");
  }

  return (await res.json()) as McpJsonRpcResponse;
}

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
   * Human-readable counterparty name, resolved post-fetch via read_user_contexts.
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

interface NegotiationListResponse {
  success?: boolean;
  error?: unknown;
  data?: {
    count?: number;
    totalCount?: number;
    negotiations?: NegotiationItem[];
  };
}

/** A single signal (intent) the user has registered, condensed for the report. */
export interface SignalItem {
  id: string;
  summary: string;
}

interface IntentListResponse {
  success?: boolean;
  error?: unknown;
  data?: {
    intents?: Array<{
      id?: string;
      summary?: string;
      description?: string;
      status?: string;
    }>;
  };
}

interface ProfileResponse {
  success?: boolean;
  error?: unknown;
  data?: {
    hasProfile?: boolean;
    /** Flat identity shape (WS11+ protocol): name lives at data.name. */
    name?: string;
    /** Legacy nested shape (pre-WS11 protocol): name lived at data.profile.name. */
    profile?: { name?: string };
  };
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

// ── Default MCP fetcher ───────────────────────────────────────────────────────

export function buildMcpFetcher(apiKey: string, mcpUrl: string): NegotiationFetcher {
  return async () => {
    const initResp = await postMcpMessage(mcpUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentvillage-negotiation-summary", version: "1.0.0" },
      },
    });
    if (initResp.error) throw new Error(`MCP initialize: ${initResp.error.message}`);

    const toolResp = await postMcpMessage(mcpUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "list_negotiations",
        arguments: { status: "all", limit: 50, detail: "narrative" },
      },
    });
    if (toolResp.error) throw new Error(`MCP list_negotiations: ${toolResp.error.message}`);

    const result = toolResp.result as McpToolResult | undefined;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (!text.trim()) return [];

    const parsed = JSON.parse(text) as NegotiationListResponse;
    if (parsed.success === false) {
      const detail = typeof parsed.error === "string" ? parsed.error : "tool reported failure";
      throw new Error(`list_negotiations: ${detail}`);
    }

    const negotiations = parsed.data?.negotiations;
    if (!Array.isArray(negotiations)) return [];
    return negotiations as NegotiationItem[];
  };
}

/**
 * Build a fetcher for the user's own active signals via read_intents (no args →
 * caller-owned active intents). Best-effort: the caller treats a throw as "no
 * signals" rather than aborting the whole report.
 */
export function buildMcpSignalFetcher(apiKey: string, mcpUrl: string): SignalFetcher {
  return async () => {
    const initResp = await postMcpMessage(mcpUrl, apiKey, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "agentvillage-negotiation-summary", version: "1.0.0" },
      },
    });
    if (initResp.error) throw new Error(`MCP initialize: ${initResp.error.message}`);

    const toolResp = await postMcpMessage(mcpUrl, apiKey, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "read_intents", arguments: { limit: 20 } },
    });
    if (toolResp.error) throw new Error(`MCP read_intents: ${toolResp.error.message}`);

    const result = toolResp.result as McpToolResult | undefined;
    const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
    if (!text.trim()) return [];

    const parsed = JSON.parse(text) as IntentListResponse;
    if (parsed.success === false) return [];

    const intents = parsed.data?.intents;
    if (!Array.isArray(intents)) return [];

    return intents
      .map((i) => ({ id: i.id ?? "", summary: (i.summary || i.description || "").trim() }))
      .filter((s) => s.summary.length > 0);
  };
}

/**
 * Build a memoised resolver mapping a counterparty userId → display name via
 * read_user_contexts. Initialises the MCP session lazily on first use and caches
 * per-userId results (including null) so repeated counterparties cost one call.
 * Any per-user failure resolves to null rather than throwing.
 */
export function buildMcpProfileResolver(apiKey: string, mcpUrl: string): ProfileResolver {
  const cache = new Map<string, string | null>();
  let initialized = false;
  let nextId = 100;

  return async (userId: string) => {
    if (!userId) return null;
    if (cache.has(userId)) return cache.get(userId) ?? null;

    try {
      if (!initialized) {
        const initResp = await postMcpMessage(mcpUrl, apiKey, {
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "agentvillage-negotiation-summary", version: "1.0.0" },
          },
        });
        if (initResp.error) throw new Error(`MCP initialize: ${initResp.error.message}`);
        initialized = true;
      }

      const toolResp = await postMcpMessage(mcpUrl, apiKey, {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "read_user_contexts", arguments: { userId } },
      });
      if (toolResp.error) throw new Error(toolResp.error.message);

      const result = toolResp.result as McpToolResult | undefined;
      const text = result?.content?.find((c) => c.type === "text")?.text ?? "";
      if (!text.trim()) {
        cache.set(userId, null);
        return null;
      }

      const parsed = JSON.parse(text) as ProfileResponse;
      // Read the flat identity shape (WS11+) first, falling back to the legacy
      // nested shape so this works across the protocol rename transition.
      const rawName =
        parsed.success !== false && parsed.data?.hasProfile
          ? parsed.data.name ?? parsed.data.profile?.name
          : undefined;
      const name = rawName?.trim() || null;
      cache.set(userId, name);
      return name;
    } catch {
      cache.set(userId, null);
      return null;
    }
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
    (n) => !alreadyReported.has(n.id) && updatedWithinDays(n.updatedAt, recentDays),
  );

  // ── Silent gate ─────────────────────────────────────────────────────────────

  if (needsAttention.length === 0 && waiting.length === 0 && newlyResolved.length === 0) {
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = argValue(args, "--state-file") ?? "memory/heartbeat-state.json";

  const apiKey = resolveIndexApiKey();
  if (!apiKey) {
    process.stdout.write("[SILENT]");
    return;
  }

  const mcpUrl = process.env.INDEX_MCP_URL?.trim() || "https://protocol.index.network/mcp";
  const fetchNegotiations = buildMcpFetcher(apiKey, mcpUrl);
  const fetchSignals = buildMcpSignalFetcher(apiKey, mcpUrl);
  const resolveProfile = buildMcpProfileResolver(apiKey, mcpUrl);

  const result = await summarizeNegotiations({
    fetchNegotiations,
    stateFile,
    fetchSignals,
    resolveProfile,
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
