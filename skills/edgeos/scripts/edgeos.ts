#!/usr/bin/env bun
/**
 * Every EdgeOS call the edgeos skill makes besides the day schedule, as one verb each (EDGEOS-BLOCK step B,
 * v2.1.10).
 *
 *   bun skills/edgeos/scripts/edgeos.ts list --after ISO [--before ISO] [--search WORDS] [--tag TAG]...
 *                                            [--kind KIND] [--venue UUID]... [--track UUID]... [--rsvped]
 *                                            [--popup UUID]
 *   bun skills/edgeos/scripts/edgeos.ts event <event_id> [--occurrence ISO]
 *   bun skills/edgeos/scripts/edgeos.ts rsvp <event_id> [--occurrence ISO]
 *   bun skills/edgeos/scripts/edgeos.ts cancel <event_id> [--occurrence ISO]
 *   bun skills/edgeos/scripts/edgeos.ts participants <event_id> [--occurrence ISO] [--skip N] [--limit N]
 *   bun skills/edgeos/scripts/edgeos.ts venues [--skip N] [--limit N] [--popup UUID]
 *
 * Why: the overlay installer sets the terminal's working directory to `$HERMES_HOME`, which holds the box's
 * `.env`, and approval.md core 0.4.6's credential pass refuses (as `account.credential`, human-only) a curl
 * whose header word carries an unexpanded `$EDGEOS_API_KEY` from such a directory. The skill's eleven curl
 * recipes therefore never ran on a default box. A script that reads the key from the environment itself
 * carries no `$` word at all, as events.ts, directory.ts and profile.ts already do.
 *
 * Request mapping, one request per run (the av-events plugin reads these verbs as the same operations the
 * curl recipes were, `plugins/av-events/_edgeos.py` `script_call`, and must agree with this table). The one
 * exception (EDGEOS-OCCURRENCE): an `rsvp` WITHOUT `--occurrence` first reads the event, and when the event is
 * recurring it sends no RSVP at all (below); otherwise its last request is still the one in the table:
 *   list          GET  {base}/events/portal/events?popup_id&event_status=published&start_after[&start_before]
 *                      [&search][&tags...][&kind][&venue_ids...][&track_ids...][&rsvped_only=true]
 *   event         GET  {base}/events/portal/events/{event_id}[?occurrence_start]
 *   rsvp          POST {base}/event-participants/portal/register/{event_id}             body {} or {occurrence_start}
 *   cancel        POST {base}/event-participants/portal/cancel-registration/{event_id}  body {} or {occurrence_start}
 *   participants  GET  {base}/event-participants/portal/participants?event_id[&occurrence_start]&skip&limit
 *   venues        GET  {base}/event-venues/portal/venues?popup_id&skip&limit
 *
 * Output: EdgeOS's JSON answer, as one line on stdout, exactly as the curl recipes printed it (the
 * plugin reads an RSVP's participant record and a confirming read's `my_rsvp_status` from it).
 *
 * Recurring events (EDGEOS-OCCURRENCE). EdgeOS calls an event recurring when its `rrule` is set (the series
 * master; EdgeOS event_participant/router.py `_resolve_occurrence_start`: `is_recurring = bool(event.rrule)`).
 *   - `--occurrence` takes the occurrence's start as an instant with its zone, as EdgeOS's `start_time` gives
 *     it (`2026-10-21T02:30:00Z`, sent unchanged), with an offset (`2026-10-21T08:00:00+05:30`, sent as the
 *     same instant in UTC, `2026-10-21T02:30:00Z`), or as the portal link's `?occ=` value still percent-encoded
 *     (`2026-10-21T02%3A30%3A00Z`, decoded once, then as above).
 *   - `event` on a recurring event prints one line on stderr after the JSON: without `--occurrence`, that the
 *     answer is the series' FIRST occurrence (EdgeOS reads `my_rsvp_status` and `attendee_count` of the first
 *     session when no `occurrence_start` is given); with it, `occurrence <ISO>`. stdout stays EdgeOS's JSON.
 *   - `rsvp` without `--occurrence` on a recurring event books nothing: it lists the series' next sessions
 *     (their `start`, from a list of the next RECURRING_WINDOW_DAYS days) on stderr and exits 5, so the agent
 *     asks the person which session and runs `rsvp` again with that `--occurrence`.
 *
 * The key: `EDGEOS_API_KEY`, `AV_POPUP_ID` and `EDGEOS_API_BASE` come from the environment, else from
 * `$HERMES_HOME/.env` (`setting()` from events.ts). The key is never an argument, never printed, never in
 * an error line, and goes only in the Authorization header, over https, to an EdgeOS host (`apiBase()`,
 * `EDGEOS_HOSTS`) under the documented `/api/v1` base; anything else is refused before any request.
 * Every id must be a UUID and every timestamp an ISO-8601 instant with its zone; the query goes through
 * URLSearchParams, so no argument can change the host or the path. Redirects are refused.
 * One limit, shared with events.ts, directory.ts and profile.ts (ov#437 review-b N2): Bun's own verbose-fetch
 * setting (`BUN_CONFIG_VERBOSE_FETCH`, from the environment or a cwd `.env.local`) makes bun print each request
 * with its Authorization header; this script cannot turn that off, and on a box the approval hook refuses both
 * ways to set it (an export is unclassified, a write to `$HERMES_HOME/.env*` human-only).
 *
 * Exit codes (the skill's fail-soft, as events.ts, directory.ts and profile.ts):
 *   0 printed EdgeOS's answer;
 *   1 EdgeOS unreachable, or it answered an error (the line gives the status and EdgeOS's short reason);
 *   2 not connected: EDGEOS_API_KEY or AV_POPUP_ID not set (the line says which, never a value), or
 *     EDGEOS_API_BASE not an EdgeOS https base;
 *   3 a usage error (the line says which);
 *   5 (rsvp only) a recurring event and no `--occurrence`: nothing was booked; the next sessions are listed
 *     (not 4, which the profile and directory scripts use for a lapsed sign-in, nor 2, "not connected").
 */
