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

/** The av-display plugin's resident command (plugins/av-display `VILLAGE_COMMAND`, rc44). */
export const VILLAGE_MENU_COMMAND = "village";

/**
 * Keep `/village` in Telegram's command menu (rc44, RESIDENT-UX). Hermes v2026.9.24 builds the
 * menu from its core commands, then plugin commands, then skills, and cuts it at
 * `platforms.telegram.extra.command_menu.max_commands` (default 60;
 * hermes_cli/commands_platforms.py:99-147, 281-297). The 67 core commands fill the 60 slots, so
 * a plugin command never shows unless it is named in `command_menu.priority`, which Hermes
 * ranks before the cap (the default `priority_mode: prepend` puts it first). This step adds
 * `village` to that list: written as `["village"]` when absent or null, appended to a list (or
 * to a single string, which Hermes reads as a one-item list) that lacks it, and nothing when it
 * is there. `max_commands` and `priority_mode` are never touched. Left alone, with a warning,
 * when a level is not a mapping, holds a YAML merge key (`<<`), or `priority` has another type.
 * Typing `/village` works whether or not it is in the menu.
 */
export function configureVillageMenu(): void {
  const doc: unknown = readConfig();
  const isMapping = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  const skip = (why: string): void => console.log(`→ warning: ${why}; /${VILLAGE_MENU_COMMAND} left out of the Telegram menu priority`);
  if (!isMapping(doc)) return skip("the top level of config.yaml is not a mapping");
  const section = (parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> | string => {
    const value = parent[key] ?? {};
    if (!isMapping(value)) return `${path} is not a mapping`;
    if ("<<" in value) return `YAML merge key "<<" under ${path}; set it by hand if wanted`;
    return value;
  };
  const platforms = section(doc, "platforms", "platforms");
  if (typeof platforms === "string") return skip(platforms);
  const telegram = section(platforms, "telegram", "platforms.telegram");
  if (typeof telegram === "string") return skip(telegram);
  const extra = section(telegram, "extra", "platforms.telegram.extra");
  if (typeof extra === "string") return skip(extra);
  const menu = section(extra, "command_menu", "platforms.telegram.extra.command_menu");
  if (typeof menu === "string") return skip(menu);

  const current = menu.priority ?? [];
  let list: unknown[];
  if (Array.isArray(current)) list = current;
  else if (typeof current === "string") list = current.trim() ? [current] : [];
  else return skip("platforms.telegram.extra.command_menu.priority is not a list");
  if (list.includes(VILLAGE_MENU_COMMAND)) {
    console.log(`→ telegram menu: /${VILLAGE_MENU_COMMAND} already in command_menu.priority`);
    return;
  }
  const priority = [...list, VILLAGE_MENU_COMMAND];
  doc.platforms = { ...platforms, telegram: { ...telegram, extra: { ...extra, command_menu: { ...menu, priority } } } };
  writeConfig(doc);
  console.log(`→ telegram menu: added /${VILLAGE_MENU_COMMAND} to platforms.telegram.extra.command_menu.priority`);
}
