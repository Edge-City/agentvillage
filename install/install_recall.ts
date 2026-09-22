/**
 * Opt-in recall (DATA-83): stage the `recall` skill and enable its plugin only
 * for a tenant with `AV_RECALL_ENABLED=1`.
 *
 * - opted in  → `skills/recall/` is staged into `$HERMES_HOME/skills/recall/`
 *               (without its tests and fixtures) and `recall` is added to
 *               `plugins.enabled`;
 * - opted out (`AV_RECALL_ENABLED=0`) → the plugin is disabled, the staged
 *               skill is removed, and the derived index at
 *               `$HERMES_HOME/.recall/` is deleted. The index only ever holds
 *               copies of text already in the sandbox, so removing it loses
 *               nothing the attendee wrote;
 * - unset     → nothing happens. Recall is never on by default.
 *
 * The plugin code itself is staged for every tenant by `copyPluginFiles()`,
 * like every plugin under `plugins/`; Hermes loads none of them unless they
 * are listed in `plugins.enabled`.
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { configureRecall, recallChoice } from "./config";
import { hermesHome, skillsDir } from "./paths";
import { copyPluginTree } from "./plugin_copy";

export const RECALL_SKILL = "recall";
export const RECALL_INDEX_DIR = ".recall";

export function installRecall(sourceSkills: string): void {
  const choice = recallChoice();
  configureRecall();
  if (choice === null) return;

  const target = join(skillsDir(), RECALL_SKILL);
  if (choice) {
    const source = join(sourceSkills, RECALL_SKILL);
    if (!existsSync(source)) {
      console.warn(`  warning: ${source} missing — recall skill not staged`);
      return;
    }
    // copyPluginTree skips `tests/` (and caches), so fixtures never reach a sandbox.
    const copied = copyPluginTree(source, target);
    console.log(`→ staged ${copied} recall skill files into ${target}`);
    return;
  }

  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`→ removed recall skill from ${target}`);
  }
  removeRecallIndex();
}

/** Delete the derived recall index (and its query-hash key). */
export function removeRecallIndex(): void {
  const index = join(hermesHome(), RECALL_INDEX_DIR);
  if (!existsSync(index)) return;
  rmSync(index, { recursive: true, force: true });
  console.log(`→ removed ${RECALL_INDEX_DIR}/ (derived recall index)`);
}
