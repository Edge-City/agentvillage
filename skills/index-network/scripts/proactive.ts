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
 *   evening        19:00: one pending conversation, or the last-day closeout.
 *
 * The script does every deterministic step, so the model only writes language
 * from the Script Output and never needs a tool:
 *   - the brief's delivery window, 05:00 to 11:00 IST (outside it: silent);
 *   - once per day per job: the day is marked done when the trigger wakes the
 *     model (a run that then fails loses that day; no delivery tracking);
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
 *     third-party free text: no headline, summary or description written by
 *     or about another person. Every string is cleaned and scanned with the
 *     mirror of Hermes's cron prompt scanner and withheld on a hit.
 *
 * Output: the Script Output JSON (no backtick, no raw `<` or `>`), then the
 * wake line as the LAST line: `{"wakeAgent": true}`, or `{"wakeAgent": false,
 * "reason": "<code>"}`. An agent-job trigger always exits 0 (a failed pre-run
 * script makes Hermes ask the model to report the failure to the resident).
 * The prefetch exits 1 on a fault; Hermes then notifies its failure target,
 * which is local. Logs carry codes and counts only: stderr, and one line per
 * run in av-events/proactive/triggers.jsonl.
 */

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { approvalsWaiting } from "./approvals-waiting";
import { askQuestions } from "./ask-questions";
import { type BriefOpportunity, type DailyBriefContext, buildDailyBriefContext, villageDate } from "./build-daily-brief-context";
import { OPPORTUNITY_DELIVERY_KEY, deliveryLogChanged, pruneDeliveryLog, readDeliveryLog, recordShowings } from "./delivery-state";
import { dropOpportunity } from "./drop-opportunity";
import { cleanName, cleanText, cleanTitle, connectionsUrl, cronScanHit, envOrDotenv } from "./proactive-text";
import { type LockOptions, LockStuck, LockTimeout, releaseHeldLocks, withStateLock } from "./state-lock";
import { writeStateFile } from "./state-file";
import { followUp } from "./summarize-negotiations";

export const ACTIONS = ["prefetch", "brief", "drop-midday", "drop-evening", "negotiation", "evening"] as const;
export type ProactiveAction = (typeof ACTIONS)[number];
export type AgentAction = Exclude<ProactiveAction, "prefetch">;

export function isProactiveAction(value: unknown): value is ProactiveAction {
  return typeof value === "string" && (ACTIONS as readonly string[]).includes(value);
}

/** The state key this trigger adds: `proactiveRuns.<action>` = the village date it last woke the model. */
export const RUNS_KEY = "proactiveRuns";
/** The brief's delivery window, in minutes since village (IST) midnight. */
export const BRIEF_WINDOW = { start: 5 * 60, end: 11 * 60 };
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
  evening?: typeof askQuestions;
  followUp?: typeof followUp;
  approvals?: (home: string) => number;
}

export interface TriggerResult {
  /** Lines for stdout; the last is the wake line. */
  lines: string[];
  exitCode: number;
  woke: boolean;
  reason: string;
  /** Strings withheld because they did not clean or would trip Hermes's scanner. */
  withheld?: number;
  /** A code for something the run repaired on its way (STATE_HEALED). */
  note?: string;
}

/** The run renamed an unreadable state file aside and continued from an empty state. */
export const STATE_HEALED = "state-renamed-aside";

// ── Paths, state and logs ───────────────────────────────────────────────────

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
  private counted(raw: unknown, text: string | null): string | null {
    if (raw !== undefined && raw !== null && raw !== "" && !text) this.count++;
    return text;
  }
}

export interface PersonView {
  name: string;
  profileUrl: string | null;
  messageUrl: string | null;
}

