import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { hermesHome } from "./paths";

const DEFAULT_MODEL_MAX_TOKENS = 4096;

/** `$HERMES_HOME/config.yaml` as a mapping (`{}` when absent or empty). Shared by the installer steps. */
export function readConfig(): Record<string, unknown> {
  const configPath = join(hermesHome(), "config.yaml");
  if (!existsSync(configPath)) return {};
  // An empty or comment-only file parses to null; every helper expects a mapping.
  return (YAML.parse(readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
}

/** Write `$HERMES_HOME/config.yaml` from `doc` (the `yaml` package's stringify, as every step here does). */
export function writeConfig(doc: Record<string, unknown>): void {
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

/** Hermes `platforms.telegram.extra` key that decides whether a cold start discards the backlog. */
export const TELEGRAM_COLD_BOOT_KEY = "drop_pending_on_cold_boot";

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Keep residents' Telegram messages across a gateway restart: set
 * `platforms.telegram.extra.drop_pending_on_cold_boot: false`, so a cold start
 * reads the messages Telegram queued while the gateway was down (an update, a
 * roll, a crash restart) in order instead of discarding them. Hermes builds from
 * 2026-09-20 read the key (default `true`); older builds ignore it, since
 * `extra` is a free-form mapping the adapter reads with `.get`.
 *
 * Written only when the key is absent. A value an operator set by hand, under
 * `extra` or at the top of the `telegram` block (Hermes promotes top-level
 * platform keys into `extra`), is left as it is, whatever it is. The file is
 * also left alone, with a warning naming the path, when the top level,
 * `platforms`, `telegram` or `extra` exists but is not a mapping, or holds a
 * YAML merge key (`<<`): the `yaml` package reads `<<` as a literal key while
 * Hermes (PyYAML) merges it, so the presence check cannot see a merged-in value
 * and an explicit `extra` written beside a merge would replace the merged one in
 * Hermes. Idempotent: when nothing changes the file is not rewritten.
 */
export function keepTelegramBacklogOnColdBoot(): void {
  const doc: unknown = readConfig();
  const skip = (why: string): void =>
    console.log(`→ warning: ${why}; left ${TELEGRAM_COLD_BOOT_KEY} unset`);
  if (!isMapping(doc)) return skip("the top level of config.yaml is not a mapping");

  // Each level may be absent or null (treated as empty); anything else must be a plain mapping.
  const section = (parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | string => {
    const value = parent[key] ?? {};
    if (!isMapping(value)) return `${path} is not a mapping`;
    if ("<<" in value) return `YAML merge key "<<" under ${path}; set it by hand if wanted`;
    return value;
  };
  const rawPlatforms = section(doc, "platforms", "platforms");
  if (typeof rawPlatforms === "string") return skip(rawPlatforms);
  const rawTelegram = section(rawPlatforms, "telegram", "platforms.telegram");
  if (typeof rawTelegram === "string") return skip(rawTelegram);
  const rawExtra = section(rawTelegram, "extra", "platforms.telegram.extra");
  if (typeof rawExtra === "string") return skip(rawExtra);

  if (TELEGRAM_COLD_BOOT_KEY in rawExtra || TELEGRAM_COLD_BOOT_KEY in rawTelegram) {
    console.log(`→ telegram ${TELEGRAM_COLD_BOOT_KEY} already set; left as is`);
    return;
  }

  const extra = { ...rawExtra, [TELEGRAM_COLD_BOOT_KEY]: false };
  doc.platforms = { ...rawPlatforms, telegram: { ...rawTelegram, extra } };
  writeConfig(doc);
  console.log(`→ set platforms.telegram.extra.${TELEGRAM_COLD_BOOT_KEY}: false (keep Telegram backlog across restarts)`);
}

/** Hermes `platforms.telegram.extra` key that turns off Telegram's link previews on every outgoing message. */
export const TELEGRAM_LINK_PREVIEWS_KEY = "disable_link_previews";

/**
 * Turn Telegram link previews off: `platforms.telegram.extra.disable_link_previews: true`
 * (SEREF-OVERLAY refute F1). Telegram's servers fetch the first link in a bot
 * message to build its preview; that link is often a resident's message link
 * (`/o/<id>?surface=telegram`), and a crawler must never be the one to open it. Hermes's
 * Telegram adapter reads the key from `extra` (default `false`); a copy at the
 * top of the `telegram` block is promoted over `extra`, so one there that is not
 * `true` is set to `true` as well.
 *
 * Unlike the cold-boot key this is a safety setting, so a `false` someone set by
 * hand is overwritten (with a log line saying so). The file is left alone, with
 * a warning, when the top level, `platforms`, `telegram` or `extra` is not a
 * mapping or holds a YAML merge key, for the reason `keepTelegramBacklogOnColdBoot`
 * gives; a top-level `telegram:` block (which Hermes reads ahead of
 * `platforms.telegram`) that sets the key to anything but `true` gets a warning
 * and is not edited. Idempotent: when nothing changes the file is not rewritten.
 */
export function disableTelegramLinkPreviews(): void {
  const key = TELEGRAM_LINK_PREVIEWS_KEY;
  const doc: unknown = readConfig();
  const skip = (why: string): void => console.log(`→ warning: ${why}; left ${key} as is`);
  if (!isMapping(doc)) return skip("the top level of config.yaml is not a mapping");

  const section = (parent: Record<string, unknown>, name: string, path: string): Record<string, unknown> | string => {
    const value = parent[name] ?? {};
    if (!isMapping(value)) return `${path} is not a mapping`;
    if ("<<" in value) return `YAML merge key "<<" under ${path}; set it by hand`;
    return value;
  };
  const rawPlatforms = section(doc, "platforms", "platforms");
  if (typeof rawPlatforms === "string") return skip(rawPlatforms);
  const rawTelegram = section(rawPlatforms, "telegram", "platforms.telegram");
  if (typeof rawTelegram === "string") return skip(rawTelegram);
  const rawExtra = section(rawTelegram, "extra", "platforms.telegram.extra");
  if (typeof rawExtra === "string") return skip(rawExtra);

  const topLevel = doc.telegram;
  if (isMapping(topLevel)) {
    const extraTop = isMapping(topLevel.extra) ? topLevel.extra : {};
    for (const [path, holder] of [["telegram", topLevel], ["telegram.extra", extraTop]] as const) {
      if (key in holder && holder[key] !== true) {
        console.log(`→ warning: ${path}.${key} is ${JSON.stringify(holder[key])}; Hermes reads it first, set it to true by hand`);
      }
    }
  }

  const promotedOk = !(key in rawTelegram) || rawTelegram[key] === true;
  if (rawExtra[key] === true && promotedOk) {
    console.log(`→ telegram ${key} already true`);
    return;
  }
  const overridden = [
    ...(key in rawExtra && rawExtra[key] !== true ? [`platforms.telegram.extra.${key}`] : []),
    ...(promotedOk ? [] : [`platforms.telegram.${key}`]),
  ];
  const telegram = { ...rawTelegram, extra: { ...rawExtra, [key]: true } };
  if (!promotedOk) telegram[key] = true;
  doc.platforms = { ...rawPlatforms, telegram };
  writeConfig(doc);
  const note = overridden.length ? ` (overrode ${overridden.join(", ")})` : "";
  console.log(`→ set platforms.telegram.extra.${key}: true (no link previews on signed links)${note}`);
}

/** The village's zone: every schedule this overlay installs is written in it (DATA-314). */
export const VILLAGE_TIMEZONE = "Asia/Kolkata";
/** Names Hermes's zoneinfo resolves to the village's zone (the IANA link included). */
const VILLAGE_ZONE_NAMES = new Set([VILLAGE_TIMEZONE, "Asia/Calcutta"]);

/**
 * Make Hermes run its cron schedules in village time (DATA-314, B1-fix F1).
 *
 * Hermes reads a schedule's hours in one zone (`hermes_time.py`, v2026.9.24):
 * `HERMES_TIMEZONE`, then `timezone:` in `config.yaml`, else the host's local
 * time; under the multiplexed gateway only `config.yaml` counts, and the
 * gateway copies a configured `timezone` over `HERMES_TIMEZONE` at startup.
 * Every schedule this overlay installs is written in village time, and the
 * morning brief's trigger delivers only between 05:00 and 11:00 IST, so on a
 * host whose Hermes zone is not IST the jobs fire at the wrong village hour
 * and the brief is silent every day.
 *
 * - No zone configured (no `timezone` key, or an empty one, which is what
 *   Hermes writes by default) and `HERMES_TIMEZONE` unset or the village
 *   zone: writes `timezone: Asia/Kolkata`, logged in one line.
 * - A zone configured that is not the village zone, in `config.yaml` or in
 *   `HERMES_TIMEZONE` (process environment or `$HERMES_HOME/.env`, which
 *   Hermes loads over it): changes nothing and prints one loud warning naming
 *   the zone.
 * A value set by hand is never overwritten. The file is also left alone, with
 * a warning, when its top level is not a mapping or holds a YAML merge key, for
 * the reason `keepTelegramBacklogOnColdBoot` gives. Idempotent: when nothing
 * changes the file is not rewritten. Hermes reads the key at gateway start, so
 * it takes effect at the restart that ends every install.
 */
export function configureVillageTimezone(): void {
  let envZone: string | undefined;
  try {
    envZone = (dotenvFileValue("HERMES_TIMEZONE") ?? process.env.HERMES_TIMEZONE)?.trim() || undefined;
  } catch {
    envZone = process.env.HERMES_TIMEZONE?.trim() || undefined;
  }
  const doc: unknown = readConfig();
  if (!isMapping(doc)) {
    console.log("→ warning: the top level of config.yaml is not a mapping; left timezone unset");
    return;
  }
  if ("<<" in doc) {
    console.log('→ warning: YAML merge key "<<" at the top of config.yaml; left timezone unset (set it by hand if wanted)');
    return;
  }
  const raw = doc.timezone;
  const unset = raw === undefined || raw === null || (typeof raw === "string" && !raw.trim());
  const wrong: string[] = [];
  if (!unset && !(typeof raw === "string" && VILLAGE_ZONE_NAMES.has(raw.trim()))) {
    wrong.push(`timezone in config.yaml is ${JSON.stringify(typeof raw === "string" ? raw.trim() : raw)}`);
  }
  if (envZone !== undefined && !VILLAGE_ZONE_NAMES.has(envZone)) wrong.push(`HERMES_TIMEZONE is ${JSON.stringify(envZone)}`);
  if (wrong.length > 0) {
    console.warn(
      `!! WARNING: ${wrong.join(" and ")}, not ${VILLAGE_TIMEZONE}. The six proactive jobs will run at the wrong `
      + `village time and the morning brief will be silent every day. Left as set; set ${VILLAGE_TIMEZONE} by hand to fix.`,
    );
    return;
  }
  if (!unset) {
    console.log(`→ timezone already ${VILLAGE_TIMEZONE}; left as is`);
    return;
  }
  doc.timezone = VILLAGE_TIMEZONE;
  writeConfig(doc);
  console.log(`→ set timezone: ${VILLAGE_TIMEZONE} (the proactive jobs' schedules are in village time)`);
}

/** Seconds a cron pre-run script may run before Hermes kills it. */
export const CRON_SCRIPT_TIMEOUT_SECONDS = 120;
/** Hermes's default (cron/scheduler.py _DEFAULT_SCRIPT_TIMEOUT). */
export const HERMES_DEFAULT_SCRIPT_TIMEOUT = 3600;

/**
 * Set `cron.script_timeout_seconds` to 120 when it is unset, holds Hermes's
 * own default of 3600 (a config save can write the default out), or is a
 * number below 120 (DATA-314). The proactive triggers wait up to 60 s for the
 * state lock and stop themselves at 100 s, so they need the script timeout at
 * about 110 s or more; Hermes's default of an hour would let a hung call hold a
 * job (and the state lock) far past its slot. Any other value an operator set
 * is left as it is. Idempotent: when nothing changes the file is not
 * rewritten.
 */
export function configureCronScriptTimeout(): void {
  const doc = readConfig();
  const raw = doc.cron;
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    console.log("→ warning: cron in config.yaml is not a mapping; left cron.script_timeout_seconds unset");
    return;
  }
  const cron = { ...((raw as Record<string, unknown>) ?? {}) };
  const current = cron.script_timeout_seconds;
  const seconds = typeof current === "number" ? current : typeof current === "string" && current.trim() ? Number(current) : Number.NaN;
  const unset = current === undefined || current === null;
  const lower = Number.isFinite(seconds) && seconds > 0 && seconds < CRON_SCRIPT_TIMEOUT_SECONDS;
  // Hermes's own default (3600) written out by a config save counts as unset.
  if (!unset && !lower && seconds !== HERMES_DEFAULT_SCRIPT_TIMEOUT) {
    // R3 fix round 4 (output injection): a config value is never echoed onto the installer's stdout.
    console.log("→ cron.script_timeout_seconds already set; left as is");
    return;
  }
  cron.script_timeout_seconds = CRON_SCRIPT_TIMEOUT_SECONDS;
  doc.cron = cron;
  writeConfig(doc);
  console.log(`→ set cron.script_timeout_seconds: ${CRON_SCRIPT_TIMEOUT_SECONDS}`);
}

/**
 * Set `cron.wrap_response: false` (DATA-373). With it unset or true, Hermes
 * wraps every cron delivery in a "Cronjob Response: <job name>" header and a
 * "To stop or manage this job ..." footer (cron/scheduler_delivery.py at the
 * floor 118984d7); false sends the model's reply as it is. Each delivering
 * prompt under skills/index-network/prompts ends with its own one-line manage
 * note instead. The knob is global, so a resident's own reminders lose the
 * wrapper too (accepted, Carter 2026-10-07). Hermes wraps on any value but
 * false, so anything else (unset, true as a config save writes the default,
 * a stray string) becomes false. Idempotent: when it is already false the
 * file is not rewritten.
 */
export function configureCronWrapResponse(): void {
  const doc = readConfig();
  const raw = doc.cron;
  if (raw !== undefined && raw !== null && (typeof raw !== "object" || Array.isArray(raw))) {
    console.log("→ warning: cron in config.yaml is not a mapping; left cron.wrap_response unset");
    return;
  }
  const cron = { ...((raw as Record<string, unknown>) ?? {}) };
  if (cron.wrap_response === false) {
    console.log("→ cron.wrap_response already false; left as is");
    return;
  }
  cron.wrap_response = false;
  doc.cron = cron;
  writeConfig(doc);
  console.log("→ set cron.wrap_response: false (cron deliveries carry no Hermes header or footer)");
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

const INDEX_LINKS_PLUGIN = "index-links";

/** List `index-links` so Hermes loads the tool-result link rewrite. Idempotent. */
export function configureIndexLinks(): void {
  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = Array.isArray(plugins.enabled)
    ? (plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[]
    : [];
  if (!enabled.includes(INDEX_LINKS_PLUGIN)) enabled.push(INDEX_LINKS_PLUGIN);
  plugins.enabled = enabled;
  doc.plugins = plugins;
  writeConfig(doc);
  console.log(`→ enabled plugin ${INDEX_LINKS_PLUGIN}`);
  if (Array.isArray(plugins.disabled) && (plugins.disabled as unknown[]).includes(INDEX_LINKS_PLUGIN)) {
    console.log(`→ warning: ${INDEX_LINKS_PLUGIN} is in plugins.disabled; Hermes will not load it`);
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
export function envOrDotenv(name: string): string | undefined {
  const fromEnv = process.env[name];
  if (fromEnv !== undefined) return fromEnv;
  return dotenvFileValue(name);
}

/**
 * A variable as `$HERMES_HOME/.env` alone assigns it (last assignment wins),
 * or `undefined` when the file or the assignment is absent. This is what a
 * Hermes process sees once `load_hermes_dotenv(override=True)` has run, which
 * is why a check about the gateway's environment reads the file and not this
 * process's environment. `name` must be a plain identifier.
 */
export function dotenvFileValue(name: string): string | undefined {
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
