#!/usr/bin/env bun
/**
 * The trigger of every proactive job (DATA-314 brief-lite). Hermes runs it as
 * the cron job's pre-run script, through a no-argument shim in
 * `$HERMES_HOME/scripts/` (`agentvillage_proactive_<action>.sh`):
 *
 *   bun skills/index-network/scripts/proactive.ts <action>
 *
 *   prefetch       02:00, the one no_agent job: builds the brief's context
 *                  into av-events/proactive/brief-context.json. Always silent.
 *   brief          08:00: the morning brief's facts; the model writes it.
 *   drop-midday    12:00 / 17:00: one person waiting to hear from the resident.
 *   drop-evening
 *   negotiation    14:00: the people follow-up.
 *   evening        19:00: the outcome ask about one accepted connection the
 *                  follow-up announced two or more days ago (outcome-ask.ts),
 *                  else one pending conversation, or the last-day closeout.
 *   pending        hourly at :20 (DATA-430): one line per opportunity that
 *                  newly turned pending for the resident (pending-alert.ts).
 *                  No once-a-day mark: the per-card ledger is the gate.
 *   tpl-brief      J2: a job added from a template for one tenant
 *   tpl-digest-preview  (`install/jobs.ts add`): the brief's, the drop's and
 *   tpl-evening-ask     the evening's content path, each with its own day
 *                  mark. The evening template never stages the outcome ask
 *                  (the av-events plugin arms it for the installer's evening
 *                  job only), so it goes straight to the evening's reminder.
 *
 * J2 per-job settings (job-settings.ts, docs/design/job-settings.md): each
 * agent job's delivery window and zone come from `av-events/job-settings.json`
 * when it has an entry, else from the defaults (the brief: 05:00 to 11:00
 * Asia/Kolkata; the pending alert: 08:00 to 22:00; every other job: no
 * window), which is rc13's behaviour for the rc13 jobs. A
 * run outside its window is silent (`outside-window`); a job whose entry is
 * invalid falls back to its default window, or, with none, is silent
 * (`settings-invalid`). The once-a-day mark stays on the village date, so a
 * settings change during the day never brings a second send.
 *
 * `<action> --preview` (the shim's `preview-<action>` name): a team tenant's
 * test run of the content path, now. Refused (`preview-refused`) unless
 * `AV_TEAM_TENANT=1`. It ignores the window and the day mark and writes
 * neither: it never takes the state lock, it runs against a private copy of
 * the state file that is deleted afterwards, and it stages no outcome ask.
 *
 * The script does every deterministic step, so the model only writes language
 * from the Script Output and never needs a tool:
 *   - the brief's delivery window, 05:00 to 11:00 IST (outside it: silent);
 *   - once per day per job: the day is marked done when the trigger wakes the
 *     model (a run that then fails loses that day; no delivery tracking);
 *     the hourly pending alert has no day mark (DAY_MARK_EXEMPT);
 *   - an exclusive lock around memory/heartbeat-state.json (state-lock.ts); a
 *     state file whose content is not a JSON object is renamed aside and the
 *     run starts from empty; one that cannot be read at all is left alone and
 *     the run is silent (`state-unreadable`);
 *   - the picks and their reservations (the existing pick scripts);
 *   - what the model is given: dates, the resident's own data, sanitised
 *     schedule facts, organiser announcements, Index counts and cleaned names
 *     (proactive-text.ts); an Index link only when it is exactly
 *     `https://index.network/<kind>/<id>`, and an event link rebuilt from the
 *     configured portal base and the event id. No
 *     third-party free text: no summary or description written by or about
 *     another person. One exception (INDEX-COMMS A, Carter's ruling of
 *     12 Oct 2026): a card's Index `headline` (a short label) as
 *     `match.headline`, beside the resident's own intent text for the card
 *     as `you.intent` (matchFacts), each withheld whole unless it is shaped
 *     like a short topic label (cleanMatchField: a closed allow-shape checked
 *     on the string that is sent, OV-301 fix round 2);
 *     Index's `summary` never. Every string is
 *     cleaned and scanned with the mirror of Hermes's cron prompt scanner
 *     and withheld on a hit.
 *
 * Output: the Script Output JSON (no backtick, no raw `<` or `>`), then the
 * wake line as the LAST line: `{"wakeAgent": true}`, or `{"wakeAgent": false,
 * "reason": "<code>"}`. An agent-job trigger always exits 0 (a failed pre-run
 * script makes Hermes ask the model to report the failure to the resident).
 * The prefetch exits 1 on a fault; Hermes then notifies its failure target,
 * which is local. Logs carry codes and counts only: stderr, and one line per
 * run in av-events/proactive/triggers.jsonl.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

import { approvalsWaiting } from "./approvals-waiting";
import { askQuestions } from "./ask-questions";
import { acceptLink, type BriefOpportunity, type DailyBriefContext, buildDailyBriefContext, villageDate } from "./build-daily-brief-context";
import { contextInterests, contextPreferences, readContextTags } from "./context-tags";
import { OPPORTUNITY_DELIVERY_KEY, deliveryLogChanged, pruneDeliveryLog, readDeliveryLog, recordShowings } from "./delivery-state";
import { dropOpportunity } from "./drop-opportunity";
import { type DueCard, pendingAlert, respondByText } from "./pending-alert";
import { type MatchFieldReason, type MatchFieldStage, cleanMatchField, cleanName, cleanText, cleanTitle, connectionsUrl, cronScanHit, envOrDotenv, matchFieldVerdict } from "./proactive-text";
import { type LockOptions, LockStuck, LockTimeout, releaseHeldLocks, withStateLock } from "./state-lock";
import { writeStateFile } from "./state-file";
import { followUp } from "./summarize-negotiations";
import { backfillAnnounced, clearStage, dueSubjects, intentionLink, listAcceptedConnections, outcomeQuestion, readAskedIds, recordAttempt, stageFor, writeStage } from "./outcome-ask";
import { type Delivery, deliveryFor, inWindow, isTeamTenant, minuteOfDay, prunePreviewFiles, readJobSettings } from "./job-settings";
import { DEFAULT_NAME, agentName, readProfile } from "../../agent-profile/scripts/profile";

/** OV-301 fix rounds 1 and 2: what a match field may hold (proactive-text.ts). */
export { MATCH_FIELD_LATIN_KEPT, MATCH_FIELD_LATIN_RANGES, MATCH_FIELD_MAX_LENGTH, MATCH_FIELD_MAX_WORDS, MATCH_FIELD_SCRIPTS, MATCH_FIELD_STOP_PHRASES, MATCH_FIELD_STOP_WORDS } from "./proactive-text";

/** The default jobs' actions, one per installer job (install_index.ts DIGEST_CRON_SPECS). */
export const ACTIONS = ["prefetch", "brief", "drop-midday", "drop-evening", "negotiation", "evening", "pending"] as const;
/** The template jobs' actions (J2), `tpl-<template>`: a job only a template add creates. */
export const TEMPLATE_ACTIONS = ["tpl-brief", "tpl-digest-preview", "tpl-evening-ask"] as const;
export type ProactiveAction = (typeof ACTIONS)[number] | (typeof TEMPLATE_ACTIONS)[number];
export type AgentAction = Exclude<ProactiveAction, "prefetch">;

export function isProactiveAction(value: unknown): value is ProactiveAction {
  return typeof value === "string" && ((ACTIONS as readonly string[]).includes(value) || (TEMPLATE_ACTIONS as readonly string[]).includes(value));
}

/** The state key this trigger adds: `proactiveRuns.<action>` = the village date it last woke the model. */
export const RUNS_KEY = "proactiveRuns";
/** The trigger stops itself (silently) after this; Hermes's own script timeout is the backstop. */
export const HARD_DEADLINE_MS = 100_000;
const PREFETCH_FILE = "brief-context.json";
const LOG_MAX_BYTES = 512 * 1024;
/** Most items of each list handed to the model. */
const LIST_MAX = 6;

export interface ProactiveOptions {
  /** `$HERMES_HOME`; defaults to the environment, then the working directory. */
  home?: string;
  now?: () => Date;
  lock?: LockOptions;
  /** Seams for tests; production uses the real functions. */
  buildContext?: typeof buildDailyBriefContext;
  drop?: typeof dropOpportunity;
  /** The pending alert's pick (pending-alert.ts). */
  pending?: typeof pendingAlert;
  evening?: typeof askQuestions;
  followUp?: typeof followUp;
  approvals?: (home: string) => number;
  /** The evening outcome ask's read of accepted connections. */
  accepted?: () => Promise<BriefOpportunity[]>;
  /** A team tenant's test run (`--preview`): no window, no day mark, no state written. */
  preview?: boolean;
  /** Tests only: write the version 2 outcome-ask stage (outcome-ask.ts STAGE_FORMAT_V2, off in production). */
  stageFormatV2?: boolean;
}

