#!/usr/bin/env bun
/**
 * Who the resident passed on, and why: their own passes and the reasons they picked in the Agent Village
 * app (NOT-A-FIT agent read, the overlay half; spec §3 "The overlay script + tools.md").
 *
 *   bun skills/index-network/scripts/passes.ts [--notes] [--limit N]
 *
 * Run through `terminal` with exactly `command` plus `workdir` = the absolute HERMES_HOME (tools.md, "Who
 * they passed on, and why"): approval classes that shape as exec.local, rule skill-script.
 *
 * Only in the resident's own private chat: in a group, a channel, a cron run, or a session with nothing to
 * say it is theirs (no chat type and no TTY), it prints PRIVATE_ONLY and exits 0 before any call, as
 * recall.ts's `query` refuses there (`privateSession`, below). Their reasons stay out of shared rooms.
 *
 * Two reads, both the resident's own:
 *
 * 1. The control plane: `GET $CONTROL_PLANE_URL/tenants/$TENANT_ID/index/passes?limit=N[&notes=1]` with
 *    `Authorization: Bearer $EDGEOS_API_KEY` (cp `control-plane/src/index-passes.js`, the box's own key,
 *    checked as the EdgeOS profile route checks it). It answers `200 {passes: [{opportunity_id, passed_at,
 *    reason_code, note?}]}`, newest first, `note` only with notes=1; it refuses with 401 `unauthorized`,
 *    400 `param_unknown`/`param_invalid`, 429 `rate_limited`, 503 `passes_unavailable`. The wire is
 *    skills/edgeos/scripts/profile.ts's, reused rather than copied:
 *    - the settings from the environment, else `$HERMES_HOME/.env` (`setting()`, events.ts:89-93);
 *    - https to an exact host on `CP_HOSTS` only, port 443, no userinfo, path or query
 *      (`controlPlaneBase()`, directory.ts:171-183, the list at :92); `TENANT_ID` must be a UUID (:90),
 *      and the query is built with URLSearchParams, so no setting or argument changes the host or path;
 *    - redirects not followed (`redirect: "manual"`, a 3xx is a failure: `attempt()`, directory.ts:322-330);
 *    - `TIMEOUT_MS` = 22 s (directory.ts:63);
 *    - the key only in the Authorization header (directory.ts:324); never in the URL, argv, stdout or
 *      stderr; an error body is never read out (directory.ts:286-294).
 *    The note is asked for only with `--notes`: without it the cp never sends one (and one it sent anyway
 *    is not printed).
 *
 * 2. Index, for the names: one `list_opportunities` with `{statuses: ["rejected"], limit: 50}` through the
 *    shared MCP client (`callIndexTool`, index-mcp.ts:256; 20 s timeout, no redirects, codes-only errors),
 *    with the box's `INDEX_API_KEY` (environment, else `$HERMES_HOME/.env`: custody strips it from the
 *    terminal's environment, plugins/av-approval/_custody.py), to `$INDEX_MCP_URL` or production as every
 *    Index script does (index-mcp.ts:36-38). Joined on the opportunity id.
 *
 * Output (stdout): a header, then one line per pass: the name linked to `peer.url` (tools.md's Rolodex /
 * profile link), the day it was passed (village time, IST), and the reason as the app's label
 * (REASON_LABELS, the app's src/lib/not-a-fit.ts:30-36 at app#497 657f3dcb); with `--notes` only, the note,
 * cleaned (NFKC, controls dropped, `<` and `>` escaped, one line, at most 280 code points) and framed
 * `<their_note>…</their_note>`. A pass Index does not name is "someone you passed on". When the cp list is
 * complete (fewer rows than the limit), a pass Index lists that the cp holds no row for (a pass the agent
 * made itself, spec §7 Q5) follows with "no reason given".
 *
 * No id is ever printed (tools.md "Never expose internal IDs"): no opportunity or tenant id; a name that
 * carries a UUID is not printed; a peer link that is not plain https, could break the markdown link, or
 * carries the opportunity id is dropped (the name stays).
 *
 * Degraded cases exit 0 with one plain line first (spec §3):
 *   - the cp not answering passes (a setting missing or not pinned, 401, 404, 503, 429, 400, a redirect, a
 *     timeout, an unreadable answer): REASONS_UNAVAILABLE, then the Index list alone;
 *   - Index not answering (no key, an MCP error, an unreadable list): NAMES_UNAVAILABLE, then the cp list
 *     with each pass "someone you passed on";
 *   - both: NOTHING_AVAILABLE and nothing else.
 * stderr is empty on a clean run; a degraded run adds one line of codes (`passes: cp=<…> index=<…>`), never a
 * key, a note, a name or a body. Exit 3 is a usage error (nothing called).
 *
 * Writes nothing: no file, no event, no memory.
 */
