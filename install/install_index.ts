/**
 * Index Network backend installer for Hermes.
 *
 *   - Merges `mcp_servers.index` into `$HERMES_HOME/config.yaml`
 *   - Writes `INDEX_API_KEY` to `$HERMES_HOME/.env`
 *   - Installs the digest crons: memory signal sync (`Edge — memory signal
 *     sync`, ~01:00), prepare (`Edge — digest prepare`, ~02:00) and send
 *     (`Edge — daily digest`, ~08:00) — all host-local; times overridable via
 *     --digest-signals-cron / --digest-prepare-cron / --digest-send-cron (or
 *     DIGEST_SIGNALS_CRON / DIGEST_PREPARE_CRON / DIGEST_SEND_CRON). To avoid
 *     the whole fleet hitting the LLM provider in the same minute (OpenRouter
 *     caps gemini-flash at 300 req/min account-wide), each tenant gets a
 *     deterministic minute offset derived from its INDEX_API_KEY: signal sync
 *     spreads over 01:00–01:49, prepare over 02:00–02:49, send over
 *     08:00–08:24.
 *     New installs create enabled crons; reconcile updates prompt bodies,
 *     migrates jobs still on the old synchronized defaults (0 2 / 0 8) to their
 *     staggered slot, and otherwise preserves each job's schedule and pause
 *     state (user-customized schedules are never touched).
 *   - Daily-loop crons are a separate, additive, canary-only non-brief
 *     evaluation layer. `--enable-daily-loop-crons` or
 *     `ENABLE_DAILY_LOOP_CRONS=true` installs/reconciles internal wakeups at
 *     14/17/20 prepare and 15/18/21 send host-local. Normal installs leave them
 *     disabled, and these wakeups do not change morning digest or control-plane
 *     evening behavior.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
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

export function buildIndexMcpHeaders(apiKey: string, telegramHandle = ""): Record<string, string> {
  const headers: Record<string, string> = {
    "x-api-key": apiKey,
    "x-index-surface": "telegram",
  };
  const trimmedHandle = telegramHandle.trim();
  if (trimmedHandle) headers["x-index-telegram-username"] = trimmedHandle;
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
  /** Prompt file under skills/edge-esmeralda/prompts/. */
  promptFile: string;
  /** Full Hermes cron name (kept under the CRON_NAME_PREFIX). */
  name: string;
  /** Whether to attach --deliver telegram. */
  deliver: boolean;
  /** CLI flag that overrides `schedule` at install time. */
  overrideFlag: string;
  /** Env var that overrides `schedule` at install time (flag wins). */
  overrideEnv: string;
  /** Back-compat CLI flag accepted during the rename from check-in to daily loop. */
  legacyOverrideFlag?: string;
  /** Back-compat env var accepted during the rename from check-in to daily loop. */
  legacyOverrideEnv?: string;
}

/**
 * Memory signal sync (01:00, no deliver) then prepare (02:00, no deliver)
 * then send (08:00, deliver telegram). Signal sync runs an hour before
 * prepare so freshly-captured signals have time to produce opportunities
 * before the brief is composed.
 */
export const DIGEST_CRON_SPECS: DigestCronSpec[] = [
  {
    schedule: "0 1 * * *",
    staggerWindowMinutes: 50,
    promptFile: "memory-signals.md",
    name: "Edge — memory signal sync",
    deliver: false,
    overrideFlag: "--digest-signals-cron",
    overrideEnv: "DIGEST_SIGNALS_CRON",
  },
  {
    schedule: "0 2 * * *",
    staggerWindowMinutes: 50,
    promptFile: "prepare.md",
    name: "Edge — digest prepare",
    deliver: false,
    overrideFlag: "--digest-prepare-cron",
    overrideEnv: "DIGEST_PREPARE_CRON",
  },
  {
    schedule: "0 8 * * *",
    staggerWindowMinutes: 25,
    promptFile: "send.md",
    name: "Edge — daily digest",
    deliver: true,
    overrideFlag: "--digest-send-cron",
    overrideEnv: "DIGEST_SEND_CRON",
  },
];

export const DAILY_LOOP_CRON_SPECS: DigestCronSpec[] = [
  {
    schedule: "0 14,17,20 * * *",
    staggerWindowMinutes: 1,
    promptFile: "daily-loop-prepare.md",
    name: "Edge — daily loop prepare",
    deliver: false,
    overrideFlag: "--daily-loop-prepare-cron",
    overrideEnv: "DAILY_LOOP_PREPARE_CRON",
    legacyOverrideFlag: "--checkin-prepare-cron",
    legacyOverrideEnv: "CHECKIN_PREPARE_CRON",
  },
  {
    schedule: "0 15,18,21 * * *",
    staggerWindowMinutes: 1,
    promptFile: "daily-loop-send.md",
    name: "Edge — daily loop send",
    deliver: true,
    overrideFlag: "--daily-loop-send-cron",
    overrideEnv: "DAILY_LOOP_SEND_CRON",
    legacyOverrideFlag: "--checkin-send-cron",
    legacyOverrideEnv: "CHECKIN_SEND_CRON",
  },
];

