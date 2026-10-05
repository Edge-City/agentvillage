/**
 * Per-job delivery settings for the proactive jobs (J2, overlay half). The
 * contract is docs/design/job-settings.md; this module is the one reader and
 * the one set of grammars, shared by the trigger (proactive.ts), the
 * installer's job commands (install/jobs.ts) and reconcile (install_index.ts).
 *
 * The carrier is one file, `$HERMES_HOME/av-events/job-settings.json`:
 *
 *   {"v": 1, "jobs": {"brief": {"window": "06:30-09:00", "tz": "Asia/Kolkata"}}, "adminSchedules": ["brief"]}
 *
 * `jobs` holds overrides only: a job with no entry runs on the defaults in
 * this file (DEFAULT_WINDOWS, DEFAULT_TZ), exactly as rc13 did, so a fleet
 * change to a default reaches every job without an override; an entry left
 * empty is deleted, and a file left with nothing is removed. `adminSchedules`
 * names the default jobs whose schedule an admin set, which reconcile's legacy
 * schedule migration never moves; the trigger never reads it. Schedules and
 * the enabled state themselves are not here: they live in Hermes's own job
 * record (the schedule, and the pause state), the only place Hermes reads them.
 *
 * Reading is strict and never widens a window: a value that fails its grammar
 * is never used; the job falls back to its default window when it has one,
 * and a job without a default window is held silent (`settings-invalid`)
 * rather than run around the clock. Every fallback is named in the trigger's
 * log line.
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The agent jobs a settings entry can name: the five default jobs, then the three template jobs. */
export const SETTINGS_JOB_KEYS = [
  "brief",
  "drop-midday",
  "drop-evening",
  "negotiation",
  "evening",
  "tpl-brief",
  "tpl-digest-preview",
  "tpl-evening-ask",
] as const;
export type JobKey = (typeof SETTINGS_JOB_KEYS)[number];

export function isJobKey(value: unknown): value is JobKey {
  return typeof value === "string" && (SETTINGS_JOB_KEYS as readonly string[]).includes(value);
}

/** The templates a job can be added from, each run by trigger action `tpl-<name>`. */
export const TEMPLATE_NAMES = ["brief", "digest-preview", "evening-ask"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

export function isTemplateName(value: unknown): value is TemplateName {
  return typeof value === "string" && (TEMPLATE_NAMES as readonly string[]).includes(value);
}

/** The village zone: every window without a `tz` is read in it (rc13's only zone). */
export const DEFAULT_TZ = "Asia/Kolkata";

/** A window in minutes since local midnight: `start` inclusive, `end` exclusive; `start > end` crosses midnight. */
export interface DeliveryWindow {
  start: number;
  end: number;
}

/** rc13's brief window, 05:00 to 11:00 village time; the brief template inherits it. No other job has one. */
export const DEFAULT_WINDOWS: Partial<Record<JobKey, DeliveryWindow>> = {
  brief: { start: 5 * 60, end: 11 * 60 },
  "tpl-brief": { start: 5 * 60, end: 11 * 60 },
};

/** A larger settings file is refused whole. */
export const MAX_SETTINGS_BYTES = 64 * 1024;

export function jobSettingsPath(home: string): string {
  return join(home, "av-events", "job-settings.json");
}

// ── Grammars ────────────────────────────────────────────────────────────────

const HHMM = "([01]\\d|2[0-3]):([0-5]\\d)";
const WINDOW_RE = new RegExp(`^${HHMM}-${HHMM}$`);

/** `HH:MM-HH:MM` (24-hour, two digits each), start and end different; anything else is null. */
export function parseWindow(text: unknown): DeliveryWindow | null {
  if (typeof text !== "string") return null;
  const match = WINDOW_RE.exec(text);
  if (!match) return null;
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  return start === end ? null : { start, end };
}

export function formatWindow(window: DeliveryWindow): string {
  const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  return `${hhmm(window.start)}-${hhmm(window.end)}`;
}

/** Whether a minute of the day falls in a window; a window whose start is after its end runs across midnight. */
export function inWindow(minute: number, window: DeliveryWindow): boolean {
  return window.start < window.end
    ? minute >= window.start && minute < window.end
    : minute >= window.start || minute < window.end;
}

/**
 * The IANA areas a job's zone may sit in. A name in one of them is accepted
 * whether it is a primary zone or a backward link inside the area
 * (`Asia/Calcutta`, `Europe/Kiev`, `America/Buenos_Aires`); a name outside
 * them is refused, links included (`Etc/UTC`, `Etc/GMT+5`, `US/Eastern`,
 * `GMT`, `EST5EDT`), except `UTC` itself.
 */
const ZONE_AREAS = new Set(["Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific"]);
const ZONE_RE = /^([A-Z][A-Za-z]+)\/[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)?$/;
let supportedZones: Set<string> | null = null;

/**
 * A job's zone (`tz`): an IANA zone name the runtime knows, spelt exactly as
 * the runtime spells it: `UTC`, or `Area/Location` (`Area/Region/Location`)
 * in one of the ten geographic areas above, accepted by the runtime's time
 * zone database (Bun's `Intl.supportedValuesOf("timeZone")`, or a name the
 * database resolves to the same spelling). Backward links inside those areas
 * are accepted (`Asia/Calcutta`, `Europe/Kiev`); offsets (`+05:30`), POSIX
 * names (`EST5EDT`), `Etc/` and `US/` names and case variants are refused.
 * (Bun's list is the older CLDR one: it has `Asia/Calcutta` but not
 * `Asia/Kolkata`, so a name it lacks is accepted when the database resolves
 * it to itself.) Hermes's own zone is read by a wider rule: hermesZoneName.
 */
export function isValidTimeZone(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 64) return false;
  if (name === "UTC") return true;
  const match = ZONE_RE.exec(name);
  if (!match || !ZONE_AREAS.has(match[1])) return false;
  supportedZones ??= new Set(Intl.supportedValuesOf("timeZone"));
  if (supportedZones.has(name)) return true;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone === name;
  } catch {
    return false;
  }
}

