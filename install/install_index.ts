/**
 * Index Network backend installer for Hermes.
 *
 *   - Merges `mcp_servers.index` into `$HERMES_HOME/config.yaml`
 *   - Writes `INDEX_API_KEY` to `$HERMES_HOME/.env`
 *   - Installs the Index crons: memory signal sync
 *     (`Edge — memory signal sync`, ~01:00; script-gated), prepare
 *     (`Edge — digest prepare`, ~02:00), send (`Edge — daily digest`, ~08:00),
 *     negotiation summary (`Edge — negotiation summary`, ~14:00), evening
 *     questions (`Edge — evening questions`, ~19:00), and two
 *     single-opportunity drops (`Edge — opportunity drop (midday)`, ~12:00 and
 *     `Edge — opportunity drop (evening)`, ~17:00), and the hourly pending
 *     opportunity alert (`Edge — pending opportunity`, ~:20 past every hour,
 *     DATA-430) — all in Hermes's zone (village time: configureVillageTimezone); times
 *     overridable via --digest-signals-cron /
 *     --digest-prepare-cron / --digest-send-cron / --negotiation-summary-cron /
 *     --evening-questions-cron / --opportunity-drop-midday-cron /
 *     --opportunity-drop-evening-cron / --pending-alert-cron (or
 *     DIGEST_SIGNALS_CRON / DIGEST_PREPARE_CRON / DIGEST_SEND_CRON /
 *     NEGOTIATION_SUMMARY_CRON / EVENING_QUESTIONS_CRON /
 *     OPPORTUNITY_DROP_MIDDAY_CRON / OPPORTUNITY_DROP_EVENING_CRON /
 *     PENDING_ALERT_CRON). To
 *     avoid the whole fleet hitting the LLM provider in the same minute
 *     (OpenRouter caps gemini-flash at 300 req/min account-wide), each tenant
 *     gets a deterministic minute offset derived from its INDEX_API_KEY:
 *     signal sync spreads over
 *     01:00–01:49, prepare over 02:00–02:49, send over 08:00–08:24,
 *     negotiation summary over 14:00–14:24, and evening questions over
 *     19:00–19:24. Opportunity drops spread over 12:00–12:24 and
 *     17:00–17:24; the pending alert over :20–:29 of every hour.
 *     K1: the Edge India knowledge sync (`Edge — knowledge sync`, every 30
 *     minutes, a per-tenant offset in the first 30; no_agent, no delivery;
 *     --knowledge-sync-cron / KNOWLEDGE_SYNC_CRON) copies the snapshot named
 *     by KNOWLEDGE_SNAPSHOT_URL (default: Edge City's mirror,
 *     skills/edge-india/references/ in this repo) to
 *     `$HERMES_HOME/knowledge/edge-india/`
 *     (skills/edge-india/scripts/knowledge-sync.ts).
 *     New installs create enabled crons, except the hourly pending
 *     opportunity alert, which ships OFF in rc29 (below). Reconcile edits each
 *     existing job in
 *     place with one `hermes cron edit <id>` for its shape (prompt, script,
 *     agent mode, failure target), which keeps its id, schedule, pause state
 *     and next run, so an upgrade roll leaves every job running; it also
 *     migrates jobs still on the old synchronized defaults (0 2 / 0 8) to their
 *     staggered slot in a separate edit (user-customized schedules are never
 *     touched).
 *
 * DATA-430 follow-up (Carter's ruling, rc29): `Edge — pending opportunity` is
 * installed PRESENT and PAUSED (Hermes's pause state, `enabled: false`), and
 * its id is still recorded in installed_jobs.json. The switch is
 * PENDING_ALERT_ENABLED (`--pending-alert-enabled true|false`, else the
 * process environment, else `$HERMES_HOME/.env`): `true` resumes it unless a
 * hold in av-events/job-holds.json keeps it paused (a resident's, an admin's
 * or the settings'), `false` pauses it, and unset leaves its pause state to
 * whoever set it last, after the installer has paused each job id once
 * (pendingAlertStep; the id it has settled is av-events/pending-alert.json).
 *
 * DATA-314 (brief-lite): the seven proactive jobs (digest prepare, daily digest,
 * negotiation summary, evening questions, the two opportunity drops, and
 * DATA-430's hourly pending alert) are
 * triggered by a pre-run script, the one shim
 * `skills/index-network/scripts/shims/agentvillage_proactive.sh` copied to
 * `$HERMES_HOME/scripts/agentvillage_proactive_<action>.sh`, which runs
 * `skills/index-network/scripts/proactive.ts <action>`. The script does the
 * deterministic work and the model only writes from its Script Output: no
 * prompt asks for a tool call. The 02:00 digest prepare is now a silent
 * no_agent context prefetch, and the only no_agent job: a no_agent job's
 * stdout would reach the resident without a model turn, so no message event
 * or archive entry would record it. Every job that delivers sets
 * `--failure-deliver local`: a failed run never messages the resident.
 *
 * J2 (docs/design/job-settings.md): a job added for one tenant from a template
 * (`install/jobs.ts add`, named `Edge — template: <name>`) is kept by
 * reconcile while its template is in TEMPLATE_NAMES: its shape is edited like
 * a default job's, its schedule and pause state are never touched, and it is
 * never created here. Any job named exactly `Edge — template: <name>` is
 * adopted, a resident's own included (its prompt and script are rewritten); a
 * near name (`Edge — template: Brief`) is removed like any retired `Edge —`
 * name. A job of a retired template is removed with the other retired names.
 * A default job with an entry in `av-events/job-settings.json`, or named in
 * its `adminSchedules`, is admin-managed: the legacy schedule migration below
 * skips it. Preview leftovers older than an hour are pruned on every run.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import { readFlag } from "./args";
import { dotenvFileValue, dumpConfig } from "./config";
import { upsertEnvVar } from "./env";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { hermesAvailable } from "../skills/index-network/scripts/hermes-cli";
import { HERMES_JOB_ID_RE, installedJobsPath, missedSlot, rawSchedule, storedJobEnabled } from "../skills/index-network/scripts/message-labels";
import { type HoldsRead, readHolds } from "../skills/index-network/scripts/pause-job";
import { CRON_NAME_PREFIX, hermesHome } from "./paths";
import { TEMPLATE_NAMES, type TemplateName, adminScheduleKeys, prunePreviewFiles, readJobSettings, scheduleAdminManaged } from "../skills/index-network/scripts/job-settings";

// Shared with the skill scripts that run on a box without install/ (DATA-376): one definition each.
export { hermesAvailable, installedJobsPath, storedJobEnabled };

/**
 * R3 fix round 4 (output injection): a job name read from the tenant's jobs.json is printed only in
 * a conservative shape (no newline, no brace, no quote); anything else is withheld, so the
 * installer's stdout never carries a sandbox-controlled string verbatim.
 */
