import { readConfig, writeConfig } from "./config";

/** GC-TELEGRAM-BALLOT: the plugin that sends the resident's GODCONST ballot as Telegram cards (docs/GODCONST-TELEGRAM-BALLOT.md). */
export const AV_GODCONST_PLUGIN = "av-godconst";

/**
 * List `av-godconst` in `plugins.enabled` so Hermes loads it (plugins are opt-in
 * at v2026.9.24: hermes_cli/plugins.py, `_get_enabled_plugins`). The plugin
 * directory itself is staged with every other one under `plugins/`. Same rules
 * as `configureAvVote`: written only when the name is missing, so a second
 * run does not rewrite the file; a `plugins.disabled` entry is the rollback
 * switch, kept with a warning that Hermes will not load the plugin (the
 * /constitution page still works); left alone, with a warning, when the top level
 * of config.yaml, `plugins` or `plugins.enabled` has an unusable shape.
 */
export function configureAvGodconst(): void {
  const doc: unknown = readConfig();
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; ${AV_GODCONST_PLUGIN} not enabled`);
    return;
  }
  const rawPlugins = doc.plugins ?? {};
  if (!isMapping(rawPlugins)) {
    console.log(`→ warning: plugins in config.yaml is not a mapping; ${AV_GODCONST_PLUGIN} not enabled`);
    return;
  }
  const rawEnabled = rawPlugins.enabled ?? [];
  if (!Array.isArray(rawEnabled)) {
    console.log(`→ warning: plugins.enabled is not a list; ${AV_GODCONST_PLUGIN} not enabled`);
    return;
  }
  if (rawEnabled.includes(AV_GODCONST_PLUGIN)) {
    console.log(`→ plugin ${AV_GODCONST_PLUGIN} already enabled`);
  } else {
    doc.plugins = { ...rawPlugins, enabled: [...rawEnabled, AV_GODCONST_PLUGIN] };
    writeConfig(doc);
    console.log(`→ enabled plugin ${AV_GODCONST_PLUGIN} (the GODCONST ballot as Telegram cards, AV_GODCONST_BALLOT)`);
  }
  if (Array.isArray(rawPlugins.disabled) && rawPlugins.disabled.includes(AV_GODCONST_PLUGIN)) {
    console.log(`→ warning: ${AV_GODCONST_PLUGIN} is in plugins.disabled; Hermes will not load it`);
  }
}
