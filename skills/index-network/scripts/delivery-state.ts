/**
 * Cross-day delivery state for Index opportunity cards: the one place that
 * decides whether a pending card may be shown to the resident today.
 *
 * Index keeps no delivery ledger, so the agent keeps one, in the shared state
 * file (memory/heartbeat-state.json) under OPPORTUNITY_DELIVERY_KEY:
 *
 *   { "<opportunityId>": { "firstShown": "YYYY-MM-DD", "lastShown": "YYYY-MM-DD", "count": 1 } }
 *
 * The rule, the same on every path that puts a card in front of the resident
 * (the morning brief, the opportunity drops, the afternoon follow-up's
 * "waiting on you" list and the evening card):
 *
 *   - a card never shown is eligible (on the brief, the drops and the evening
 *     card; the follow-up only re-shows cards already shown);
 *   - a card already shown is eligible again COOLDOWN_DAYS after its last
 *     showing, while it has been shown fewer than MAX_SHOWINGS times;
 *   - a card that leaves the pending list (accepted or rejected) is finished:
 *     its entry is dropped on the next successful, complete read of that list,
 *     so the same id coming back later counts as new;
 *   - a card with `negotiating: true` is not waiting on the resident, so it is
 *     never offered (see awaitsResident).
 *
 * Dates are the village day (villageDate, Asia/Kolkata) that every caller
 * already uses for `deliveredToday`. The per-day `deliveredToday` dedupe is
 * unchanged and is applied by each caller before this rule.
 *
 * Known limit: a showing is recorded when the card is handed to the agent for
 * delivery (the drop, the evening card and the follow-up before they print
 * it, the brief's send before the agent replies), not when the message is
 * confirmed delivered, because no delivery confirmation exists anywhere in
 * the chain. A send that fails after that point still costs the card its
 * COOLDOWN_DAYS wait and one of its MAX_SHOWINGS showings.
 *
 * Everything here is pure. Callers read and write the state file themselves
 * and replace only OPPORTUNITY_DELIVERY_KEY, so sibling keys are never
 * touched.
 */

import type { BriefOpportunity } from "./build-daily-brief-context";

/** Days after its last showing before an unanswered card may be shown again. */
export const COOLDOWN_DAYS = 3;
/** Showings in total, across every path, before a card is never shown again. */
export const MAX_SHOWINGS = 3;
/** An entry last shown this many days ago or more is forgotten. */
export const MAX_ENTRY_AGE_DAYS = 60;
/** An entry last shown more than this many days after today is malformed. */
export const MAX_FUTURE_DAYS = 1;
/** The log never holds more entries than this. */
export const MAX_ENTRIES = 200;
/** The state-file key that holds the log. */
export const OPPORTUNITY_DELIVERY_KEY = "opportunityDelivery";

export interface CardShowings {
  firstShown: string;
  lastShown: string;
  count: number;
}

export type DeliveryLog = Record<string, CardShowings>;

/**
 * What one successful read of the pending list says. `pendingIds` holds the
 * id of every pending row Index returned (whether or not it became a card).
 * `complete` is true only when that read cannot have been cut short by the
 * page limit; a cut-short read never removes an entry for being absent.
 */
export interface PendingListing {
  complete: boolean;
  pendingIds: ReadonlySet<string>;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ID = /^[A-Za-z0-9_-]{1,200}$/;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function dayNumber(date: string): number | null {
  const match = date.match(DATE);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null;
  return ms / 86_400_000;
}

/** Whole days from `earlier` to `later`; negative when `earlier` is after `later`. */
export function daysBetween(earlier: string, later: string): number {
  const a = dayNumber(earlier);
  const b = dayNumber(later);
  if (a === null || b === null) throw new Error(`expected YYYY-MM-DD dates, got ${earlier} and ${later}`);
  return b - a;
}

function validShowings(value: unknown): CardShowings | null {
  const row = asRecord(value);
  if (!row) return null;
  const { firstShown, lastShown, count } = row;
  if (typeof firstShown !== "string" || dayNumber(firstShown) === null) return null;
  if (typeof lastShown !== "string" || dayNumber(lastShown) === null) return null;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1) return null;
  if (firstShown > lastShown) return null;
  return { firstShown, lastShown, count };
}

