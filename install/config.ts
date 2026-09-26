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
 * Enable the Agent Village telemetry plugin on every tenant, token or not.
 *
 * The plugin is fail-open by construction: without `AV_EVENTS_TOKEN` no event
 * is emitted or buffered and no flusher thread starts; memory backups still
 * run when AV_BACKUP_URL, AV_BACKUP_TOKEN and the tenant id are set (the
 * control plane sets them only while village consent is in force and
 * BACKUP_WRITE_MASTER is configured). `AV_EVENTS_ENABLED=0` switches it off
 * without a redeploy. So it is always listed. Gating the listing on a token at
 * install time left it off every control-plane tenant (DATA-160): the control
 * plane writes the token into `$HERMES_HOME/.env` seconds after the installer
 * has run, and nothing re-ran the enable once it had.
 *
 * The token's presence (process environment, else `$HERMES_HOME/.env`, read
 * as the recall flag is) only shapes the log line, and a failure to read it
 * never stops the install (it falls back to the idle wording). The token is
 * never written to `config.yaml` or anywhere else: the plugin reads it at
 * session start. An `av-events` entry in `plugins.disabled` is left alone and
 * logged as a warning: it is the one way to keep the plugin off across
 * updates. Idempotent; every other `plugins.enabled` entry keeps its place.
 */
export function configureAvEvents(): void {
  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = Array.isArray(plugins.enabled)
    ? (plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[]
    : [];
  if (!enabled.includes(AV_EVENTS_PLUGIN)) enabled.push(AV_EVENTS_PLUGIN);
  plugins.enabled = enabled;
  doc.plugins = plugins;

  writeConfig(doc);
  let present = false;
  try {
    present = Boolean(envOrDotenv("AV_EVENTS_TOKEN")?.trim());
  } catch {
    // Only the log line depends on this; an unreadable .env must not stop the install.
  }
  const idle = present
    ? ""
    : " (no AV_EVENTS_TOKEN yet; the plugin idles until the control plane writes one)";
  console.log(`→ enabled plugin ${AV_EVENTS_PLUGIN}${idle}`);
  if (Array.isArray(plugins.disabled) && (plugins.disabled as unknown[]).includes(AV_EVENTS_PLUGIN)) {
    console.log(`→ warning: ${AV_EVENTS_PLUGIN} is in plugins.disabled; Hermes will not load it`);
  }
}

export const RECALL_PLUGIN = "recall";

/** The only values that turn a flag on. Anything else — `disabled`, `n`, `none`, a typo — is off. */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/**
 * A variable from the process environment or, when it is absent there, from
 * `$HERMES_HOME/.env` — the sidecar `/update` path runs the installer without
 * sourcing that file, and the control plane writes some variables (such as
 * `AV_EVENTS_TOKEN`) there only after the first install. A variable present in
 * the environment (even blank) is authoritative, as in `av-events`. `name`
 * must be a plain identifier (it is spliced into a regular expression).
 */
function envOrDotenv(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) return fromEnv;
  const dotenv = join(hermesHome(), ".env");
  if (!existsSync(dotenv)) return undefined;
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  let found: string | undefined;
  for (const line of readFileSync(dotenv, "utf8").split(/\r?\n/)) {
    const m = assignment.exec(line);
    if (!m) continue;
    found = dotenvValue(m[1] ?? ""); // last assignment wins, as python-dotenv does
  }
  return found;
}

/** `AV_RECALL_ENABLED`, read by `envOrDotenv`. */
function recallFlag(): string | undefined {
  return envOrDotenv("AV_RECALL_ENABLED");
}

/**
 * One `.env` value, read the way python-dotenv (which Hermes uses) reads it:
 * a single-quoted value is literal up to the closing quote; a double-quoted
 * one honours backslash escapes up to the closing unescaped quote; anything
 * after the closing quote (such as `# comment`) is ignored. An unquoted value
 * ends at the first `#` that follows whitespace, and is trimmed.
 * (`AV_RECALL_ENABLED` values are simple words; this covers what an operator
 * writes, not every python-dotenv corner such as multi-line values.)
 */
export function dotenvValue(raw: string): string {
  const text = raw.trim();
  const quote = text[0];
  if (quote === "'" || quote === '"') {
    let out = "";
    for (let i = 1; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === quote) return out;
      if (quote === '"' && ch === "\\" && i + 1 < text.length) {
        const next = text[++i]!;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        continue;
      }
      out += ch;
    }
    return text; // unterminated: python-dotenv keeps the raw text
  }
  // python-dotenv: `re.sub(r"\s+#.*", "", value).rstrip()`.
  return text.replace(/\s+#.*$/, "").trim();
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
