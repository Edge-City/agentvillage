#!/usr/bin/env bun
/**
 * The attendee directory, read through the Agent Village control plane (DATA-454).
 *
 *   bun skills/edgeos/scripts/directory.ts [--search WORDS] [--skip N] [--limit N] [--hide-empty]
 *                                          [--popup UUID] [--json]
 *
 * Since EdgeOS v1.47 a resident's session token lives 15 minutes, so the box's `EDGEOS_BEARER_TOKEN`
 * is dead almost at once. The directory now goes box → control plane → Agent Village app → EdgeOS:
 * the app reads it with the resident's own Edge City sign-in, which it refreshes itself, and returns
 * rows only. This script calls `GET $CONTROL_PLANE_URL/tenants/$TENANT_ID/edgeos/directory` with
 * `Authorization: Bearer $EDGEOS_API_KEY` (the attendee key the box already holds; the control plane
 * checks it against the tenant's own) and allow-listed query parameters only: `q` (1-120 characters),
 * `skip` (0-5000), `limit` (1-100, default 20), `hide_empty_rows=true` and `popup_id` (a UUID).
 *
 * Fallback (Carter, 14 Oct): only when the control plane is not connected (a cp setting missing, or it
 * answered 401, 403, 404 or 409) does the script try EdgeOS's own directory,
 * `GET $EDGEOS_API_BASE/applications/my/directory/{popup}` (the old §9 endpoint and parameters), with
 * `Authorization: Bearer $EDGEOS_API_KEY` as events.ts sends it, and only to an EdgeOS host
 * (`apiBase()` from events.ts). EdgeOS answers an API key 403 there today, so that ends in exit 2;
 * once EdgeOS grants API keys `portal:directory:read`, it works with no overlay change. A 429, 5xx,
 * timeout or network error from the control plane is exit 1 at once, with no second call. Both paths
 * print the same projected shape; stderr ends with one word, `via=cp`, `via=direct` (or `via=none`
 * when nothing was called), so a read-back can tell them apart.
 *
 * `CONTROL_PLANE_URL`, `TENANT_ID`, `EDGEOS_API_KEY`, `EDGEOS_API_BASE` and `AV_POPUP_ID` come from the
 * environment, else from `$HERMES_HOME/.env` (`setting()` from events.ts). The key never appears in the
 * command, the output or an error, and travels only in the Authorization header. Security (commit
 * review, 14 Oct): it is sent only over https to an exact host on a hard-coded list, `CP_HOSTS` for the
 * control plane and `EDGEOS_HOSTS` (events.ts) for EdgeOS, with no userinfo, no other port, and for
 * EdgeOS only the documented `/api/v1` base; anything else is refused with no request sent (exit 2).
 * `TENANT_ID` and `popup_id` must be UUIDs and the query goes through URLSearchParams, so no argument
 * or setting can change the host or the path. Redirects are not followed (`redirect: "manual"`); a
 * 3xx is exit 1.
 * The rows are projected to the skill's §9 fields, so a field added upstream cannot widen the output;
 * a `"*"` (a field the attendee hid) is kept as is (`hidden` in the line output).
 *
 * Exit codes (the skill's fail-soft, §9):
 *   0 printed (no match included);
 *   2 not connected: the key missing, or the control plane not connected (a setting missing, or 401,
 *     403, 404 for the route not deployed yet or a popup without a directory, 409 for no live Edge City
 *     grant) and the direct path not connected either (401, 403, 404, 409, or nothing to call);
 *   1 can't reach it right now: 429, 5xx, a timeout, a network error or an unreadable answer from the
 *     path that answered last;
 *   3 a usage error (the line says which), or the answering path refused the arguments (400/422).
 */
import { DEFAULT_BASE, apiBase, setting } from "./events";

export const MAX_Q = 120;
export const MAX_SKIP = 5000;
export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;
export const TIMEOUT_MS = 15_000;
/** The largest answer read; 100 rows are far below it. */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

export const EXIT_OK = 0;
export const EXIT_UNAVAILABLE = 1;
export const EXIT_NOT_CONNECTED = 2;
export const EXIT_USAGE = 3;

