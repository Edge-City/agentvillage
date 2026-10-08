#!/usr/bin/env bun
/**
 * DATA-357: the resident's first welcome, grounded in their own Index intents.
 *
 *   bun skills/index-network/scripts/welcome.ts [--home DIR] [--draft]
 *
 * One Index read (`list_intents`, an unrouted read through the shared MCP
 * client) and a fixed template, so the text is the same every time for the
 * same intents:
 *
 *   - intents: up to three of the resident's active intents by title, one
 *     line each (whole up to TITLE_MAX code points, else cut at a word
 *     boundary, and cut further only when the three together would take the
 *     welcome past WELCOME_MAX_CHARS: fitTitles), what the agent will do with
 *     them, and how to add or change them (the app's Intents page, or just
 *     tell me);
 *   - no active intents: the app's three Context questions, and a promise to
 *     turn the answers into intents the resident confirms;
 *   - no key, Index unreachable or an answer it cannot read: the welcome
 *     without the list, saying it will catch up in the morning brief.
 *
 * DATA-412 / DATA-416: the seed. When no welcome was sent yet (the welcome
 * marker below, read in both modes), that read succeeds and lists no active
 * intent, the resident selected intentions at signup (`## Selected
 * intentions` in the app's profile at `$HERMES_HOME/USER.md`:
 * selectedIntentions), and the seed marker `memory/welcome-seed.json` does
 * not exist, the script claims that marker (created exclusively, so the
 * creates run once per box, in both modes) and creates up to three of those
 * lines at once, each with `create_intent(description=<the line's text>,
 * sourceType="agentvillage")` and nothing else; a line that repeats another
 * one, or any intent Index lists whatever its status, is skipped.
 * `AV_WELCOME_SEED_MODE=paused` pauses each one it created (`pause_intent`).
 * It then lists the intents again (the creates leave it
 * WELCOME_RELIST_RESERVE_MS of the budget) and the welcome names the seeded
 * ones first ("From what you told me at signup, ..."); the marker then gets
 * `done`, and a run that finds a marker without it waits for it. Nothing of
 * the resident's but the selected texts is sent, and no text is logged. It
 * never changes, publishes or archives an intent it did not create.
 *
 * One welcome per tenant. `memory/welcome-state.json` under `$HERMES_HOME`
 * (`{"welcomeSent":true,"sentAt":"<ISO-8601>"}`) is the marker the control
 * plane's Telegram greeting and the overlay's AGENTS.md welcome gate already
 * share, and the installer keeps across updates (install/welcome_state.ts).
 * By default the script prints WELCOME_ALREADY_SENT when the marker is set;
 * otherwise it claims the marker (created exclusively, so two runs at once
 * cannot both win) and prints the welcome. `--draft` prints the welcome and
 * never writes the marker, for a caller that delivers and marks the welcome
 * itself; it reads it only to skip the seed once a welcome was sent (the seed
 * marker is claimed in both modes).
 *
 * Stdout is exactly the message (the agent sends it verbatim). By default
 * nothing is written to stderr on any normal path: Hermes's `terminal` tool
 * hands the agent both streams. With `--draft` only, one line follows on
 * stderr after the message, for the caller that delivers it (the control
 * plane's Telegram greeting, which records welcome.sent@1 from it): exactly
 *
 *   {"welcome":1,"fallback":"none|questions|unreachable","intents_listed":<0..3>,"intents_seeded":<0..3>,"seed_failed":<0..3>}
 *
 * `fallback` is the branch the text took (`none`: intents listed, seeded
 * ones included; `questions`: no active intents; `unreachable`: no key,
 * Index unreachable, or the script failed and printed the unreachable text),
 * `intents_listed` the number of `- ` intent lines printed (1..3 for `none`,
 * else 0), `intents_seeded` the intents this run created (and, paused mode,
 * paused) and `seed_failed` the lines it meant to seed and could not (both 0
 * when nothing was attempted). It never carries text. It always exits 0.
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_NAME, agentName, readProfile } from "../../agent-profile/scripts/profile";
import { type IndexMcpTarget, callIndexTool, indexMcpUrl, toolJsonArray, toolJsonObject } from "./index-mcp";
import { DEFAULT_CONNECTIONS_URL, cleanTitle, connectionsUrl, cronScanHit, cutAtWord, envOrDotenv } from "./proactive-text";

/** The marker, relative to `$HERMES_HOME` (install/welcome_state.ts WELCOME_STATE_RELATIVE_PATH). */
export const WELCOME_STATE_FILE = join("memory", "welcome-state.json");
/** What the script prints instead of a welcome when one was already sent. */
export const ALREADY_SENT = "WELCOME_ALREADY_SENT";
/** Intents the welcome lists at most. */
export const MAX_LISTED = 3;
/**
 * Code points of one intent title at most (DATA-374: was 80, which cut most
 * real intents). A longer title is cut at the last word boundary before it,
 * with an ellipsis (cleanTitle "word", cutAtWord).
 */
