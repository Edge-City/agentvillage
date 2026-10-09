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
 * message to build its preview; that link is often a resident's signed accept
 * link (`acceptUrl`), and a crawler must never be the one to open it. Hermes's
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

/**
 * The floor for Hermes's per-file context cap, top-level `context_file_max_chars`
 * in config.yaml (AGENTS-MD-CAP). Hermes's `_get_context_file_max_chars`
 * (agent/prompt_builder.py, v2026.9.24 = Hermes 0.21.5) uses `int(val)` when
 * the top-level key is an `int` or `float` above 0, else the dynamic cap
 * `max(20000, min(context_length * 4 * 0.06, 500000))`. No box sets the key, and
 * the control plane pins `model.context_length: 90000` (DATA-401), so the cap
 * there is 21,600; unpinned at 200,000 it was 48,000, so this value restores
 * exactly the pre-pin cap. Over the cap Hermes keeps the head and the tail of a
 * context file around a marker and drops the middle: rc24 to rc26 shipped a
 * `workspace/AGENTS.md` of 25,232 to 29,714 chars, and the cut removed most of
 * its "Red lines" on every box. The control plane sets exactly three Hermes
 * keys at every root step (`model`, `cron.model`, `model.context_length`) and
 * never resets config.yaml, so this key survives provision, update, recreate
 * and rewire. A Hermes older than the key ignores an extra top-level key, so
 * the pin is harmless there and never fails the install.
 */
export const CONTEXT_FILE_MAX_CHARS = 48000;

/** A config value's kind for a log line, never the value itself. */
function kindOf(value: unknown): string {
  if (Array.isArray(value)) return "a list";
  if (isMapping(value)) return "a mapping";
  if (typeof value === "number") return "a non-finite number";
  return `a ${typeof value}`;
}

/**
 * Pin `context_file_max_chars` to at least `CONTEXT_FILE_MAX_CHARS`, the safety
 * net under the AGENTS.md budget (scripts/tests/agents-md-budget.test.ts).
 *
 * - Absent, null, or not a number Hermes honours (a string, a boolean, a
 *   non-finite or non-positive number, a number below 48,000): set to 48,000.
 * - A finite number of 48,000 or more: an operator's larger cap, left as is.
 * The file is left alone, with a warning, when its top level is not a mapping
 * or holds a YAML merge key, for the reason `keepTelegramBacklogOnColdBoot`
 * gives. A config value is never echoed onto the installer's stdout (only its
 * type, or a number). Idempotent: when nothing changes the file is not
 * rewritten. Hermes reads the key when it builds a prompt.
 */
