/**
 * What a resident sees on Telegram while their agent works (DATA-318).
 *
 * Hermes resolves each gateway display setting per platform, first non-null
 * wins: `display.platforms.<platform>.<key>`, then `display.<key>`, then its
 * built-in tier for the platform, then a global default
 * (`gateway/display_config.py`, v2026.9.24). The gateway reads only
 * `$HERMES_HOME/config.yaml` (no merge of Hermes's built-in defaults). Hermes's
 * config template, `cli-config.yaml.example`, which its installer copies to
 * seed that file, sets the global keys (`show_reasoning: true`,
 * `tool_progress: all`, `interim_assistant_messages: true`); the fleet's files
 * also carry `display.platforms.telegram.streaming: true` from Hermes's
 * built-in defaults (`hermes_cli/config_defaults.py`). Those outrank the
 * quieter Telegram tier. So a resident saw the model's last reasoning block
 * above every reply, a progress line per tool call, and mid-turn commentary as
 * separate messages.
 *
 * The owner's decisions: residents never see reasoning. Tool progress (Carter,
 * Oct 9, RC28): the progress bubble is back for everyone as `tool_progress:
 * new`, one quiet message edited in place and deleted with the reply (the
 * grouping and cleanup keys below; its lines carry Hermes's 40-char tool
 * preview, accepted). The string has to be written: Hermes's Telegram tier
 * default for `tool_progress` is `off` (display_config.py:53,
 * `_PLATFORM_DEFAULTS`), so an unset key does not bring the bubble back. Each
 * resident can switch it with Hermes's `/verbose`
 * (gateway/slash_commands.py:961-986: it cycles off → new → all → verbose → log
 * for the current platform and saves the string to
 * `display.platforms.telegram.tool_progress`), which this step enables with
 * `display.tool_progress_command: true` (default false,
 * hermes_cli/config_defaults.py:901; never enabled on the fleet before RC28,
 * so no resident could have chosen a mode before). Hermes posts its one-time
 * first-time tip after a slow tool (agent/onboarding.py
 * `tool_progress_hint_gateway`); accepted. A written value is "explicit" to
 * Hermes (display_config.py:115-126 `resolve_tool_progress`), which only
 * matters for Slack's native task cards (gateway/run_turn.py:3018-3029: a
 * written `off` turns them off too); on Telegram a written `new` shows the
 * bubble and a written `off` hides it, nothing more. (History: DATA-409, Oct 7,
 * had set `off`.) A turn over 3 minutes also shows Hermes's one
 * "⏳ Working — N min" heartbeat line, whatever `tool_progress` says. This step
 * writes Telegram-scoped keys, plus the one gateway-wide `/verbose` gate, so
 * the CLI and desktop surfaces operators use keep Hermes's display defaults:
 *
 * | key | value | written when |
 * |---|---|---|
 * | `platforms.telegram.show_reasoning` | `false` | always (a privacy and product decision; a resident's `/reasoning show` is undone on the next roll) |
 * | `platforms.telegram.tool_progress` | `new` | unset (absent or null) and no legacy `display.tool_progress_overrides.telegram`; any other value is kept, `off` and `false` included (rc29; see below) |
 * | `platforms.telegram.tool_progress_grouping` | `accumulate` | unset |
 * | `platforms.telegram.interim_assistant_messages` | `false` | unset |
 * | `platforms.telegram.streaming` | `false` | unset, or `true` (the value Hermes itself writes there) |
 * | `platforms.telegram.cleanup_progress` | `true` | unset |
 * | `tool_progress_command` (under `display`) | `true` | unset (absent or null); any other value is kept |
 *
 * rc29 (DATA-434): an `off` or a `false` in `tool_progress` is a resident's
 * `/verbose` choice and is kept; only an absent or null value gets `new`.
 * (History: rc28 treated both as unset, to undo DATA-409's own `off`, which
 * the YAML 1.2 writer had left bare and Hermes's PyYAML had re-saved as
 * `false` on 10 of 10 boxes.) Since rc29 `writeConfig` (`dumpConfig`)
 * double-quotes every string YAML 1.1 reads as another type, so Hermes's
 * PyYAML (utils.py `fast_safe_load`, hermes_cli/config.py:436) reads a saved
 * `off` back as the string through any installer rewrite and any later Hermes
 * save. Hermes resolves `off` and `false` alike (display_config.py:135-146
 * `_norm_tristate`): the bubble is hidden.
 *
 * Together: one tool-progress message per reply, edited in place at most every
 * 1.5 s with a line per tool, deleted once the reply lands (kept when the turn
 * fails); the reply arrives as one message. Streaming and interim commentary
 * are off because each streamed or commentary message would otherwise arrive
 * as its own message before the reply.
 *
 * A value someone set by hand is kept (except `show_reasoning`). A resident who
 * sets `streaming: true` by hand cannot be told from the default that was
 * written there and is reset on the next roll. `AV_DISPLAY_DEFAULTS=0` (or `false`, `no`, `off`),
 * in the process environment or `$HERMES_HOME/.env`, leaves `config.yaml`
 * untouched. The file is also left alone, with a warning, when `display`,
 * `display.platforms` or `display.platforms.telegram` is not a mapping or holds
 * a YAML merge key (`<<`), for the reason `keepTelegramBacklogOnColdBoot`
 * gives. Idempotent: when nothing changes the file is not rewritten.
 */
import { envOrDotenv, readConfig, writeConfig } from "./config";

