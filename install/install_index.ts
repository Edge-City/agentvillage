/**
 * Index Network backend installer for Hermes.
 *
 *   - Merges `mcp_servers.index` into `$HERMES_HOME/config.yaml`
 *   - Writes `INDEX_API_KEY` to `$HERMES_HOME/.env`
 *   - Installs the digest crons: prepare (`Edge — digest prepare`, 02:00) and
 *     send (`Edge — daily digest`, 08:00) — both host-local; times overridable
 *     via --digest-prepare-cron / --digest-send-cron (or DIGEST_PREPARE_CRON /
 *     DIGEST_SEND_CRON). New installs create enabled crons; reconcile updates
 *     prompt bodies only and preserves each job's schedule and pause state.
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

/**
 * Normalize a Telegram handle to a bare lowercase handle.
 * Strips leading @, URL prefix (t.me/, https://t.me/, telegram.me/), and
 * everything after the first /, ?, or # — matching the SQL normalization
 * in database.adapter.ts:4483.
 */
export function normalizeTelegramHandle(value: string): string {
  let v = value.trim().toLowerCase();
  v = v.replace(/^(https?:\/\/)?(t\.me|telegram\.me)\//, "");
  v = v.replace(/^@/, "");
  v = v.replace(/[/?#].*$/, "");
  return v;
}

/**
 * Typed error for identity verification failures.
 * `kind` distinguishes a rejected key (401/403) from a telegram handle mismatch.
 * Thrown by `verifyIndexIdentity`; `main().catch` maps it to exit 1.
 */
export class IdentityVerificationError extends Error {
  constructor(
    message: string,
    public readonly kind: "rejected" | "mismatch",
  ) {
    super(message);
    this.name = "IdentityVerificationError";
  }
}

/**
 * Verify that the given API key resolves to the expected resident on Index Network.
 * Calls GET /api/auth/me with the key and compares the profile telegram handle against
 * the expected handle (if provided).
 *
 * @throws {IdentityVerificationError} kind='rejected' when HTTP 401/403 (invalid/expired key)
 * @throws {IdentityVerificationError} kind='mismatch' when telegram handle does not match
 */
export async function verifyIndexIdentity(apiKey: string, telegramHandle: string): Promise<void> {
  const baseUrl = PROTOCOL_MCP_URL.replace(/\/mcp$/, "");
  console.log("  verifying Index Network identity...");

  type MeUser = {
    id: string;
    name: string;
    email: string | null;
    socials?: Array<{ label: string; value: string }>;
  };

  let identity: MeUser | null = null;

  try {
    const resp = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 401 || resp.status === 403) {
      throw new IdentityVerificationError(
        `API key rejected by Index Network (HTTP ${resp.status}) — invalid or expired key`,
        "rejected",
      );
    }

    if (!resp.ok) {
      console.warn(
        `  warning: identity check unavailable (HTTP ${resp.status}) — proceeding without verification`,
      );
      return;
    }

    const json = (await resp.json()) as { user?: MeUser };
    identity = json.user ?? null;
  } catch (err) {
    if (err instanceof IdentityVerificationError) throw err;
    const reason = err instanceof Error && err.name === "TimeoutError"
      ? "timeout after 10 s"
      : "network error";
    console.warn(
      `  warning: identity check unavailable (${reason}) — proceeding without verification`,
    );
    return;
  }

  if (!identity) {
    console.warn(
      "  warning: identity check returned empty user — proceeding without verification",
    );
    return;
  }

  const displayName = `${identity.name}${identity.email ? ` (${identity.email})` : ""}`;

  if (!telegramHandle) {
    console.log(`  authenticated as ${displayName}`);
    return;
  }

  const telegramSocial = identity.socials?.find((s) => s.label === "telegram");

  if (!telegramSocial) {
    console.warn(
      `  warning: authenticated as ${displayName} — no telegram handle on profile, cannot verify @${telegramHandle}`,
    );
    return;
  }

  const profileHandle = normalizeTelegramHandle(telegramSocial.value);
  const expectedHandle = normalizeTelegramHandle(telegramHandle);

  if (profileHandle !== expectedHandle) {
    throw new IdentityVerificationError(
      `API key authenticates as @${profileHandle}, expected @${expectedHandle} — wrong key for this resident`,
      "mismatch",
    );
  }

  console.log(`  authenticated as ${displayName} — telegram: @${profileHandle} ✓`);
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
    promptFile: "prepare.md",
    name: "Edge — digest prepare",
    deliver: false,
    overrideFlag: "--digest-prepare-cron",
    overrideEnv: "DIGEST_PREPARE_CRON",
  },
  {
    schedule: "0 8 * * *",
    promptFile: "send.md",
    name: "Edge — daily digest",
    deliver: true,
    overrideFlag: "--digest-send-cron",
    overrideEnv: "DIGEST_SEND_CRON",
  },
];

/** Build the argv for `hermes cron create` from a spec + resolved prompt body. */
export function cronCreateArgs(spec: DigestCronSpec, promptBody: string, home: string): string[] {
  const args = ["cron", "create", spec.schedule, promptBody, "--name", spec.name];
  if (spec.deliver) args.push("--deliver", "telegram");
  args.push("--workdir", home);
  return args;
}

/** Build the argv for `hermes cron edit` — prompt only; schedule/pause unchanged. */
export function cronEditPromptArgs(jobId: string, promptBody: string): string[] {
  return ["cron", "edit", jobId, "--prompt", promptBody];
}

/** True for a standard 5-field cron expression (minute hour day-of-month month day-of-week). */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f));
}