const FIELD_BOUNDS: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
const CRON_ITEM_RE = /^(\*|\d{1,2}|\d{1,2}-\d{1,2})(?:\/(\d{1,2}))?$/;
/** Five fields of `0-9 * , - /`, one space between them, nothing before or after. */
const CRON_SHAPE_RE = /^[0-9*,/-]+( [0-9*,/-]+){4}$/;

/**
 * The values one strict cron field selects, or null when it is outside the
 * grammar. `a/s` runs from a to the field's maximum; `a-b` needs b above a:
 * `a-a` (with or without a step) is refused, because croniter 6.0.0 reads a
 * degenerate range as the whole field. (croniter also reads `a/s` with a at
 * the maximum, such as `23/2`, as `*\/s`; the canonical form below never
 * sends either shape, so Hermes reads exactly these values.)
 */
function cronField(text: string, [low, high]: [number, number]): number[] | null {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const match = CRON_ITEM_RE.exec(item);
    if (!match) return null;
    let from = low;
    let to = high;
    if (match[1] !== "*") {
      const [a, b] = match[1].split("-").map(Number);
      if (a < low || a > high) return null;
      from = a;
      if (b === undefined) to = match[2] === undefined ? a : high;
      else {
        if (b <= a || b > high) return null;
        to = b;
      }
    }
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (step < 1 || step > high - low + 1) return null;
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return [...values].sort((x, y) => x - y);
}

/** A field as Hermes is sent it: `*` when it holds every value, else its values joined by commas. */
function canonicalField(values: number[], [low, high]: [number, number]): string {
  return values.length === high - low + 1 ? "*" : values.join(",");
}

export interface ParsedCron {
  /**
   * The canonical form, the only form ever sent to Hermes: each field its
   * explicit values joined by commas (`*` only when the field holds every
   * value), fields joined by one space. croniter 6.0.0 expands it to exactly
   * the lists below (tests/fixtures/croniter-6.0.0.json).
   */
  expr: string;
  minutes: number[];
  hours: number[];
  /** Day of month, 1-31. */
  days: number[];
  months: number[];
  /** Day of week, 0 (Sunday) to 6. */
  weekdays: number[];
}

/**
 * A strict five-field cron expression (minute hour day-of-month month
 * day-of-week): digits, `*`, `,`, `-`, `/` and one space between fields, at
 * most 100 characters; numbers inside each field's range (day of week 0-6); a
 * range's end above its start; a step from 1 to the field's width. No names,
 * no `?`, `L`, `W`, `#`, `@daily`, no leading, trailing or doubled spaces.
 * Anything else is null.
 *
 * A field that lists every value is `*` (so `1-31` is every day, and with a
 * restricted day of week it means that day of week only). When day of month
 * and day of week are both restricted, a day matches either (croniter's
 * default `day_or`).
 */
