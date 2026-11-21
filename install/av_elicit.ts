import { envOrDotenv, readConfig, writeConfig } from "./config";

/**
 * GC-ELICIT (contract v1, sections 3a-3c): the plugin that injects the control plane's staged
 * notices (`$HERMES_HOME/av-events/elicit/inject/*.txt`) into the resident's Telegram DM session,
 * writes `probe.json`, and carries the agent's `elicitation_record` tool (plugins/av-elicit).
 */
export const AV_ELICIT_PLUGIN = "av-elicit";

/** The per-tenant opt-in, written into the box's `.env` by the control plane. */
export const AV_ELICIT_ENV = "AV_ELICIT_ENABLED";

/**
 * The built-in memory store's cap the agent's private gap list needs (contract 3a; Hermes's
 * default, and the fleet's, is 2200: hermes_cli/config_defaults.py, tools/memory_tool.py).
 */
export const ELICIT_MEMORY_CHAR_LIMIT = 8000;

/** The only values that turn the flag on (the same set as `AV_RECALL_ENABLED`). */
const TRUTHY = new Set(["1", "true", "yes", "on"]);

export type AvElicitResult = "skipped" | "enabled" | "kept" | "disabled" | "unchanged" | "refused";

const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `true` for `1|true|yes|on` (any case), `null` when unset or blank, `false` for any other value. */
export function avElicitChoice(): boolean | null {
  const raw = envOrDotenv(AV_ELICIT_ENV)?.trim().toLowerCase();
  if (!raw) return null;
  return TRUTHY.has(raw);
}

/**
 * The value Hermes would use for `memory.memory_char_limit` (it calls `int()` on it), or `null`
 * when it is unset or something Hermes could not read as a number.
 */
function memoryLimit(raw: unknown): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return Math.trunc(raw);
  if (typeof raw === "string" && /^\s*[+-]?\d+\s*$/.test(raw)) return Number.parseInt(raw, 10);
  return null;
}

/**
 * Opt-in, like recall (`AV_RECALL_ENABLED`): the control plane writes `AV_ELICIT_ENABLED=1` into a
 * tenant's `.env` for the tenants it elicits (its `GODCONST_ELICIT_TENANTS` gate), read from the
 * environment first, else `$HERMES_HOME/.env` (`envOrDotenv`).
 *
 * - unset or blank: nothing is read or written, so a box without the flag is unchanged;
 * - on (`1|true|yes|on`): `av-elicit` is listed in `plugins.enabled` (plugins are opt-in at
 *   v2026.9.24), `plugins.entries.av-elicit.allow_gateway_injection: true` is set (Hermes gates
 *   `ctx.inject_message` on that value being exactly `true`: hermes_cli/plugins.py
 *   `_gateway_injection_allowed`), and `memory.memory_char_limit` is raised to 8000 when it is
 *   unset, unreadable or lower; a higher value is kept. Every other key is kept;
 * - any other value (off): `av-elicit` leaves `plugins.enabled` and its `allow_gateway_injection`
 *   key is removed. The memory cap is left as it is: lowering it could cut what the agent saved.
 *
 * Writes only on a change, so a second run does not rewrite the file. A `plugins.disabled` entry is
 * kept, with a warning that Hermes will not load the plugin. An unusable shape (the top level,
 * `plugins`, `plugins.enabled`, `plugins.entries` or its av-elicit entry, or `memory` not of the
 * expected type, or a YAML merge key `<<` in `memory`) leaves the whole file alone with a warning.
 * No config value is echoed onto stdout. The plugin directory is staged with every other one under
 * `plugins/` (`stagePlugins`); the control plane writes the brief skill
 * (`skills/odin-constitution/`; `skills/constitution-elicitation/` before GC-ELICIT v5) itself, and the installer never copies or removes it.
 */