export const TITLE_MAX = 300;
/**
 * Characters (UTF-16 code units, JavaScript's `.length`) of the whole welcome
 * at most. The control plane uses the scripted welcome only when it is
 * shorter than 1200 (control-plane/src/telegram-onboarding.js
 * WELCOME_MAX_CHARS) and otherwise sends its fixed greeting, so this stays
 * below that with room to spare. welcomeText holds every welcome to it: the
 * listed titles share what the rest of the text leaves (fitTitles).
 */
export const WELCOME_MAX_CHARS = 1150;
/**
 * Characters of the Intents link at most: a longer one (an AV_CONNECTIONS_URL
 * host of absurd length) gives way to the default host's, so the link can
 * never crowd the intents out of the welcome.
 */
export const INTENTS_URL_MAX = 200;
/** The welcome's Index read gives up sooner than the brief's: the resident is waiting for a first reply. */
export const WELCOME_INDEX_TIMEOUT_MS = 10_000;
/**
 * One seed call (`create_intent`, `pause_intent`) at most: a create runs
 * Index's verification graph, which takes longer than a read.
 */
export const WELCOME_SEED_TIMEOUT_MS = 20_000;
/**
 * Every Index call of one run together, from its start (DATA-416: 50 s, was
 * 25 s, so a first welcome that seeds has room for creates that take tens of
 * seconds): the control plane stops the `--draft` run at its draft timeout
 * (telegram-onboarding.js greetingDraft, 60 s from DATA-416 W2; it was 30 s),
 * and a run that is stopped sends its fixed greeting instead. A call that
 * would start with less than WELCOME_MIN_CALL_MS left is not made.
 */
export const WELCOME_BUDGET_MS = 50_000;
export const WELCOME_MIN_CALL_MS = 1_000;
/** Of WELCOME_BUDGET_MS, what the creates leave for the second list (DATA-416 S1). */
export const WELCOME_RELIST_RESERVE_MS = 5_000;
/**
 * How long a run that finds another run's seed still in progress (a marker
 * without `done`) waits for it, and how often it looks (DATA-416 S3).
 */
export const WELCOME_SEED_WAIT_MS = 10_000;
export const WELCOME_SEED_POLL_MS = 500;
/**
 * `sourceType` on every intent the overlay creates (the av-events plugin's
 * SOURCE_TYPE, which its poller reads; create_intent's input in
 * plugins/av-events/tests/vectors/index_intent_contract.json): a constant,
 * never resident text.
 */
export const SEED_SOURCE_TYPE = "agentvillage";
/**
 * The app's intention categories, a closed set (agentvillage-app
 * src/lib/agent/client.ts AgentDraft `intentions[].category`, and
 * src/lib/server/agent/schemas.ts `Intention.category`, z.enum). A line
 * tagged with anything else is not one the app wrote.
 */
export const INTENTION_CATEGORIES: readonly string[] = ["build", "learn", "meet", "explore"];

/** The seed marker, relative to `$HERMES_HOME`: its existence, whatever it holds, means the seed ran on this box. */
export const WELCOME_SEED_FILE = join("memory", "welcome-seed.json");
/** The app's flattened profile, relative to `$HERMES_HOME` (the control plane's writeUserMdCmd). */
export const USER_MD_FILE = "USER.md";
/** The profile's heading over the intentions the resident kept (agentvillage-app profile-text.ts profileText). */
export const SELECTED_HEADING = "## Selected intentions";

/** The lead and closing sentence of a welcome that seeded intents, by mode. */
export const SEEDED_COPY = {
  publish: {
    lead: "From what you told me at signup, I've set up these signals:",
    close: "Say change or pause to adjust any of them, or tell me a new one.",
  },
  paused: {
    lead: "From what you told me at signup, I've drafted these signals, paused until you say go:",
    close: "Say go to publish any of them, change or drop to adjust, or tell me a new one.",
  },
} as const;

/**
 * The Edge City app's suggested Context questions (agentvillage-app
 * src/lib/agent/context.ts DEFAULT_QUESTIONS), the three the "Add more"
 * flow asks, word for word.
 */
