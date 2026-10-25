import { readConfig, writeConfig } from "./config";

/** The suggestion rating cards plugin (data docs/design/suggestion-rating.md; plugins/av-rate). */
export const AV_RATE_PLUGIN = "av-rate";

/**
 * List `av-rate` in `plugins.enabled` (plugins are opt-in at v2026.9.24) and allow it to inject the
 * `[Rating recorded]` line into the resident's session: Hermes gates `ctx.inject_message` on
 * `plugins.entries.<plugin>.allow_gateway_injection` being exactly `true`
 * (hermes_cli/plugins.py `_gateway_injection_allowed`). Same rules as `configureAvVote`: written
 * only when something is missing, so a second run does not rewrite the file; `plugins.disabled` is
 * the rollback switch, kept with a warning; an unusable shape is left alone with a warning. The
 * cards themselves stay off until `AV_RATE_CARDS` is on in the box's `.env`.
 */
export function configureAvRate(): void {
  const doc: unknown = readConfig();
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; ${AV_RATE_PLUGIN} not enabled`);
    return;
  }
  const rawPlugins = doc.plugins ?? {};
  if (!isMapping(rawPlugins)) {
    console.log(`→ warning: plugins in config.yaml is not a mapping; ${AV_RATE_PLUGIN} not enabled`);
    return;
  }
  const rawEnabled = rawPlugins.enabled ?? [];
  if (!Array.isArray(rawEnabled)) {
    console.log(`→ warning: plugins.enabled is not a list; ${AV_RATE_PLUGIN} not enabled`);
    return;
  }
  const rawEntries = rawPlugins.entries ?? {};
  if (!isMapping(rawEntries)) {
    console.log(`→ warning: plugins.entries is not a mapping; ${AV_RATE_PLUGIN} not enabled`);
    return;
  }
  const rawEntry = rawEntries[AV_RATE_PLUGIN] ?? {};
  if (!isMapping(rawEntry)) {
    console.log(`→ warning: plugins.entries.${AV_RATE_PLUGIN} is not a mapping; ${AV_RATE_PLUGIN} not enabled`);
    return;
  }
  const enabledAlready = rawEnabled.includes(AV_RATE_PLUGIN);
  const injectionAlready = rawEntry.allow_gateway_injection === true;
  if (enabledAlready && injectionAlready) {
    console.log(`→ plugin ${AV_RATE_PLUGIN} already enabled`);
  } else {
    doc.plugins = {
      ...rawPlugins,
      enabled: enabledAlready ? rawEnabled : [...rawEnabled, AV_RATE_PLUGIN],
      entries: { ...rawEntries, [AV_RATE_PLUGIN]: { ...rawEntry, allow_gateway_injection: true } },
    };
    writeConfig(doc);
    console.log(`→ enabled plugin ${AV_RATE_PLUGIN} (suggestion rating cards; the recorded rating is handed to the agent)`);
  }
  if (Array.isArray(rawPlugins.disabled) && rawPlugins.disabled.includes(AV_RATE_PLUGIN)) {
    console.log(`→ warning: ${AV_RATE_PLUGIN} is in plugins.disabled; Hermes will not load it`);
  }
}