export function printableJobName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z0-9 _.:-]{1,80}$/.test(name) ? name : "(name withheld)";
}

const PROD_MCP_URL = "https://protocol.index.network/mcp";
const DEV_MCP_URL = "https://protocol.dev.index.network/mcp";

const IS_DEV = process.argv.slice(2).includes("--dev");
const PROTOCOL_MCP_URL =
  process.env.INDEX_MCP_URL?.trim() || (IS_DEV ? DEV_MCP_URL : PROD_MCP_URL);

function readApiKey(): string {
  const key =
    readFlag("--index-api-key")?.trim()
    || process.env.INDEX_API_KEY?.trim()
    || readPersistedEnvVar("INDEX_API_KEY");
  if (!key) {
    console.error("error: --index-api-key required (or set INDEX_API_KEY)");
    console.error("usage: bun install/install.ts --index-api-key <KEY> [--dev]");
    process.exit(1);
  }
  return key;
}

function readTelegramHandle(): string {
  return readFlag("--telegram-handle")?.trim()
    || process.env.INDEX_TELEGRAM_HANDLE?.trim()
    || process.env.TELEGRAM_HANDLE?.trim()
    || "";
}

function normalizeTelegramHandle(raw: string): string {
  const bare = raw
    .trim()
    .replace(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0];
  // Telegram usernames are case-insensitive (@Seref and @seref are the same
  // account), so fold case to a canonical lowercase handle. Without this, a
  // case-only difference between sources (e.g. EdgeOS "seref" vs runtime
  // "@Seref") registers as a false-positive conflict in telegram-handle
  // reconciliation.
  return /^[A-Za-z0-9_]{5,32}$/.test(bare) ? bare.toLowerCase() : "";
}

export function buildIndexMcpHeaders(apiKey: string, telegramHandle = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-index-surface": "telegram",
  };
  const normalizedHandle = normalizeTelegramHandle(telegramHandle);
  if (normalizedHandle) headers["x-index-telegram-username"] = normalizedHandle;
  return headers;
}

function writeMcpServerEntry(apiKey: string, telegramHandle: string): void {
  const configPath = join(hermesHome(), "config.yaml");
  let doc: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    doc = YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  }
  const mcpServers = { ...((doc.mcp_servers as Record<string, unknown>) ?? {}) };
  mcpServers.index = {
    url: PROTOCOL_MCP_URL,
    headers: buildIndexMcpHeaders(apiKey, telegramHandle),
  };
  doc.mcp_servers = mcpServers;
  writeFileSync(configPath, dumpConfig(doc));
  console.log("→ wrote mcp_servers.index in config.yaml");
}

function readPersistedEnvVar(key: string): string {
  return persistedEnvVar(hermesHome(), key);
}

/**
 * A variable as the installer persisted it in `<home>/.env`: the first line
 * that starts `KEY=`, its value trimmed; "" when there is none. The stagger
 * seed is read this way by reconcile and by `install/jobs.ts set --schedule default`.
 */
export function persistedEnvVar(home: string, key: string): string {
  const envPath = join(home, ".env");
  if (!existsSync(envPath)) return "";

  const prefix = `${key}=`;
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .find((entry) => entry.startsWith(prefix));
  return line ? line.slice(prefix.length).trim() : "";
}


function removeEdgeCronJobs(env: NodeJS.ProcessEnv): void {
  const jobsPath = join(hermesHome(), "cron", "jobs.json");
  if (!existsSync(jobsPath)) return;

  let parsed: { jobs?: Array<{ id: string; name: string }> };
  try {
    parsed = JSON.parse(readFileSync(jobsPath, "utf8"));
  } catch {
    return;
  }

  const bin = hermesBin();
  for (const job of parsed.jobs ?? []) {
    if (!job.name.startsWith(CRON_NAME_PREFIX)) continue;
    try {
      execFileSync(bin, ["cron", "remove", job.id], { stdio: "ignore", env });
      console.log(`→ removed cron ${printableJobName(job.name)}`);
    } catch {
      console.warn(`  warning: could not remove cron ${printableJobName(job.name)}`);
    }
  }
}

export interface StoredCronJob {
  id: string;
  name: string;
  prompt?: string;
  script?: string;
  schedule?: { expr?: string } | string;
  schedule_display?: string;
  no_agent?: boolean;
  failure_deliver?: string | null;
  /** Hermes's pause state: `enabled` false, `state` "paused" or a `paused_at` mark. */
  enabled?: boolean;
  state?: string;
  paused_at?: string | null;
}

// storedJobEnabled (Hermes's pause state) lives in message-labels.ts and is re-exported above.

/** Extract the cron expression a stored Hermes job currently runs on. */
export function storedSchedule(job: StoredCronJob): string {
  if (typeof job.schedule === "string") return job.schedule.trim();
  return (job.schedule?.expr ?? job.schedule_display ?? "").trim();
}

export function readCronJobs(): StoredCronJob[] {
  const jobsPath = join(hermesHome(), "cron", "jobs.json");
  if (!existsSync(jobsPath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(jobsPath, "utf8")) as { jobs?: StoredCronJob[] };
    return parsed.jobs ?? [];
  } catch {
    return [];
  }
}

export interface DigestCronSpec {
  /** Default cron schedule (overridable at install time). */
  schedule: string;
  /** Width of the per-tenant stagger window, in minutes from the default hour. */
  staggerWindowMinutes: number;
  /** Prompt file under skills/. */
  promptFile?: string;
  /** Script file under skills/. for Hermes script crons. */
  scriptFile?: string;
  /** Installed script filename under $HERMES_HOME/scripts/. */
  scriptInstallName?: string;
  /** Skill name passed to Hermes for script crons. */
  skill?: string;
  /** Inline prompt used with script crons. */
  promptBody?: string;
  /** Full Hermes cron name (kept under the CRON_NAME_PREFIX). */
  name: string;
  /** Whether to attach --deliver telegram. */
  deliver: boolean;
  /**
   * `--no-agent`: Hermes runs the script and delivers its stdout with no
   * model and no session. Only a silent job with no delivery target may set
   * it: the 02:00 prefetch (DATA-314) and the knowledge sync (K1).
   */
  noAgent?: boolean;
  /** `--failure-deliver local`: a failure notice stays out of the resident's chat. */
  failureDeliver?: "local";
  /** CLI flag that overrides `schedule` at install time. */
  overrideFlag: string;
  /** Env var that overrides `schedule` at install time (flag wins). */
  overrideEnv: string;
}