export const CONTEXT_QUESTIONS = [
  "What are you most excited about this month?",
  "What would make this month a real success for you?",
  "What are you unusually good at helping other people with?",
] as const;

/** How the seed leaves what it creates: published (the default), or paused until the resident says go. */
export type SeedMode = "publish" | "paused";

/**
 * `seeded`: this run seeded at least one intent, in that mode, and `titles`
 * starts with them (the seeded lead and closing sentence, SEEDED_COPY).
 */
export type IntentsRead =
  | { kind: "listed"; titles: string[]; seeded?: SeedMode }
  | { kind: "unreachable" };

const UNREACHABLE: IntentsRead = { kind: "unreachable" };

/** What a run's seed did: intents it created (and, paused mode, paused), and lines it meant to and could not. */
export type SeedCounts = { intents_seeded: number; seed_failed: number };
const NO_SEED: SeedCounts = { intents_seeded: 0, seed_failed: 0 };

/** The branch a welcome took, as `--draft` reports it on stderr. */
export type WelcomeBranch = { fallback: "none" | "questions" | "unreachable"; intents_listed: number } & SeedCounts;

/** The branch welcomeText takes for `read`, how many intents it lists, and what the seed did. Pure. */
export function welcomeBranch(read: IntentsRead, seed: SeedCounts = NO_SEED): WelcomeBranch {
  const counts = { intents_seeded: seed.intents_seeded, seed_failed: seed.seed_failed };
  if (read.kind === "unreachable") return { fallback: "unreachable", intents_listed: 0, ...counts };
  if (read.titles.length === 0) return { fallback: "questions", intents_listed: 0, ...counts };
  return { fallback: "none", intents_listed: Math.min(read.titles.length, MAX_LISTED), ...counts };
}

/** The `--draft` stderr line for `branch`, without its newline: these five keys in this order, always, nothing else. */
export function draftTrailer(branch: WelcomeBranch): string {
  return JSON.stringify({
    welcome: 1,
    fallback: branch.fallback,
    intents_listed: branch.intents_listed,
    intents_seeded: branch.intents_seeded ?? 0,
    seed_failed: branch.seed_failed ?? 0,
  });
}

function homeFrom(argv: string[]): string {
  const i = argv.indexOf("--home");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

/**
 * The resident's active intents from a `list_intents` text, as clean titles,
 * in Index's order: archived and paused ones dropped (the welcome promises to
 * watch for these, and a paused intent is not being matched), the title from
 * `summary` else `description`, one plain line of at most TITLE_MAX code
 * points (cut at a word boundary, with an ellipsis), repeats dropped. Titles go through cleanTitle, the stricter
 * cleaner for text read back from a store: the resident, Index's summariser
 * and the agent's own memory job all write intents, and the welcome is sent
 * as printed, so no link, domain, `@handle`, `/command`, cashtag, phone
 * number, markup or control character reaches the resident. Throws IndexMcpError when Index's answer is a
 * failure or cannot be read (toolJsonArray), never an empty list for that.
 */
export function intentTitles(text: string): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const row of toolJsonArray(text, "intents")) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const intent = row as { summary?: unknown; description?: unknown; status?: unknown };
    if (intent.status === "archived" || intent.status === "paused") continue;
    const raw = typeof intent.summary === "string" && intent.summary.trim() ? intent.summary : intent.description;
    const title = cleanTitle(raw, TITLE_MAX, "word");
    if (!title) continue;
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    titles.push(title);
  }
  return titles;
}