/**
 * Resolve a spec's cron schedule, honoring an optional install-time override.
 * Precedence: CLI flag (`<overrideFlag> <expr>`) > env var (`overrideEnv`) > the
 * spec default. An override that is not a valid 5-field cron expression is
 * ignored (with a warning) and the default is used.
 */
export function resolveCronSchedule(
  spec: DigestCronSpec,
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const flagIdx = argv.indexOf(spec.overrideFlag);
  const fromFlag = flagIdx >= 0 ? argv[flagIdx + 1]?.trim() : undefined;
  const override = fromFlag || env[spec.overrideEnv]?.trim();
  if (!override) return spec.schedule;
  if (!isValidCron(override)) {
    console.warn(
      `  warning: ignoring invalid cron override for "${spec.name}" ("${override}") — using default "${spec.schedule}"`,
    );
    return spec.schedule;
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

    if (job) {
      if (job.prompt === promptBody) {
        console.log(`→ cron "${spec.name}" prompt up to date`);
        continue;
      }
      console.log(`→ updating cron "${spec.name}" prompt`);
      try {
        execFileSync(bin, cronEditPromptArgs(job.id, promptBody), {
          stdio: ["ignore", "ignore", "inherit"],
          env,
        });
      } catch {
        console.warn(`  warning: could not update cron "${spec.name}" — gateway may still run`);
      }
      continue;
    }

    const schedule = resolveCronSchedule(spec);
    const resolved = { ...spec, schedule };
    const suffix = schedule === spec.schedule ? "" : " [overridden]";
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

/**
 * Pre-flight identity verification. Reads the API key and telegram handle from
 * CLI flags / env, then calls `verifyIndexIdentity`.
 *
 * Call this in `main()` *before* any HERMES_HOME mutations so a credential
 * failure aborts a pristine install.
 *
 * @throws {IdentityVerificationError} on rejected key or handle mismatch
 */
export async function preflightIndexIdentity(): Promise<void> {
  const apiKey = readApiKey();
  const telegramHandle = readTelegramHandle();
  console.log(
    `→ index network: target=${IS_DEV ? "dev" : "production"} (${PROTOCOL_MCP_URL})`,
  );
  await verifyIndexIdentity(apiKey, telegramHandle);
}

export function installIndex(): void {
  const apiKey = readApiKey();
  const telegramHandle = readTelegramHandle();
  upsertEnvVar("INDEX_API_KEY", apiKey);
  if (telegramHandle) upsertEnvVar("INDEX_TELEGRAM_HANDLE", telegramHandle);
  writeMcpServerEntry(apiKey, telegramHandle);

  if (!process.argv.includes("--skip-crons")) {
    reconcileDigestCronJobs(hermesExecEnv());
  }
}
