#!/usr/bin/env bun
/**
 * Deterministically deliver the approved daily morning brief from Kanban.
 *
 * The send cron prompt should not reimplement file, Kanban, or URL-guard logic
 * with model-generated Python. This script owns approval-gate checking, outgoing
 * body persistence, digest marker extraction, delivery-state bookkeeping,
 * Kanban completion, and final body sanitization. The prompt only needs to call
 * this script, confirm the returned opportunity ids through MCP, and return the
 * returned brief verbatim.
 */

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";

import { QUESTION_COOLDOWN_DAYS } from "./build-daily-brief-context";
import { extractDigestOpportunityIds, extractDigestQuestionIds, sanitizeDigestUrls } from "./validate-digest-urls";

interface SendResult {
  taskId: string;
  opportunityIds: string[];
  questionIds: string[];
  finalBrief: string;
}

interface SilentResult {
  silent: true;
  reason: string;
}

interface HermesTask {
  id?: string;
  status?: string;
  body?: string;
}

type HermesRunner = (args: string[]) => string | Promise<string>;

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
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Whether a question delivery entry is still inside the re-delivery cooldown.
 * Future-dated entries (clock skew) count as within cooldown — never re-spam
 * on ambiguity, matching filterCooldownQuestions in build-daily-brief-context.
 */
function withinQuestionCooldown(deliveredOn: string, today: string): boolean {
  const toUtc = (d: string) => {
    const [year, month, day] = d.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  const elapsedDays = Math.floor((toUtc(today) - toUtc(deliveredOn)) / 86_400_000);
  return elapsedDays < QUESTION_COOLDOWN_DAYS;
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveHermesCommand(): Promise<string> {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  if (await fileExists("/opt/hermes/.venv/bin/hermes")) return "/opt/hermes/.venv/bin/hermes";
  return "hermes";
}

async function runHermes(args: string[]): Promise<string> {
  const hermes = await resolveHermesCommand();
  const result = Bun.spawnSync([hermes, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HERMES_HOME ?? process.env.HOME, HERMES_HOME: process.env.HERMES_HOME ?? process.cwd() },
  });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const stdout = new TextDecoder().decode(result.stdout).trim();
    throw new Error(`${hermes} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return new TextDecoder().decode(result.stdout);
}

function parseTask(raw: string): HermesTask | null {
  try {
    const parsed = JSON.parse(raw) as { task?: HermesTask } & HermesTask;
    const task = parsed.task && typeof parsed.task === "object" ? parsed.task : parsed;
    return task && typeof task === "object" ? task : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export async function sendDailyBrief(options: {
  date?: string;
  stateFile?: string;
  outgoingFile?: string;
  hermes?: HermesRunner;
} = {}): Promise<SendResult | SilentResult> {
  const date = options.date ?? pacificDate();
  const stateFile = options.stateFile ?? "memory/heartbeat-state.json";
  const outgoingFile = options.outgoingFile ?? "memory/digest-outgoing.md";
  const hermes = options.hermes ?? runHermes;

  const state = await readJsonObject(stateFile);
  const prepared = state.prepared && typeof state.prepared === "object" && !Array.isArray(state.prepared)
    ? state.prepared as Record<string, unknown>
    : {};
  const taskId = typeof prepared.taskId === "string" ? prepared.taskId : "";
  const preparedDate = typeof prepared.date === "string" ? prepared.date : "";

  if (!taskId || preparedDate !== date) {
    return { silent: true, reason: "no-staged-task" };
  }

  const task = parseTask(await hermes(["kanban", "show", taskId, "--json"]));
  if (!task) return { silent: true, reason: "task-unreadable" };

  const status = String(task.status ?? "").toLowerCase();
  if (status !== "ready" && status !== "todo") {
    return { silent: true, reason: `not-approved:${status || "unknown"}` };
  }

  const body = typeof task.body === "string" ? task.body : "";
  if (!body.trim()) return { silent: true, reason: "empty-body" };

  await Bun.write(outgoingFile, body);
  const opportunityIds = extractDigestOpportunityIds(body);
  const questionIds = extractDigestQuestionIds(body);

  const deliveredToday = state.deliveredToday && typeof state.deliveredToday === "object" && !Array.isArray(state.deliveredToday)
    ? state.deliveredToday as Record<string, unknown>
    : {};
  const currentIds = deliveredToday.date === date ? stringArray(deliveredToday.ids) : [];
  state.deliveredToday = {
    date,
    ids: Array.from(new Set([...currentIds, ...opportunityIds])),
  };

  // Cross-day question delivery log: record today's delivered question ids and
  // prune entries past the cooldown (they no longer affect filtering, so the
  // prune is lossless and keeps the state file bounded).
  const questionDelivery = state.questionDelivery && typeof state.questionDelivery === "object" && !Array.isArray(state.questionDelivery)
    ? { ...(state.questionDelivery as Record<string, unknown>) }
    : {};
  for (const [id, deliveredOn] of Object.entries(questionDelivery)) {
    if (typeof deliveredOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(deliveredOn) || !withinQuestionCooldown(deliveredOn, date)) {
      delete questionDelivery[id];
    }
  }
  for (const id of questionIds) questionDelivery[id] = date;
  state.questionDelivery = questionDelivery;

  await writeJson(stateFile, state);

  await hermes(["kanban", "complete", taskId, "--summary", "delivered"]);

  const { output: finalBrief } = sanitizeDigestUrls(body, { stripDigestMetadata: true });
  return { taskId, opportunityIds, questionIds, finalBrief };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await sendDailyBrief({
    date: argValue(args, "--date"),
    stateFile: argValue(args, "--state-file"),
    outgoingFile: argValue(args, "--outgoing-file"),
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