/** One `list_intents` call; any failure, or no key, is `unreachable`. Never throws. */
export async function readIntents(options: {
  apiKey: string;
  mcpUrl: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Promise<IntentsRead> {
  return (await listIntents({ ...options, timeoutMs: options.timeoutMs ?? WELCOME_INDEX_TIMEOUT_MS })).read;
}

/** One intent of a `list_intents` answer, whatever its status, as the seed compares against it. */
export type IntentRow = { id: string | null; active: boolean; title: string | null; keys: string[] };

/**
 * Every intent row of a `list_intents` text, archived and paused ones too:
 * its id, whether it is active (neither archived nor paused, as intentTitles
 * counts it), its title as intentTitles makes it, and the seed's keys
 * (seedKey) of its summary and of its description. Throws like intentTitles.
 */
export function intentRows(text: string): IntentRow[] {
  const rows: IntentRow[] = [];
  for (const row of toolJsonArray(text, "intents")) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const intent = row as { id?: unknown; summary?: unknown; description?: unknown; status?: unknown };
    const raw = typeof intent.summary === "string" && intent.summary.trim() ? intent.summary : intent.description;
    const keys = [intent.summary, intent.description].map(seedKey).filter((k): k is string => k !== null);
    rows.push({
      id: plainId(intent.id),
      active: intent.status !== "archived" && intent.status !== "paused",
      title: cleanTitle(raw, TITLE_MAX, "word"),
      keys,
    });
  }
  return rows;
}

type Listed = { read: IntentsRead; rows: IntentRow[] | null };

/** One `list_intents` call through `target`: the read and its rows; any failure, or no key, is `unreachable`. Never throws. */
async function listIntents(target: IndexMcpTarget): Promise<Listed> {
  if (!target.apiKey) return { read: UNREACHABLE, rows: null };
  try {
    const text = await callIndexTool(target, "list_intents", { limit: 20 });
    return { read: { kind: "listed", titles: intentTitles(text) }, rows: intentRows(text) };
  } catch {
    return { read: UNREACHABLE, rows: null };
  }
}

// ── The seed (DATA-412) ──────────────────────────────────────────────────────

/**
 * The intentions the resident selected at signup, in the profile's order:
 * the text of each `- [<category>] <text>` line of the `## Selected
 * intentions` section of `$HERMES_HOME/USER.md` (the app's profileText), that
 * is everything after the first `] `, trimmed. The section runs from its
 * heading line to the next line starting with `## `, or the end of the file.
 * The app writes that heading exactly once; text the participant supplied
 * (imported context before it, follow-up answers and offers after it) may
 * hold newlines and so a copy of it, and then nothing is read at all
 * (DATA-416 M1). A line of any other shape, a category outside
 * INTENTION_CATEGORIES, or a line empty after its tag, is skipped. No other
 * change is made to the text: these are the resident's own words. A missing
 * or unreadable file, or no section, is none. Never throws, never logs.
 */
export function selectedIntentions(home: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(home, USER_MD_FILE), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const start = lines.indexOf(SELECTED_HEADING);
  if (start < 0 || lines.indexOf(SELECTED_HEADING, start + 1) >= 0) return [];
  const selected: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const match = /^- \[([^\]]*)\] ([\s\S]*)$/.exec(line);
    if (!match || !INTENTION_CATEGORIES.includes(match[1])) continue;
    const text = match[2].trim();
    if (text) selected.push(text);
  }
  return selected;
}

/**
 * What the seed compares: the text as the welcome would show it (cleanTitle
 * at TITLE_MAX, cut at a word), lower-cased. Null when nothing showable is
 * left, and the seed never sends such a line.
 */
export function seedKey(text: unknown): string | null {
  return cleanTitle(text, TITLE_MAX, "word")?.toLocaleLowerCase() ?? null;
}

/** `AV_WELCOME_SEED_MODE` (environment, else `$HERMES_HOME/.env`): `paused`, else `publish`. */
export function seedMode(home: string): SeedMode {
  return envOrDotenv("AV_WELCOME_SEED_MODE", home).toLowerCase() === "paused" ? "paused" : "publish";
}

/** An intent id as Index names one: a plain token, else null. */
function plainId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * True when a write tool's answer says it did nothing: `intent_needs_revision`
 * anywhere in it (tools.md: nothing was created), or a JSON object whose
 * `success` is not true. Pure.
 */
export function writeRefused(text: string): boolean {
  if (text.includes("intent_needs_revision")) return true;
  const root = answerObject(text);
  return !!root && "success" in root && root.success !== true;
}

