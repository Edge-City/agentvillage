#!/usr/bin/env bun
/**
 * Railway status watcher (CLAIMS L18050, L18092). Reads status.railway.com's
 * own JSON feed and posts ONE Telegram message per change (a new incident, or
 * an incident whose status moved) to the operator group, through the alerts
 * bot. It runs on GitHub Actions in this public repo
 * (.github/workflows/railway-status-notify.yml), not on Railway, so it still
 * speaks when Railway is down. Ops tooling only: nothing on a box runs it, and
 * it holds no secret (the Telegram variables come from the environment).
 * Self-contained: bun and node: built-ins, no imports from this repo.
 * README.md beside it is the runbook.
 *
 *   bun .github/railway-status/railway-status-notify.ts --state <file>             # fetch, diff, send, write state
 *   bun .github/railway-status/railway-status-notify.ts --state <file> --dry-run   # print what would be sent; no token, nothing written
 *
 * The feed is `https://status.railway.com/api/status` (the page's own data
 * call): `activeIncidents` and `recentIncidents`, each with `id`, `slug`,
 * `title`, `status`, `createdAt`, `resolvedAt`, `components` (name,
 * groupName, impact) and `updates` (status, message, createdAt). An
 * incident's status is its newest update's (the top-level field can lag),
 * RESOLVED once `resolvedAt` is set; its updated time is the newest of its
 * updates, `resolvedAt` and `createdAt`. A newest update with no status (a
 * note) leaves the status at the newest update that has one.
 *
 * **State** is a JSON file, incident id -> {status, updatedAt}. No file (or
 * an unreadable one) is a first run: every incident is recorded and only the
 * unresolved ones are posted, so an empty cache never replays old resolved
 * incidents. An incident absent from the feed keeps its entry (a short or
 * glitched feed never makes old incidents look new); entries older than
 * `PRUNE_DAYS` go. A NEW incident that is already resolved and was last
 * updated more than `STALE_NEW_MS` ago is recorded silently.
 *
 * **Failures.** A feed that cannot be fetched or is not the expected shape
 * (either incident list missing or not an array, or ANY incident lacking an
 * id, title, status or created time, as after a field rename): exit 1,
 * nothing sent, the state file untouched (so one malformed incident keeps
 * every run red until Railway fixes it or it leaves the feed: loud on
 * purpose). A Telegram 400 whose description is a known CONTENT error
 * (message too long, text not UTF-8, empty text, entities that cannot be
 * parsed) refuses that one message for good: it is logged
 * (`railway_status.send_refused`), recorded as done so it never blocks later
 * alerts, the rest are sent, and the run exits 1. Every other failure
 * (unreachable, 429, 5xx, any other 4xx including a bodyless 400, an unknown
 * description, a migrated supergroup, missing rights, 409): the messages sent
 * before it are recorded, the rest are not (the next run sends them again),
 * the state is written, exit 1. Missing or malformed
 * Telegram variables (not in dry run): exit 2, named, never their values; the
 * feed is not fetched. Delivery is at least once: a send whose answer is lost
 * is sent again.
 *
 * Telegram: `ALERTS_TELEGRAM_BOT_TOKEN`, `ALERTS_TELEGRAM_CHAT_ID` and,
 * optional, `ALERTS_TELEGRAM_THREAD_ID` (a forum topic), the same names and
 * shapes as the agentvillage-data alerts notifier. Plain text, no parse
 * mode, no link preview. Logs carry codes, incident slugs and counts only:
 * never the token, the chat or thread id, the feed body, or Telegram's
 * response body. The logs are public and GitHub reads a line starting with
 * `::` as a workflow command, so every feed-derived value in a log line is
 * gated (`logRef`, `logStatus`: anything else is `invalid`), and a dry run
 * prints each message line behind `| `.
 *
 * With `GITHUB_OUTPUT` set it appends `changed=true|false` (whether the state
 * file was written) and `sent=<n>`, so the workflow saves its cache only when
 * something moved.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";

export const FEED_URL = "https://status.railway.com/api/status";
export const PAGE_URL = "https://status.railway.com";
export const TELEGRAM_ORIGIN = "https://api.telegram.org";

export const TOKEN_ENV = "ALERTS_TELEGRAM_BOT_TOKEN";
export const CHAT_ENV = "ALERTS_TELEGRAM_CHAT_ID";
export const THREAD_ENV = "ALERTS_TELEGRAM_THREAD_ID";

/** Same shapes as the agentvillage-data alerts notifier (src/ops/telegram-notifier.ts there). */
const TOKEN_RE = /^[0-9]{5,16}:[A-Za-z0-9_-]{30,64}$/;
const CHAT_RE = /^-?[0-9]{1,20}$/;
const THREAD_RE = /^[1-9][0-9]{0,15}$/;
const SLUG_RE = /^[A-Za-z0-9]{4,32}$/;
const LOG_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOG_STATUS_RE = /^[A-Z_]{1,32}$/;