/** The entry for `id`, own properties only. */
export function showingsFor(log: DeliveryLog, id: string): CardShowings | undefined {
  return Object.hasOwn(log, id) ? log[id] : undefined;
}

/**
 * The log in a parsed state file, as read on `today`. A map that is not an
 * object reads as empty, and an entry that is not a valid record is dropped
 * alone; so is an entry last shown more than MAX_FUTURE_DAYS after today,
 * which would otherwise never age out. A state file from before this log
 * existed (no key at all) is read from its `deliveredToday` set: each id
 * there counts as shown once, on that set's date, so a card the previous
 * version sent is not offered as new.
 */
export function readDeliveryLog(state: Record<string, unknown>, today: string): DeliveryLog {
  const now = dayNumber(today);
  if (now === null) throw new Error(`expected YYYY-MM-DD date, got ${today}`);
  const tooFar = (date: string) => (dayNumber(date) as number) - now > MAX_FUTURE_DAYS;
  const raw = state[OPPORTUNITY_DELIVERY_KEY];
  if (raw === undefined) {
    const delivered = asRecord(state.deliveredToday);
    const date = delivered?.date;
    if (typeof date !== "string" || dayNumber(date) === null || tooFar(date) || !Array.isArray(delivered?.ids)) return {};
    const ids = delivered.ids.filter((id): id is string => typeof id === "string" && ID.test(id));
    return Object.fromEntries(ids.map((id) => [id, { firstShown: date, lastShown: date, count: 1 }]));
  }
  const map = asRecord(raw);
  if (!map) return {};
  return Object.fromEntries(
    Object.entries(map).flatMap(([id, value]) => {
      const showings = ID.test(id) ? validShowings(value) : null;
      return showings && !tooFar(showings.lastShown) ? [[id, showings]] : [];
    }),
  );
}

/**
 * Whether a card with these showings may be shown on `date`. Never shown:
 * yes. Otherwise only when it has been shown fewer than MAX_SHOWINGS times
 * and at least COOLDOWN_DAYS have passed since the last showing (a last
 * showing dated after `date` is clock skew and counts as not yet passed).
 */
export function isEligible(showings: CardShowings | undefined, date: string): boolean {
  if (!showings) return true;
  if (showings.count >= MAX_SHOWINGS) return false;
  return daysBetween(showings.lastShown, date) >= COOLDOWN_DAYS;
}

/**
 * Whether the card is waiting on the resident. Index can mark a pending card
 * `negotiating: true`; until Index says what that means, such a card is
 * treated as the agents still talking: never offered as "waiting on you" and
 * never nudged again.
 */
export function awaitsResident(card: BriefOpportunity): boolean {
  return card.negotiating !== true;
}

/**
 * Delivery order: cards never shown first, in the order given (Index's
 * order), then cards shown before, the one shown longest ago first. Cards
 * without an id cannot be tracked and sort as never shown.
 */
export function compareForDelivery(log: DeliveryLog): (a: BriefOpportunity, b: BriefOpportunity) => number {
  return (a, b) => {
    const sa = a.opportunityId ? showingsFor(log, a.opportunityId) : undefined;
    const sb = b.opportunityId ? showingsFor(log, b.opportunityId) : undefined;
    if (!sa || !sb) return (sa ? 1 : 0) - (sb ? 1 : 0);
    return sa.lastShown < sb.lastShown ? -1 : sa.lastShown > sb.lastShown ? 1 : 0;
  };
}

/**
 * Split cards (already past the caller's same-day dedupe) into those that may
 * be shown on `date`, in delivery order, and those held back by the cooldown
 * or the showing limit. Cards that are not waiting on the resident are in
 * neither list. A card without an id is always eligible: it cannot be
 * recorded, which is how such cards behaved before this rule.
 */
