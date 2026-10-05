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
 * up to MAX_ATTEMPTS (two) evenings. When the plugin would not record (blank AV_EVENTS_TOKEN,
 * AV_EVENTS_ENABLED off, outcome_ask or post_llm_call disabled) or its asked ledger is unreadable,
 * nothing could record an ask, and the evening asks nobody
 * (proactive.ts outcomePluginOff, readAskedIds).
 *
 * M2b: a version 2 stage's subject also names the intention the connection
 * belongs to (`intention_id`), or null with a reason (`intention_reason`),
 * and the plugin carries it onto `outcome.asked` and `outcome.reported`
 * unchanged (`intentionLink`; docs/design/outcome-ask.md §8). The plugin
 * reads version 2 from this release on, but the trigger still WRITES version
 * 1, byte for byte as before (STAGE_FORMAT_V2 is off): until every tenant's
 * plugin reads version 2, a version 2 stage met by the plugin from before is
 * refused after the question has gone out, and the resident is asked again.
 */

import { createHash } from "node:crypto";
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
/**
 * Evenings a subject may be staged without the plugin confirming the ask;
 * then it is no longer due. Two: a plugin that is degraded, not loaded, or in
 * a degraded cron session is invisible to the trigger, and each unconfirmed
 * evening asks the resident the same question again.
 */
export const MAX_ATTEMPTS = 2;
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

/**
 * The question key, as plugins/av-events/outcome_question.json `key` defines
 * it (and the plugin's `question_key` computes it): these spaces as plain
 * spaces; every character of KEY_REMOVE deleted; ASCII whitespace runs as one
 * space; stripped; one final full stop off; lower-cased. The bun test checks
 * both constants and every case of that file against this function.
 */
export const QUESTION_SPACES = ["\u00a0", "\u2007", "\u202f"];
export const KEY_REMOVE = "*_`~";

export function questionKey(sentence: string): string {
  let text = sentence;
  for (const space of QUESTION_SPACES) text = text.split(space).join(" ");
  text = Array.from(text).filter((ch) => !KEY_REMOVE.includes(ch)).join("");
  text = text.replace(/[ \t\n\r\f\v]+/g, " ").replace(/^ +| +$/g, "");
  if (text.endsWith(".")) text = text.slice(0, -1);
  return text.toLowerCase();
}

/** The plain SHA-256 (hex) of the question key: the stage's `question_sha256`, a hash and never the text. */
export function questionSha256(sentence: string): string {
  return createHash("sha256").update(questionKey(sentence), "utf8").digest("hex");
}

/**
 * Why an ask names no intention (the closed vocabulary, the plugin's
 * INTENTION_REASONS): `not_linked` (no intention known for the connection),
 * `ambiguous` (several, and not the one it was matched on), or
 * `not_recorded` (the stage carried no intention information at all: a
 * version 1 stage, which is every stage while STAGE_FORMAT_V2 is off). Only
 * the plugin sets `not_recorded`; a version 2 stage carries one of the first
 * two, and `stageFor` never writes the third.
 */
export type IntentionReason = "not_linked" | "ambiguous" | "not_recorded";

/** The stage subject's intention: an id with a null reason, or a null id with a reason. Never both, never a guess. */
export interface IntentionLink {
  intention_id: string | null;
  intention_reason: IntentionReason | null;
}

export const NOT_LINKED: IntentionLink = Object.freeze({ intention_id: null, intention_reason: "not_linked" });
const AMBIGUOUS: IntentionLink = Object.freeze({ intention_id: null, intention_reason: "ambiguous" });

/**
 * An envelope id (agentvillage-data `src/envelope.ts` ID_PATTERN; the plugin's
 * `_ID`): an Index intent id is a uuid. Nothing with a space fits, so no
 * intention's wording can ride in this field.
 */
const INTENTION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The intention an ask is about, from the resident's own intent ids Index
 * says the connection was matched on (`BriefOpportunity.matchedIntentIds`):
 *
 * - none (or no list): `not_linked`;
 * - exactly one distinct id, and a valid one: that id;
 * - more than one distinct entry: `ambiguous`. One outcome belongs to one
 *   intention on the data side, and an envelope carries one `intention_id`,
 *   so several cannot all be named, and picking one would be a guess. When
 *   Index says which one the match was made on, the parser lists that one
 *   alone;
 * - a single entry that is not an id: `not_linked`.
 *
 * No heuristic (the most recent intention, text similarity) ever fills it: a
 * wrong credit is worse than none.
 */
export function intentionLink(matched: readonly unknown[] | undefined): IntentionLink {
  if (!Array.isArray(matched) || matched.length === 0) return NOT_LINKED;
  const distinct = new Set(matched);
  if (distinct.size > 1) return AMBIGUOUS;
  const [only] = distinct;
  return typeof only === "string" && INTENTION_ID.test(only) ? { intention_id: only, intention_reason: null } : NOT_LINKED;
}

