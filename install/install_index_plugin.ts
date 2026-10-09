/**
 * Install the Index Hermes plugin (`index-network`) on every tenant and seed
 * the negotiator file once.
 *
 * The plugin is not in this repo. `hermes plugins install indexnetwork/hermes-plugin`
 * clones it; a later run uses `hermes plugins update index-network`. Either way
 * it is enabled. A failure is the caller's to catch: the core install continues.
 *
 * `$HERMES_HOME/index/negotiator.ts` is written only when absent, so an update
 * never replaces a resident's negotiator. The seed calls `next()`, which is
 * the built-in negotiator.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installManagedMoralmod } from "./moralmod_host";
import { hermesHome } from "./paths";

export const INDEX_PLUGIN = "index-network";
export const INDEX_PLUGIN_SOURCE = "indexnetwork/hermes-plugin";

export const NEGOTIATOR_SEED = [
  "// Runs before the built-in negotiator. Return next() to keep it.",
  "// Or return { turn: { action, message } } or { stall: { reason, suggestedAsk } }.",
  '// action is "propose" | "counter" | "accept" | "decline".',
  "//",
  "// input:",
  "//   user: { id, name, intro, location, timezone }",
  "//   intent: { id, statement }",
  "//   brief: string",
  "//   opportunity: {",
  "//     id, counterpart, status, awaiting, turnCount, actions,",
  "//     intent: { statement },",
  "//     turns: [{ turnIndex, actor, action, message, createdAt }]",
  "//   }",
  "export default async function negotiate(input, next) {",
  "  return next();",
  "}",
  "",
].join("\n");

export function negotiatorPath(home: string): string {
  return join(home, "index", "negotiator.ts");
}

/** @returns Whether the file was written. */
export function seedNegotiator(home: string): boolean {
  const path = negotiatorPath(home);
  if (existsSync(path)) return false;
  mkdirSync(join(home, "index"), { recursive: true });
  writeFileSync(path, NEGOTIATOR_SEED);
  return true;
}

/**
 * Install or update the plugin, enable it, and seed the negotiator file.
 *
 * @param run - One Hermes invocation, argv without the binary.
 * @param home - The Hermes home. Defaults to `hermesHome()`.
 */
export function installIndexPlugin(
  run: (args: string[]) => void,
  home: string = hermesHome(),
): void {
  const release = process.env.MORALMOD_RELEASE_DIR?.trim();
  const config = process.env.MORALMOD_RESIDENT_CONFIG?.trim();
  if (release || config) {
    if (!release || !config)
      throw Error("MoralMod requires both release and resident config");
    installManagedMoralmod(run, home, release, config);
    console.log(
      "→ installed pinned MoralMod lifecycle; selection/readiness verified at runtime",
    );
    return;
  }
  // A managed resident must never be silently overwritten by a floating update.
  if (existsSync(join(home, "index", "moralmod", "active.json")))
    throw Error(
      "Managed MoralMod update requires explicit pinned release/config",
    );
  const installed = existsSync(
    join(home, "plugins", INDEX_PLUGIN, "plugin.yaml"),
  );
  if (installed) run(["plugins", "update", INDEX_PLUGIN]);
  else run(["plugins", "install", INDEX_PLUGIN_SOURCE, "--enable"]);
  run(["plugins", "enable", INDEX_PLUGIN]);
  if (seedNegotiator(home)) console.log(`→ seeded ${negotiatorPath(home)}`);
  else console.log(`→ left ${negotiatorPath(home)} in place`);
}
