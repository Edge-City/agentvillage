#!/usr/bin/env bun
/**
 * Deterministically summarize active and recently-resolved negotiations for
 * the afternoon check-in cron.
 *
 * Outputs either exactly `[SILENT]` (nothing actionable) or one JSON object
 * `{ finalBrief: string }` that the cron prompt delivers verbatim to Telegram.
 *
 * Tracks which completed negotiations have already been reported in
 * `memory/heartbeat-state.json` under `negotiationSummary.reportedCompletedIds`
 * so the user is never spammed about the same concluded negotiation twice.
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
      // Mirrors the daily-brief scripts: surface=telegram ensures connect
      // links render with the Telegram deep-link redirect.
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

interface NegotiationItem {
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

interface NegotiationSummaryState {
  reportedCompletedIds?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function pacificDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Shorten a UUID to a 6-char reference for display. */
function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 6).toUpperCase();
}

/**
 * Whether a negotiation was updated in the last `withinDays` days.
 * Used to suppress stale completed negotiations that somehow slipped
 * past the reportedCompletedIds gate (e.g. first run after install).
 */
function updatedWithinDays(updatedAt: string, withinDays: number): boolean {
  const updatedMs = new Date(updatedAt).getTime();
  const cutoffMs = Date.now() - withinDays * 24 * 60 * 60 * 1000;
  return updatedMs >= cutoffMs;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
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

async function writeJsonObject(path: string, data: Record<string, unknown>): Promise<void> {
  await Bun.write(path, `${JSON.stringify(data, null, 2)}\n`);
}

// ── MCP negotiation fetch ─────────────────────────────────────────────────────

async function fetchNegotiations(opts: {
  apiKey: string;
  mcpUrl: string;
}): Promise<NegotiationItem[]> {
  // Initialize MCP session.
  const initResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
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

  // Fetch all negotiations — we filter on the client side so active ones are
  // never missed by a narrow `since` window.
  const toolResp = await postMcpMessage(opts.mcpUrl, opts.apiKey, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "list_negotiations",
      arguments: { status: "all", limit: 50 },
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
}

// ── Brief composition ─────────────────────────────────────────────────────────

function actionLabel(action: string | null): string {
  switch (action) {
    case "propose": return "proposed";
    case "accept": return "accepted";
    case "reject": return "declined";
    case "counter": return "countered";
    case "question": return "asked a question";
    default: return "responded";
  }
}

function outcomeLabel(latestAction: string | null): string {
  if (latestAction === "accept") return "connected ✓";
  if (latestAction === "reject") return "no match";
  return "stalled";
}

function composeBrief(opts: {
  date: string;
  needsAttention: NegotiationItem[];
  waiting: NegotiationItem[];
  newlyResolved: NegotiationItem[];
}): string {
  const { needsAttention, waiting, newlyResolved } = opts;
  const lines: string[] = [];

  lines.push("**Negotiations — afternoon check-in**");
  lines.push("");

  if (needsAttention.length > 0) {
    lines.push(`**Your turn (${needsAttention.length})**`);
    for (const n of needsAttention) {
      const ref = shortId(n.id);
      const turns = n.turnCount === 1 ? "1 turn" : `${n.turnCount} turns`;
      const preview = n.latestMessagePreview?.trim()
        ? ` — "${n.latestMessagePreview.slice(0, 80).trim()}${n.latestMessagePreview.length > 80 ? "…" : ""}"`
        : "";
      lines.push(`• ${ref}: ${turns} in${preview}`);
    }
    lines.push("");
  }

  if (waiting.length > 0) {
    lines.push(`**Waiting for response (${waiting.length})**`);
    for (const n of waiting) {
      const ref = shortId(n.id);
      const turns = n.turnCount === 1 ? "1 turn" : `${n.turnCount} turns`;
      const lastAction = n.latestAction ? ` — last: ${actionLabel(n.latestAction)}` : "";
      lines.push(`• ${ref}: ${turns}${lastAction}`);
    }
    lines.push("");
  }

  if (newlyResolved.length > 0) {
    lines.push(`**Concluded (${newlyResolved.length})**`);
    for (const n of newlyResolved) {
      const ref = shortId(n.id);
      const turns = n.turnCount === 1 ? "1 turn" : `${n.turnCount} turns`;
      const outcome = outcomeLabel(n.latestAction);
      lines.push(`• ${ref}: ${outcome} after ${turns}`);
    }
    lines.push("");
  }

  // Trim trailing blank line
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return lines.join("\n");
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

  let allNegotiations: NegotiationItem[];
  try {
    allNegotiations = await fetchNegotiations({ apiKey, mcpUrl });
  } catch (err) {
    // Fetch failure is non-fatal: stay silent rather than erroring the cron.
    process.stderr.write(
      `negotiation-summary: MCP fetch failed — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stdout.write("[SILENT]");
    return;
  }

  // ── Categorize ──────────────────────────────────────────────────────────────

  const needsAttention = allNegotiations.filter(
    (n) => (n.status === "active" || n.status === "waiting_for_agent") && n.isUsersTurn,
  );
  const waiting = allNegotiations.filter(
    (n) => (n.status === "active" || n.status === "waiting_for_agent") && !n.isUsersTurn,
  );
  const completed = allNegotiations.filter((n) => n.status === "completed");

  // ── State: track reported completed IDs ─────────────────────────────────────

  const state = await readJsonObject(stateFile);
  const summaryState = (state.negotiationSummary ?? {}) as NegotiationSummaryState;
  const alreadyReported = new Set(summaryState.reportedCompletedIds ?? []);

  // Only surface completed negotiations updated within the last 7 days that
  // haven't been reported in a prior run of this cron.
  const newlyResolved = completed.filter(
    (n) => !alreadyReported.has(n.id) && updatedWithinDays(n.updatedAt, 7),
  );

  // ── Silent gate ──────────────────────────────────────────────────────────────

  if (needsAttention.length === 0 && waiting.length === 0 && newlyResolved.length === 0) {
    process.stdout.write("[SILENT]");
    return;
  }

  // ── Compose brief ────────────────────────────────────────────────────────────

  const today = pacificDate();
  const finalBrief = composeBrief({ date: today, needsAttention, waiting, newlyResolved });

  // ── Persist state ────────────────────────────────────────────────────────────

  const updatedReportedIds = [
    ...alreadyReported,
    ...newlyResolved.map((n) => n.id),
  ];

  const updatedState: Record<string, unknown> = {
    ...state,
    negotiationSummary: {
      ...summaryState,
      reportedCompletedIds: updatedReportedIds,
    } satisfies NegotiationSummaryState,
  };
  await writeJsonObject(stateFile, updatedState);

  // ── Output ───────────────────────────────────────────────────────────────────

  process.stdout.write(JSON.stringify({ finalBrief }));
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(
      `negotiation-summary: fatal — ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.stdout.write("[SILENT]");
    process.exit(0); // exit 0 so the cron doesn't fire error alerts
  });
}
