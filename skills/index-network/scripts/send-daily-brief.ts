#!/usr/bin/env bun
/**
 * Deterministically deliver the approved daily morning brief from Kanban.
 *
 * The send cron prompt should not reimplement file, Kanban, or URL-guard logic
 * with model-generated Python. This script owns approval-gate checking, outgoing
 * body persistence, delivery-state bookkeeping, Kanban completion, and final
 * body sanitization. The local state file is the record of what was delivered;
 * nothing is reported back to Index. The
 * prompt only needs to call this script and return the returned brief verbatim.
 *
 * A `--date` earlier than today's village date is a read-only rerun for
 * delivery state: it writes neither `deliveredToday` nor the delivery log.
 */

import { existsSync } from "node:fs";
import { access } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import { QUESTION_COOLDOWN_DAYS, realVillageDate, villageDate } from "./build-daily-brief-context";
import {
  OPPORTUNITY_DELIVERY_KEY,
  deliveryLogChanged,
  isBackDated,
  pruneDeliveryLog,
  readDeliveryLog,
  recordShowings,
} from "./delivery-state";
import { RECEIPT_STATE_KEY, extractDigestReceiptIds, recordReceipts, stripDigestReceiptMarkers } from "./intention-brief";
import { sanitizeDigestUrls } from "./validate-digest-urls";

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

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || "/opt/data";
}

function resolveHermesPath(path: string): string {
  return isAbsolute(path) ? path : join(hermesHome(), path);
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

/**
 * DATA-222: after the specific strippers, any HTML comment still in the body
 * (a malformed marker, a stray note), an HTML-escaped one
 * (`&lt;!-- ... --&gt;`), and any lone `<!--` or `-->`, so nothing internal
 * reaches the resident.
 */
export function stripRemainingHtmlComments(text: string): string {
  return text
    .replace(/[ \t]*<!--[\s\S]*?-->[ \t]*/g, (match, offset: number, whole: string) => {
      const before = offset > 0 ? whole[offset - 1] : "\n";
      const after = whole[offset + match.length] ?? "\n";
      return /\s/.test(before) || /\s/.test(after) ? "" : " ";
    })
    .replace(/&lt;!--[\s\S]*?--&gt;/gi, "")
    .replace(/<!--|-->/g, "");
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
  const date = options.date ?? villageDate();
  const stateFile = resolveHermesPath(options.stateFile ?? "memory/heartbeat-state.json");
  const outgoingFile = resolveHermesPath(options.outgoingFile ?? "memory/digest-outgoing.md");
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
  const opportunityIds = stringArray(prepared.opportunityIds);
  const questionIds = stringArray(prepared.questionIds);

  const readOnly = isBackDated(date, realVillageDate());
  const storedDeliveryLog = readDeliveryLog(state, date, realVillageDate());
  const deliveredToday = state.deliveredToday && typeof state.deliveredToday === "object" && !Array.isArray(state.deliveredToday)
    ? state.deliveredToday as Record<string, unknown>
    : {};
  const currentIds = deliveredToday.date === date ? stringArray(deliveredToday.ids) : [];
  if (!readOnly) {
    state.deliveredToday = {
      date,
      ids: Array.from(new Set([...currentIds, ...opportunityIds])),
    };
  }

  // One showing for each card the sent brief names, for the cross-day card
  // cooldown (delivery-state.ts). The log was read from the state as loaded,
  // before deliveredToday was replaced, so a state file from before the log
  // existed still counts the cards its set holds.
  const deliveryLog = pruneDeliveryLog(recordShowings(storedDeliveryLog, opportunityIds, date), date, null);
  if (!readOnly && deliveryLogChanged(state, deliveryLog)) state[OPPORTUNITY_DELIVERY_KEY] = deliveryLog;

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

  const { output: sanitized } = sanitizeDigestUrls(stripDigestReceiptMarkers(body), { stripDigestMetadata: true });
  const finalBrief = stripRemainingHtmlComments(sanitized);

  // DATA-222: the inferred intentions this brief receipted, so later briefs do
  // not list them again: the ids staging kept that are also in the body sent.
  // Recorded after the card was completed, the last step here that can fail;
  // the reply itself is delivered by Hermes after this script, which nothing
  // here can wait for. A failed write is a receipt shown again, never one lost.
  if (!readOnly) {
    const sent = new Set(extractDigestReceiptIds(body));
    const receiptIds = stringArray(prepared.receiptIds).filter((id) => sent.has(id));
    try {
      // Read back what this run just wrote; a file that no longer parses as an
      // object is left alone rather than replaced by the receipts alone.
      const parsed = JSON.parse(await Bun.file(stateFile).text()) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TypeError("state-unreadable");
      const latest = parsed as Record<string, unknown>;
      const receipts = recordReceipts(latest[RECEIPT_STATE_KEY], receiptIds, date);
      if (receipts !== null) {
        latest[RECEIPT_STATE_KEY] = receipts;
        await writeJson(stateFile, latest);
      }
    } catch (err) {
      process.stderr.write(`warning: intention receipts not recorded (${err instanceof Error ? err.name : "error"})\n`);
    }
  }

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
