#!/usr/bin/env bun
/**
 * The pending-opportunity alert (DATA-430, overlay half): one Telegram line,
 * within the hour, for each opportunity that newly turned pending for the
 * resident, so a pending window never runs out with nobody told.
 *
 * The hourly job `Edge — pending opportunity` (install_index.ts, 20 * * * *)
 * runs it through the proactive trigger (proactive.ts `pending`), which reads
 * the job's delivery window first (job-settings.ts: 08:00 to 22:00 village
 * time by default): a run outside it never gets here, so it writes nothing. It
 * has no once-a-day mark: the per-card ledger below is the only gate.
 *
 *   - Reads Index's pending list through the path the opportunity drops use
 *     (listOpportunitiesFromMcp, INDEX_API_KEY): no new credential, no
 *     control-plane call.
 *   - A card is newly pending when it is on that list (status `pending`, or
 *     no status: the read asks for pending only), it awaits the resident
 *     (delivery-state.ts awaitsResident: not `negotiating`), and its id is not
 *     in the ledger below.
 *   - The ledger is PENDING_ALERTS_KEY in memory/heartbeat-state.json:
 *
 *       "pendingAlerts": { "<opportunityId>": { "firstSeen": "<ISO>", "alertedAt": "<ISO>" | null } }
 *
 *     `firstSeen` is the first in-window run that saw the card pending;
 *     `alertedAt` is when it was handed to the agent to send, null while it
 *     waits for a slot (at most MAX_ALERTS_PER_RUN per run, the oldest
 *     `firstSeen` first; the rest go at the next run).
 *   - FIRST RUN on a box (the key absent): every card pending now is recorded
 *     as already alerted (`alertedAt` = now) and nothing is sent, so the
 *     install never sends the backlog of cards that were pending before this
 *     job existed. The key is written even when the list is empty.
 *   - An entry whose card has left the pending list (accepted, rejected,
 *     gone) is dropped on the next complete read, and so is one whose card is
 *     seen `negotiating` again, so an id that comes back pending later counts
 *     as new and is alerted again. A cut-short read never drops an entry for
 *     being absent (delivery-state.ts PendingListing).
 *   - A card is recorded as alerted when it is handed to the agent, before
 *     delivery, as the drops record their showing: a send that fails after
 *     that loses the alert, and never repeats it.
 *   - A failed Index read writes nothing and is silent (`index-unavailable`).
 *
 * `respondBy`: Index's `list_opportunities` row carries no deadline field (the
 * recorded reply, tests/fixtures/index-mcp-2026-07-28.json, verified
 * 2026-10-03), and listedCard (build-daily-brief-context.ts) keeps none, so
 * respondBy is null on every card today. It is read only from a card's
 * `respondBy` (an ISO date-time) once the parser carries a field Index
 * serves; it is never invented. The words are RESPOND_BY_WORDS.
 *
 * As a script (`bun pending-alert.ts [--state-file <path>] [--read-only]`,
 * from $HERMES_HOME): takes the state lock, prints `[SILENT]` (the reason on
 * stderr) or the Script Output the trigger would give the model:
 * `{ agentName, job, cards: [{ name, profileUrl, appUrl, acceptUrl,
 * opportunityId, firstSeen, respondBy }] }`. It ignores the delivery window.
 * `--read-only` picks as a real run would and writes nothing.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { type BriefOpportunity, listOpportunitiesFromMcp, resolveIndexApiKey } from "./build-daily-brief-context";
import { type PendingListing, awaitsResident } from "./delivery-state";
import { indexMcpUrl } from "./index-mcp";
import { DEFAULT_TZ } from "./job-settings";
import { cleanName } from "./proactive-text";
import { writeStateFile } from "./state-file";

/** The state-file key of the ledger. */
export const PENDING_ALERTS_KEY = "pendingAlerts";
/** Most cards one run hands to the agent; the rest wait for the next run. */
export const MAX_ALERTS_PER_RUN = 3;
/** The ledger never holds more entries than this. */
export const MAX_LEDGER_ENTRIES = 200;

export interface LedgerEntry {
  firstSeen: string;
  alertedAt: string | null;
}

export type PendingLedger = Record<string, LedgerEntry>;

/** A card as the list read hands it over; `respondBy` only once a parser carries Index's deadline. */
export type PendingSourceCard = BriefOpportunity & { respondBy?: unknown };

export interface DueCard {
  card: PendingSourceCard;
  opportunityId: string;
  firstSeen: string;
}

export interface PendingAlertResult {
  cards: DueCard[];
}

export interface PendingSilentResult {
  silent: true;
  reason: string;
}