/**
 * Memory signal sync (01:00, no deliver, script-gated so unchanged MEMORY.md
 * does not wake the LLM), prepare (02:00, no deliver; since DATA-314 the
 * silent no_agent prefetch of the brief's context), send (08:00, deliver
 * telegram; the morning brief), then
 * evening questions (19:00, deliver telegram). Signal sync runs an hour before
 * prepare so freshly-captured signals have time to produce opportunities before
 * the brief is composed. The evening questions pass asks the user one pending
 * question from the protocol each evening, sharing the 3-day cooldown state
 * with the morning digest to avoid repeating the same question.
 *
 * On top of the morning brief, two lighter "opportunity drop" passes (12:00 and
 * 17:00, deliver telegram) each surface a single fresh opportunity. They share
 * the digest's per-day `deliveredToday` dedup state, so a drop never repeats an
 * opportunity the brief (or the other drop) already sent that day, and vice versa.
 *
 * The 30-minute "Edge — heartbeat" cron was retired (see Edge-City/agentvillage#100
 * "Heartbeat cron drains OpenRouter key budget"). Its prompt loaded the
 * full agent context + Index MCP tool surface (~57k input tokens) every 30 min,
 * which exhausted the per-tenant OpenRouter keys fleet-wide (HTTP 402). It is no
 * longer in this list, so `reconcileDigestCronJobs` removes it from existing
 * tenants on the next install/update (Edge-prefixed crons not in this list are
 * retired). The old heartbeat prompt file has been removed.
 */
/** The one proactive trigger shim (DATA-314), installed once per action under its own name. */
export const PROACTIVE_SHIM = "index-network/scripts/shims/agentvillage_proactive.sh";

function proactiveScript(action: string): Pick<DigestCronSpec, "scriptFile" | "scriptInstallName" | "failureDeliver"> {
  return { scriptFile: PROACTIVE_SHIM, scriptInstallName: `agentvillage_proactive_${action}.sh`, failureDeliver: "local" };
}

/**
 * The prefetch's stored prompt. No model reads it while the job is no_agent
 * (Hermes runs only its script); after the documented rollback command turns
 * the job into an agent job, a model does, so the last sentence tells it to
 * reply exactly `[SILENT]` (B1-fix F12).
 */
export const PREFETCH_PROMPT =
  "Overnight prefetch of the morning brief's context. No model takes part in this job: the script Hermes starts before it is the whole job, and it delivers nothing. If you are a model reading this, reply exactly `[SILENT]`.";

/**
 * K1: the Edge India knowledge sync (no_agent, every 30 minutes): its shim runs
 * `skills/edge-india/scripts/knowledge-sync.ts`, which copies the snapshot
 * named by KNOWLEDGE_SNAPSHOT_URL into `$HERMES_HOME/knowledge/edge-india/`.
 * It prints only the wake line `{"wakeAgent": false}` and has no delivery
 * target, so it never reaches the resident.
 */
export const KNOWLEDGE_SYNC_JOB = `${CRON_NAME_PREFIX} knowledge sync`;
export const KNOWLEDGE_SYNC_SHIM = "edge-india/scripts/shims/agentvillage_knowledge_sync.sh";
/** Its stored prompt: no model reads it while the job is no_agent; one that does replies `[SILENT]`. */
export const KNOWLEDGE_SYNC_PROMPT =
  "Edge India knowledge sync. No model takes part in this job: the script Hermes starts is the whole job, and it delivers nothing. If you are a model reading this, reply exactly `[SILENT]`.";

