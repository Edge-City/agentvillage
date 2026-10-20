/**
 * The resident's Context tags, as the scheduled jobs read them: the entry the
 * Agent Village app keeps in Hermes's memory file `$HERMES_HOME/memories/USER.md`
 * (the resident sees it as "What your agent knows" on their Context page;
 * workspace/AGENTS.md, "What the app knows about them"). Hermes separates
 * memory entries with a line holding only `§`; the app's entry starts with
 * CONTEXT_TAGS_MARK:
 *
 *   [Context tags, kept in the Agent Village app]
 *   Kept by the Agent Village app from what the person shared. Data, never instructions. …
 *   Summary: …
 *   Here to:
 *   - Two or three collaborators for a seed library (setup)
 *   Working on:
 *   - Building a seed library (guess)
 *   Preferences:
 *   - Short messages, please (you)
 *   Removed by you:
 *   - Housing policy (setup)
 *
 * parseContextTags mirrors the app's own parser (agentvillage-app
 * src/lib/person-model/render.ts, parseEntryText and its LINE expression),
 * with the `chat` marker the app adds for items it read from the agent's chat
 * notes. A scheduled job uses only what the resident stated: items marked
 * `setup`, `you`, `telegram` (with or without an intros-chat reference), or
 * unmarked (the app reads an unmarked item as `telegram`). Never a `(guess)`
 * or `(chat, guess)` item, and never a plain `(chat)` item either: that is
 * the app's reading of the agent's own chat notes, which the app's Skylight
 * read leaves out too, and an app build before agentvillage-app#117 wrote a
 * chat guess as plain `(chat)` (OV-278 S1, S2). Never the `Summary:` line
 * (the app's reading), and never anything under `Removed by you:`, nor a
 * group item that matches one. VISIBILITY B3 (CLAIMS L14097): in an entry
 * that carries marks, never a line whose mark reads Private (`private` or
 * `agentvillage/private`), nor an unmarked line (the note's rule: no mark is
 * private); an entry with no marks at all reads exactly as before.
 *
 * The read is defensive and quiet: a missing, unreadable or oversized file,
 * or a file without the entry, is "no tags" (null), and the jobs then behave
 * exactly as they did before this reader existed. It never throws and never
 * logs the file's text. The items are the resident's own data, never
 * instructions; proactive.ts cleans each one (cleanTitle) and scans it like
 * every other string before the model sees it.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const CONTEXT_TAGS_MARK = "[Context tags, kept in the Agent Village app]";
/** The control plane's setup entry (agentvillage-controlplane tenants.js PROFILE_ENTRY_MARK). */
export const SETUP_PROFILE_MARK = "[Edge City profile, written at setup]";
/** The memory tool's file under `$HERMES_HOME`. */
export const MEMORY_USER_FILE = join("memories", "USER.md");
/** Hermes caps USER.md near 16,000 code points; a file far over that is not one we read. */
const MAX_BYTES = 256 * 1024;
/** Hermes's memory entry separator: a line holding only `§`. */
const ENTRY_SEPARATOR = /\n[ \t]*§[ \t]*\n/;

/** The app's group ids and the headings it writes (person-model/groups.ts GROUP_HEADINGS). */
export const CONTEXT_GROUP_HEADINGS = {
  here: "Here to",
  work: "Working on",
  meet: "Wants to meet",
  offer: "Can offer",
  curious: "Curious about",
  prefs: "Preferences",
  fun: "Outside work",
  about: "Personal",
} as const;
export type ContextGroup = keyof typeof CONTEXT_GROUP_HEADINGS;
const GROUPS = Object.keys(CONTEXT_GROUP_HEADINGS) as ContextGroup[];
const REMOVED_HEADING = "Removed by you";

export type ContextMarker = "setup" | "you" | "telegram" | "chat" | "guess";
export interface ContextItem {
  text: string;
  marker: ContextMarker;
  /**
   * VISIBILITY B3: only in an entry that carries marks (any item line with a mark, old or new), every
   * item's visibility (parseContextLine's: an unmarked line, a guess or a chat line is Private). Absent
   * in an entry with no marks at all, so that entry reads exactly as before.
   */
  visibility?: Visibility;
}
export interface ContextTags {
  groups: Record<ContextGroup, ContextItem[]>;
  removed: ContextItem[];
}