export function configureAvElicit(): AvElicitResult {
  const choice = avElicitChoice();
  if (choice === null) {
    console.log(`→ skipped plugin ${AV_ELICIT_PLUGIN} (opt-in: ${AV_ELICIT_ENV}=1, set by the control plane)`);
    return "skipped";
  }
  const doc: unknown = readConfig();
  const refuse = (why: string): AvElicitResult => {
    console.log(`→ warning: ${why}; ${AV_ELICIT_PLUGIN} left unconfigured`);
    return "refused";
  };
  if (!isMapping(doc)) return refuse("the top level of config.yaml is not a mapping");
  const plugins = doc.plugins ?? {};
  if (!isMapping(plugins)) return refuse("plugins in config.yaml is not a mapping");
  const enabled = plugins.enabled ?? [];
  if (!Array.isArray(enabled)) return refuse("plugins.enabled is not a list");
  const entries = plugins.entries ?? {};
  if (!isMapping(entries)) return refuse("plugins.entries is not a mapping");
  const entry = entries[AV_ELICIT_PLUGIN] ?? {};
  if (!isMapping(entry)) return refuse(`plugins.entries.${AV_ELICIT_PLUGIN} is not a mapping`);
  const memory = doc.memory ?? {};
  if (!isMapping(memory)) return refuse("memory in config.yaml is not a mapping");
  if ("<<" in memory) return refuse(`YAML merge key "<<" under memory`);

  const listed = enabled.includes(AV_ELICIT_PLUGIN);
  const disabledWarning = (): void => {
    if (Array.isArray(plugins.disabled) && plugins.disabled.includes(AV_ELICIT_PLUGIN)) {
      console.log(`→ warning: ${AV_ELICIT_PLUGIN} is in plugins.disabled; Hermes will not load it`);
    }
  };

  if (!choice) {
    const hasKey = "allow_gateway_injection" in entry;
    if (!listed && !hasKey) {
      console.log(`→ plugin ${AV_ELICIT_PLUGIN} not enabled (${AV_ELICIT_ENV} off)`);
      return "unchanged";
    }
    const { allow_gateway_injection: _dropped, ...rest } = entry;
    const nextEntries = { ...entries };
    if (Object.keys(rest).length > 0) nextEntries[AV_ELICIT_PLUGIN] = rest;
    else delete nextEntries[AV_ELICIT_PLUGIN];
    const nextPlugins: Record<string, unknown> = { ...plugins, enabled: enabled.filter((n) => n !== AV_ELICIT_PLUGIN) };
    if (Object.keys(nextEntries).length > 0) nextPlugins.entries = nextEntries;
    else delete nextPlugins.entries;
    doc.plugins = nextPlugins;
    writeConfig(doc);
    console.log(`→ disabled plugin ${AV_ELICIT_PLUGIN} (${AV_ELICIT_ENV} off; memory.memory_char_limit left as is)`);
    return "disabled";
  }

  const injecting = entry.allow_gateway_injection === true;
  const limit = memoryLimit(memory.memory_char_limit);
  const raiseMemory = limit === null || limit < ELICIT_MEMORY_CHAR_LIMIT;
  if (listed && injecting && !raiseMemory) {
    console.log(`→ plugin ${AV_ELICIT_PLUGIN} already enabled (injection allowed, memory.memory_char_limit at least ${ELICIT_MEMORY_CHAR_LIMIT})`);
    disabledWarning();
    return "kept";
  }
  doc.plugins = {
    ...plugins,
    enabled: listed ? enabled : [...enabled, AV_ELICIT_PLUGIN],
    entries: { ...entries, [AV_ELICIT_PLUGIN]: { ...entry, allow_gateway_injection: true } },
  };
  if (raiseMemory) doc.memory = { ...memory, memory_char_limit: ELICIT_MEMORY_CHAR_LIMIT };
  writeConfig(doc);
  console.log(
    `→ enabled plugin ${AV_ELICIT_PLUGIN} (GODCONST follow-up questions; staged notices injected into the DM session)`
    + (raiseMemory ? `; set memory.memory_char_limit: ${ELICIT_MEMORY_CHAR_LIMIT}` : ""),
  );
  disabledWarning();
  return "enabled";
}

/** `configureAvElicit`, but a failure is logged and never stops the install. */
export function safeConfigureAvElicit(): boolean {
  try {
    configureAvElicit();
    return true;
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err;
    console.warn(`  warning: ${AV_ELICIT_PLUGIN} step failed (${kind}); core install continues`);
    return false;
  }
}
