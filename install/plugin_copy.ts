import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Directory names never staged into a tenant's plugin directory.
 *
 * A plugin's test suite and its build caches are development artefacts: they
 * are dead weight in every sandbox, they are the largest part of some plugins,
 * and `tests/` in particular ships fixtures and fake payloads into the same
 * tree Hermes scans. Nothing in the sandbox ever runs them.
 */
export const PLUGIN_COPY_IGNORE_DIRS = new Set([
  "tests",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

/** File suffixes never staged (compiled Python, editor leftovers). */
export const PLUGIN_COPY_IGNORE_SUFFIXES = [".pyc", ".pyo", ".pyd"];

export function shouldCopyPluginEntry(name: string, isDirectory: boolean): boolean {
  if (isDirectory) return !PLUGIN_COPY_IGNORE_DIRS.has(name);
  if (name === "pytest.ini") return false;
  return !PLUGIN_COPY_IGNORE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Recursive copy that skips development-only entries. Returns files copied. */
export function copyPluginTree(sourceDir: string, targetDir: string): number {
  if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true });

  let copied = 0;
  for (const entry of readdirSync(sourceDir)) {
    const sourcePath = join(sourceDir, entry);
    const isDirectory = statSync(sourcePath).isDirectory();
    if (!shouldCopyPluginEntry(entry, isDirectory)) continue;

    if (isDirectory) {
      copied += copyPluginTree(sourcePath, join(targetDir, entry));
    } else {
      copyFileSync(sourcePath, join(targetDir, entry));
      copied++;
    }
  }
  return copied;
}
