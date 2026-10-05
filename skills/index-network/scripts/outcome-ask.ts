/**
 * The evening outcome ask (DATA-42, ruling R2): the trigger's half.
 *
 * The 14:00 follow-up announces each newly accepted connection once and
 * records the village date it did (`negotiationSummary.announcedOn`). Two or
 * more days later, the 19:00 evening job asks about ONE such connection that
 * has not been asked yet:
 *
 *   Did you and <name> meet? Reply met, not useful, or missed.
 *
 * When none is due, or Index cannot be read, or the due person's name does
 * not clean, the evening job falls back to its reminder (ask-questions.ts) and
 * the subject stays due.
 *
 * Hand-off to the av-events plugin (plugins/av-events/_outcome_ask.py): when
 * the trigger wakes the model with the question it writes a stage file,
 * `av-events/proactive/outcome-ask-evening.json` (0600, ids only, no name and
 * no text). The plugin arms it on the evening run's reply and, once Hermes's
 * ledger says the message was delivered or queued, emits `outcome.asked` and
 * records the subject in `av-events/proactive/outcome-asked.json`. Only that
 * ledger makes a subject "asked": a run that replies `[SILENT]`, fails to
 * deliver, or never reaches the plugin leaves it due for the next evening,
 * up to MAX_ATTEMPTS evenings. When the plugin idles (blank AV_EVENTS_TOKEN,
 * or outcome_ask in AV_HOOKS_DISABLED) or its asked ledger is unreadable,
 * nothing could record an ask, and the evening asks nobody
 * (proactive.ts outcomePluginOff, readAskedIds).
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { PENDING_LIST_LIMIT, parseListedOpportunitiesCounted, resolveIndexApiKey, type BriefOpportunity } from "./build-daily-brief-context";
import { callIndexTool, indexMcpUrl } from "./index-mcp";

/** The one action that asks. */
export const OUTCOME_ASK_ACTION = "evening";
/** §4.1 `asked_by` for this ask. */
export const ASKED_BY = "outcome_cron";
/** The ask is answerable for one day (the plugin's answer rule: 24 hours, and only until the next ask). */
export const WINDOW_DAYS = 1;
/** A connection is asked about this many village days after the follow-up announced it, or later. */
export const DUE_AFTER_DAYS = 2;
/** Evenings a subject may be staged without the plugin confirming the ask; then it is no longer due. */
export const MAX_ATTEMPTS = 3;
/** `negotiationSummary.announcedOn`: opportunity id -> the village date the follow-up announced it. */
export const ANNOUNCED_KEY = "announcedOn";
/** The trigger's own state key: `outcomeAsk.attempts` = opportunity id -> dates it was staged. */
export const OUTCOME_ASK_KEY = "outcomeAsk";

/** The question, word for word. `name` is a cleaned name (proactive-text.ts cleanName). */
export function outcomeQuestion(name: string): string {
  return `Did you and ${name} meet? Reply met, not useful, or missed.`;
}

/** An Index opportunity id we can put in an envelope id (`^[A-Za-z0-9._:-]{1,128}$` with the prefix). */
const OPPORTUNITY_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/** The outcome object for one opportunity: every ask and answer about it lands on this id. */
export function outcomeId(opportunityId: string): string | null {
  return OPPORTUNITY_ID.test(opportunityId) ? `opp-outcome:${opportunityId}` : null;
}

export function stagePath(home: string): string {
  return join(home, "av-events", "proactive", `outcome-ask-${OUTCOME_ASK_ACTION}.json`);
}