/** The JSON object after a write answer's markdown lead (one line break or a blank line before it), or null. */
function answerObject(text: string): Record<string, unknown> | null {
  return toolJsonObject(text)?.root ?? toolJsonObject(text.replace(/\n(?=[ \t]*\{)/g, "\n\n"))?.root ?? null;
}

/**
 * The intent a `create_intent` answer names: its id (the intent object's
 * `id` under `data.intent`, a one-item `data.intents` or `intent`, else
 * `intentId` at the top or under `data`, else the one intent link in the
 * text, `?intent=<id>` or `/i/<id>`) and its title (summary else
 * description, through cleanTitle), each null when the answer does not say.
 * Null when the answer is a refusal (writeRefused). Pure.
 */
export function createdIntent(text: string): { id: string | null; title: string | null } | null {
  if (writeRefused(text)) return null;
  const root = answerObject(text);
  const data = record(root?.data);
  const many = data?.intents;
  const intent = record(data?.intent) ?? (Array.isArray(many) && many.length === 1 ? record(many[0]) : null) ?? record(root?.intent);
  const linked = [...new Set([...text.matchAll(/(?:[?&]intent=|\/i\/)([A-Za-z0-9_-]{8,100})/g)].map((m) => m[1]))];
  const id = plainId(intent?.id) ?? plainId(root?.intentId) ?? plainId(data?.intentId) ?? (linked.length === 1 ? linked[0] : null);
  const raw = typeof intent?.summary === "string" && intent.summary.trim() ? intent.summary : intent?.description;
  return { id, title: cleanTitle(raw, TITLE_MAX, "word") };
}

/**
 * Claim the seed: create the marker exclusively, so of two runs at once
 * exactly one claims it, and a marker that exists, whatever it holds, is
 * never claimed again. True when this run claimed it. Throws only on a
 * filesystem failure (and then nothing is created).
 */
export function claimSeed(home: string, selected: number, now: Date = new Date()): boolean {
  const path = join(home, WELCOME_SEED_FILE);
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, seedBody(now, selected, 0, 0, false), { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") return false;
    throw err;
  }
}

function seedBody(now: Date, selected: number, created: number, failed: number, done: boolean): string {
  return `${JSON.stringify({ seededAt: now.toISOString(), selected, created, failed, ...(done ? { done: true } : {}) })}\n`;
}

/** The claimed marker, rewritten with the seed's counts and `done` (temp file and rename). Never throws: the claim already holds. */
function recordSeed(home: string, now: Date, selected: number, created: number, failed: number): void {
  const path = join(home, WELCOME_SEED_FILE);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, seedBody(now, selected, created, failed, true), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // The marker stays as claimed (counts 0, no done): it still means the seed ran.
  }
}

/**
 * True while another run is seeding: the marker is the seed's JSON object
 * without `done: true` (DATA-416 S3). A marker of any other content (not
 * JSON, empty, unreadable) is never waited for.
 */
export function seedInProgress(home: string): boolean {
  try {
    const marker = JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8")) as unknown;
    return record(marker) !== null && (marker as { done?: unknown }).done !== true;
  } catch {
    return false;
  }
}

type Clock = { deadline: number; cap: number | undefined; reserve: number; wait: number; poll: number };

/**
 * `target` with the timeout a call may still have, keeping `reserve` of the
 * budget back (null: too little left to make it).
 */