export interface TriggerResult {
  /** Lines for stdout; the last is the wake line. */
  lines: string[];
  exitCode: number;
  woke: boolean;
  reason: string;
  /** Strings withheld because they did not clean or would trip Hermes's scanner. */
  withheld?: number;
  /** DATA-487: headline flags handed to the av-events plugin (writeHeadlineFlags). */
  flagged?: number;
  /** DATA-487: headline flags not handed over, and why (`flag_dropped`, `flag_dropped_reason` in the run log). */
  flagDropped?: number;
  flagDroppedReason?: FlagDropReason;
  /** DATA-487: flagged headlines whose card had no Index opportunity id or counterpart user id: counted, never emitted. */
  flagUnattributed?: number;
  /** A code for something the run repaired on its way (STATE_HEALED). */
  note?: string;
  /** A code for which path an action took (the evening's outcome ask, or why it fell back). */
  detail?: string;
  /** Which settings the run used (Delivery.settings); absent when there is no settings file. */
  settings?: string;
  /** The run was a preview. */
  preview?: boolean;
}

/** The run renamed an unreadable state file aside and continued from an empty state. */
export const STATE_HEALED = "state-renamed-aside";

// ── Paths, state and logs ───────────────────────────────────────────────────

/**
 * P1 (S5): the agent's name for a proactive message, `agentName` in every agent job's Script
 * Output: the resident's nickname from `$HERMES_HOME/av-profile.json`, read through the
 * agent-profile skill's own reader (the control plane's whole nickname rule, applied again), else
 * Edge. A nickname that would trip the cron scanner is Edge too (it would otherwise silence the
 * whole message). Only the name from that file: the resident's about me and its tone, brevity and
 * language are not given to these jobs (P1 left them to a follow-up). The morning brief also gets
 * the interests they stated (statedInterestsFor, DATA-372, else contextInterestsFor), and every
 * job that writes to them about a person, and the brief, gets the Preferences they stated on their
 * Context page (preferencesFor). Never throws; a missing or bad file is Edge (one stderr line for
 * a bad one).
 */
export function agentNameFor(home: string): string {
  try {
    const name = agentName(readProfile(home));
    return cronScanHit(name) ? DEFAULT_NAME : name;
  } catch {
    return DEFAULT_NAME;
  }
}

/**
 * DATA-372: the interests the resident stated in `$HERMES_HOME/av-profile.json`, read through the
 * same reader (its interest rule applied: at most 12, each at most 40 code points, no control
 * character; a list that breaks it is dropped whole), for the morning brief's `you.interests`.
 * Empty when there is no file, the file is ignored or the list is empty or dropped: the brief then
 * names no interest, and tags extracted from the memory files only pick events and notes. Silent (an agent job's agentNameFor logs a
 * bad file once per run; the prefetch logs nothing); never throws.
 */
export function statedInterestsFor(home: string): string[] {
  try {
    const result = readProfile(home, () => {});
    return result.status === "ok" ? result.profile.interests : [];
  } catch {
    return [];
  }
}

/**
 * The brief's interests when av-profile.json states none: the stated items of the Context tags
 * entry in `$HERMES_HOME/memories/USER.md` (context-tags.ts contextInterests: Here to, Curious
 * about, Working on, Wants to meet; never a guess or a removed item). Empty without the entry, and
 * the brief then behaves as before. Never throws.
 */
export function contextInterestsFor(home: string): string[] {
  return contextInterests(readContextTags(home));
}

/**
 * How the resident asked to be talked to: the stated items of the Context tags' Preferences
 * (context-tags.ts contextPreferences), raw; withPreferences and briefView clean them. Empty
 * without the entry. Never throws.
 */
export function preferencesFor(home: string): string[] {
  return contextPreferences(readContextTags(home));
}

/** The Script Output of an agent job: the agent's name first, then the job's own view. */
export function withAgentName(home: string, view: Record<string, unknown>): Record<string, unknown> {
  return { agentName: agentNameFor(home), ...view };
}

export function homeDir(options: ProactiveOptions = {}): string {
  return options.home ?? (process.env.HERMES_HOME?.trim() || process.cwd());
}

export function proactiveDir(home: string): string {
  return join(home, "av-events", "proactive");
}

export function stateFilePath(home: string): string {
  return join(home, "memory", "heartbeat-state.json");
}

/** A larger state file is corrupt: it is renamed aside (readStateHealing), never read as empty and written over. */
export const MAX_STATE_BYTES = 5 * 1024 * 1024;

/** The state file could not be read (EACCES, EIO, a directory, ...): the run is silent and the file is left alone. */
export class StateUnreadable extends Error {
  constructor() {
    super("state-unreadable");
    this.name = "StateUnreadable";
  }
}

/** The state file was read, but its content is not a JSON object, or it is over MAX_STATE_BYTES: it may be renamed aside. */
export class StateCorrupt extends Error {
  constructor() {
    super("state-corrupt");
    this.name = "StateCorrupt";
  }
}

/**
 * memory/heartbeat-state.json as an object. Missing or empty: an empty state
 * (a first run). Read, but not a JSON object (bad JSON, `[]`, `null`) or over
 * MAX_STATE_BYTES: StateCorrupt. Not readable at all (any other read error):
 * StateUnreadable. Nothing is written over it either way. One short retry
 * first, because the memory signal sync's model writes this file without the
 * lock.
 */
export function readState(path: string): Record<string, unknown> {
  let failure: StateUnreadable | StateCorrupt = new StateUnreadable();
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) Bun.sleepSync(150);
    let text: string;
    try {
      if (!existsSync(path)) return {};
      const size = statSync(path).size;
      if (size > MAX_STATE_BYTES) throw new StateCorrupt();
      if (size === 0) return {};
      text = readFileSync(path, "utf8");
    } catch (err) {
      if (err instanceof StateCorrupt) throw err;
      failure = new StateUnreadable();
      continue;
    }
    try {
      const raw = JSON.parse(text) as unknown;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
    } catch {
      // not JSON: corrupt, below
    }
    failure = new StateCorrupt();
  }
  throw failure;
}

/** Unreadable state files kept beside the state file after being renamed aside; older ones are deleted. */
export const CORRUPT_KEEP = 3;

/** `heartbeat-state.json.corrupt-<UTC stamp>`, the stamp sortable (`20261012T023000123Z`). */
export function corruptStatePath(path: string, at: Date): string {
  return `${path}.corrupt-${at.toISOString().replace(/[-:]/g, "").replace(".", "")}`;
}

/**
 * readState that heals: a state file that was read but is not a JSON object
 * (bad JSON, `[]`, `null`) or is over MAX_STATE_BYTES (StateCorrupt) is
 * renamed aside as corruptStatePath (the newest CORRUPT_KEEP such files are
 * kept), and the run continues from an empty state, as the pick scripts on
 * main did. Call it holding the lock. A file that could not be read at all
 * (StateUnreadable: a permission or I/O error) is left alone and the error
 * propagates (B1-fix2 R7), as does a corrupt file that cannot be renamed.
 */
export function readStateHealing(path: string, at: Date): { state: Record<string, unknown>; healed: boolean } {
  try {
    return { state: readState(path), healed: false };
  } catch (err) {
    if (!(err instanceof StateCorrupt)) throw err;
  }
  try {
    renameSync(path, corruptStatePath(path, at));
  } catch {
    throw new StateUnreadable();
  }
  pruneCorruptStates(path);
  return { state: {}, healed: true };
}