export const DIGEST_CRON_SPECS: DigestCronSpec[] = [
  {
    schedule: "0 1 * * *",
    staggerWindowMinutes: 50,
    promptFile: "index-network/prompts/memory-signals.md",
    scriptFile: "index-network/scripts/memory_signal_gate.py",
    scriptInstallName: "agentvillage_memory_signal_gate.py",
    name: "Edge — memory signal sync",
    deliver: false,
    overrideFlag: "--digest-signals-cron",
    overrideEnv: "DIGEST_SIGNALS_CRON",
  },
  {
    schedule: "0 2 * * *",
    staggerWindowMinutes: 50,
    promptBody: PREFETCH_PROMPT,
    ...proactiveScript("prefetch"),
    noAgent: true,
    name: "Edge — digest prepare",
    deliver: false,
    overrideFlag: "--digest-prepare-cron",
    overrideEnv: "DIGEST_PREPARE_CRON",
  },
  {
    schedule: "0 8 * * *",
    staggerWindowMinutes: 25,
    promptFile: "index-network/prompts/brief.md",
    ...proactiveScript("brief"),
    name: "Edge — daily digest",
    deliver: true,
    overrideFlag: "--digest-send-cron",
    overrideEnv: "DIGEST_SEND_CRON",
  },
  {
    schedule: "0 14 * * *",
    staggerWindowMinutes: 25,
    promptFile: "index-network/prompts/negotiation-summary.md",
    ...proactiveScript("negotiation"),
    name: "Edge — negotiation summary",
    deliver: true,
    overrideFlag: "--negotiation-summary-cron",
    overrideEnv: "NEGOTIATION_SUMMARY_CRON",
  },
  {
    schedule: "0 19 * * *",
    staggerWindowMinutes: 25,
    promptFile: "index-network/prompts/ask-questions.md",
    ...proactiveScript("evening"),
    name: "Edge — evening questions",
    deliver: true,
    overrideFlag: "--evening-questions-cron",
    overrideEnv: "EVENING_QUESTIONS_CRON",
  },
  {
    schedule: "0 12 * * *",
    staggerWindowMinutes: 25,
    promptFile: "index-network/prompts/opportunity-drop.md",
    ...proactiveScript("drop-midday"),
    name: "Edge — opportunity drop (midday)",
    deliver: true,
    overrideFlag: "--opportunity-drop-midday-cron",
    overrideEnv: "OPPORTUNITY_DROP_MIDDAY_CRON",
  },
  {
    schedule: "0 17 * * *",
    staggerWindowMinutes: 25,
    promptFile: "index-network/prompts/opportunity-drop.md",
    ...proactiveScript("drop-evening"),
    name: "Edge — opportunity drop (evening)",
    deliver: true,
    overrideFlag: "--opportunity-drop-evening-cron",
    overrideEnv: "OPPORTUNITY_DROP_EVENING_CRON",
  },
  {
    // DATA-430: hourly, so an opportunity that turns pending is told within
    // the hour; its delivery window (job-settings.ts, 08:00 to 22:00 by
    // default) keeps it quiet at night, and its per-card ledger
    // (pending-alert.ts) is its only gate: no once-a-day mark. rc29 installs
    // it paused: PENDING_ALERT_ENABLED turns it on (pendingAlertStep).
    schedule: "20 * * * *",
    staggerWindowMinutes: 10,
    promptFile: "index-network/prompts/pending-alert.md",
    ...proactiveScript("pending"),
    name: "Edge — pending opportunity",
    deliver: true,
    overrideFlag: "--pending-alert-cron",
    overrideEnv: "PENDING_ALERT_CRON",
  },
  {
    schedule: "0 9 * * *",
    staggerWindowMinutes: 50,
    scriptFile: "token-usage-audit/scripts/audit_token_usage.py",
    scriptInstallName: "agentvillage_token_usage_audit.py",
    skill: "token-usage-audit",
    promptBody: [
      "A deterministic local token usage audit found an actionable driver.",
      "Use the sanitized facts emitted by the script. Do not mention raw session ids, prompts, transcripts, private hosts, env values, or secrets.",
      "If user-facing delivery is warranted, keep it brief: explain whether scheduled background work drove spend, name the likely cron only when confidence is high or medium, and suggest pausing or reporting the driver.",
      "If the script emitted wakeAgent:false, return [SILENT].",
      // DATA-373 follow-up: the manage line, as the delivering prompt files end.
      "End any message you deliver with one blank line and then the line below, exactly as written: never translated, reworded or formatted, with nothing after it; a [SILENT] reply is only that, without the line.",
    ].join(" ") + "\n\n(Usage report message - you can ask me to stop or manage it)",
    name: "Edge — token usage audit",
    deliver: true,
    failureDeliver: "local",
    overrideFlag: "--token-usage-audit-cron",
    overrideEnv: "TOKEN_USAGE_AUDIT_CRON",
  },
  {
    // K1: the Edge India snapshot onto disk for the edge-india skill, every
    // 30 minutes (staggered per tenant). No model, no delivery; a failure
    // goes to the failure target, local.
    schedule: "*/30 * * * *",
    staggerWindowMinutes: 30,
    promptBody: KNOWLEDGE_SYNC_PROMPT,
    scriptFile: KNOWLEDGE_SYNC_SHIM,
    scriptInstallName: "agentvillage_knowledge_sync.sh",
    noAgent: true,
    failureDeliver: "local",
    name: KNOWLEDGE_SYNC_JOB,
    deliver: false,
    overrideFlag: "--knowledge-sync-cron",
    overrideEnv: "KNOWLEDGE_SYNC_CRON",
  },
];

/** A template job's Hermes name. Reconcile keeps a job by this name while its template is current. */
export const TEMPLATE_JOB_PREFIX = `${CRON_NAME_PREFIX} template: `;

export function templateJobName(template: TemplateName): string {
  return `${TEMPLATE_JOB_PREFIX}${template}`;
}

/**
 * The template a job can be added from (J2), on its base job's prompt and the
 * proactive shim under `agentvillage_proactive_tpl-<name>.sh`:
 *   brief          the morning brief (brief.md; the brief's default window);
 *   digest-preview the opportunity drop (opportunity-drop.md): one person
 *                  waiting to hear from the resident. No job of this name
 *                  existed; this is the smallest one on an existing prompt
 *                  (flagged for review in docs/design/job-settings.md);
 *   evening-ask    the evening questions (ask-questions.md), without the
 *                  outcome ask (the plugin arms it for the installer's job).
 * The schedule is the add command's; a template has none of its own.
 */
export function templateCronSpec(template: TemplateName, schedule: string): DigestCronSpec {
  const promptFile = {
    brief: "index-network/prompts/brief.md",
    "digest-preview": "index-network/prompts/opportunity-drop.md",
    "evening-ask": "index-network/prompts/ask-questions.md",
  }[template];
  return {
    schedule,
    staggerWindowMinutes: 0,
    promptFile,
    ...proactiveScript(`tpl-${template}`),
    name: templateJobName(template),
    deliver: true,
    overrideFlag: "",
    overrideEnv: "",
  };
}

/** The job settings key of a proactive spec (`agentvillage_proactive_<key>.sh`), else null. */
export function settingsKeyOf(spec: DigestCronSpec): string | null {
  const match = /^agentvillage_proactive_(.+)\.sh$/.exec(spec.scriptInstallName ?? "");
  return match && match[1] !== "prefetch" ? match[1] : null;
}

/** FNV-1a 32-bit hash — deterministic, dependency-free. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Per-tenant staggered schedule: replace the minute field of the spec default
 * with a deterministic offset in [0, staggerWindowMinutes) derived from a
 * stable tenant seed, counted from the default's own minute when that is a
 * plain number whose window stays inside the hour (DATA-430: `20 * * * *`
 * spreads over :20 to :29; every `0 ...` default is unchanged). Spreads the
 * fleet so simultaneous digest runs don't blow through the shared OpenRouter
 * per-model rate limit.
 */
export function staggeredSchedule(spec: DigestCronSpec, seed: string): string {
  const fields = spec.schedule.trim().split(/\s+/);
  const window = Math.max(1, spec.staggerWindowMinutes);
  const base = /^\d+$/.test(fields[0]) && Number(fields[0]) + window <= 60 ? Number(fields[0]) : 0;
  const minute = base + (fnv1a(`${seed}:${spec.name}`) % window);
  // An every-N-minutes default (`*/30`, `*/15`; N divides 60) keeps its rate:
  // the offset minute and every N after it within the hour.
  const step = /^\*\/(\d+)$/.exec(fields[0]);
  const every = step ? Number(step[1]) : 0;
  const minuteField = every > 0 && 60 % every === 0 && spec.staggerWindowMinutes <= every
    ? Array.from({ length: 60 / every }, (_, i) => minute + i * every).join(",")
    : String(minute);
  return [minuteField, ...fields.slice(1)].join(" ");
}