/** The §9 row fields, in order; anything else upstream is dropped. */
export const FIELDS = [
  "id", "first_name", "last_name", "email", "telegram", "role", "organization", "residence", "age", "gender",
  "picture_url", "category", "participation", "associated_attendees",
] as const;
export const PARTICIPATION_FIELDS = ["id", "name", "slug", "category", "duration_type"] as const;
/** Error codes the control plane or app may send that are safe to name on stderr (never the body itself). */
const KNOWN_CODES = new Set([
  "unauthorized", "not_linked", "ambiguous", "directory_forbidden", "directory_not_found", "param_unknown",
  "param_invalid", "rate_limited", "busy", "edgeos_unavailable", "directory_unavailable", "not found",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Control plane hosts the key may be sent to: the agentvillage-goa project's production service (CONTEXT.md §3). */
export const CP_HOSTS = ["control-plane-production-606c.up.railway.app"] as const;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

type Env = Record<string, string | undefined>;
type Row = Record<string, unknown>;

export interface Args {
  q: string;
  skip: number;
  limit: number;
  hideEmpty: boolean;
  popup: string;
  json: boolean;
}

export interface Result {
  code: number;
  out: string;
  err: string;
}

export interface Options {
  timeoutMs?: number;
}

const USAGE =
  "usage: bun skills/edgeos/scripts/directory.ts [--search WORDS] [--skip N] [--limit N] [--hide-empty] [--popup UUID] [--json]\n";

function wholeNumber(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** The arguments, each checked here as the control plane checks it. */
export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { q: "", skip: 0, limit: DEFAULT_LIMIT, hideEmpty: false, popup: "", json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      return v;
    };
    try {
      if (arg === "--search") {
        const q = value().trim();
        if (q.length < 1 || q.length > MAX_Q) return { error: `--search must be 1 to ${MAX_Q} characters` };
        if (CONTROL.test(q)) return { error: "--search must not contain control characters" };
        args.q = q;
      } else if (arg === "--skip") {
        const n = wholeNumber(value(), 0, MAX_SKIP);
        if (n === null) return { error: `--skip must be a whole number from 0 to ${MAX_SKIP}` };
        args.skip = n;
      } else if (arg === "--limit") {
        const n = wholeNumber(value(), 1, MAX_LIMIT);
        if (n === null) return { error: `--limit must be a whole number from 1 to ${MAX_LIMIT}` };
        args.limit = n;
      } else if (arg === "--hide-empty") args.hideEmpty = true;
      else if (arg === "--popup") {
        const popup = value().trim();
        if (!UUID.test(popup)) return { error: "--popup must be a popup id (a UUID)" };
        args.popup = popup.toLowerCase();
      } else if (arg === "--json") args.json = true;
      else return { error: `unknown argument ${arg}` };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }
  return args;
}

/**
 * The control plane's origin when `raw` is exactly https on a host in `CP_HOSTS` (hostname compared
 * exactly, no suffix match), port 443 or none, no userinfo, no path beyond `/`, no query or fragment;
 * else null, and the key is not sent.
 */
export function controlPlaneBase(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null;
  if (url.port && url.port !== "443") return null;
  if (url.pathname !== "/") return null;
  if (!(CP_HOSTS as readonly string[]).includes(url.hostname.toLowerCase())) return null;
  return `https://${url.hostname.toLowerCase()}`;
}

/** The EdgeOS base for the direct path: `apiBase()` from events.ts (EdgeOS hosts only), and only the documented path. */
export function directBase(raw: string): string | null {
  const base = apiBase(raw);
  return base === DEFAULT_BASE ? base : null;
}

/** The query string: allow-listed parameters only. */
export function query(args: Args, defaultPopup: string): URLSearchParams {
  const params = new URLSearchParams();
  if (args.q) params.set("q", args.q);
  params.set("skip", String(args.skip));
  params.set("limit", String(args.limit));
  if (args.hideEmpty) params.set("hide_empty_rows", "true");
  const popup = args.popup || (UUID.test(defaultPopup) ? defaultPopup.toLowerCase() : "");
  if (popup) params.set("popup_id", popup);
  return params;
}

function pick(source: Row, keys: readonly string[]): Row {
  const out: Row = {};
  for (const key of keys) out[key] = key in source ? source[key] : null;
  return out;
}

/** One row with the §9 fields only; each ticket with its five fields only. */
export function projectRow(raw: unknown): Row {
  const source = raw && typeof raw === "object" ? (raw as Row) : {};
  const row = pick(source, FIELDS);
  row.participation = Array.isArray(source.participation)
    ? source.participation.map((p) => pick(p && typeof p === "object" ? (p as Row) : {}, PARTICIPATION_FIELDS))
    : [];
  row.associated_attendees = Array.isArray(source.associated_attendees) ? source.associated_attendees : [];
  return row;
}

export interface Page {
  results: Row[];
  paging: { offset: number | null; limit: number | null; total: number | null };
}

/** The answer as `{results, paging}` with §9 fields only; null when it is not that shape. */
export function project(body: unknown): Page | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as Row).results)) return null;
  const paging = ((body as Row).paging && typeof (body as Row).paging === "object" ? (body as Row).paging : {}) as Row;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return {
    results: ((body as Row).results as unknown[]).map(projectRow),
    paging: { offset: num(paging.offset), limit: num(paging.limit), total: num(paging.total) },
  };
}