export function parseStrictCron(text: unknown): ParsedCron | null {
  if (typeof text !== "string" || text.length > 100 || !CRON_SHAPE_RE.test(text)) return null;
  const fields = text.split(" ");
  const parsed = fields.map((field, i) => cronField(field, FIELD_BOUNDS[i]));
  if (parsed.some((values) => values === null)) return null;
  const lists = parsed as number[][];
  return {
    expr: lists.map((values, i) => canonicalField(values, FIELD_BOUNDS[i])).join(" "),
    minutes: lists[0],
    hours: lists[1],
    days: lists[2],
    months: lists[3],
    weekdays: lists[4],
  };
}

/** Days in each month, February in a leap year: croniter searches 50 years, so 29 February is found. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Whether croniter 6.0.0 finds no next run: a restricted day of month that
 * none of the listed months has (`0 8 31 2 *`, `0 8 30 2 *`,
 * `0 8 31 4,6,9,11 *`). croniter raises CroniterBadDateError on these
 * whatever the day of week says (with both restricted it first searches the
 * day of month alone, and that search fails), so Hermes refuses them on
 * create and edit; this mirrors it.
 */
export function cronNeverFires(cron: ParsedCron): boolean {
  if (cron.days.length === 31) return false;
  return !cron.months.some((month) => cron.days.some((day) => day <= MONTH_DAYS[month - 1]));
}

/**
 * Whether the only day the schedule can run on is 29 February (`0 8 29 2 *`):
 * croniter accepts it (the next run is up to four years away), these commands
 * refuse it with the impossible dates, so every accepted schedule fires
 * within any year. (With day of week restricted too, a day matches either, so
 * it runs weekly and is not this case.)
 */
export function cronLeapDayOnly(cron: ParsedCron): boolean {
  if (cron.days.length === 31 || cron.weekdays.length < 7) return false;
  return cron.months.every((month) => cron.days.every((day) => day > MONTH_DAYS[month - 1] || (month === 2 && day === 29)));
}

/**
 * Whether the schedule fires more than once in some hour: two or more minute
 * values. (With one minute value two firings are at least 60 minutes apart.)
 */
export function cronFrequent(cron: ParsedCron): boolean {
  return cron.minutes.length > 1;
}

/** Whether a calendar date is one the schedule runs on (month, then day of month and day of week). */
export function cronRunsOn(cron: ParsedCron, year: number, month: number, day: number): boolean {
  if (!cron.months.includes(month)) return false;
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const byDay = cron.days.includes(day);
  const byWeekday = cron.weekdays.includes(weekday);
  return cron.days.length < 31 && cron.weekdays.length < 7 ? byDay || byWeekday : byDay && byWeekday;
}

// ── Clocks ──────────────────────────────────────────────────────────────────

const formatters = new Map<string, Intl.DateTimeFormat>();

function wallParts(at: Date | number, tz: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let format = formatters.get(tz);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(tz, format);
  }
  const parts = Object.fromEntries(format.formatToParts(at).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour) % 24, minute: Number(parts.minute), second: Number(parts.second),
  };
}

/** Minutes since local midnight in `tz` (wall clock, so a DST change moves it as the resident's clock moves). */
export function minuteOfDay(now: Date, tz: string): number {
  const { hour, minute } = wallParts(now, tz);
  return hour * 60 + minute;
}