export function setContextFileMaxChars(): void {
  const key = "context_file_max_chars";
  const doc: unknown = readConfig();
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; left ${key} unset`);
    return;
  }
  if ("<<" in doc) {
    console.log(`→ warning: YAML merge key "<<" at the top of config.yaml; left ${key} unset (set it by hand to ${CONTEXT_FILE_MAX_CHARS} or more)`);
    return;
  }
  const raw = doc[key];
  // Hermes reads a bool as an int (True == 1): only a real finite number counts.
  const number = typeof raw === "number" && Number.isFinite(raw);
  if (number && raw >= CONTEXT_FILE_MAX_CHARS) {
    console.log(`→ ${key} already ${raw} (at least ${CONTEXT_FILE_MAX_CHARS}); left as is`);
    return;
  }
  const why =
    raw === undefined ? "was unset"
    : raw === null ? "was null (Hermes's dynamic cap)"
    : number ? `was ${raw}, below ${CONTEXT_FILE_MAX_CHARS}`
    : `was ${kindOf(raw)}, not a number Hermes reads`;
  doc[key] = CONTEXT_FILE_MAX_CHARS;
  writeConfig(doc);
  console.log(`→ set ${key}: ${CONTEXT_FILE_MAX_CHARS} (${why}; Hermes truncates a longer context file)`);
}

/**
 * RC28: the seconds the gateway holds an arriving message while the pre-turn
 * session-hygiene summary finishes, `compression.hygiene_max_turn_hold_seconds`
 * (nested under the top-level `compression` mapping; Hermes 0.21.5 =
 * v2026.9.24 reads it at gateway/run_turn.py:651-672, default 10 at
 * hermes_cli/config_defaults.py:620-624, re-read every turn, no restart).
 *
 * Hygiene fires when the previous turn's prompt reached 85% of
 * `model.context_length` (76,500 at the control plane's 90,000 pin). A summary
 * still running when the hold expires sends "Context compression deferred —
 * summary still streaming" to the chat (run_turn.py:999-1001) and the turn runs
 * uncompressed; the stored token count stays high, so the notice repeats on
 * every message. A summary that lands inside the hold is adopted inline and
 * resets that count (run_turn.py:1142-1144), so the hold is the fix.
 *
 * Why 25: the haiku-5.5 summary measured on the affected box took 16-18 s
 * (Oct 9), so the 10 s default expired every time; 25 covers it with margin.
 * It stays under `compression.hygiene_timeout_seconds` (default 30, a
 * no-progress window that flips to a different warning and a 300 s cooldown)
 * and under Hermes's own "keep under chat idle timeouts, Telegram ~30s" note;
 * the resident sees the typing indicator while the turn is held. The lead's
 * first ask was 45: the number moves here, in this one constant. Summary
 * bounds for scale: output about 4,500 tokens, input capped at 160k chars.
 */
export const HYGIENE_MAX_TURN_HOLD_SECONDS = 25;

/**
 * Pin the compaction settings behind the deferred-compression notice loop (RC28):
 *
 * 1. `compression.hygiene_max_turn_hold_seconds: 25` (see
 *    `HYGIENE_MAX_TURN_HOLD_SECONDS`). Absent, null, not a finite number (a
 *    string, a boolean, which Hermes's float() reads as 1) or below 25: set to
 *    25. A number of 25 or more is an operator's longer hold, left as is.
 *    `compression` absent or null is created; `compression` not a mapping, or
 *    holding a YAML merge key, is left alone with a warning.
 * 2. `display.platforms.telegram.suppress_warning_notifications: true`
 *    (DATA-409, the chat half). Hermes sends its warning-class diagnostics
 *    through `adapter.emit_warning` and the diagnostic status rail and drops
 *    them on a platform where this resolves true
 *    (gateway/warning_notifications.py:90-101, gateway/display_config.py:82-112,
 *    read at send time). Trade-off: on Telegram it hides every warning
 *    diagnostic, not only the deferred notice: the hygiene timeout and failure
 *    warnings, the "Configured compression model ... failed" notice, the
 *    context-file TRUNCATED status line and media-send fallback notices. It
 *    never hides an assistant reply or a command response. Written for Telegram
 *    only, the resident surface; the global `display` key is never written. An
 *    explicit `false` is an operator's choice, kept with one log line; any other
 *    value but `true` is set to `true`. The Telegram display step
 *    (install/display_defaults.ts) walks the same `display.platforms.telegram`
 *    mapping, refuses the same shapes and never writes this key, so the two
 *    steps cannot undo each other.
 * 3. An explicit `auxiliary.compression` route `{provider, model,
 *    reasoning_effort: none}`. With Hermes's default `provider: auto` the
 *    summary already runs on the main provider and model but never with
 *    reasoning disabled; an explicit provider and model matching the route used,
 *    with `reasoning_effort: none`, make Hermes send `reasoning: {enabled:
 *    false}` on the summary call (agent/auxiliary_client.py:6144-6195). The
 *    provider and model are this box's own `model.provider` and `model.default`,
 *    what `auto` resolves to (auxiliary_client.py:2428-2455), so the summary
 *    model does not change. A route already explicit (a provider or model not
 *    empty and not `auto`, or a `base_url`) is kept, this step's own earlier
 *    write included; `reasoning_effort` is added when absent, null or empty and
 *    otherwise kept. With no named `model.provider` and `model.default` the
 *    block is skipped with a warning.
 *
 * Each pin is independent: one that cannot be written is skipped with a
 * `→ warning:` line and the others still apply. The whole step is skipped when
 * the top level of config.yaml is not a mapping or holds a YAML merge key, for
 * the reason `keepTelegramBacklogOnColdBoot` gives. One `→` line per pin; a
 * config value is never echoed onto stdout (only its type, or a number).
 * Idempotent: a second run changes nothing, says so, and does not rewrite the
 * file.
 */
export function setCompactionSettings(): void {
  const holdPath = "compression.hygiene_max_turn_hold_seconds";
  const suppressPath = "display.platforms.telegram.suppress_warning_notifications";
  const routePath = "auxiliary.compression";
  const doc: unknown = readConfig();
  if (!isMapping(doc)) {
    console.log("→ warning: the top level of config.yaml is not a mapping; left the compaction settings unset");
    return;
  }
  if ("<<" in doc) {
    console.log('→ warning: YAML merge key "<<" at the top of config.yaml; left the compaction settings unset (set them by hand)');
    return;
  }
  // Each level may be absent or null (treated as empty); anything else must be a plain mapping.
  const section = (parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | string => {
    const value = parent[key] ?? {};
    if (!isMapping(value)) return `${path} is not a mapping`;
    if ("<<" in value) return `YAML merge key "<<" under ${path}; set it by hand`;
    return value;
  };
  const lines: string[] = [];
  let changed = false;

  // 1. The turn hold.
  const compression = section(doc, "compression", "compression");
  if (typeof compression === "string") {
    lines.push(`→ warning: ${compression}; left ${holdPath} unset`);
  } else {
    const raw = compression.hygiene_max_turn_hold_seconds;
    const number = typeof raw === "number" && Number.isFinite(raw);
    if (number && raw >= HYGIENE_MAX_TURN_HOLD_SECONDS) {
      lines.push(`→ ${holdPath} already ${raw} (at least ${HYGIENE_MAX_TURN_HOLD_SECONDS}); left as is`);
    } else {
      const why =
        raw === undefined ? "was unset"
        : raw === null ? "was null"
        : number ? `was ${raw}, below ${HYGIENE_MAX_TURN_HOLD_SECONDS}`
        : `was ${kindOf(raw)}, not a number`;
      doc.compression = { ...compression, hygiene_max_turn_hold_seconds: HYGIENE_MAX_TURN_HOLD_SECONDS };
      changed = true;
      lines.push(`→ set ${holdPath}: ${HYGIENE_MAX_TURN_HOLD_SECONDS} (${why}; a summary that lands inside the hold is adopted with no notice)`);
    }
  }

  // 2. Telegram warning diagnostics off (DATA-409).
  const display = section(doc, "display", "display");
  const platforms = typeof display === "string" ? display : section(display, "platforms", "display.platforms");
  const telegram = typeof platforms === "string" ? platforms : section(platforms, "telegram", "display.platforms.telegram");
  if (typeof display === "string" || typeof platforms === "string" || typeof telegram === "string") {
    const why = typeof display === "string" ? display : typeof platforms === "string" ? platforms : telegram;
    lines.push(`→ warning: ${why}; left ${suppressPath} unset`);
  } else {
    const raw = telegram.suppress_warning_notifications;
    if (raw === true) {
      lines.push(`→ ${suppressPath} already true`);
    } else if (raw === false) {
      lines.push(`→ ${suppressPath} is false (set by hand); left as is, so Hermes warning diagnostics still reach Telegram`);
    } else {
      const why = raw === undefined ? "was unset" : raw === null ? "was null" : `was ${typeof raw === "number" ? "a number" : kindOf(raw)}`;
      doc.display = { ...display, platforms: { ...platforms, telegram: { ...telegram, suppress_warning_notifications: true } } };
      changed = true;
      lines.push(`→ set ${suppressPath}: true (${why}; Hermes warning diagnostics, the compaction notices among them, stay out of the resident's chat)`);
    }
  }

  // 3. The summary call's explicit route, reasoning off.
  const named = (value: unknown): value is string =>
    typeof value === "string" && value.trim() !== "" && value.trim().toLowerCase() !== "auto";
  // Hermes's own block writes `reasoning_effort: ""` (the provider's default): that counts as unset.
  const effortUnset = (value: unknown): boolean =>
    value === undefined || value === null || (typeof value === "string" && !value.trim());
  const auxiliary = section(doc, "auxiliary", "auxiliary");
  const route = typeof auxiliary === "string" ? auxiliary : section(auxiliary, "compression", routePath);
  const main = section(doc, "model", "model");
  if (typeof auxiliary === "string" || typeof route === "string") {
    lines.push(`→ warning: ${typeof auxiliary === "string" ? auxiliary : route}; left ${routePath} as is`);
  } else if (named(route.provider) || named(route.model) || (typeof route.base_url === "string" && route.base_url.trim())) {
    // A route already explicit (this step's own write on an earlier run, or an operator's) is kept.
    const ours = typeof main !== "string" && named(main.provider) && named(main.default)
      && route.provider === main.provider.trim() && route.model === main.default.trim();
    if (effortUnset(route.reasoning_effort)) {
      doc.auxiliary = { ...auxiliary, compression: { ...route, reasoning_effort: "none" } };
      changed = true;
      lines.push(`→ set ${routePath}.reasoning_effort: none (kept the explicit route already there)`);
    } else if (ours) {
      lines.push(`→ ${routePath} already this box's main provider and model; left as is`);
    } else {
      lines.push(`→ ${routePath} has an explicit route other than this box's main model; left as is`);
    }
  } else if (typeof main === "string" || !named(main.provider) || !named(main.default)) {
    lines.push(`→ warning: config.yaml names no model.provider and model.default; left ${routePath} as is (the summary keeps the provider's default reasoning)`);
  } else {
    const keptEffort = !effortUnset(route.reasoning_effort);
    const next = { ...route, provider: main.provider.trim(), model: main.default.trim(), ...(keptEffort ? {} : { reasoning_effort: "none" }) };
    doc.auxiliary = { ...auxiliary, compression: next };
    changed = true;
    lines.push(`→ set ${routePath}: this box's main provider and model, ${keptEffort ? "reasoning_effort kept as set" : "reasoning_effort: none (the summary runs with reasoning off)"}`);
  }

  if (changed) writeConfig(doc);
  for (const line of lines) console.log(line);
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