/** Build the argv for `hermes cron create` from a spec + resolved prompt body. */
export function cronCreateArgs(spec: DigestCronSpec, promptBody: string, home: string): string[] {
  const args = ["cron", "create", spec.schedule, promptBody, "--name", spec.name];
  if (spec.deliver) args.push("--deliver", "telegram");
  if (spec.failureDeliver) args.push("--failure-deliver", spec.failureDeliver);
  if (spec.skill) args.push("--skill", spec.skill);
  if (spec.scriptFile) args.push("--script", expectedCronScriptArg(spec)!);
  if (spec.noAgent) args.push("--no-agent");
  args.push("--workdir", home);
  return args;
}

export interface CronEditFields {
  prompt?: string;
  schedule?: string;
  script?: string;
  /** true → `--no-agent`, false → `--agent`. */
  noAgent?: boolean;
  failureDeliver?: string;
}

/**
 * Build the argv for `hermes cron edit` — only the provided fields. Hermes
 * applies them in one update; id, pause state and (unless the schedule
 * changes) next run are kept.
 */
export function cronEditArgs(jobId: string, { prompt, schedule, script, noAgent, failureDeliver }: CronEditFields): string[] {
  const args = ["cron", "edit", jobId];
  if (schedule !== undefined) args.push("--schedule", schedule);
  if (prompt !== undefined) args.push("--prompt", prompt);
  if (script !== undefined) args.push("--script", script);
  if (noAgent !== undefined) args.push(noAgent ? "--no-agent" : "--agent");
  if (failureDeliver !== undefined) args.push("--failure-deliver", failureDeliver);
  return args;
}

/**
 * The fields of a stored job's shape that differ from its spec, as one `cron
 * edit`: prompt, script, agent mode and failure target. A job without a
 * failure target gets the spec's; agent mode is authoritative both ways. The
 * schedule is not compared here (a customised schedule is never touched).
 */
export function staleShapeFields(job: StoredCronJob, spec: DigestCronSpec, promptBody: string): CronEditFields {
  const fields: CronEditFields = {};
  // `cron create` strips the prompt and `cron edit` stores it raw, so both are
  // compared and sent with trailing whitespace trimmed: a second roll is a
  // no-op for a created job too (B1-fix F13).
  const prompt = promptBody.trimEnd();
  if (typeof job.prompt !== "string" || job.prompt.trimEnd() !== prompt) fields.prompt = prompt;
  const script = expectedCronScriptArg(spec);
  if (script !== undefined && job.script !== script) fields.script = script;
  if (Boolean(job.no_agent) !== Boolean(spec.noAgent)) fields.noAgent = Boolean(spec.noAgent);
  if (spec.failureDeliver && job.failure_deliver !== spec.failureDeliver) fields.failureDeliver = spec.failureDeliver;
  return fields;
}

/** True for a standard 5-field cron expression (minute hour day-of-month month day-of-week). */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f));
}

/**
 * Resolve a spec's cron schedule, honoring an optional install-time override.
 * Precedence: CLI flag (`<overrideFlag> <expr>`) > env var (`overrideEnv`) >
 * per-tenant staggered default (when `staggerSeed` is provided) > the spec
 * default. An override that is not a valid 5-field cron expression is ignored
 * (with a warning) and the staggered/spec default is used.
 */
/**
 * The fleet's default schedule for a spec on one tenant, before any
 * install-time override: the staggered slot for the tenant's seed, or the
 * spec's own schedule when there is no seed. Reconcile creates a job on it
 * (resolveCronSchedule), and `install/jobs.ts set --schedule default` restores it.
 */
export function defaultScheduleFor(spec: DigestCronSpec, staggerSeed = ""): string {
  return staggerSeed ? staggeredSchedule(spec, staggerSeed) : spec.schedule;
}

export function resolveCronSchedule(
  spec: DigestCronSpec,
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  staggerSeed = "",
): string {
  const fallback = defaultScheduleFor(spec, staggerSeed);
  const flagIdx = argv.indexOf(spec.overrideFlag);
  const fromFlag = flagIdx >= 0 ? argv[flagIdx + 1]?.trim() : undefined;
  const override = fromFlag || env[spec.overrideEnv]?.trim();
  if (!override) return fallback;
  if (!isValidCron(override)) {
    console.warn(
      `  warning: ignoring invalid cron override for "${spec.name}" ("${override}") — using default "${fallback}"`,
    );
    return fallback;
  }
  return override;
}

export function tokenUsageAuditCronDisabled(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes("--skip-token-usage-audit-cron")) return true;

  const flagIdx = argv.indexOf("--token-usage-audit-cron");
  const fromFlag = flagIdx >= 0 ? argv[flagIdx + 1]?.trim() : undefined;
  const configured = fromFlag || env.TOKEN_USAGE_AUDIT_CRON?.trim();
  if (!configured) return true;

  const raw = configured.toLowerCase();
  return raw === "off"
    || raw === "false"
    || raw === "0"
    || raw === "disabled";
}

// ── The hourly pending opportunity alert ships off (DATA-430 follow-up, rc29) ──

/** DATA-430's hourly alert: installed paused in rc29 (Carter's ruling), turned on by PENDING_ALERT_ENABLED. */
export const PENDING_ALERT_JOB = "Edge — pending opportunity";
/** The switch: `PENDING_ALERT_ENABLED=true|false` (process environment or `$HERMES_HOME/.env`). */
export const PENDING_ALERT_SWITCH_ENV = "PENDING_ALERT_ENABLED";
/** The same switch on one install's command line; it wins over the environment and `.env`. */
export const PENDING_ALERT_SWITCH_FLAG = "--pending-alert-enabled";

export type PendingAlertSwitch = "on" | "off" | "unset";

const SWITCH_ON_WORDS = new Set(["1", "true", "yes", "on", "enabled"]);
const SWITCH_OFF_WORDS = new Set(["0", "false", "no", "off", "disabled"]);

/**
 * The switch as this install reads it: `--pending-alert-enabled <value>`,
 * else PENDING_ALERT_ENABLED in the environment (present, even blank, it is
 * authoritative, as config.ts envOrDotenv), else its last assignment in
 * `$HERMES_HOME/.env`. `true`/`on`/`1`/`yes`/`enabled` is on,
 * `false`/`off`/`0`/`no`/`disabled` is off, blank or absent is unset. Any
 * other value is unset too, with a warning that never prints it (`.env` is
 * the resident's to write).
 */