function shown(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value === "*") return "hidden";
  return String(value).replace(/\s+/g, " ").trim();
}

/** One line for one attendee: `"*"` reads as `hidden`, an empty field is left out. */
export function attendeeLine(row: Row): string {
  const first = shown(row.first_name);
  const last = shown(row.last_name);
  const name = first === "hidden" && last === "hidden" ? "hidden" : [first, last].filter(Boolean).join(" ");
  const bits = [`name: ${name || "(none)"}`];
  for (const key of ["email", "telegram", "role", "organization", "residence", "age", "gender", "category"]) {
    const v = shown(row[key]);
    if (v !== null) bits.push(`${key}: ${v}`);
  }
  const tickets = (row.participation as Row[]).map((p) => shown(p.name)).filter(Boolean);
  if (tickets.length) bits.push(`tickets: ${tickets.join(", ")}`);
  const picture = shown(row.picture_url);
  if (picture) bits.push(`picture: ${picture}`);
  const id = shown(row.id);
  if (id) bits.push(`id ${id}`);
  return bits.join(" · ");
}

export function pagingLine(page: Page, args: Args): string {
  const { offset, total } = page.paging;
  const from = offset ?? args.skip;
  const count = page.results.length;
  let line = `paging: offset ${from}, showing ${count}, total ${total ?? "unknown"}`;
  if (total !== null && from + count < total && count > 0) line += ` (more: --skip ${from + count})`;
  return line;
}

/** The safe error code from an error body, if it is one we know; never the body itself. */
function errorCode(text: string): string {
  try {
    const body = JSON.parse(text) as Row;
    const code = typeof body?.error === "string" ? body.error : typeof body?.code === "string" ? body.code : "";
    return KNOWN_CODES.has(code) ? code : "";
  } catch {
    return "";
  }
}

async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return null;
  return new TextDecoder().decode(buf);
}

type Via = "cp" | "direct";
type Attempt =
  | { kind: "ok"; page: Page }
  | { kind: "not_connected"; why: string }
  | { kind: "unavailable"; why: string }
  | { kind: "usage"; why: string };

/** One GET to one path, sorted into the fail-soft classes. Never reads out the key or an error body. */
async function attempt(url: string, key: string, fetchImpl: typeof fetch, timeoutMs: number): Promise<Attempt> {
  let res: Response;
  let text: string | null;
  try {
    res = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      redirect: "manual", // a redirect is never followed, so the key never goes on to another URL
      signal: AbortSignal.timeout(timeoutMs),
    });
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      return { kind: "unavailable", why: `answered ${res.status} (a redirect, not followed)` };
    }
    text = await readCapped(res);
  } catch (e) {
    const name = e instanceof Error ? e.name : "error";
    return { kind: "unavailable", why: name === "TimeoutError" || name === "AbortError" ? "timed out" : `network error (${name})` };
  }
  const status = res.status;
  if (status === 200) {
    let body: unknown;
    try {
      body = text === null ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const page = project(body);
    return page ? { kind: "ok", page } : { kind: "unavailable", why: "the answer was not a directory listing" };
  }
  const code = text ? errorCode(text) : "";
  const tag = code ? `${status} ${code}` : String(status);
  if (status === 404 && code === "directory_not_found") {
    return { kind: "not_connected", why: `this popup has no attendee directory (${tag})` };
  }
  if (status === 401 || status === 403 || status === 404 || status === 409) return { kind: "not_connected", why: `answered ${tag}` };
  if (status === 400 || status === 422) return { kind: "usage", why: `refused the arguments (${tag})` };
  if (status === 429) return { kind: "unavailable", why: `busy (${tag})` };
  return { kind: "unavailable", why: `answered ${tag}` };
}