import { EDGEOS_HOSTS, apiBase, setting } from "./events";

/** The only base path the verbs are sent under (and the one the av-events plugin labels). */
export const API_PATH = "/api/v1";
export const MAX_SKIP = 100_000;
export const MAX_LIMIT = 1000;
export const DEFAULT_LIMIT = 100;
export const MAX_SEARCH = 200;
export const MAX_REPEAT = 20;
export const TIMEOUT_MS = 20_000;
/** At most this many characters of EdgeOS's own error reason are shown. */
export const MAX_REASON = 200;
/** A bare rsvp on a recurring event lists the sessions starting in this many days from now... */
export const RECURRING_WINDOW_DAYS = 14;
/** ...at most this many of them. */
export const MAX_SESSIONS = 10;

export const VERBS = ["list", "event", "rsvp", "cancel", "participants", "venues"] as const;
export type Verb = (typeof VERBS)[number];

type Env = Record<string, string | undefined>;

export const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
/** An instant with its zone: `2026-10-20T10:00:00Z`, `2026-10-20T15:30:00+05:30`, fractions allowed. */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;
/** A search word, tag or kind: printable, no control characters. */
const TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;

export interface Args {
  verb: Verb;
  eventId: string;
  occurrence: string;
  after: string;
  before: string;
  search: string;
  tags: string[];
  kind: string;
  venues: string[];
  tracks: string[];
  rsvped: boolean;
  popup: string;
  skip: number;
  limit: number;
}

/** Which flags each verb takes (value flags; `--rsvped` is the one switch). */
const FLAGS: Record<Verb, readonly string[]> = {
  list: ["--after", "--before", "--search", "--tag", "--kind", "--venue", "--track", "--rsvped", "--popup"],
  event: ["--occurrence"],
  rsvp: ["--occurrence"],
  cancel: ["--occurrence"],
  participants: ["--occurrence", "--skip", "--limit"],
  venues: ["--skip", "--limit", "--popup"],
};
const REPEATABLE = new Set(["--tag", "--venue", "--track"]);
const WITH_EVENT: ReadonlySet<Verb> = new Set(["event", "rsvp", "cancel", "participants"]);

