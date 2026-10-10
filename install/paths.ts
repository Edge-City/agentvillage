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
  // Edge City India public village knowledge (the current event): read from the
  // local copy the "Edge — knowledge sync" job keeps (K1), with the snapshot
  // installed here as the fallback; never fetched in a turn.
  "edge-india",
  // The previous popup, background only.
  "edge-esmeralda",
  "token-usage-audit",
  "agent-plaza",
  "agent-commons",
  "simocracy",
  // DATA-212: installed everywhere, inert unless the `record_intention` tool
  // is available (tenants with `AV_RECORD_INTENTION` on); its text says so.
  "record-intention",
  // P1: the agent's nickname and the resident's own profile, read once per
  // private session from $HERMES_HOME/av-profile.json (the control plane writes it).
  "agent-profile",
  // Read-only, bounded access to the app's current main-group Village Digest.
  // It is inert unless the operator explicitly configures its dedicated URL
  // and read secret; the installer never injects either one.
  "village-digest",
] as const;

/**
 * Generated skill directories the installer replaces instead of merging, so a
 * document removed from the snapshot is removed from existing Hermes homes too.
 */
export const REPLACED_SKILL_DIRS = ["edge-india/references"] as const;

/**
 * Skill bundles this repo once installed and no longer ships. The installer
 * removes each from `$HERMES_HOME/skills/` on every install and update (one
 * log line per removal), so a home installed before the retirement stops
 * registering it. A skill on neither this list nor `EDGE_SKILL_NAMES`
 * (Hermes's own bundled skills, one a resident added) is never touched.
 * Add a name here when it leaves `EDGE_SKILL_NAMES`.
 */
export const RETIRED_SKILL_DIRS = [
  // DATA-360: left EDGE_SKILL_NAMES in rc16 (9adff7a6); the Geo CLI it
  // pointed the agent at is unused.
  "geo-esmeralda",
] as const;

// A name on both lists would be copied in and removed again on every run.
for (const name of RETIRED_SKILL_DIRS) {
  if ((EDGE_SKILL_NAMES as readonly string[]).includes(name)) {
    throw new Error(
      `install/paths.ts: "${name}" is in both EDGE_SKILL_NAMES and RETIRED_SKILL_DIRS; remove it from one`,
    );
  }
}

export const CRON_NAME_PREFIX = "Edge —";
