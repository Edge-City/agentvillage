/**
 * The morning brief's reminder and receipt for intentions the agent inferred
 * (DATA-222).
 *
 * Two small parts of the brief context, empty unless `AV_RECORD_INTENTION` and
 * the approval path (`AV_APPROVAL_ENABLED`, `AV_APPROVAL_URL`) are on:
 *
 * - `heldForApprovalCount`: how many things the agent inferred and proposed to
 *   share are still waiting for the resident's answer in their approvals. A
 *   count only: the held text never leaves the plugin's map (R16). Nothing is
 *   approved inside the brief and the brief carries no approval link.
 * - `sharedOnYourBehalf`: inferred intentions published and not yet listed by
 *   a delivered brief, each with how it was approved (`individual`, `rule`, or
 *   absent when the map does not say): the receipt that makes "publish, then
 *   tell me" differ from "publish".
 *
 * **Where the data comes from.** The av-events plugin's own reader
 * (`$HERMES_HOME/plugins/av-events/_brief_items.py`, see its docstring and the
 * plugin README), run once with Hermes's Python and handed the ids already
 * receipted. This module never reads the plugin's map file. A published
 * intention's text was deleted from the map at publish (R16), so its words are
 * looked up on Index with `get_intent`, one call per listed item (at most
 * `RECEIPT_LIST_LIMIT`), only when there is something to receipt; without
 * them the item is listed without words.
 *
 * **Each receipt once, and not lost while briefs fail.** The brief names each
 * receipted item with a hidden marker, `<!-- digest-receipt:id=ID -->`.
 * Staging keeps the markers whose id is in the context (any other receipt
 * marker is removed, with a warning code, never a failure) and records their
 * ids in `prepared.receiptIds`. The send records, under `intentionReceipts`
 * (`{id: village date}`) in `memory/heartbeat-state.json`, the ids both in
 * `prepared.receiptIds` and in the body it sends, after the Kanban card was
 * completed. An item not recorded there is offered again by every later brief
 * until the reader's window ends: 14 days after the publish. Lost, therefore:
 * an item no delivered brief carried within 14 days of its publish (no brief
 * delivered for two weeks, or a backlog of more than three a day for that
 * long). Log entries are pruned after `RECEIPT_KEEP_DAYS`, longer than that
 * window, so the prune never re-offers an item.
 *
 * **The receipt preference** ("publish, then tell me" against "publish") is a
 * setting the control plane keeps on the tenant (DATA-259; values `none` |
 * `morning_brief`). Nothing carries it into the sandbox yet, and the two
 * choices render the same approval policy, so until a follow-up wires it this
 * module uses `RECEIPT_PREFERENCE_DEFAULT` (`morning_brief`: tell the resident
 * what was shared in their name), and "publish" behaves like "publish, then
 * tell me". `none` suppresses the receipt, never the reminder.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type ReceiptPreference = "none" | "morning_brief";
export type ApprovedBy = "individual" | "rule";

/** Used until the tenant's setting reaches the sandbox (see the module comment). */
export const RECEIPT_PREFERENCE_DEFAULT: ReceiptPreference = "morning_brief";
/** Receipts in one brief; the rest wait for the next brief, oldest first. */
export const RECEIPT_LIST_LIMIT = 3;
/** heartbeat-state key: receipted intention id -> the village date of the brief that carried it. */
export const RECEIPT_STATE_KEY = "intentionReceipts";
/** The reader's window (`RECEIPT_WINDOW_S` in `_brief_items.py`), in days. */
export const RECEIPT_WINDOW_DAYS = 14;
/** Longer than the reader's window, so pruning never re-offers an item. */
export const RECEIPT_KEEP_DAYS = 21;
export const READER_TIMEOUT_MS = 15_000;
export const READER_MAX_BUFFER = 1024 * 1024;
export const READER_VERSION = 2;
export const READER_RELATIVE_PATH = join("plugins", "av-events", "_brief_items.py");

const VILLAGE_TZ = "Asia/Kolkata";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * A well-formed receipt marker, on one line: `digest-receipt` in any case,
 * optional blanks around `:` and `=`, an optional `id=`, an optionally quoted id.
 */
