#!/usr/bin/env bun
/**
 * Deterministic guardrails for prompt-led daily brief preparation.
 *
 * This script deliberately does not compose the user-facing brief. The prepare
 * prompt owns wholesale synthesis from deterministic JSON context. This module
 * owns the mechanical pieces around that creative step: context collection,
 * idempotency, URL sanitization, marker validation, Kanban create/block, and
 * heartbeat bookkeeping.
 */

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { buildDailyBriefContext, type DailyBriefContext } from "./build-daily-brief-context";
import {
  extractDigestOpportunityIds,
  extractDigestQuestionIds,
  sanitizeDigestUrls,
} from "./validate-digest-urls";

/**
 * Kanban statuses that mean today's digest card already exists and must not be
 * disturbed by a re-run of the prepare step. To force a fresh card, archive
 * today's first, then regenerate.
 */
const PROTECTED_DIGEST_STATUSES = new Set([
  "blocked",
  "ready",
  "todo",
  "in_progress",
  "doing",
  "done",
  "completed",
]);

type HermesRunner = (args: string[]) => string | Promise<string>;

interface HermesTask {
  id?: string;
  status?: string;
  body?: string;
}

interface ExistingDigestCard {
  taskId: string;
  status: string;
  body: string;
  opportunityIds: string[];
  questionIds: string[];
}

interface StageResult {
  taskId: string;
  body: string;
  opportunityIds: string[];
  questionIds: string[];
  skipped?: boolean;
  reason?: string;
}

interface PrepareContextResult {
  date: string;
  contextOut: string;
  skipped?: boolean;
  reason?: string;
  taskId?: string;
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || "/opt/data";
}

function resolveHermesPath(path: string): string {
  return isAbsolute(path) ? path : join(hermesHome(), path);
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

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readDailyBriefContext(path: string): Promise<DailyBriefContext | null> {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(await Bun.file(path).text()) as DailyBriefContext;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
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
    env: { ...process.env, HOME: hermesHome(), HERMES_HOME: hermesHome() },
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

async function readExistingDigestCard(
  hermes: HermesRunner,
  stateFile: string,
  date: string,
): Promise<ExistingDigestCard | null> {
  const state = await readJsonObject(stateFile);
  const prepared = state.prepared && typeof state.prepared === "object" && !Array.isArray(state.prepared)
    ? state.prepared as Record<string, unknown>
    : {};
  if (prepared.date !== date) return null;
  const taskId = typeof prepared.taskId === "string" ? prepared.taskId : "";
  if (!taskId) return null;

  let task: HermesTask | null = null;
  try {
    task = parseTask(await hermes(["kanban", "show", taskId, "--json"]));
  } catch {
    return null;
  }
  if (!task) return null;

  const status = String(task.status ?? "").toLowerCase();
  if (!status || status === "archived") return null;

  return {
    taskId,
    status,
    body: typeof task.body === "string" ? task.body : "",
    opportunityIds: stringArray(prepared.opportunityIds),
    questionIds: stringArray(prepared.questionIds),
  };
}

function extractTaskId(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; task?: { id?: unknown } };
    const id = typeof parsed.id === "string" ? parsed.id : typeof parsed.task?.id === "string" ? parsed.task.id : "";
    if (id) return id;
  } catch {
    // fall through to regex extraction
  }
  const match = trimmed.match(/\b(t_[A-Za-z0-9_-]+)\b/);
  if (match) return match[1];
  throw new Error(`could not parse task id from kanban create output: ${trimmed.slice(0, 200)}`);
}