export function pendingAlertSwitch(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): PendingAlertSwitch {
  const flagIdx = argv.indexOf(PENDING_ALERT_SWITCH_FLAG);
  const fromFlag = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
  const raw = fromFlag ?? (env[PENDING_ALERT_SWITCH_ENV] !== undefined ? env[PENDING_ALERT_SWITCH_ENV] : dotenvFileValue(PENDING_ALERT_SWITCH_ENV));
  const word = (raw ?? "").trim().toLowerCase();
  if (!word) return "unset";
  if (SWITCH_ON_WORDS.has(word)) return "on";
  if (SWITCH_OFF_WORDS.has(word)) return "off";
  console.warn(`  warning: ${PENDING_ALERT_SWITCH_ENV} is neither true nor false; "${PENDING_ALERT_JOB}" keeps its pause state`);
  return "unset";
}

/**
 * `$HERMES_HOME/av-events/pending-alert.json`, `{"v":1,"settled":"<id>"}`:
 * the id of the pending alert job whose pause state the installer has
 * already settled. With the switch unset, a job id not recorded here is
 * paused once (a job created by this install, or one an earlier main build
 * created enabled), and a recorded one is left as it is: an admin's
 * `set --enabled true` or a resident's resume then survives every later roll.
 */
export function pendingAlertSettledPath(home: string): string {
  return join(home, "av-events", "pending-alert.json");
}

/** The settled id, or null (no file, or anything not of the one shape: the resident can write the file). */
export function readPendingAlertSettled(home: string): string | null {
  try {
    const data = JSON.parse(readFileSync(pendingAlertSettledPath(home), "utf8")) as { v?: unknown; settled?: unknown };
    return data && data.v === 1 && typeof data.settled === "string" && HERMES_JOB_ID_RE.test(data.settled) ? data.settled : null;
  } catch {
    return null;
  }
}

/** Record the settled id, by temp file and rename. False when it could not be written (the next roll pauses the job again: the off direction). */
export function writePendingAlertSettled(home: string, id: string): boolean {
  if (!HERMES_JOB_ID_RE.test(id)) return false;
  try {
    mkdirSync(join(home, "av-events"), { recursive: true, mode: 0o700 });
    const path = pendingAlertSettledPath(home);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ v: 1, settled: id })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** What reconcile does to the pending alert job's pause state. `held`: the switch is on and a hold (or an unreadable holds file) keeps it paused. */
export type PendingAlertStep = "pause" | "resume" | "keep" | "held";

/**
 * The one rule (pure; the caller runs Hermes):
 *   off    pause it when it runs; a paused job stays paused.
 *   on     resume it when it is paused, unless av-events/job-holds.json holds
 *          it `paused` (by the resident, an admin or the settings) or cannot
 *          be read: a resume never overrides a hold, as every control-plane
 *          resume path (docs/design/job-settings.md, "Resident holds").
 *   unset  pause it once per job id (`settled` is not its id); after that,
 *          leave its pause state alone, as reconcile does for every other job.
 * `holds` is read only when the step needs it.
 */
export function pendingAlertStep(
  sw: PendingAlertSwitch,
  job: { id: string; enabled: boolean },
  settled: string | null,
  holds: () => HoldsRead,
): PendingAlertStep {
  if (sw === "off") return job.enabled ? "pause" : "keep";
  if (sw === "on") {
    if (job.enabled) return "keep";
    const read = holds();
    if (read.status !== "ok" || read.holds.get(job.id)?.state === "paused") return "held";
    return "resume";
  }
  if (settled === job.id) return "keep";
  return job.enabled ? "pause" : "keep";
}

/**
 * Settle the pending alert job's pause state for this install (pendingAlertStep),
 * read it back, and record its id as settled. A resume whose next run is
 * already due re-applies the stored schedule, so the job does not fire at
 * the next tick (as pause-job.ts and `jobs.ts set --enabled true`). Returns
 * false when the pause or resume failed or did not read back: the caller
 * counts the job as failed, and nothing is recorded, so the next roll tries
 * again.
 */
function settlePendingAlert(job: StoredCronJob, sw: PendingAlertSwitch, bin: string, env: NodeJS.ProcessEnv, home: string): boolean {
  const settled = readPendingAlertSettled(home);
  const step = pendingAlertStep(sw, { id: job.id, enabled: storedJobEnabled(job) }, settled, () => readHolds(home));
  if (step === "pause" || step === "resume") {
    try {
      execFileSync(bin, ["cron", step, job.id], { stdio: ["ignore", "ignore", "inherit"], env });
    } catch {
      console.warn(`  warning: could not ${step} cron "${PENDING_ALERT_JOB}"`);
      return false;
    }
    const now = readCronJobs().find((entry) => entry.id === job.id);
    if (!now || storedJobEnabled(now) !== (step === "resume")) {
      console.warn(`  warning: cron "${PENDING_ALERT_JOB}" did not read back ${step === "resume" ? "running" : "paused"}`);
      return false;
    }
    if (step === "resume" && missedSlot(now, new Date()) && isValidCron(rawSchedule(now))) {
      try {
        execFileSync(bin, cronEditArgs(job.id, { schedule: rawSchedule(now) }), { stdio: ["ignore", "ignore", "inherit"], env });
      } catch {
        console.warn(`  warning: could not re-anchor cron "${PENDING_ALERT_JOB}"; a missed run may fire at the next tick`);
      }
    }
    console.log(
      step === "resume"
        ? `→ cron "${PENDING_ALERT_JOB}" on (${PENDING_ALERT_SWITCH_ENV}=true)`
        : `→ cron "${PENDING_ALERT_JOB}" paused (${sw === "off" ? `${PENDING_ALERT_SWITCH_ENV}=false` : `off in rc29; ${PENDING_ALERT_SWITCH_ENV}=true turns it on`})`,
    );
  } else if (step === "held") {
    console.log(`→ cron "${PENDING_ALERT_JOB}" left paused: a hold keeps it (av-events/job-holds.json)`);
  }
  if (settled !== job.id && !writePendingAlertSettled(home, job.id)) {
    console.warn(`  warning: could not record "${PENDING_ALERT_JOB}" as settled; the next roll may pause it again`);
  }
  return true;
}

export function readCronPromptBody(spec: DigestCronSpec, promptsDir: string): string {
  if (spec.promptFile) {
    const promptPath = join(promptsDir, spec.promptFile);
    if (!existsSync(promptPath)) {
      console.error(`error: prompt missing at ${promptPath} — run install.ts first`);
      process.exit(1);
    }
    return readFileSync(promptPath, "utf8");
  }
  if (spec.promptBody !== undefined) return spec.promptBody;
  console.error(`error: cron "${spec.name}" has neither promptFile nor promptBody`);
  process.exit(1);
}

