import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { hermesHome } from "./paths";

const DEFAULT_MODEL_MAX_TOKENS = 4096;

/**
 * LLM-429: the one Hermes fallback route the installer manages (`configureModelFallback`), the
 * only place this model string lives in the overlay. luna is the control plane's code default
 * (`DEFAULT_MODEL`, control-plane/src/tenants.js:291), a model every box can call through its own
 * OpenRouter key: that key restricts no model (the control plane's `HERMES_MODEL_ALLOWLIST` gates
 * only the per-tenant model PUT, tenant-model.js), and luna turns spend the key's lifetime limit
 * like any other. Why and the incident:
 * private/handover/lanes-intro/LLM-429.md.
 */
export const FALLBACK_PROVIDER = "openrouter";
export const FALLBACK_MODEL = "openai/gpt-6-luna";

/** `$HERMES_HOME/config.yaml` as a mapping (`{}` when absent or empty). Shared by the installer steps. */
export function readConfig(): Record<string, unknown> {
  const configPath = join(hermesHome(), "config.yaml");
  if (!existsSync(configPath)) return {};
  // An empty or comment-only file parses to null; every helper expects a mapping.
  return (YAML.parse(readFileSync(configPath, "utf8")) ?? {}) as Record<string, unknown>;
}

/**
 * The plain-scalar patterns YAML 1.1 resolves to something other than a string, taken from the
 * `yaml` package's own `yaml-1.1` schema: booleans (y, n, yes, no, on, off, true, false in their
 * case forms), null and `~`, 1.1 integers (`0b101`, `0755`, `1_000`, base-60 `22:00`), floats and
 * timestamps (`2026-10-08`). The merge key `<<` is not in the list (see `needsQuotes`).
 */
const YAML11_IMPLICIT: readonly RegExp[] = new YAML.Document(null, { version: "1.1" }).schema.tags.flatMap((tag) =>
  "test" in tag && tag.test instanceof RegExp && tag.default === true ? [tag.test] : [],
);

/**
 * PyYAML's own timestamp resolver (yaml/resolver.py), which is wider than the `yaml` package's 1.1
 * schema in two spots: a time-zone hour of one or two digits (`+35`, which PyYAML then refuses as an
 * offset, so the whole file is unreadable) and a fraction with no digits after the dot
 * (`10:00:00.`, read as a datetime). Refuter M1 (lanes-b3/DATA-434-refute.md).
 */