export function applyCooldown(
  cards: BriefOpportunity[],
  log: DeliveryLog,
  date: string,
): { eligible: BriefOpportunity[]; held: BriefOpportunity[] } {
  const eligible: BriefOpportunity[] = [];
  const held: BriefOpportunity[] = [];
  for (const card of cards) {
    if (!awaitsResident(card)) continue;
    const showings = card.opportunityId ? showingsFor(log, card.opportunityId) : undefined;
    (isEligible(showings, date) ? eligible : held).push(card);
  }
  return { eligible: [...eligible].sort(compareForDelivery(log)), held };
}

/**
 * The log with one showing on `date` recorded for each id. Recording the same
 * id twice on one day counts once, so a retried send never spends a second
 * showing.
 */
export function recordShowings(log: DeliveryLog, ids: Iterable<string>, date: string): DeliveryLog {
  if (dayNumber(date) === null) throw new Error(`expected YYYY-MM-DD date, got ${date}`);
  let next = log;
  for (const id of ids) {
    if (!ID.test(id)) continue;
    const prev = showingsFor(next, id);
    if (prev && prev.lastShown >= date) continue;
    const showings = prev
      ? { firstShown: prev.firstShown, lastShown: date, count: prev.count + 1 }
      : { firstShown: date, lastShown: date, count: 1 };
    next = { ...next, [id]: showings };
  }
  return next;
}

/**
 * The log without entries that no longer matter, and never more than
 * MAX_ENTRIES long:
 *   - an entry last shown MAX_ENTRY_AGE_DAYS or more before `date` goes;
 *   - given a complete listing, an entry whose card is not in it goes (the
 *     card was accepted or rejected). Pass null when there was no successful
 *     read: a failed read must never reset a card's cooldown;
 *   - over the cap, entries go oldest first, those absent from the listing
 *     (finished, as far as a cut-short read can tell) before the rest.
 */
export function pruneDeliveryLog(log: DeliveryLog, date: string, listing: PendingListing | null): DeliveryLog {
  const kept = Object.entries(log).filter(([id, showings]) => {
    if (daysBetween(showings.lastShown, date) >= MAX_ENTRY_AGE_DAYS) return false;
    if (listing?.complete && !listing.pendingIds.has(id)) return false;
    return true;
  });
  if (kept.length <= MAX_ENTRIES) return Object.fromEntries(kept);
  const finished = (id: string) => (listing && !listing.pendingIds.has(id) ? 0 : 1);
  const dropOrder = [...kept].sort(
    ([ia, a], [ib, b]) =>
      finished(ia) - finished(ib) || (a.lastShown < b.lastShown ? -1 : a.lastShown > b.lastShown ? 1 : 0) || (ia < ib ? -1 : ia > ib ? 1 : 0),
  );
  const dropped = new Set(dropOrder.slice(0, kept.length - MAX_ENTRIES).map(([id]) => id));
  return Object.fromEntries(kept.filter(([id]) => !dropped.has(id)));
}

/**
 * Whether writing `log` would change what the state file holds. A file with no
 * log yet and nothing to put in it stays without the key.
 */
export function deliveryLogChanged(state: Record<string, unknown>, log: DeliveryLog): boolean {
  const raw = state[OPPORTUNITY_DELIVERY_KEY];
  if (raw === undefined) return Object.keys(log).length > 0;
  return JSON.stringify(raw) !== JSON.stringify(log);
}

/**
 * The listing one successful `list_opportunities` read describes. It is
 * complete only when fewer rows came back than were asked for and the
 * pagination object `{limit, offset, count}`, when present, does not
 * contradict that: a `count` above the rows returned, or a `limit` below the
 * one asked for, means more may exist. Without a pagination object the row
 * count alone decides.
 */
export function pendingListing(options: {
  pendingIds: Iterable<string>;
  rowCount: number;
  requestedLimit: number;
  pagination?: unknown;
}): PendingListing {
  const pagination = asRecord(options.pagination);
  const count = pagination?.count;
  const limit = pagination?.limit;
  const contradicted =
    (typeof count === "number" && count > options.rowCount) || (typeof limit === "number" && limit < options.requestedLimit);
  return {
    complete: options.rowCount < options.requestedLimit && !contradicted,
    pendingIds: new Set(options.pendingIds),
  };
}