function expectedCronScriptPath(spec: DigestCronSpec, home: string): string | undefined {
  if (!spec.scriptFile) return undefined;
  return join(home, "scripts", expectedCronScriptArg(spec)!);
}

export function expectedCronScriptArg(spec: DigestCronSpec): string | undefined {
  if (!spec.scriptFile) return undefined;
  return spec.scriptInstallName || spec.scriptFile.split("/").pop() || "agentvillage_cron.py";
}

export function ensureCronScriptInstalled(spec: DigestCronSpec, home: string, promptsDir: string): string | undefined {
  const expectedScript = expectedCronScriptPath(spec, home);
  if (!expectedScript || !spec.scriptFile) return undefined;
  const sourceScript = join(promptsDir, spec.scriptFile);
  if (!existsSync(sourceScript)) {
    console.error(`error: script missing at ${sourceScript} — run install.ts first`);
    process.exit(1);
  }
  mkdirSync(join(home, "scripts"), { recursive: true });
  copyFileSync(sourceScript, expectedScript);
  // Hermes runs a .sh through bash, so the bit is not needed; it lets an operator run it by hand.
  if (expectedScript.endsWith(".sh")) chmodSync(expectedScript, 0o755);
  return expectedScript;
}

// hermesAvailable (the `hermes --version` probe) and installedJobsPath
// (`$HERMES_HOME/av-events/installed_jobs.json`, DATA-92) live beside the
// skill scripts (hermes-cli.ts, message-labels.ts) and are re-exported above.

/** Replace the record, by temp file and rename. Best effort, like `restore.json`. */
export function writeInstalledJobIds(home: string, ids: string[]): void {
  try {
    const dir = join(home, "av-events");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = installedJobsPath(home);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ids: [...new Set(ids)].sort() })}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    console.warn("  warning: could not record the installed cron job ids; cron.run will carry no job names");
  }
}

/**
 * The order jobs are reconciled in: every job before the no_agent prefetch.
 * The bad mix is the prefetch edited and the morning brief not (the old brief
 * prompt then finds nothing staged and no brief goes out), so the prefetch
 * goes last: a run cut short leaves the old prefetch, which is harmless. The
 * other no_agent job (the knowledge sync, K1) goes just before it.
 */
export function reconcileOrder(specs: DigestCronSpec[]): DigestCronSpec[] {
  const prefetch = (spec: DigestCronSpec): boolean => spec.scriptInstallName === "agentvillage_proactive_prefetch.sh";
  return [
    ...specs.filter((spec) => !spec.noAgent),
    ...specs.filter((spec) => spec.noAgent && !prefetch(spec)),
    ...specs.filter((spec) => spec.noAgent && prefetch(spec)),
  ];
}

/**
 * Reconcile the Index cron jobs. Every job is attempted even after one fails;
 * the names of those whose remove, create or shape edit failed are returned
 * and named in one summary line at the end (B1-fix F9). A failed schedule
 * migration only warns: the job keeps working on its old default slot.
 */