export const USAGE =
  "usage: bun skills/edgeos/scripts/edgeos.ts list --after ISO [--before ISO] [--search WORDS] [--tag TAG] [--kind KIND] " +
  "[--venue UUID] [--track UUID] [--rsvped] [--popup UUID]\n" +
  "       bun skills/edgeos/scripts/edgeos.ts event|rsvp|cancel <event_id> [--occurrence ISO]\n" +
  "       bun skills/edgeos/scripts/edgeos.ts participants <event_id> [--occurrence ISO] [--skip N] [--limit N]\n" +
  "       bun skills/edgeos/scripts/edgeos.ts venues [--skip N] [--limit N] [--popup UUID]\n";

/** An ISO_RE instant naming a real calendar day and clock time (no Feb 30, no 24:00, no +25:00). */
export function validInstant(value: string): boolean {
  if (!ISO_RE.test(value) || Number.isNaN(new Date(value).getTime())) return false;
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value.slice(0, 10)) return false;
  const [hh, mm] = [Number(value.slice(11, 13)), Number(value.slice(14, 16))];
  const ss = value[16] === ":" ? Number(value.slice(17, 19)) : 0;
  const zone = value.match(/([+-])(\d{2}):(\d{2})$/);
  if (zone && (Number(zone[2]) > 23 || Number(zone[3]) > 59)) return false;
  return hh < 24 && mm < 60 && ss < 60;
}

/**
 * An `--occurrence` value as the instant EdgeOS expects, or null. A `Z` instant (EdgeOS's own `start_time`
 * form) is returned unchanged; one with an offset becomes the same instant in UTC, its fraction kept; a value
 * still percent-encoded as the portal's `?occ=` carries it (`encodeURIComponent(start_time)`) is decoded once.
 * A year outside 0001-9999 (before or after the shift) is refused. The av-events observer reads the same value
 * with `script_occurrence` (plugins/av-events/_edgeos.py); `tests/occurrence-parity.json` runs through both,
 * so the two always name the same occurrence.
 */
export function occurrenceInstant(raw: string): string | null {
  let value = raw;
  if (value.includes("%")) {
    try {
      value = decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  if (!validInstant(value) || Number(value.slice(0, 4)) < 1) return null;
  if (value.endsWith("Z")) return value;
  const m = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2})(\.\d{1,6})?)?([+-]\d{2}:\d{2})$/);
  if (!m) return null;
  const at = new Date(`${m[1]}:${m[2] ?? "00"}${m[4]}`);
  if (Number.isNaN(at.getTime()) || at.getUTCFullYear() < 1 || at.getUTCFullYear() > 9999) return null;
  return `${at.toISOString().slice(0, 19)}${m[3] ?? ""}Z`;
}

/** Whether EdgeOS treats this event as recurring: its `rrule` is set (EdgeOS `bool(event.rrule)`). */
export function isRecurring(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const rrule = (event as { rrule?: unknown }).rrule;
  return typeof rrule === "string" && rrule.trim() !== "";
}

/** An event's `start_time` when it is a valid instant (it is printed back to the agent); "" otherwise. */
function startOf(event: unknown): string {
  const start = event && typeof event === "object" ? (event as { start_time?: unknown }).start_time : undefined;
  return typeof start === "string" && validInstant(start) ? start : "";
}

/** The one stderr line an `event` read of a recurring event gets ("" for any other event). */
export function occurrenceNote(event: unknown, occurrence: string): string {
  if (!isRecurring(event)) return "";
  if (occurrence) return `occurrence ${occurrence}\n`;
  const start = startOf(event);
  return `recurring event: this is the FIRST occurrence (start ${start || "unknown"}); pass --occurrence <ISO> for another session\n`;
}