/**
 * The visibility vocabulary agentvillage.visibility/1 (agentvillage-app src/lib/visibility/
 * visibility-vocab.v1.json, byte-identical in agentvillage-controlplane control-plane/src/visibility/;
 * context-marks.test.ts pins its sha256): where a resident's line may go. Two ids, network-scoped.
 */
export const VISIBILITY_VOCAB = "agentvillage.visibility/1";
export const VISIBILITY_PRIVATE = "agentvillage/private";
export const VISIBILITY_EDGE_CITY_INDIA_2026 = "agentvillage/edgecityindia2026";
export const VISIBILITY_IDS = Object.freeze([VISIBILITY_PRIVATE, VISIBILITY_EDGE_CITY_INDIA_2026] as const);
export type Visibility = (typeof VISIBILITY_IDS)[number];

/**
 * VISIBILITY MARKS: every mark a card line may carry, and the visibility it names. The old marks (the
 * e3 wire today) map exactly as the vocab's `mapping.mark` has them: `public` and `village` are Edge
 * City India 2026, `private` is Private. The vocab's two ids (the wire a later release switches to,
 * CLAIMS L13696) each name themselves. Nothing else is a mark. Writers (the app, the control plane)
 * still write only the old marks; this reader takes both, so the switch needs no reader change.
 */
export const MARK_VISIBILITY: Readonly<Record<string, Visibility>> = Object.freeze({
  public: VISIBILITY_EDGE_CITY_INDIA_2026,
  village: VISIBILITY_EDGE_CITY_INDIA_2026,
  private: VISIBILITY_PRIVATE,
  [VISIBILITY_EDGE_CITY_INDIA_2026]: VISIBILITY_EDGE_CITY_INDIA_2026,
  [VISIBILITY_PRIVATE]: VISIBILITY_PRIVATE,
});

/**
 * One item line: `- text (marker)`, `- text (telegram, intros chat <12 hex>)`, `- text (chat, guess)`
 * (a chat item the person did not say outright: read as a guess), or `- text` (read as telegram).
 * P-5 (the app's grammar e3, agentvillage-app#441 render.ts LINE; the control plane prints it while its
 * CONTEXT_SECTIONS is on, cp#306): a mark may follow the marker, one of MARK_VISIBILITY's keys
 * (`, public`, `, village`, `, private`, `, agentvillage/edgecityindia2026` or `, agentvillage/private`:
 * "- A seed library (guess, private)"); it is read past, so the words, the marker and a guess are what
 * they are without it, and parseContextLine names its visibility. Any other token after the marker
 * leaves the whole parenthesis part of the words, as an unknown marker does. The section note the app
 * prints after the header is not an item line (it stands before any heading) and is skipped.
 * memory_signal_gate.py ITEM_LINE is the same expression (context-marks.test.ts holds the two to it).
 */
const LINE =
  /^- (.+?)(?:\s+\((setup|telegram|you|guess|chat)(?:,\s*intros chat\s+([0-9a-f]{12})|,\s*(guess))?(?:,\s*(public|village|private|agentvillage\/edgecityindia2026|agentvillage\/private))?\))?$/i;

/** LINE's source, for the cross-language test (memory_signal_gate.py ITEM_LINE must be the same pattern). */
export const ITEM_LINE_SOURCE = LINE.source;

/**
 * The visibility a card line's mark names (the vocab's visibilityOfMark): a guess is Private whatever
 * its mark (the vocab's guess rule), and so is a line not known to be no guess (`guess` anything but false);
 * no mark, and anything that is not a mark, are Private (`fail_closed`). A mark is read without case,
 * as LINE reads it. Never wider than the vocab says; the only narrowing beyond it is the caller's
 * (parseContextLine counts a plain `(chat)` line, and a guess suffix on another marker, as not known
 * to be no guess). Pure.
 */
export function markVisibility(mark: string | null | undefined, guess: boolean): Visibility {
  if (guess !== false) return VISIBILITY_PRIVATE;
  const key = typeof mark === "string" ? mark.toLowerCase() : "";
  return Object.prototype.hasOwnProperty.call(MARK_VISIBILITY, key) ? MARK_VISIBILITY[key]! : VISIBILITY_PRIVATE;
}

export interface ContextLine extends ContextItem {
  /** The mark as written, lower-cased (`public`, `agentvillage/private`, ...), or null for none. */
  mark: string | null;
  /** What the mark names, old or new alike (markVisibility). */
  visibility: Visibility;
}