import { setting } from "../../edgeos/scripts/events";
import { type Env, TIMEOUT_MS, UUID, attempt, controlPlaneBase } from "../../edgeos/scripts/directory";
import { DEFAULT_INDEX_MCP_URL, INDEX_MCP_TIMEOUT_MS, callIndexTool, toolJsonArray } from "./index-mcp";

/** The cp route's own range (index-passes.js LIMIT_DEFAULT / LIMIT_MAX). */
export const LIMIT_DEFAULT = 20;
export const LIMIT_MAX = 50;
/** One Index read for the names (spec §3). */
export const INDEX_LIST_LIMIT = 50;
/** The cp's note cap (cp#331 NOTE_MAX, the app's NOTE_MAX), in code points. */
export const NOTE_MAX = 280;
const NAME_MAX = 80;

export const EXIT_OK = 0;
export const EXIT_USAGE = 3;

/** The app's labels, word for word (app src/lib/not-a-fit.ts:30-36 at app#497 657f3dcb). */
export const REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  off_target: "Not what I’m looking for",
  not_now: "Not the right time",
  already_know: "I already know them",
  little_in_common: "Not enough in common",
  other: "Something else",
});
export const NO_REASON = "no reason given";
/** A code the app does not have: never printed raw. */
export const REASON_NOT_SHOWN = "reason not shown";

export const HEADER = "Who they passed on (their reasons and notes are theirs alone: never share or save them):";
export const UNNAMED = "someone you passed on";
export const NO_PASSES = "No passes found.";
export const REASONS_UNAVAILABLE = "Reasons aren't available right now.";
export const NAMES_UNAVAILABLE = "Names aren't available right now.";
export const NOTHING_AVAILABLE = "Their passes aren't available right now.";
/** The one line a group, channel, cron or unidentified session gets (nothing is called). */
export const PRIVATE_ONLY = "I can only show this in your private chat with me.";

const USAGE = "usage: bun skills/index-network/scripts/passes.ts [--notes] [--limit N]\n";
const SEP = " — ";

export interface Args {
  notes: boolean;
  limit: number;
}
export interface Result {
  code: number;
  out: string;
  err: string;
}
export interface Options {
  /** Tests only: the cp call's timeout (default TIMEOUT_MS, 22 s). */
  timeoutMs?: number;
  /** Tests only: the Index call's timeout (default INDEX_MCP_TIMEOUT_MS, 20 s). */
  indexTimeoutMs?: number;
  /** Tests only: whether stdin is a TTY (default `process.stdin.isTTY`). */
  tty?: boolean;
}

/** `[--notes] [--limit N]`, each at most once; anything else is a usage error. */
export function parseArgs(argv: string[]): Args | { error: string } {
  const args: Args = { notes: false, limit: LIMIT_DEFAULT };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (seen.has(arg)) return { error: `${arg} given twice` };
    seen.add(arg);
    if (arg === "--notes") args.notes = true;
    else if (arg === "--limit") {
      const raw = argv[++i];
      if (raw === undefined || !/^[1-9][0-9]?$/.test(raw) || Number(raw) > LIMIT_MAX) {
        return { error: `--limit must be a whole number from 1 to ${LIMIT_MAX}` };
      }
      args.limit = Number(raw);
    } else return { error: "unknown argument" }; // never echoed: it could be anything
  }
  return args;
}