export function parseArgs(argv: string[]): Args | { error: string } {
  const verb = argv[0];
  if (!verb) return { error: "a verb is required (list, event, rsvp, cancel, participants or venues)" };
  if (!(VERBS as readonly string[]).includes(verb)) return { error: `unknown verb ${verb}` };
  const args: Args = {
    verb: verb as Verb, eventId: "", occurrence: "", after: "", before: "", search: "", tags: [], kind: "",
    venues: [], tracks: [], rsvped: false, popup: "", skip: 0, limit: DEFAULT_LIMIT,
  };
  let i = 1;
  if (WITH_EVENT.has(args.verb)) {
    const id = argv[1];
    if (id === undefined || id.startsWith("--")) return { error: `${verb} needs the event id first` };
    if (!UUID_RE.test(id)) return { error: "the event id must be a UUID" };
    args.eventId = id.toLowerCase();
    i = 2;
  }
  const seen = new Set<string>();
  for (; i < argv.length; i++) {
    const flag = argv[i];
    if (!FLAGS[args.verb].includes(flag)) return { error: `${verb} takes no argument ${flag}` };
    if (seen.has(flag) && !REPEATABLE.has(flag)) return { error: `${flag} given twice` };
    seen.add(flag);
    if (flag === "--rsvped") {
      args.rsvped = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith("--")) return { error: `${flag} needs a value` };
    switch (flag) {
      case "--occurrence": {
        const occurrence = occurrenceInstant(value);
        if (!occurrence) {
          return {
            error: "--occurrence must be the occurrence's start with its zone, e.g. 2026-10-20T10:00:00Z, " +
              "2026-10-20T15:30:00+05:30 or a portal link's ?occ= value",
          };
        }
        args.occurrence = occurrence;
        break;
      }
      case "--after":
      case "--before":
        if (!validInstant(value)) return { error: `${flag} must be an ISO-8601 time with its zone, e.g. 2026-10-20T10:00:00Z` };
        if (flag === "--after") args.after = value;
        else args.before = value;
        break;
      case "--search":
      case "--kind": {
        const text = value.trim();
        if (!text || text.length > MAX_SEARCH || !TEXT_RE.test(text)) {
          return { error: `${flag} must be 1-${MAX_SEARCH} printable characters` };
        }
        if (flag === "--search") args.search = text;
        else args.kind = text;
        break;
      }
      case "--tag": {
        const text = value.trim();
        if (!text || text.length > MAX_SEARCH || !TEXT_RE.test(text)) return { error: `--tag must be 1-${MAX_SEARCH} printable characters` };
        args.tags.push(text);
        break;
      }
      case "--venue":
      case "--track":
      case "--popup":
        if (!UUID_RE.test(value)) return { error: `${flag} must be a UUID` };
        if (flag === "--venue") args.venues.push(value.toLowerCase());
        else if (flag === "--track") args.tracks.push(value.toLowerCase());
        else args.popup = value.toLowerCase();
        break;
      case "--skip":
      case "--limit": {
        const max = flag === "--skip" ? MAX_SKIP : MAX_LIMIT;
        const min = flag === "--skip" ? 0 : 1;
        if (!/^\d{1,6}$/.test(value) || Number(value) < min || Number(value) > max) {
          return { error: `${flag} must be a whole number from ${min} to ${max}` };
        }
        if (flag === "--skip") args.skip = Number(value);
        else args.limit = Number(value);
        break;
      }
    }
  }
  if (args.tags.length > MAX_REPEAT || args.venues.length > MAX_REPEAT || args.tracks.length > MAX_REPEAT) {
    return { error: `at most ${MAX_REPEAT} of each of --tag, --venue and --track` };
  }
  if (args.verb === "list" && !args.after) {
    return { error: "list needs --after (and usually --before): without a window a recurring series comes back once" };
  }
  if (args.after && args.before && new Date(args.before).getTime() <= new Date(args.after).getTime()) {
    return { error: "--before must be later than --after" };
  }
  return args;
}

export interface Request {
  method: "GET" | "POST";
  /** The path under the base, from `/` (no base path), e.g. `/events/portal/events`. */
  path: string;
  query: URLSearchParams;
  body: Record<string, string> | null;
  /** Whether the popup id is needed (list, venues). */
  popup: boolean;
}