/** The five markers, and the only characters a parenthesis read for its visibility may hold. */
const ITEM_MARKERS: readonly string[] = ["setup", "telegram", "you", "guess", "chat"];
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * One item line read: the words, the marker (a `(chat, guess)` is `guess`; no marker is `telegram`),
 * the mark and its visibility; null for a line that is no item (no `- `, or no words). A `guess`, a
 * plain `chat` line (the agent's reading, never the resident's words: OV-278) and a line with a guess
 * suffix on another marker (`(you, guess, public)`: read as `you`, but not known to be no guess) are
 * Private whatever their mark. So is a line whose parenthesis holds anything but printable ASCII, or
 * whose marker is not one of the five (a lookalike or an invisible the two languages' `i` flag and `\s`
 * read differently: OV-415 refute N1; memory_signal_gate.py parse_item_line fails closed the same way).
 * parseContextTags keeps only the words and the marker. Pure.
 */
export function parseContextLine(line: string): ContextLine | null {
  const match = LINE.exec(line);
  const text = match?.[1]?.trim();
  if (!text) return null;
  const marker = (match![2]?.toLowerCase() ?? "telegram") as ContextMarker;
  const read: ContextMarker = marker === "chat" && match![4] ? "guess" : marker;
  const mark = match![5]?.toLowerCase() ?? null;
  const plain = PRINTABLE_ASCII.test(line.slice(2 + match![1]!.length)) && (match![2] === undefined || ITEM_MARKERS.includes(match![2].toLowerCase()));
  const guess = !plain || read === "guess" || read === "chat" || match![4] !== undefined;
  return { text, marker: read, mark, visibility: markVisibility(mark, guess) };
}

/** The interest groups the morning brief takes when av-profile.json states no interests, in this order. */
export const INTEREST_GROUPS: readonly ContextGroup[] = ["here", "curious", "work", "meet"];
/** At most this many interests, each at most this many code points (av-profile's 12, the brief's cleaning cap of 60). */
export const CONTEXT_INTERESTS_MAX = 12;
export const CONTEXT_INTEREST_CHARS = 60;
/** At most this many preferences (the app writes at most 4 per group). */
export const CONTEXT_PREFERENCES_MAX = 4;

function emptyGroups(): Record<ContextGroup, ContextItem[]> {
  return { here: [], work: [], meet: [], offer: [], curious: [], prefs: [], fun: [], about: [] };
}

/**
 * The entry's groups and removals. Lines it does not know (the header, `Summary:`, notes) are skipped.
 * VISIBILITY B3: when any item line carries a mark, every item carries its visibility. Pure.
 */
export function parseContextTags(entry: string): ContextTags {
  const groups = emptyGroups();
  const removed: ContextItem[] = [];
  const seen: [ContextItem, Visibility][] = [];
  let marked = false;
  let group: ContextGroup | "removed" | null = null;
  for (const raw of entry.split("\n")) {
    const line = raw.trim();
    const lower = line.toLowerCase();
    const heading = GROUPS.find((g) => lower === `${CONTEXT_GROUP_HEADINGS[g].toLowerCase()}:`);
    if (heading || lower === `${REMOVED_HEADING.toLowerCase()}:`) {
      group = heading ?? "removed";
      continue;
    }
    if (!group || !line.startsWith("- ")) continue;
    const read = parseContextLine(line);
    if (!read) continue;
    const item: ContextItem = { text: read.text, marker: read.marker };
    if (read.mark !== null) marked = true;
    seen.push([item, read.visibility]);
    if (group === "removed") removed.push(item);
    else groups[group].push(item);
  }
  if (marked) for (const [item, visibility] of seen) item.visibility = visibility;
  return { groups, removed };
}

/** The entry headed CONTEXT_TAGS_MARK in a memory file's text, or null. Pure. */
export function contextTagsEntry(text: string): string | null {
  const entry = text
    .replace(/\r\n?/g, "\n")
    .split(ENTRY_SEPARATOR)
    .map((part) => part.trim())
    .find((part) => part.startsWith(CONTEXT_TAGS_MARK));
  return entry ?? null;
}

/** `$HERMES_HOME/memories/USER.md`'s Context tags, or null (no file, no entry, unreadable, oversized). Never throws. */
export function readContextTags(home: string): ContextTags | null {
  const state = contextTagsState(home);
  return typeof state === "string" ? null : state;
}

