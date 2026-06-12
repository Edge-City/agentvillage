/**
 * Index Network backend installer for Hermes.
 *
 *   - Merges `mcp_servers.index` into `$HERMES_HOME/config.yaml`
 *   - Writes `INDEX_API_KEY` to `$HERMES_HOME/.env`
 *   - Installs the digest crons: prepare (`Edge — digest prepare`, ~02:00) and
 *     send (`Edge — daily digest`, ~08:00) — both host-local; times overridable
 *     via --digest-prepare-cron / --digest-send-cron (or DIGEST_PREPARE_CRON /
 *     DIGEST_SEND_CRON). To avoid the whole fleet hitting the LLM provider in
 *     the same minute (OpenRouter caps gemini-flash at 300 req/min account-wide),
 *     each tenant gets a deterministic minute offset derived from its
 *     INDEX_API_KEY: prepare spreads over 02:00–02:49, send over 08:00–08:24.
 *     New installs create enabled crons; reconcile updates prompt bodies,
 *     migrates jobs still on the old synchronized defaults (0 2 / 0 8) to their
 *     staggered slot, and otherwise preserves each job's schedule and pause
 *     state (user-customized schedules are never touched).
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
}

/** Prepare (02:00, no deliver) then send (08:00, deliver telegram). */
export const DIGEST_CRON_SPECS: DigestCronSpec[] = [
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
  const specNames = new Set(DIGEST_CRON_SPECS.map((s) => s.name));
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

  for (const spec of DIGEST_CRON_SPECS) {
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
      const parts = [
        ...(promptStale ? ["prompt"] : []),
        ...(scheduleStale ? [`schedule → ${schedule}`] : []),
      ];
      console.log(`→ updating cron "${spec.name}" (${parts.join(", ")})`);
      try {
        execFileSync(
          bin,
          cronEditArgs(job.id, {
            ...(promptStale ? { prompt: promptBody } : {}),
            ...(scheduleStale ? { schedule } : {}),
          }),
          { stdio: ["ignore", "ignore", "inherit"], env },
        );
      } catch {
        console.warn(`  warning: could not update cron "${spec.name}" — gateway may still run`);
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