function pruneCorruptStates(path: string): void {
  try {
    const prefix = `${basename(path)}.corrupt-`;
    const old = readdirSync(dirname(path))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .reverse()
      .slice(CORRUPT_KEEP);
    for (const name of old) rmSync(join(dirname(path), name), { recursive: true, force: true });
  } catch {
    // best effort: a leftover copy is harmless
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** `YYYY-MM-DD` as a real calendar date (UTC midnight), or null. */
function calendarDate(text: unknown): Date | null {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const day = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === text ? day : null;
}

/**
 * Whether `action` already woke the model on `date`: a stored mark counts as
 * done only when it is a real calendar date equal to `date` or the day after
 * it, so a clock that moved back by up to a day cannot deliver twice (B1-fix
 * F10), and a mark further ahead (a wrong clock, `9999-99-99`) never silences
 * the job: it is ignored and overwritten at the next wake (B1-fix2 R2).
 */
export function doneToday(state: Record<string, unknown>, action: AgentAction, date: string): boolean {
  const mark = calendarDate(asRecord(state[RUNS_KEY])[action]);
  const today = calendarDate(date);
  if (!mark || !today) return false;
  const daysAhead = (mark.getTime() - today.getTime()) / 86_400_000;
  return daysAhead === 0 || daysAhead === 1;
}

export function markDone(state: Record<string, unknown>, action: AgentAction, date: string): Record<string, unknown> {
  return { ...state, [RUNS_KEY]: { ...asRecord(state[RUNS_KEY]), [action]: date } };
}

/** Append one decision (codes and counts only) to triggers.jsonl. Never throws. */
export function appendRunLog(home: string, record: Record<string, unknown>): void {
  try {
    const dir = proactiveDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, "triggers.jsonl");
    try {
      if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // no file yet
    }
    appendFileSync(path, `${JSON.stringify({ v: 1, ts: new Date().toISOString(), source: "trigger", ...record })}\n`, { mode: 0o600 });
  } catch {
    // the log is best effort
  }
}

// ── Wake lines and the Script Output ────────────────────────────────────────

/** A reason code as it may appear in a wake line or a log: `[A-Za-z0-9:_-]`, at most 64 characters. */
export function reasonCode(reason: string | undefined): string {
  return String(reason ?? "silent").replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 64) || "silent";
}

export function wakeLine(woke: boolean, reason?: string): string {
  return woke ? JSON.stringify({ wakeAgent: true }) : JSON.stringify({ wakeAgent: false, reason: reasonCode(reason) });
}

function silent(reason: string, exitCode = 0, withheld?: number): TriggerResult {
  return { lines: [wakeLine(false, reason)], exitCode, woke: false, reason, ...(withheld ? { withheld } : {}) };
}

/**
 * The Script Output as JSON. Hermes puts it inside a triple-backtick fence,
 * so the backtick is escaped, as are `<`, `>`, and every line break
 * Python's splitlines splits on that JSON.stringify leaves raw (U+0085 and
 * the Unicode line and paragraph separators; it escapes the C0 controls
 * itself): no string can make a line of its own, close the fence, or be the
 * last line.
 */
export function scriptOutputText(view: Record<string, unknown>): string {
  return JSON.stringify(view, null, 2)
    .replace(/\u0085/g, "\\u0085")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/`/g, "\\u0060");
}

/** A short code for an unexpected error: its class name, never its message. */
export function errorCode(err: unknown): string {
  const name = err instanceof Error ? err.name : typeof err;
  return `fault:${String(name).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "unknown"}`;
}

// ── What the model is given ─────────────────────────────────────────────────

/** An Index page link of one kind (`/u/` person, `/o/` conversation, `/i/` signal), or null. */
export function indexUrl(kind: "u" | "o" | "i", url: unknown): string | null {
  return typeof url === "string" && new RegExp(`^https://index\\.network/${kind}/[A-Za-z0-9_-]{1,128}$`).test(url) ? url : null;
}

/** Portal forms of Index links. Cron Script Output never passes through the index-links plugin. */
const PORTAL_WEB = "https://agents.edgecity.live";
/** The Agent Village front page: the morning brief's one `villageLink`, near its end. */
export const VILLAGE_LINK = PORTAL_WEB;
const lastSegment = (url: string) => url.slice(url.lastIndexOf("/") + 1);
const profileLink = (url: unknown) => { const u = indexUrl("u", url); return u && `${PORTAL_WEB}/rolodex?person=${lastSegment(u)}`; };
const signalLink = (url: unknown) => { const u = indexUrl("i", url); return u && `${PORTAL_WEB}/intents?intent=${lastSegment(u)}`; };
/**
 * INTRO-TELEGRAM: the message link for a card Index minted a signed accept link for is the app's
 * `<portal>/intro/<id>`, never Index's link: there one tap (signed in) accepts and, once both people
 * have accepted, opens Telegram with the other person. Index's signature never reaches the chat.
 */
export const introLink = (url: unknown): string | null => {
  const a = acceptLink(url);
  const id = a?.match(/^https:\/\/[^/]+\/o\/([A-Za-z0-9_-]{1,128})\?/)?.[1];
  return id ? `${PORTAL_WEB}/intro/${encodeURIComponent(id)}` : null;
};
const messageLink = introLink;
/**
 * DATA-430: the app's deep link to one pending card, `<portal>/intents?opportunity=<id>#opportunity-<id>`
 * (the app half's literal: the Intents page scrolls to that card; an unknown id shows the page). The id
 * is encoded once in each place (a valid id encodes to itself).
 */
export const appOpportunityLink = (id: unknown): string | null => {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) return null;
  const encoded = encodeURIComponent(id);
  return `${PORTAL_WEB}/intents?opportunity=${encoded}#opportunity-${encoded}`;
};

/** Counts strings that did not survive cleaning, so the run log can say how many were withheld. */
class Withheld {
  count = 0;
  name(raw: unknown): string | null {
    const name = cleanName(raw);
    if (!name) this.count++;
    return name;
  }
  text(raw: unknown, max: number): string | null {
    return this.counted(raw, cleanText(raw, max));
  }
  /** Text a non-organiser can write or that is read back from a store (event titles, venues, notes, signals): the stricter cleaner (F6). */
  title(raw: unknown, max: number): string | null {
    return this.counted(raw, cleanTitle(raw, max));
  }
  /**
   * INDEX-COMMS A: one fact about a match (Index's headline, the resident's own intent), cut at a
   * word to `max`, or withheld whole (cleanMatchField, OV-301 fix round 2): the scanner on the raw
   * text; NFKC, quotes and invisible characters out; then a closed allow-shape (every word letters
   * of one allowed script, digits and `' - & /`; at most 6 words), the strong-signal word list and
   * the scanner, on the whole text and again on the string that is sent. A withheld field is an
   * absent key and one more on the withheld count; nothing of its text is logged.
   */
  matchField(raw: unknown, max: number): string | null {
    return this.counted(raw, cleanMatchField(raw, max));
  }
  /**
   * Detection (DATA-487, Carter's ruling of 12 Oct 2026 18:25Z): Index's headline for a card, as
   * matchField, plus one HeadlineFlag when it was withheld or flagged: the card's Index
   * opportunity id, the counterpart's Index user id, a reason code, the gate and the raw length.
   * Never any text. A flagged card without both ids is counted in `unattributed`, never guessed.
   */
  matchHeadline(raw: unknown, max: number, ids: CardIds): string | null {
    const verdict = matchFieldVerdict(raw, max);
    if (verdict.flag) {
      const opportunityId = indexIdOf(ids.opportunityId, ids.opportunityUrl, "o");
      const counterpartId = indexIdOf(ids.userId, ids.userUrl, "u");
      if (opportunityId && counterpartId) {
        this.flags.push({
          opportunity_id: opportunityId,
          counterpart_index_user_id: counterpartId,
          reason_code: verdict.flag.reason,
          stage: verdict.flag.stage,
          headline_length: Math.min(typeof raw === "string" ? [...raw].length : 0, HEADLINE_LENGTH_MAX),
        });
      } else {
        this.unattributed++;
      }
    }
    return this.counted(raw, verdict.text);
  }
  /** DATA-487: one per withheld or flagged `match.headline` (matchHeadline). */
  flags: HeadlineFlag[] = [];
  /** DATA-487: flagged headlines whose card had no Index opportunity id or counterpart user id. */
  unattributed = 0;
  /** The detection keys a view result carries: none when nothing was flagged. */
  flagged(): { flags?: HeadlineFlag[]; flagUnattributed?: number } {
    return { ...(this.flags.length ? { flags: this.flags } : {}), ...(this.unattributed ? { flagUnattributed: this.unattributed } : {}) };
  }
  private counted(raw: unknown, text: string | null): string | null {
    if (raw !== undefined && raw !== null && raw !== "" && !text) this.count++;
    return text;
  }
}

/**
 * DATA-487 `opportunity.headline_flagged@1`'s payload, closed: every key required, ids and codes
 * only, no text of any kind. The script hands it to the av-events plugin (writeHeadlineFlags);
 * the plugin emits it (plugins/av-events/_headline_flagged.py).
 */
