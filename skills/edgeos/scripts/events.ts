#!/usr/bin/env bun
/**
 * The village schedule for a day, the weekend or the next few days, in the village's local time
 * (OVERBLOCK 4.2 item 1; approval code-gap lane 2).
 *
 *   bun skills/edgeos/scripts/events.ts --when today|tomorrow|weekend|YYYY-MM-DD
 *                                       [--days N] [--search WORDS] [--rsvped] [--json]
 *
 * It works out the local calendar days (the village zone is `$HERMES_TIMEZONE`, else Asia/Kolkata),
 * turns their local midnights into the UTC window EdgeOS wants, calls the events list once with the
 * popup id and `event_status=published`, and prints one line per event grouped by local day: local
 * start and end with the zone label, the title, the venue, the person's RSVP status and the event id.
 * The output opens with `Today is <Wkd YYYY-MM-DD> (<zone>)` (DATE-1), `Now: <Wkd YYYY-MM-DD HH:MM> <zone> (<h:mm AM/PM>)`
 * and `Listing: <the days asked for>` (DATE-1). For today it leaves out the events that already ended (their end
 * time is at or before now) and says how many; an event in progress, or one without an end time, stays (EVENTS-NOW:
 * a cron prompt carries no time of day, and a heartbeat offered a session hours after it ended).
 * Agents asked for "today" used to compute that window in inline Python, which the gate refuses.
 *
 * The script reads its own key. `EDGEOS_API_KEY`, `AV_POPUP_ID` and `EDGEOS_API_BASE` come from the
 * environment, else from `$HERMES_HOME/.env`, so it keeps working when the key is moved out of the
 * agent's environment. The key never appears in the command, the output or an error, and it is sent
 * only over https to an EdgeOS host (`EDGEOS_HOSTS`, the av-events allowlist's hosts): a base pointing
 * anywhere else is refused before any request, so a changed `EDGEOS_API_BASE` cannot carry the key
 * off the box.
 *
 * Exit codes: 0 printed (an empty schedule included); 1 EdgeOS unreachable or answered an error;
 * 2 a usage error or a missing setting (the line says which, never a value).
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** EdgeOS hosts the key may be sent to; equals plugins/av-events/edgeos_tool_allowlist.json `hosts`. */
export const EDGEOS_HOSTS = ["api.edgeos.world"] as const;
export const DEFAULT_BASE = "https://api.edgeos.world/api/v1";
export const DEFAULT_TZ = "Asia/Kolkata";
export const MAX_DAYS = 14;

type Env = Record<string, string | undefined>;

export interface EdgeEvent {
  id?: string;
  title?: string;
  start_time?: string;
  end_time?: string | null;
  venue_title?: string | null;
  custom_location_name?: string | null;
  my_rsvp_status?: string | null;
  highlighted?: boolean;
}

export interface Args {
  when: string;
  days: number;
  search: string;
  rsvped: boolean;
  json: boolean;
}