const RECEIPT_MARKER = /<!--[ \t]*digest-receipt[ \t]*:[ \t]*(?:id[ \t]*=[ \t]*)?(["']?)([A-Za-z0-9_-]+)\1[ \t]*-->/gi;
const RECEIPT_MARKER_WHOLE = new RegExp(`^${RECEIPT_MARKER.source}$`, "i");
/**
 * Anything that starts like a receipt marker, with the blanks around it,
 * never past its own line: up to its `-->`, else its first `>`, else the end
 * of the line, so a broken close cannot swallow the lines after it and an id
 * in it is never shown.
 */
const ANY_RECEIPT_MARKER = /[ \t]*<!--[ \t]*digest-receipt\b(?:(?!<!--)[^\n])*?(?:-->|>|$)[ \t]*/gim;
const TEXT_CHARS = 160;

export interface SharedOnYourBehalf {
  /** The marker id for this receipt. Never shown. */
  id: string;
  /** The published words, when Index answered with them. */
  text?: string;
  /** Village date (YYYY-MM-DD) it was published. */
  sharedOn: string;
  /** Absent when the map does not say how it was approved. */
  approvedBy?: ApprovedBy;
}

export interface IntentionBrief {
  heldForApprovalCount: number;
  sharedOnYourBehalf: SharedOnYourBehalf[];
  /** Receipts beyond this brief's limit, offered by the next brief. */
  sharedOnYourBehalfMore: number;
  source: "off" | "plugin" | "unavailable";
  warning?: string;
}

export interface ReaderPublished {
  id: string;
  indexIntentId: string;
  publishedAt: string;
  approvedBy: ApprovedBy | null;
}

export interface ReaderAnswer {
  status: "ok" | "off" | "error";
  reason: string | null;
  heldCount: number;
  published: ReaderPublished[];
  publishedCount: number;
  /** Rows of the answer this side could not read (each dropped alone). */
  dropped: number;
}

/** Runs the plugin's reader with the receipted ids and returns its stdout. Throws when it cannot. */
export type ReaderRunner = (home: string, receipted: string[]) => string;
/** Index id -> the published words, for the ids asked; `failed` counts the ids that could not be read. */
export type IntentTextLookup = (indexIntentIds: string[]) => Promise<{ texts: Map<string, string>; failed: number }>;

export function emptyIntentionBrief(source: IntentionBrief["source"] = "off", warning?: string): IntentionBrief {
  return {
    heldForApprovalCount: 0,
    sharedOnYourBehalf: [],
    sharedOnYourBehalfMore: 0,
    source,
    ...(warning ? { warning } : {}),
  };
}

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || "/opt/data";
}

function dotenvValue(home: string, name: string): string | undefined {
  const file = join(home, ".env");
  if (!existsSync(file)) return undefined;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match || match[1] !== name) continue;
      return match[2].trim().replace(/^["']|["']$/g, "");
    }
  } catch {
    // unreadable .env: treated as unset
  }
  return undefined;
}

/** The plugin's `_core.env`: the process environment (even blank), else `$HERMES_HOME/.env`. */
export function envOrDotenv(name: string, home = hermesHome()): string {
  const raw = process.env[name];
  if (raw !== undefined) return raw.trim();
  return (dotenvValue(home, name) ?? "").trim();
}

/** Both switches the reader needs; checked here so an off tenant spawns nothing. */
export function intentionBriefSwitchesOn(home = hermesHome()): boolean {
  return TRUTHY.has(envOrDotenv("AV_RECORD_INTENTION", home).toLowerCase())
    && TRUTHY.has(envOrDotenv("AV_APPROVAL_ENABLED", home).toLowerCase())
    && envOrDotenv("AV_APPROVAL_URL", home).length > 0;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Hermes's interpreter: `HERMES_PYTHON`, the venv beside `HERMES_BIN`, Hermes's known venv, else `python3`. */
export function hermesPython(): string {
  const fromEnv = process.env.HERMES_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const bin = process.env.HERMES_BIN?.trim();
  for (const candidate of [
    bin && isAbsolute(bin) ? join(dirname(bin), "python") : "",
    "/opt/hermes/.venv/bin/python",
  ]) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return "python3";
}

export const runPluginReader: ReaderRunner = (home, receipted) => {
  const reader = join(home, READER_RELATIVE_PATH);
  if (!existsSync(reader)) throw new Error("reader-missing");
  const result = spawnSync(hermesPython(), ["-I", "-B", reader, "--exclude-stdin"], {
    input: JSON.stringify(receipted),
    env: { ...process.env, HERMES_HOME: home },
    timeout: READER_TIMEOUT_MS,
    maxBuffer: READER_MAX_BUFFER,
    encoding: "utf8",
  });
  if (result.error) throw new Error(`reader-${(result.error as NodeJS.ErrnoException).code ?? "spawn-failed"}`);
  if (result.status !== 0) throw new Error(`reader-exit-${result.status ?? result.signal ?? "unknown"}`);
  return String(result.stdout);
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isoInstant(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000 ? value : null;
}

/**
 * The reader's JSON. Throws `reader-unparsed` when the answer itself is not
 * the reader's shape; a row inside it that is not is dropped alone (`dropped`).
 */
export function parseReaderAnswer(raw: string): ReaderAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error("reader-unparsed");
  }
  const root = asRecord(parsed);
  const heldCount = count(root?.heldCount);
  if (!root || root.v !== READER_VERSION || !["ok", "off", "error"].includes(String(root.status))
    || !Array.isArray(root.published) || heldCount === null) {
    throw new Error("reader-unparsed");
  }
  const published: ReaderPublished[] = [];
  let dropped = 0;
  for (const item of root.published) {
    const row = asRecord(item);
    const publishedAt = isoInstant(row?.publishedAt);
    const approvedBy = row?.approvedBy === "individual" || row?.approvedBy === "rule" ? row.approvedBy : null;
    const approvalReadable = row?.approvedBy === null || row?.approvedBy === undefined || approvedBy !== null;
    if (
      !row || typeof row.id !== "string" || !ID.test(row.id) || typeof row.indexIntentId !== "string"
      || !ID.test(row.indexIntentId) || !publishedAt || !approvalReadable
    ) {
      dropped++;
      continue;
    }
    published.push({ id: row.id, indexIntentId: row.indexIntentId, publishedAt, approvedBy });
  }
  const publishedCount = Math.max(count(root.publishedCount) ?? 0, root.published.length);
  return {
    status: root.status as ReaderAnswer["status"],
    reason: typeof root.reason === "string" ? root.reason : null,
    heldCount,
    published,
    publishedCount,
    dropped,
  };
}