export interface HeadlineFlag {
  /** The Index opportunity id of the card (a UUID, either case). */
  opportunity_id: string;
  /** The card's other party's Index user id: the id behind `https://index.network/u/<userId>` (`peer.userId`). */
  counterpart_index_user_id: string;
  reason_code: MatchFieldReason;
  stage: MatchFieldStage;
  /** The raw headline's length in code points, capped at HEADLINE_LENGTH_MAX. */
  headline_length: number;
}
/** `headline_length`'s cap (DATA-487: an int 0..2000). */
export const HEADLINE_LENGTH_MAX = 2000;
/**
 * The ids the event may carry (commit review flag 1: the same shapes the plugin checks,
 * plugins/av-events/_headline_flagged.py): an Index opportunity id and an Index user id, each a
 * UUID, either case (USER_ID, as attachIndexLinks keeps it). DATA-487 (data, 13 Oct): data's door
 * admits a UUID opportunity id only, so a card whose opportunity id is not one is counted as
 * `flag_unattributed` and never handed off.
 */
export const FLAG_OPPORTUNITY_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const FLAG_USER_ID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const INDEX_PAGE = { o: /^https:\/\/index\.network\/o\/([^/?#]+)$/, u: /^https:\/\/index\.network\/u\/([^/?#]+)$/ } as const;

/** The ids a card carries for the detection event: the ids themselves, else the Index pages attachIndexLinks built from them. */
export interface CardIds {
  opportunityId?: unknown;
  opportunityUrl?: unknown;
  userId?: unknown;
  userUrl?: unknown;
}

/** An Index id of its shape from the id field, else from its Index page link (`https://index.network/<kind>/<id>`); null when neither holds one. */
function indexIdOf(id: unknown, url: unknown, kind: "o" | "u"): string | null {
  const shape = kind === "o" ? FLAG_OPPORTUNITY_ID : FLAG_USER_ID;
  if (typeof id === "string" && shape.test(id)) return id;
  const fromPage = typeof url === "string" ? url.match(INDEX_PAGE[kind])?.[1] : undefined;
  return fromPage && shape.test(fromPage) ? fromPage : null;
}

export interface PersonView {
  name: string;
  profileUrl: string | null;
  messageUrl: string | null;
}

function person(card: { name?: unknown; userUrl?: unknown; acceptUrl?: unknown }, w: Withheld): PersonView | null {
  const name = w.name(card.name);
  return name ? { name, profileUrl: profileLink(card.userUrl), messageUrl: messageLink(card.acceptUrl) } : null;
}

/** INDEX-COMMS A: most code points of Index's headline for a card in a message. */
export const MATCH_HEADLINE_MAX = 60;
/** INDEX-COMMS A: most code points of the resident's own intent text for a card in a message. */
export const MATCH_INTENT_MAX = 120;

export interface MatchFacts {
  match?: { headline: string };
  you?: { intent: string };
}

/**
 * INDEX-COMMS A (Carter's ruling, 12 Oct 2026): what a message may say the match is about. At
 * most two facts, each present only when it cleans and scans (Withheld.matchField):
 *   - `match.headline`: Index's own `headline` for the card, never the `summary` (nor a fallback
 *     to it: callers pass the row's headline alone);
 *   - `you.intent`: the resident's own intent text for the card (BriefOpportunity.matchedIntentText;
 *     no parser sets it today), only when `intent` is allowed (a community ask is not the
 *     resident's match).
 * Absent facts are absent keys: the prompts then say nothing about them. A withheld, flagged or
 * cut headline adds one HeadlineFlag for the card `ids` name (DATA-487); the intent never does.
 */
function matchFacts(headline: unknown, intent: unknown, w: Withheld, ids: CardIds, { withIntent = true } = {}): MatchFacts {
  const cleanHeadline = w.matchHeadline(headline, MATCH_HEADLINE_MAX, ids);
  const cleanIntent = withIntent ? w.matchField(intent, MATCH_INTENT_MAX) : null;
  return { ...(cleanHeadline ? { match: { headline: cleanHeadline } } : {}), ...(cleanIntent ? { you: { intent: cleanIntent } } : {}) };
}

/**
 * The portal events base the links are rebuilt on: `AV_PORTAL_URL` (process
 * environment, else `$HERMES_HOME/.env`) when it parses as an `https` URL with
 * no user name, password, query or fragment and no character that could break
 * a message; else null (no event links).
 */
export function portalBase(home: string): string | null {
  const raw = envOrDotenv("AV_PORTAL_URL", home).replace(/\/+$/, "");
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !url.hostname) return null;
    const href = url.href.replace(/\/+$/, "");
    return /^https:\/\/[^\s"'`<>()[\]]+$/.test(href) && !cronScanHit(href) ? href : null;
  } catch {
    return null;
  }
}

/**
 * An event's link, rebuilt rather than passed through: the last segment of
 * the fetched link's path must be the whole event id (`[A-Za-z0-9_-]`, at most
 * 128), and the link is the configured portal base and that id. Null when
 * either is missing or malformed.
 */
export function eventLink(url: unknown, base: string | null): string | null {
  if (!base || typeof url !== "string") return null;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const id = path.slice(path.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9_-]{1,128}$/.test(id) ? `${base}/${id}` : null;
}

function eventsView(events: DailyBriefContext["rsvpEvents"] | undefined, w: Withheld, base: string | null): Array<Record<string, string>> {
  return (events ?? []).slice(0, LIST_MAX).flatMap((event) => {
    const title = w.title(event.title, 100);
    if (!title) return [];
    const time = cleanText(event.timeLocal, 20);
    const venue = w.title(event.venue, 60);
    const link = eventLink(event.eventUrl, base);
    return [{ title, ...(time ? { time } : {}), ...(venue ? { venue } : {}), ...(link ? { link } : {}) }];
  });
}

/** The overnight context, for the Index part when today's read of Index failed. */
export function readPrefetch(home: string, date: string): DailyBriefContext | null {
  try {
    const path = join(proactiveDir(home), PREFETCH_FILE);
    if (!existsSync(path) || statSync(path).size > 4 * 1024 * 1024) return null;
    const raw = asRecord(JSON.parse(readFileSync(path, "utf8")));
    const context = asRecord(raw.context);
    return raw.date === date && context.date === date ? (context as unknown as DailyBriefContext) : null;
  } catch {
    return null;
  }
}

/** Today's context, with the overnight Index part when today's read of Index failed. */
export function withPrefetchedIndex(context: DailyBriefContext, prefetched: DailyBriefContext | null): DailyBriefContext {
  if (context.diagnostics.opportunitySource !== "unavailable") return context;
  if (!prefetched || prefetched.diagnostics?.opportunitySource === "unavailable") return context;
  return {
    ...context,
    connectionOpportunities: prefetched.connectionOpportunities ?? [],
    eligibleMatchCount: typeof prefetched.eligibleMatchCount === "number" ? prefetched.eligibleMatchCount : null,
    moreWaitingThanListed: Boolean(prefetched.moreWaitingThanListed),
  };
}

/**
 * The brief's `you.interests` (DATA-372): the interests the resident stated in their profile,
 * exactly (in their order, deduplicated after cleaning), and nothing else; when the profile states
 * none, the items they stated on their Context page (contextInterestsFor), the same way. With none
 * stated in either the list is empty and the brief names no interest (B1): tags extracted from the
 * memory files only pick `forYourInterests` and the notes, never what the brief names. Stated
 * interests are text the resident (or anything with access to the sandbox) wrote, so they take the
 * stricter cleaner, with room for the spaces it adds (the profile reader caps each at 40 code
 * points, the Context tags reader at 60; S2).
 */
export const STATED_INTEREST_MAX = 60;

function interestsView(context: DailyBriefContext, w: Withheld): string[] {
  const stated = context.userModel?.statedInterests ?? [];
  const cleaned = stated.flatMap((interest) => w.title(interest, STATED_INTEREST_MAX) ?? []);
  const seen = new Set<string>();
  return cleaned.filter((interest) => {
    const key = interest.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Most code points of one stated preference handed to the model (the app's own extractor keeps an item to 120). */
export const PREFERENCE_MAX = 120;

/**
 * The resident's stated Preferences (preferencesFor), cleaned for `you.preferences`: their own
 * words, but read from a memory file that anything with access to the sandbox can edit, so the
 * stricter cleaner and the scan, as for the notes; deduplicated after cleaning. Data, never
 * instructions: the prompts use them only for tone, length, timing and what to leave out.
 */
function preferencesList(raw: readonly string[], w: Withheld): string[] {
  const seen = new Set<string>();
  return raw.flatMap((item) => w.title(item, PREFERENCE_MAX) ?? []).filter((item) => {
    const key = item.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * A drop's, the follow-up's or the evening reminder's view with `you.preferences` added, only when
 * the resident stated any that clean: without them the view is exactly what it was.
 */
export function withPreferences(view: Record<string, unknown>, raw: readonly string[]): { view: Record<string, unknown>; withheld: number } {
  const w = new Withheld();
  const preferences = preferencesList(raw, w);
  // INDEX-COMMS A: beside `you.intent` when the view has one, never replacing it.
  const you = view.you && typeof view.you === "object" ? (view.you as Record<string, unknown>) : {};
  return { view: preferences.length ? { ...view, you: { ...you, preferences } } : view, withheld: w.count };
}

/**
 * The morning brief's Script Output. The Index part is a count, at most
 * three cleaned names, and the Connections link; no card text, no person
 * link. `villageLink` is the Agent Village front page, written once near the end. `shownIds` are the cards named, recorded as shown when the model is
 * woken (as the old send recorded the cards of the brief it delivered).
 */
export function briefView(
  context: DailyBriefContext,
  { link, approvals, portal = null, preferences = [] }: { link: string; approvals: number; portal?: string | null; preferences?: readonly string[] },
): { view: Record<string, unknown>; withheld: number; shownIds: string[] } {
  const w = new Withheld();
  const stated = preferencesList(preferences, w);
  const named = (context.connectionOpportunities ?? [])
    .flatMap((card: BriefOpportunity) => {
      const name = w.name(card.name);
      return name ? [{ name, id: card.opportunityId }] : [];
    })
    .slice(0, 3);
  const count = typeof context.eligibleMatchCount === "number" ? context.eligibleMatchCount : null;
  const view: Record<string, unknown> = {
    job: "morning-brief",
    date: context.date,
    displayDate: context.displayDate,
    weather: context.weather ? { forecast: cleanText(context.weather.forecast, 120), emoji: cleanText(context.weather.emoji, 8) } : null,
    announcements: (context.announcements ?? []).slice(0, 5).flatMap((item) => {
      const text = w.text(item.body, 280);
      return text ? [text] : [];
    }),
    schedule: {
      known: context.diagnostics.calendarSource !== "unavailable" || context.diagnostics.rsvpSource !== "unavailable",
      yourRsvps: eventsView(context.rsvpEvents, w, portal),
      highlighted: eventsView(context.highlightedEvents, w, portal),
      forYourInterests: eventsView(context.interestEvents, w, portal),
    },
    you: {
      interests: interestsView(context, w),
      // Read from the agent's memory files, which can hold text that came from someone else: the stricter cleaner.
      notes: (context.userModel?.phrases ?? []).slice(0, 3).flatMap((phrase) => w.title(phrase, 120) ?? []),
      ...(stated.length ? { preferences: stated } : {}),
    },
    connections: {
      newMatchCount: count,
      countIsAtLeast: count !== null && Boolean(context.moreWaitingThanListed),
      names: named.map((entry) => entry.name),
      link,
    },
    approvalsWaiting: Math.max(0, Math.trunc(approvals)) || 0,
    villageLink: VILLAGE_LINK,
  };
  return { view, withheld: w.count, shownIds: named.flatMap((entry) => (entry.id ? [entry.id] : [])) };
}

/** The brief's named cards recorded as shown today: `deliveredToday` and one showing each. */
export function recordBriefShowings(state: Record<string, unknown>, ids: string[], date: string, realToday: string): Record<string, unknown> {
  if (ids.length === 0) return state;
  const next = { ...state };
  const delivered = asRecord(state.deliveredToday);
  const current = delivered.date === date && Array.isArray(delivered.ids) ? delivered.ids.filter((id): id is string => typeof id === "string") : [];
  next.deliveredToday = { date, ids: Array.from(new Set([...current, ...ids])) };
  const log = pruneDeliveryLog(recordShowings(readDeliveryLog(state, date, realToday), ids, date), date, null);
  if (deliveryLogChanged(state, log)) next[OPPORTUNITY_DELIVERY_KEY] = log;
  return next;
}

/** A view and its withheld count; `flags` and `flagUnattributed` only when a headline was flagged (DATA-487). */
export type ViewResult = { view: Record<string, unknown> | null; withheld: number; flags?: HeadlineFlag[]; flagUnattributed?: number };

export function dropView(date: string, card: BriefOpportunity): ViewResult {
  const w = new Withheld();
  const who = person(card, w);
  if (!who) return { view: null, withheld: w.count };
  const kind = card.feedCategory === "connector-flow" ? "community-ask" : "conversation";
  return {
    view: {
      job: "opportunity-drop",
      date,
      kind,
      seenBefore: Boolean(card.redelivery),
      person: who,
      ...matchFacts(card.headline, card.matchedIntentText, w, card, { withIntent: kind === "conversation" }),
    },
    withheld: w.count,
    ...w.flagged(),
  };
}

/**
 * DATA-430: the pending alert's Script Output, one entry per card the pick
 * handed over (pending-alert.ts). The prompt links only `appUrl` (the app's
 * deep link to that card, where the resident decides); `acceptUrl` (Index's
 * signed accept link, which accepts at once) is kept for completeness and is
 * not rendered. `respondBy` is the deadline's words (respondByText), or null.
 */
export function pendingView(cards: DueCard[], now: Date): ViewResult {
  const w = new Withheld();
  const shown = cards.flatMap(({ card, opportunityId, firstSeen }) => {
    const who = person(card, w);
    if (!who) return [];
    // INDEX-COMMS A: the fixed line may name Index's headline; never the resident's intent here.
    const { match } = matchFacts(card.headline, undefined, w, { ...card, opportunityId }, { withIntent: false });
    return [{ name: who.name, profileUrl: who.profileUrl, appUrl: appOpportunityLink(opportunityId), acceptUrl: who.messageUrl, opportunityId, firstSeen, respondBy: respondByText(card.respondBy, now), ...(match ? { match } : {}) }];
  });
  return { view: shown.length > 0 ? { job: "pending-opportunity", cards: shown } : null, withheld: w.count, ...w.flagged() };
}

type EveningResult = Awaited<ReturnType<typeof askQuestions>>;

export function eveningView(date: string, result: Exclude<EveningResult, { silent: true }>): ViewResult {
  const w = new Withheld();
  if (!("name" in result)) {
    const question = w.text(result.prompt, 300);
    return { view: question ? { job: "evening-note", date, closeoutQuestion: question } : null, withheld: w.count };
  }
  const who = person(result, w);
  if (!who) return { view: null, withheld: w.count };
  // `matchHeadline` is Index's own headline: the card's `headline` falls back to the summary and is never read.
  // DATA-487: the evening card carries the Index pages (attachIndexLinks), not the ids.
  const facts = matchFacts(result.matchHeadline, result.matchedIntentText, w, result);
  return { view: { job: "evening-note", date, person: who, ...facts }, withheld: w.count, ...w.flagged() };
}

type FollowUpResult = Exclude<Awaited<ReturnType<typeof followUp>>, { silent: true }>;

export function followUpView(date: string, result: FollowUpResult): ViewResult {
  const w = new Withheld();
  const people = (cards: FollowUpResult["needsAttention"]) => cards.slice(0, LIST_MAX).flatMap((card) => person(card, w) ?? []);
  // INDEX-COMMS A: a Waiting on you row may name the match (Index's own headline, the resident's intent).
  const waitingOnYou = result.needsAttention.slice(0, LIST_MAX).flatMap((card) => {
    const who = person(card, w);
    return who ? [{ ...who, ...matchFacts(card.matchHeadline, card.matchedIntentText, w, card) }] : [];
  });
  const newConnections = people(result.newlyResolved);
  const agentsTalking = people(result.waiting).map(({ name, profileUrl }) => ({ name, profileUrl }));
  const yourSignals = result.signals.slice(0, LIST_MAX).flatMap((signal) => {
    // A signal's summary comes back from Index, not from the resident's keyboard: the stricter cleaner.
    const text = w.title(signal.summary, 120);
    return text ? [{ text, link: signalLink(signal.url) }] : [];
  });
  if (waitingOnYou.length === 0 && newConnections.length === 0) return { view: null, withheld: w.count, ...w.flagged() };
  return { view: { job: "people-follow-up", date, yourSignals, waitingOnYou, agentsTalking, newConnections }, withheld: w.count, ...w.flagged() };
}

// ── Actions ─────────────────────────────────────────────────────────────────

interface Run {
  home: string;
  action: AgentAction;
  date: string;
  now: Date;
  options: ProactiveOptions;
  /** The state file the content path reads and writes: the real one, or a preview's private copy. */
  stateFile: string;
  preview: boolean;
}

/** What an action decided: the view to wake on (and what to record with the day mark), or why to stay silent. */
type Decision =
  | ({
      view: Record<string, unknown>;
      withheld: number;
      record?: (state: Record<string, unknown>) => Record<string, unknown>;
      /** Runs holding the lock just before the day mark is written (the outcome ask's stage file); a throw keeps the run silent. */
      beforeWake?: () => void;
      detail?: string;
    } & Flagged)
  | ({ silent: string; withheld?: number; detail?: string } & Flagged);

/** DATA-487: the headline flags a view collected (ViewResult), carried to the run. */
type Flagged = { flags?: HeadlineFlag[]; flagUnattributed?: number };

/** The flag keys of a view result, for a Decision. */
function flagsOf(result: Flagged): Flagged {
  return { ...(result.flags?.length ? { flags: result.flags } : {}), ...(result.flagUnattributed ? { flagUnattributed: result.flagUnattributed } : {}) };
}

/**
 * The brief's context options. The interests are the profile's (DATA-372); when it states none,
 * the Context tags' stated items (contextInterestsFor), which then also pick the events in place of
 * tags from the memory files. Neither: the memory files, as before.
 */
function contextOptions(home: string, date: string, stateFile = stateFilePath(home)) {
  const profile = statedInterestsFor(home);
  const fromContext = profile.length ? [] : contextInterestsFor(home);
  return {
    date,
    stateFile,
    userFiles: [join(home, "USER.md"), join(home, "MEMORY.md"), join(home, "memory", `${date}.md`)],
    statedInterests: profile.length ? profile : fromContext,
    ...(fromContext.length ? { statedFrom: "context" as const } : {}),
  };
}

async function briefAction(run: Run): Promise<Decision> {
  const build = run.options.buildContext ?? buildDailyBriefContext;
  const context = withPrefetchedIndex(await build(contextOptions(run.home, run.date, run.stateFile)), readPrefetch(run.home, run.date));
  const approvals = (run.options.approvals ?? approvalsWaiting)(run.home);
  const { view, withheld, shownIds } = briefView(context, { link: connectionsUrl(run.home), approvals, portal: portalBase(run.home), preferences: preferencesFor(run.home) });
  return { view, withheld, record: (state) => recordBriefShowings(state, shownIds, run.date, villageDate()) };
}

async function dropAction(run: Run): Promise<Decision> {
  let result: Awaited<ReturnType<typeof dropOpportunity>>;
  try {
    result = await (run.options.drop ?? dropOpportunity)({ date: run.date, stateFile: run.stateFile });
  } catch {
    return { silent: "index-unavailable" };
  }
  if ("silent" in result) return { silent: result.reason };
  const shown = dropView(run.date, result.opportunity);
  const { view, withheld } = shown;
  if (!view) return { silent: "name-withheld", withheld, ...flagsOf(shown) };
  const styled = withPreferences(view, preferencesFor(run.home));
  return { view: styled.view, withheld: withheld + styled.withheld, ...flagsOf(shown) };
}

/**
 * DATA-430: the cards that newly turned pending, recorded as alerted by the
 * pick (pending-alert.ts) before the model is woken, as the drops record a
 * showing. The window was checked before this (deliveryGate).
 */
async function pendingAction(run: Run): Promise<Decision> {
  const result = await (run.options.pending ?? pendingAlert)({ stateFile: run.stateFile, now: run.now });
  if ("silent" in result) return { silent: result.reason };
  const shown = pendingView(result.cards, run.now);
  const { view, withheld } = shown;
  return view ? { view, withheld, ...flagsOf(shown) } : { silent: "name-withheld", withheld, ...flagsOf(shown) };
}

/** The av-events plugin's spellings of "off" (`_core.py` DISABLED_VALUES), matched trimmed and case-insensitive. */
const PLUGIN_OFF_VALUES = new Set(["0", "false", "no", "off"]);
/** Names in `AV_HOOKS_DISABLED` that leave the ask unrecorded: the ask's own switch, and the hook that arms it. */
const OUTCOME_ASK_HOOKS = new Set(["outcome_ask", "post_llm_call"]);

/**
 * The av-events plugin would not record an ask: `AV_EVENTS_TOKEN` blank (also
 * how consent is revoked), `AV_EVENTS_ENABLED` an off spelling, or
 * `outcome_ask` or `post_llm_call` in `AV_HOOKS_DISABLED` (matched as the
 * plugin does: comma-separated, trimmed, case-insensitive). All read like
 * every other variable here, the environment else `.env`. The states this
 * cannot see (the plugin degraded or not loaded) are bounded by MAX_ATTEMPTS.
 */
export function outcomePluginOff(home: string): boolean {
  if (!envOrDotenv("AV_EVENTS_TOKEN", home)) return true;
  if (PLUGIN_OFF_VALUES.has(envOrDotenv("AV_EVENTS_ENABLED", home).toLowerCase())) return true;
  return envOrDotenv("AV_HOOKS_DISABLED", home)
    .split(",")
    .some((part) => OUTCOME_ASK_HOOKS.has(part.trim().toLowerCase()));
}

/**
 * The evening outcome ask (DATA-42 R2), or why there is none tonight: a code,
 * and the run falls back to the reminder. The subject is only ever recorded
 * as staged (`outcomeAsk.attempts`); the plugin's asked ledger, written once
 * the message was delivered, is what makes it asked.
 */
async function outcomeAskDecision(run: Run): Promise<Decision | { fallback: string; withheld?: number }> {
  // Nothing would record the ask: the same question every evening, for every connection.
  if (outcomePluginOff(run.home)) return { fallback: "outcome-ask-plugin-off" };
  const path = run.stateFile;
  let state: Record<string, unknown>;
  try {
    state = readState(path);
  } catch {
    return { fallback: "outcome-ask-state" };
  }
  const backfilled = backfillAnnounced(state, run.date);
  if (backfilled.changed) {
    writeStateFile(path, backfilled.state);
    state = backfilled.state;
  }
  const asked = readAskedIds(run.home);
  // The plugin never overwrites a ledger it refuses, so it could record no
  // new ask: asking tonight could ask a subject again and again.
  if (asked === null) return { fallback: "outcome-ask-ledger-unreadable" };
  const due = dueSubjects(state, asked, run.date);
  if (due.length === 0) return { fallback: "outcome-ask-none-due" };
  let accepted: BriefOpportunity[];
  try {
    accepted = await (run.options.accepted ?? listAcceptedConnections)();
  } catch {
    return { fallback: "outcome-ask-index-unavailable" };
  }
  const listed = new Map(accepted.flatMap((card) => (card.opportunityId && card.status === "accepted" ? [[card.opportunityId, card] as const] : [])));
  const candidates = due.filter((candidate) => listed.has(candidate));
  if (candidates.length === 0) return { fallback: "outcome-ask-not-listed" };
  // A subject whose name does not clean is passed over tonight (counted in
  // the run log's `withheld`, no attempt recorded) and never blocks the ones
  // behind it; it stays due and is asked once its name cleans.
  const w = new Withheld();
  let id: string | undefined;
  let name: string | null = null;
  for (const candidate of candidates) {
    name = w.name(listed.get(candidate)!.name);
    if (name) {
      id = candidate;
      break;
    }
  }
  if (!id || !name) return { fallback: "outcome-ask-name-withheld", withheld: w.count };
  const subject = id;
  const question = outcomeQuestion(name);
  // M2b: the intention this connection belongs to, only when Index named it
  // (today never: `not_linked`). Written only in a version 2 stage, which is
  // off (STAGE_FORMAT_V2): the stage is version 1, as before M2b.
  const link = intentionLink(listed.get(id)!.matchedIntentIds);
  const stage = stageFor(id, run.date, run.now, question, link, { formatV2: run.options.stageFormatV2 });
  if (!stage) return { fallback: "outcome-ask-bad-id" };
  return {
    view: { job: "evening-note", date: run.date, outcomeQuestion: question },
    withheld: w.count,
    record: (latest) => recordAttempt(latest, subject, run.date, asked),
    beforeWake: () => writeStage(run.home, stage),
    detail: "outcome-ask",
  };
}

async function eveningAction(run: Run): Promise<Decision> {
  // A stage left by an earlier run is never this run's: without this, a
  // reminder written now could be armed as the ask. Only the installer's
  // evening job stages, so only it clears: a preview or the evening template
  // leaves a real run's stage alone (its model may still be writing).
  const stages = run.action === "evening" && !run.preview;
  if (stages) clearStage(run.home);
  // The plugin arms the ask for the installer's evening job only: a template
  // job's ask would go out unrecorded and be asked again.
  const ask = run.action === "evening" ? await outcomeAskDecision(run) : { fallback: "outcome-ask-template-job" };
  if (!("fallback" in ask)) return ask;
  const detail = ask.fallback;
  // Due names the ask passed over still count in the run log's `withheld`.
  const askWithheld = ("withheld" in ask ? ask.withheld : 0) ?? 0;
  const result = await (run.options.evening ?? askQuestions)({ date: run.date, stateFile: run.stateFile });
  if ("silent" in result) return { silent: result.reason, detail, ...(askWithheld ? { withheld: askWithheld } : {}) };
  const shown = eveningView(run.date, result);
  const { view, withheld } = shown;
  if (!view) return { silent: "name-withheld", withheld: withheld + askWithheld, detail, ...flagsOf(shown) };
  // The reminder about a person only: the closeout question, like the outcome ask, goes out word for word.
  const styled = "person" in view ? withPreferences(view, preferencesFor(run.home)) : { view, withheld: 0 };
  return { view: styled.view, withheld: withheld + askWithheld + styled.withheld, detail, ...flagsOf(shown) };
}

async function negotiationAction(run: Run): Promise<Decision> {
  const result = await (run.options.followUp ?? followUp)({ date: run.date, stateFile: run.stateFile });
  if ("silent" in result) return { silent: result.reason };
  const shown = followUpView(run.date, result);
  const { view, withheld } = shown;
  if (!view) return { silent: "name-withheld", withheld, ...flagsOf(shown) };
  const styled = withPreferences(view, preferencesFor(run.home));
  return { view: styled.view, withheld: withheld + styled.withheld, ...flagsOf(shown) };
}

const AGENT_ACTIONS: Record<AgentAction, (run: Run) => Promise<Decision>> = {
  brief: briefAction,
  "drop-midday": dropAction,
  "drop-evening": dropAction,
  negotiation: negotiationAction,
  evening: eveningAction,
  pending: pendingAction,
  "tpl-brief": briefAction,
  "tpl-digest-preview": dropAction,
  "tpl-evening-ask": eveningAction,
};

/**
 * Actions with no once-a-day mark (DATA-430): the hourly pending alert runs
 * every hour of its window and its own per-card ledger is the only gate, so
 * the day mark is neither read nor written for it.
 */
export const DAY_MARK_EXEMPT: ReadonlySet<AgentAction> = new Set<AgentAction>(["pending"]);

/** The silent reason for an error a trigger caught: a known code, else the error's class. */
function faultReason(err: unknown): string {
  if (err instanceof LockTimeout) return "state-locked";
  if (err instanceof LockStuck) return "state-lock-stuck";
  if (err instanceof StateUnreadable || err instanceof StateCorrupt) return "state-unreadable";
  return errorCode(err);
}

/**
 * Whether this run may deliver under its job's settings: null when it may, else
 * the silent result. Read before the lock, as rc13 read the brief's window.
 */
export function deliveryGate(delivery: Delivery, now: Date): TriggerResult | null {
  const settings = delivery.settings ? { settings: delivery.settings } : {};
  if (delivery.hold) return { ...silent("settings-invalid"), ...settings };
  if (delivery.window && !inWindow(minuteOfDay(now, delivery.tz), delivery.window)) return { ...silent("outside-window"), ...settings };
  return null;
}

/**
 * The first decision of an agent-job run: the job's settings read now, and
 * the silent result when its window or settings stop it (deliveryGate). The
 * trigger's own path (runAgentAction); the rc13 parity test calls it too.
 */
export function windowDecision(action: AgentAction, home: string, now: Date): { delivery: Delivery; gated: TriggerResult | null } {
  const delivery = deliveryFor(action, readJobSettings(home));
  return { delivery, gated: deliveryGate(delivery, now) };
}

/** One agent-job trigger, start to wake line. Never throws; always exit code 0. */
async function runAgentAction(action: AgentAction, options: ProactiveOptions): Promise<TriggerResult> {
  const home = homeDir(options);
  const now = (options.now ?? (() => new Date()))();
  const { delivery, gated } = windowDecision(action, home, now);
  if (gated) return gated;
  const settings = delivery.settings ? { settings: delivery.settings } : {};
  const stateFile = stateFilePath(home);
  const run: Run = { home, action, date: villageDate(now), now, options, stateFile, preview: false };
  let healed = false;
  const read = (): Record<string, unknown> => {
    const got = readStateHealing(stateFile, now);
    healed ||= got.healed;
    return got.state;
  };
  let result: TriggerResult;
  try {
    result = await withStateLock(stateFile, async () => {
      // An unreadable state file is renamed aside before anything is picked or written.
      const marked = !DAY_MARK_EXEMPT.has(action);
      if (doneToday(read(), action, run.date) && marked) return silent("done-today");
      const decision = await AGENT_ACTIONS[action](run);
      // DATA-487: every withheld or flagged headline this run saw, ids and codes only, whatever the run does next.
      const flagged = handOffFlags(home, decision, now);
      const extra = { ...(decision.detail ? { detail: decision.detail } : {}), ...flagged };
      if ("silent" in decision) return { ...silent(decision.silent, 0, decision.withheld), ...extra };
      const text = scriptOutputText(withAgentName(home, decision.view));
      // Every field was scanned; this catches a hit spanning two of them.
      if (cronScanHit(text)) return { ...silent("scan-blocked", 0, decision.withheld), ...extra };
      // The day is done from the moment the model is woken.
      // A stage that cannot be written stops the wake before the day is marked.
      decision.beforeWake?.();
      if (marked || decision.record) {
        const latest = read();
        const recorded = decision.record ? decision.record(latest) : latest;
        writeStateFile(stateFile, marked ? markDone(recorded, action, run.date) : recorded);
      }
      return { lines: [text, wakeLine(true)], exitCode: 0, woke: true, reason: "woke", ...(decision.withheld ? { withheld: decision.withheld } : {}), ...extra };
    }, options.lock);
  } catch (err) {
    result = silent(faultReason(err));
  }
  return { ...(healed ? { ...result, note: STATE_HEALED } : result), ...settings };
}

// ── Detection (DATA-487): withheld or flagged headlines, handed to the av-events plugin ──

/**
 * The folder the trigger hands headline flags to the av-events plugin in
 * (plugins/av-events/_headline_flagged.py emits `opportunity.headline_flagged@1`
 * for each record, then removes the file). Scripts never write events themselves.
 */
export function headlineFlagDir(home: string): string {
  return join(proactiveDir(home), "headline-flagged");
}
/** Files waiting in headlineFlagDir at most: past it the run hands nothing over (a plugin that never reads them). */
export const HEADLINE_FLAG_FILES_MAX = 200;
/** Records one run hands over at most (the plugin's RECORDS_MAX): past it the first go and the rest are counted. */
export const HEADLINE_FLAG_RECORDS_MAX = 50;
/** Why a run's flags, or some of them, were not handed over. */
export type FlagDropReason = "plugin_off" | "folder_full" | "unwritable" | "over_cap";
/** The plugin's own name for this in `AV_HOOKS_DISABLED`. */
export const HEADLINE_FLAG_SWITCH = "headline_flagged";

/**
 * The av-events plugin would not emit the flags (as outcomePluginOff): `AV_EVENTS_TOKEN` blank,
 * `AV_EVENTS_ENABLED` an off spelling, or `headline_flagged` in `AV_HOOKS_DISABLED`.
 */
export function headlineFlagPluginOff(home: string): boolean {
  if (!envOrDotenv("AV_EVENTS_TOKEN", home)) return true;
  if (PLUGIN_OFF_VALUES.has(envOrDotenv("AV_EVENTS_ENABLED", home).toLowerCase())) return true;
  return envOrDotenv("AV_HOOKS_DISABLED", home)
    .split(",")
    .some((part) => part.trim().toLowerCase() === HEADLINE_FLAG_SWITCH);
}

/**
 * Write one hand-off file for the av-events plugin: `{"v":1,"written_at":<ISO>,"records":[...]}`,
 * each record exactly the five keys of HeadlineFlag (ids, codes and a length; no name, no
 * headline, no intent, no text), 0600 in a 0700 folder, by temp file and rename, at most
 * HEADLINE_FLAG_RECORDS_MAX records (the caller counts the rest). Null when it was written, else
 * why not (the plugin off, the folder full, the write failed). Never throws.
 */
export function writeHeadlineFlags(home: string, flags: readonly HeadlineFlag[], now: Date): FlagDropReason | null {
  if (headlineFlagPluginOff(home)) return "plugin_off";
  try {
    const dir = headlineFlagDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (readdirSync(dir).filter((name) => name.endsWith(".json")).length >= HEADLINE_FLAG_FILES_MAX) return "folder_full";
    const records = flags.slice(0, HEADLINE_FLAG_RECORDS_MAX).map(({ opportunity_id, counterpart_index_user_id, reason_code, stage, headline_length }) => ({ opportunity_id, counterpart_index_user_id, reason_code, stage, headline_length }));
    const path = join(dir, `${now.getTime()}-${process.pid}-${randomBytes(6).toString("hex")}.json`);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, written_at: now.toISOString(), records })}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
    return null;
  } catch {
    return "unwritable";
  }
}

/**
 * Hand a decision's flags over and say, in counts only, what happened to them (the run log's
 * `flagged`, `flag_dropped` with `flag_dropped_reason`, `flag_unattributed`): a drop is never silent.
 */
function handOffFlags(home: string, decision: Flagged, now: Date): Pick<TriggerResult, "flagged" | "flagDropped" | "flagDroppedReason" | "flagUnattributed"> {
  const flags = decision.flags ?? [];
  const unattributed = decision.flagUnattributed ? { flagUnattributed: decision.flagUnattributed } : {};
  if (flags.length === 0) return unattributed;
  const failed = writeHeadlineFlags(home, flags, now);
  if (failed) return { flagDropped: flags.length, flagDroppedReason: failed, ...unattributed };
  const sent = Math.min(flags.length, HEADLINE_FLAG_RECORDS_MAX);
  return { flagged: sent, ...(sent < flags.length ? { flagDropped: flags.length - sent, flagDroppedReason: "over_cap" as const } : {}), ...unattributed };
}

/** Private state copies a preview in this process is using, so the hard stop can remove them. */
const previewCopies = new Set<string>();

/**
 * What the hard deadline does before it exits: release every state lock this
 * process holds and remove every preview state copy it made (the normal
 * path's `finally` never runs on that exit). Exported for the tests.
 */
export function hardStopCleanup(): void {
  releaseHeldLocks();
  for (const dir of [...previewCopies]) {
    previewCopies.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // pruned by the next preview or roll after an hour
    }
  }
}

/**
 * A team tenant's preview of an agent job's content path, now. Refused unless
 * AV_TEAM_TENANT=1 (checked here, whatever started the run). No window and no
 * day mark are read; nothing the real run reads is written: the state lock is
 * never taken, the content path runs against a private copy of the state file
 * (deleted afterwards, by the hard stop too), no record or day mark is
 * applied, no outcome ask is staged and no real stage is cleared. The Script
 * Output is the real run's.
 */
async function runPreview(action: ProactiveAction, options: ProactiveOptions): Promise<TriggerResult> {
  const home = homeDir(options);
  if (action === "prefetch") return silent("preview-not-agent-job");
  if (!isTeamTenant(home)) return silent("preview-refused");
  const now = (options.now ?? (() => new Date()))();
  // Copies an earlier preview left when it was killed (by modification time, so the real clock).
  prunePreviewFiles(home, Date.now(), { shims: false });
  let state: Record<string, unknown>;
  try {
    // A plain read: every write of the file is a rename, so no lock is needed to see a whole one.
    state = readState(stateFilePath(home));
  } catch (err) {
    return silent(faultReason(err));
  }
  let dir: string | undefined;
  try {
    mkdirSync(proactiveDir(home), { recursive: true, mode: 0o700 });
    dir = mkdtempSync(join(proactiveDir(home), "preview-"));
    previewCopies.add(dir);
    const stateFile = join(dir, "heartbeat-state.json");
    writePrivateJson(stateFile, state);
    const run: Run = { home, action, date: villageDate(now), now, options, stateFile, preview: true };
    const decision = await AGENT_ACTIONS[action](run);
    const detail = decision.detail ? { detail: decision.detail } : {};
    if ("silent" in decision) return { ...silent(decision.silent, 0, decision.withheld), ...detail };
    const text = scriptOutputText(withAgentName(home, decision.view));
    if (cronScanHit(text)) return { ...silent("scan-blocked", 0, decision.withheld), ...detail };
    return { lines: [text, wakeLine(true)], exitCode: 0, woke: true, reason: "woke", ...(decision.withheld ? { withheld: decision.withheld } : {}), ...detail };
  } catch (err) {
    return silent(faultReason(err));
  } finally {
    if (dir) {
      previewCopies.delete(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Write JSON by temp file and rename (0600, its directory 0700). */
function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** The 02:00 prefetch (no_agent): today's brief context, written for 08:00. Always silent. */
async function runPrefetch(options: ProactiveOptions): Promise<TriggerResult> {
  const home = homeDir(options);
  const now = (options.now ?? (() => new Date()))();
  const date = villageDate(now);
  const stateFile = stateFilePath(home);
  let healed = false;
  let result: TriggerResult;
  try {
    result = await withStateLock(stateFile, async () => {
      healed = readStateHealing(stateFile, now).healed;
      const context = await (options.buildContext ?? buildDailyBriefContext)(contextOptions(home, date));
      writePrivateJson(join(proactiveDir(home), PREFETCH_FILE), { date, builtAt: now.toISOString(), context });
      return silent("prefetched");
    }, options.lock);
  } catch (err) {
    result = err instanceof LockTimeout ? silent("state-locked") : silent(faultReason(err), 1);
  }
  return healed ? { ...result, note: STATE_HEALED } : result;
}

/** Run one action and return what to print. Never throws. */
export async function runProactive(action: ProactiveAction, options: ProactiveOptions = {}): Promise<TriggerResult> {
  let result: TriggerResult;
  const preview = options.preview === true;
  try {
    if (preview) result = { ...(await runPreview(action, options)), preview: true };
    else result = action === "prefetch" ? await runPrefetch(options) : await runAgentAction(action, options);
  } catch (err) {
    result = silent(errorCode(err), action === "prefetch" && !preview ? 1 : 0);
  }
  appendRunLog(homeDir(options), {
    action,
    decision: result.woke ? "woke" : "silent",
    reason: reasonCode(result.reason),
    ...(result.withheld ? { withheld: result.withheld } : {}),
    ...(result.flagged ? { flagged: result.flagged } : {}),
    ...(result.flagDropped ? { flag_dropped: result.flagDropped, flag_dropped_reason: result.flagDroppedReason } : {}),
    ...(result.flagUnattributed ? { flag_unattributed: result.flagUnattributed } : {}),
    ...(result.note ? { note: reasonCode(result.note) } : {}),
    ...(result.detail ? { detail: reasonCode(result.detail) } : {}),
    ...(result.settings ? { settings: reasonCode(result.settings) } : {}),
    ...(preview ? { preview: true } : {}),
  });
  return result;
}

/**
 * The script: `proactive.ts <action> [--preview]`. Exported, with `seams`, for
 * the hard-deadline test only (a child process runs it with a tiny deadline
 * and a content path that never returns); the script itself passes none.
 */
export async function main(argv: string[] = process.argv.slice(2), seams: { deadlineMs?: number; options?: ProactiveOptions } = {}): Promise<void> {
  // stdout is the Script Output: anything a library prints goes to stderr.
  console.log = console.error;
  const action = argv[0];
  const extra = argv.slice(1);
  // The one flag: `--preview` (the shim passes it for a `preview-<action>` name). Anything else is refused.
  if (!isProactiveAction(action) || extra.some((arg) => arg !== "--preview")) {
    process.stdout.write(`${wakeLine(false, "unknown-action")}\n`);
    return;
  }
  const preview = extra.includes("--preview");
  const exitCode = action === "prefetch" && !preview ? 1 : 0;
  const hardStop = setTimeout(() => {
    hardStopCleanup();
    appendRunLog(homeDir(seams.options), { action, decision: "silent", reason: "trigger-timeout", ...(preview ? { preview: true } : {}) });
    process.stderr.write(`proactive: ${action} trigger-timeout\n`);
    process.stdout.write(`${wakeLine(false, "trigger-timeout")}\n`, () => process.exit(exitCode));
  }, seams.deadlineMs ?? HARD_DEADLINE_MS);
  const result = await runProactive(action, { ...seams.options, preview });
  clearTimeout(hardStop);
  process.stderr.write(`proactive: ${action} ${reasonCode(result.reason)}${result.note ? ` ${reasonCode(result.note)}` : ""}\n`);
  // Exit once the last line is written: a lingering child must not keep the trigger alive.
  process.stdout.write(`${result.lines.join("\n")}\n`, () => process.exit(result.exitCode));
}

if (import.meta.main) {
  try {
    await main();
  } catch (err) {
    process.stdout.write(`${wakeLine(false, errorCode(err))}\n`, () => process.exit(process.argv[2] === "prefetch" ? 1 : 0));
  }
}
