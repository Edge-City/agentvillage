#!/usr/bin/env bun
/**
 * Deterministically fetch and select a pending question for the evening pass.
 *
 * The ask-questions cron prompt calls this script to:
 * - Fetch pending questions from the Index MCP server via read_pending_questions.
 * - Apply the cross-day cooldown filter (same QUESTION_COOLDOWN_DAYS as the
 *   morning digest) so the same question is never asked within 3 days.
 * - Record the chosen question in heartbeat-state.json under `questionDelivery`
 *   BEFORE returning — this prevents double-delivery on parallel runs and
 *   ensures the cooldown is honoured even when the agent fails to deliver.
 * - Return one question for the agent to deliver, or [SILENT] if none are
 *   available.
 *
 * State is shared with the morning digest: both passes read and write
 * `questionDelivery` in heartbeat-state.json, so a question included in the
 * morning brief is already on cooldown by the time the evening cron fires.
 */

import { existsSync } from "node:fs";

import {
  QUESTION_COOLDOWN_DAYS,
  fetchPendingQuestionsFromMcp,
  filterCooldownQuestions,
  resolveIndexApiKey,
} from "./build-daily-brief-context";

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

/** Whole days elapsed from `earlier` to `later` (both YYYY-MM-DD). */
function daysBetween(earlier: string, later: string): number {
  const toMs = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return Date.UTC(y, m - 1, day);
  };
  return Math.floor((toMs(later) - toMs(earlier)) / 86_400_000);
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
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

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function readQuestionDelivery(stateFile: string): Promise<Record<string, string>> {
  try {
    const raw = await Bun.file(stateFile).text();
    const parsed = JSON.parse(raw) as { questionDelivery?: unknown };
    if (
      parsed.questionDelivery &&
      typeof parsed.questionDelivery === "object" &&
      !Array.isArray(parsed.questionDelivery)
    ) {
      return Object.fromEntries(
        Object.entries(parsed.questionDelivery as Record<string, unknown>).filter(
          (entry): entry is [string, string] =>
            Boolean(entry[0]) &&
            typeof entry[1] === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(entry[1]),
        ),
      );
    }
  } catch {
    // missing/malformed state must not block delivery
  }
  return {};
}

export interface AskQuestionsResult {
  questionId: string;
  prompt: string;
}

interface SilentResult {
  silent: true;
  reason: string;
}

type FetchQuestionsFn = typeof fetchPendingQuestionsFromMcp;

export async function askQuestions(options: {
  date?: string;
  stateFile?: string;
  /** Injectable for tests — defaults to fetchPendingQuestionsFromMcp. */
  fetchQuestions?: FetchQuestionsFn;
  /** Injectable for tests — defaults to resolveIndexApiKey(). */
  apiKey?: string;
} = {}): Promise<AskQuestionsResult | SilentResult> {
  const date = options.date ?? pacificDate();
  const stateFile = options.stateFile ?? "memory/heartbeat-state.json";
  const fetchQuestions = options.fetchQuestions ?? fetchPendingQuestionsFromMcp;

  const apiKey = options.apiKey ?? resolveIndexApiKey();
  if (!apiKey) return { silent: true, reason: "no-api-key" };

  const mcpUrl =
    process.env.INDEX_MCP_URL?.trim() || "https://protocol.index.network/mcp";

  const questionResult = await fetchQuestions({ apiKey, mcpUrl });
  if (questionResult.source === "unavailable" || questionResult.questions.length === 0) {
    return { silent: true, reason: questionResult.reason ?? "no-pending-questions" };
  }

  const questionDelivery = await readQuestionDelivery(stateFile);
  const available = filterCooldownQuestions(questionResult.questions, questionDelivery, date);
  if (available.length === 0) return { silent: true, reason: "all-questions-on-cooldown" };

  const question = available[0];

  // Record delivery BEFORE returning the question to the agent. This ensures
  // the cooldown fires even when the agent fails to deliver, preventing a
  // broken run from re-asking the same question on the very next cron tick.
  // Prune expired entries at the same time to keep the state file bounded.
  const state = await readJsonObject(stateFile);
  const updatedDelivery: Record<string, string> = {};
  for (const [id, deliveredOn] of Object.entries(questionDelivery)) {
    if (daysBetween(deliveredOn, date) < QUESTION_COOLDOWN_DAYS) {
      updatedDelivery[id] = deliveredOn;
    }
  }
  updatedDelivery[question.id] = date;
  state.questionDelivery = updatedDelivery;
  await writeJson(stateFile, state);

  return { questionId: question.id, prompt: question.prompt };
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