export function villageDateOf(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VILLAGE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

/** Ids already carried by a delivered brief (`intentionReceipts`). */
export function receiptedIds(state: Record<string, unknown>): string[] {
  const log = asRecord(state[RECEIPT_STATE_KEY]);
  return log ? Object.keys(log).filter((id) => ID.test(id)) : [];
}

/** Words placed in the context: one line, no HTML comment delimiters, at most `TEXT_CHARS`. */
export function contextText(raw: string): string {
  const text = raw.replace(/<!--|-->/g, " ").replace(/\s+/g, " ").trim();
  return text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS - 1).trimEnd()}…` : text;
}

/**
 * Build the two parts. Never throws: anything that fails leaves them empty
 * (`source: unavailable`, a code in `warning`), and the brief goes out without
 * these lines.
 */
export async function readIntentionBrief(options: {
  state: Record<string, unknown>;
  hermesHome?: string;
  preference?: ReceiptPreference;
  reader?: ReaderRunner;
  lookupTexts?: IntentTextLookup;
}): Promise<IntentionBrief> {
  const home = options.hermesHome ?? hermesHome();
  if (!intentionBriefSwitchesOn(home)) return emptyIntentionBrief("off");
  const receipted = receiptedIds(options.state);
  let answer: ReaderAnswer;
  try {
    answer = parseReaderAnswer((options.reader ?? runPluginReader)(home, receipted));
  } catch (err) {
    return emptyIntentionBrief("unavailable", `intentions: ${err instanceof Error ? err.message : "reader-failed"}`);
  }
  if (answer.status === "off") return emptyIntentionBrief("off");
  if (answer.status === "error") return emptyIntentionBrief("unavailable", `intentions: ${answer.reason ?? "reader-error"}`);

  const warnings: string[] = [];
  if (answer.dropped > 0) warnings.push(`intentions: reader-rows-dropped:${answer.dropped}`);

  const receiptsOn = (options.preference ?? RECEIPT_PREFERENCE_DEFAULT) === "morning_brief";
  const done = new Set(receipted);
  // The reader already left the receipted ids out; this is the belt to its braces.
  const already = answer.published.filter((item) => done.has(item.id)).length;
  const due = receiptsOn ? answer.published.filter((item) => !done.has(item.id)) : [];
  const listed = due.slice(0, RECEIPT_LIST_LIMIT);
  const more = receiptsOn ? Math.max(0, answer.publishedCount - already - listed.length) : 0;

  let texts = new Map<string, string>();
  if (listed.length > 0 && options.lookupTexts) {
    try {
      const looked = await options.lookupTexts(listed.map((item) => item.indexIntentId));
      texts = looked.texts;
      if (looked.failed > 0) warnings.push(`intentions: published-text-unavailable:${looked.failed}`);
    } catch (err) {
      warnings.push(`intentions: published-text-unavailable (${err instanceof Error ? err.message : "lookup-failed"})`);
    }
  }
  const sharedOnYourBehalf = listed.map((item) => {
    const raw = texts.get(item.indexIntentId);
    const text = raw ? contextText(raw) : "";
    return {
      id: item.id,
      ...(text ? { text } : {}),
      sharedOn: villageDateOf(item.publishedAt),
      ...(item.approvedBy ? { approvedBy: item.approvedBy } : {}),
    };
  });

  return {
    heldForApprovalCount: answer.heldCount,
    sharedOnYourBehalf,
    sharedOnYourBehalfMore: more,
    source: "plugin",
    ...(warnings.length ? { warning: warnings.join("; ") } : {}),
  };
}

/**
 * One `get_intent` answer's JSON -> the published words (the description the
 * agent sent, else Index's summary), or null when there are none or the
 * intent is archived (`archivedAt` set; Index's status is only active or
 * paused). Throws when the answer is a tool error.
 */
export function intentTextFrom(root: Record<string, unknown>): string | null {
  if (root.success === false) throw new Error("mcp-tool-error");
  const intent = asRecord(root.intent) ?? root;
  if (intent.archivedAt !== undefined && intent.archivedAt !== null) return null;
  const raw = typeof intent.description === "string" && intent.description.trim()
    ? intent.description
    : typeof intent.summary === "string" ? intent.summary : "";
  const text = contextText(raw);
  return text || null;
}

/** Receipt marker ids in a brief body (well-formed markers only), in order, each once. */
export function extractDigestReceiptIds(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(RECEIPT_MARKER)) {
    if (ID.test(match[2]) && !ids.includes(match[2])) ids.push(match[2]);
  }
  return ids;
}

export function removeMarker(match: string, offset: number, whole: string): string {
  // Keep one space between words the marker sat between.
  const before = offset > 0 ? whole[offset - 1] : "\n";
  const after = whole[offset + match.length] ?? "\n";
  return /\s/.test(before) || /\s/.test(after) ? "" : " ";
}

/** The body with every receipt marker, well-formed or not, removed. */
export function stripDigestReceiptMarkers(body: string): string {
  return body.replace(ANY_RECEIPT_MARKER, removeMarker);
}

/**
 * Staging's pass over the receipt markers: a well-formed marker whose id is in
 * `known` is kept, in canonical form; every other receipt marker (unknown id,
 * malformed, several ids) is removed and counted in a warning code. Never
 * throws, so a marker mistake never costs the brief; a tenant with the feature
 * off has an empty `known` set and keeps no receipt marker.
 */
export function settleReceiptMarkers(body: string, known: Set<string>): { body: string; receiptIds: string[]; warnings: string[] } {
  let unknown = 0;
  let malformed = 0;
  const receiptIds: string[] = [];
  const out = body.replace(ANY_RECEIPT_MARKER, (match: string, offset: number, whole: string) => {
    const id = RECEIPT_MARKER_WHOLE.exec(match.trim())?.[2];
    if (!id || !ID.test(id)) {
      malformed++;
      return removeMarker(match, offset, whole);
    }
    if (!known.has(id)) {
      unknown++;
      return removeMarker(match, offset, whole);
    }
    if (!receiptIds.includes(id)) receiptIds.push(id);
    const lead = /^[ \t]*/.exec(match)?.[0] ?? "";
    const tail = /[ \t]*$/.exec(match)?.[0] ?? "";
    return `${lead}<!-- digest-receipt:id=${id} -->${tail}`;
  });
  const warnings: string[] = [];
  if (unknown > 0) warnings.push(`digest-receipt-unknown:${unknown}`);
  if (malformed > 0) warnings.push(`digest-receipt-malformed:${malformed}`);
  return { body: out, receiptIds, warnings };
}

function daysBetween(earlier: string, later: string): number {
  const toUtc = (d: string) => {
    const [year, month, day] = d.split("-").map(Number);
    return Date.UTC(year, month - 1, day);
  };
  return Math.floor((toUtc(later) - toUtc(earlier)) / 86_400_000);
}

/**
 * The receipt log after a delivered brief: the ids it carried recorded on
 * `date`, entries older than `RECEIPT_KEEP_DAYS` (or malformed) dropped.
 * Null when there is no log and nothing to record, so the state file gains
 * no key for a tenant without receipts.
 */
export function recordReceipts(existing: unknown, ids: string[], date: string): Record<string, string> | null {
  const log = asRecord(existing);
  if (!log && ids.length === 0) return null;
  const next: Record<string, string> = {};
  for (const [id, on] of Object.entries(log ?? {})) {
    if (!ID.test(id) || typeof on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(on)) continue;
    if (daysBetween(on, date) > RECEIPT_KEEP_DAYS) continue;
    next[id] = on;
  }
  for (const id of ids) if (ID.test(id) && !next[id]) next[id] = date;
  return next;
}
