import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { hermesHome } from "./paths";

const DEFAULT_MODEL_MAX_TOKENS = 4096;

function readConfig(): Record<string, unknown> {
  const configPath = join(hermesHome(), "config.yaml");
  if (!existsSync(configPath)) return {};
  return YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

function writeConfig(doc: Record<string, unknown>): void {
  writeFileSync(join(hermesHome(), "config.yaml"), YAML.stringify(doc));
}

function configuredMaxTokens(): number {
  const parsed = Number.parseInt(process.env.HERMES_MAX_TOKENS ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MODEL_MAX_TOKENS;
}

/** Point gateway / messaging CWD at `$HERMES_HOME` so `AGENTS.md` loads. */
export function setTerminalCwd(): void {
  const home = hermesHome();

  const doc = readConfig();

  const terminal = { ...((doc.terminal as Record<string, unknown>) ?? {}) };
  terminal.cwd = home;
  doc.terminal = terminal;

  writeConfig(doc);
  console.log(`→ set terminal.cwd to ${home}`);
}

/**
 * Configure Hermes speech-to-text so inbound voice notes are auto-transcribed
 * to text before reaching the agent. Uses Groq Whisper by default (fast, free
 * tier); the gateway reads the `GROQ_API_KEY` env var at runtime. The provider
 * is overridable via `STT_PROVIDER` for operators who prefer openai/local.
 *
 * Note: Hermes v2026.5.16 does NOT hand the agent a raw audio file path when
 * STT is disabled (it just refuses), so a real STT provider is required for
 * voice notes to work. Idempotent.
 */
export function configureStt(): void {
  const provider = process.env.STT_PROVIDER?.trim() || "groq";
  const doc = readConfig();
  const stt = { ...((doc.stt as Record<string, unknown>) ?? {}) };
  if (stt.enabled === true && stt.provider === provider) {
    console.log(`→ stt already enabled with provider "${provider}"`);
    return;
  }
  stt.enabled = true;
  stt.provider = provider;
  doc.stt = stt;
  writeConfig(doc);
  console.log(`→ enabled stt with provider "${provider}" (voice notes auto-transcribed)`);
}

/** Ensure hosted cron turns never inherit a provider's enormous output-token default. */
export function capModelMaxTokens(): void {
  const cap = configuredMaxTokens();
  const doc = readConfig();
  const rawModel = doc.model;
  let model: Record<string, unknown>;

  if (typeof rawModel === "string" && rawModel.trim()) {
    model = { default: rawModel.trim(), model: rawModel.trim() };
  } else if (rawModel && typeof rawModel === "object" && !Array.isArray(rawModel)) {
    model = { ...(rawModel as Record<string, unknown>) };
  } else {
    model = {};
  }

  const existing = Number.parseInt(String(model.max_tokens ?? ""), 10);
  if (!Number.isFinite(existing) || existing <= 0 || existing > cap) {
    model.max_tokens = cap;
  }

  doc.model = model;
  writeConfig(doc);
  console.log(`→ capped model.max_tokens at ${model.max_tokens}`);
}

/** Hosted Telegram: pairing codes, no restart pings, no approval prompts. Idempotent. */
export function configureHostedGateway(): void {
  const doc = readConfig();

  const gateway = { ...((doc.gateway as Record<string, unknown>) ?? {}) };
  const pairing = { ...((gateway.pairing as Record<string, unknown>) ?? {}) };
  pairing.global_mode = "pair";
  gateway.pairing = pairing;
  doc.gateway = gateway;

  const approvals = { ...((doc.approvals as Record<string, unknown>) ?? {}) };
  approvals.mode = false;
  doc.approvals = approvals;

  const platforms = { ...((doc.platforms as Record<string, unknown>) ?? {}) };
  const telegram = { ...((platforms.telegram as Record<string, unknown>) ?? {}) };
  telegram.gateway_restart_notification = false;
  platforms.telegram = telegram;
  doc.platforms = platforms;

  writeConfig(doc);
  console.log("→ hosted gateway: pairing mode, approvals off, no telegram restart pings");
}

const DASHBOARD_PLUGIN = "dashboard-auth-edgecity";

/** Enable the Edge City dashboard-auth plugin and public URL for hosted dashboards. */
export function configureDashboardAuth(): void {
  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = Array.isArray(plugins.enabled)
    ? (plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[]
    : [];
  if (!enabled.includes(DASHBOARD_PLUGIN)) enabled.push(DASHBOARD_PLUGIN);
  plugins.enabled = enabled;
  doc.plugins = plugins;

  const publicUrl = process.env.HERMES_DASHBOARD_PUBLIC_URL?.trim();
  if (publicUrl) {
    const dashboard = { ...((doc.dashboard as Record<string, unknown>) ?? {}) };
    dashboard.public_url = publicUrl.replace(/\/$/, "");
    doc.dashboard = dashboard;
  }

  writeConfig(doc);
  console.log(`→ enabled plugin ${DASHBOARD_PLUGIN}`);
}

const AV_EVENTS_PLUGIN = "av-events";

/**
 * Enable the Agent Village telemetry plugin, but only for a tenant that has
 * been issued an ingest token.
 *
 * A tenant without `AV_EVENTS_TOKEN` is left alone entirely: the plugin would
 * idle harmlessly if enabled, but not listing it keeps the sandbox's plugin set
 * honest about what is actually collecting. The token itself is never written
 * to `config.yaml` — the plugin reads it from the environment (or from
 * `$HERMES_HOME/.env`) at session start, which is also what makes the kill
 * switches work without a redeploy. Idempotent.
 */
export function configureAvEvents(): void {
  if (!process.env.AV_EVENTS_TOKEN?.trim()) {
    console.log(`→ skipped plugin ${AV_EVENTS_PLUGIN} (no AV_EVENTS_TOKEN)`);
    return;
  }

  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = Array.isArray(plugins.enabled)
    ? (plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[]
    : [];
  if (!enabled.includes(AV_EVENTS_PLUGIN)) enabled.push(AV_EVENTS_PLUGIN);
  plugins.enabled = enabled;
  doc.plugins = plugins;

  writeConfig(doc);
  console.log(`→ enabled plugin ${AV_EVENTS_PLUGIN}`);
}

export const RECALL_PLUGIN = "recall";

/** The only values that turn a flag on. Anything else — `disabled`, `n`, `none`, a typo — is off. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * `AV_RECALL_ENABLED` from the process environment or, when it is absent
 * there, from `$HERMES_HOME/.env` — the sidecar `/update` path runs the
 * installer without sourcing that file. A variable present in the environment
 * (even blank) is authoritative, as in `av-events`.
 */
function recallFlag(): string | undefined {
  const fromEnv = process.env.AV_RECALL_ENABLED;
  if (fromEnv !== undefined) return fromEnv;
  const dotenv = join(hermesHome(), ".env");
  if (!existsSync(dotenv)) return undefined;
  let found: string | undefined;
  for (const line of readFileSync(dotenv, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?AV_RECALL_ENABLED\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let value = m[1] ?? "";
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2] ?? "";
    else value = value.replace(/\s+#.*$/, "");
    found = value; // last assignment wins, as when the file is sourced
  }
  return found;
}

/**
 * The tenant's recall opt-in: `true` for `1|true|yes|on` (any case), `null`
 * when unset or blank (not opted in, and nothing to undo), `false` for any
 * other value.
 */
export function recallChoice(): boolean | null {
  const raw = recallFlag()?.trim().toLowerCase();
  if (!raw) return null;
  return TRUTHY.has(raw);
}

/** Add or remove `recall` in `plugins.enabled`, leaving every other entry alone. */
export function setRecallPluginEnabled(on: boolean): void {
  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = Array.isArray(plugins.enabled)
    ? (plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[]
    : [];
  const next = on
    ? (enabled.includes(RECALL_PLUGIN) ? enabled : [...enabled, RECALL_PLUGIN])
    : enabled.filter((name) => name !== RECALL_PLUGIN);
  if (!on && next.length === enabled.length && !Array.isArray(plugins.enabled)) return;
  plugins.enabled = next;
  doc.plugins = plugins;
  writeConfig(doc);
}

/**
 * Enable the opt-in `recall` plugin (DATA-83) for a tenant that asked for it,
 * and disable it for one that explicitly opted out. A tenant that never set
 * `AV_RECALL_ENABLED` is left alone, so recall never lands on the core loop
 * by default. Idempotent. Skill staging and index removal live in
 * `install_recall.ts`.
 */
export function configureRecall(): void {
  const choice = recallChoice();
  if (choice === null) {
    console.log(`→ skipped plugin ${RECALL_PLUGIN} (opt-in: AV_RECALL_ENABLED=1)`);
    return;
  }
  setRecallPluginEnabled(choice);
  console.log(choice ? `→ enabled plugin ${RECALL_PLUGIN}` : `→ disabled plugin ${RECALL_PLUGIN} (AV_RECALL_ENABLED off)`);
}