const EDGE_CRON_SPECS: DigestCronSpec[] = [...DIGEST_CRON_SPECS, ...DAILY_LOOP_CRON_SPECS];

export function dailyLoopCronsEnabled(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (argv.includes("--enable-daily-loop-crons")) return true;
  if (argv.includes("--enable-checkin-crons")) return true;
  const value = (env.ENABLE_DAILY_LOOP_CRONS ?? env.ENABLE_CHECKIN_CRONS)?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
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
 * stable tenant seed. Spreads the fleet so simultaneous digest runs don't
 * blow through the shared OpenRouter per-model rate limit.
 */
export function staggeredSchedule(spec: DigestCronSpec, seed: string): string {
  const fields = spec.schedule.trim().split(/\s+/);
  const minute = fnv1a(`${seed}:${spec.name}`) % Math.max(1, spec.staggerWindowMinutes);
  return [String(minute), ...fields.slice(1)].join(" ");
}

/** Build the argv for `hermes cron create` from a spec + resolved prompt body. */
export function cronCreateArgs(spec: DigestCronSpec, promptBody: string, home: string): string[] {
  const args = ["cron", "create", spec.schedule, promptBody, "--name", spec.name];
  if (spec.deliver) args.push("--deliver", "telegram");
  args.push("--workdir", home);
  return args;
}

/** Build the argv for `hermes cron edit` — only the provided fields; pause state unchanged. */
export function cronEditArgs(
  jobId: string,
  { prompt, schedule }: { prompt?: string; schedule?: string },
): string[] {
  const args = ["cron", "edit", jobId];
  if (schedule !== undefined) args.push("--schedule", schedule);
  if (prompt !== undefined) args.push("--prompt", prompt);
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
  const legacyFlagIdx = spec.legacyOverrideFlag ? argv.indexOf(spec.legacyOverrideFlag) : -1;
  const fromLegacyFlag = legacyFlagIdx >= 0 ? argv[legacyFlagIdx + 1]?.trim() : undefined;
  const override = fromFlag
    || fromLegacyFlag
    || env[spec.overrideEnv]?.trim()
    || (spec.legacyOverrideEnv ? env[spec.legacyOverrideEnv]?.trim() : undefined);
  if (!override) return fallback;
  if (!isValidCron(override)) {
    console.warn(
      `  warning: ignoring invalid cron override for "${spec.name}" ("${override}") — using default "${fallback}"`,
    );
    return fallback;
  }
  return override;
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

export function reconcileDigestCronJobs(env: NodeJS.ProcessEnv = hermesExecEnv()): void {
  const home = hermesHome();
  const promptsDir = join(home, "skills/edge-esmeralda/prompts");

  const bin = hermesBin();
  if (!hermesAvailable(bin)) {
    console.warn("  warning: hermes CLI not found — skipping digest crons");
    return;
  }

  const existing = readCronJobs();
  const activeCronSpecs = dailyLoopCronsEnabled(process.argv, process.env)
    ? EDGE_CRON_SPECS
    : DIGEST_CRON_SPECS;
  const specNames = new Set(activeCronSpecs.map((s) => s.name));
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

  if (!dailyLoopCronsEnabled(process.argv, process.env)) {
    console.log("→ daily loop crons disabled (set --enable-daily-loop-crons or ENABLE_DAILY_LOOP_CRONS=true to install canary jobs)");
  }

  for (const spec of activeCronSpecs) {
    const promptPath = join(promptsDir, spec.promptFile);
    if (!existsSync(promptPath)) {
      console.error(`error: prompt missing at ${promptPath} — run install.ts first`);
      process.exit(1);
    }
    const promptBody = readFileSync(promptPath, "utf8");
    const job = existing.find((entry) => entry.name === spec.name);
    const schedule = resolveCronSchedule(spec, process.argv, process.env, staggerSeed);

    if (job) {
      const promptStale = job.prompt !== promptBody;
      // Migrate only jobs still sitting on the old synchronized default
      // (e.g. "0 8 * * *") to their staggered slot. Anything else is a
      // deliberate per-tenant schedule and is preserved.
      const scheduleStale = storedSchedule(job) === spec.schedule && schedule !== spec.schedule;
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
  const telegramHandle = readTelegramHandle();
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