/** An incident as a log line may name it: its slug or id when plainly safe, else `invalid`. */
export function logRef(inc: { slug: string | null; id: string }): string {
  const r = inc.slug ?? inc.id;
  return LOG_REF_RE.test(r) ? r : "invalid";
}

/** A status as a log line may show it, else `invalid`. */
export function logStatus(status: string): string {
  return LOG_STATUS_RE.test(status) ? status : "invalid";
}

export const STATE_VERSION = 1;
export const PRUNE_DAYS = 90;
/** A first-seen incident that is resolved and quiet for this long is recorded, not posted. */
export const STALE_NEW_MS = 24 * 60 * 60 * 1000;
export const FEED_TIMEOUT_MS = 20_000;
export const TELEGRAM_TIMEOUT_MS = 10_000;
/** Telegram's limit is 4096; the alerts notifier keeps to 3800. */
export const MAX_CHARS = 3_800;
export const MAX_UPDATE_CHARS = 500;

export type Component = { name: string; group: string | null; impact: string | null };

export type Incident = {
  id: string;
  slug: string | null;
  title: string;
  /** Upper case as the feed has it: INVESTIGATING, IDENTIFIED, MONITORING, RESOLVED, TRIAGE, ... */
  status: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  components: Component[];
  latestMessage: string | null;
};

export type StateEntry = { status: string; updatedAt: string };
export type State = { version: number; incidents: Record<string, StateEntry> };

export type Change =
  | { kind: "new"; incident: Incident }
  | { kind: "status"; incident: Incident; from: string };

export type Diff = {
  /** In feed order, oldest first, so a thread reads in time order. */
  changes: Change[];
  /** The state with every change applied (the caller drops the ones it failed to send). */
  next: State;
  /** Incidents recorded without a message (first run, or stale and resolved). */
  silent: number;
};

export class FeedError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "FeedError";
  }
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function ms(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function latest(a: string, b: string | null): string {
  if (b === null) return a;
  return ms(b) > ms(a) ? b : a;
}

/** One incident from the feed, or null when it lacks an id, title, status or created time. */
export function parseIncident(raw: unknown): Incident | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const id = str(r.id);
  const title = str(r.title);
  const top = str(r.status);
  const createdAt = str(r.createdAt);
  if (id === null || title === null || top === null || createdAt === null || !Number.isFinite(Date.parse(createdAt))) return null;
  const resolvedAt = str(r.resolvedAt);
  const slugRaw = str(r.slug);
  const slug = slugRaw !== null && SLUG_RE.test(slugRaw) ? slugRaw : null;

  const components: Component[] = [];
  if (Array.isArray(r.components)) {
    for (const c of r.components) {
      if (typeof c !== "object" || c === null) continue;
      const cr = c as Record<string, unknown>;
      const name = str(cr.name);
      if (name === null) continue;
      components.push({ name, group: str(cr.groupName), impact: str(cr.impact) });
    }
  }

  // Newest update by time, never by array order; the status from the newest update that has one.
  let newest: { message: string | null; at: string } | null = null;
  let newestStatus: { status: string; at: string } | null = null;
  if (Array.isArray(r.updates)) {
    for (const u of r.updates) {
      if (typeof u !== "object" || u === null) continue;
      const ur = u as Record<string, unknown>;
      const at = str(ur.createdAt);
      if (at === null || !Number.isFinite(Date.parse(at))) continue;
      if (newest === null || ms(at) > ms(newest.at)) newest = { message: str(ur.message), at };
      const st = str(ur.status);
      if (st !== null && (newestStatus === null || ms(at) > ms(newestStatus.at))) newestStatus = { status: st, at };
    }
  }

  let status = (newestStatus?.status ?? top).toUpperCase();
  if (resolvedAt !== null || top.toUpperCase() === "RESOLVED") status = "RESOLVED";
  let updatedAt = createdAt;
  if (newest !== null) updatedAt = latest(updatedAt, newest.at);
  updatedAt = latest(updatedAt, resolvedAt);

  return { id, slug, title, status, createdAt, updatedAt, resolvedAt, components, latestMessage: newest?.message ?? null };
}

