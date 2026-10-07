/**
 * What a resident sees on Telegram while their agent works (DATA-318).
 *
 * Hermes resolves each gateway display setting per platform, first non-null
 * wins: `display.platforms.<platform>.<key>`, then `display.<key>`, then its
 * built-in tier for the platform (`gateway/display_config.py`, v2026.9.24).
 * The gateway reads only `$HERMES_HOME/config.yaml` (no merge of Hermes's
 * built-in defaults). Hermes's config template, `cli-config.yaml.example`,
 * which its installer copies to seed that file, sets the global keys
 * (`show_reasoning: true`, `tool_progress: all`,
 * `interim_assistant_messages: true`); the fleet's files also carry
 * `display.platforms.telegram.streaming: true` from Hermes's built-in defaults
 * (`hermes_cli/config_defaults.py`). Those outrank the quieter Telegram tier. So a resident saw the model's last reasoning block above every
 * reply, a progress line per tool call, and mid-turn commentary as separate
 * messages.
 *
 * The owner's decision: residents never see reasoning, and (DATA-409, after a
 * tester watched 38 seconds of raw curl and python command previews) see no
 * progress message at all while the agent works: `tool_progress: off`, Hermes's
 * own Telegram tier default. The grouping and cleanup keys stay as written so a
 * resident who turns progress back on by hand still gets one quiet, edited
 * message. This step writes Telegram-scoped keys only, so the CLI and desktop
 * surfaces operators use keep Hermes's defaults:
 *
 * | key | value | written when |
 * |---|---|---|
 * | `show_reasoning` | `false` | always (a privacy and product decision; a resident's `/reasoning show` is undone on the next roll) |
 * | `tool_progress` | `off` | unset (absent or null), or `new` (this installer's value until DATA-409), and no legacy `display.tool_progress_overrides.telegram` |
 * | `tool_progress_grouping` | `accumulate` | unset |
 * | `interim_assistant_messages` | `false` | unset |
 * | `streaming` | `false` | unset, or `true` (the value Hermes itself writes there) |
 * | `cleanup_progress` | `true` | unset |
 *
 * Together: no progress message; the reply arrives as one message. (With
 * progress turned on by hand: one message, edited in place at most every 1.5 s
 * with a line per tool, deleted once the reply lands, kept when the turn fails.)
 * Streaming and interim commentary are off because each streamed or commentary
 * message would otherwise arrive as its own message before the reply.
 *
 * A value someone set by hand is kept (except `show_reasoning`). A resident who
 * sets `streaming: true` or `tool_progress: new` by hand cannot be told from the
 * default that was written there and is reset on the next roll. `AV_DISPLAY_DEFAULTS=0` (or `false`, `no`, `off`),
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
  /** Values Hermes itself writes at this path, which count as unset. */
  hermesDefaults?: readonly unknown[];
}

/** The keys this step owns under `display.platforms.telegram`, in the order they are written. */
export const TELEGRAM_DISPLAY_DEFAULTS: readonly ManagedKey[] = [
  { key: "show_reasoning", value: false, policy: "always" },
  // DATA-409: `new` is the value this installer wrote until 2026-10-07 (DATA-318), so a box still
  // holding it is on the old default, not a hand-set choice, and flips to `off` at its next roll.
  { key: "tool_progress", value: "off", policy: "unset", hermesDefaults: ["new"] },
  { key: "tool_progress_grouping", value: "accumulate", policy: "unset" },
  { key: "interim_assistant_messages", value: false, policy: "unset" },
  { key: "streaming", value: false, policy: "unset", hermesDefaults: [true] },
  { key: "cleanup_progress", value: true, policy: "unset" },
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

  const next = { ...telegram };
  const written: string[] = [];
  const kept: string[] = [];
  for (const { key, value, policy, hermesDefaults } of TELEGRAM_DISPLAY_DEFAULTS) {
    const current = telegram[key];
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

  const keptNote = kept.length ? ` (kept as set by hand: ${kept.join(", ")})` : "";
  if (written.length === 0) {
    console.log(`→ telegram display settings already in place${keptNote}`);
    return [];
  }
  doc.display = { ...display, platforms: { ...platforms, telegram: next } };
  writeConfig(doc);
  console.log(`→ telegram display: ${written.join(", ")}${keptNote}`);
  return written.map((entry) => entry.slice(0, entry.indexOf("=")));
}
