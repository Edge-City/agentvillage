import { readConfig, writeConfig } from "./config";

/** VOTE CALLBACK (rc42): the plugin that records a referendum vote card tap in the chat. */
export const AV_VOTE_PLUGIN = "av-vote";

/**
 * List `av-vote` in `plugins.enabled` so Hermes loads it (plugins are opt-in
 * at v2026.9.24: hermes_cli/plugins.py, `_get_enabled_plugins`). The plugin
 * directory itself is staged with every other one under `plugins/`. Same rules
 * as `configureAvDisplay`: written only when the name is missing, so a second
 * run does not rewrite the file; a `plugins.disabled` entry is the rollback
 * switch, kept with a warning that Hermes will not load the plugin (the vote
 * card's web row still works); left alone, with a warning, when the top level
 * of config.yaml, `plugins` or `plugins.enabled` has an unusable shape.
 */
export function configureAvVote(): void {
  const doc: unknown = readConfig();
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isMapping(doc)) {
    console.log(`→ warning: the top level of config.yaml is not a mapping; ${AV_VOTE_PLUGIN} not enabled`);
    return;
  }
  const rawPlugins = doc.plugins ?? {};
  if (!isMapping(rawPlugins)) {
    console.log(`→ warning: plugins in config.yaml is not a mapping; ${AV_VOTE_PLUGIN} not enabled`);
    return;
  }
  const rawEnabled = rawPlugins.enabled ?? [];
  if (!Array.isArray(rawEnabled)) {
    console.log(`→ warning: plugins.enabled is not a list; ${AV_VOTE_PLUGIN} not enabled`);
    return;
  }
  if (rawEnabled.includes(AV_VOTE_PLUGIN)) {
    console.log(`→ plugin ${AV_VOTE_PLUGIN} already enabled`);
  } else {
    doc.plugins = { ...rawPlugins, enabled: [...rawEnabled, AV_VOTE_PLUGIN] };
    writeConfig(doc);
    console.log(`→ enabled plugin ${AV_VOTE_PLUGIN} (a vote card tap is recorded in the chat)`);
  }
  if (Array.isArray(rawPlugins.disabled) && rawPlugins.disabled.includes(AV_VOTE_PLUGIN)) {
    console.log(`→ warning: ${AV_VOTE_PLUGIN} is in plugins.disabled; Hermes will not load it`);
  }
}
