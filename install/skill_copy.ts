import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { EDGE_SKILL_NAMES, REPLACED_SKILL_DIRS } from "./paths";

/** Recursive copy that overwrites files and keeps anything already at the target. Returns files copied. */
export function copyTree(sourceDir: string, targetDir: string): number {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const targetPath = join(targetDir, entry);
    const stat = statSync(sourcePath);

    if (stat.isDirectory()) {
      copied += copyTree(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
      copied++;
    }
  }
  return copied;
}

/**
 * Stages the repo's skill bundles into `<targetSkillsRoot>/<name>/`.
 *
 * A bundle is merged into what is already there, except the generated
 * directories in `REPLACED_SKILL_DIRS`: those are removed first and copied
 * fresh, so a document deleted upstream also leaves an existing Hermes home.
 * A replaced directory is only removed when the source has it, so a checkout
 * without it never empties a working install.
 */
export function copySkillBundles(
  sourceSkillsRoot: string,
  targetSkillsRoot: string,
  names: readonly string[] = EDGE_SKILL_NAMES,
): number {
  if (!existsSync(targetSkillsRoot)) mkdirSync(targetSkillsRoot, { recursive: true });

  let copied = 0;
  for (const name of names) {
    const sourcePath = join(sourceSkillsRoot, name);
    if (!existsSync(sourcePath)) continue;
    for (const replaced of REPLACED_SKILL_DIRS) {
      if (!replaced.startsWith(`${name}/`)) continue;
      if (!existsSync(join(sourceSkillsRoot, replaced))) continue;
      rmSync(join(targetSkillsRoot, replaced), { recursive: true, force: true });
    }
    copied += copyTree(sourcePath, join(targetSkillsRoot, name));
  }
  return copied;
}