function zoneOffsetMs(tz: string, instant: number): number {
  const p = wallParts(instant, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(instant / 1000) * 1000;
}

/** The instant a wall time in `tz` names (in a DST gap: the instant after it). */
export function wallTimeInstant(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(tz, guess);
  const second = guess - zoneOffsetMs(tz, first);
  return second;
}

function isoDate(at: number, tz: string): string {
  const p = wallParts(at, tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/**
 * Every firing of `cron` in Hermes's zone over `days` calendar days from the
 * day of `from` (firings before `from` skipped), grouped by the Hermes-zone
 * date it runs on. Calendar days come from date arithmetic, firings from the
 * zone: on a day whose offsets do not change the instants are computed from
 * that day's midnight, otherwise one by one.
 */
function firingsByDay(cron: ParsedCron, hermesTz: string, from: Date, days: number): number[][] {
  const start = wallParts(from, hermesTz);
  const out: number[][] = [];
  const minutesOfDay: number[] = [];
  for (const hour of cron.hours) for (const minute of cron.minutes) minutesOfDay.push(hour * 60 + minute);
  for (let i = 0; i < days; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
    if (!cronRunsOn(cron, year, month, day)) continue;
    const midnight = wallTimeInstant(year, month, day, 0, 0, hermesTz);
    const next = new Date(Date.UTC(year, month - 1, day + 1));
    const nextMidnight = wallTimeInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0, hermesTz);
    const steady = nextMidnight - midnight === 86_400_000;
    const firings = minutesOfDay
      .map((m) => (steady ? midnight + m * 60_000 : wallTimeInstant(year, month, day, Math.floor(m / 60), m % 60, hermesTz)))
      .filter((at) => at >= from.getTime());
    if (firings.length > 0) out.push(firings);
  }
  return out;
}

/** How a schedule meets a window over the horizon. */
export type WindowFit =
  /** Every day it fires, at least one firing lands in the window. */
  | { fit: "always" }
  /** No firing lands in the window. */
  | { fit: "never" }
  /** Some days do and some do not (a DST change in either zone): the first date one does not, in the job's zone. */
  | { fit: "seasonal"; outsideFrom: string }
  /** It does not fire at all in the horizon. */
  | { fit: "no-firing" };

/** Days the window check covers: a full year, so both DST changes of any zone fall inside it. */
export const WINDOW_CHECK_DAYS = 366;

/**
 * Whether a schedule run by Hermes in `hermesTz` lands inside `window` (read
 * in `jobTz`) over a year from `from`, day by day: a day it fires lands when
 * at least one of that day's firings is in the window.
 */
export function scheduleWindowFit(cron: ParsedCron, window: DeliveryWindow, jobTz: string, hermesTz: string, from: Date, days = WINDOW_CHECK_DAYS): WindowFit {
  const byDay = firingsByDay(cron, hermesTz, from, days);
  if (byDay.length === 0) return { fit: "no-firing" };
  let landed = 0;
  let firstMiss: number | null = null;
  for (const firings of byDay) {
    const first = firings[0];
    const last = firings[firings.length - 1];
    // The job zone's offset is steady over the day when it is the same at its first and last firing (and an hour apart at most).
    const steady = last - first < 86_400_000 && zoneOffsetMs(jobTz, first) === zoneOffsetMs(jobTz, last);
    const base = steady ? minuteOfDay(new Date(first), jobTz) : 0;
    const hit = firings.some((at) => inWindow(steady ? (base + Math.round((at - first) / 60_000)) % 1440 : minuteOfDay(new Date(at), jobTz), window));
    if (hit) landed++;
    else firstMiss ??= first;
  }
  if (landed === 0) return { fit: "never" };
  if (firstMiss === null) return { fit: "always" };
  return { fit: "seasonal", outsideFrom: isoDate(firstMiss, jobTz) };
}

/** The first firing strictly after `after` (Hermes's zone), or null within the horizon. The test stand-in for Hermes uses it. */
export function nextFiring(cron: ParsedCron, hermesTz: string, after: Date, days = WINDOW_CHECK_DAYS): number | null {
  for (const firings of firingsByDay(cron, hermesTz, after, days)) {
    const at = firings.find((instant) => instant > after.getTime());
    if (at !== undefined) return at;
  }
  return null;
}

// ── The carrier ─────────────────────────────────────────────────────────────

export type SettingsRead =
  | { status: "absent" }
  /** `adminSchedules` is the raw top-level value (adminScheduleKeys reads it); the trigger never does. */
  | { status: "ok"; jobs: Record<string, unknown>; adminSchedules?: unknown }
  | { status: "invalid"; code: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The settings file as read: absent, a valid `{v: 1, jobs}` object, or invalid with a code. Never throws. */
export function readJobSettings(home: string): SettingsRead {
  const path = jobSettingsPath(home);
  let text: string;
  try {
    if (!existsSync(path)) return { status: "absent" };
    const stat = statSync(path);
    if (!stat.isFile()) return { status: "invalid", code: "file-not-file" };
    if (stat.size > MAX_SETTINGS_BYTES) return { status: "invalid", code: "file-too-large" };
    text = readFileSync(path, "utf8");
  } catch {
    return { status: "invalid", code: "file-unreadable" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { status: "invalid", code: "file-not-json" };
  }
  if (!isObject(raw)) return { status: "invalid", code: "file-not-object" };
  if (raw.v !== 1) return { status: "invalid", code: "file-version" };
  const admin = raw.adminSchedules === undefined ? {} : { adminSchedules: raw.adminSchedules };
  if (raw.jobs === undefined) return { status: "ok", jobs: {}, ...admin };
  if (!isObject(raw.jobs)) return { status: "invalid", code: "file-jobs" };
  return { status: "ok", jobs: raw.jobs, ...admin };
}

/** Whether a key is one of the five default jobs (the ones reconcile's legacy schedule migration can move). */
export function isDefaultJobKey(value: unknown): value is JobKey {
  return isJobKey(value) && !value.startsWith("tpl-");
}

/**
 * The default jobs whose schedule an admin set (`set --schedule`), from the
 * file's top-level `adminSchedules` list: reconcile's legacy schedule
 * migration never moves them. Only installer code reads it (the trigger
 * ignores the key). `invalid`: the value is not a list of default job keys
 * (or the file is invalid); `keys` then holds the valid members, and
 * reconcile treats every job as admin-managed.
 */
export function adminScheduleKeys(read: SettingsRead): { keys: JobKey[]; invalid: boolean } {
  if (read.status === "absent") return { keys: [], invalid: false };
  if (read.status === "invalid") return { keys: [], invalid: true };
  const raw = read.adminSchedules;
  if (raw === undefined) return { keys: [], invalid: false };
  if (!Array.isArray(raw)) return { keys: [], invalid: true };
  const keys = [...new Set(raw.filter(isDefaultJobKey))].sort();
  return { keys, invalid: keys.length !== raw.length };
}

/** One entry's settings, or the code of the first field that fails. Unknown fields are ignored. */
export function validateEntry(entry: unknown): { window?: DeliveryWindow; tz?: string } | { invalid: string } {
  if (!isObject(entry)) return { invalid: "entry" };
  const out: { window?: DeliveryWindow; tz?: string } = {};
  if (entry.window !== undefined) {
    const window = parseWindow(entry.window);
    if (!window) return { invalid: "window" };
    out.window = window;
  }
  if (entry.tz !== undefined) {
    if (!isValidTimeZone(entry.tz)) return { invalid: "tz" };
    out.tz = entry.tz;
  }
  return out;
}

/** How one run of a job may deliver. */
export interface Delivery {
  /** null: no window (the job may deliver whenever it runs). */
  window: DeliveryWindow | null;
  tz: string;
  /** For the log line: `default` (a file, no entry), `custom`, or `invalid:<code>`; absent with no file. */
  settings?: string;
  /** The job must stay silent this run: its settings are invalid and it has no default window to fall back to. */
  hold?: boolean;
}

/** The delivery window and zone for `key`, from what readJobSettings returned. */
export function deliveryFor(key: JobKey, read: SettingsRead): Delivery {
  const fallbackWindow = DEFAULT_WINDOWS[key] ?? null;
  const invalid = (code: string): Delivery =>
    fallbackWindow
      ? { window: fallbackWindow, tz: DEFAULT_TZ, settings: `invalid:${code}` }
      : { window: null, tz: DEFAULT_TZ, settings: `invalid:${code}`, hold: true };
  if (read.status === "absent") return { window: fallbackWindow, tz: DEFAULT_TZ };
  if (read.status === "invalid") return invalid(read.code);
  if (!Object.prototype.hasOwnProperty.call(read.jobs, key)) return { window: fallbackWindow, tz: DEFAULT_TZ, settings: "default" };
  const entry = validateEntry(read.jobs[key]);
  if ("invalid" in entry) return invalid(entry.invalid);
  return { window: entry.window ?? fallbackWindow, tz: entry.tz ?? DEFAULT_TZ, settings: "custom" };
}

/**
 * The file's text for these entries and admin schedules: `{"v":1,"jobs":{...}}`
 * with keys sorted, plus `"adminSchedules":[...]` when there are any; null
 * when there is nothing to hold (the file is then removed, and the tenant is
 * back to no settings file at all).
 */
export function settingsFileText(jobs: Record<string, unknown>, adminSchedules: readonly string[] = []): string | null {
  const keys = Object.keys(jobs).sort();
  if (keys.length === 0 && adminSchedules.length === 0) return null;
  const sorted = Object.fromEntries(keys.map((key) => [key, jobs[key]]));
  const admin = adminSchedules.length > 0 ? { adminSchedules: [...adminSchedules].sort() } : {};
  return `${JSON.stringify({ v: 1, jobs: sorted, ...admin })}\n`;
}

/** The settings file's bytes now, or null when there is no file (or it cannot be read). */
export function settingsFileBytes(home: string): string | null {
  try {
    return readFileSync(jobSettingsPath(home), "utf8");
  } catch {
    return null;
  }
}

/**
 * Make the settings file hold `text` (temp file and rename, 0600 in a 0700
 * directory), or remove it when `text` is null. Only the installer's job
 * commands call it, holding the jobs lock; the content must already be validated.
 */
export function replaceSettingsFile(home: string, text: string | null): void {
  const path = jobSettingsPath(home);
  if (text === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Replace the settings file with these entries and admin schedules (removed when both are empty). */
export function writeJobSettings(home: string, jobs: Record<string, { window?: string; tz?: string }>, adminSchedules: readonly string[] = []): void {
  replaceSettingsFile(home, settingsFileText(jobs, adminSchedules));
}

// ── The team gate ───────────────────────────────────────────────────────────

/** The variable that marks a team tenant (process environment, else `$HERMES_HOME/.env`). */
export const TEAM_TENANT_VAR = "AV_TEAM_TENANT";

/**
 * Whether this tenant is a team (test) tenant: `AV_TEAM_TENANT` is exactly
 * `1` once surrounding whitespace is trimmed, and nothing else (no quote
 * stripping: `"1"` is refused). The process environment wins when the
 * variable is set there at all (even empty); else the last assignment in
 * `$HERMES_HOME/.env`, as python-dotenv reads it. The control plane sets it
 * from the same match as `isTeam`; nothing in the overlay sets it, so a
 * tenant without it refuses every preview. The resident controls both
 * places: this is defence in depth, and the control plane's own team check
 * is the authoritative gate (docs/design/job-settings.md §5).
 */
export function isTeamTenant(home: string): boolean {
  const fromEnv = process.env[TEAM_TENANT_VAR];
  if (fromEnv !== undefined) return fromEnv.trim() === "1";
  let value: string | undefined;
  try {
    for (const line of readFileSync(join(home, ".env"), "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?AV_TEAM_TENANT\s*=(.*)$/.exec(line);
      if (match) value = match[1];
    }
  } catch {
    // no .env, or unreadable: unset
  }
  return value !== undefined && value.trim() === "1";
}

// ── Preview leftovers ───────────────────────────────────────────────────────

/** A preview state copy, a preview shim or a preview job older than this is pruned. */
export const PREVIEW_MAX_AGE_MS = 60 * 60 * 1000;

const PREVIEW_COPY_RE = /^preview-[A-Za-z0-9]{6}$/;
const PREVIEW_SHIM_RE = /^agentvillage_proactive_preview-(.+)\.sh$/;

/**
 * Remove preview leftovers older than PREVIEW_MAX_AGE_MS (by modification
 * time): the trigger's private state copies `av-events/proactive/preview-*`
 * (left only when the trigger was killed before its own cleanup) and, unless
 * `shims` is false, the preview shims `scripts/agentvillage_proactive_preview-<key>.sh`.
 * Names outside those exact shapes, symlinks and younger entries are left.
 * Never throws; returns how many of each went.
 */
export function prunePreviewFiles(home: string, nowMs: number, options: { shims?: boolean } = {}): { copies: number; shims: number } {
  const removed = { copies: 0, shims: 0 };
  const old = (path: string, kind: "dir" | "file"): boolean => {
    try {
      const stat = lstatSync(path);
      if (kind === "dir" ? !stat.isDirectory() : !stat.isFile()) return false;
      return nowMs - stat.mtimeMs > PREVIEW_MAX_AGE_MS;
    } catch {
      return false;
    }
  };
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };
  const copies = join(home, "av-events", "proactive");
  for (const name of list(copies)) {
    if (!PREVIEW_COPY_RE.test(name) || !old(join(copies, name), "dir")) continue;
    try {
      rmSync(join(copies, name), { recursive: true, force: true });
      removed.copies++;
    } catch {
      // left for the next prune
    }
  }
  if (options.shims === false) return removed;
  const scripts = join(home, "scripts");
  for (const name of list(scripts)) {
    const match = PREVIEW_SHIM_RE.exec(name);
    if (!match || !isJobKey(match[1]) || !old(join(scripts, name), "file")) continue;
    try {
      rmSync(join(scripts, name), { force: true });
      removed.shims++;
    } catch {
      // left for the next prune
    }
  }
  return removed;
}

