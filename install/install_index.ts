/**
 * Index Network backend installer for Hermes.
 *
 *   - Merges `mcp_servers.index` into `$HERMES_HOME/config.yaml`
 *   - Writes `INDEX_API_KEY` to `$HERMES_HOME/.env`
 *   - Installs the Index crons: memory signal sync
 *     (`Edge — memory signal sync`, ~01:00; script-gated), prepare
 *     (`Edge — digest prepare`, ~02:00), send (`Edge — daily digest`, ~08:00),
 *     negotiation summary (`Edge — negotiation summary`, ~14:00), two
 *     single-opportunity drops (`Edge — opportunity drop (midday)`, ~12:00 and
 *     `Edge — opportunity drop (evening)`, ~17:00), and evening questions
 *     (`Edge — evening questions`, ~19:00) — all host-local; times
 *     overridable via --digest-signals-cron /
 *     --digest-prepare-cron / --digest-send-cron / --negotiation-summary-cron /
 *     --evening-questions-cron (or
 *     DIGEST_SIGNALS_CRON / DIGEST_PREPARE_CRON / DIGEST_SEND_CRON /
 *     NEGOTIATION_SUMMARY_CRON / EVENING_QUESTIONS_CRON). To
 *     avoid the whole fleet hitting the LLM provider in the same minute
 *     (OpenRouter caps gemini-flash at 300 req/min account-wide), each tenant
 *     gets a deterministic minute offset derived from its INDEX_API_KEY:
 *     signal sync spreads over
 *     01:00–01:49, prepare over 02:00–02:49, send over 08:00–08:24,
 *     negotiation summary over 14:00–14:24, and evening questions over
 *     19:00–19:24.
 *     New installs create enabled crons; reconcile updates prompt bodies,
 *     migrates jobs still on the old synchronized defaults (0 2 / 0 8) to their
 *     staggered slot, and otherwise preserves each job's schedule and pause
 *     state (user-customized schedules are never touched).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import { readFlag } from "./args";
import { upsertEnvVar } from "./env";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { CRON_NAME_PREFIX, hermesHome } from "./paths";

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
  writeFileSync(configPath, YAML.stringify(doc));
  console.log("→ wrote mcp_servers.index in config.yaml");
}

function readPersistedEnvVar(key: string): string {
  const envPath = join(hermesHome(), ".env");
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
      console.log(`→ removed cron ${job.name}`);
    } catch {
      console.warn(`  warning: could not remove cron ${job.name}`);
    }
  }
}

interface StoredCronJob {
  id: string;
  name: string;
  prompt?: string;
  script?: string;
  schedule?: { expr?: string } | string;
  schedule_display?: string;
}

/** Extract the cron expression a stored Hermes job currently runs on. */
export function storedSchedule(job: StoredCronJob): string {
  if (typeof job.schedule === "string") return job.schedule.trim();
  return (job.schedule?.expr ?? job.schedule_display ?? "").trim();
}

function readCronJobs(): StoredCronJob[] {
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
  /** CLI flag that overrides `schedule` at install time. */
  overrideFlag: string;
  /** Env var that overrides `schedule` at install time (flag wins). */
  overrideEnv: string;
}

/**
 * Heartbeat (every 30m, deliver telegram), memory signal sync (01:00, no
 * deliver, script-gated so unchanged MEMORY.md does not wake the LLM), prepare (02:00, no deliver), send (08:00, deliver telegram), then
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
 * retired). `index-network/heartbeat.md` is kept for reference/history only.
 */
