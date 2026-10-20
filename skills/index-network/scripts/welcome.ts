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
 *     them, and how to add, change or pause one (just tell me);
 *   - no active intents, and the resident told the app nothing at signup
 *     (hasSetupContext): under "Your intents", the app's three Context questions and a promise to
 *     turn the answers into intents the resident confirms;
 *   - no active intents, but the resident did tell the app something at
 *     signup: CONTEXT_COPY, which says the agent read it and asks what to
 *     look for first, never the three questions again;
 *   - no key, Index unreachable or an answer it cannot read: the welcome
 *     without the list, saying it cannot load the intents right now.
 *
 * DATA-412 / DATA-416: the seed. When no welcome was sent yet (the welcome
 * marker below, read in both modes), that read succeeds and lists no active
 * intent, the resident selected intentions at signup (`## Selected
 * intentions` in the app's profile at `$HERMES_HOME/USER.md`:
 * selectedIntentions), and the seed marker `memory/welcome-seed.json` does
 * not exist, the script claims that marker (created exclusively, so the
 * creates run once per box, in both modes) and creates up to three of those
 * lines at once, each with one `POST <origin>/api/intents` of
 * `{description: <the line's text>, sourceType: "agentvillage"}` and nothing
 * else (index-mcp.ts createIntentDirect: no `/prepare`, no
 * `preparationReceipt`, so Index stores the line as written and runs no
 * admission); a line that repeats another one, or any intent Index lists
 * whatever its status, is skipped.
 * `AV_WELCOME_SEED_MODE=paused` pauses each one it created (`pause_intent`).
 * It then lists the intents again (the creates leave it
 * WELCOME_RELIST_RESERVE_MS of the budget) and the welcome names the seeded
 * ones first ("Based on what you shared at signup, ..."); the marker then gets
 * `done`. A run that finds the marker already there, whatever its first list
 * showed (another run's creates may have landed only in part), waits while it
 * lacks `done` and then lists again, so its welcome shows what was seeded.
 * Nothing of the resident's but the selected texts is sent, and no text is
 * logged. It never changes, publishes or archives an intent it did not
 * create.
 *
 * Known limits (DATA-416). In paused mode, a create that landed but answered
 * too late, or whose `pause_intent` failed, stays published while the trailer
 * counts it failed and the paused welcome leaves it out (paused mode is not
 * used in production). The seed marker is claimed by an exclusive create and
 * then written, not in one atomic step: a run that reads it in between finds
 * it empty, does not wait, and may list only part of the seed (theoretical:
 * a window of microseconds).
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
 *   {"welcome":1,"fallback":"none|questions|context|unreachable","intents_listed":<0..3>,"intents_seeded":<0..3>,"seed_failed":<0..3>}
 *
 * `fallback` is the branch the text took (`none`: intents listed, seeded
 * ones included; `questions`: no active intents and no signup context;
 * `context`: no active intents, signup context read, questions skipped;
 * `unreachable`: no key, Index unreachable, or the script failed and printed
 * the unreachable text),
 * `intents_listed` the number of `- ` intent lines printed (1..3 for `none`,
 * else 0), `intents_seeded` the intents this run created (and, paused mode,
 * paused) and `seed_failed` the lines it meant to seed and could not (both 0
 * when nothing was attempted). It never carries text. It always exits 0.
 *
 * Two switches add keys after these five, each off by default (unset: the
 * line is exactly the one above), because the data door refuses a
 * welcome.sent with a key it does not know and an older control plane refuses
 * the whole line with an extra key: each goes on only after the data release
 * and the control plane's pass-through. `AV_SEED_TRAILER_V2=1` (seedTrailerV2)
 * adds `seed_codes` and `seed_recovery_kinds` when the seed left any.
 * `AV_WELCOME_REASON=1` (welcomeReasonOn, U-1a; environment, else
 * `$HERMES_HOME/.env`; the control plane sets it per tenant) adds, last and
 * only when `fallback` is `unreachable`, `"reason":"no_key|list_failed|bad_answer"`
 * (UnreachableReason: why the list could not be read; codes only). A run that
 * threw and printed the unreachable text has no reason (the control plane's
 * own `script_failed` covers a script that failed; this script never prints
 * that code).
 *
 * SEED-REVISION (routing (c), 12 Oct 2026): a line whose create Index answers
 * non-2xx with its `intent_needs_revision` refusal (index-mcp.ts
 * intentRefusal; since the direct create, 13 Oct 2026, the only refusal kept:
 * any other non-2xx, a timeout or no answer is a plain failed line) still
 * counts in `seed_failed` exactly as before, and the seed marker also keeps
 * it under `refused`: the resident's own line (at most REFUSED_LINE_MAX code
 * points), Index's feedback (refusedFeedback: cleaned, scanned, withheld
 * whole as null on a hit), the code, the run's time and the key names (never
 * the values) of Index's answer (the block below also reads a `prepare`
 * category and recovery questions, but no marker on a box holds them: no
 * roll shipped the prepare seed, rc34 carries neither ov#302 nor ov#303, and
 * the direct create never writes them; and `refused` fills only on a REST
 * `intent_needs_revision` answer, which Index's create does not send at
 * a91c3ff: the ruling's defensive trigger). The default run that
 * prints WELCOME_ALREADY_SENT (the AGENTS.md welcome gate, once the welcome
 * went out) then also prints, once ever, one line naming ONE refused line
 *
 *   REFUSED_SEEDS [{"line":"...","kind":"single"|"multi"|"text"|null,"question":"..."|null}]
 *
 * the resident's own line (if they still have it on their Context page) and
 * Index's first recovery question (refusedQuestion: cleaned, scanned, tool
 * names in any spelling and stop words withheld whole as null). Index's
 * feedback is never printed. Every pending entry is marked `surfacedAt`, so
 * the agent asks the resident once to say it in their own words and
 * publishes only their answer, with their yes. The script never sends a
 * refused line again; `--draft` never prints the block.
 */

import { existsSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { DEFAULT_NAME, agentName, readProfile } from "../../agent-profile/scripts/profile";
import {
  type DirectCreate,
  type IndexMcpTarget,
  type IntentRefusal,
  type RecoveryQuestion,
  AGENTVILLAGE_SOURCE_TYPE,
  IndexMcpError,
  callIndexTool,
  createIntentDirect,
  indexMcpUrl,
  toolJsonArray,
  toolJsonObject,
} from "./index-mcp";
import { type ContextTags, contextHolds, contextTagsState } from "./context-tags";
import { DEFAULT_CONNECTIONS_URL, cleanTitle, connectionsUrl, cronScanHit, cutAtWord, envOrDotenv } from "./proactive-text";
import { type GuardHit, QUESTION_MAX, questionGuardHit } from "./question-guard";
import { type HeldLock, acquireStateLock, tryAcquireLock } from "./state-lock";

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
 * at most. The coordinated control-plane delivery cap is 2100, leaving room
 * below Telegram's 4096-character message limit. welcomeText holds every
 * welcome to this smaller generator cap: the listed titles share what the
 * rest of the text leaves (fitTitles).
 */
export const WELCOME_MAX_CHARS = 2000;
/**
 * Characters of the Intents link at most: a longer one (an AV_CONNECTIONS_URL
 * host of absurd length) gives way to the default host's, so the link can
 * never crowd the intents out of the welcome.
 */
export const INTENTS_URL_MAX = 200;
/** The welcome's Index read gives up sooner than the brief's: the resident is waiting for a first reply. */
export const WELCOME_INDEX_TIMEOUT_MS = 10_000;
/**
 * One seed call (the create, `pause_intent`) at most: a create runs Index's
 * intent graph, which takes longer than a read.
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
 * without `done`) waits for it, and how often it looks (DATA-416 S3). The
 * wait outlasts one seed call (WELCOME_SEED_TIMEOUT_MS, 20 s: the creates run
 * at once), so a slow create still shows in the waiting run's welcome; it
 * ends by the budget less the second list's reserve in any case, and the
 * first list (10 s), the wait and the second list (10 s) fit in
 * WELCOME_BUDGET_MS (DATA-416 W1 fix round 2: 25 s, was 10 s).
 */
export const WELCOME_SEED_WAIT_MS = 25_000;
export const WELCOME_SEED_POLL_MS = 500;
/**
 * `sourceType` on every intent the overlay creates (the av-events plugin's
 * SOURCE_TYPE, which its poller reads; index-mcp.ts AGENTVILLAGE_SOURCE_TYPE,
 * which also tells Index to store the line as written): a constant, never
 * resident text.
 */
export const SEED_SOURCE_TYPE = AGENTVILLAGE_SOURCE_TYPE;
/** SEED-REVISION: the line the default run prints after ALREADY_SENT, once, when Index refused seed lines. */
export const REFUSED_SEEDS = "REFUSED_SEEDS";
/** Code points of a refused line kept and printed at most (the resident's own text, cut at a word). */
export const REFUSED_LINE_MAX = 200;
/** Code points of Index's feedback kept at most in the seed marker (cleanTitle, cut at a word). Never printed. */
export const REFUSED_FEEDBACK_MAX = 160;
/** Refused lines one REFUSED_SEEDS block names: one (lead 18:19Z, ONE recovery question); the others are recorded, never printed. */
export const REFUSED_SHOWN_MAX = 1;
/** Code points of Index's recovery question printed at most; a longer one is withheld whole (question-guard.ts). */
export const REFUSED_QUESTION_MAX = QUESTION_MAX;
/**
 * SEED-REJECT part 3b: the trailer's codes, to the data door's contract
 * (agentvillage-data #506, CLAIMS 18:28Z ruling: codes only): at most
 * SEED_CODES_MAX `seed_codes`, each SEED_CODE, one per seed line that left a
 * code; at most SEED_RECOVERY_KINDS_MAX `seed_recovery_kinds`.
 */
export const SEED_CODES_MAX = 3;
export const SEED_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;
export const SEED_RECOVERY_KINDS_MAX = 4;
/** A line whose create could not even start: too little of the budget left. */
export const BUDGET_EXHAUSTED = "budget_exhausted";

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
/**
 * The profile's sections that hold what the resident told the app at signup
 * (agentvillage-app profile-text.ts profileText, in its order): imported
 * context, kept intentions, follow-up answers, offers.
 */
export const CONTEXT_HEADING = "## Context supplied by the participant";
export const FOLLOW_UP_HEADING = "## Follow-up preferences";
export const OFFERS_HEADING = "## Offers";
export const SETUP_HEADINGS = [CONTEXT_HEADING, SELECTED_HEADING, FOLLOW_UP_HEADING, OFFERS_HEADING] as const;

/** The lead and closing sentence of a welcome that seeded intents and lists two or more, by mode. */
export const SEEDED_COPY = {
  publish: {
    lead: "Based on what you shared at signup, these intents are active:",
    close: "Tell me if you'd like to add, change, or pause an intent.",
  },
  paused: {
    lead: "Based on what you shared at signup, these intents are paused:",
    close: "Tell me when you'd like to publish, change, or drop one, or add a new intent.",
  },
} as const;

/** The same when the seeded welcome lists exactly one intent: singular throughout (DATA-416 Q3). */
export const SEEDED_COPY_ONE = {
  publish: {
    lead: "Based on what you shared at signup, this intent is active:",
    close: "Tell me if you'd like to add, change, or pause an intent.",
  },
  paused: {
    lead: "Based on what you shared at signup, this intent is paused:",
    close: "Tell me when you'd like to publish, change, or drop it, or add a new intent.",
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

/**
 * The welcome's paragraphs when Index lists no active intent but the resident
 * told the app something at signup (hasSetupContext): never the three
 * questions they already answered. The lead opens its own paragraph (the
 * control plane's WELCOME_BRANCHES reads it).
 */
export const CONTEXT_COPY = {
  lead: "I've read what you shared at signup, but you don't have an active intent yet. Tell me what you'd like me to look for first.",
  close: "I'll turn it into an intent for you to confirm, then look for people and events that fit.",
} as const;

/** How the seed leaves what it creates: published (the default), or paused until the resident says go. */
export type SeedMode = "publish" | "paused";

/**
 * `seeded`: this run seeded at least one intent, in that mode, and `titles`
 * starts with them (the seeded lead and closing sentence: SEEDED_COPY, or
 * SEEDED_COPY_ONE when the welcome lists exactly one).
 */
export type IntentsRead =
  | { kind: "listed"; titles: string[]; seeded?: SeedMode }
  | { kind: "unreachable"; reason?: UnreachableReason };

const UNREACHABLE: IntentsRead = { kind: "unreachable" };

/**
 * U-1a: why a read is `unreachable`, a closed set of codes (never text, never
 * ids). `no_key`: no Index key, so no call; `list_failed`: the `list_intents`
 * call failed (a transport failure or timeout, an HTTP status other than 200,
 * a JSON-RPC error, or Index flagging the tool call failed); `bad_answer`:
 * Index answered but the answer could not be read (no result, a result that
 * is not complete, no text, or a text with no intents list: parse).
 */
export const UNREACHABLE_REASONS = ["no_key", "list_failed", "bad_answer"] as const;
export type UnreachableReason = (typeof UNREACHABLE_REASONS)[number];

/** The IndexMcpError codes of an answer Index sent but this script could not read (unreachableReason). */
const BAD_ANSWER_CODES: readonly string[] = ["mcp-bad-response", "mcp-result-type", "mcp-unparsed"];

/**
 * The reason a `list_intents` call that threw `err` is unreachable: an
 * IndexMcpError whose code says the answer could not be read, or anything
 * thrown that is not an IndexMcpError (reading the answer), is `bad_answer`;
 * every other IndexMcpError (`mcp-unreachable`, `mcp-http-*`,
 * `mcp-rpc-error*`, `mcp-tool-error`) is `list_failed`. Pure.
 */
export function unreachableReason(err: unknown): UnreachableReason {
  if (!(err instanceof IndexMcpError)) return "bad_answer";
  return BAD_ANSWER_CODES.includes(err.code) ? "bad_answer" : "list_failed";
}

/** What a run's seed did: intents it created (and, paused mode, paused), and lines it meant to and could not. */
/**
 * What a run's seed did: intents it created (and, paused mode, paused), and
 * lines it meant to and could not; SEED-REJECT part 3b: the code each line
 * left (seedCodes) and the kinds of Index's recovery questions, both for the
 * trailer behind AV_SEED_TRAILER_V2 (codes only, never text).
 */
export type SeedCounts = { intents_seeded: number; seed_failed: number; seed_codes?: string[]; seed_recovery_kinds?: RecoveryQuestion["kind"][] };
const NO_SEED: SeedCounts = { intents_seeded: 0, seed_failed: 0 };

/** The branch a welcome took, as `--draft` reports it on stderr; `reason` only on `unreachable`, from its read (U-1a). */
export type WelcomeBranch = { fallback: "none" | "questions" | "context" | "unreachable"; intents_listed: number; reason?: UnreachableReason } & SeedCounts;

/**
 * The branch welcomeText takes for `read`, how many intents it lists, and
 * what the seed did. `context`: the resident told the app something at
 * signup (hasSetupContext). Pure.
 */
export function welcomeBranch(read: IntentsRead, seed: SeedCounts = NO_SEED, context = false): WelcomeBranch {
  const counts: SeedCounts = {
    intents_seeded: seed.intents_seeded,
    seed_failed: seed.seed_failed,
    ...(seed.seed_codes?.length ? { seed_codes: seed.seed_codes } : {}),
    ...(seed.seed_recovery_kinds?.length ? { seed_recovery_kinds: seed.seed_recovery_kinds } : {}),
  };
  if (read.kind === "unreachable") return { fallback: "unreachable", intents_listed: 0, ...counts, ...(read.reason ? { reason: read.reason } : {}) };
  if (read.titles.length === 0) return { fallback: context ? "context" : "questions", intents_listed: 0, ...counts };
  return { fallback: "none", intents_listed: Math.min(read.titles.length, MAX_LISTED), ...counts };
}

/**
 * The `--draft` stderr line for `branch`, without its newline: these five keys
 * in this order, always; with `v2` (seedTrailerV2), then `seed_codes` and
 * `seed_recovery_kinds` when the seed left any; with `withReason`
 * (welcomeReasonOn), last, `reason` when the branch is `unreachable` and
 * carries one of UNREACHABLE_REASONS; and nothing else, ever.
 */
export function draftTrailer(branch: WelcomeBranch, v2 = false, withReason = false): string {
  return JSON.stringify({
    welcome: 1,
    fallback: branch.fallback,
    intents_listed: branch.intents_listed,
    intents_seeded: branch.intents_seeded ?? 0,
    seed_failed: branch.seed_failed ?? 0,
    // SEED-REJECT part 3b, behind AV_SEED_TRAILER_V2 (seedTrailerV2): codes only, each key only when non-empty.
    ...(v2 && branch.seed_codes?.length ? { seed_codes: branch.seed_codes.slice(0, SEED_CODES_MAX) } : {}),
    ...(v2 && branch.seed_recovery_kinds?.length ? { seed_recovery_kinds: branch.seed_recovery_kinds.slice(0, SEED_RECOVERY_KINDS_MAX) } : {}),
    // U-1a, behind AV_WELCOME_REASON (welcomeReasonOn): a code only, on the unreachable branch only, last.
    ...(withReason && branch.fallback === "unreachable" && branch.reason !== undefined && (UNREACHABLE_REASONS as readonly string[]).includes(branch.reason)
      ? { reason: branch.reason }
      : {}),
  });
}

/**
 * SEED-REJECT part 3b: `AV_SEED_TRAILER_V2` (environment, else `$HERMES_HOME/.env`)
 * is `1`: the trailer may carry `seed_codes` and `seed_recovery_kinds`. Off by
 * default, because the data door refuses a welcome.sent with a key it does not
 * know, and a control plane before part 3a refuses the whole trailer with a
 * sixth key: the switch goes on only after the data release and the cp half.
 */
export function seedTrailerV2(home: string): boolean {
  return envOrDotenv("AV_SEED_TRAILER_V2", home).trim() === "1";
}

/**
 * U-1a: `AV_WELCOME_REASON` (environment, else `$HERMES_HOME/.env`) is `1`:
 * the `--draft` trailer of an unreachable welcome carries `reason`
 * (UnreachableReason). Off by default for the same reasons as
 * AV_SEED_TRAILER_V2: it goes on, per tenant from the control plane, only
 * after data registers `reason` on welcome.sent@1 and the control plane
 * passes it through.
 */
export function welcomeReasonOn(home: string): boolean {
  return envOrDotenv("AV_WELCOME_REASON", home).trim() === "1";
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

/** One `list_intents` call; any failure, or no key, is `unreachable` (with its reason, U-1a). Never throws. */
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

/**
 * One `list_intents` call through `target`: the read and its rows; any
 * failure, or no key, is `unreachable`, with its reason (U-1a: `no_key`, else
 * unreachableReason). Never throws.
 */
async function listIntents(target: IndexMcpTarget): Promise<Listed> {
  if (!target.apiKey) return { read: { kind: "unreachable", reason: "no_key" }, rows: null };
  try {
    const text = await callIndexTool(target, "list_intents", { limit: 20 });
    return { read: { kind: "listed", titles: intentTitles(text) }, rows: intentRows(text) };
  } catch (err) {
    return { read: { kind: "unreachable", reason: unreachableReason(err) }, rows: null };
  }
}

/**
 * True when `$HERMES_HOME/USER.md` holds something the resident told the app
 * at signup, under one of SETUP_HEADINGS (each section runs to the next `#`
 * heading of level 1 or 2): under CONTEXT_HEADING, any non-blank line that is
 * not a `###` source label; under the others, a `- ` line with text after
 * it (a follow-up answer: text after its `: `). The app always writes the
 * headings and the name/work lines, so those alone are not context. A
 * missing or unreadable file is none. Never throws, never logs.
 */
export function hasSetupContext(home: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(home, USER_MD_FILE), "utf8");
  } catch {
    return false;
  }
  let section: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^#{1,2} /.test(line)) {
      section = (SETUP_HEADINGS as readonly string[]).includes(line) ? line : null;
      continue;
    }
    if (section === null || !line.trim()) continue;
    if (section === CONTEXT_HEADING) {
      if (!line.startsWith("### ")) return true;
    } else if (section === FOLLOW_UP_HEADING) {
      if (/^- .*?:\s*\S/.test(line)) return true;
    } else if (/^- \s*\S/.test(line)) {
      return true;
    }
  }
  return false;
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

/** One line Index refused, as the seed marker keeps it (SEED-REVISION). */
export type RefusedSeed = {
  line: string;
  feedback: string | null;
  code: string;
  at: string;
  keys: string[];
  surfacedAt?: string;
  /** SEED-REJECT part 3b, a `prepare` refusal's category and recovery questions (cleaned): read if present, never written now, and no shipped roll wrote them. */
  category?: string;
  /** Why Index's first recovery question will not be shown (a code, never text): set at the seed or when the block is printed. */
  questionWithheld?: QuestionWithheld;
  recovery?: Array<{ kind: RecoveryQuestion["kind"]; question: string; options?: string[] }>;
};

/** A word joined by an underscore (`create_intent`, `source_type`): the shape of a tool or field name, never Index's prose. */
const SNAKE_CASE = /\p{L}+_[\p{L}\p{N}_]*[\p{L}\p{N}]/u;

/**
 * Index's feedback on a refused line as it may reach the agent and the
 * resident: model-written, third-party text, so null when Hermes's scanner
 * would block on it (cronScanHit), when it names a tool or field (SNAKE_CASE),
 * or when cleanTitle leaves nothing; else cleanTitle's one plain line (no
 * link, handle, markup, phone number), at most REFUSED_FEEDBACK_MAX code
 * points, cut at a word. Withheld whole, never partly. Pure.
 */
export function refusedFeedback(raw: unknown): string | null {
  if (typeof raw !== "string" || cronScanHit(raw) || SNAKE_CASE.test(raw)) return null;
  const clean = cleanTitle(raw, REFUSED_FEEDBACK_MAX, "word");
  return clean === null || SNAKE_CASE.test(clean) || cronScanHit(clean) ? null : clean;
}

/** Why a recovery question was withheld from the REFUSED_SEEDS block: the seed marker records this code, never the text. */
export type QuestionWithheld = "empty" | "malformed" | GuardHit;

/**
 * Index's recovery question as the REFUSED_SEEDS block may carry it (lead
 * 18:19Z: the agent asks the resident ONE of Index's questions in plain
 * words). Third-party, model-written text, so the guard FAILS CLOSED
 * (question-guard.ts questionGuardHit, commit review of d738cf87): any
 * doubt withholds it whole (question null, with the reason code); nothing is
 * cut or repaired. What passes is one plain question of at most
 * REFUSED_QUESTION_MAX code points, and it must come through cleanTitle
 * unchanged (else `shape`). `line` is the resident's own refused line (a
 * question quoting it back is withheld). Pure.
 */
export function refusedQuestion(raw: unknown, line?: string | null): { question: string | null; withheld: QuestionWithheld | null } {
  if (typeof raw !== "string" || !raw.trim()) return { question: null, withheld: "empty" };
  const hit = questionGuardHit(raw, line);
  if (hit) return { question: null, withheld: hit };
  const plain = raw.normalize("NFKC").trim().replace(/ +/g, " ");
  const clean = cleanTitle(raw, REFUSED_QUESTION_MAX);
  if (clean === null) return { question: null, withheld: "empty" };
  return clean === plain ? { question: clean, withheld: null } : { question: null, withheld: "shape" };
}

/** The resident's refused line, verbatim, at most REFUSED_LINE_MAX code points (cut at a word); null when blank. Pure. */
export function refusedLine(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? cutAtWord(raw, REFUSED_LINE_MAX) : null;
}

function refusedSeed(line: string, refusal: IntentRefusal, now: Date): RefusedSeed | null {
  const kept = refusedLine(line);
  if (kept === null) return null;
  return { line: kept, feedback: refusedFeedback(refusal.feedback), code: refusal.code, at: now.toISOString(), keys: refusal.keys };
}

/** `code` as the trailer may carry it (SEED_CODE): characters outside the set become `_`, cut to 64; null when nothing is left. Pure. */
export function seedCode(code: string): string | null {
  const shaped = code.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 64);
  return SEED_CODE.test(shaped) ? shaped : null;
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

function seedBody(now: Date, selected: number, created: number, failed: number, done: boolean, refused: RefusedSeed[] = []): string {
  return `${JSON.stringify({ seededAt: now.toISOString(), selected, created, failed, ...(done ? { done: true } : {}), ...(refused.length ? { refused } : {}) })}\n`;
}

/** `body` as the marker's new content: temp file (0600) and rename. Throws on a filesystem failure. */
function replaceSeedMarker(home: string, body: string): void {
  const path = join(home, WELCOME_SEED_FILE);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, body, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The claimed marker, rewritten with the seed's counts, `done`, and the lines
 * Index refused (`refused`, only when there are any: SEED-REVISION) (temp
 * file and rename). Never throws: the claim already holds.
 */
function recordSeed(home: string, now: Date, selected: number, created: number, failed: number, refused: RefusedSeed[] = []): void {
  try {
    replaceSeedMarker(home, seedBody(now, selected, created, failed, true, refused));
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
 * The seed marker exists (another run claimed it, now or before): while that
 * run is still seeding, wait for its `done` (at most clock.wait, polling every
 * clock.poll, within the budget), then list again once, whether the marker
 * was done from the start or not, since the first read may predate that
 * run's creates (DATA-416 race 2). The welcome then shows what Index lists;
 * the first read stands only when that second list fails or is not made.
 */
async function awaitSeed(home: string, target: IndexMcpTarget, first: { read: IntentsRead }, clock: Clock): Promise<{ read: IntentsRead; seed: SeedCounts }> {
  const until = Math.min(Date.now() + clock.wait, clock.deadline - Math.min(clock.reserve, WELCOME_INDEX_TIMEOUT_MS));
  while (seedInProgress(home) && Date.now() < until) await sleep(Math.max(1, Math.min(clock.poll, until - Date.now())));
  const relistTarget = timed(target, clock, WELCOME_INDEX_TIMEOUT_MS);
  const again = relistTarget ? await listIntents(relistTarget) : { read: UNREACHABLE, rows: null };
  return { read: again.read.kind === "listed" ? again.read : first.read, seed: NO_SEED };
}

type SeedLineInput = { text: string; title: string; key: string };

/**
 * Seed `lines` (seedOne, all at once), list again, and classify each line:
 * created (or, in publish mode, landed although its own call gave up or its
 * 2xx named no id: active in the second list), else failed, a refused one (a non-2xx create with Index's
 * `intent_needs_revision`, ov#302) kept for the first chat turn. `codes`: the code each
 * line left, in line order, shaped for the trailer (seedCode); `kinds`: the
 * kinds of the refused lines' recovery questions, at most
 * SEED_RECOVERY_KINDS_MAX.
 */
async function seedLines(home: string, target: IndexMcpTarget, clock: Clock, lines: SeedLineInput[], now: Date) {
  const mode = seedMode(home);
  const made = (await Promise.allSettled(lines.map((line) => seedOne(target, clock, mode, line.text)))).map((r) =>
    r.status === "fulfilled" ? r.value : { out: null, code: "error" },
  );
  const relistTarget = timed(target, clock, WELCOME_INDEX_TIMEOUT_MS);
  const again = relistTarget ? await listIntents(relistTarget) : { read: UNREACHABLE, rows: null };
  const seeded: Array<{ id: string | null; title: string; key: string }> = [];
  const refused: RefusedSeed[] = [];
  const codes: string[] = [];
  let failed = 0;
  lines.forEach((line, i) => {
    const { out: one, code } = made[i]!;
    const created = one && !("refused" in one) ? one : null;
    if (created) seeded.push({ id: created.id, title: created.title ?? line.title, key: line.key });
    // A create that landed although its own call gave up or named no id (publish mode: in paused mode it was never paused).
    else if (mode === "publish" && again.rows?.some((row) => row.active && row.keys.includes(line.key))) seeded.push({ id: null, title: line.title, key: line.key });
    else {
      failed++;
      // SEED-REVISION: Index wanted this line clearer; keep it for the first chat turn.
      const kept = one && "refused" in one ? refusedSeed(line.text, one, now) : null;
      if (kept) refused.push(kept);
    }
    const shaped = code === null ? null : seedCode(code);
    if (shaped !== null && codes.length < SEED_CODES_MAX) codes.push(shaped);
  });
  const kinds = refused.flatMap((r) => (r.recovery ?? []).map((q) => q.kind)).slice(0, SEED_RECOVERY_KINDS_MAX);
  return { mode, again, seeded, failed, refused, codes, kinds };
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
 * call failed, or whose 2xx named no id, is counted as seeded only when the
 * second list shows its text active (publish mode). When the marker already exists, whatever the first
 * read listed (a run whose first list landed between another run's creates
 * sees only some of them: DATA-416 race 1), the run waits for it and lists
 * again (awaitSeed). The read the welcome is composed from, and the counts.
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
  if (first.read.kind !== "listed") return unchanged;
  // The marker before the active count: another run's creates may already be partly listed (DATA-416 race 1).
  if (existsSync(join(home, WELCOME_SEED_FILE))) return awaitSeed(home, target, first, clock);
  if (first.read.titles.length !== 0) return unchanged;
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

  const { mode, again, seeded, failed, refused, codes, kinds } = await seedLines(home, target, clock, lines, now);
  recordSeed(home, now, selected.length, seeded.length, failed, refused);
  // SEED-REJECT part 3b: the codes ride on the branch only behind AV_SEED_TRAILER_V2, so with it off the branch is today's.
  const seed: SeedCounts = { intents_seeded: seeded.length, seed_failed: failed, ...(seedTrailerV2(home) ? { seed_codes: codes, seed_recovery_kinds: kinds } : {}) };

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
 * One selected line: one direct create (createIntentDirect: `POST
 * <origin>/api/intents` with its text as `description` and SEED_SOURCE_TYPE
 * as `sourceType`, nothing else, no `/prepare`, no receipt), then, in
 * `paused` mode, `pause_intent` with the id Index's answer names. The intent
 * (its id when the answer names one; Index's REST answer has no title, so
 * the second list's title, else the line's, is shown); Index's
 * `intent_needs_revision` refusal on a non-2xx answer (SEED-REVISION, kept
 * for the first chat turn); or null when the line failed otherwise: any other
 * non-2xx (`create-http-<status>`), a timeout (`create-timeout`), no answer
 * (`create-unreachable`), a create URL refused before sending
 * (CREATE_BAD_URL), a 2xx naming no id (CREATE_NO_ID: in publish mode
 * seedLines still counts it when the second list shows it), too little time
 * left to call (the second list's reserve kept back), or in `paused` mode no
 * id to pause or a pause that failed (never retried).
 */
/** One seed line's outcome (seedOne) and the code it left for the trailer (null: created, nothing to say). */
type SeedLine = { out: { id: string | null; title: string | null } | IntentRefusal | null; code: string | null };

/** The trailer's code for a create that did not land: by its HTTP status, else a refused URL (nothing sent), timeout or unreachable. Pure. */
export function createFailureCode(failed: Extract<DirectCreate, { ok: false }>): string {
  if (failed.status > 0) return `create-http-${failed.status}`;
  if (failed.badUrl) return CREATE_BAD_URL;
  return failed.timedOut ? "create-timeout" : "create-unreachable";
}

/** A create whose origin indexOrigin refused (`$INDEX_API_URL`, else the MCP URL): nothing sent, the key kept (refute 57644408 S2). */
export const CREATE_BAD_URL = "create-bad-url";
/**
 * A 2xx create answer naming no intent id Index could have issued: not
 * created on that answer alone (anything at the URL can say 2xx), so in
 * publish mode the line counts only when the second list shows it active,
 * as a create that timed out (refute 57644408 S1).
 */
export const CREATE_NO_ID = "create-no-id";

async function seedOne(target: IndexMcpTarget, clock: Clock, mode: SeedMode, description: string): Promise<SeedLine> {
  // `description` is the resident's line exactly as selectedIntentions read it: never rewritten, trimmed or composed.
  try {
    // One create per line, inside the run's budget and timeout, the second list's reserve kept back, no retry.
    const createTarget = timed(target, clock, WELCOME_SEED_TIMEOUT_MS, clock.reserve);
    if (!createTarget) return { out: null, code: BUDGET_EXHAUSTED };
    const created = await createIntentDirect(createTarget, description);
    if (!created.ok) return created.refusal ? { out: created.refusal, code: created.refusal.code } : { out: null, code: createFailureCode(created) };
    const made = { id: created.id, title: null };
    if (mode === "publish") return made.id === null ? { out: null, code: CREATE_NO_ID } : { out: made, code: null };
    if (made.id === null) return { out: null, code: "pause-no-id" };
    const pauseTarget = timed(target, clock, WELCOME_SEED_TIMEOUT_MS, clock.reserve);
    if (!pauseTarget) return { out: null, code: BUDGET_EXHAUSTED };
    return writeRefused(await callIndexTool(pauseTarget, "pause_intent", { intentId: made.id }))
      ? { out: null, code: "pause-refused" }
      : { out: made, code: null };
  } catch (err) {
    return { out: null, code: err instanceof IndexMcpError ? err.code : "error" };
  }
}

/**
 * The app's Intents page, on the same host as the brief's Connections link
 * (`AV_CONNECTIONS_URL`), or on the default host when that link would be
 * longer than INTENTS_URL_MAX characters.
 */
export function intentsPageUrl(home: string): string {
  const href = new URL("/intents-v2", connectionsUrl(home)).href;
  return href.length <= INTENTS_URL_MAX ? href : new URL("/intents-v2", DEFAULT_CONNECTIONS_URL).href;
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
 * INTENTS_URL_MAX characters (welcome.test.ts, the worst cases). `context`:
 * the resident told the app something at signup (hasSetupContext), so with
 * no active intent the welcome is CONTEXT_COPY, not the three questions.
 */
export function welcomeText(name: string, read: IntentsRead, intentsUrl: string, context = false): string {
  if (read.kind === "unreachable" || read.titles.length === 0) return composeWelcome(name, read, intentsUrl, [], context);
  const titles = read.titles.slice(0, MAX_LISTED);
  const rest = composeWelcome(name, read, intentsUrl, titles.map(() => "")).length;
  return composeWelcome(name, read, intentsUrl, fitTitles(titles, Math.max(0, WELCOME_MAX_CHARS - rest)));
}

/** The welcome's text with `listed` as the intent lines (the listed branch only); `context` as welcomeText's. */
function composeWelcome(name: string, read: IntentsRead, intentsUrl: string, listed: string[], context = false): string {
  const intro = `I'm ${name}, your personal agent for Edge City India. It's a pleasure to meet you.`;
  const questions = [
    "What can you ask me?",
    "• What events are happening tomorrow?",
    "• Please RSVP me to [event name] on the calendar.",
    "You can also send me Telegram voice notes.",
  ].join("\n");
  const appHomeUrl = new URL("/", intentsUrl).href;
  const onboarding = [
    "To complete your onboarding",
    `Explore the Agent Village app: ${appHomeUrl}`,
    "",
    "1) Rolodex: browse people and track who you've met.",
    "2) Send someone a gold star to show gratitude (three per day).",
    "3) Skylight: make an avatar for me in the virtual village.",
  ].join("\n");
  const parts = ["Welcome to Edge City India ☀️", intro, questions, onboarding];
  if (read.kind === "unreachable") {
    parts.push(
      "Your intents\nI can't load your intents right now. Tell me what you're looking for, and I'll still help you find relevant people and events.",
    );
  } else if (read.titles.length === 0 && context) {
    parts.push(["Your intents", CONTEXT_COPY.lead].join("\n"), CONTEXT_COPY.close);
  } else if (read.titles.length === 0) {
    parts.push(
      ["Your intents", "You don't have an active intent yet. To help me find the right people and events, answer any of these:", "", ...CONTEXT_QUESTIONS.map((q) => `- ${q}`)].join("\n"),
      "I'll turn your answers into intents for you to confirm.",
    );
  } else if (read.seeded) {
    const copy = (listed.length === 1 ? SEEDED_COPY_ONE : SEEDED_COPY)[read.seeded];
    parts.push(
      ["Your intents", copy.lead, "", ...listed.map((t) => `- ${t}`)].join("\n"),
      read.seeded === "paused"
        ? `${listed.length === 1 ? "This intent" : "These intents"} will stay paused until you tell me to publish ${listed.length === 1 ? "it" : "them"}.`
        : `I'll use ${listed.length === 1 ? "this" : "these"} to look for relevant people and events. ${copy.close}`,
      ...(read.seeded === "paused" ? [copy.close] : []),
    );
  } else {
    const lead = read.titles.length > MAX_LISTED ? "Your intents\nHere are three of them:" : "Your intents";
    parts.push(
      [lead, "", ...listed.map((t) => `- ${t}`)].join("\n"),
      `I'll use ${listed.length === 1 ? "this" : "these"} to look for relevant people and events. Tell me if you'd like to add, change, or pause an intent.`,
    );
  }
  parts.push("I'm excited for our time at Edge City India together!");
  return parts.join("\n\n");
}

// ── SEED-REVISION: the refused lines, handed to the first chat turn ─────────

/** How long the REFUSED_SEEDS run waits for another run's hold on the seed marker, and when a hold is stale. */
const REFUSED_LOCK_WAIT_MS = 2_000;
const REFUSED_LOCK_STALE_MS = 30_000;

/** The seed marker when it is done and holds a `refused` list, else null. Never throws. */
function refusedMarker(home: string): { marker: Record<string, unknown>; refused: unknown[] } | null {
  try {
    const marker = record(JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8")));
    if (!marker || marker.done !== true || !Array.isArray(marker.refused)) return null;
    return { marker, refused: marker.refused };
  } catch {
    return null;
  }
}

/** Indexes of the refused entries with a line that were never surfaced, in the resident's order. */
function pendingRefused(refused: unknown[]): number[] {
  const pending: number[] = [];
  refused.forEach((entry, i) => {
    const row = record(entry);
    if (row && row.surfacedAt === undefined && refusedLine(row.line) !== null) pending.push(i);
  });
  return pending;
}

/** One REFUSED_SEEDS entry: the resident's own line and Index's first recovery question (kind + text), or null. */
type ShownSeed = { line: string; kind: RecoveryQuestion["kind"] | null; question: string | null };
const RECOVERY_KINDS: ReadonlyArray<RecoveryQuestion["kind"]> = ["single", "multi", "text"];

/** The block's question for a refused entry: the first of its `recovery` list, through refusedQuestion. */
function shownQuestion(row: Record<string, unknown>, line: string): { kind: RecoveryQuestion["kind"] | null; question: string | null; withheld: QuestionWithheld | null } {
  if (typeof row.questionWithheld === "string") return { kind: null, question: null, withheld: row.questionWithheld as QuestionWithheld };
  if (!Array.isArray(row.recovery) || row.recovery.length === 0) return { kind: null, question: null, withheld: null };
  const first = record(row.recovery[0]);
  const kind = RECOVERY_KINDS.find((k) => k === first?.kind);
  if (!first || !kind) return { kind: null, question: null, withheld: "malformed" };
  const { question, withheld } = refusedQuestion(first.question, line);
  return question === null ? { kind: null, question: null, withheld } : { kind, question, withheld: null };
}

/**
 * SEED-REVISION S1: the resident still has `line`, by the Context tags entry
 * of `memories/USER.md` (contextHolds; `absent`, no entry: nothing was ever
 * removed). The first turn's REFUSED_SEEDS block (surfaceRefusedSeeds) and
 * `--reseed`'s fallback (reseedLines) both ask this. Pure.
 */
function residentHolds(context: ContextTags | "absent", line: string): boolean {
  return context === "absent" || contextHolds(context, line);
}

/**
 * The REFUSED_SEEDS line, or null when there is nothing to print. It names
 * ONE refused line (REFUSED_SHOWN_MAX): the first not yet surfaced, in the
 * resident's order, that the resident still has (S1: checked against the
 * Context tags entry of `memories/USER.md`; a line they removed or edited
 * away is skipped, `notShown: "gone"`; with no entry nothing was ever
 * removed; an unreadable file, or an entry that does not parse (N9), prints
 * nothing and leaves the marker for a later run). With it, Index's first recovery question (shownQuestion), or
 * null; Index's feedback is never printed (box file only). Every pending
 * entry is marked `surfacedAt` in the same write, the ones not printed with
 * `notShown` ("gone", or "cap" past the one), and a withheld question with
 * `questionWithheld` (a code, never text), under the marker's lock (temp
 * file and rename) BEFORE the line is returned: the block is printed at most
 * once, ever, and a write that fails prints nothing. Never throws.
 */
export async function surfaceRefusedSeeds(home: string, now: Date = new Date()): Promise<string | null> {
  try {
    const first = refusedMarker(home);
    if (!first || pendingRefused(first.refused).length === 0) return null;
    const lock = await acquireStateLock(join(home, WELCOME_SEED_FILE), { waitMs: REFUSED_LOCK_WAIT_MS, staleMs: REFUSED_LOCK_STALE_MS });
    try {
      const held = refusedMarker(home);
      if (!held) return null;
      const pending = pendingRefused(held.refused);
      if (pending.length === 0) return null;
      const context = contextTagsState(home);
      if (context === "unreadable") return null;
      const at = now.toISOString();
      const marks = new Map<number, Record<string, unknown>>();
      const shown: ShownSeed[] = [];
      for (const i of pending) {
        const row = record(held.refused[i])!;
        const line = refusedLine(row.line)!;
        if (!residentHolds(context, line)) {
          marks.set(i, { surfacedAt: at, notShown: "gone" });
        } else if (shown.length >= REFUSED_SHOWN_MAX) {
          marks.set(i, { surfacedAt: at, notShown: "cap" });
        } else {
          const { kind, question, withheld } = shownQuestion(row, line);
          shown.push({ line, kind, question });
          marks.set(i, { surfacedAt: at, ...(withheld ? { questionWithheld: withheld } : {}) });
        }
      }
      const refused = held.refused.map((entry, i) => (marks.has(i) ? { ...record(entry), ...marks.get(i) } : entry));
      replaceSeedMarker(home, `${JSON.stringify({ ...held.marker, refused })}\n`);
      if (shown.length === 0) return null;
      // One line whatever the resident typed: JSON escapes C0 controls; these three it leaves raw.
      return `${REFUSED_SEEDS} ${JSON.stringify(shown).replace(/[\u0085\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`)}`;
    } finally {
      lock.release();
    }
  } catch {
    return null;
  }
}

/** ALREADY_SENT, and on its own line after it the REFUSED_SEEDS block when there is one to print. Never throws. */
async function alreadySentText(home: string, now: Date): Promise<string> {
  const block = await surfaceRefusedSeeds(home, now);
  return block === null ? ALREADY_SENT : `${ALREADY_SENT}\n${block}`;
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

// ── SEED-REJECT 3b: --reseed, the operator's one-shot second seed ────────────

/** The operator's flag: seed again for a box whose welcome seeded nothing (Carter's ruling (4), 12 Oct 2026). */
export const RESEED_FLAG = "--reseed";
/** Each `--reseed` run's own marker, relative to `$HERMES_HOME`: `memory/welcome-reseed-<time>.json`. */
export const WELCOME_RESEED_PREFIX = join("memory", "welcome-reseed-");
/**
 * Gap G2: `--reseed --dry-run` lists, names each line a run would send
 * (WOULD_CREATE), and asks Index nothing else, creates and writes nothing
 * (reseedRun). Alone, `--dry-run` means the same (never a real welcome).
 */
export const DRY_RUN_FLAG = "--dry-run";
/** Gap G2: `--reseed --again` runs although an earlier `--reseed` left its marker (reseedRan). */
export const AGAIN_FLAG = "--again";
/** Gap G2: the code a real `--reseed` leaves, alone, when an earlier one already ran on this box: nothing listed, created or written. */
export const RESEED_ALREADY_RAN = "reseed_already_ran";
/** Gap G2: a dry run's code for each line a real run would send (create directly); nothing is asked of Index for it. */
export const WOULD_CREATE = "would_create";
/** The code a `--reseed` (or `--dry-run`) leaves, alone, when reseedLines finds no line: no Index call, nothing written. */
export const RESEED_NO_LINES = "no_lines";
/** The code a real `--reseed` leaves, alone, when another one holds WELCOME_RESEED_LOCK: no Index call, nothing written. */
export const RESEED_IN_PROGRESS = "reseed_in_progress";
/** A real `--reseed` holds this lock (tryAcquireLock), relative to `$HERMES_HOME`, from before it lists until its marker is written. */
export const WELCOME_RESEED_LOCK = join("memory", "welcome-reseed.lock");
/** A WELCOME_RESEED_LOCK older than this is a run that was killed: taken over (its budget, twice). */
const RESEED_LOCK_STALE_MS = 2 * WELCOME_BUDGET_MS;

/**
 * True when a `--reseed` already sent lines here: a
 * WELCOME_RESEED_PREFIX<time>.json marker with `created + failed > 0`, or one
 * that cannot be read as such (fail closed: `--again` overrides). A run that
 * sent nothing writes no marker, and an older zero-count one does not count.
 * Never throws.
 */
export function reseedRan(home: string): boolean {
  const dir = join(home, dirname(WELCOME_RESEED_PREFIX));
  const name = basename(WELCOME_RESEED_PREFIX);
  try {
    return readdirSync(dir).some((f) => f.startsWith(name) && f.endsWith(".json") && reseedSent(join(dir, f)));
  } catch {
    return false;
  }
}

/** Whether the reseed marker at `path` records a run that sent a line (`created + failed > 0`); unreadable counts as sent. Never throws. */
function reseedSent(path: string): boolean {
  try {
    const marker = record(JSON.parse(readFileSync(path, "utf8")));
    const created = marker?.created;
    const failed = marker?.failed;
    if (typeof created !== "number" || typeof failed !== "number") return true;
    return created + failed > 0;
  } catch {
    return true;
  }
}

/**
 * The lines a `--reseed` sends (and a `--dry-run` names): the profile's
 * selected intentions as the welcome's seed reads them (selectedIntentions,
 * verbatim), else, since the app leaves that section out once Telegram is
 * paired, the lines Index refused at the welcome (the seed marker's
 * `refused`, ov#302), as recorded, filtered exactly as the first turn's
 * reader filters them (surfaceRefusedSeeds, SEED-REVISION S1): never an entry
 * the reader marked `notShown: "gone"`, never a line the Context tags no
 * longer hold or list under "Removed by you" (residentHolds), and none at all
 * when the tags are unreadable (fail closed). Never rewritten, trimmed or
 * composed. Never throws.
 */
export function reseedLines(home: string): string[] {
  return reseedPlan(home).lines;
}

/** The code a `--reseed` (or `--dry-run`) leaves for each refused line it did not send because the marker kept it cut (reseedPlan). */
export const RESEED_CUT_LINE = "reseed-cut-line";

/**
 * reseedLines, and how many of the seed marker's refused lines it passed
 * over as cut (refute 57644408 N1): a line refusedLine would not keep as it
 * is (longer than REFUSED_LINE_MAX) or one ending in "\u2026" (the ellipsis
 * cutAtWord puts on a line it cut; a line the resident ended with one is
 * passed over too, since the two cannot be told apart) is never sent: the
 * resident's whole line is not on the box. Only lines the filters above
 * would have sent are counted. Never throws.
 */
export function reseedPlan(home: string): { lines: string[]; cut: number } {
  const selected = selectedIntentions(home);
  if (selected.length) return { lines: selected, cut: 0 };
  try {
    const marker = record(JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8")));
    const refused = Array.isArray(marker?.refused) ? marker.refused : [];
    if (refused.length === 0) return { lines: [], cut: 0 };
    const context = contextTagsState(home);
    if (context === "unreadable") return { lines: [], cut: 0 };
    let cut = 0;
    const lines = refused.flatMap((entry) => {
      const row = record(entry);
      const line = refusedLine(row?.line);
      if (!row || line === null || row.notShown === "gone" || !residentHolds(context, line)) return [];
      if (line !== row.line || (row.line as string).endsWith("\u2026")) {
        cut++;
        return [];
      }
      return [row.line as string];
    });
    return { lines, cut };
  } catch {
    return { lines: [], cut: 0 };
  }
}

/**
 * `--reseed`: whatever welcome-state.json and the seed marker say (neither is
 * read for permission nor written), read reseedLines first (none: RESEED_NO_LINES,
 * no Index call, nothing written), take WELCOME_RESEED_LOCK (held by another
 * run: RESEED_IN_PROGRESS, no Index call, nothing written), list, then seed
 * (seedLines: one direct create per line, refusals kept) up to
 * MAX_LISTED of those lines that are not already listed in Index (seedKey,
 * any status), and, when a line was sent, write a new marker
 * WELCOME_RESEED_PREFIX<time>.json with the counts, the codes and the refused
 * lines, then release the lock. A run that sends nothing (every line listed,
 * the list unavailable, no key) writes no marker. A refused line also goes
 * into the seed marker's `refused` (mergeReseedRefused, gap G1), so the first
 * chat turn's REFUSED_SEEDS block asks the resident about it. Gap G2: when an
 * earlier `--reseed` sent lines (reseedRan, checked again under the lock), a
 * run does nothing at all and leaves RESEED_ALREADY_RAN, unless `again`; with
 * `dryRun` (never refused, no lock) it lists, then names the lines a run
 * would send (wouldCreate) and creates and writes nothing. A refused line
 * the marker kept cut is never sent (reseedPlan): each one leads the codes
 * as RESEED_CUT_LINE, and a real run records `cutSkipped` in its own marker
 * even when it sends nothing. The branch for the operator's trailer. Never
 * throws.
 */
export async function reseedRun(home: string, options: WelcomeOptions = {}, flags: { dryRun?: boolean; again?: boolean } = {}): Promise<WelcomeBranch> {
  const now = options.now ?? new Date();
  const alone = (code: string): WelcomeBranch => ({ ...welcomeBranch(UNREACHABLE), seed_codes: [code] });
  let claim: HeldLock | null = null;
  try {
    if (!flags.dryRun && !flags.again && reseedRan(home)) return alone(RESEED_ALREADY_RAN);
    const { lines: all, cut } = reseedPlan(home);
    // N1: each refused line passed over as cut is named first in the trailer, and a real run that passed one over
    // writes its own marker even when it sends nothing (counts 0 and `cutSkipped`, so the run-once guard is not spent).
    const cutCodes = Array.from({ length: cut }, () => RESEED_CUT_LINE);
    const sentNothing = (read: IntentsRead, code?: string): WelcomeBranch => {
      if (cut && !flags.dryRun) recordReseed(home, now, { selected: all.length, created: 0, failed: 0, codes: cutCodes.slice(0, SEED_CODES_MAX), refused: [], cutSkipped: cut });
      const codes = [...cutCodes, ...(code === undefined ? [] : [code])];
      return welcomeBranch(read, codes.length ? { ...NO_SEED, seed_codes: codes } : NO_SEED);
    };
    if (all.length === 0) return cut ? sentNothing(UNREACHABLE, RESEED_NO_LINES) : alone(RESEED_NO_LINES);
    if (!flags.dryRun) {
      claim = tryAcquireLock(join(home, WELCOME_RESEED_LOCK), { staleMs: RESEED_LOCK_STALE_MS });
      if (claim === null) return alone(RESEED_IN_PROGRESS);
      // Under the lock: a run that finished just before this one took it has left its marker.
      if (!flags.again && reseedRan(home)) return alone(RESEED_ALREADY_RAN);
    }
    const clock: Clock = {
      deadline: Date.now() + (options.budgetMs ?? WELCOME_BUDGET_MS),
      cap: options.timeoutMs,
      reserve: options.reserveMs ?? WELCOME_RELIST_RESERVE_MS,
      wait: 0,
      poll: options.pollMs ?? WELCOME_SEED_POLL_MS,
    };
    const target: IndexMcpTarget = { apiKey: envOrDotenv("INDEX_API_KEY", home), mcpUrl: indexMcpUrl(), fetch: options.fetch };
    const first = await listIntents({ ...target, timeoutMs: options.timeoutMs ?? WELCOME_INDEX_TIMEOUT_MS });
    // Nothing sent: no marker with a line sent, so the run-once guard is not spent.
    if (!first.rows) return sentNothing(UNREACHABLE, "list-unavailable");
    const sent = new Set(first.rows.flatMap((row) => row.keys));
    const lines: SeedLineInput[] = [];
    for (const text of all) {
      if (lines.length === MAX_LISTED) break;
      const key = seedKey(text);
      if (key === null || sent.has(key)) continue;
      sent.add(key);
      lines.push({ text, title: cleanTitle(text, TITLE_MAX, "word")!, key });
    }
    if (lines.length === 0) return sentNothing(first.read);
    if (flags.dryRun) {
      const would = wouldCreate(lines);
      return welcomeBranch(first.read, { ...would, seed_codes: [...cutCodes, ...(would.seed_codes ?? [])].slice(0, SEED_CODES_MAX) });
    }
    const { again, seeded, failed, refused, codes: sentCodes, kinds } = await seedLines(home, target, clock, lines, now);
    const codes = [...cutCodes, ...sentCodes].slice(0, SEED_CODES_MAX);
    const counts = { selected: all.length, created: seeded.length, failed };
    const merged = refused.length ? await mergeReseedRefused(home, now, refused, counts) : null;
    recordReseed(home, now, { ...counts, codes, refused, ...(merged === null ? {} : { refusedMerged: merged }), ...(cut ? { cutSkipped: cut } : {}) });
    const read = again.read.kind === "listed" ? again.read : first.read;
    return welcomeBranch(read, { intents_seeded: seeded.length, seed_failed: failed, seed_codes: codes, seed_recovery_kinds: kinds });
  } catch {
    return alone("error");
  } finally {
    claim?.release();
  }
}

/**
 * Gap G2, `--dry-run`: the lines a real run would send, each as WOULD_CREATE
 * (in order, at most SEED_CODES_MAX), and nothing seeded or failed. No Index
 * call: the direct create has no verdict to ask for first, and a create is a
 * write. Pure.
 */
function wouldCreate(lines: SeedLineInput[]): SeedCounts {
  return { intents_seeded: 0, seed_failed: 0, seed_codes: lines.slice(0, SEED_CODES_MAX).map(() => WOULD_CREATE) };
}

/**
 * Gap G1 (context@b3, RESEED-RESEND.md): the lines a `--reseed` saw refused,
 * merged into the seed marker's `refused` (ov#302's list, which the first chat
 * turn's REFUSED_SEEDS block reads; surfaceRefusedSeeds), each entry exactly
 * as the welcome's seed keeps one (refusedSeed) and never `surfacedAt`, so the
 * block names it at the resident's next session. An entry for the same line
 * (as kept, refusedLine) is replaced by the new one in its place, its
 * `surfacedAt`, `notShown` and `questionWithheld` gone with it; other entries
 * stay as they are. Under the marker's lock (surfaceRefusedSeeds's), temp file
 * and rename. A done marker keeps its fields; a marker left claimed (no
 * `done`) is completed with `done: true` unless it is younger than
 * RESEED_SEED_BUSY_MS (a welcome seeding right now, whose own write would
 * drop the entries: left alone); no marker, or one that is not a JSON object,
 * becomes recordSeed's shape with this run's counts. True when the entries
 * were written. Never throws.
 */
async function mergeReseedRefused(home: string, now: Date, refused: RefusedSeed[], counts: { selected: number; created: number; failed: number }): Promise<boolean> {
  try {
    const path = join(home, WELCOME_SEED_FILE);
    const lock = await acquireStateLock(path, { waitMs: REFUSED_LOCK_WAIT_MS, staleMs: REFUSED_LOCK_STALE_MS });
    try {
      let marker: Record<string, unknown> | null = null;
      try {
        marker = record(JSON.parse(readFileSync(path, "utf8")));
      } catch {
        // No marker, or not JSON: written whole below.
      }
      if (marker && marker.done !== true) {
        const claimed = typeof marker.seededAt === "string" ? Date.parse(marker.seededAt) : Number.NaN;
        if (Number.isFinite(claimed) && now.getTime() - claimed < RESEED_SEED_BUSY_MS) return false;
      }
      const list: unknown[] = Array.isArray(marker?.refused) ? [...marker.refused] : [];
      for (const entry of refused) {
        const same = list.flatMap((e, i) => (record(e)?.line === entry.line ? [i] : []));
        if (same.length === 0) {
          list.push(entry);
          continue;
        }
        list[same[0]!] = entry;
        for (const i of same.slice(1).reverse()) list.splice(i, 1);
      }
      replaceSeedMarker(
        home,
        marker
          ? `${JSON.stringify({ ...marker, done: true, refused: list })}\n`
          : seedBody(now, counts.selected, counts.created, counts.failed, true, list as RefusedSeed[]),
      );
      return true;
    } finally {
      lock.release();
    }
  } catch {
    return false;
  }
}

/** A seed marker without `done` younger than this is a welcome seeding now (its budget, twice): mergeReseedRefused leaves it alone. */
const RESEED_SEED_BUSY_MS = 2 * WELCOME_BUDGET_MS;

/**
 * The `--reseed` run's own marker (0600, a new file each run that sent a line
 * or passed a cut one over), with `refusedMerged` when it saw refused lines
 * (whether mergeReseedRefused wrote them into the seed marker) and
 * `cutSkipped` when it passed cut lines over (reseedPlan); never touches
 * welcome-state.json. Never throws.
 */
function recordReseed(
  home: string,
  now: Date,
  body: { selected: number; created: number; failed: number; codes: string[]; refused: RefusedSeed[]; refusedMerged?: boolean; cutSkipped?: number },
): void {
  try {
    const path = join(home, `${WELCOME_RESEED_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}.json`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ reseededAt: now.toISOString(), ...body, ...(body.refused.length ? {} : { refused: undefined }) })}\n`, { mode: 0o600 });
  } catch {
    // Nothing to keep: the trailer still says what happened.
  }
}

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
 * (null for ALREADY_SENT, which `--draft` never prints, and which carries the
 * REFUSED_SEEDS line after it when there is one: SEED-REVISION). Seeds first
 * when it should (seedWelcome), in both modes. Never throws.
 */
export async function welcomeRun(argv: string[], options: WelcomeOptions = {}): Promise<{ text: string; branch: WelcomeBranch | null }> {
  const home = homeFrom(argv);
  // `--dry-run` alone is `--reseed --dry-run` (gap G2): never a real welcome.
  if (argv.includes(RESEED_FLAG) || argv.includes(DRY_RUN_FLAG)) {
    return { text: "", branch: await reseedRun(home, options, { dryRun: argv.includes(DRY_RUN_FLAG), again: argv.includes(AGAIN_FLAG) }) };
  }
  const draft = argv.includes("--draft");
  const welcomed = welcomeAlreadySent(home);
  if (!draft && welcomed) return { text: await alreadySentText(home, options.now ?? new Date()), branch: null };
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
  const context = read.kind === "listed" && read.titles.length === 0 && hasSetupContext(home);
  const out = { text: welcomeText(welcomeName(home), read, intentsPageUrl(home), context), branch: welcomeBranch(read, seed, context) };
  if (draft) return out;
  try {
    if (!claimWelcome(home, options.now)) return { text: await alreadySentText(home, options.now ?? new Date()), branch: null };
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
  // `--reseed` (SEED-REJECT 3b) prints nothing for the resident, and its trailer, both extra keys included, for the operator.
  const reseed = argv.includes(RESEED_FLAG) || argv.includes(DRY_RUN_FLAG);
  if (!reseed) io.stdout(`${out.text}\n`);
  if ((reseed || argv.includes("--draft")) && out.branch) {
    const home = homeFrom(argv);
    io.stderr(`${draftTrailer(out.branch, reseed || seedTrailerV2(home), welcomeReasonOn(home))}\n`);
  }
}

if (import.meta.main) {
  await main(process.argv.slice(2), {
    stdout: (s) => process.stdout.write(s),
    stderr: (s) => process.stderr.write(s),
  });
  process.exit(0);
}
