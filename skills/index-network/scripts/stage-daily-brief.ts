#!/usr/bin/env bun
/**
 * Deterministically compose and stage the daily morning brief.
 *
 * This script owns the deterministic prepare path: context building, markdown
 * composition, URL validation, Kanban create/block, and heartbeat bookkeeping.
 * Context building fetches people/community cards through MCP when configured
 * and keeps the old transcript fallback for tests/recovery. Keeping staging
 * deterministic avoids prompt-generated shell quoting bugs and CLI flag drift.
 */

import { existsSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";

import { buildDailyBriefContext, type BriefOpportunity, type DailyBriefContext } from "./build-daily-brief-context";
import { sanitizeDigestUrls } from "./validate-digest-urls";

const CONNECTION_DIGEST_LIMIT = 1;
const COMMUNITY_DIGEST_LIMIT = 1;

/**
 * Kanban statuses that mean "today's digest card already exists and must not be
 * disturbed by a re-run of the prepare step." When an admin clicks "Generate
 * all" (or the prepare cron fires twice), stageDailyBrief must NOT knock a
 * staged card back to blocked, overwrite an approved (ready) card, or re-stage a
 * card that was already delivered (done). Only a missing card or an explicitly
 * archived one is (re)generated. To force a fresh card, archive today's first,
 * then regenerate.
 */
const PROTECTED_DIGEST_STATUSES = new Set([
  "blocked",
  "ready",
  "todo",
  "in_progress",
  "doing",
  "done",
  "completed",
]);

type HermesRunner = (args: string[]) => string | Promise<string>;

interface HermesTask {
  id?: string;
  status?: string;
  body?: string;
}

interface ExistingDigestCard {
  taskId: string;
  status: string;
  body: string;
  opportunityIds: string[];
  questionIds: string[];
}

function argValue(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function pacificDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventLine(event: DailyBriefContext["highlightedEvents"][number]): string {
  const venue = event.venue ? ` at ${event.venue}` : "";
  const title = event.eventUrl ? `[${event.title}](${event.eventUrl})` : event.title;
  return `- ${event.timePacific} — ${title}${venue}`;
}

function plainEventTitle(event: DailyBriefContext["highlightedEvents"][number]): string {
  return event.title.trim();
}

function joinNatural(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function opportunityLabel(opp: BriefOpportunity): string {
  return opp.profileUrl ? `[${opp.name}](${opp.profileUrl})` : opp.name;
}

function opportunityMarker(opp: BriefOpportunity): string {
  return opp.opportunityId ? `<!-- digest-opportunity:id=${opp.opportunityId} -->` : "";
}

function normalizeOpportunityText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sanitizeVisibleProse(text: string): string {
  return text
    .replace(/\bIndex(?: Network)?\b/gi, "community")
    .replace(/\bintents?\b/gi, "interests")
    .replace(/\bsignals?\b/gi, "interests")
    .replace(/\bopportunities\b/gi, "possibilities")
    .replace(/\bopportunity\b/gi, "possibility")
    .replace(/\bmatches\b/gi, "overlaps")
    .replace(/\bmatching\b/gi, "finding overlap")
    .replace(/\bmatch\b/gi, "overlap")
    .replace(/\bnetworking\b/gi, "meeting people")
    .replace(/\bbias(?:es|ed|ing)?\b/gi, "leaning")
    .replace(/\s+/g, " ")
    .trim();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function linkifyOpportunityName(text: string, opp: BriefOpportunity): { text: string; includesLabel: boolean } {
  if (!opp.profileUrl) return { text, includesLabel: false };

  const label = opportunityLabel(opp);
  const candidates = [opp.name, firstName(opp.name)].filter(Boolean);
  for (const candidate of candidates) {
    const idx = text.indexOf(candidate);
    if (idx >= 0) {
      return {
        text: `${text.slice(0, idx)}${label}${text.slice(idx + candidate.length)}`,
        includesLabel: true,
      };
    }
  }

  return { text, includesLabel: false };
}

function opportunityReason(
  opp: BriefOpportunity,
  fallback: string,
): { text: string; includesLabel: boolean } {
  const text = normalizeOpportunityText(opp.mainText || fallback);
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text;
  const reason = sanitizeVisibleProse(firstSentence.replace(/[,.]$/, ""));
  return linkifyOpportunityName(reason, opp);
}

export function composeDailyBrief(context: DailyBriefContext): { body: string; opportunityIds: string[]; questionIds: string[] } {
  const greetingParts = [`🌞 Good morning from Edge Esmeralda. It is ${context.displayDate}`];
  if (context.weather?.source !== "unavailable" && context.weather?.forecast) {
    greetingParts.push(`${context.weather.emoji} ${context.weather.forecast}`);
  }
  const greeting = greetingParts.length > 1 ? `${greetingParts.join(". ")}.` : greetingParts[0];
  const lines: string[] = [
    greeting,
    "",
    "Here is the shape of today:",
    "",
  ];
  const opportunityIds: string[] = [];
  const questionIds: string[] = [];
  let hasVerifiedContent = false;

  // Key on id + start time so distinct occurrences of a recurring event are not collapsed.
  const eventKey = (event: DailyBriefContext["highlightedEvents"][number]) => `${event.id ?? event.title}:${event.startTime}`;
  const rsvpKeys = new Set(context.rsvpEvents.map(eventKey));
  const events = [...context.highlightedEvents, ...context.interestEvents].filter((event) => !rsvpKeys.has(eventKey(event)));

  const allCalendarEvents = [...context.rsvpEvents, ...events];
  if (allCalendarEvents.length > 0) {
    const titles = allCalendarEvents.slice(0, 3).map(plainEventTitle);
    const userPhrases = context.userModel?.phrases ?? [];
    const profileClause = userPhrases.length > 0
      ? `Against what I currently have about you — ${joinNatural(userPhrases.slice(0, 2))} — this looks like a day for testing which parts still fit today.`
      : "I do not have much about you yet, so today is also a chance to tell me what I should carry forward.";
    lines.push(`${joinNatural(titles)} ${titles.length === 1 ? "is" : "are"} the spine of the day. ${profileClause}`);
    lines.push("");
    hasVerifiedContent = true;
  }

  if (context.announcements.length > 0) {
    lines.push("**From the village**");
    for (const announcement of context.announcements) {
      lines.push(`- ${announcement.body}`);
    }
    lines.push("");
    hasVerifiedContent = true;
  }

  if (context.rsvpEvents.length > 0) {
    lines.push("**Already on your calendar**");
    for (const event of context.rsvpEvents) lines.push(eventLine(event));
    lines.push("");
    hasVerifiedContent = true;
  }

  if (events.length > 0) {
    lines.push(context.rsvpEvents.length > 0 ? "**Also worth noticing**" : "**Calendar picks**");
    for (const event of events) lines.push(eventLine(event));
    if (context.diagnostics.calendarSource === "edgeos") {
      lines.push("That's a selection, not the whole day — ask me for the full calendar anytime.");
    }
    lines.push("");
    hasVerifiedContent = true;
  }

  const peopleSetupRequired = context.diagnostics.warnings.some((warning) => /setup required before people suggestions/i.test(warning));
  const connectionOpportunities = [...context.connectionOpportunities]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, CONNECTION_DIGEST_LIMIT);
  if (connectionOpportunities.length > 0) {
    lines.push("**People, if useful**");
    for (const opp of connectionOpportunities) {
      if (opp.opportunityId) opportunityIds.push(opp.opportunityId);
      const action = opp.acceptUrl ? ` [Say hi](${opp.acceptUrl}).` : " Say hi.";
      const reason = opportunityReason(opp, "Relevant to what you have shared.");
      const lineBody = reason.includesLabel ? reason.text : `${opportunityLabel(opp)} — ${reason.text}`;
      // Cooldown re-shows are framed as reminders so the user knows this is a
      // deliberate nudge about something still waiting, not a repeated rec.
      const prefix = opp.redelivery ? "Still open — " : "";
      lines.push(`- ${opportunityMarker(opp)}${prefix}${lineBody}.${action}`);
    }
    lines.push("");
    hasVerifiedContent = true;
  } else if (peopleSetupRequired) {
    lines.push("**People**");
    lines.push("- I do not have enough from you yet to include people here. Reply with one sentence about what Edge Esmeralda should understand about you.");
    lines.push("");
  }

  const communityOpportunities = [...context.communityOpportunities]
    .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
    .slice(0, COMMUNITY_DIGEST_LIMIT);
  if (communityOpportunities.length > 0) {
    lines.push("**Someone else asked around**");
    for (const opp of communityOpportunities) {
      if (opp.opportunityId) opportunityIds.push(opp.opportunityId);
      const action = opp.acceptUrl ? ` Know someone? [Make intro](${opp.acceptUrl}).` : " Know someone? Make intro.";
      const reason = opportunityReason(opp, "They are looking for a relevant introduction.");
      const lineBody = reason.includesLabel ? reason.text : `${opportunityLabel(opp)} — ${reason.text}`;
      const prefix = opp.redelivery ? "Still open — " : "";
      lines.push(`- ${opportunityMarker(opp)}${prefix}${lineBody}.${action}`);
    }
    lines.push("");
    hasVerifiedContent = true;
  }

  if (context.diagnostics.calendarSource === "unavailable" && (context.connectionOpportunities.length > 0 || context.communityOpportunities.length > 0)) {
    lines.push("I couldn't check the live calendar this morning — ask me what's on today and I'll look it up.", "");
  }

  if (!hasVerifiedContent) {
    lines.push("I couldn't check the live calendar this morning — ask me what's on today and I'll look it up.", "");
  }

  if (hasVerifiedContent) {
    lines.push("If this is the wrong version of you for today, reply with the correction.");
  } else {
    lines.push("Ask me what's on today and I'll look it up.");
  }

  // "One for you" postscript: deliberately placed after the sign-off as a P.S.
  // (sanctioned in prepare.md). Gated on hasVerifiedContent so the pointer-only
  // fallback digest stays pointer-only. The digest-question marker mirrors the
  // opportunity marker: it survives human Kanban edits and lets the send pass
  // record exactly which question actually shipped.
  const pendingQuestions = context.questions ?? [];
  const question = hasVerifiedContent ? pendingQuestions[0] : undefined;
  if (question) {
    questionIds.push(question.id);
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`<!-- digest-question:id=${question.id} -->**One for you:** ${question.prompt}`);
    lines.push("");
    lines.push("Reply to me anytime!");
  }

  return { body: lines.join("\n").replace(/\n{3,}/g, "\n\n"), opportunityIds, questionIds };
}

async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(await Bun.file(path).text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveHermesCommand(): Promise<string> {
  if (process.env.HERMES_BIN) return process.env.HERMES_BIN;
  if (await fileExists("/opt/hermes/.venv/bin/hermes")) return "/opt/hermes/.venv/bin/hermes";
  return "hermes";
}

async function runHermes(args: string[]): Promise<string> {
  const hermes = await resolveHermesCommand();
  const result = Bun.spawnSync([hermes, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, HOME: process.env.HERMES_HOME ?? process.env.HOME, HERMES_HOME: process.env.HERMES_HOME ?? process.cwd() },
  });
  if (!result.success) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const stdout = new TextDecoder().decode(result.stdout).trim();
    throw new Error(`${hermes} ${args.join(" ")} failed: ${stderr || stdout}`);
  }
  return new TextDecoder().decode(result.stdout);
}

function parseTask(raw: string): HermesTask | null {
  try {
    const parsed = JSON.parse(raw) as { task?: HermesTask } & HermesTask;
    const task = parsed.task && typeof parsed.task === "object" ? parsed.task : parsed;
    return task && typeof task === "object" ? task : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * Resolve the digest card already staged for `date`, if any. Reads the prior
 * `prepared.taskId` recorded in the heartbeat state (idempotent across re-runs)
 * and asks Hermes for its current status. Returns null when there is no card for
 * today, when the recorded card can no longer be resolved, or when it has been
 * archived — all cases where regeneration is the correct behavior.
 */
async function readExistingDigestCard(
  hermes: HermesRunner,
  stateFile: string,
  date: string,
): Promise<ExistingDigestCard | null> {
  const state = await readJsonObject(stateFile);
  const prepared = state.prepared && typeof state.prepared === "object" && !Array.isArray(state.prepared)
    ? state.prepared as Record<string, unknown>
    : {};
  if (prepared.date !== date) return null;
  const taskId = typeof prepared.taskId === "string" ? prepared.taskId : "";
  if (!taskId) return null;

  let task: HermesTask | null = null;
  try {
    task = parseTask(await hermes(["kanban", "show", taskId, "--json"]));
  } catch {
    return null; // card no longer resolvable → allow regeneration
  }
  if (!task) return null;

  const status = String(task.status ?? "").toLowerCase();
  if (!status || status === "archived") return null; // archived/unknown → regenerate

  return {
    taskId,
    status,
    body: typeof task.body === "string" ? task.body : "",
    opportunityIds: stringArray(prepared.opportunityIds),
    questionIds: stringArray(prepared.questionIds),
  };
}

function extractTaskId(raw: string): string {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed) as { id?: unknown; task?: { id?: unknown } };
    const id = typeof parsed.id === "string" ? parsed.id : typeof parsed.task?.id === "string" ? parsed.task.id : "";
    if (id) return id;
  } catch {
    // fall through to regex extraction
  }
  const match = trimmed.match(/\b(t_[A-Za-z0-9_-]+)\b/);
  if (match) return match[1];
  throw new Error(`could not parse task id from kanban create output: ${trimmed.slice(0, 200)}`);
}

export async function stageDailyBrief(options: {
  date?: string;
  opportunitiesFile?: string;
  stateFile?: string;
  contextOut?: string;
  hermes?: HermesRunner;
} = {}): Promise<{ taskId: string; body: string; opportunityIds: string[]; questionIds: string[]; skipped?: boolean; reason?: string }> {
  const date = options.date ?? pacificDate();
  const opportunitiesFile = options.opportunitiesFile ?? "memory/digest-opportunities.txt";
  const stateFile = options.stateFile ?? "memory/heartbeat-state.json";
  const contextOut = options.contextOut ?? "memory/daily-brief-context.json";
  const hermes = options.hermes ?? runHermes;

  // Idempotency guard. A re-run of prepare (admin "Generate all", a double cron
  // fire, or a manual per-pod generate) must leave an already-staged card alone
  // instead of re-blocking it, overwriting approved content, or re-staging an
  // already-delivered digest. Build context and create/block ONLY when there is
  // no protected card for today. This short-circuits before buildDailyBriefContext
  // so a no-op regenerate never re-queries opportunities or rewrites context.
  const existing = await readExistingDigestCard(hermes, stateFile, date);
  if (existing && PROTECTED_DIGEST_STATUSES.has(existing.status)) {
    return {
      taskId: existing.taskId,
      body: existing.body,
      opportunityIds: existing.opportunityIds,
      questionIds: existing.questionIds,
      skipped: true,
      reason: `already-staged:${existing.status}`,
    };
  }

  const context = await buildDailyBriefContext({ date, opportunitiesFile, stateFile });
  await writeJson(contextOut, context);

  const { body, opportunityIds, questionIds } = composeDailyBrief(context);
  const { output: sanitizedBody } = sanitizeDigestUrls(body);
  await Bun.write("memory/digest-draft.md", `${sanitizedBody}\n`);

  const createOutput = await hermes([
    "kanban",
    "create",
    `Morning digest — ${date}`,
    "--body",
    sanitizedBody,
    "--idempotency-key",
    `digest-${date}`,
    "--json",
  ]);
  const taskId = extractTaskId(createOutput);

  await hermes(["kanban", "block", taskId, `review-required: morning brief — ${date}`]);

  const state = await readJsonObject(stateFile);
  state.prepared = {
    date,
    taskId,
    taskTitle: `Morning digest — ${date}`,
    opportunityIds,
    questionIds,
  };
  await writeJson(stateFile, state);

  rmSync("memory/digest-draft.md", { force: true });

  return { taskId, body: sanitizedBody, opportunityIds, questionIds };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await stageDailyBrief({
    date: argValue(args, "--date"),
    opportunitiesFile: argValue(args, "--opportunities-file"),
    stateFile: argValue(args, "--state-file"),
    contextOut: argValue(args, "--context-out"),
  });
  process.stdout.write(`${JSON.stringify({ taskId: result.taskId, opportunityIds: result.opportunityIds, questionIds: result.questionIds })}\n`);
}

if (import.meta.main) {
  await main();
}
