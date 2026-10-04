/**
 * The morning brief's reminder and receipt for intentions the agent inferred
 * (DATA-222).
 *
 * Two small parts of the brief context, both empty unless `AV_RECORD_INTENTION`
 * and the approval path (`AV_APPROVAL_ENABLED`, `AV_APPROVAL_URL`) are on:
 *
 * - `heldForApproval`: things the agent inferred and proposed to share, still
 *   waiting for the resident's answer in their approvals (a reminder; nothing
 *   is approved inside the brief and the brief carries no approval link).
 * - `sharedOnYourBehalf`: inferred intentions published since the last
 *   delivered brief, each with how it was approved (`individual` or `rule`):
 *   the receipt that makes "publish, then tell me" differ from "publish".
 *
 * **Where the data comes from.** The av-events plugin's own reader
 * (`$HERMES_HOME/plugins/av-events/_brief_items.py`, see its docstring and the
 * plugin README), run once with Hermes's Python. This module never reads the
 * plugin's map file. The held text comes from the reader; a published
 * intention's text was deleted from the map at publish (R16), so its words are
 * looked up on Index (`list_intents`, by Index id) only when there is
 * something to receipt; without them the item is listed without text.
 *
 * **Each receipt once, never lost.** The brief names each receipted item with
 * a hidden marker, `<!-- digest-receipt:id=ID -->`. Staging validates the
 * markers against the context and records their ids in `prepared.receiptIds`;
 * the send script, when it delivers, records them under `intentionReceipts`
 * (`{id: village date}`) in `memory/heartbeat-state.json`, the way it records
 * the cards it delivered. An item not yet recorded there is offered again by
 * the next brief while the reader still returns it (a week after the publish),
 * so a failed, suppressed or unsent brief loses nothing. Entries are pruned
 * after `RECEIPT_KEEP_DAYS`, past the reader's window, so the prune is lossless.
 *
 * **The receipt preference** ("publish, then tell me" against "publish") is a
 * setting the control plane keeps on the tenant (DATA-259; values `none` |
 * `morning_brief`). Nothing carries it into the sandbox yet, and the
 * two choices render the same approval policy, so this module uses
 * `RECEIPT_PREFERENCE_DEFAULT` (`morning_brief`: tell the resident what was
 * shared in their name). `none` suppresses the receipt, never the reminder.
 */

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type ReceiptPreference = "none" | "morning_brief";
export type ApprovedBy = "individual" | "rule";

/** Used until the tenant's setting reaches the sandbox (see the module comment). */
export const RECEIPT_PREFERENCE_DEFAULT: ReceiptPreference = "morning_brief";
/** Held items listed by name in one brief; the rest are counted. */
export const HELD_LIST_LIMIT = 3;
/** Receipts in one brief; the rest wait for the next brief, oldest first. */
export const RECEIPT_LIST_LIMIT = 3;
/** heartbeat-state key: receipted intention id -> the village date of the brief that carried it. */
export const RECEIPT_STATE_KEY = "intentionReceipts";
/** Longer than the reader's 7-day window, so pruning never re-offers an item. */
export const RECEIPT_KEEP_DAYS = 14;
export const READER_TIMEOUT_MS = 15_000;
export const READER_RELATIVE_PATH = join("plugins", "av-events", "_brief_items.py");