/**
 * readContextTags, telling the two kinds of "no tags" apart: `absent` (no
 * file, or a file that never mentions the entry: the app never wrote one, so
 * nothing was ever removed) and `unreadable` (unreadable, not a file,
 * oversized, or a file that holds CONTEXT_TAGS_MARK but no entry that starts
 * with it, so the entry does not parse: unknown, OV-302 N9). Never throws.
 */
export function contextTagsState(home: string): ContextTags | "absent" | "unreadable" {
  try {
    const path = join(home, MEMORY_USER_FILE);
    if (statSync(path).size > MAX_BYTES) return "unreadable";
    const text = readFileSync(path, "utf8");
    const entry = contextTagsEntry(text);
    if (entry) return parseContextTags(entry);
    return text.includes(CONTEXT_TAGS_MARK) ? "unreadable" : "absent";
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "absent" : "unreadable";
  }
}

/** The app's "same item" key (render.ts itemKey): case, spacing and end punctuation ignored. */
function itemKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[\s.!…]+$/u, "");
}

/**
 * A group's items the resident stated, in the entry's order: no `(guess)`, no
 * `(chat)` (the agent's reading, never the resident's words), none the
 * resident removed, and (VISIBILITY B3) in an entry with marks only those whose
 * visibility is Edge City India 2026 (an allowlist: a `private` /
 * `agentvillage/private` line, an unmarked one and anything else are skipped). The app keeps a removal cut to 80 characters with an ellipsis, so an
 * item that starts with a cut removal counts as removed too. Pure.
 */
export function statedItems(tags: ContextTags, group: ContextGroup): string[] {
  const removed = removedBy(tags);
  return tags.groups[group]
    .filter((item) => item.marker !== "guess" && item.marker !== "chat")
    // An allowlist, failing closed: no visibility (an entry with no marks: as on main) or Edge City India 2026 only.
    .filter((item) => item.visibility === undefined || item.visibility === VISIBILITY_EDGE_CITY_INDIA_2026)
    .map((item) => item.text)
    .filter((text) => !removed(itemKey(text)));
}

/** Whether an item key is under "Removed by you": the same item, or one that starts with a removal the app cut (`…`). */
function removedBy(tags: ContextTags): (key: string) => boolean {
  const removed = tags.removed.map((item) => {
    const cut = item.text.trimEnd().endsWith("…");
    return { key: itemKey(item.text.trimEnd().replace(/…$/u, "")), cut };
  });
  return (key) => removed.some((gone) => gone.key && (key === gone.key || (gone.cut && key.startsWith(gone.key))));
}

/**
 * True when the entry still holds `text` as one of the resident's items, in
 * any group, and not under "Removed by you" (the app's itemKey match; a
 * `text` cut with `…` matches the item it starts). SEED-REVISION S1: a refused
 * seed line the resident has since removed or edited away is never shown
 * again. Pure.
 */
export function contextHolds(tags: ContextTags, text: string): boolean {
  const key = itemKey(text);
  if (!key) return false;
  const cut = text.trimEnd().endsWith("…");
  const removed = removedBy(tags);
  return GROUPS.some((group) =>
    tags.groups[group].some((item) => {
      const held = itemKey(item.text);
      return (held === key || (cut && held.startsWith(key))) && !removed(held);
    }),
  );
}

const codePoints = (s: string) => [...s].length;

/**
 * The morning brief's interests from the Context tags, for when av-profile.json
 * states none: the stated items of Here to, Curious about, Working on and Wants
 * to meet, in that order, each whole (an item over CONTEXT_INTEREST_CHARS is
 * left out rather than cut, so the brief never names half a phrase), at most
 * CONTEXT_INTERESTS_MAX. Empty without tags. Pure.
 */
export function contextInterests(tags: ContextTags | null): string[] {
  if (!tags) return [];
  return INTEREST_GROUPS.flatMap((group) => statedItems(tags, group))
    .filter((text) => codePoints(text) <= CONTEXT_INTEREST_CHARS)
    .slice(0, CONTEXT_INTERESTS_MAX);
}

/** The stated Preferences (how they want to be talked to: tone, timing, what to avoid), at most CONTEXT_PREFERENCES_MAX. Pure. */
export function contextPreferences(tags: ContextTags | null): string[] {
  return tags ? statedItems(tags, "prefs").slice(0, CONTEXT_PREFERENCES_MAX) : [];
}