export const DIGEST_CRON_SPECS: DigestCronSpec[] = [
  {
    schedule: "0 1 * * *",
    staggerWindowMinutes: 50,
    promptFile: "edge-esmeralda/prompts/memory-signals.md",
    scriptFile: "edge-esmeralda/scripts/memory_signal_gate.py",
    scriptInstallName: "agentvillage_memory_signal_gate.py",
    name: "Edge — memory signal sync",
    deliver: false,
    overrideFlag: "--digest-signals-cron",
    overrideEnv: "DIGEST_SIGNALS_CRON",
  },
  {
    schedule: "0 2 * * *",
    staggerWindowMinutes: 50,
    promptFile: "edge-esmeralda/prompts/prepare.md",
    name: "Edge — digest prepare",
    deliver: false,
    overrideFlag: "--digest-prepare-cron",
    overrideEnv: "DIGEST_PREPARE_CRON",
  },
  {
    schedule: "0 8 * * *",
    staggerWindowMinutes: 25,
    promptFile: "edge-esmeralda/prompts/send.md",
    name: "Edge — daily digest",
    deliver: true,
    overrideFlag: "--digest-send-cron",
    overrideEnv: "DIGEST_SEND_CRON",
  },
  {
    schedule: "0 14 * * *",
    staggerWindowMinutes: 25,
    promptFile: "edge-esmeralda/prompts/negotiation-summary.md",
    name: "Edge — negotiation summary",
    deliver: true,
    overrideFlag: "--negotiation-summary-cron",
    overrideEnv: "NEGOTIATION_SUMMARY_CRON",
  },
  {
    schedule: "0 19 * * *",
    staggerWindowMinutes: 25,
    promptFile: "edge-esmeralda/prompts/ask-questions.md",
    name: "Edge — evening questions",
    deliver: true,
    overrideFlag: "--evening-questions-cron",
    overrideEnv: "EVENING_QUESTIONS_CRON",
  },
  {
    schedule: "0 12 * * *",
    staggerWindowMinutes: 25,
    promptFile: "edge-esmeralda/prompts/opportunity-drop.md",
    name: "Edge — opportunity drop (midday)",
    deliver: true,
    overrideFlag: "--opportunity-drop-midday-cron",
    overrideEnv: "OPPORTUNITY_DROP_MIDDAY_CRON",
  },
  {
    schedule: "0 17 * * *",
    staggerWindowMinutes: 25,
    promptFile: "edge-esmeralda/prompts/opportunity-drop.md",
    name: "Edge — opportunity drop (evening)",
    deliver: true,
    overrideFlag: "--opportunity-drop-evening-cron",
    overrideEnv: "OPPORTUNITY_DROP_EVENING_CRON",
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
    ].join(" "),
    name: "Edge — token usage audit",
    deliver: true,
    overrideFlag: "--token-usage-audit-cron",
    overrideEnv: "TOKEN_USAGE_AUDIT_CRON",
  },
];

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
 * stable tenant seed. Spreads the fleet so simultaneous digest runs don't
 * blow through the shared OpenRouter per-model rate limit.
 */
export function staggeredSchedule(spec: DigestCronSpec, seed: string): string {
  const fields = spec.schedule.trim().split(/\s+/);
  const minute = fnv1a(`${seed}:${spec.name}`) % Math.max(1, spec.staggerWindowMinutes);
  const minuteField = fields[0] === "*/30" && spec.staggerWindowMinutes <= 30
    ? `${minute},${minute + 30}`
    : String(minute);
  return [minuteField, ...fields.slice(1)].join(" ");
}

/** Build the argv for `hermes cron create` from a spec + resolved prompt body. */
export function cronCreateArgs(spec: DigestCronSpec, promptBody: string, home: string): string[] {
  const args = ["cron", "create", spec.schedule, promptBody, "--name", spec.name];
  if (spec.deliver) args.push("--deliver", "telegram");
  if (spec.skill) args.push("--skill", spec.skill);
  if (spec.scriptFile) args.push("--script", expectedCronScriptArg(spec)!);
  args.push("--workdir", home);
  return args;
}