const ID = /^[A-Za-z0-9_-]{1,200}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isoStamp(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * The ledger in a parsed state file, or null when there is none yet (the key
 * absent, or not an object: a first run, which seeds silently). An entry that
 * is not a valid record is dropped alone (its card then counts as new).
 */
export function readPendingLedger(state: Record<string, unknown>): PendingLedger | null {
  const map = asRecord(state[PENDING_ALERTS_KEY]);
  if (!map) return null;
  return Object.fromEntries(
    Object.entries(map).flatMap(([id, value]) => {
      const row = asRecord(value);
      if (!ID.test(id) || !row || !isoStamp(row.firstSeen)) return [];
      if (row.alertedAt !== null && !isoStamp(row.alertedAt)) return [];
      return [[id, { firstSeen: row.firstSeen, alertedAt: row.alertedAt as string | null }]];
    }),
  );
}

/** Whether a card is pending and waiting on the resident, with an id the ledger can hold. */
export function awaitsAlert(card: BriefOpportunity): card is BriefOpportunity & { opportunityId: string } {
  const status = (card.status ?? "").trim().toLowerCase();
  return (status === "" || status === "pending") && awaitsResident(card) && typeof card.opportunityId === "string" && ID.test(card.opportunityId);
}

/**
 * One run's decision, pure. `ledger` null is a first run: every card pending
 * now is recorded as alerted at `nowIso` and none is due. Otherwise a card
 * with no entry gets one (`alertedAt` null); the due cards are the entries
 * not yet alerted whose card is listed now with a name that cleans, the
 * oldest `firstSeen` first (then Index's order), at most `max`; they come
 * back recorded as alerted at `nowIso`. Entries whose card left the list
 * (complete read) or is seen negotiating are dropped.
 */
export function planPendingAlerts(
  ledger: PendingLedger | null,
  fetched: PendingSourceCard[],
  listing: PendingListing,
  nowIso: string,
  max = MAX_ALERTS_PER_RUN,
): { ledger: PendingLedger; due: DueCard[]; seeded: boolean } {
  const awaiting = fetched.filter(awaitsAlert);
  const awaitingIds = new Set(awaiting.map((card) => card.opportunityId));
  if (ledger === null) {
    const seeded: PendingLedger = {};
    for (const card of awaiting) seeded[card.opportunityId] ??= { firstSeen: nowIso, alertedAt: nowIso };
    return { ledger: capLedger(seeded), due: [], seeded: true };
  }
  const negotiating = new Set(fetched.flatMap((card) => (!awaitsResident(card) && card.opportunityId ? [card.opportunityId] : [])));
  const next: PendingLedger = {};
  for (const [id, entry] of Object.entries(ledger)) {
    if (negotiating.has(id) && !awaitingIds.has(id)) continue;
    if (listing.complete && !awaitingIds.has(id)) continue;
    next[id] = entry;
  }
  for (const card of awaiting) {
    if (!Object.hasOwn(next, card.opportunityId)) next[card.opportunityId] = { firstSeen: nowIso, alertedAt: null };
  }
  const order = new Map(awaiting.map((card, index) => [card.opportunityId, index] as const));
  const byId = new Map(awaiting.map((card) => [card.opportunityId, card] as const));
  const due = [...byId.values()]
    .filter((card) => next[card.opportunityId].alertedAt === null && cleanName(card.name))
    .sort((a, b) => {
      const fa = next[a.opportunityId].firstSeen;
      const fb = next[b.opportunityId].firstSeen;
      return fa < fb ? -1 : fa > fb ? 1 : (order.get(a.opportunityId) ?? 0) - (order.get(b.opportunityId) ?? 0);
    })
    .slice(0, Math.max(0, max))
    .map((card) => ({ card, opportunityId: card.opportunityId, firstSeen: next[card.opportunityId].firstSeen }));
  for (const item of due) next[item.opportunityId] = { firstSeen: item.firstSeen, alertedAt: nowIso };
  return { ledger: capLedger(next), due, seeded: false };
}

/** At most MAX_LEDGER_ENTRIES: alerted entries go first, the oldest `firstSeen` first. */
function capLedger(ledger: PendingLedger): PendingLedger {
  const entries = Object.entries(ledger);
  if (entries.length <= MAX_LEDGER_ENTRIES) return ledger;
  const dropOrder = [...entries].sort(
    ([ia, a], [ib, b]) =>
      (a.alertedAt === null ? 1 : 0) - (b.alertedAt === null ? 1 : 0) || (a.firstSeen < b.firstSeen ? -1 : a.firstSeen > b.firstSeen ? 1 : 0) || (ia < ib ? -1 : 1),
  );
  const dropped = new Set(dropOrder.slice(0, entries.length - MAX_LEDGER_ENTRIES).map(([id]) => id));
  return Object.fromEntries(entries.filter(([id]) => !dropped.has(id)));
}

/**
 * The words for a deadline, kept in one place: the app's pending card uses the
 * same ones (DATA-430 app half), and they are proposals until Carter approves
 * them there.
 */
export const RESPOND_BY_WORDS = {
  today: (time: string) => `by ${time} today`,
  otherDay: (weekday: string, time: string) => `by ${weekday} ${time}`,
} as const;

function villageParts(at: Date): { day: string; weekday: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
    time: `${parts.hour}:${parts.minute} ${String(parts.dayPeriod).toLowerCase()}`,
  };
}