/** The one request a verb makes (the table in the header). `popup` is filled in by `run`. */
export function request(args: Args, popup = ""): Request {
  const q = new URLSearchParams();
  const occurrenceBody = () => (args.occurrence ? { occurrence_start: args.occurrence } : {});
  switch (args.verb) {
    case "list":
      q.set("popup_id", args.popup || popup);
      q.set("event_status", "published");
      q.set("start_after", args.after);
      if (args.before) q.set("start_before", args.before);
      if (args.search) q.set("search", args.search);
      for (const tag of args.tags) q.append("tags", tag);
      if (args.kind) q.set("kind", args.kind);
      for (const venue of args.venues) q.append("venue_ids", venue);
      for (const track of args.tracks) q.append("track_ids", track);
      if (args.rsvped) q.set("rsvped_only", "true");
      return { method: "GET", path: "/events/portal/events", query: q, body: null, popup: !args.popup };
    case "event":
      if (args.occurrence) q.set("occurrence_start", args.occurrence);
      return { method: "GET", path: `/events/portal/events/${args.eventId}`, query: q, body: null, popup: false };
    case "rsvp":
      return { method: "POST", path: `/event-participants/portal/register/${args.eventId}`, query: q, body: occurrenceBody(), popup: false };
    case "cancel":
      return {
        method: "POST", path: `/event-participants/portal/cancel-registration/${args.eventId}`, query: q,
        body: occurrenceBody(), popup: false,
      };
    case "participants":
      q.set("event_id", args.eventId);
      if (args.occurrence) q.set("occurrence_start", args.occurrence);
      q.set("skip", String(args.skip));
      q.set("limit", String(args.limit));
      return { method: "GET", path: "/event-participants/portal/participants", query: q, body: null, popup: false };
    case "venues":
      q.set("popup_id", args.popup || popup);
      q.set("skip", String(args.skip));
      q.set("limit", String(args.limit));
      return { method: "GET", path: "/event-venues/portal/venues", query: q, body: null, popup: !args.popup };
  }
}

