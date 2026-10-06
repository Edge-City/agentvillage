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
 *     line each, what the agent will do with them, and how to add or change
 *     them (the app's Intents page, or just tell me);
 *   - no active intents: the app's three Context questions, and a promise to
 *     turn the answers into intents the resident confirms;
 *   - no key, Index unreachable or an answer it cannot read: the welcome
 *     without the list, saying it will catch up in the morning brief.
 *
 * It never creates, changes or publishes an intent.
 *
 * One welcome per tenant. `memory/welcome-state.json` under `$HERMES_HOME`
 * (`{"welcomeSent":true,"sentAt":"<ISO-8601>"}`) is the marker the control
 * plane's Telegram greeting and the overlay's AGENTS.md welcome gate already
 * share, and the installer keeps across updates (install/welcome_state.ts).
 * By default the script prints WELCOME_ALREADY_SENT when the marker is set;
 * otherwise it claims the marker (created exclusively, so two runs at once
 * cannot both win) and prints the welcome. `--draft` prints the welcome and
 * never reads or writes the marker, for a caller that delivers and marks the
 * welcome itself.
 *
 * Stdout is exactly the message (the agent sends it verbatim), and nothing
 * is written to stderr on any normal path: Hermes's `terminal` tool hands the
 * agent both streams. It always exits 0.
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { DEFAULT_NAME, agentName, readProfile } from "../../agent-profile/scripts/profile";
import { callIndexTool, indexMcpUrl, toolJsonArray } from "./index-mcp";
import { cleanText, connectionsUrl, cronScanHit, envOrDotenv } from "./proactive-text";

/** The marker, relative to `$HERMES_HOME` (install/welcome_state.ts WELCOME_STATE_RELATIVE_PATH). */
export const WELCOME_STATE_FILE = join("memory", "welcome-state.json");
/** What the script prints instead of a welcome when one was already sent. */
export const ALREADY_SENT = "WELCOME_ALREADY_SENT";
/** Intents the welcome lists at most. */
export const MAX_LISTED = 3;
/** Code points of one intent title at most (an ellipsis marks a cut). */
export const TITLE_MAX = 80;
/** Characters of the whole welcome at most. */
export const WELCOME_MAX_CHARS = 900;
/** The welcome's Index read gives up sooner than the brief's: the resident is waiting for a first reply. */
export const WELCOME_INDEX_TIMEOUT_MS = 10_000;

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

export type IntentsRead =
  | { kind: "listed"; titles: string[] }
  | { kind: "unreachable" };

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
 * points, repeats dropped. Throws IndexMcpError when Index's answer is a
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
    const title = cleanText(raw, TITLE_MAX);
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
  if (!options.apiKey) return { kind: "unreachable" };
  try {
    const text = await callIndexTool(
      { apiKey: options.apiKey, mcpUrl: options.mcpUrl, fetch: options.fetch, timeoutMs: options.timeoutMs ?? WELCOME_INDEX_TIMEOUT_MS },
      "list_intents",
      { limit: 20 },
    );
    return { kind: "listed", titles: intentTitles(text) };
  } catch {
    return { kind: "unreachable" };
  }
}

/** The app's Intents page, on the same host as the brief's Connections link (`AV_CONNECTIONS_URL`). */
export function intentsPageUrl(home: string): string {
  return new URL("/intents", connectionsUrl(home)).href;
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

/** The welcome. Pure. */
export function welcomeText(name: string, read: IntentsRead, intentsUrl: string): string {
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
  } else {
    const listed = read.titles.slice(0, MAX_LISTED);
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

/** What the script prints, given its arguments. Never throws. */
export async function welcome(argv: string[], options: { fetch?: typeof fetch; timeoutMs?: number; now?: Date } = {}): Promise<string> {
  const home = homeFrom(argv);
  const draft = argv.includes("--draft");
  if (!draft && welcomeAlreadySent(home)) return ALREADY_SENT;
  const read = await readIntents({
    apiKey: envOrDotenv("INDEX_API_KEY", home),
    mcpUrl: indexMcpUrl(),
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  const text = welcomeText(welcomeName(home), read, intentsPageUrl(home));
  if (draft) return text;
  try {
    if (!claimWelcome(home, options.now)) return ALREADY_SENT;
  } catch {
    // The marker could not be written: still welcome (never silent); the next first message may welcome again.
  }
  return text;
}

if (import.meta.main) {
  let out: string;
  try {
    out = await welcome(process.argv.slice(2));
  } catch {
    out = welcomeText(DEFAULT_NAME, { kind: "unreachable" }, intentsPageUrl(homeFrom(process.argv.slice(2))));
  }
  process.stdout.write(`${out}\n`);
  process.exit(0);
}