// ---------------------------------------------------------------------------
// The session: the resident's own private chat only.

/**
 * recall.ts's `sessionIsPrivate(env, tty)`, its `sessionVerdict` being "main" (skills/recall/scripts/
 * recall.ts:225-248), copied, not imported: the recall skill is staged only for tenants who opted in
 * (install/install_recall.ts), so an import would fail to load on every other box. passes.test.ts holds
 * this copy to recall.ts's verdict. Hermes exports the gateway's session to terminal commands
 * (tools/environments/local.py `_inject_session_context_env`); a value in `$HERMES_HOME/.env` does not
 * count, only the process's own.
 */
const DIRECT_CHAT_TYPES = new Set(["dm", "private", "direct", "c2c"]);
const LOCAL_SURFACES = new Set(["cli", "tui", "desktop", "local"]);
const norm = (value: string | undefined) => (value ?? "").trim().toLowerCase();

export function privateSession(env: Env, tty: boolean): boolean {
  const chatType = norm(env.HERMES_SESSION_CHAT_TYPE);
  const idents = [env.HERMES_PLATFORM, env.HERMES_SESSION_PLATFORM, env.HERMES_SESSION_SOURCE].map(norm).filter(Boolean);
  const sessionId = (env.HERMES_SESSION_ID ?? "").trim();
  if (norm(env.HERMES_CRON_SESSION) === "1" || sessionId.startsWith("cron_") || idents.includes("cron")) return false;
  if (DIRECT_CHAT_TYPES.has(chatType)) return true;
  if (chatType !== "") return false;
  if (idents.length > 0) return idents.every((ident) => LOCAL_SURFACES.has(ident));
  return tty;
}

// ---------------------------------------------------------------------------
// Cleaning: the note is the resident's own text, a name is Index's; both are data, never instructions.

// deno-lint-ignore no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Bidi embeddings, overrides and isolates, and the marks: they can reorder what the reader sees. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/**
 * Every format character (Unicode Cf), after NFKC: zero-width spaces and joiners, the BOM, the soft hyphen,
 * invisible operators and the tag block (U+E0001, U+E0020-E007F, "ASCII smuggling"), which a reader cannot
 * see but a model may read (review-a ov#453 S3; Hermes's INVISIBLE_CHARS, tools/threat_patterns.py),
 * and every other default-ignorable code point: variation selectors, Hangul fillers, the combining
 * grapheme joiner and the unassigned ignorables (review-a S-F1). An emoji loses its U+FE0F; it still shows.
 */
const FORMAT = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const LINE_BREAKS = /[\t\n\v\f\r\u0085\u2028\u2029]/g;
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function clip(text: string, max: number): string {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join("") : text;
}

/** NFKC, line breaks to spaces, controls/bidi/format characters/lone surrogates dropped, spaces collapsed, clipped. */
function tidy(raw: string, max: number): string {
  const text = raw
    .normalize("NFKC")
    .replace(LINE_BREAKS, " ")
    .replace(CONTROLS, "")
    .replace(BIDI, "")
    .replace(FORMAT, "")
    .replace(LONE_SURROGATE, "")
    .replace(/\s+/g, " ")
    .trim();
  return clip(text, max).trim();
}

const escapeAngles = (text: string) => text.replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The note as printed inside the frame: NFKC, controls dropped, one line, at most NOTE_MAX, `<` `>` escaped. */
export function cleanNote(raw: string): string {
  return escapeAngles(tidy(raw, NOTE_MAX));
}

export function frameNote(raw: string): string {
  return `<their_note>${cleanNote(raw)}</their_note>`;
}

/**
 * A name as printed: cleaned as a note is, with `\`, `[` and `]` escaped for the markdown link (the backslash
 * too, else a name ending `\` turns the escaped `]` back into a live one: review-a ov#453 S2); null when
 * empty or id-like.
 */
function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = tidy(raw, NAME_MAX);
  if (!text || UUID_ANYWHERE.test(text)) return null;
  return escapeAngles(text).replace(/[\\[\]]/g, (c) => `\\${c}`);
}