/** EdgeOS's own short reason (`detail` as a string), one line, at most MAX_REASON characters; "" otherwise. */
export function reason(body: unknown): string {
  const detail = body && typeof body === "object" ? (body as { detail?: unknown }).detail : undefined;
  if (typeof detail !== "string") return "";
  const flat = detail.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > MAX_REASON ? `${flat.slice(0, MAX_REASON)}…` : flat;
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

const fail = (code: number, err: string): Result => ({ code, out: "", err: `edgeos: ${err}\n` });

/** One EdgeOS request: its JSON answer, or the failure Result the script exits with. */
async function send(
  url: string, method: "GET" | "POST", key: string, body: Record<string, string> | null, fetchImpl: typeof fetch,
): Promise<{ body: object } | { fail: Result }> {
  const headers: Record<string, string> = { Authorization: `Bearer ${key}`, Accept: "application/json" };
  if (body !== null) headers["Content-Type"] = "application/json";
  let res: Response;
  let text: string;
  try {
    res = await fetchImpl(url, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return { fail: fail(1, `EdgeOS unreachable (${name})`) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!res.ok) {
    const why = reason(parsed);
    const retry = res.status === 429 && /^\d{1,5}$/.test(res.headers.get("retry-after") ?? "")
      ? ` (retry after ${res.headers.get("retry-after")} s)` : "";
    const refused = res.status === 401 || res.status === 403 ? " (the key was refused)" : "";
    return { fail: fail(1, `EdgeOS answered ${res.status}${refused}${retry}${why ? `: ${why}` : ""}`) };
  }
  if (parsed === undefined || parsed === null || typeof parsed !== "object") {
    return { fail: fail(1, "EdgeOS answered something that is not JSON") };
  }
  return { body: parsed };
}

/**
 * A bare `rsvp` on a recurring event: book nothing, list the series' next sessions (`start` of each, from the
 * events list of the next RECURRING_WINDOW_DAYS days) and exit 5. A session detached from the series is its
 * own event and is booked by its own id without `--occurrence` (EdgeOS refuses one for a non-recurring event).
 */
async function recurringRefusal(
  base: string, eventId: string, event: object, env: Env, key: string, fetchImpl: typeof fetch, now: number,
): Promise<Result> {
  const own = (event as { popup_id?: unknown }).popup_id;
  const configured = setting("AV_POPUP_ID", env);
  const popup = typeof own === "string" && UUID_RE.test(own) ? own : UUID_RE.test(configured) ? configured : "";
  const lines: string[] = [];
  let listed = false;
  if (popup) {
    const q = new URLSearchParams();
    q.set("popup_id", popup.toLowerCase());
    q.set("event_status", "published");
    q.set("start_after", new Date(now).toISOString());
    q.set("start_before", new Date(now + RECURRING_WINDOW_DAYS * 86_400_000).toISOString());
    const answer = await send(`${base}/events/portal/events?${q.toString()}`, "GET", key, null, fetchImpl);
    const rows = "body" in answer ? (answer.body as { results?: unknown }).results : undefined;
    if (Array.isArray(rows)) {
      listed = true;
      const sessions: [number, string][] = [];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const { id, recurrence_master_id: master } = row as { id?: unknown; recurrence_master_id?: unknown };
        const start = startOf(row);
        if (!start || typeof id !== "string" || !UUID_RE.test(id)) continue;
        if (id.toLowerCase() === eventId) sessions.push([new Date(start).getTime(), `start ${start}`]);
        else if (typeof master === "string" && master.toLowerCase() === eventId) {
          sessions.push([new Date(start).getTime(), `start ${start} (its own event ${id.toLowerCase()}: rsvp it without --occurrence)`]);
        }
      }
      sessions.sort((a, b) => a[0] - b[0]);
      for (const [, line] of sessions.slice(0, MAX_SESSIONS)) lines.push(line);
    }
  }
  const head = "edgeos: a recurring event: nothing was booked. An RSVP is for one session: ask the person which one, " +
    "then run rsvp again with --occurrence <its start>.";
  const tail = lines.length
    ? `Next sessions (up to ${MAX_SESSIONS}, next ${RECURRING_WINDOW_DAYS} days):\n${lines.join("\n")}`
    : listed
      ? `No session starts in the next ${RECURRING_WINDOW_DAYS} days; list the series with a later window and copy the row's start.`
      : "Its sessions could not be listed; list the series with a window and copy the row's start.";
  return { code: 5, out: "", err: `${head}\n${tail}\n` };
}

export async function run(
  argv: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch, now: number = Date.now(),
): Promise<Result> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return { code: 3, out: "", err: `edgeos: ${parsed.error}\n${USAGE}` };
  const key = setting("EDGEOS_API_KEY", env);
  if (!key) return fail(2, "EDGEOS_API_KEY is not set: EdgeOS is not connected to this agent");
  const shape = request(parsed);
  const popup = shape.popup ? setting("AV_POPUP_ID", env) : "";
  if (shape.popup && !popup) return fail(2, "AV_POPUP_ID is not set: the village schedule is not connected to this agent");
  if (shape.popup && !UUID_RE.test(popup)) return fail(2, "AV_POPUP_ID is not a UUID");
  const base = apiBase(setting("EDGEOS_API_BASE", env));
  if (!base || new URL(base).pathname !== API_PATH) {
    return fail(2, `EDGEOS_API_BASE is not https://${EDGEOS_HOSTS.join(" or ")}${API_PATH}; the key is not sent anywhere else`);
  }
  if (parsed.verb === "rsvp" && !parsed.occurrence) {
    // EDGEOS-OCCURRENCE: never book a recurring event without naming the session.
    const read = await send(`${base}/events/portal/events/${parsed.eventId}`, "GET", key, null, fetchImpl);
    if ("fail" in read) return read.fail;
    if (isRecurring(read.body)) return recurringRefusal(base, parsed.eventId, read.body, env, key, fetchImpl, now);
  }
  const req = request(parsed, popup.toLowerCase());
  const query = req.query.toString();
  const answer = await send(`${base}${req.path}${query ? `?${query}` : ""}`, req.method, key, req.body, fetchImpl);
  if ("fail" in answer) return answer.fail;
  const note = parsed.verb === "event" ? occurrenceNote(answer.body, parsed.occurrence) : "";
  return { code: 0, out: `${JSON.stringify(answer.body)}\n`, err: note };
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
