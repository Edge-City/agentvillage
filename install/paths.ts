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
  // DATA-212: installed everywhere, inert unless the `record_intention` tool
  // is available (tenants with `AV_RECORD_INTENTION` on); its text says so.
  "record-intention",
  // K1: Edge City India background, read from the local snapshot copy that
  // the "Edge — knowledge sync" job keeps (never fetched in a turn).
  "edge-india",
  // P1: the agent's nickname and the resident's own profile, read once per
  // private session from $HERMES_HOME/av-profile.json (the control plane writes it).
  "agent-profile",
] as const;

export const CRON_NAME_PREFIX = "Edge —";