function timed(target: IndexMcpTarget, clock: Clock, ms: number, reserve = 0): IndexMcpTarget | null {
  const left = clock.deadline - reserve - Date.now();
  const timeoutMs = Math.min(clock.cap ?? ms, left);
  return left < Math.min(WELCOME_MIN_CALL_MS, clock.cap ?? WELCOME_MIN_CALL_MS) || timeoutMs <= 0 ? null : { ...target, timeoutMs };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Another run holds the seed: when it is still seeding, wait for its `done`
 * (at most clock.wait, polling every clock.poll, within the budget) and list
 * again, so the welcome shows what it created; else the first read stands.
 */
async function awaitSeed(home: string, target: IndexMcpTarget, first: { read: IntentsRead }, clock: Clock): Promise<{ read: IntentsRead; seed: SeedCounts }> {
  const unchanged = { read: first.read, seed: NO_SEED };
  if (!seedInProgress(home)) return unchanged;
  const until = Math.min(Date.now() + clock.wait, clock.deadline - Math.min(clock.reserve, WELCOME_INDEX_TIMEOUT_MS));
  while (seedInProgress(home) && Date.now() < until) await sleep(Math.max(1, Math.min(clock.poll, until - Date.now())));
  const relistTarget = timed(target, clock, WELCOME_INDEX_TIMEOUT_MS);
  const again = relistTarget ? await listIntents(relistTarget) : { read: UNREACHABLE, rows: null };
  return { read: again.read.kind === "listed" ? again.read : first.read, seed: NO_SEED };
}

/**
 * The seed, after a read that listed `first` (DATA-412, DATA-416): when no
 * welcome was sent yet (`welcomed` false, in both modes), no intent is
 * active, the marker does not exist, and the resident selected intentions,
 * claim the marker and create up to MAX_LISTED of them at once (a line whose
 * seedKey repeats one already taken this run, or any listed intent's
 * whatever its status, is skipped and not counted; a line with no key is
 * skipped), pausing each in `paused` mode, keeping WELCOME_RELIST_RESERVE_MS
 * of the budget for the second list; then list again. A create whose own
 * call failed but whose text the second list shows active is counted as
 * seeded (publish mode). A marker another run is still filling is waited
 * for (awaitSeed). The read the welcome is composed from, and the counts.
 * Never throws.
 */
async function seedWelcome(
  home: string,
  target: IndexMcpTarget,
  first: { read: IntentsRead; rows: IntentRow[] },
  clock: Clock,
  now: Date,
  welcomed: boolean,
): Promise<{ read: IntentsRead; seed: SeedCounts }> {
  const unchanged = { read: first.read, seed: NO_SEED };
  if (welcomed) return unchanged;
  if (first.read.kind !== "listed" || first.read.titles.length !== 0) return unchanged;
  if (existsSync(join(home, WELCOME_SEED_FILE))) return awaitSeed(home, target, first, clock);
  const selected = selectedIntentions(home);
  const sent = new Set(first.rows.flatMap((row) => row.keys));
  const lines: Array<{ text: string; title: string; key: string }> = [];
  for (const text of selected) {
    if (lines.length === MAX_LISTED) break;
    const key = seedKey(text);
    if (key === null || sent.has(key)) continue;
    sent.add(key);
    lines.push({ text, title: cleanTitle(text, TITLE_MAX, "word")!, key });
  }
  if (lines.length === 0) return unchanged;
  try {
    if (!claimSeed(home, selected.length, now)) return awaitSeed(home, target, first, clock);
  } catch {
    return unchanged;
  }

  const mode = seedMode(home);
  const made = (await Promise.allSettled(lines.map((line) => seedOne(target, clock, mode, line.text)))).map((r) =>
    r.status === "fulfilled" ? r.value : null,
  );
  const relistTarget = timed(target, clock, WELCOME_INDEX_TIMEOUT_MS);
  const again = relistTarget ? await listIntents(relistTarget) : { read: UNREACHABLE, rows: null };
  const seeded: Array<{ id: string | null; title: string; key: string }> = [];
  let failed = 0;
  lines.forEach((line, i) => {
    const one = made[i];
    if (one) seeded.push({ id: one.id, title: one.title ?? line.title, key: line.key });
    // A create that landed after its own call gave up (publish mode: in paused mode it was never paused).
    else if (mode === "publish" && again.rows?.some((row) => row.active && row.keys.includes(line.key))) seeded.push({ id: null, title: line.title, key: line.key });
    else failed++;
  });
  recordSeed(home, now, selected.length, seeded.length, failed);
  const seed = { intents_seeded: seeded.length, seed_failed: failed };

  if (seeded.length === 0) return { read: again.read.kind === "listed" ? again.read : first.read, seed };
  // A seeded intent's row in the second list: by the id its create answer named, else by the text sent.
  const rowOf = (s: { id: string | null; key: string }) =>
    again.rows?.find((row) => (s.id !== null ? row.id === s.id : row.keys.includes(s.key))) ?? null;
  const mine = new Set(seeded.map(rowOf).filter((row) => row !== null));
  const titles = seeded.map((s) => rowOf(s)?.title ?? s.title);
  if (mode === "publish") {
    for (const row of again.rows ?? []) if (row.active && row.title !== null && !mine.has(row)) titles.push(row.title);
  }
  const seen = new Set<string>();
  const unique = titles.filter((t) => {
    const key = t.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { read: { kind: "listed", titles: unique, seeded: mode }, seed };
}

/**
 * One selected line: `create_intent` with its text as `description` and
 * SEED_SOURCE_TYPE as `sourceType`, nothing else, then, in `paused` mode,
 * `pause_intent` with the id the answer names. The intent (its id and
 * title, when the answer says), or null when the line failed: a throw, an
 * `isError` answer, a refusal, too little time left to call (the second
 * list's reserve kept back), or in `paused` mode no id to pause or a pause
 * that failed (never retried).
 */
async function seedOne(
  target: IndexMcpTarget,
  clock: Clock,
  mode: SeedMode,
  description: string,
): Promise<{ id: string | null; title: string | null } | null> {
  try {
    const createTarget = timed(target, clock, WELCOME_SEED_TIMEOUT_MS, clock.reserve);
    if (!createTarget) return null;
    const made = createdIntent(await callIndexTool(createTarget, "create_intent", { description, sourceType: SEED_SOURCE_TYPE }));
    if (!made || mode === "publish") return made;
    if (made.id === null) return null;
    const pauseTarget = timed(target, clock, WELCOME_SEED_TIMEOUT_MS, clock.reserve);
    if (!pauseTarget) return null;
    return writeRefused(await callIndexTool(pauseTarget, "pause_intent", { intentId: made.id })) ? null : made;
  } catch {
    return null;
  }
}

/**
 * The app's Intents page, on the same host as the brief's Connections link
 * (`AV_CONNECTIONS_URL`), or on the default host when that link would be
 * longer than INTENTS_URL_MAX characters.
 */
export function intentsPageUrl(home: string): string {
  const href = new URL("/intents", connectionsUrl(home)).href;
  return href.length <= INTENTS_URL_MAX ? href : new URL("/intents", DEFAULT_CONNECTIONS_URL).href;
}

/** The agent's name: the resident's nickname for it, else Edge. Never throws, never logs. */
export function welcomeName(home: string): string {
  try {
    const name = agentName(readProfile(home, () => {}));
    return cronScanHit(name) ? DEFAULT_NAME : name;
  } catch {
    return DEFAULT_NAME;
  }
}

/**
 * The listed titles cut so that together they take at most `budget`
 * characters (UTF-16 code units). Unchanged when they already fit; otherwise
 * every title longer than a common length L is cut to L at a word boundary
 * with an ellipsis (cutAtWord), L being the largest length at which the
 * titles fit, so the shorter ones stay whole and the longest give way first.
 * Pure.
 */
export function fitTitles(titles: string[], budget: number): string[] {
  const room = (cap: number) => titles.reduce((sum, t) => sum + Math.min(t.length, cap), 0);
  const longest = Math.max(0, ...titles.map((t) => t.length));
  if (room(longest) <= budget) return titles;
  let fits = 0;
  let over = longest;
  while (over - fits > 1) {
    const mid = Math.floor((fits + over) / 2);
    if (room(mid) <= budget) fits = mid;
    else over = mid;
  }
  return titles.map((t) => (t.length <= fits ? t : cutAtWord(t, fits, "utf16")));
}

/**
 * The welcome. Pure. With intents listed (seeded or not), at most
 * WELCOME_MAX_CHARS long whenever the rest of the text leaves room, which it
 * always does for a name of at most 32 code points and a link of at most
 * INTENTS_URL_MAX characters (welcome.test.ts, the worst cases).
 */
export function welcomeText(name: string, read: IntentsRead, intentsUrl: string): string {
  if (read.kind === "unreachable" || read.titles.length === 0) return composeWelcome(name, read, intentsUrl, []);
  const titles = read.titles.slice(0, MAX_LISTED);
  const rest = composeWelcome(name, read, intentsUrl, titles.map(() => "")).length;
  return composeWelcome(name, read, intentsUrl, fitTitles(titles, Math.max(0, WELCOME_MAX_CHARS - rest)));
}

/** The welcome's text with `listed` as the intent lines (the listed branch only). */
function composeWelcome(name: string, read: IntentsRead, intentsUrl: string, listed: string[]): string {
  const intro =
    name === DEFAULT_NAME
      ? "Mandrem, Goa, October 11 to November 1. I'm your personal agent for your time in the village. You can call me Edge, or give me whatever name you like."
      : `Mandrem, Goa, October 11 to November 1. I'm ${name}, your personal agent for your time in the village.`;
  const parts = ["Welcome to Edge City India ☀️", intro];
  if (read.kind === "unreachable") {
    parts.push(
      "I can't see what you're here for just yet, so I'll catch up and bring people and events that fit to your morning brief.",
      "Meanwhile, tell me what you're looking for, or ask me anything about the village.",
    );
  } else if (read.titles.length === 0) {
    parts.push(
      ["To find your people, I'd love three quick answers, a line or two each:", ...CONTEXT_QUESTIONS.map((q) => `- ${q}`)].join("\n"),
      "I'll turn your answers into intents you can confirm, then look for people and events that fit and bring the best to your morning brief.",
    );
  } else if (read.seeded) {
    const copy = SEEDED_COPY[read.seeded];
    parts.push(
      [copy.lead, ...listed.map((t) => `- ${t}`)].join("\n"),
      `I'll keep watch for people and events that fit ${listed.length === 1 ? "this" : "these"} and bring the best to your morning brief.`,
      copy.close,
    );
  } else {
    const lead = read.titles.length > MAX_LISTED ? "Here are three of the things I have you down for:" : "Here's what I have you down for so far:";
    parts.push(
      [lead, ...listed.map((t) => `- ${t}`)].join("\n"),
      `I'll keep watch for people and events that fit ${listed.length === 1 ? "this" : "these"} and bring the best to your morning brief.`,
      `To add or change one, use the Intents page in the app (${intentsUrl}) or just tell me.`,
    );
  }
  return parts.join("\n\n");
}

/** True when the marker records a sent welcome (install/welcome_state.ts recordsWelcomeSent). */
export function welcomeAlreadySent(home: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(home, WELCOME_STATE_FILE), "utf8")) as { welcomeSent?: unknown })?.welcomeSent === true;
  } catch {
    return false;
  }
}

