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
  "edge-esmeralda",
  "geo-esmeralda",
  "token-usage-audit",
  "agent-plaza",
  "agent-commons",
  "simocracy",
  // DATA-212: shown by Hermes only when the `record_intention` tool is
  // registered (`metadata.hermes.requires_tools`), i.e. on tenants with
  // `AV_RECORD_INTENTION` on.
  "record-intention",
] as const;

export const CRON_NAME_PREFIX = "Edge —";