/** Written by the plugin only; the trigger reads it. */
export function askedLedgerPath(home: string): string {
  return join(home, "av-events", "proactive", "outcome-asked.json");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The plugin's size cap for the asked ledger (`_outcome_ask.py` LEDGER_MAX_BYTES). */
const ASKED_LEDGER_MAX_BYTES = 256 * 1024;

/**
 * Opportunity ids the plugin recorded as asked (delivered): none when the
 * ledger does not exist yet, and null when it exists but is unreadable. The
 * test is the plugin's own (`private_file` in `_outcome_ask.py`): the plugin
 * never overwrites a ledger it refuses, so it could record no new ask, and an
 * evening that asked anyway would ask the same question again. Null means
 * "ask nobody tonight".
 */
export function readAskedIds(home: string): Set<string> | null {
  const path = askedLedgerPath(home);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  try {
    let file;
    try {
      file = lstatSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
      return null;
    }
    const dir = lstatSync(dirname(path));
    if (!dir.isDirectory() || (uid !== null && dir.uid !== uid) || dir.mode & 0o022) return null;
    if (!file.isFile() || (uid !== null && file.uid !== uid) || file.mode & 0o077 || file.size > ASKED_LEDGER_MAX_BYTES) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    const asked = data && typeof data === "object" && !Array.isArray(data) ? data.asked : undefined;
    if (!asked || typeof asked !== "object" || Array.isArray(asked)) return null;
    return new Set(Object.keys(asked));
  } catch {
    return null;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function dayNumber(date: string): number | null {
  if (!DATE.test(date)) return null;
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.round(ms / 86_400_000);
}

/** `negotiationSummary.announcedOn`, valid entries only. */
export function announcedOn(state: Record<string, unknown>): Record<string, string> {
  const raw = asRecord(asRecord(state.negotiationSummary)[ANNOUNCED_KEY]);
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === "string" && DATE.test(entry[1])));
}

/**
 * Connections the follow-up reported before it recorded dates
 * (`reportedCompletedIds` with no `announcedOn` entry) are dated `date`, so
 * they become due DUE_AFTER_DAYS from now rather than never.
 */
export function backfillAnnounced(state: Record<string, unknown>, date: string): { state: Record<string, unknown>; changed: boolean } {
  const summary = asRecord(state.negotiationSummary);
  const reported = Array.isArray(summary.reportedCompletedIds) ? summary.reportedCompletedIds.filter((id): id is string => typeof id === "string") : [];
  const dated = announcedOn(state);
  const missing = reported.filter((id) => !(id in dated));
  if (missing.length === 0) return { state, changed: false };
  const next = { ...dated, ...Object.fromEntries(missing.map((id) => [id, date])) };
  return { state: { ...state, negotiationSummary: { ...summary, [ANNOUNCED_KEY]: next } }, changed: true };
}

/** `outcomeAsk.attempts`: opportunity id -> the dates the trigger staged an ask about it. */
export function attempts(state: Record<string, unknown>): Record<string, string[]> {
  const raw = asRecord(asRecord(state[OUTCOME_ASK_KEY]).attempts);
  return Object.fromEntries(
    Object.entries(raw).map(([id, dates]) => [id, Array.isArray(dates) ? dates.filter((d): d is string => typeof d === "string" && DATE.test(d)) : []]),
  );
}

/** The state with one more staged attempt for `id` on `date`. Entries for ids already asked are dropped. */
export function recordAttempt(state: Record<string, unknown>, id: string, date: string, asked: Set<string>): Record<string, unknown> {
  const current = attempts(state);
  const next: Record<string, string[]> = {};
  for (const [key, dates] of Object.entries(current)) if (!asked.has(key)) next[key] = dates;
  next[id] = Array.from(new Set([...(next[id] ?? []), date]));
  return { ...state, [OUTCOME_ASK_KEY]: { ...asRecord(state[OUTCOME_ASK_KEY]), attempts: next } };
}

/**
 * Opportunity ids due an ask on `date`: announced DUE_AFTER_DAYS or more days
 * earlier, not in the plugin's asked ledger, staged on fewer than
 * MAX_ATTEMPTS earlier evenings (and not already today). Oldest announcement
 * first, then by id, so the order is the same on every run.
 */
export function dueSubjects(state: Record<string, unknown>, asked: Set<string>, date: string): string[] {
  const today = dayNumber(date);
  if (today === null) return [];
  const tried = attempts(state);
  return Object.entries(announcedOn(state))
    .flatMap(([id, on]) => {
      const day = dayNumber(on);
      if (day === null || today - day < DUE_AFTER_DAYS || asked.has(id) || !outcomeId(id)) return [];
      const dates = tried[id] ?? [];
      if (dates.includes(date) || dates.length >= MAX_ATTEMPTS) return [];
      return [[id, on] as const];
    })
    .sort((a, b) => (a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? -1 : 1))
    .map(([id]) => id);
}

export interface OutcomeStage {
  v: 1;
  action: typeof OUTCOME_ASK_ACTION;
  date: string;
  staged_at: string;
  asked_by: typeof ASKED_BY;
  window_days: number;
  subjects: Array<{ outcome_id: string; opportunity_id: string }>;
}

export function stageFor(opportunityId: string, date: string, now: Date): OutcomeStage | null {
  const id = outcomeId(opportunityId);
  if (!id) return null;
  return {
    v: 1,
    action: OUTCOME_ASK_ACTION,
    date,
    staged_at: now.toISOString(),
    asked_by: ASKED_BY,
    window_days: WINDOW_DAYS,
    subjects: [{ outcome_id: id, opportunity_id: opportunityId }],
  };
}

/** Write the stage file by temp file and rename (0600, its directory 0700): a reader never sees half of it. */
export function writeStage(home: string, stage: OutcomeStage): void {
  const path = stagePath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(stage)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Remove a stage file left by an earlier run. Never throws. */
export function clearStage(home: string): void {
  try {
    rmSync(stagePath(home), { force: true });
  } catch {
    // best effort: the plugin ignores a stage older than its 15-minute limit anyway
  }
}

/** Accepted connections as Index lists them now. Throws when Index cannot be read. */
export async function listAcceptedConnections(): Promise<BriefOpportunity[]> {
  const apiKey = resolveIndexApiKey();
  if (!apiKey) throw new Error("no-api-key");
  const text = await callIndexTool({ apiKey, mcpUrl: indexMcpUrl() }, "list_opportunities", { statuses: ["accepted"], limit: PENDING_LIST_LIMIT });
  return parseListedOpportunitiesCounted(text).cards.filter((card) => card.status === "accepted");
}