/**
 * The feed's incidents, active and recent, one per id, oldest first. Throws
 * `FeedError("feed_shape")` when either list is missing or not an array, and
 * `FeedError("feed_shape_incident")` when any incident does not parse: the
 * feed is undocumented, and a renamed field must fail the run, not empty it.
 */
export function parseFeed(body: unknown): { incidents: Incident[]; skipped: number } {
  if (typeof body !== "object" || body === null) throw new FeedError("feed_shape");
  const b = body as Record<string, unknown>;
  const lists = [b.activeIncidents, b.recentIncidents];
  if (!lists.every(Array.isArray)) throw new FeedError("feed_shape");
  const byId = new Map<string, Incident>();
  let skipped = 0;
  for (const list of lists as unknown[][]) {
    for (const raw of list) {
      const inc = parseIncident(raw);
      if (inc === null) {
        skipped++;
        continue;
      }
      const prev = byId.get(inc.id);
      // The same incident in both lists: keep the fresher copy.
      if (prev === undefined || ms(inc.updatedAt) > ms(prev.updatedAt)) byId.set(inc.id, inc);
    }
  }
  if (skipped > 0) throw new FeedError("feed_shape_incident");
  const incidents = [...byId.values()].sort((a, b) => ms(a.createdAt) - ms(b.createdAt) || a.id.localeCompare(b.id));
  return { incidents, skipped };
}

export type Fetch = (input: string, init: RequestInit) => Promise<Response>;

