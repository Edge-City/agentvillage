#!/usr/bin/env bun
/**
 * Shared daily-loop canary for non-brief Edge interruptions.
 *
 * The point of this module is the boundary, not final copy. Morning brief can
 * later write into the same state/context contract so Edge has one record of
 * what it already surfaced or asked today.
 */

import { existsSync, mkdirSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";

// context: normalized calendar/RSVP/Index/memory/brief-history inputs
export type DailyLoopWindow = "1500" | "1800" | "2100";
export type DailyLoopRole =
  | "orient"
  | "calibrate_rest_of_day"
  | "event_followup"
  | "close_loop"
  | "tomorrow_prep"
  | "silent";
export type DailyLoopInput =
  | "pending-question"
  | "thin-signal"
  | "pace-preference"
  | "ended-rsvp"
  | "live-opportunity"
  | "active-want"
  | "reflection"
  | "brief-history";
export type DailyLoopSkipReason =
  | "brief-already-asked"
  | "event-followup-replaces-evening"
  | "quiet-pace"
  | "no-new-context"
  | "budget-used"
  | "cooldown"
  | "stale";

export interface DailyLoopWindowSpec {
  window: DailyLoopWindow;
  prepareHour: number;
  sendHour: number;
  titleTime: string;
}

export const DAILY_LOOP_WINDOWS: DailyLoopWindowSpec[] = [
  { window: "1500", prepareHour: 14, sendHour: 15, titleTime: "15:00" },
  { window: "1800", prepareHour: 17, sendHour: 18, titleTime: "18:00" },
  { window: "2100", prepareHour: 20, sendHour: 21, titleTime: "21:00" },
];

export interface DailyLoopEvent {
  title?: string;
  eventUrl?: string;
}

export interface DailyLoopContext {
  pendingQuestion?: { id?: string; prompt?: string };
  thinSignal?: string;
  pacePreference?: string;
  endedRsvpEvent?: DailyLoopEvent;
  opportunityCount?: number;
  opportunityCategory?: string;
  opportunityNames?: string[];
  opportunityUrls?: string[];
  activeWant?: string;
  dayEventCount?: number;
  unansweredEarlierLoop?: boolean;
  briefAskedQuestionIds?: string[];
}

export interface DailyLoopCandidate {
  body: string;
  role: DailyLoopRole;
  inputType: DailyLoopInput;
  inputLabel: string;
  questionId?: string;
  replacesRoles?: DailyLoopRole[];
}

// render: placeholder tone/templates; launch-blocking copy surface
export const DAILY_LOOP_RENDER_CONFIG = {
  status: "placeholder",
  launchBlockedOn: "product/tone refinement",
  approvalMarker: "APPROVED_DAILY_LOOP_SEND",
  todo:
    "TODO before launch: replace examples with approved Edge daily-loop question/tone guidance. Keep mechanics deterministic.",
  examplesByWindow: {
    "1500": "What would make the rest of today useful — a person, a topic, or quiet time?",
    "1800": "Did you make it to {event}? If yes, did it surface anyone or anything you want help following up on?",
    "2100": "What should I carry forward from today — a person, idea, moment, or something you want more of tomorrow?",
  } satisfies Record<DailyLoopWindow, string>,
};

// state: surfaced/asked/sent/skipped, visible budget, cooldowns
interface DailyLoopRecord {
  at: string;
  role: DailyLoopRole;
  window?: DailyLoopWindow;
  reason?: string;
  questionId?: string;
  taskId?: string;
}

interface WindowRecord {
  date?: string;
  taskId?: string;
  idempotencyKey?: string;
  role?: DailyLoopRole;
  inputType?: DailyLoopInput;
  inputLabel?: string;
  questionId?: string;
  body?: string;
  preparedAt?: string;
  sentAt?: string;
  skippedAt?: string;
  skipReason?: DailyLoopSkipReason;
}

export interface DailyLoopState {
  date?: string;
  visibleBudget?: { date?: string; nonBriefLimit?: number; nonBriefSent?: number; lastSentAt?: string };
  cooldowns?: { nonBriefMinutes?: number };
  surfaced?: DailyLoopRecord[];
  asked?: DailyLoopRecord[];
  sent?: DailyLoopRecord[];
  skipped?: DailyLoopRecord[];
  windows?: Partial<Record<DailyLoopWindow, WindowRecord>>;
}

type HermesRunner = (args: string[]) => string | Promise<string>;

const DEFAULT_NON_BRIEF_LIMIT = 1;
const DEFAULT_COOLDOWN_MINUTES = 90;
const DEFAULT_STALE_AFTER_MINUTES = 90;
const APPROVAL_MARKER = DAILY_LOOP_RENDER_CONFIG.approvalMarker;

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function hostLocalDate(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function hostLocalTime(date: string, hour: number): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day, hour);
}

