import { readConfig, writeConfig } from "./config";

/** The plugin that turns a bare /help into the resident's own question, answered by the agent. */
export const AV_HELP_PLUGIN = "av-help";

/**
 * List `av-help` in `plugins.enabled` so Hermes loads it (plugins are opt-in:
 * hermes_cli/plugins.py `_get_enabled_plugins`). The plugin directory is staged
 * with every other one under `plugins/`. Written only when the name is missing.
 * A `plugins.disabled` entry is the rollback switch: kept, with a warning. Left
 * alone, with a warning, when config.yaml, `plugins` or `plugins.enabled` has an
 * unusable shape. Same behaviour as `configureAvDisplay`.
 */
export function configureAvHelp(): void {
  const doc: unknown = readConfig();
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; ${AV_HELP_PLUGIN} not enabled`);
    return;
  }
  const rawPlugins = doc.plugins ?? {};
  if (!isMapping(rawPlugins)) {
    console.log(`→ warning: plugins in config.yaml is not a mapping; ${AV_HELP_PLUGIN} not enabled`);
    return;
  }
  const rawEnabled = rawPlugins.enabled ?? [];
  if (!Array.isArray(rawEnabled)) {
    console.log(`→ warning: plugins.enabled is not a list; ${AV_HELP_PLUGIN} not enabled`);
    return;
  }
  if (rawEnabled.includes(AV_HELP_PLUGIN)) {
    console.log(`→ plugin ${AV_HELP_PLUGIN} already enabled`);
  } else {
    doc.plugins = { ...rawPlugins, enabled: [...rawEnabled, AV_HELP_PLUGIN] };
    writeConfig(doc);
    console.log(`→ enabled plugin ${AV_HELP_PLUGIN} (a bare /help is answered by the agent, not the command list)`);
  }
  if (Array.isArray(rawPlugins.disabled) && rawPlugins.disabled.includes(AV_HELP_PLUGIN)) {
    console.log(`→ warning: ${AV_HELP_PLUGIN} is in plugins.disabled; Hermes will not load it`);
  }
}