export function reconcileDigestCronJobs(
  env: NodeJS.ProcessEnv = hermesExecEnv(),
  argv: string[] = process.argv,
): string[] {
  const home = hermesHome();
  const promptsDir = join(home, "skills");

  const bin = hermesBin();
  if (!hermesAvailable(bin)) {
    console.warn("  warning: hermes CLI not found — skipping Index crons");
    return [];
  }
  const failed: string[] = [];

  const existing = readCronJobs();
  const idsBefore = new Set(existing.map((job) => job.id));
  // The job ids this run leaves in place as ours (DATA-92), and the id a
  // `cron create` just added under `name`, read back from jobs.json.
  const installed: string[] = [];
  const createdId = (name: string): string | undefined =>
    readCronJobs().find((job) => job.name === name && !idsBefore.has(job.id))?.id;
  const activeSpecs = DIGEST_CRON_SPECS.filter(
    (spec) => spec.name !== "Edge — token usage audit" || !tokenUsageAuditCronDisabled(argv, env),
  );
  const specNames = new Set(activeSpecs.map((s) => s.name));
  // rc29: the hourly pending alert ships off; this install's switch for it (pendingAlertStep).
  const pendingSwitch = pendingAlertSwitch(argv, env);
  // J2: a job added from a current template is kept; a retired template's job is removed below.
  const templateNames = new Map(TEMPLATE_NAMES.map((template) => [templateJobName(template), template] as const));
  // J2: a default job with a settings entry, or named in the file's
  // `adminSchedules` (an admin set its schedule), is admin-managed: the legacy
  // schedule migration skips it. An unreadable file, or an `adminSchedules`
  // that is not a list, counts every default job as managed, and says so
  // here; an entry of the list that is not a default job key is ignored on
  // its own. The rule is scheduleAdminManaged, which `jobs.ts list` reports.
  const settings = readJobSettings(home);
  const adminManaged = (spec: DigestCronSpec): boolean => {
    const key = settingsKeyOf(spec);
    return key !== null && scheduleAdminManaged(key, settings);
  };
  if (settings.status === "invalid") {
    console.warn(`  warning: av-events/job-settings.json is unreadable (${settings.code}); the legacy schedule migration skips every default job`);
  } else if (adminScheduleKeys(settings).invalid) {
    console.warn("  warning: adminSchedules in av-events/job-settings.json is not a list; the legacy schedule migration skips every default job");
  }
  // J2: preview leftovers older than an hour (state copies a killed preview
  // left, preview shims); every `Edge — preview` job goes with the retired names below.
  prunePreviewFiles(home, Date.now());

  // Stable per-tenant seed for schedule staggering. The tenant's own Index
  // API key never changes across reinstalls, so the derived minute is stable.
  const staggerSeed = process.env.INDEX_API_KEY?.trim() || readPersistedEnvVar("INDEX_API_KEY");

  for (const job of existing) {
    if (!job.name.startsWith(CRON_NAME_PREFIX) || specNames.has(job.name) || templateNames.has(job.name)) continue;
    try {
      execFileSync(bin, ["cron", "remove", job.id], { stdio: "ignore", env });
      console.log(`→ removed retired cron ${printableJobName(job.name)}`);
    } catch {
      console.warn(`  warning: could not remove cron ${printableJobName(job.name)}`);
      failed.push(job.name);
    }
  }

  // Ensure the Kanban store exists (idempotent). The proactive jobs no longer
  // stage on it (DATA-314); the old stage/send scripts still can, by hand.
  try {
    execFileSync(bin, ["kanban", "init"], { stdio: "ignore", env });
  } catch {
    console.warn("  warning: could not run `hermes kanban init` — board may auto-init on first use");
  }

  // J2: template jobs (before the specs, so a run cut short still leaves the
  // prefetch last). Shape only: the schedule and pause state are the
  // tenant's, and a missing template job is never created here.
  for (const job of existing) {
    const template = templateNames.get(job.name);
    if (!template) continue;
    const spec = templateCronSpec(template, storedSchedule(job));
    ensureCronScriptInstalled(spec, home, promptsDir);
    const stale = staleShapeFields(job, spec, readCronPromptBody(spec, promptsDir).trimEnd());
    installed.push(job.id);
    const staleNames = Object.keys(stale);
    if (staleNames.length === 0) {
      console.log(`→ cron "${spec.name}" up to date`);
      continue;
    }
    console.log(`→ updating cron "${spec.name}" in place (${staleNames.join(", ")})`);
    try {
      execFileSync(bin, cronEditArgs(job.id, stale), { stdio: ["ignore", "ignore", "inherit"], env });
    } catch {
      console.warn(`  warning: could not update cron "${spec.name}" — it keeps its previous shape`);
      failed.push(spec.name);
    }
  }

  for (const spec of reconcileOrder(activeSpecs)) {
    // Scripts are copied before any edit: Hermes checks a script path when a job is edited.
    ensureCronScriptInstalled(spec, home, promptsDir);
    // Trimmed as `cron create` stores it (B1-fix F13).
    const promptBody = readCronPromptBody(spec, promptsDir).trimEnd();
    const job = existing.find((entry) => entry.name === spec.name);
    const schedule = resolveCronSchedule(spec, argv, env, staggerSeed);

    if (job) {
      installed.push(job.id);
      // rc29: the pending alert's pause state, before the shape edit (which keeps it).
      if (spec.name === PENDING_ALERT_JOB && !settlePendingAlert(job, pendingSwitch, bin, env, home)) failed.push(spec.name);
      // Migrate only jobs still sitting on the old synchronized default
      // (e.g. "0 8 * * *") to their staggered slot. Anything else is a
      // deliberate per-tenant schedule and is preserved. An admin-managed job
      // (J2: it has a settings entry) is never migrated, even when an admin
      // set it to the old default on purpose.
      const scheduleStale = storedSchedule(job) === spec.schedule && schedule !== spec.schedule && !adminManaged(spec);
      const stale = staleShapeFields(job, spec, promptBody);
      const staleNames = Object.keys(stale);
      if (staleNames.length === 0 && !scheduleStale) {
        console.log(`→ cron "${spec.name}" up to date`);
        continue;
      }
      // One in-place edit for the job's shape: it keeps the id, the schedule,
      // the pause state and next_run_at, so an upgrade never pauses a job or
      // runs it twice in a day. A failed edit leaves the job as it was.
      if (staleNames.length > 0) {
        console.log(`→ updating cron "${spec.name}" in place (${staleNames.join(", ")})`);
        try {
          execFileSync(bin, cronEditArgs(job.id, stale), { stdio: ["ignore", "ignore", "inherit"], env });
        } catch {
          console.warn(`  warning: could not update cron "${spec.name}" — it keeps its previous shape`);
          failed.push(spec.name);
        }
      }
      // The schedule goes in its own edit, as before, so an older Hermes
      // without --schedule cannot take down the shape edit above.
      if (scheduleStale) {
        console.log(`→ migrating cron "${spec.name}" schedule → ${schedule}`);
        try {
          execFileSync(bin, cronEditArgs(job.id, { schedule }), {
            stdio: ["ignore", "ignore", "inherit"],
            env,
          });
        } catch {
          console.warn(`  warning: could not migrate cron "${spec.name}" schedule — still on "${spec.schedule}"`);
        }
      }
      continue;
    }

    const resolved = { ...spec, schedule };
    const suffix = schedule === spec.schedule ? "" : " [staggered/overridden]";
    console.log(`→ installing cron "${spec.name}" (${schedule})${suffix}`);
    let createFailed = false;
    try {
      execFileSync(bin, cronCreateArgs(resolved, promptBody, home), {
        stdio: ["ignore", "ignore", "inherit"],
        env,
      });
    } catch {
      console.warn(`  warning: could not install cron "${spec.name}" — gateway may still run`);
      failed.push(spec.name);
      createFailed = true;
    }
    const created = createdId(spec.name);
    if (created) installed.push(created);
    // rc29: Hermes creates every job running; the pending alert is then paused
    // (or left on by the switch). A created job that cannot be read back
    // cannot be paused, so it counts as failed.
    if (spec.name === PENDING_ALERT_JOB) {
      const fresh = created === undefined ? undefined : readCronJobs().find((entry) => entry.id === created);
      if (fresh) {
        if (!settlePendingAlert(fresh, pendingSwitch, bin, env, home)) failed.push(spec.name);
      } else if (!createFailed) {
        console.warn(`  warning: could not read back cron "${spec.name}" — it may be running`);
        failed.push(spec.name);
      }
    }
  }
  writeInstalledJobIds(home, installed);
  // A job can fail twice (its pause and its shape edit): named once.
  const failedNames = [...new Set(failed)];
  console.log(
    failedNames.length === 0
      ? "→ Index crons: every job in shape"
      : `→ warning: Index crons: ${failedNames.length} failed (${failedNames.join(", ")}); the tenant may run a mix of old and new jobs`,
  );
  return failedNames;
}

/** Returns the names of the Index cron jobs that failed to reconcile (empty when none, or crons skipped). */
export function installIndex(): string[] {
  const apiKey = readApiKey();
  // Persist the canonical (bare, lowercase) handle so the runtime source
  // (INDEX_TELEGRAM_HANDLE / MCP headers) never drifts from other systems by
  // a leading @ or letter case alone.
  const telegramHandle = normalizeTelegramHandle(readTelegramHandle());
  console.log(
    `→ index network: target=${IS_DEV ? "dev" : "production"} (${PROTOCOL_MCP_URL})`,
  );
  upsertEnvVar("INDEX_API_KEY", apiKey);
  if (telegramHandle) upsertEnvVar("INDEX_TELEGRAM_HANDLE", telegramHandle);
  writeMcpServerEntry(apiKey, telegramHandle);

  if (process.argv.includes("--skip-crons")) return [];
  return reconcileDigestCronJobs(hermesExecEnv());
}