/** A link exactly as `intentionLink` makes it, else NOT_LINKED (never `not_recorded`, which only the plugin sets). */
function checkedLink(link: IntentionLink): IntentionLink {
  if (link.intention_id === null) return link.intention_reason === "ambiguous" ? AMBIGUOUS : NOT_LINKED;
  return typeof link.intention_id === "string" && INTENTION_ID.test(link.intention_id) && link.intention_reason === null
    ? { intention_id: link.intention_id, intention_reason: null }
    : NOT_LINKED;
}

/**
 * Whether the trigger writes the version 2 stage (the subject names its
 * intention). OFF: the trigger writes version 1, the exact bytes the trigger
 * from before M2b wrote (tests/fixtures/outcome-stage-v1-origin-main.json),
 * and the link `intentionLink` computes is not written anywhere.
 *
 * Why off. During a roll the installer copies skills and plugins first and
 * restarts the gateway last (install/install.ts), so for a while a new
 * trigger runs beside the plugin from before, still in memory; and a
 * roll-back puts that plugin back. That plugin refuses a version 2 stage
 * (`stage_refused`) after the question has gone out: no `outcome.asked`,
 * nothing recorded as asked, and the resident gets the same question the
 * next evening. Nothing can set a link yet either (no parser sets
 * `BriefOpportunity.matchedIntentIds`), so a version 2 stage would carry
 * only `not_linked` and buy nothing.
 *
 * Turn it on only when BOTH hold:
 * 1. one full release has passed since every tenant runs a plugin that reads
 *    version 2 (the M2b reader, `_outcome_ask.py`), so neither a skewed roll
 *    nor a roll-back can meet a version 2 stage with an older plugin; and
 * 2. something can actually set a link: a parser sets `matchedIntentIds` from
 *    a field Index documents as the viewer's matched intent(s), and the data
 *    side has settled how it reads a plugin-observed intention link
 *    (docs/design/outcome-ask.md §8).
 * Tests turn it on through `stageFor`'s `formatV2` option (proactive.ts
 * `ProactiveOptions.stageFormatV2`), never by editing this constant.
 */
export const STAGE_FORMAT_V2 = false;

/** The stage versions: 1 (no intention, what the trigger writes while STAGE_FORMAT_V2 is off) and 2 (M2b). */
export const STAGE_VERSION_V1 = 1;
export const STAGE_VERSION_V2 = 2;

interface StageCommon {
  action: typeof OUTCOME_ASK_ACTION;
  date: string;
  staged_at: string;
  asked_by: typeof ASKED_BY;
  window_days: number;
  /** The SHA-256 of the key of the exact question shown to the model: the plugin arms only on a reply with this key. */
  question_sha256: string;
}

/** Version 1: exactly the stage from before M2b, subjects with no intention keys. */
export interface OutcomeStageV1 extends StageCommon {
  v: typeof STAGE_VERSION_V1;
  subjects: Array<{ outcome_id: string; opportunity_id: string }>;
}

/** Version 2 (M2b, written only with STAGE_FORMAT_V2 on): each subject names its intention or why not. */
export interface OutcomeStageV2 extends StageCommon {
  v: typeof STAGE_VERSION_V2;
  subjects: Array<{ outcome_id: string; opportunity_id: string } & IntentionLink>;
}

export type OutcomeStage = OutcomeStageV1 | OutcomeStageV2;

export interface StageOptions {
  /** Write version 2 (default STAGE_FORMAT_V2). A seam for tests. */
  formatV2?: boolean;
}

/**
 * The stage for one ask. With STAGE_FORMAT_V2 off (the default) it is the
 * version 1 stage, key for key and in the same order as the trigger from
 * before M2b, and `link` is ignored; with `formatV2` it is version 2 and the
 * subject carries `link` (only of `intentionLink`'s shape).
 */
export function stageFor(
  opportunityId: string,
  date: string,
  now: Date,
  question: string,
  link: IntentionLink = NOT_LINKED,
  options: StageOptions = {},
): OutcomeStage | null {
  const id = outcomeId(opportunityId);
  if (!id) return null;
  if (!(options.formatV2 ?? STAGE_FORMAT_V2)) {
    // Key order is part of the contract: the bytes match the fixture from before M2b.
    return {
      v: STAGE_VERSION_V1,
      action: OUTCOME_ASK_ACTION,
      date,
      staged_at: now.toISOString(),
      asked_by: ASKED_BY,
      window_days: WINDOW_DAYS,
      question_sha256: questionSha256(question),
      subjects: [{ outcome_id: id, opportunity_id: opportunityId }],
    };
  }
  return {
    v: STAGE_VERSION_V2,
    action: OUTCOME_ASK_ACTION,
    date,
    staged_at: now.toISOString(),
    asked_by: ASKED_BY,
    window_days: WINDOW_DAYS,
    question_sha256: questionSha256(question),
    subjects: [{ outcome_id: id, opportunity_id: opportunityId, ...checkedLink(link) }],
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