function contextOpportunityIds(context: DailyBriefContext): Set<string> {
  return new Set(
    context.opportunities
      .map((opp) => opp.opportunityId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
}

function contextQuestionIds(context: DailyBriefContext): Set<string> {
  return new Set([
    ...(context.questions ?? []).map((question) => question.id),
    `daily-identity-${context.date}`,
  ]);
}

function validateMarkers(body: string, context: DailyBriefContext): { opportunityIds: string[]; questionIds: string[] } {
  const opportunityIds = extractDigestOpportunityIds(body);
  const questionIds = extractDigestQuestionIds(body);
  const knownOpportunityIds = contextOpportunityIds(context);
  const knownQuestionIds = contextQuestionIds(context);
  const unknownOpportunityIds = opportunityIds.filter((id) => !knownOpportunityIds.has(id));
  const unknownQuestionIds = questionIds.filter((id) => !knownQuestionIds.has(id));

  if (unknownOpportunityIds.length > 0) {
    throw new Error(`digest body contains unknown opportunity marker id(s): ${unknownOpportunityIds.join(", ")}`);
  }
  if (unknownQuestionIds.length > 0) {
    throw new Error(`digest body contains unknown question marker id(s): ${unknownQuestionIds.join(", ")}`);
  }

  return { opportunityIds, questionIds };
}

export async function prepareDailyBriefContext(options: {
  date?: string;
  opportunitiesFile?: string;
  stateFile?: string;
  contextOut?: string;
  hermes?: HermesRunner;
} = {}): Promise<PrepareContextResult> {
  const date = options.date ?? pacificDate();
  const opportunitiesFile = resolveHermesPath(options.opportunitiesFile ?? "memory/digest-opportunities.txt");
  const stateFile = resolveHermesPath(options.stateFile ?? "memory/heartbeat-state.json");
  const contextOut = resolveHermesPath(options.contextOut ?? "memory/daily-brief-context.json");
  const hermes = options.hermes ?? runHermes;

  const existing = await readExistingDigestCard(hermes, stateFile, date);
  if (existing && PROTECTED_DIGEST_STATUSES.has(existing.status)) {
    return {
      date,
      contextOut,
      taskId: existing.taskId,
      skipped: true,
      reason: `already-staged:${existing.status}`,
    };
  }

  const context = await buildDailyBriefContext({ date, opportunitiesFile, stateFile });
  await writeJson(contextOut, context);
  return { date, contextOut };
}

export async function stageDailyBrief(options: {
  date?: string;
  body?: string;
  bodyFile?: string;
  opportunitiesFile?: string;
  stateFile?: string;
  contextOut?: string;
  hermes?: HermesRunner;
} = {}): Promise<StageResult> {
  const date = options.date ?? pacificDate();
  const opportunitiesFile = resolveHermesPath(options.opportunitiesFile ?? "memory/digest-opportunities.txt");
  const stateFile = resolveHermesPath(options.stateFile ?? "memory/heartbeat-state.json");
  const contextOut = resolveHermesPath(options.contextOut ?? "memory/daily-brief-context.json");
  const bodyFile = options.bodyFile ? resolveHermesPath(options.bodyFile) : undefined;
  const hermes = options.hermes ?? runHermes;

  const existing = await readExistingDigestCard(hermes, stateFile, date);
  if (existing && PROTECTED_DIGEST_STATUSES.has(existing.status)) {
    return {
      taskId: existing.taskId,
      body: existing.body,
      opportunityIds: existing.opportunityIds,
      questionIds: existing.questionIds,
      skipped: true,
      reason: `already-staged:${existing.status}`,
    };
  }

  if (options.body !== undefined && bodyFile) {
    throw new Error("stageDailyBrief accepts only one body input: --body-stdin or --body-file");
  }
  if (options.body === undefined && !bodyFile) {
    throw new Error("stageDailyBrief requires --body-stdin or --body-file unless today's digest is already staged");
  }

  let context = await readDailyBriefContext(contextOut);
  if (!context || context.date !== date) {
    context = await buildDailyBriefContext({ date, opportunitiesFile, stateFile });
    await writeJson(contextOut, context);
  }

  const rawBody = options.body ?? await Bun.file(bodyFile!).text();
  if (!rawBody.trim()) throw new Error("digest body is empty");

  const { output: sanitizedBody } = sanitizeDigestUrls(rawBody.trim());
  const { opportunityIds, questionIds } = validateMarkers(sanitizedBody, context);

  const createOutput = await hermes([
    "kanban",
    "create",
    `Morning digest — ${date}`,
    "--body",
    sanitizedBody,
    "--idempotency-key",
    `digest-${date}`,
    "--json",
  ]);
  const taskId = extractTaskId(createOutput);

  await hermes(["kanban", "block", taskId, `review-required: morning brief — ${date}`]);

  const state = await readJsonObject(stateFile);
  state.prepared = {
    date,
    taskId,
    taskTitle: `Morning digest — ${date}`,
    opportunityIds,
    questionIds,
  };
  await writeJson(stateFile, state);

  return { taskId, body: sanitizedBody, opportunityIds, questionIds };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const common = {
    date: argValue(args, "--date"),
    opportunitiesFile: argValue(args, "--opportunities-file"),
    stateFile: argValue(args, "--state-file"),
    contextOut: argValue(args, "--context-out"),
  };

  if (args.includes("--prepare-context")) {
    const result = await prepareDailyBriefContext(common);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const body = args.includes("--body-stdin")
    ? await Bun.readableStreamToText(Bun.stdin.stream())
    : undefined;

  const result = await stageDailyBrief({
    ...common,
    body,
    bodyFile: argValue(args, "--body-file"),
  });
  process.stdout.write(`${JSON.stringify({ taskId: result.taskId, opportunityIds: result.opportunityIds, questionIds: result.questionIds, skipped: result.skipped, reason: result.reason })}\n`);
}

if (import.meta.main) {
  await main();
}
