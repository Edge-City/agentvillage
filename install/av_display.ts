import { readConfig, writeConfig } from "./config";

/** The plugin that makes Telegram tool-progress lines name the tool, never the command (RC28). */
export const AV_DISPLAY_PLUGIN = "av-display";

/**
 * List `av-display` in `plugins.enabled` so Hermes loads it (plugins are opt-in
 * at v2026.9.24: hermes_cli/plugins.py, `_get_enabled_plugins`). The plugin
 * directory itself is staged with every other one under `plugins/`. Written
 * only when the name is missing, so a second run does not rewrite the file. A
 * `plugins.disabled` entry is the rollback switch: it is kept, with a warning
 * that Hermes will not load the plugin. Left alone, with a warning, when the
 * top level of config.yaml, `plugins` or `plugins.enabled` has an unusable shape.
 */
export function configureAvDisplay(): void {
  const doc: unknown = readConfig();
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; ${AV_DISPLAY_PLUGIN} not enabled`);
    return;
  }
  const rawPlugins = doc.plugins ?? {};
  if (!isMapping(rawPlugins)) {
    console.log(`→ warning: plugins in config.yaml is not a mapping; ${AV_DISPLAY_PLUGIN} not enabled`);
    return;
  }
  const rawEnabled = rawPlugins.enabled ?? [];
  if (!Array.isArray(rawEnabled)) {
    console.log(`→ warning: plugins.enabled is not a list; ${AV_DISPLAY_PLUGIN} not enabled`);
    return;
  }
  if (rawEnabled.includes(AV_DISPLAY_PLUGIN)) {
    console.log(`→ plugin ${AV_DISPLAY_PLUGIN} already enabled`);
  } else {
    doc.plugins = { ...rawPlugins, enabled: [...rawEnabled, AV_DISPLAY_PLUGIN] };
    writeConfig(doc);
    console.log(`→ enabled plugin ${AV_DISPLAY_PLUGIN} (Telegram progress lines name the tool, not the command)`);
  }
  if (Array.isArray(rawPlugins.disabled) && rawPlugins.disabled.includes(AV_DISPLAY_PLUGIN)) {
    console.log(`→ warning: ${AV_DISPLAY_PLUGIN} is in plugins.disabled; Hermes will not load it`);
  }
}
