/**
 * Per-job delivery settings for the proactive jobs (J2, overlay half). The
 * contract is docs/design/job-settings.md; this module is the one reader and
 * the one set of grammars, shared by the trigger (proactive.ts) and the
 * installer's job commands (install/jobs.ts).
 *
 * The carrier is one file, `$HERMES_HOME/av-events/job-settings.json`:
 *
 *   {"v": 1, "jobs": {"brief": {"window": "06:30-09:00", "tz": "Asia/Kolkata"}}}
 *
 * It holds overrides only: a job with no entry runs on the defaults in this
 * file (DEFAULT_WINDOWS, DEFAULT_TZ), exactly as rc13 did, so a fleet change
 * to a default reaches every job without an override. Schedules and the
 * enabled state are not here: they live in Hermes's own job record (the
 * schedule, and the pause state), the only place Hermes reads them.
 *
 * Reading is strict and never widens a window: a value that fails its grammar
 * is never used; the job falls back to its default window when it has one,
 * and a job without a default window is held silent (`settings-invalid`)
 * rather than run around the clock. Every fallback is named in the trigger's
 * log line.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { envOrDotenv } from "./proactive-text";

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

/** The IANA areas a zone may sit in; `Etc/`, `US/` and the other backward links are refused. */
const ZONE_AREAS = new Set(["Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific"]);
const ZONE_RE = /^([A-Z][A-Za-z]+)\/[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z][A-Za-z0-9_+-]*)?$/;
let supportedZones: Set<string> | null = null;

/**
 * An IANA zone name the runtime knows, spelt exactly as the runtime spells it:
 * `UTC`, or `Area/Location` (`Area/Region/Location`) in one of the ten
 * geographic areas, accepted by the runtime's time zone database with the
 * same spelling back. Offsets (`+05:30`), POSIX names (`EST5EDT`), `Etc/` and
 * other backward links, and case variants are refused. (Bun's
 * `Intl.supportedValuesOf("timeZone")` is the older CLDR list: it has
 * `Asia/Calcutta` but not `Asia/Kolkata`, so a name it lacks is still
 * accepted when the database resolves it to itself.)
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

/** The values one strict cron field selects, or null when it is outside the grammar. */
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
        // `a-a` is refused: croniter reads a degenerate range as the whole field.
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

export interface ParsedCron {
  /** The expression as it is passed on: the five fields joined by one space. */
  expr: string;
  minutes: number[];
  hours: number[];
}

/**
 * A strict five-field cron expression (minute hour day-of-month month
 * day-of-week): digits, `*`, `,`, `-`, `/` only; numbers inside each field's
 * range (day of week 0-6); a range's end above its start; a step from 1 to
 * the field's width; at most 100 characters. No names, no `?`, `L`, `W`, `#`
 * or `@daily`. Anything else is null.
 */
export function parseStrictCron(text: unknown): ParsedCron | null {
  if (typeof text !== "string" || text.length > 100 || !/^[0-9*,/ -]+$/.test(text.trim())) return null;
  const fields = text.trim().split(/ +/);
  if (fields.length !== 5) return null;
  const parsed = fields.map((field, i) => cronField(field, FIELD_BOUNDS[i]));
  if (parsed.some((values) => values === null)) return null;
  return { expr: fields.join(" "), minutes: parsed[0]!, hours: parsed[1]! };
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

/**
 * Whether a schedule run by Hermes in `hermesTz` fires at least once inside
 * `window` (read in `jobTz`) over the `days` days from `from`. Only the minute
 * and hour fields are read, so a schedule that runs on some days only is
 * judged by its times of day.
 */
export function scheduleMeetsWindow(cron: ParsedCron, window: DeliveryWindow, jobTz: string, hermesTz: string, from: Date, days = 14): boolean {
  for (let day = 0; day < days; day++) {
    const date = wallParts(from.getTime() + day * 86_400_000, hermesTz);
    for (const hour of cron.hours) {
      for (const minute of cron.minutes) {
        const at = wallTimeInstant(date.year, date.month, date.day, hour, minute, hermesTz);
        if (inWindow(minuteOfDay(new Date(at), jobTz), window)) return true;
      }
    }
  }
  return false;
}

// ── The carrier ─────────────────────────────────────────────────────────────

export type SettingsRead =
  | { status: "absent" }
  | { status: "ok"; jobs: Record<string, unknown> }
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
  if (raw.jobs === undefined) return { status: "ok", jobs: {} };
  if (!isObject(raw.jobs)) return { status: "invalid", code: "file-jobs" };
  return { status: "ok", jobs: raw.jobs };
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
 * Replace the settings file (temp file and rename, 0600 in a 0700 directory).
 * Only the installer's job commands call it; `jobs` must already be validated.
 */
export function writeJobSettings(home: string, jobs: Record<string, { window?: string; tz?: string }>): void {
  const path = jobSettingsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const sorted = Object.fromEntries(Object.keys(jobs).sort().map((key) => [key, jobs[key]]));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ v: 1, jobs: sorted })}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

// ── The team gate ───────────────────────────────────────────────────────────

/** The variable that marks a team tenant (process environment, else `$HERMES_HOME/.env`). */
export const TEAM_TENANT_VAR = "AV_TEAM_TENANT";

/**
 * Whether this tenant is a team (test) tenant: `AV_TEAM_TENANT` is exactly
 * `1`. The control plane sets it from the same match as `isTeam`; nothing in
 * the overlay sets it, so a tenant without it refuses every preview.
 */
export function isTeamTenant(home: string): boolean {
  return envOrDotenv(TEAM_TENANT_VAR, home) === "1";
}