function windowSpec(window: DailyLoopWindow): DailyLoopWindowSpec {
  const spec = DAILY_LOOP_WINDOWS.find((entry) => entry.window === window);
  if (!spec) throw new Error(`unknown daily-loop window: ${window}`);
  return spec;
}

export function scheduledWindowForHostHour(kind: "prepare" | "send", hour: number): DailyLoopWindow | undefined {
  const spec = DAILY_LOOP_WINDOWS.find((entry) => (kind === "prepare" ? entry.prepareHour : entry.sendHour) === hour);
  return spec?.window;
}

export function resolveWindowArg(args: string[], kind: "prepare" | "send", now = new Date()): DailyLoopWindow | undefined {
  const explicit = argValue(args, "--window");
  if (explicit) {
    if (!DAILY_LOOP_WINDOWS.some((entry) => entry.window === explicit)) return undefined;
    return explicit as DailyLoopWindow;
  }
  return scheduledWindowForHostHour(kind, now.getHours());
}

function titleFor(date: string, window: DailyLoopWindow): string {
  return `Daily loop ${windowSpec(window).titleTime} — ${date}`;
}

function idempotencyKey(date: string, window: DailyLoopWindow): string {
  return `daily-loop-${date}-${window}`;
}

function firstAllowedOpportunityName(context: DailyLoopContext): string | undefined {
  if (!context.opportunityUrls?.some((url) => /^https?:\/\//.test(url))) return undefined;
  return context.opportunityNames?.find((name) => name.trim());
}

function linkEvent(event: DailyLoopEvent): string {
  const title = event.title?.trim() || "that event";
  return event.eventUrl ? `[${title}](${event.eventUrl})` : title;
}

function quietPace(context: DailyLoopContext): boolean {
  return /\b(quiet|stay quiet|do not interrupt|don't interrupt)\b/i.test(context.pacePreference ?? "");
}

// roles + render: explicit role/input/outcome contract
export function composeDailyLoopCandidate(options: {
  date: string;
  window: DailyLoopWindow;
  context: DailyLoopContext;
}): DailyLoopCandidate | null {
  const { window, context } = options;

  if (window === "1500") {
    const prompt = context.pendingQuestion?.prompt?.trim();
    if (prompt) {
      return {
        body: prompt,
        role: "calibrate_rest_of_day",
        inputType: "pending-question",
        inputLabel: "pending Index question",
        questionId: context.pendingQuestion?.id,
      };
    }
    if (context.thinSignal?.trim()) {
      return {
        body: DAILY_LOOP_RENDER_CONFIG.examplesByWindow["1500"],
        role: "calibrate_rest_of_day",
        inputType: "thin-signal",
        inputLabel: "thin or older signal",
      };
    }
    return null;
  }

  if ((window === "1800" || window === "2100") && (context.endedRsvpEvent?.title || context.endedRsvpEvent?.eventUrl)) {
    return {
      body: `Did you make it to ${linkEvent(context.endedRsvpEvent)}? If yes, did it surface anyone or anything you want help following up on?`,
      role: "event_followup",
      inputType: "ended-rsvp",
      inputLabel: "ended RSVP event",
      replacesRoles: ["close_loop", "tomorrow_prep"],
    };
  }

  if (window === "1800") {
    if ((context.opportunityCount ?? 0) > 0) {
      const name = firstAllowedOpportunityName(context);
      const personPhrase = name ? `${name} or someone adjacent` : "one useful person";
      return {
        body: `If ${personPhrase} would be worth meeting this evening, what kind of person would that be?`,
        role: "calibrate_rest_of_day",
        inputType: "live-opportunity",
        inputLabel: `${context.opportunityCount} live ${context.opportunityCategory || "opportunity"} candidate(s)`,
      };
    }
    if (context.activeWant?.trim()) {
      return {
        body: "What kind of person would be useful to meet this evening?",
        role: "calibrate_rest_of_day",
        inputType: "active-want",
        inputLabel: "active want",
      };
    }
    return null;
  }

  if (context.unansweredEarlierLoop) {
    return {
      body: "Anything you are looking for tomorrow based on today?",
      role: "close_loop",
      inputType: "reflection",
      inputLabel: "unanswered earlier daily-loop card",
    };
  }
  if ((context.dayEventCount ?? 0) > 0 || context.activeWant?.trim()) {
    return {
      body: DAILY_LOOP_RENDER_CONFIG.examplesByWindow["2100"],
      role: "tomorrow_prep",
      inputType: "reflection",
      inputLabel: "reflection or tomorrow prep",
    };
  }
  return null;
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
  mkdirSync(dirname(path), { recursive: true });
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

function extractTaskId(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; task?: { id?: unknown } };
    const id = typeof parsed.id === "string" ? parsed.id : typeof parsed.task?.id === "string" ? parsed.task.id : "";
    if (id) return id;
  } catch {
    // fall through
  }
  const match = trimmed.match(/\b(t_[A-Za-z0-9_-]+)\b/);
  if (match) return match[1];
  throw new Error(`could not parse task id from kanban create output: ${trimmed.slice(0, 200)}`);
}

function parseTask(raw: string): { id?: string; status?: string; body?: string } | null {
  try {
    const parsed = JSON.parse(raw) as { task?: { id?: string; status?: string; body?: string } } & {
      id?: string;
      status?: string;
      body?: string;
    };
    const task = parsed.task && typeof parsed.task === "object" ? parsed.task : parsed;
    return task && typeof task === "object" ? task : null;
  } catch {
    return null;
  }
}

export function normalizeDailyLoopState(value: Record<string, unknown>, date: string): DailyLoopState {
  const state = value as DailyLoopState;
  if (state.date !== date) {
    return {
      date,
      visibleBudget: { date, nonBriefLimit: DEFAULT_NON_BRIEF_LIMIT, nonBriefSent: 0 },
      cooldowns: { nonBriefMinutes: DEFAULT_COOLDOWN_MINUTES },
      surfaced: [],
      asked: [],
      sent: [],
      skipped: [],
      windows: {},
    };
  }
  state.visibleBudget = state.visibleBudget?.date === date
    ? state.visibleBudget
    : { date, nonBriefLimit: DEFAULT_NON_BRIEF_LIMIT, nonBriefSent: 0 };
  state.visibleBudget.nonBriefLimit ??= DEFAULT_NON_BRIEF_LIMIT;
  state.visibleBudget.nonBriefSent ??= 0;
  state.cooldowns ??= { nonBriefMinutes: DEFAULT_COOLDOWN_MINUTES };
  state.cooldowns.nonBriefMinutes ??= DEFAULT_COOLDOWN_MINUTES;
  state.surfaced ??= [];
  state.asked ??= [];
  state.sent ??= [];
  state.skipped ??= [];
  state.windows ??= {};
  return state;
}

function minutesSince(iso: string | undefined, nowIso: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (new Date(nowIso).getTime() - new Date(iso).getTime()) / 60_000;
}

function isStale(date: string, window: DailyLoopWindow, nowIso: string, staleAfterMinutes: number): boolean {
  const sendAt = hostLocalTime(date, windowSpec(window).sendHour);
  return (new Date(nowIso).getTime() - sendAt.getTime()) / 60_000 > staleAfterMinutes;
}

function recordSkip(
  state: DailyLoopState,
  nowIso: string,
  role: DailyLoopRole,
  window: DailyLoopWindow,
  reason: DailyLoopSkipReason,
): void {
  state.skipped ??= [];
  state.skipped.push({ at: nowIso, role, window, reason });
}

// policy: should interrupt? replacement rules? visible budget?
export function evaluateDailyLoopPolicy(options: {
  state: DailyLoopState;
  context: DailyLoopContext;
  candidate: DailyLoopCandidate | null;
  window: DailyLoopWindow;
  nowIso: string;
}): { ok: true; candidate: DailyLoopCandidate } | { ok: false; reason: DailyLoopSkipReason } {
  const { state, context, candidate, nowIso, window } = options;
  if (quietPace(context)) {
    recordSkip(state, nowIso, "silent", window, "quiet-pace");
    return { ok: false, reason: "quiet-pace" };
  }
  if (!candidate) {
    recordSkip(state, nowIso, "silent", window, "no-new-context");
    return { ok: false, reason: "no-new-context" };
  }
  if (
    candidate.questionId
    && (
      state.asked?.some((record) => record.questionId === candidate.questionId)
      || context.briefAskedQuestionIds?.includes(candidate.questionId)
    )
  ) {
    recordSkip(state, nowIso, candidate.role, window, "brief-already-asked");
    return { ok: false, reason: "brief-already-asked" };
  }
  const budget = state.visibleBudget ?? { nonBriefLimit: DEFAULT_NON_BRIEF_LIMIT, nonBriefSent: 0 };
  if ((budget.nonBriefSent ?? 0) >= (budget.nonBriefLimit ?? DEFAULT_NON_BRIEF_LIMIT)) {
    recordSkip(state, nowIso, candidate.role, window, "budget-used");
    return { ok: false, reason: "budget-used" };
  }
  if (minutesSince(budget.lastSentAt, nowIso) < (state.cooldowns?.nonBriefMinutes ?? DEFAULT_COOLDOWN_MINUTES)) {
    recordSkip(state, nowIso, candidate.role, window, "cooldown");
    return { ok: false, reason: "cooldown" };
  }
  if (candidate.role === "event_followup" && candidate.replacesRoles?.length) {
    recordSkip(state, nowIso, "close_loop", window, "event-followup-replaces-evening");
  }
  return { ok: true, candidate };
}

function bodyWithReviewNote(body: string, candidate: DailyLoopCandidate): string {
  return [
    body,
    "",
    "<!-- daily-loop-review: placeholder launch copy; product/tone refinement required before broad launch -->",
    `<!-- daily-loop-source:role=${candidate.role}; input=${candidate.inputType}; label=${candidate.inputLabel} -->`,
  ].join("\n");
}

function stripDailyLoopMetadata(body: string): string {
  return body
    .replace(/<!--\s*daily-loop-(?:review|source):[\s\S]*?-->\n?/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function hasApprovalMarker(body: string): boolean {
  return new RegExp(`\\b${APPROVAL_MARKER}\\b`).test(body);
}

// kanban: staging/review/send helpers
export async function stageDailyLoop(options: {
  date?: string;
  window: DailyLoopWindow;
  nowIso?: string;
  stateFile?: string;
  context: DailyLoopContext;
  hermes?: HermesRunner;
}): Promise<
  | { staged: true; taskId: string; idempotencyKey: string; reused?: true }
  | { staged: false; reason: DailyLoopSkipReason }
> {
  const date = options.date ?? hostLocalDate();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const stateFile = options.stateFile ?? "memory/daily-loop-state.json";
  const hermes = options.hermes ?? runHermes;

  const state = normalizeDailyLoopState(await readJsonObject(stateFile), date);
  const existing = state.windows?.[options.window];
  if (existing?.taskId) {
    return { staged: true, taskId: existing.taskId, idempotencyKey: existing.idempotencyKey ?? idempotencyKey(date, options.window), reused: true };
  }

  const candidate = composeDailyLoopCandidate({ date, window: options.window, context: options.context });
  const decision = evaluateDailyLoopPolicy({ state, context: options.context, candidate, window: options.window, nowIso });
  if (!decision.ok) {
    await writeJson(stateFile, state);
    return { staged: false, reason: decision.reason };
  }

  const key = idempotencyKey(date, options.window);
  const body = bodyWithReviewNote(decision.candidate.body, decision.candidate);
  const createOutput = await hermes([
    "kanban",
    "create",
    titleFor(date, options.window),
    "--body",
    body,
    "--idempotency-key",
    key,
    "--json",
  ]);
  const taskId = extractTaskId(createOutput);
  await hermes(["kanban", "block", taskId, `review-required: daily loop ${windowSpec(options.window).titleTime} — ${date}`]);

  state.surfaced?.push({ at: nowIso, role: decision.candidate.role, window: options.window, taskId });
  if (decision.candidate.questionId) {
    state.asked?.push({ at: nowIso, role: decision.candidate.role, window: options.window, questionId: decision.candidate.questionId, taskId });
  }
  state.windows ??= {};
  state.windows[options.window] = {
    date,
    taskId,
    idempotencyKey: key,
    role: decision.candidate.role,
    inputType: decision.candidate.inputType,
    inputLabel: decision.candidate.inputLabel,
    questionId: decision.candidate.questionId,
    body,
    preparedAt: nowIso,
  };
  await writeJson(stateFile, state);

  return { staged: true, taskId, idempotencyKey: key };
}

export async function sendDailyLoop(options: {
  date?: string;
  window: DailyLoopWindow;
  nowIso?: string;
  stateFile?: string;
  hermes?: HermesRunner;
  staleAfterMinutes?: number;
}): Promise<
  | { sent: true; taskId: string; finalMessage: string }
  | { sent: false; reason: string }
> {
  const date = options.date ?? hostLocalDate();
  const nowIso = options.nowIso ?? new Date().toISOString();
  const stateFile = options.stateFile ?? "memory/daily-loop-state.json";
  const hermes = options.hermes ?? runHermes;
  const staleAfterMinutes = options.staleAfterMinutes ?? DEFAULT_STALE_AFTER_MINUTES;

  const state = normalizeDailyLoopState(await readJsonObject(stateFile), date);
  const record = state.windows?.[options.window];
  const taskId = record?.taskId ?? "";
  if (!taskId || record?.date !== date) return { sent: false, reason: "no-staged-task" };
  if (record.sentAt) return { sent: false, reason: "already-sent" };

  if (isStale(date, options.window, nowIso, staleAfterMinutes)) {
    record.skippedAt = nowIso;
    record.skipReason = "stale";
    recordSkip(state, nowIso, record.role ?? "silent", options.window, "stale");
    await writeJson(stateFile, state);
    await hermes(["kanban", "complete", taskId, "--summary", "skipped-stale"]);
    return { sent: false, reason: "stale" };
  }

  const task = parseTask(await hermes(["kanban", "show", taskId, "--json"]));
  if (!task) return { sent: false, reason: "task-unreadable" };

  const status = String(task.status ?? "").toLowerCase();
  if (status !== "ready") return { sent: false, reason: `not-approved:${status || "unknown"}` };

  const rawBody = typeof task.body === "string" ? task.body : "";
  if (!hasApprovalMarker(rawBody)) return { sent: false, reason: "missing-approval-marker" };
  const body = stripDailyLoopMetadata(rawBody.replace(new RegExp(`\\b${APPROVAL_MARKER}\\b`, "g"), ""));
  if (!body) return { sent: false, reason: "empty-body" };

  state.visibleBudget = state.visibleBudget?.date === date
    ? state.visibleBudget
    : { date, nonBriefLimit: DEFAULT_NON_BRIEF_LIMIT, nonBriefSent: 0 };
  state.visibleBudget.nonBriefSent = (state.visibleBudget.nonBriefSent ?? 0) + 1;
  state.visibleBudget.lastSentAt = nowIso;
  state.sent?.push({ at: nowIso, role: record.role ?? "silent", window: options.window, taskId });
  record.sentAt = nowIso;
  await writeJson(stateFile, state);

  await hermes(["kanban", "complete", taskId, "--summary", "delivered"]);

  return { sent: true, taskId, finalMessage: body };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

async function loadContext(path?: string, state?: DailyLoopState): Promise<DailyLoopContext> {
  if (!path || !existsSync(path)) {
    return { briefAskedQuestionIds: state?.asked?.map((record) => record.questionId).filter((id): id is string => Boolean(id)) ?? [] };
  }
  const raw = await readJsonObject(path);
  const questions = Array.isArray(raw.questions) ? raw.questions as Array<Record<string, unknown>> : [];
  const rsvpEvents = Array.isArray(raw.rsvpEvents) ? raw.rsvpEvents as Array<Record<string, unknown>> : [];
  const opportunities = Array.isArray(raw.connectionOpportunities)
    ? raw.connectionOpportunities as Array<Record<string, unknown>>
    : Array.isArray(raw.opportunities)
      ? raw.opportunities as Array<Record<string, unknown>>
      : [];
  const prepared = raw.prepared && typeof raw.prepared === "object" && !Array.isArray(raw.prepared)
    ? raw.prepared as Record<string, unknown>
    : {};

  return {
    pendingQuestion: questions[0]
      ? { id: String(questions[0].id ?? ""), prompt: String(questions[0].prompt ?? "") }
      : undefined,
    endedRsvpEvent: rsvpEvents[0]
      ? { title: String(rsvpEvents[0].title ?? ""), eventUrl: typeof rsvpEvents[0].eventUrl === "string" ? rsvpEvents[0].eventUrl : undefined }
      : undefined,
    opportunityCount: opportunities.length,
    opportunityCategory: opportunities.length > 0 ? String(opportunities[0].feedCategory ?? "connection") : undefined,
    opportunityNames: opportunities.map((opp) => String(opp.name ?? "")).filter(Boolean),
    opportunityUrls: opportunities.flatMap((opp) => [opp.profileUrl, opp.acceptUrl]).filter((url): url is string => typeof url === "string"),
    dayEventCount: Array.isArray(raw.highlightedEvents) ? raw.highlightedEvents.length : undefined,
    briefAskedQuestionIds: [
      ...stringArray(raw.questionIds),
      ...stringArray(prepared.questionIds),
      ...(state?.asked?.map((record) => record.questionId).filter((id): id is string => Boolean(id)) ?? []),
    ],
  };
}

// cron entrypoints: prepare/send wakeups
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = hasFlag(args, "--send") ? "send" : "prepare";
  const now = new Date();
  const window = resolveWindowArg(args, mode, now);
  const date = argValue(args, "--date") ?? hostLocalDate(now);
  const stateFile = argValue(args, "--state-file") ?? "memory/daily-loop-state.json";

  if (!window) {
    process.stdout.write("[SILENT]\n");
    return;
  }

  if (mode === "send") {
    const result = await sendDailyLoop({ date, window, stateFile });
    if (!result.sent) {
      process.stdout.write("[SILENT]\n");
      return;
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const existingState = normalizeDailyLoopState(await readJsonObject(stateFile), date);
  const context = await loadContext(argValue(args, "--context-file") ?? "memory/daily-loop-context.json", existingState);
  const result = await stageDailyLoop({ date, window, stateFile, context });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.main) {
  await main();
}