/**
 * A peer's profile link, when it is plain https (no userinfo), at most 512 characters, holds nothing that
 * could end or nest the markdown link, and does not carry the opportunity id; else null (the name stays).
 */
function peerLink(raw: unknown, opportunityId: string): string | null {
  if (typeof raw !== "string" || raw.length > 512 || !/^https:\/\//i.test(raw)) return null;
  if (/[\s()[\]<>"'`\\]/.test(raw) || CONTROL.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (raw.toLowerCase().includes(opportunityId.toLowerCase())) return null;
  return raw;
}

/** The day a pass was made, in village time (IST, UTC+5:30): `20 Oct`; null when the time is unreadable. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function villageDay(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const ist = new Date(ms + 330 * 60_000);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]}`;
}

function reasonLabel(code: string | null): string {
  if (code === null) return NO_REASON;
  return Object.hasOwn(REASON_LABELS, code) ? REASON_LABELS[code] : REASON_NOT_SHOWN;
}

// ---------------------------------------------------------------------------
// The control plane's answer

export interface CpPass {
  opportunity_id: string;
  passed_at: string | null;
  reason_code: string | null;
  note: string | null;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/** `{passes: [...]}` to the four fields only (rows without a string id dropped); null when not that shape. */
export function projectPasses(body: unknown): CpPass[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const passes = (body as Record<string, unknown>).passes;
  if (!Array.isArray(passes)) return null;
  const out: CpPass[] = [];
  for (const row of passes) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const id = str(r.opportunity_id);
    if (!id) continue;
    out.push({ opportunity_id: id, passed_at: str(r.passed_at), reason_code: str(r.reason_code), note: str(r.note) });
  }
  return out;
}

type CpRead = { ok: true; passes: CpPass[] } | { ok: false; why: string };

async function readCp(args: Args, env: Env, fetchImpl: typeof fetch, timeoutMs: number): Promise<CpRead> {
  const key = setting("EDGEOS_API_KEY", env);
  const rawBase = setting("CONTROL_PLANE_URL", env);
  const tenant = setting("TENANT_ID", env);
  if (!key) return { ok: false, why: "no-key" };
  if (!rawBase) return { ok: false, why: "no-url" };
  if (!tenant) return { ok: false, why: "no-tenant" };
  const base = controlPlaneBase(rawBase);
  if (!base) return { ok: false, why: "url-not-pinned" };
  if (!UUID.test(tenant)) return { ok: false, why: "tenant-not-uuid" };
  const query = new URLSearchParams({ limit: String(args.limit) });
  if (args.notes) query.set("notes", "1");
  const url = `${base}/tenants/${tenant.toLowerCase()}/index/passes?${query.toString()}`;
  const a = await attempt(url, key, fetchImpl, timeoutMs, projectPasses, "a passes list");
  if (a.kind === "ok") return { ok: true, passes: a.value.slice(0, args.limit) };
  return { ok: false, why: a.why.replace(/[^A-Za-z0-9 ._()-]/g, "").slice(0, 80) };
}

// ---------------------------------------------------------------------------
// Index's names

interface Named {
  name: string | null;
  link: string | null;
}
type IndexRead = { ok: true; byId: Map<string, Named>; passed: string[] } | { ok: false; why: string };

async function readIndex(env: Env, fetchImpl: typeof fetch, timeoutMs: number): Promise<IndexRead> {
  const apiKey = setting("INDEX_API_KEY", env);
  if (!apiKey) return { ok: false, why: "no-key" };
  const mcpUrl = env.INDEX_MCP_URL?.trim() || DEFAULT_INDEX_MCP_URL;
  try {
    const text = await callIndexTool({ apiKey, mcpUrl, fetch: fetchImpl, timeoutMs }, "list_opportunities", {
      statuses: ["rejected"],
      limit: INDEX_LIST_LIMIT,
    });
    const byId = new Map<string, Named>();
    const passed: string[] = [];
    for (const row of toolJsonArray(text, "opportunities")) {
      if (!row || typeof row !== "object") continue;
      const r = row as Record<string, unknown>;
      const id = str(r.id)?.toLowerCase();
      if (!id || byId.has(id)) continue;
      const peer = r.peer && typeof r.peer === "object" ? (r.peer as Record<string, unknown>) : {};
      byId.set(id, { name: cleanName(peer.name), link: peerLink(peer.url, id) });
      if (str(r.status)?.trim().toLowerCase() === "rejected") passed.push(id);
    }
    return { ok: true, byId, passed };
  } catch (e) {
    const code = (e as { code?: unknown })?.code;
    return { ok: false, why: typeof code === "string" && /^[a-z0-9:-]{1,40}$/.test(code) ? code : "error" };
  }
}

// ---------------------------------------------------------------------------

function who(named: Named | undefined): string {
  if (!named?.name) return UNNAMED;
  return named.link ? `[${named.name}](${named.link})` : named.name;
}

/** Both reads (at once), then the lines. Never throws; exit 0 unless the arguments are wrong. */
export async function run(argv: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch,
  options: Options = {}): Promise<Result> {
  if (!privateSession(env, options.tty ?? Boolean(process.stdin.isTTY))) {
    return { code: EXIT_OK, out: `${PRIVATE_ONLY}\n`, err: "" };
  }
  const parsed = parseArgs(argv);
  if ("error" in parsed) return { code: EXIT_USAGE, out: "", err: `passes: ${parsed.error}\n${USAGE}` };

  const [cp, index] = await Promise.all([
    readCp(parsed, env, fetchImpl, options.timeoutMs ?? TIMEOUT_MS),
    readIndex(env, fetchImpl, options.indexTimeoutMs ?? INDEX_MCP_TIMEOUT_MS),
  ]);

  const err = cp.ok && index.ok ? "" : `passes: cp=${cp.ok ? "ok" : cp.why} index=${index.ok ? "ok" : index.why}\n`;
  if (!cp.ok && !index.ok) return { code: EXIT_OK, out: `${NOTHING_AVAILABLE}\n`, err };

  const out: string[] = [];
  const items: string[] = [];
  if (cp.ok) {
    if (!index.ok) out.push(NAMES_UNAVAILABLE);
    const byId = index.ok ? index.byId : new Map<string, Named>();
    const listed = new Set<string>();
    for (const pass of cp.passes) {
      const id = pass.opportunity_id.toLowerCase();
      listed.add(id);
      const parts = [who(byId.get(id))];
      const day = villageDay(pass.passed_at);
      if (day) parts.push(day);
      parts.push(reasonLabel(pass.reason_code));
      if (parsed.notes && pass.note !== null && cleanNote(pass.note)) parts.push(frameNote(pass.note));
      items.push(`- ${parts.join(SEP)}`);
    }
    // A complete cp list: a pass Index lists with no cp row has no reason recorded (spec §7 Q5).
    if (index.ok && cp.passes.length < parsed.limit) {
      for (const id of index.passed) {
        if (items.length >= parsed.limit) break;
        if (listed.has(id)) continue;
        items.push(`- ${who(index.byId.get(id))}${SEP}${NO_REASON}`);
      }
    }
  } else if (index.ok) {
    out.push(REASONS_UNAVAILABLE);
    for (const id of index.passed.slice(0, parsed.limit)) items.push(`- ${who(index.byId.get(id))}`);
  }
  if (items.length) out.push(HEADER, ...items);
  else out.push(NO_PASSES);
  return { code: EXIT_OK, out: `${out.join("\n")}\n`, err };
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