/**
 * Claim the welcome: write the marker unless it already records one. A new
 * marker is created exclusively, so of two runs at once exactly one claims
 * it; a marker that exists but does not record a welcome (unreadable, not
 * JSON, `welcomeSent` not true) is replaced by temp file and rename. True
 * when this run claimed it. Throws only on a filesystem failure.
 */
export function claimWelcome(home: string, now: Date = new Date()): boolean {
  const path = join(home, WELCOME_STATE_FILE);
  const body = `${JSON.stringify({ welcomeSent: true, sentAt: now.toISOString() })}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, body, { flag: "wx", mode: 0o600 });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
  }
  if (welcomeAlreadySent(home)) return false;
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, path);
  return true;
}

/**
 * Tests only: `timeoutMs` caps every Index call; `budgetMs`, `reserveMs`,
 * `waitMs` and `pollMs` replace WELCOME_BUDGET_MS, WELCOME_RELIST_RESERVE_MS,
 * WELCOME_SEED_WAIT_MS and WELCOME_SEED_POLL_MS.
 */
type WelcomeOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
  budgetMs?: number;
  reserveMs?: number;
  waitMs?: number;
  pollMs?: number;
  now?: Date;
};

/**
 * What the script prints, given its arguments, and the branch the text took
 * (null for ALREADY_SENT, which `--draft` never prints). Seeds first when it
 * should (seedWelcome), in both modes. Never throws.
 */
export async function welcomeRun(argv: string[], options: WelcomeOptions = {}): Promise<{ text: string; branch: WelcomeBranch | null }> {
  const home = homeFrom(argv);
  const draft = argv.includes("--draft");
  const welcomed = welcomeAlreadySent(home);
  if (!draft && welcomed) return { text: ALREADY_SENT, branch: null };
  const clock: Clock = {
    deadline: Date.now() + (options.budgetMs ?? WELCOME_BUDGET_MS),
    cap: options.timeoutMs,
    reserve: options.reserveMs ?? WELCOME_RELIST_RESERVE_MS,
    wait: options.waitMs ?? WELCOME_SEED_WAIT_MS,
    poll: options.pollMs ?? WELCOME_SEED_POLL_MS,
  };
  const target: IndexMcpTarget = { apiKey: envOrDotenv("INDEX_API_KEY", home), mcpUrl: indexMcpUrl(), fetch: options.fetch };
  const first = await listIntents({ ...target, timeoutMs: options.timeoutMs ?? WELCOME_INDEX_TIMEOUT_MS });
  const { read, seed } = first.rows
    ? await seedWelcome(home, target, { read: first.read, rows: first.rows }, clock, options.now ?? new Date(), welcomed)
    : { read: first.read, seed: NO_SEED };
  const out = { text: welcomeText(welcomeName(home), read, intentsPageUrl(home)), branch: welcomeBranch(read, seed) };
  if (draft) return out;
  try {
    if (!claimWelcome(home, options.now)) return { text: ALREADY_SENT, branch: null };
  } catch {
    // The marker could not be written: still welcome (never silent); the next first message may welcome again.
  }
  return out;
}

/** What the script prints, given its arguments. Never throws. */
export async function welcome(argv: string[], options: WelcomeOptions = {}): Promise<string> {
  return (await welcomeRun(argv, options)).text;
}

/**
 * The script: the message and a newline on stdout; with `--draft`, then the
 * trailer and a newline on stderr; without it, nothing on stderr. A run that
 * throws prints the unreachable welcome (and, with `--draft`, its trailer).
 * `run` and the writers are parameters for the tests only.
 */
export async function main(
  argv: string[],
  io: { stdout: (s: string) => void; stderr: (s: string) => void },
  run: (argv: string[]) => Promise<{ text: string; branch: WelcomeBranch | null }> = welcomeRun,
): Promise<void> {
  let out: { text: string; branch: WelcomeBranch | null };
  try {
    out = await run(argv);
  } catch {
    out = { text: welcomeText(DEFAULT_NAME, UNREACHABLE, intentsPageUrl(homeFrom(argv))), branch: welcomeBranch(UNREACHABLE) };
  }
  io.stdout(`${out.text}\n`);
  if (argv.includes("--draft") && out.branch) io.stderr(`${draftTrailer(out.branch)}\n`);
}

if (import.meta.main) {
  await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(0);
}
