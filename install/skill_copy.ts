import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import { EDGE_SKILL_NAMES, REPLACED_SKILL_DIRS, RETIRED_SKILL_DIRS } from "./paths";

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

/** A retired name must be one plain directory name directly under the skills root. */
function isPlainDirName(name: string): boolean {
  return name !== ""
    && name !== "."
    && name !== ".."
    && !name.includes("/")
    && !name.includes("\\")
    && !name.includes("\0");
}

function presentOrDangling(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes the skill bundles this repo no longer ships (`RETIRED_SKILL_DIRS`)
 * from `<targetSkillsRoot>/<name>/`, one log line per removal, and returns the
 * names removed. Idempotent: a name already gone is skipped silently. Only a
 * plain directory name directly under the root is acted on (a name with a path
 * separator or `..` is refused and logged), and a name still in
 * `EDGE_SKILL_NAMES` is never removed. Nothing else under the root is read or
 * touched, so Hermes's bundled skills and a resident's own stay.
 */
export function removeRetiredSkillDirs(
  targetSkillsRoot: string,
  names: readonly string[] = RETIRED_SKILL_DIRS,
  log: (line: string) => void = console.log,
): string[] {
  const shipped = new Set<string>(EDGE_SKILL_NAMES);
  const removed: string[] = [];
  for (const name of names) {
    if (!isPlainDirName(name)) {
      log(`  warning: refused retired skill name ${JSON.stringify(name)} (not a plain directory name)`);
      continue;
    }
    if (shipped.has(name)) continue;
    const target = join(targetSkillsRoot, name);
    if (!presentOrDangling(target)) continue;
    // A symlink is unlinked, never followed.
    rmSync(target, { recursive: true, force: true });
    removed.push(name);
    log(`→ removed retired skill ${name} from ${targetSkillsRoot}`);
  }
  return removed;
}
