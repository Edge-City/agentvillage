import { homedir } from "node:os";
import { join } from "node:path";

/** Hermes data root (`HERMES_HOME` or `~/.hermes`). */
export function hermesHome(): string {
  return process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
}

/** Edge project context + memory — flat under `$HERMES_HOME` (Hermes default layout). */
export function targetWorkspace(): string {
  return hermesHome();
}

export function skillsDir(): string {
  return join(hermesHome(), "skills");
}

/** Skill bundles shipped by this repo (installed into `$HERMES_HOME/skills/<name>/`). */
export const EDGE_SKILL_NAMES = [
  "index-network",
  "edgeos",
  // Edge City India public village knowledge (the current event).
  "edge-india",
  // The previous popup, background only.
  "edge-esmeralda",
  "geo-esmeralda",
  "token-usage-audit",
  "agent-plaza",
  "agent-commons",
  "simocracy",
  // DATA-212: installed everywhere, inert unless the `record_intention` tool
  // is available (tenants with `AV_RECORD_INTENTION` on); its text says so.
  "record-intention",
] as const;

/**
 * Generated skill directories the installer replaces instead of merging, so a
 * document removed from the snapshot is removed from existing Hermes homes too.
 */
export const REPLACED_SKILL_DIRS = ["edge-india/references"] as const;

export const CRON_NAME_PREFIX = "Edge —";
