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
 * the cron prompt feeds to the LLM for narrative composition:
 *
 *   { needsAttention: [...], waiting: [...], newlyResolved: [...] }
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

export interface NegotiationSummaryState {
  reportedCompletedIds?: string[];
}

export type NegotiationFetcher = () => Promise<NegotiationItem[]>;

export interface NegotiationContext {
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
}): Promise<ContextResult | SilentResult> {
  const { fetchNegotiations, stateFile, recentDays = 7 } = opts;

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

  return { context: { needsAttention, waiting, newlyResolved } };
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

  const result = await summarizeNegotiations({ fetchNegotiations, stateFile });

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