const PYYAML_TIMESTAMP =
  /^(?:[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?)$/;

/**
 * Whether a string scalar must be quoted for PyYAML. Also `=` anywhere and `<<` as a value: PyYAML
 * resolves both bare words to tags `safe_load` cannot construct and refuses the whole file. A `<<`
 * key stays bare, as before, so a merge PyYAML performs is still a merge. A single-line string
 * holding a tab is quoted too: the `yaml` package emits it plain, and PyYAML and ruamel (Hermes's
 * writer) both refuse a tab inside a plain scalar, which makes the whole file unreadable. A
 * multi-line string is emitted as a block scalar, which both readers accept with tabs.
 */
function needsQuotes(value: string, isKey: boolean): boolean {
  if (value === "=" || (value === "<<" && !isKey)) return true;
  if (value.includes("\t") && !value.includes("\n")) return true;
  if (PYYAML_TIMESTAMP.test(value)) return true;
  return YAML11_IMPLICIT.some((re) => re.test(value));
}

/**
 * `doc` as config.yaml text (DATA-434). Hermes reads the file with PyYAML (YAML 1.1;
 * hermes_cli/config.py:436, utils.py `fast_safe_load`) while the `yaml` package writes YAML 1.2,
 * where only true/false/null are reserved; a string such as a resident's `/verbose` "off" came out
 * as the bare word `off`, which Hermes reads as boolean False and its next save writes as `false`.
 * So this is the package's YAML 1.2 dump (a string 1.2 would read as another type is quoted as
 * before) with every string, key or value, that YAML 1.1 would read as another type double-quoted
 * too; Hermes's own writer double-quotes the boolean and null words the same way (utils.py
 * `_rt_value`). Every string then reads back as itself under both readers, and nothing else
 * changes form. Not `version: "1.1"`: that writer drops the quotes from a string such as "0o755"
 * (a plain string to 1.1, an integer to `readConfig`'s 1.2 parse), so the next installer pass
 * would turn it into a number.
 */
export function dumpConfig(doc: Record<string, unknown>): string {
  const out = new YAML.Document(doc);
  YAML.visit(out, {
    Scalar(key, node) {
      if (typeof node.value === "string" && needsQuotes(node.value, key === "key")) node.type = "QUOTE_DOUBLE";
    },
  });
  return out.toString();
}

/** Write `$HERMES_HOME/config.yaml` from `doc` through `dumpConfig`, the one writer every installer step uses. */
export function writeConfig(doc: Record<string, unknown>): void {
  writeFileSync(join(hermesHome(), "config.yaml"), dumpConfig(doc));
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

/**
 * LLM-429: make sure top-level `fallback_providers` holds `{provider: openrouter, model:
 * openai/gpt-6-luna}` (`FALLBACK_PROVIDER` / `FALLBACK_MODEL`), so the first upstream 429 on the
 * primary model answers that turn on luna with no wait instead of up to two Retry-After waits
 * and a dropped turn. Paths are per Hermes v2026.9.24 (0.21.5):
 *
 * - Shape: what `hermes fallback add` appends, `{provider, model}` (hermes_cli/fallback_cmd.py:37-47,
 *   :189-191). No `api_key` or `base_url`: the openrouter route reads `OPENROUTER_API_KEY`, which
 *   the control plane already puts in the box's env (agent/auxiliary_client.py:2309-2317).
 * - When it fires: an OpenRouter "Provider returned error" 429 is `upstream_rate_limit`
 *   (agent/error_classifier.py:1050-1054); the eager-fallback step switches on that first error,
 *   before the retry wait (agent/turn_recovery.py:1826-1842, called at agent/turn_api_error.py:161;
 *   the wait is :391-398). The primary comes back on the first turn after the cooldown
 *   (agent/agent_runtime_helpers.py:1221-1317; cooldown agent/fallback_cooldown.py:45-76).
 * - Primary already luna: written anyway. Hermes skips a chain entry that is the backend that just
 *   failed (agent/chat_completion_helpers.py:1914-1926), and this step runs before the control
 *   plane's model step (tenants.js applyModelStep after INSTALL_CMD), so the installer cannot know
 *   the tenant's model; a per-tenant model change (PUT /tenants/:id/model) never reruns it.
 * - The control plane's `hermes config set model` / `cron.model` rewrite single keys of the raw
 *   file and keep this one (hermes_cli/config.py:3532-3578; bare `model` goes to `model.default`,
 *   :3401-3410); this step rewrites only `fallback_providers`.
 *
 * An entry with the same provider and model (case and spaces aside, other keys ignored, like
 * Hermes's own duplicate check, fallback_cmd.py:186) counts as present. Entries a human added are
 * kept in order and luna is appended after them; nothing is ever removed. A single mapping (the
 * legacy one-entry shape Hermes also reads, hermes_cli/fallback_config.py:77-78) becomes a list
 * with that mapping first. The file is left alone, with a warning, when its top level is not a
 * mapping or holds a YAML merge key, or when `fallback_providers` is something else (a string, a
 * number). A config value is never echoed onto stdout. Idempotent: when luna is present the file
 * is not rewritten. The gateway re-reads the chain before each turn, no restart needed
 * (gateway/run_config_loaders.py:516-553).
 */
export function configureModelFallback(): void {
  const key = "fallback_providers";
  const route = `${FALLBACK_PROVIDER} / ${FALLBACK_MODEL}`;
  const doc: unknown = readConfig();
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; left ${key} unset`);
    return;
  }
  if ("<<" in doc) {
    console.log(`→ warning: YAML merge key "<<" at the top of config.yaml; left ${key} unset (add ${route} by hand)`);
    return;
  }
  const raw = doc[key];
  let entries: unknown[];
  if (raw === undefined || raw === null) entries = [];
  else if (Array.isArray(raw)) entries = raw;
  else if (isMapping(raw)) entries = [raw];
  else {
    console.log(`→ warning: ${key} is a ${typeof raw}, not a list; left as is (add ${route} by hand)`);
    return;
  }
  const same = (value: unknown, want: string): boolean =>
    typeof value === "string" && value.trim().toLowerCase() === want.toLowerCase();
  if (entries.some((entry) => isMapping(entry) && same(entry.provider, FALLBACK_PROVIDER) && same(entry.model, FALLBACK_MODEL))) {
    console.log(`→ ${key} already has ${route}; left as is`);
    return;
  }
  doc[key] = [...entries, { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL }];
  writeConfig(doc);
  if (entries.length === 0) {
    console.log(`→ set ${key}: [${route}] (an upstream 429 on the primary model answers that turn on luna, no wait; LLM-429)`);
  } else {
    const n = entries.length;
    console.log(`→ added ${route} to ${key} after ${n} existing ${n === 1 ? "entry" : "entries"}`);
  }
}

/**
 * Hosted Telegram: pairing codes, no restart pings, no approval prompts, and every message
 * stamped with the time it was sent. Idempotent.
 *
 * `gateway.message_timestamps.enabled: true` (AGENT-DATE): Hermes 0.21.5 keeps a continuing
 * session's system prompt byte for byte (agent/conversation_loop.py `_restore_or_build_system_prompt`),
 * so its "today's date" line is the day of the last rebuild, often days old in a Telegram chat.
 * With this on, the gateway prefixes each resident message in the model's context with
 * `[Mon 2026-10-12 09:17:05 IST]` in Hermes's zone (gateway/run_turn.py:1495, read per message;
 * gateway/run.py `_message_timestamps_enabled`; the stored transcript stays clean). Hermes's
 * default is off (hermes_cli/config_defaults.py:2168). This is a pin, like
 * `disableTelegramLinkPreviews`: a `false` set by hand, or the bare `message_timestamps: <bool>`
 * shorthand Hermes also reads, becomes `{ enabled: true }`; other keys in the block are kept.
 * AGENTS.md tells the agent to trust the stamp over the prompt's date.
 */
export function configureHostedGateway(): void {
  const doc = readConfig();

  const gateway = { ...((doc.gateway as Record<string, unknown>) ?? {}) };
  const pairing = { ...((gateway.pairing as Record<string, unknown>) ?? {}) };
  pairing.global_mode = "pair";
  gateway.pairing = pairing;
  const rawStamps = gateway.message_timestamps;
  if (rawStamps !== undefined && rawStamps !== null && !isMapping(rawStamps) && rawStamps !== true) {
    // R3 fix round 4 (output injection): a config value is never echoed onto the installer's stdout.
    console.log("→ gateway.message_timestamps was not a mapping; replaced with { enabled: true }");
  } else if (isMapping(rawStamps) && "enabled" in rawStamps && rawStamps.enabled !== true) {
    console.log("→ gateway.message_timestamps.enabled was not true; set to true");
  }
  gateway.message_timestamps = { ...(isMapping(rawStamps) ? rawStamps : {}), enabled: true };
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
  console.log("→ hosted gateway: pairing mode, approvals off, no telegram restart pings, message timestamps on");
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

/**
 * SEC-6: the slash commands a resident may run. Every other command, built-in or plugin, is
 * admin-only under Hermes's slash access control: `/model`, `/reasoning`, `/fast`, `/yolo`,
 * `/config`, `/plugins`, `/skills`, `/cron`, `/reload`, `/update`, `/tools` and the rest. Names are
 * Hermes canonical names (`hermes_cli/commands.py` `CommandDef`); aliases resolve to them first.
 */
export const RESIDENT_SLASH_COMMANDS: readonly string[] = Object.freeze([
  // session
  "start", "new", "clear", "history", "save", "retry", "undo", "title", "compress", "stop", "pause",
  "approve", "deny", "btw", "queue", "steer", "status", "context", "resume", "sessions", "topic",
  // info
  "help", "whoami", "usage", "version", "commands", "insights", "image",
  // display
  "personality", "timestamps", "verbose", "busy", "footer",
  // tools
  "memory",
]);

/**
 * Admin id that matches no Telegram user: a non-empty admin list is what turns gating on. Always
 * the only admin id (SEC-6 fix round 1, S1): no environment variable can name an admin, because
 * the roll runs the installer with Bun's `.env` autoload from a directory the agent can write. An
 * operator who needs `/model` on a box uses the dashboard admin PTY or the `hermes` CLI there,
 * which slash access does not gate.
 */
export const SLASH_NO_ADMIN = "av-approval:no-admin";

/** The four keys `configureSlashAccess` writes (admin lists are per scope in Hermes). */
export const SLASH_ACCESS_KEYS = [
  "allow_admin_from", "group_allow_admin_from", "user_allowed_commands", "group_user_allowed_commands",
] as const;

/** The values `configureSlashAccess` writes under `platforms.telegram.extra`. */
export function slashAccessKeys(): Record<(typeof SLASH_ACCESS_KEYS)[number], string[]> {
  return {
    allow_admin_from: [SLASH_NO_ADMIN],
    group_allow_admin_from: [SLASH_NO_ADMIN],
    user_allowed_commands: [...RESIDENT_SLASH_COMMANDS],
    group_user_allowed_commands: [...RESIDENT_SLASH_COMMANDS],
  };
}

/**
 * SEC-6: residents may run only `RESIDENT_SLASH_COMMANDS` (plus Hermes's `/help`, `/whoami` floor);
 * `/model` and every model, cost or config command is admin-only, and no Telegram user is admin.
 * Hermes v2026.9.24 `gateway/slash_access.py` reads the four keys from the platform's `extra` per
 * scope (dm, group) and gates both dispatch paths (`gateway/run_busy.py` `_check_slash_access`);
 * a non-admin gets "⛔ /model is admin-only here. You can run: …". Plain chat is never gated.
 *
 * Written to `platforms.telegram.extra`, as `keepTelegramBacklogOnColdBoot` does, and overwritten
 * on every run (other keys kept). Hermes may read three other blocks over that one: a root
 * `telegram:` block or `gateway.platforms.telegram` (its shared-key bridge copies their top-level
 * keys, and a root block's `extra`, over `extra`) and `gateway.telegram` (merged last). The step
 * deletes the four keys from each of them, top level and `extra`, with one line per removal, and
 * mirrors the values onto a top-level `platforms.telegram.<key>` copy.
 *
 * Fails loudly (fix round 1, S3): when a level it must edit is not a mapping or holds a YAML merge
 * key (`<<`, which PyYAML merges and the `yaml` package cannot see through), it writes nothing and
 * returns the reason; install.ts records it as `slash_access_failed` in `install-status.json` and
 * exits non-zero at the end of the run. Idempotent: an unchanged file is not rewritten.
 *
 * @returns null when the gate is configured, else why it is not.
 */
export function configureSlashAccess(): string | null {
  const doc: unknown = readConfig();
  const fail = (why: string): string => {
    console.log(`→ error: ${why}; slash access NOT configured (residents can run /model)`);
    return why;
  };
  if (!isMapping(doc)) return fail("the top level of config.yaml is not a mapping");

  const section = (parent: Record<string, unknown>, name: string, path: string): Record<string, unknown> | string => {
    const value = parent[name] ?? {};
    if (!isMapping(value)) return `${path} is not a mapping`;
    if ("<<" in value) return `YAML merge key "<<" under ${path}`;
    return value;
  };
  const rawPlatforms = section(doc, "platforms", "platforms");
  if (typeof rawPlatforms === "string") return fail(rawPlatforms);
  const rawTelegram = section(rawPlatforms, "telegram", "platforms.telegram");
  if (typeof rawTelegram === "string") return fail(rawTelegram);
  const rawExtra = section(rawTelegram, "extra", "platforms.telegram.extra");
  if (typeof rawExtra === "string") return fail(rawExtra);

  const before = JSON.stringify(doc);
  const removed: string[] = [];
  // A competing block (and its `extra`): delete our four keys. A non-mapping block or `extra` is
  // ignored by Hermes, so it is left alone; a merge key could hide one of the keys, so it fails.
  const strip = (block: unknown, path: string): string | null => {
    if (!isMapping(block)) return null;
    if ("<<" in block) return `YAML merge key "<<" under ${path}`;
    for (const key of SLASH_ACCESS_KEYS) {
      if (key in block) {
        delete block[key];
        removed.push(`${path}.${key}`);
      }
    }
    return null;
  };
  const gateway = doc.gateway;
  const gatewayPlatforms = isMapping(gateway) ? gateway.platforms : undefined;
  const competing: Array<[unknown, string]> = [
    [doc.telegram, "telegram"],
    [isMapping(gateway) ? gateway.telegram : undefined, "gateway.telegram"],
    [isMapping(gatewayPlatforms) ? gatewayPlatforms.telegram : undefined, "gateway.platforms.telegram"],
  ];
  for (const [block, path] of competing) {
    const why = strip(block, path) ?? (isMapping(block) ? strip(block.extra, `${path}.extra`) : null);
    if (why) return fail(why);
  }

  const want = slashAccessKeys();
  const telegram: Record<string, unknown> = { ...rawTelegram, extra: { ...rawExtra, ...want } };
  for (const key of SLASH_ACCESS_KEYS) if (key in rawTelegram) telegram[key] = want[key];
  doc.platforms = { ...rawPlatforms, telegram };
  if (JSON.stringify(doc) !== before) writeConfig(doc);
  for (const path of removed) console.log(`→ slash access: removed ${path} (Hermes would read it over platforms.telegram)`);
  console.log(`→ slash access: residents may run ${RESIDENT_SLASH_COMMANDS.length} commands; /model and config commands are admin-only`);
  return null;
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

/** A number written as a string that Python's float() reads (Hermes's `_knob`, run_turn.py:657-665). */
const NUMERIC_STRING = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Pin the compaction settings behind the deferred-compression notice loop (RC28):
 *
 * 1. `compression.hygiene_max_turn_hold_seconds: 25` (see
 *    `HYGIENE_MAX_TURN_HOLD_SECONDS`). Absent, null, not a number Hermes reads
 *    (a boolean, which Hermes's float() reads as 1, a list, a word) or below 25:
 *    set to 25. A number of 25 or more is an operator's longer hold, left as
 *    is, and so is a number written as a string (`"45"`), which Hermes's float()
 *    reads the same way (refute N3); one below 25 is set to 25. `compression`
 *    absent or null is created; `compression` not a mapping, or holding a YAML
 *    merge key, is left alone with a warning.
 * 2. `auxiliary.compression.reasoning_effort: none`, so the summary runs with
 *    reasoning off. Hermes folds this key into the summary request on any route,
 *    the default `provider: auto` included (agent/auxiliary_client.py:6242-6270
 *    `_get_task_extra_body`, then :6615-6622 into `reasoning_config`), and
 *    strips it only when the block names an explicit provider and model that the
 *    call did not use (:6178-6195, `_compression_config_claims_fast_lane` is
 *    false for `auto`). So no explicit route is written: the summary keeps
 *    running on the box's main provider and model, and an explicit route an
 *    operator set is left alone (this step only adds the key). Written when
 *    absent, null or empty (Hermes's own block writes `""`, the provider's
 *    default); any other value is kept. `auxiliary` or `auxiliary.compression`
 *    not a mapping, or holding a merge key, is left alone with a warning. A
 *    model that cannot turn reasoning off is stepped up to its lowest level by
 *    Hermes (agent/auxiliary_reasoning_floor.py), not broken.
 *
 * Not here: hiding Hermes's warning notices on Telegram
 * (`display.platforms.telegram.suppress_warning_notifications`). The switch also
 * hides failures a resident must act on (a dropped message, an aborted turn, a
 * failed upload, cron failures), so rc28 drops it (the lead, Oct 9) and never
 * touches the key; DATA-409's chat half stays open upstream.
 *
 * Each pin is independent: one that cannot be written is skipped with a
 * `→ warning:` line and the other still applies. The whole step is skipped when
 * the top level of config.yaml is not a mapping or holds a YAML merge key, for
 * the reason `keepTelegramBacklogOnColdBoot` gives. One `→` line per pin; a
 * config value is never echoed onto stdout (only its type, or a number).
 * Idempotent: a second run changes nothing, says so, and does not rewrite the
 * file.
 */
export function setCompactionSettings(): void {
  const holdPath = "compression.hygiene_max_turn_hold_seconds";
  const effortPath = "auxiliary.compression.reasoning_effort";
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
    const fromString = typeof raw === "string" && NUMERIC_STRING.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
    const stringNumber = Number.isFinite(fromString);
    if (number && raw >= HYGIENE_MAX_TURN_HOLD_SECONDS) {
      lines.push(`→ ${holdPath} already ${raw} (at least ${HYGIENE_MAX_TURN_HOLD_SECONDS}); left as is`);
    } else if (stringNumber && fromString >= HYGIENE_MAX_TURN_HOLD_SECONDS) {
      lines.push(`→ ${holdPath} already ${fromString}, written as a string Hermes reads as a number (at least ${HYGIENE_MAX_TURN_HOLD_SECONDS}); left as is`);
    } else {
      const why =
        raw === undefined ? "was unset"
        : raw === null ? "was null"
        : number ? `was ${raw}, below ${HYGIENE_MAX_TURN_HOLD_SECONDS}`
        : stringNumber ? `was ${fromString} written as a string, below ${HYGIENE_MAX_TURN_HOLD_SECONDS}`
        : `was ${kindOf(raw)}, not a number`;
      doc.compression = { ...compression, hygiene_max_turn_hold_seconds: HYGIENE_MAX_TURN_HOLD_SECONDS };
      changed = true;
      lines.push(`→ set ${holdPath}: ${HYGIENE_MAX_TURN_HOLD_SECONDS} (${why}; a summary that lands inside the hold is adopted with no notice)`);
    }
  }

  // 2. The summary with reasoning off, on whatever route the box already uses.
  const auxiliary = section(doc, "auxiliary", "auxiliary");
  const route = typeof auxiliary === "string" ? auxiliary : section(auxiliary, "compression", "auxiliary.compression");
  if (typeof auxiliary === "string" || typeof route === "string") {
    lines.push(`→ warning: ${typeof auxiliary === "string" ? auxiliary : route}; left ${effortPath} unset`);
  } else {
    const raw = route.reasoning_effort;
    if (raw === undefined || raw === null || (typeof raw === "string" && !raw.trim())) {
      doc.auxiliary = { ...auxiliary, compression: { ...route, reasoning_effort: "none" } };
      changed = true;
      lines.push(`→ set ${effortPath}: none (the summary runs on the box's main model with reasoning off)`);
    } else {
      lines.push(`→ ${effortPath} already set; left as is`);
    }
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

const AV_APPROVAL_PLUGIN = "av-approval";

/**
 * List `av-approval` on every tenant, whatever `AV_APPROVAL_ENABLED` says.
 *
 * The plugin carries two halves. Credential custody (`_custody.py`: the
 * service keys out of every child the agent's code runs in) must run on every
 * box, so the plugin must load on every box. The gate's backstop does nothing
 * unless the switch is on (`register` returns before registering any hook when
 * it is unset or off), so listing it here blocks no tool on a box without the
 * gate. The approval step lists it too; the kill switch keeps it listed. An
 * `av-approval` entry in `plugins.disabled` is left alone and logged.
 * Idempotent; every other entry keeps its place.
 */
export function configureAvApproval(): void {
  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = Array.isArray(plugins.enabled)
    ? (plugins.enabled as unknown[]).filter((n) => typeof n === "string") as string[]
    : [];
  if (!enabled.includes(AV_APPROVAL_PLUGIN)) enabled.push(AV_APPROVAL_PLUGIN);
  plugins.enabled = enabled;
  // SEC-1 (S3): Hermes's plugins.disabled outranks plugins.enabled, so an earlier Disable would keep
  // custody off through every upgrade. Remove exact av-approval entries; keep every other entry.
  const wasDisabled = Array.isArray(plugins.disabled) && (plugins.disabled as unknown[]).includes(AV_APPROVAL_PLUGIN);
  if (Array.isArray(plugins.disabled)) plugins.disabled = (plugins.disabled as unknown[]).filter((n) => n !== AV_APPROVAL_PLUGIN);
  doc.plugins = plugins;
  writeConfig(doc);
  console.log(`→ enabled plugin ${AV_APPROVAL_PLUGIN} (credential custody; the gate half follows AV_APPROVAL_ENABLED)`);
  if (wasDisabled) {
    console.log(`→ removed ${AV_APPROVAL_PLUGIN} from plugins.disabled (custody must run on every box)`);
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

/**
 * Drop each of `names` from `plugins.enabled` (install.ts passes `NOT_STAGED_PLUGINS`), so a box
 * whose config an earlier installer wrote is healed (OV-300 M1: `village-bridge`). Writes only when
 * an entry is removed; every other entry, `plugins.disabled` included, is left as it is. The names
 * removed, for the log line.
 */
export function unlistPlugins(names: Iterable<string>): string[] {
  const doc = readConfig();
  const plugins = doc.plugins;
  if (!plugins || typeof plugins !== "object" || Array.isArray(plugins)) return [];
  const enabled = (plugins as Record<string, unknown>).enabled;
  if (!Array.isArray(enabled)) return [];
  const drop = new Set(names);
  const removed = [...new Set(enabled.filter((n): n is string => typeof n === "string" && drop.has(n)))];
  if (removed.length === 0) return [];
  doc.plugins = { ...(plugins as Record<string, unknown>), enabled: enabled.filter((n) => !(typeof n === "string" && drop.has(n))) };
  writeConfig(doc);
  return removed;
}