const VILLAGE_TZ = "Asia/Kolkata";
const TRUTHY = new Set(["1", "true", "yes", "on"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DIGEST_RECEIPT_MARKER = /<!--\s*digest-receipt:(?:id=)?([^\s>]+)\s*-->/g;
const DIGEST_RECEIPT_MARKER_LINE = /[ \t]*<!--\s*digest-receipt:(?:id=)?[^\s>]+\s*-->[ \t]*/g;

export interface HeldForApproval {
  /** The held words, as the resident is shown them in the approval request (shortened). */
  text: string;
  /** Village date (YYYY-MM-DD) it was first held. */
  heldSince: string;
}

export interface SharedOnYourBehalf {
  /** The marker id for this receipt. Never shown. */
  id: string;
  /** The published words, when Index answered with them. */
  text?: string;
  /** Village date (YYYY-MM-DD) it was published. */
  sharedOn: string;
  approvedBy: ApprovedBy;
}

export interface IntentionBrief {
  heldForApproval: HeldForApproval[];
  heldForApprovalCount: number;
  sharedOnYourBehalf: SharedOnYourBehalf[];
  /** Receipts beyond this brief's limit, offered by the next brief. */
  sharedOnYourBehalfMore: number;
  source: "off" | "plugin" | "unavailable";
  warning?: string;
}

export interface ReaderHeld {
  id: string;
  text: string;
  heldSince: string;
}

export interface ReaderPublished {
  id: string;
  indexIntentId: string;
  publishedAt: string;
  approvedBy: ApprovedBy;
}

export interface ReaderAnswer {
  status: "ok" | "off" | "error";
  reason: string | null;
  held: ReaderHeld[];
  heldCount: number;
  published: ReaderPublished[];
}

/** Runs the plugin's reader and returns its stdout. Throws when it cannot. */
export type ReaderRunner = (home: string) => string;
/** Index id -> the published words, for the ids asked. Throws when Index cannot answer. */
export type IntentTextLookup = (indexIntentIds: string[]) => Promise<Map<string, string>>;

export function emptyIntentionBrief(source: IntentionBrief["source"] = "off", warning?: string): IntentionBrief {
  return {
    heldForApproval: [],
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

export const runPluginReader: ReaderRunner = (home) => {
  const reader = join(home, READER_RELATIVE_PATH);
  if (!existsSync(reader)) throw new Error("reader-missing");
  const result = Bun.spawnSync([hermesPython(), "-I", "-B", reader], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HERMES_HOME: home },
    timeout: READER_TIMEOUT_MS,
  });
  if (!result.success) throw new Error(`reader-exit-${result.exitCode ?? "signal"}`);
  return new TextDecoder().decode(result.stdout);
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isoInstant(value: unknown): string | null {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) && !Number.isNaN(Date.parse(value))
    ? value
    : null;
}

/** The reader's JSON, checked field by field. Throws `reader-unparsed` on any other shape. */
export function parseReaderAnswer(raw: string): ReaderAnswer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    throw new Error("reader-unparsed");
  }
  const root = asRecord(parsed);
  if (!root || root.v !== 1 || !["ok", "off", "error"].includes(String(root.status))) throw new Error("reader-unparsed");
  if (!Array.isArray(root.held) || !Array.isArray(root.published) || typeof root.heldCount !== "number") {
    throw new Error("reader-unparsed");
  }
  const held: ReaderHeld[] = [];
  for (const item of root.held) {
    const row = asRecord(item);
    const heldSince = isoInstant(row?.heldSince);
    if (!row || typeof row.id !== "string" || !ID.test(row.id) || typeof row.text !== "string" || !row.text.trim() || !heldSince) {
      throw new Error("reader-unparsed");
    }
    held.push({ id: row.id, text: row.text.trim(), heldSince });
  }
  const published: ReaderPublished[] = [];
  for (const item of root.published) {
    const row = asRecord(item);
    const publishedAt = isoInstant(row?.publishedAt);
    if (
      !row || typeof row.id !== "string" || !ID.test(row.id) || typeof row.indexIntentId !== "string" || !ID.test(row.indexIntentId)
      || (row.approvedBy !== "individual" && row.approvedBy !== "rule") || !publishedAt
    ) {
      throw new Error("reader-unparsed");
    }
    published.push({ id: row.id, indexIntentId: row.indexIntentId, publishedAt, approvedBy: row.approvedBy });
  }
  const heldCount = Number.isInteger(root.heldCount) && root.heldCount >= held.length ? root.heldCount : held.length;
  return {
    status: root.status as ReaderAnswer["status"],
    reason: typeof root.reason === "string" ? root.reason : null,
    held,
    heldCount,
    published,
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
export function receiptedIds(state: Record<string, unknown>): Set<string> {
  const log = asRecord(state[RECEIPT_STATE_KEY]);
  return new Set(log ? Object.keys(log) : []);
}

/**
 * Build the two lists. Never throws: anything that fails leaves them empty
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
  let answer: ReaderAnswer;
  try {
    answer = parseReaderAnswer((options.reader ?? runPluginReader)(home));
  } catch (err) {
    return emptyIntentionBrief("unavailable", `intentions: ${err instanceof Error ? err.message : "reader-failed"}`);
  }
  if (answer.status === "off") return emptyIntentionBrief("off");
  if (answer.status === "error") return emptyIntentionBrief("unavailable", `intentions: ${answer.reason ?? "reader-error"}`);

  const heldForApproval = answer.held
    .slice(0, HELD_LIST_LIMIT)
    .map((item) => ({ text: item.text, heldSince: villageDateOf(item.heldSince) }));

  const preference = options.preference ?? RECEIPT_PREFERENCE_DEFAULT;
  const done = receiptedIds(options.state);
  const due = preference === "morning_brief" ? answer.published.filter((item) => !done.has(item.id)) : [];
  const listed = due.slice(0, RECEIPT_LIST_LIMIT);

  let texts = new Map<string, string>();
  let warning: string | undefined;
  if (listed.length > 0 && options.lookupTexts) {
    try {
      texts = await options.lookupTexts(listed.map((item) => item.indexIntentId));
    } catch (err) {
      warning = `intentions: published text unavailable (${err instanceof Error ? err.message : "lookup-failed"})`;
    }
  }
  const sharedOnYourBehalf = listed.map((item) => {
    const text = texts.get(item.indexIntentId);
    return {
      id: item.id,
      ...(text ? { text } : {}),
      sharedOn: villageDateOf(item.publishedAt),
      approvedBy: item.approvedBy,
    };
  });

  return {
    heldForApproval,
    heldForApprovalCount: answer.heldCount,
    sharedOnYourBehalf,
    sharedOnYourBehalfMore: due.length - listed.length,
    source: "plugin",
    ...(warning ? { warning } : {}),
  };
}

const TEXT_CHARS = 160;

/**
 * `list_intents` rows -> Index id to the published words (the description the
 * agent sent, else Index's summary), for the asked ids only. Archived rows are
 * left out (the resident took it down).
 */
export function intentTextsFrom(rows: unknown[], wanted: string[]): Map<string, string> {
  const want = new Set(wanted);
  const out = new Map<string, string>();
  for (const item of rows) {
    const row = asRecord(item);
    if (!row || typeof row.id !== "string" || !want.has(row.id) || row.status === "archived") continue;
    const raw = typeof row.description === "string" && row.description.trim()
      ? row.description
      : typeof row.summary === "string" ? row.summary : "";
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    out.set(row.id, text.length > TEXT_CHARS ? `${text.slice(0, TEXT_CHARS - 1).trimEnd()}…` : text);
  }
  return out;
}

/** Receipt marker ids in a brief body, in order, each once. */
export function extractDigestReceiptIds(body: string): string[] {
  const ids: string[] = [];
  for (const match of body.matchAll(DIGEST_RECEIPT_MARKER)) {
    if (!ids.includes(match[1])) ids.push(match[1]);
  }
  return ids;
}

/** The body with every receipt marker removed (the send strips them before delivery). */
export function stripDigestReceiptMarkers(body: string): string {
  return body.replace(DIGEST_RECEIPT_MARKER_LINE, (match, offset: number, whole: string) => {
    // Keep one space between words the marker sat between.
    const before = offset > 0 ? whole[offset - 1] : "\n";
    const after = whole[offset + match.length] ?? "\n";
    return /\s/.test(before) || /\s/.test(after) ? "" : " ";
  });
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
    if (typeof on !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(on)) continue;
    const age = daysBetween(on, date);
    if (age > RECEIPT_KEEP_DAYS) continue;
    next[id] = on;
  }
  for (const id of ids) if (ID.test(id) && !next[id]) next[id] = date;
  return next;
}