export async function fetchFeed(fetchImpl: Fetch, timeoutMs = FEED_TIMEOUT_MS): Promise<{ incidents: Incident[]; skipped: number }> {
  let res: Response;
  try {
    res = await fetchImpl(FEED_URL, {
      method: "GET",
      headers: { accept: "application/json", "user-agent": "agentvillage-data railway-status watcher (GitHub Actions)" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new FeedError("feed_unreachable");
  }
  if (!res.ok) throw new FeedError(`feed_http_${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new FeedError("feed_not_json");
  }
  return parseFeed(body);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** The state from its file's text, or null (a first run) when absent, unreadable or not this version. */
export function parseState(text: string | null): State | null {
  if (text === null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== STATE_VERSION || typeof r.incidents !== "object" || r.incidents === null || Array.isArray(r.incidents)) return null;
  const incidents: Record<string, StateEntry> = {};
  for (const [id, e] of Object.entries(r.incidents as Record<string, unknown>)) {
    if (typeof e !== "object" || e === null) continue;
    const er = e as Record<string, unknown>;
    const status = str(er.status);
    const updatedAt = str(er.updatedAt);
    if (status !== null && updatedAt !== null) incidents[id] = { status, updatedAt };
  }
  return { version: STATE_VERSION, incidents };
}

export function serializeState(state: State): string {
  const ids = Object.keys(state.incidents).sort();
  const incidents: Record<string, StateEntry> = {};
  for (const id of ids) incidents[id] = state.incidents[id]!;
  return `${JSON.stringify({ version: STATE_VERSION, incidents }, null, 2)}\n`;
}

/**
 * Old state against the feed. `prev === null` is a first run: everything is
 * recorded, only unresolved incidents are posted.
 */
export function diffState(prev: State | null, incidents: Incident[], now: Date): Diff {
  const seed = prev === null;
  const nextIncidents: Record<string, StateEntry> = {};
  const cutoff = now.getTime() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
  // Keep what the feed no longer lists, unless it is old.
  if (prev !== null) {
    for (const [id, e] of Object.entries(prev.incidents)) {
      if (ms(e.updatedAt) >= cutoff) nextIncidents[id] = e;
    }
  }
  const changes: Change[] = [];
  let silent = 0;
  for (const inc of incidents) {
    const entry: StateEntry = { status: inc.status, updatedAt: inc.updatedAt };
    const old = prev?.incidents[inc.id];
    nextIncidents[inc.id] = entry;
    if (old === undefined) {
      const resolved = inc.status === "RESOLVED";
      if (seed ? resolved : resolved && now.getTime() - ms(inc.updatedAt) > STALE_NEW_MS) silent++;
      else changes.push({ kind: "new", incident: inc });
    } else if (old.status !== inc.status) {
      changes.push({ kind: "status", incident: inc, from: old.status });
    }
  }
  return { changes, next: { version: STATE_VERSION, incidents: nextIncidents }, silent };
}

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

function words(s: string): string {
  return s.toLowerCase().replace(/_/g, " ");
}

/** At most `max` code points, never half a surrogate pair. */
export function cut(s: string, max: number): string {
  const cps = Array.from(s);
  return cps.length > max ? `${cps.slice(0, max - 3).join("").trimEnd()}...` : s;
}

function oneLine(s: string, max: number): string {
  return cut(s.replace(/\s+/g, " ").trim(), max);
}

function utc(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * "Builds: US West (California, USA), EU West (Amsterdam, Netherlands) [partial outage]",
 * one entry per component name and impact, in the feed's order.
 */
export function formatComponents(components: Component[]): string {
  if (components.length === 0) return "none listed";
  const groups = new Map<string, { name: string; impact: string | null; regions: string[] }>();
  for (const c of components) {
    const key = `${c.name}\u0000${c.impact ?? ""}`;
    let g = groups.get(key);
    if (g === undefined) {
      g = { name: c.name, impact: c.impact, regions: [] };
      groups.set(key, g);
    }
    if (c.group !== null && !g.regions.includes(c.group)) g.regions.push(c.group);
  }
  return [...groups.values()]
    .map((g) => `${g.name}${g.regions.length > 0 ? `: ${g.regions.join(", ")}` : ""}${g.impact !== null ? ` [${words(g.impact)}]` : ""}`)
    .join("; ");
}

export function incidentLink(inc: Incident): string {
  return inc.slug !== null ? `${PAGE_URL}/incident/${inc.slug}` : PAGE_URL;
}

export function formatMessage(change: Change): string {
  const inc = change.incident;
  const status = words(inc.status);
  let head: string;
  if (change.kind === "new") head = inc.status === "RESOLVED" ? `Railway incident (new, already resolved)` : `Railway incident NEW: ${status}`;
  else if (inc.status === "RESOLVED") head = `Railway incident RESOLVED (was ${words(change.from)})`;
  else head = `Railway incident ${status} (was ${words(change.from)})`;
  const lines = [
    head,
    oneLine(inc.title, 300),
    `Components: ${oneLine(formatComponents(inc.components), 1200)}`,
  ];
  if (inc.latestMessage !== null) lines.push(`Latest update: ${oneLine(inc.latestMessage, MAX_UPDATE_CHARS)}`);
  lines.push(`Started ${utc(inc.createdAt)}, updated ${utc(inc.updatedAt)}`);
  lines.push(incidentLink(inc));
  return cut(lines.join("\n"), MAX_CHARS);
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

export type TelegramConfig = { token: string; chatId: string; threadId?: number };

/** The config, or the names of the variables that are missing or malformed (never their values). */
export function telegramFromEnv(env: Record<string, string | undefined>): { ok: true; config: TelegramConfig } | { ok: false; invalid: string[] } {
  const invalid: string[] = [];
  const token = env[TOKEN_ENV] ?? "";
  const chatId = env[CHAT_ENV] ?? "";
  const thread = env[THREAD_ENV] ?? "";
  if (!TOKEN_RE.test(token)) invalid.push(TOKEN_ENV);
  if (!CHAT_RE.test(chatId)) invalid.push(CHAT_ENV);
  if (thread !== "" && !THREAD_RE.test(thread)) invalid.push(THREAD_ENV);
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, config: thread !== "" ? { token, chatId, threadId: Number(thread) } : { token, chatId } };
}

/**
 * A send that failed. `permanent`: Telegram refused this message's content
 * (`CONTENT_RE`); sending it again would fail the same way. The message is a
 * code only, never the URL (which holds the token) nor Telegram's text.
 */
export class SendError extends Error {
  constructor(
    readonly code: string,
    readonly permanent: boolean,
  ) {
    super(code);
    this.name = "SendError";
  }
}

/**
 * The only refusals skipped (recorded as done): a 400 whose description says
 * the message's own text is bad. Anything else is retried, so a wrong chat,
 * missing rights or a description we do not know never loses an alert.
 */
export const CONTENT_RE = /message is too long|must be encoded in UTF-8|message text is empty|text must be non-empty|can't parse entities/i;

/** Sends one plain-text message (no parse mode, no link preview). Throws `SendError`. */
export async function sendTelegram(fetchImpl: Fetch, config: TelegramConfig, text: string, timeoutMs = TELEGRAM_TIMEOUT_MS): Promise<void> {
  const body: Record<string, unknown> = { chat_id: config.chatId, text, link_preview_options: { is_disabled: true } };
  if (config.threadId !== undefined) body.message_thread_id = config.threadId;
  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_ORIGIN}/bot${config.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new SendError("telegram_unreachable", false);
  }
  if (res.ok) return;
  const s = res.status;
  if (s === 400) {
    let description = "";
    try {
      const j = (await res.json()) as { description?: unknown };
      if (typeof j.description === "string") description = j.description;
    } catch {
      // no body: not a known content error, so retried
    }
    if (CONTENT_RE.test(description)) throw new SendError("telegram_http_400_content", true);
  }
  throw new SendError(`telegram_http_${s}`, false);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

export type RunOptions = {
  fetch?: Fetch;
  now?: () => Date;
  print?: (line: string) => void;
  /** Log lines (codes, ids, counts). */
  log?: (line: string) => void;
  readFile?: (path: string) => string | null;
  writeFile?: (path: string, text: string) => void;
  appendOutput?: (line: string) => void;
};

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function defaultWrite(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function runRailwayStatus(argv: string[], env: Record<string, string | undefined> = process.env, opts: RunOptions = {}): Promise<number> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const log = opts.log ?? ((line: string) => console.error(line));
  const fetchImpl = opts.fetch ?? (fetch as unknown as Fetch);
  const readFile = opts.readFile ?? defaultRead;
  const writeFile = opts.writeFile ?? defaultWrite;
  const ghOut = env.GITHUB_OUTPUT;
  const appendOutput = opts.appendOutput ?? (ghOut ? (line: string) => appendFileSync(ghOut, `${line}\n`) : () => {});

  let dryRun = false;
  let statePath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") dryRun = true;
    else if (a === "--state" && argv[i + 1] !== undefined && statePath === null) statePath = argv[++i]!;
    else {
      log("railway_status.bad_arguments code=unknown_argument");
      return 1;
    }
  }
  if (statePath === null) {
    log("railway_status.bad_arguments code=state_required");
    return 1;
  }

  let config: TelegramConfig | null = null;
  if (!dryRun) {
    const t = telegramFromEnv(env);
    if (!t.ok) {
      log(`railway_status.config_invalid variables=${t.invalid.join(",")}`);
      return 2;
    }
    config = t.config;
  }

  let feed: { incidents: Incident[]; skipped: number };
  try {
    feed = await fetchFeed(fetchImpl);
  } catch (e) {
    const code = e instanceof FeedError ? e.code : "feed_error";
    log(`railway_status.feed_failed code=${code}`);
    appendOutput("changed=false");
    appendOutput("sent=0");
    return 1;
  }

  const prev = parseState(readFile(statePath));
  const now = opts.now?.() ?? new Date();
  const diff = diffState(prev, feed.incidents, now);
  log(
    `railway_status.diff incidents=${feed.incidents.length} skipped=${feed.skipped} first_run=${prev === null} changes=${diff.changes.length} silent=${diff.silent}${dryRun ? " dry_run=1" : ""}`,
  );

  if (dryRun) {
    if (diff.changes.length === 0) print("(nothing to send)");
    for (const c of diff.changes) {
      print(`--- would send (${c.kind}, ${logRef(c.incident)}) ---`);
      for (const line of formatMessage(c).split(/\r\n|\r|\n/)) print(`| ${line}`);
    }
    appendOutput("changed=false");
    appendOutput("sent=0");
    return 0;
  }

  // Send in order. A message Telegram refuses for good is recorded as done
  // and the rest go on; any other failure stops the batch and puts back the
  // old entries of the ones not sent, so the next run sends them.
  const next = diff.next;
  let sent = 0;
  let refused = 0;
  let failed: string | null = null;
  const putBack = (id: string) => {
    const old = prev?.incidents[id];
    if (old === undefined) delete next.incidents[id];
    else next.incidents[id] = old;
  };
  for (const c of diff.changes) {
    const ref = logRef(c.incident);
    const status = logStatus(c.incident.status);
    if (failed !== null) {
      putBack(c.incident.id);
      continue;
    }
    try {
      await sendTelegram(fetchImpl, config!, formatMessage(c));
      sent++;
      log(`railway_status.sent kind=${c.kind} incident=${ref} status=${status}`);
    } catch (e) {
      const err = e instanceof SendError ? e : new SendError("telegram_error", false);
      if (err.permanent) {
        refused++;
        log(`railway_status.send_refused code=${err.code} incident=${ref} status=${status} kind=${c.kind}`);
        continue;
      }
      failed = err.code;
      log(`railway_status.send_failed code=${failed} incident=${ref}`);
      putBack(c.incident.id);
    }
  }

  const text = serializeState(next);
  const changed = prev === null || text !== serializeState(prev);
  if (changed) writeFile(statePath, text);
  appendOutput(`changed=${changed}`);
  appendOutput(`sent=${sent}`);
  return failed === null && refused === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exit(await runRailwayStatus(process.argv.slice(2)));
}