/**
 * A deadline as the line's words, in village time: `by 6:30 pm today` when it
 * falls on the current village day, else `by Fri 6:30 pm`. Null for no
 * deadline, one that does not parse, or one not after `now` (a past deadline
 * says nothing: Index changes the status).
 */
export function respondByText(deadline: unknown, now: Date): string | null {
  if (typeof deadline !== "string" || deadline.length > 64) return null;
  const at = Date.parse(deadline);
  if (Number.isNaN(at) || at <= now.getTime()) return null;
  const when = villageParts(new Date(at));
  return when.day === villageParts(now).day ? RESPOND_BY_WORDS.today(when.time) : RESPOND_BY_WORDS.otherDay(when.weekday, when.time);
}

function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || "/opt/data";
}

function resolveHermesPath(path: string): string {
  return isAbsolute(path) ? path : join(hermesHome(), path);
}

/**
 * The state file as an object: missing or empty is `{}`; anything that is not
 * a JSON object throws (the trigger has renamed such a file aside before this
 * runs, proactive.ts readStateHealing; run alone, the script never writes over it).
 */
function readStateObject(path: string): Record<string, unknown> {
  if (!existsSync(path) || statSync(path).size === 0) return {};
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const state = asRecord(parsed);
  if (!state) throw new Error("state-corrupt");
  return state;
}

export async function pendingAlert(options: {
  stateFile?: string;
  now?: Date;
  apiKey?: string;
  mcpUrl?: string;
  listOpportunities?: typeof listOpportunitiesFromMcp;
  /** Pick as a real run would and write nothing. */
  readOnly?: boolean;
  max?: number;
} = {}): Promise<PendingAlertResult | PendingSilentResult> {
  const stateFile = resolveHermesPath(options.stateFile ?? "memory/heartbeat-state.json");
  const apiKey = options.apiKey ?? resolveIndexApiKey();
  if (!apiKey) return { silent: true, reason: "no-api-key" };
  const mcpUrl = options.mcpUrl ?? indexMcpUrl();
  let read: Awaited<ReturnType<typeof listOpportunitiesFromMcp>>;
  try {
    read = await (options.listOpportunities ?? listOpportunitiesFromMcp)({ apiKey, mcpUrl });
  } catch {
    return { silent: true, reason: "index-unavailable" };
  }
  let state: Record<string, unknown>;
  try {
    state = readStateObject(stateFile);
  } catch {
    return { silent: true, reason: "state-unreadable" };
  }
  const nowIso = (options.now ?? new Date()).toISOString();
  const before = state[PENDING_ALERTS_KEY];
  const plan = planPendingAlerts(readPendingLedger(state), read.cards as PendingSourceCard[], read.listing, nowIso, options.max);
  if (!options.readOnly && JSON.stringify(before) !== JSON.stringify(plan.ledger)) {
    writeStateFile(stateFile, { ...state, [PENDING_ALERTS_KEY]: plan.ledger });
  }
  if (plan.seeded) return { silent: true, reason: "seeded" };
  if (plan.due.length === 0) return { silent: true, reason: "nothing-new" };
  return { cards: plan.due };
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stateFile = resolveHermesPath(argValue(args, "--state-file") ?? "memory/heartbeat-state.json");
  const readOnly = args.includes("--read-only");
  // The trigger's view and lock, loaded here only: proactive.ts imports this file.
  const { pendingView, withAgentName, scriptOutputText } = await import("./proactive");
  const { withStateLock } = await import("./state-lock");
  const now = new Date();
  const run = () => pendingAlert({ stateFile, now, readOnly });
  const result = readOnly ? await run() : await withStateLock(stateFile, run);
  if ("silent" in result) {
    process.stderr.write(`pending-alert: ${result.reason}\n`);
    process.stdout.write("[SILENT]\n");
    return;
  }
  const { view } = pendingView(result.cards, now);
  if (!view) {
    process.stderr.write("pending-alert: name-withheld\n");
    process.stdout.write("[SILENT]\n");
    return;
  }
  process.stdout.write(`${scriptOutputText(withAgentName(hermesHome(), view))}\n`);
}

if (import.meta.main) {
  await main();
}