function person(card: { name?: unknown; userUrl?: unknown; opportunityUrl?: unknown }, w: Withheld): PersonView | null {
  const name = w.name(card.name);
  return name ? { name, profileUrl: indexUrl("u", card.userUrl), messageUrl: indexUrl("o", card.opportunityUrl) } : null;
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
 * The morning brief's Script Output. The Index part is a count, at most
 * three cleaned names, and the Connections link; no card text, no person
 * link. `shownIds` are the cards named, recorded as shown when the model is
 * woken (as the old send recorded the cards of the brief it delivered).
 */
export function briefView(
  context: DailyBriefContext,
  { link, approvals, portal = null }: { link: string; approvals: number; portal?: string | null },
): { view: Record<string, unknown>; withheld: number; shownIds: string[] } {
  const w = new Withheld();
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
      interests: (context.userModel?.interestTags ?? []).flatMap((tag) => cleanText(tag, 40) ?? []),
      // Read from the agent's memory files, which can hold text that came from someone else: the stricter cleaner.
      notes: (context.userModel?.phrases ?? []).slice(0, 3).flatMap((phrase) => w.title(phrase, 120) ?? []),
    },
    connections: {
      newMatchCount: count,
      countIsAtLeast: count !== null && Boolean(context.moreWaitingThanListed),
      names: named.map((entry) => entry.name),
      link,
    },
    approvalsWaiting: Math.max(0, Math.trunc(approvals)) || 0,
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

export function dropView(date: string, card: BriefOpportunity): { view: Record<string, unknown> | null; withheld: number } {
  const w = new Withheld();
  const who = person(card, w);
  if (!who) return { view: null, withheld: w.count };
  return {
    view: {
      job: "opportunity-drop",
      date,
      kind: card.feedCategory === "connector-flow" ? "community-ask" : "conversation",
      seenBefore: Boolean(card.redelivery),
      person: who,
    },
    withheld: w.count,
  };
}

type EveningResult = Awaited<ReturnType<typeof askQuestions>>;

export function eveningView(date: string, result: Exclude<EveningResult, { silent: true }>): { view: Record<string, unknown> | null; withheld: number } {
  const w = new Withheld();
  if (!("name" in result)) {
    const question = w.text(result.prompt, 300);
    return { view: question ? { job: "evening-note", date, closeoutQuestion: question } : null, withheld: w.count };
  }
  const who = person(result, w);
  return { view: who ? { job: "evening-note", date, person: who } : null, withheld: w.count };
}

type FollowUpResult = Exclude<Awaited<ReturnType<typeof followUp>>, { silent: true }>;

export function followUpView(date: string, result: FollowUpResult): { view: Record<string, unknown> | null; withheld: number } {
  const w = new Withheld();
  const people = (cards: FollowUpResult["needsAttention"]) => cards.slice(0, LIST_MAX).flatMap((card) => person(card, w) ?? []);
  const waitingOnYou = people(result.needsAttention);
  const newConnections = people(result.newlyResolved);
  const agentsTalking = people(result.waiting).map(({ name, profileUrl }) => ({ name, profileUrl }));
  const yourSignals = result.signals.slice(0, LIST_MAX).flatMap((signal) => {
    // A signal's summary comes back from Index, not from the resident's keyboard: the stricter cleaner.
    const text = w.title(signal.summary, 120);
    return text ? [{ text, link: indexUrl("i", signal.url) }] : [];
  });
  if (waitingOnYou.length === 0 && newConnections.length === 0) return { view: null, withheld: w.count };
  return { view: { job: "people-follow-up", date, yourSignals, waitingOnYou, agentsTalking, newConnections }, withheld: w.count };
}

// ── Actions ─────────────────────────────────────────────────────────────────

interface Run {
  home: string;
  action: AgentAction;
  date: string;
  now: Date;
  options: ProactiveOptions;
}

/** What an action decided: the view to wake on (and what to record with the day mark), or why to stay silent. */
type Decision = { view: Record<string, unknown>; withheld: number; record?: (state: Record<string, unknown>) => Record<string, unknown> } | { silent: string; withheld?: number };

function contextOptions(home: string, date: string) {
  return {
    date,
    stateFile: stateFilePath(home),
    userFiles: [join(home, "USER.md"), join(home, "MEMORY.md"), join(home, "memory", `${date}.md`)],
  };
}

async function briefAction(run: Run): Promise<Decision> {
  const build = run.options.buildContext ?? buildDailyBriefContext;
  const context = withPrefetchedIndex(await build(contextOptions(run.home, run.date)), readPrefetch(run.home, run.date));
  const approvals = (run.options.approvals ?? approvalsWaiting)(run.home);
  const { view, withheld, shownIds } = briefView(context, { link: connectionsUrl(run.home), approvals, portal: portalBase(run.home) });
  return { view, withheld, record: (state) => recordBriefShowings(state, shownIds, run.date, villageDate()) };
}

async function dropAction(run: Run): Promise<Decision> {
  let result: Awaited<ReturnType<typeof dropOpportunity>>;
  try {
    result = await (run.options.drop ?? dropOpportunity)({ date: run.date, stateFile: stateFilePath(run.home) });
  } catch {
    return { silent: "index-unavailable" };
  }
  if ("silent" in result) return { silent: result.reason };
  const { view, withheld } = dropView(run.date, result.opportunity);
  return view ? { view, withheld } : { silent: "name-withheld", withheld };
}

async function eveningAction(run: Run): Promise<Decision> {
  const result = await (run.options.evening ?? askQuestions)({ date: run.date, stateFile: stateFilePath(run.home) });
  if ("silent" in result) return { silent: result.reason };
  const { view, withheld } = eveningView(run.date, result);
  return view ? { view, withheld } : { silent: "name-withheld", withheld };
}

async function negotiationAction(run: Run): Promise<Decision> {
  const result = await (run.options.followUp ?? followUp)({ date: run.date, stateFile: stateFilePath(run.home) });
  if ("silent" in result) return { silent: result.reason };
  const { view, withheld } = followUpView(run.date, result);
  return view ? { view, withheld } : { silent: "name-withheld", withheld };
}

const AGENT_ACTIONS: Record<AgentAction, (run: Run) => Promise<Decision>> = {
  brief: briefAction,
  "drop-midday": dropAction,
  "drop-evening": dropAction,
  negotiation: negotiationAction,
  evening: eveningAction,
};

/** Minutes since village (IST) midnight. */
export function villageMinuteOfDay(now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return (hour % 24) * 60 + minute;
}

export function inBriefWindow(now: Date): boolean {
  const minute = villageMinuteOfDay(now);
  return minute >= BRIEF_WINDOW.start && minute < BRIEF_WINDOW.end;
}

/** The silent reason for an error a trigger caught: a known code, else the error's class. */
function faultReason(err: unknown): string {
  if (err instanceof LockTimeout) return "state-locked";
  if (err instanceof LockStuck) return "state-lock-stuck";
  if (err instanceof StateUnreadable || err instanceof StateCorrupt) return "state-unreadable";
  return errorCode(err);
}

/** One agent-job trigger, start to wake line. Never throws; always exit code 0. */
async function runAgentAction(action: AgentAction, options: ProactiveOptions): Promise<TriggerResult> {
  const home = homeDir(options);
  const now = (options.now ?? (() => new Date()))();
  if (action === "brief" && !inBriefWindow(now)) return silent("outside-window");
  const run: Run = { home, action, date: villageDate(now), now, options };
  const stateFile = stateFilePath(home);
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
      if (doneToday(read(), action, run.date)) return silent("done-today");
      const decision = await AGENT_ACTIONS[action](run);
      if ("silent" in decision) return silent(decision.silent, 0, decision.withheld);
      const text = scriptOutputText(decision.view);
      // Every field was scanned; this catches a hit spanning two of them.
      if (cronScanHit(text)) return silent("scan-blocked", 0, decision.withheld);
      // The day is done from the moment the model is woken.
      const latest = read();
      writeStateFile(stateFile, markDone(decision.record ? decision.record(latest) : latest, action, run.date));
      return { lines: [text, wakeLine(true)], exitCode: 0, woke: true, reason: "woke", ...(decision.withheld ? { withheld: decision.withheld } : {}) };
    }, options.lock);
  } catch (err) {
    result = silent(faultReason(err));
  }
  return healed ? { ...result, note: STATE_HEALED } : result;
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
  try {
    result = action === "prefetch" ? await runPrefetch(options) : await runAgentAction(action, options);
  } catch (err) {
    result = silent(errorCode(err), action === "prefetch" ? 1 : 0);
  }
  appendRunLog(homeDir(options), {
    action,
    decision: result.woke ? "woke" : "silent",
    reason: reasonCode(result.reason),
    ...(result.withheld ? { withheld: result.withheld } : {}),
    ...(result.note ? { note: reasonCode(result.note) } : {}),
  });
  return result;
}

async function main(): Promise<void> {
  // stdout is the Script Output: anything a library prints goes to stderr.
  console.log = console.error;
  const action = process.argv[2];
  if (!isProactiveAction(action)) {
    process.stdout.write(`${wakeLine(false, "unknown-action")}\n`);
    return;
  }
  const exitCode = action === "prefetch" ? 1 : 0;
  const hardStop = setTimeout(() => {
    releaseHeldLocks();
    appendRunLog(homeDir(), { action, decision: "silent", reason: "trigger-timeout" });
    process.stderr.write(`proactive: ${action} trigger-timeout\n`);
    process.stdout.write(`${wakeLine(false, "trigger-timeout")}\n`, () => process.exit(exitCode));
  }, HARD_DEADLINE_MS);
  const result = await runProactive(action);
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