export function hermesHome(env: Env): string {
  return env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

/** One `NAME=value` from a dotenv file (`export`, quotes and an inline ` # comment` handled); "" when absent. */
export function dotenvValue(file: string, name: string): string {
  if (!existsSync(file)) return "";
  try {
    let found = "";
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m || m[1] !== name) continue;
      let value = m[2].trim();
      const quoted = value.match(/^(["'])(.*)\1(?:\s+#.*)?$/);
      value = quoted ? quoted[2] : value.replace(/\s+#.*$/, "");
      found = value.trim(); // the last assignment wins, as python-dotenv reads it
    }
    return found;
  } catch {
    return "";
  }
}

/** A setting from the environment when set and non-blank, else from `$HERMES_HOME/.env`. */
export function setting(name: string, env: Env): string {
  const fromEnv = env[name]?.trim();
  if (fromEnv) return fromEnv;
  return dotenvValue(join(hermesHome(env), ".env"), name);
}

/** The API base when it is https on an EdgeOS host (no userinfo, port 443 or none); else null. */
export function apiBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw || DEFAULT_BASE);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (!(EDGEOS_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) return null;
  if (url.port && url.port !== "443") return null;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { when: "", days: 1, search: "", rsvped: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    try {
      if (arg === "--when") args.when = value();
      else if (arg === "--days") {
        const raw = value();
        if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > MAX_DAYS) {
          return { error: `--days must be a whole number from 1 to ${MAX_DAYS}` };
        }
        args.days = Number(raw);
      } else if (arg === "--search") args.search = value().trim();
      else if (arg === "--rsvped") args.rsvped = true;
      else if (arg === "--json") args.json = true;
      else return { error: `unknown argument ${arg}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  if (!args.when) return { error: "--when is required (today, tomorrow, weekend or YYYY-MM-DD)" };
  if (!/^(today|tomorrow|weekend|\d{4}-\d{2}-\d{2})$/.test(args.when)) {
    return { error: "--when must be today, tomorrow, weekend or YYYY-MM-DD" };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(args.when) && !validDate(args.when)) return { error: `no such date ${args.when}` };
  return args;
}

function validDate(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === date;
}

/** The calendar date `now` falls on in `tz`, as YYYY-MM-DD. */
export function localDate(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Offset of `tz` from UTC at instant `at`, in milliseconds. */
function offsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The UTC instant of local midnight starting `date` in `tz`. */
export function localMidnightUtc(date: string, tz: string): Date {
  const guess = new Date(`${date}T00:00:00Z`);
  let at = new Date(guess.getTime() - offsetMs(guess, tz));
  at = new Date(guess.getTime() - offsetMs(at, tz)); // a second pass settles a DST edge
  return at;
}

/** The local days asked for. */
export function days(args: Args, now: Date, tz: string): string[] {
  const today = localDate(now, tz);
  let first: string;
  let count = args.days;
  if (args.when === "today") first = today;
  else if (args.when === "tomorrow") first = addDays(today, 1);
  else if (args.when === "weekend") {
    const dow = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 Sunday … 6 Saturday
    if (dow === 6) { first = today; count = Math.min(1 + args.days, MAX_DAYS); }
    else if (dow === 0) { first = today; count = args.days; }
    else { first = addDays(today, 6 - dow); count = Math.min(1 + args.days, MAX_DAYS); }
  } else first = args.when;
  return Array.from({ length: count }, (_, i) => addDays(first, i));
}

function zoneLabel(tz: string, at: Date): string {
  if (tz === "Asia/Kolkata") return "IST";
  const part = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
    .formatToParts(at).find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

function clock(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true })
    .format(new Date(iso));
}

/** A local date with its weekday, e.g. `Wed 2026-10-14`. */
export function isoDay(date: string): string {
  const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" })
    .format(new Date(`${date}T00:00:00Z`));
  return `${weekday} ${date}`;
}

/**
 * The two lines every listing starts with (DATE-1): today in the village zone, then the days asked for.
 * Hermes keeps the session's start date in the prompt for the life of a chat, so the model reads a
 * fresh local "today" here, above the events, on every schedule answer.
 */
export function header(args: Args, wanted: string[], now: Date, tz: string): [string, string] {
  const first = isoDay(wanted[0]);
  const span = wanted.length === 1 ? first : `${first} to ${isoDay(wanted[wanted.length - 1])}`;
  const named = /^\d/.test(args.when) ? span : `${args.when} = ${span}`;
  return [`Today is ${isoDay(localDate(now, tz))} (${zoneLabel(tz, now)})`, `Listing: ${named}`];
}

/**
 * The village clock (EVENTS-NOW), e.g. `Now: Wed 2026-10-14 18:30 IST (6:30 PM)`: the 24-hour time and, in
 * brackets, the 12-hour form the event lines use. A cron run's prompt has no time of day, so this is how a
 * scheduled job knows which of today's sessions are over.
 */
export function nowLine(now: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", hour: "2-digit", minute: "2-digit" })
    .formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `Now: ${isoDay(localDate(now, tz))} ${get("hour")}:${get("minute")} ${zoneLabel(tz, now)} (${clock(now.toISOString(), tz)})`;
}

/** True when the event's end time is at or before `now`. No end time, or one that does not parse, never counts as ended. */
export function hasEnded(event: EdgeEvent, now: Date): boolean {
  if (!event.end_time) return false;
  const end = new Date(event.end_time).getTime();
  return !Number.isNaN(end) && end <= now.getTime();
}

export function dayHeading(date: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short" })
    .format(new Date(`${date}T00:00:00Z`));
}

/** One line for one event, in local time. */
export function eventLine(event: EdgeEvent, tz: string): string {
  const start = event.start_time ? clock(event.start_time, tz) : "?";
  const end = event.end_time ? `–${clock(event.end_time, tz)}` : "";
  const label = event.start_time ? ` ${zoneLabel(tz, new Date(event.start_time))}` : "";
  const venue = event.venue_title ?? event.custom_location_name;
  const bits = [`${start}${end}${label}`, (event.title ?? "(untitled)").replace(/\s+/g, " ").trim()];
  if (venue) bits.push(venue.replace(/\s+/g, " ").trim());
  if (event.highlighted) bits.push("highlighted");
  bits.push(`RSVP: ${event.my_rsvp_status ?? "none"}`);
  if (event.id) bits.push(`id ${event.id}`);
  if (event.start_time) bits.push(`start ${event.start_time}`); // a recurring event's occurrence_start for an RSVP
  return bits.join(" · ");
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

export async function run(argv: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch,
  now: Date = new Date()): Promise<Result> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    return { code: 2, out: "", err: `events: ${parsed.error}\nusage: bun skills/edgeos/scripts/events.ts --when today|tomorrow|weekend|YYYY-MM-DD [--days N] [--search WORDS] [--rsvped] [--json]\n` };
  }
  const tz = env.HERMES_TIMEZONE?.trim() || DEFAULT_TZ;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    return { code: 2, out: "", err: "events: HERMES_TIMEZONE is not a time zone this runtime knows\n" };
  }
  const key = setting("EDGEOS_API_KEY", env);
  const popup = setting("AV_POPUP_ID", env);
  if (!popup) return { code: 2, out: "", err: "events: AV_POPUP_ID is not set: the village schedule is not connected to this agent\n" };
  if (!key) return { code: 2, out: "", err: "events: EDGEOS_API_KEY is not set: the village schedule is not connected to this agent\n" };
  const base = apiBase(setting("EDGEOS_API_BASE", env));
  if (!base) {
    return { code: 2, out: "", err: `events: EDGEOS_API_BASE is not https on ${EDGEOS_HOSTS.join(", ")}; the key is not sent anywhere else\n` };
  }

  const wanted = days(parsed, now, tz);
  const startIso = localMidnightUtc(wanted[0], tz).toISOString().replace(".000Z", "Z");
  const endIso = localMidnightUtc(addDays(wanted[wanted.length - 1], 1), tz).toISOString().replace(".000Z", "Z");
  const params = new URLSearchParams({ popup_id: popup, event_status: "published", start_after: startIso, start_before: endIso });
  if (parsed.search) params.set("search", parsed.search);
  if (parsed.rsvped) params.set("rsvped_only", "true");

  let events: EdgeEvent[];
  try {
    const res = await fetchImpl(`${base}/events/portal/events?${params.toString()}`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      const hint = res.status === 401 || res.status === 403 ? " (the key was refused)" : "";
      return { code: 1, out: "", err: `events: EdgeOS answered ${res.status}${hint}\n` };
    }
    const body = (await res.json()) as { results?: EdgeEvent[] };
    events = Array.isArray(body?.results) ? body.results : [];
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return { code: 1, out: "", err: `events: EdgeOS unreachable (${name})\n` };
  }

  events = events
    .filter((e) => typeof e.start_time === "string" && !Number.isNaN(new Date(e.start_time).getTime()))
    .sort((a, b) => new Date(a.start_time!).getTime() - new Date(b.start_time!).getTime());
  // EVENTS-NOW: today's events that already ended are left out (counted); other days are listed whole.
  const today = localDate(now, tz);
  const endedToday = (e: EdgeEvent) => localDate(new Date(e.start_time!), tz) === today && hasEnded(e, now);
  const ended = events.filter(endedToday).length;
  events = events.filter((e) => !endedToday(e));
  const [todayLine, listingLine] = header(parsed, wanted, now, tz);
  const clockLine = nowLine(now, tz);
  if (parsed.json) {
    // One JSON document, so the header lines ride as its first fields rather than as text above it.
    return { code: 0, out: `${JSON.stringify({ today: todayLine, now: clockLine, listing: listingLine, time_zone: tz, start_after: startIso, start_before: endIso, ended_earlier_today: ended, results: events })}\n`, err: "" };
  }
  const lines: string[] = [todayLine, clockLine, listingLine];
  const filtered = Boolean(parsed.search || parsed.rsvped);
  for (const day of wanted) {
    const todays = events.filter((e) => localDate(new Date(e.start_time!), tz) === day);
    const gone = day === today ? ended : 0;
    lines.push(`${dayHeading(day)} (${tz})`);
    if (gone > 0) lines.push(`  ${gone} earlier ${gone === 1 ? "event" : "events"} today already ended (not listed)`);
    if (todays.length === 0) {
      if (gone > 0) lines.push(filtered ? "  nothing more matching today" : "  nothing more today");
      else lines.push(filtered ? "  nothing matching" : "  no published events");
    }
    for (const event of todays) lines.push(`  ${eventLine(event, tz)}`);
  }
  return { code: 0, out: `${lines.join("\n")}\n`, err: "" };
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