/** Operator override: an "off" spelling leaves `config.yaml` untouched. */
export const DISPLAY_DEFAULTS_ENV = "AV_DISPLAY_DEFAULTS";
/** Spellings of "off", case-folded and trimmed, as `AV_EVENTS_ENABLED` accepts them. */
const DISABLED_VALUES = new Set(["0", "false", "no", "off"]);

type DisplayValue = boolean | string;

interface ManagedKey {
  key: string;
  value: DisplayValue;
  /** `always`: written whenever it differs. `unset`: only while absent, null, or one of `hermesDefaults`. */
  policy: "always" | "unset";
  /** Values that count as unset besides absent and null: what Hermes itself writes at this path. */
  hermesDefaults?: readonly unknown[];
}

/** The keys this step owns under `display.platforms.telegram`, in the order they are written. */
export const TELEGRAM_DISPLAY_DEFAULTS: readonly ManagedKey[] = [
  { key: "show_reasoning", value: false, policy: "always" },
  // RC28: the bubble is back (`new`). rc29 (DATA-434): nothing but absent or null counts as unset, so a
  // resident's /verbose `off` (or the `false` an older Hermes save left) is kept.
  { key: "tool_progress", value: "new", policy: "unset", hermesDefaults: [] },
  { key: "tool_progress_grouping", value: "accumulate", policy: "unset" },
  { key: "interim_assistant_messages", value: false, policy: "unset" },
  { key: "streaming", value: false, policy: "unset", hermesDefaults: [true] },
  { key: "cleanup_progress", value: true, policy: "unset" },
];

/** The key this step owns directly under `display`: the gate on Hermes's /verbose (RC28). */
export const DISPLAY_LEVEL_DEFAULTS: readonly ManagedKey[] = [
  { key: "tool_progress_command", value: true, policy: "unset" },
];

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function overrideOff(): boolean {
  let raw: string | undefined;
  try {
    raw = envOrDotenv(DISPLAY_DEFAULTS_ENV);
  } catch {
    console.log(`→ warning: could not read ${DISPLAY_DEFAULTS_ENV} from $HERMES_HOME/.env; applying the Telegram display settings`);
    return false;
  }
  return DISABLED_VALUES.has((raw ?? "").trim().toLowerCase());
}

/**
 * Apply the Telegram display settings above to `$HERMES_HOME/config.yaml`.
 * Returns the keys it wrote (empty when it changed nothing or was switched off).
 */
export function configureTelegramDisplay(): string[] {
  if (overrideOff()) {
    console.log(`→ telegram display: left untouched (${DISPLAY_DEFAULTS_ENV} is off)`);
    return [];
  }
  const doc: unknown = readConfig();
  const skip = (why: string): string[] => {
    console.log(`→ warning: ${why}; left the Telegram display settings unset`);
    return [];
  };
  if (!isMapping(doc)) return skip("the top level of config.yaml is not a mapping");

  // Each level may be absent or null (treated as empty); anything else must be a plain mapping.
  const section = (parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | string => {
    const value = parent[key] ?? {};
    if (!isMapping(value)) return `${path} is not a mapping`;
    if ("<<" in value) return `YAML merge key "<<" under ${path}; set it by hand if wanted`;
    return value;
  };
  const display = section(doc, "display", "display");
  if (typeof display === "string") return skip(display);
  const platforms = section(display, "platforms", "display.platforms");
  if (typeof platforms === "string") return skip(platforms);
  const telegram = section(platforms, "telegram", "display.platforms.telegram");
  if (typeof telegram === "string") return skip(telegram);

  // Hermes still honours the deprecated per-platform map as a tool_progress fallback.
  const legacy = display.tool_progress_overrides;
  const legacyToolProgress = isMapping(legacy) && legacy.telegram !== undefined && legacy.telegram !== null;

  const written: string[] = [];
  const kept: string[] = [];
  const apply = (block: Record<string, unknown>, keys: readonly ManagedKey[]): Record<string, unknown> => {
    const next = { ...block };
    for (const { key, value, policy, hermesDefaults } of keys) {
      const current = block[key];
      if (current === value) continue;
      const unset = current === undefined || current === null || (hermesDefaults ?? []).includes(current);
      const handSet = !unset || (key === "tool_progress" && legacyToolProgress);
      if (policy === "unset" && handSet) {
        kept.push(key);
        continue;
      }
      next[key] = value;
      written.push(`${key}=${value}`);
    }
    return next;
  };
  const nextTelegram = apply(telegram, TELEGRAM_DISPLAY_DEFAULTS);
  const telegramChanged = written.length > 0;
  const nextDisplay = apply(display, DISPLAY_LEVEL_DEFAULTS);

  const keptNote = kept.length ? ` (kept as set by hand: ${kept.join(", ")})` : "";
  if (written.length === 0) {
    console.log(`→ telegram display settings already in place${keptNote}`);
    return [];
  }
  // Existing keys keep their place (a spread); a new `platforms` lands before a new gate key.
  const out: Record<string, unknown> = { ...display };
  if (telegramChanged) out.platforms = { ...platforms, telegram: nextTelegram };
  for (const { key } of DISPLAY_LEVEL_DEFAULTS) out[key] = nextDisplay[key];
  doc.display = out;
  writeConfig(doc);
  console.log(`→ telegram display: ${written.join(", ")}${keptNote}`);
  return written.map((entry) => entry.slice(0, entry.indexOf("=")));
}