/** The EdgeOS directory URL for the direct path: the same endpoint and parameters the old §9 curl used. */
export function directUrl(base: string, popup: string, args: Args): string {
  const params = new URLSearchParams();
  params.set("skip", String(args.skip));
  params.set("limit", String(args.limit));
  if (args.q) params.set("q", args.q);
  if (args.hideEmpty) params.set("hide_empty_rows", "true");
  return `${base}/applications/my/directory/${popup}?${params.toString()}`;
}

/** The printed result, the same for both paths; `via=<path>` is the last word on stderr. */
function finish(a: Attempt, via: Via, args: Args, before = ""): Result {
  const tail = ` via=${via}\n`;
  const prior = before ? `${before}; ` : "";
  if (a.kind === "ok") {
    if (args.json) return { code: EXIT_OK, out: `${JSON.stringify(a.page)}\n`, err: `via=${via}\n` };
    const lines = a.page.results.length ? a.page.results.map(attendeeLine) : ["no attendees matching"];
    lines.push(pagingLine(a.page, args));
    return { code: EXIT_OK, out: `${lines.join("\n")}\n`, err: `via=${via}\n` };
  }
  if (a.kind === "not_connected") {
    return { code: EXIT_NOT_CONNECTED, out: "", err: `directory: not connected: ${prior}${via} ${a.why}${tail}` };
  }
  if (a.kind === "usage") return { code: EXIT_USAGE, out: "", err: `directory: ${prior}${via} ${a.why}${tail}${USAGE}` };
  return { code: EXIT_UNAVAILABLE, out: "", err: `directory: can't reach the directory right now: ${prior}${via} ${a.why}${tail}` };
}

const notConnected = (why: string): Result => ({
  code: EXIT_NOT_CONNECTED, out: "", err: `directory: not connected: ${why}\n`,
});

/**
 * The control plane first. Only when it is not connected (a cp setting missing, or 401, 403, 404,
 * 409) is EdgeOS's own directory tried with the box's API key, on the EdgeOS host only. EdgeOS
 * answers an API key 403 on the directory today, so that ends in exit 2 as before; once EdgeOS grants
 * API keys `portal:directory:read`, the same script works with no overlay change. A 429, 5xx, timeout
 * or network error from the control plane is exit 1 at once, with no second call.
 */
export async function run(argv: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch,
  options: Options = {}): Promise<Result> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return { code: EXIT_USAGE, out: "", err: `directory: ${parsed.error}\n${USAGE}` };
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const key = setting("EDGEOS_API_KEY", env);
  if (!key) return notConnected("EDGEOS_API_KEY is not set");
  const popupDefault = setting("AV_POPUP_ID", env);

  const rawBase = setting("CONTROL_PLANE_URL", env);
  const tenant = setting("TENANT_ID", env);
  let cpWhy = "";
  let cpCalled = false;
  if (!rawBase) cpWhy = "CONTROL_PLANE_URL is not set";
  else if (!tenant) cpWhy = "TENANT_ID is not set";
  else if (!controlPlaneBase(rawBase)) cpWhy = `CONTROL_PLANE_URL is not https on ${CP_HOSTS.join(", ")}; the key is not sent there`;
  else if (!UUID.test(tenant)) cpWhy = "TENANT_ID is not a tenant id (a UUID)";

  if (!cpWhy) {
    const params = query(parsed, popupDefault);
    const url = `${controlPlaneBase(rawBase)}/tenants/${tenant.toLowerCase()}/edgeos/directory?${params.toString()}`;
    const cp = await attempt(url, key, fetchImpl, timeoutMs);
    cpCalled = true;
    if (cp.kind !== "not_connected") return finish(cp, "cp", parsed);
    cpWhy = `cp ${cp.why}`;
  }

  // The direct path: EdgeOS's own directory, the key sent only over https to an EdgeOS host.
  const edgeos = directBase(setting("EDGEOS_API_BASE", env));
  const popup = parsed.popup || (UUID.test(popupDefault) ? popupDefault.toLowerCase() : "");
  const via = cpCalled ? "cp" : "none";
  if (!edgeos) return notConnected(`${cpWhy}; EDGEOS_API_BASE is not ${DEFAULT_BASE}, so no direct call via=${via}`);
  if (!popup) return notConnected(`${cpWhy}; AV_POPUP_ID is not set, so no direct call via=${via}`);
  const direct = await attempt(directUrl(edgeos, popup, parsed), key, fetchImpl, timeoutMs);
  return finish(direct, "direct", parsed, cpWhy);
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
