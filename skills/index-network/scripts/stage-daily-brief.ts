#!/usr/bin/env bun
/**
 * Deterministically compose and stage the daily morning brief.
 *
 * The cron prompt still fetches Index opportunities through MCP and writes the
 * transcript to `memory/digest-opportunities.txt`. This script owns everything
 * after that: context building, markdown composition, URL validation, Kanban
 * create/block, and heartbeat bookkeeping. Keeping this deterministic avoids
 * prompt-generated shell quoting bugs and CLI flag drift.
 */

import { existsSync, rmSync } from "node:fs";
import { access } from "node:fs/promises";

import { buildDailyBriefContext, type BriefOpportunity, type DailyBriefContext } from "./build-daily-brief-context";
import { sanitizeDigestUrls } from "./validate-digest-urls";

const CONNECTION_DIGEST_LIMIT = 3;
const COMMUNITY_DIGEST_LIMIT = 2;
const OPPORTUNITY_REASON_MAX_CHARS = 170;

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

function opportunityLabel(opp: BriefOpportunity): string {
  return opp.profileUrl ? `[${opp.name}](${opp.profileUrl})` : opp.name;
}

function opportunityMarker(opp: BriefOpportunity): string {
  return opp.opportunityId ? `<!-- digest-opportunity:id=${opp.opportunityId} -->` : "";
}

function normalizeOpportunityText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

function truncateAtWord(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars + 1);
  const boundary = slice.lastIndexOf(" ");
  return `${slice.slice(0, boundary > 80 ? boundary : maxChars).trimEnd()}…`;
}

function opportunityReason(opp: BriefOpportunity, fallback: string): string {
  const text = normalizeOpportunityText(opp.mainText || fallback);
  const firstSentence = text.split(/(?<=[.!?])\s+/)[0]?.trim() ?? text;
  return truncateAtWord(firstSentence, OPPORTUNITY_REASON_MAX_CHARS).replace(/[,.]$/, "");
}

export function composeDailyBrief(context: DailyBriefContext): { body: string; opportunityIds: string[] } {
  const lines: string[] = [
    `🌞 Good morning from Edge Esmeralda. It is ${context.displayDate}`,
    "",
    "Here's what you need to know today:",
    "",
  ];
  const opportunityIds: string[] = [];
  let hasVerifiedContent = false;

  if (context.announcements.length > 0) {
    lines.push("**Announcements**");
    for (const announcement of context.announcements) {
      lines.push(`- ${announcement.body}`);
    }
    lines.push("");
    hasVerifiedContent = true;
  }

  const events = [...context.highlightedEvents, ...context.interestEvents];
  if (events.length > 0) {
    lines.push("**The calendar today:**");
    for (const event of events) lines.push(eventLine(event));
    lines.push("");
    hasVerifiedContent = true;
  }

  const connectionOpportunities = context.connectionOpportunities.slice(0, CONNECTION_DIGEST_LIMIT);
  if (connectionOpportunities.length > 0) {
    lines.push("**People worth meeting today:**");
    for (const opp of connectionOpportunities) {
      if (opp.opportunityId) opportunityIds.push(opp.opportunityId);
      const action = opp.acceptUrl ? ` [Say hi](${opp.acceptUrl}).` : " Say hi.";
      const reason = opportunityReason(opp, "Relevant overlap with your current signals.");
      lines.push(`- ${opportunityMarker(opp)}${opportunityLabel(opp)} — ${reason}.${action}`);
    }
    lines.push("");
    hasVerifiedContent = true;
  }

  const communityOpportunities = context.communityOpportunities.slice(0, COMMUNITY_DIGEST_LIMIT);
  if (communityOpportunities.length > 0) {
    lines.push("**Help your community**");
    for (const opp of communityOpportunities) {
      if (opp.opportunityId) opportunityIds.push(opp.opportunityId);
      const action = opp.acceptUrl ? ` Know someone? [Make intro](${opp.acceptUrl}).` : " Know someone? Make intro.";
      const reason = opportunityReason(opp, "They are looking for a relevant introduction.");
      lines.push(`- ${opportunityMarker(opp)}${opportunityLabel(opp)} — ${reason}.${action}`);
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

  lines.push("That's it for now. You can always ask me for more detail, or any other questions you have!");

  return { body: lines.join("\n").replace(/\n{3,}/g, "\n\n"), opportunityIds };
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
} = {}): Promise<{ taskId: string; body: string; opportunityIds: string[] }> {
  const date = options.date ?? pacificDate();
  const opportunitiesFile = options.opportunitiesFile ?? "memory/digest-opportunities.txt";
  const stateFile = options.stateFile ?? "memory/heartbeat-state.json";
  const contextOut = options.contextOut ?? "memory/daily-brief-context.json";

  const context = await buildDailyBriefContext({ date, opportunitiesFile, stateFile });
  await writeJson(contextOut, context);

  const { body, opportunityIds } = composeDailyBrief(context);
  const { output: sanitizedBody } = sanitizeDigestUrls(body);
  await Bun.write("memory/digest-draft.md", `${sanitizedBody}\n`);

  const createOutput = await runHermes([
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

  await runHermes(["kanban", "block", taskId, `review-required: morning brief — ${date}`]);

  const state = await readJsonObject(stateFile);
  state.prepared = {
    date,
    taskId,
    taskTitle: `Morning digest — ${date}`,
    opportunityIds,
  };
  await writeJson(stateFile, state);

  rmSync("memory/digest-draft.md", { force: true });

  return { taskId, body: sanitizedBody, opportunityIds };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const result = await stageDailyBrief({
    date: argValue(args, "--date"),
    opportunitiesFile: argValue(args, "--opportunities-file"),
    stateFile: argValue(args, "--state-file"),
    contextOut: argValue(args, "--context-out"),
  });
  process.stdout.write(`${JSON.stringify({ taskId: result.taskId, opportunityIds: result.opportunityIds })}\n`);
}

if (import.meta.main) {
  await main();
}
