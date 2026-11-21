/**
 * Agent profile switch for the installer (`AV_PROFILE`).
 *
 *   - `resident` (default): the resident's agent, Edge. Behaviour is unchanged.
 *   - `odin`: ODIN, the village god agent. Installs `workspace/odin/SOUL.md` and
 *     `workspace/odin/AGENTS.md` instead of the resident ones, and fills the
 *     "## Village constitution" section of SOUL.md from `$HERMES_HOME/constitution.md`
 *     (the operator places that file; no constitution text lives in this repo).
 *
 * See docs/odin-profile.md for what ODIN does and does not get.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { dotenvFileValue } from "./config";

export type Profile = "resident" | "odin";

/** Plugins only the resident's agent runs; an ODIN box does not list them in `plugins.enabled`. */
export const RESIDENT_ONLY_PLUGINS = ["village-bridge", "av-vote", "av-godconst", "index-links", "index-network", "av-elicit"];

export const CONSTITUTION_FILE = "constitution.md";
export const CONSTITUTION_PLACEHOLDER = "{{CONSTITUTION}}";
export const NO_CONSTITUTION_LINE = "(no constitution adopted yet)";

export const PROFILE_ENV = "AV_PROFILE";

/**
 * Resolve `AV_PROFILE`: the process environment first, else `$HERMES_HOME/.env` (the control plane
 * writes it there, as it does `AV_MORALMOD_ARM`, so a provisioned box keeps its profile across
 * update, reset and roll). Unset or blank is `resident`; any other unknown value throws.
 */
export function resolveProfile(
  env: Record<string, string | undefined> = process.env,
  fromDotenv: (name: string) => string | undefined = dotenvFileValue,
): Profile {
  const raw = (env[PROFILE_ENV] ?? fromDotenv(PROFILE_ENV))?.trim().toLowerCase();
  if (!raw || raw === "resident") return "resident";
  if (raw === "odin") return "odin";
  throw new Error(`AV_PROFILE must be "resident" or "odin"`);
}

/** Directory holding the profile's SOUL.md and AGENTS.md. */
export function profileSourceDir(workspace: string, profile: Profile): string {
  return profile === "odin" ? join(workspace, "odin") : workspace;
}

/** Splice the constitution (or the single "none adopted" line) into ODIN's SOUL.md text. */
export function renderOdinSoul(template: string, home: string): string {
  const path = join(home, CONSTITUTION_FILE);
  let body = NO_CONSTITUTION_LINE;
  if (existsSync(path)) {
    // The app's soul export opens with its own "## Village constitution" heading; the template has one.
    const text = readFileSync(path, "utf8").trim().replace(/^## Village constitution[ \t]*(?:\r?\n|$)\s*/i, "");
    if (text) body = text;
  }
  // A function replacer keeps `$` sequences in the constitution literal.
  return template.replace(CONSTITUTION_PLACEHOLDER, () => body);
}

/**
 * Write the profile's SOUL.md (and, for `odin`, AGENTS.md) into `home`.
 * `resident` writes SOUL.md only: the resident AGENTS.md goes out with the other project files.
 * Returns the names written. `preserve` leaves an existing file alone (`--preserve-context`).
 */
export function installProfileIdentity(
  workspace: string,
  home: string,
  profile: Profile,
  preserve = false,
): string[] {
  const written: string[] = [];
  const dir = profileSourceDir(workspace, profile);
  const soulSource = join(dir, "SOUL.md");
  const soulTarget = join(home, "SOUL.md");
  if (existsSync(soulSource) && !(preserve && existsSync(soulTarget))) {
    if (profile === "odin") {
      writeFileSync(soulTarget, renderOdinSoul(readFileSync(soulSource, "utf8"), home));
    } else {
      copyFileSync(soulSource, soulTarget);
    }
    written.push("SOUL.md");
  }
  if (profile === "odin") {
    const agentsTarget = join(home, "AGENTS.md");
    if (!(preserve && existsSync(agentsTarget))) {
      copyFileSync(join(dir, "AGENTS.md"), agentsTarget);
      written.push("AGENTS.md");
    }
  }
  return written;
}