/** Build the argv for `hermes cron edit` — only the provided fields; pause state unchanged. */
export function cronEditArgs(
  jobId: string,
  { prompt, schedule, script }: { prompt?: string; schedule?: string; script?: string },
): string[] {
  const args = ["cron", "edit", jobId];
  if (schedule !== undefined) args.push("--schedule", schedule);
  if (prompt !== undefined) args.push("--prompt", prompt);
  if (script !== undefined) args.push("--script", script);
  return args;
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
export function resolveCronSchedule(
  spec: DigestCronSpec,
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  staggerSeed = "",
): string {
  const fallback = staggerSeed ? staggeredSchedule(spec, staggerSeed) : spec.schedule;
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

function readCronPromptBody(spec: DigestCronSpec, promptsDir: string): string {
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

function expectedCronScriptArg(spec: DigestCronSpec): string | undefined {
  if (!spec.scriptFile) return undefined;
  return spec.scriptInstallName || spec.scriptFile.split("/").pop() || "agentvillage_cron.py";
}

function ensureCronScriptInstalled(spec: DigestCronSpec, home: string, promptsDir: string): string | undefined {
  const expectedScript = expectedCronScriptPath(spec, home);
  if (!expectedScript || !spec.scriptFile) return undefined;
  const sourceScript = join(promptsDir, spec.scriptFile);
  if (!existsSync(sourceScript)) {
    console.error(`error: script missing at ${sourceScript} — run install.ts first`);
    process.exit(1);
  }
  mkdirSync(join(home, "scripts"), { recursive: true });
  copyFileSync(sourceScript, expectedScript);
  return expectedScript;
}

/**
 * Probe whether the Hermes CLI can actually run. `hermesBin()` falls back to the
 * bare name `"hermes"` when it finds no fixed-path binary, but that name still
 * resolves on PATH (the augmented env adds ~/.local/bin etc.). So test by
 * executing `hermes --version` rather than string-comparing the resolved name.
 */
function hermesAvailable(bin: string): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", env: hermesExecEnv() });
    return true;
  } catch {
    return false;
  }
}

export function reconcileDigestCronJobs(
  env: NodeJS.ProcessEnv = hermesExecEnv(),
  argv: string[] = process.argv,
): void {
  const home = hermesHome();
  const promptsDir = join(home, "skills");

  const bin = hermesBin();
  if (!hermesAvailable(bin)) {
    console.warn("  warning: hermes CLI not found — skipping Index crons");
    return;
  }

  const existing = readCronJobs();
  const activeSpecs = DIGEST_CRON_SPECS.filter(
    (spec) => spec.name !== "Edge — token usage audit" || !tokenUsageAuditCronDisabled(argv, env),
  );
  const specNames = new Set(activeSpecs.map((s) => s.name));
  // Stable per-tenant seed for schedule staggering. The tenant's own Index
  // API key never changes across reinstalls, so the derived minute is stable.
  const staggerSeed = process.env.INDEX_API_KEY?.trim() || readPersistedEnvVar("INDEX_API_KEY");

  for (const job of existing) {
    if (!job.name.startsWith(CRON_NAME_PREFIX) || specNames.has(job.name)) continue;
    try {
      execFileSync(bin, ["cron", "remove", job.id], { stdio: "ignore", env });
      console.log(`→ removed retired cron ${job.name}`);
    } catch {
      console.warn(`  warning: could not remove cron ${job.name}`);
    }
  }

  // Ensure the Kanban store exists (idempotent; prepare/send stage tasks on it).
  try {
    execFileSync(bin, ["kanban", "init"], { stdio: "ignore", env });
  } catch {
    console.warn("  warning: could not run `hermes kanban init` — board may auto-init on first use");
  }

  for (const spec of activeSpecs) {
    const expectedScript = ensureCronScriptInstalled(spec, home, promptsDir);
    const promptBody = readCronPromptBody(spec, promptsDir);
    const job = existing.find((entry) => entry.name === spec.name);
    const schedule = resolveCronSchedule(spec, argv, env, staggerSeed);

    if (job) {
      const promptStale = job.prompt !== promptBody;
      const expectedScriptArg = expectedCronScriptArg(spec);
      const scriptStale = expectedScriptArg !== undefined && job.script !== expectedScriptArg;
      // Migrate only jobs still sitting on the old synchronized default
      // (e.g. "0 8 * * *") to their staggered slot. Anything else is a
      // deliberate per-tenant schedule and is preserved.
      const scheduleStale = storedSchedule(job) === spec.schedule && schedule !== spec.schedule;
      if (scriptStale) {
        console.log(`→ recreating cron "${spec.name}" with current script`);
        try {
          execFileSync(bin, ["cron", "remove", job.id], { stdio: "ignore", env });
          execFileSync(bin, cronCreateArgs({ ...spec, schedule }, promptBody, home), {
            stdio: ["ignore", "ignore", "inherit"],
            env,
          });
        } catch {
          console.warn(`  warning: could not recreate cron "${spec.name}" — gateway may still run`);
        }
        continue;
      }
      if (!promptStale && !scheduleStale) {
        console.log(`→ cron "${spec.name}" up to date`);
        continue;
      }
      // Prompt and schedule are updated in separate `cron edit` calls so a
      // failure of one (e.g. an older Hermes without --schedule) cannot take
      // down the other. Prompt first — it's the critical update.
      if (promptStale) {
        console.log(`→ updating cron "${spec.name}" prompt`);
        try {
          execFileSync(bin, cronEditArgs(job.id, { prompt: promptBody }), {
            stdio: ["ignore", "ignore", "inherit"],
            env,
          });
        } catch {
          console.warn(`  warning: could not update cron "${spec.name}" prompt — gateway may still run`);
        }
      }
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
    try {
      execFileSync(bin, cronCreateArgs(resolved, promptBody, home), {
        stdio: ["ignore", "ignore", "inherit"],
        env,
      });
    } catch {
      console.warn(`  warning: could not install cron "${spec.name}" — gateway may still run`);
    }
  }
}

export function installIndex(): void {
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

  if (!process.argv.includes("--skip-crons")) {
    reconcileDigestCronJobs(hermesExecEnv());
  }
}
