/**
 * Opt-in recall (DATA-83): stage the `recall` skill and enable its plugin only
 * for a tenant with `AV_RECALL_ENABLED` set to `1|true|yes|on` (read from the
 * environment, else from `$HERMES_HOME/.env`).
 *
 * - opted in  → `skills/recall/` is staged into `$HERMES_HOME/skills/recall/`
 *               (without its tests and fixtures) and `recall` is added to
 *               `plugins.enabled`;
 * - opted out (any other non-blank value) → the plugin is disabled, the
 *               staged skill is removed, and the derived index under
 *               `$HERMES_HOME/.recall/` is deleted. The index only ever holds
 *               copies of text already in the sandbox, so removing it loses
 *               nothing the attendee wrote. The `--wipe-user` epoch marker is
 *               kept;
 * - unset     → nothing happens. Recall is never on by default.
 *
 * The plugin code itself is staged for every tenant by `copyPluginFiles()`,
 * like every plugin under `plugins/`; Hermes loads none of them unless they
 * are listed in `plugins.enabled`.
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { configureRecall, recallChoice, setRecallPluginEnabled } from "./config";
import { hermesHome, skillsDir } from "./paths";
import { copyPluginTree } from "./plugin_copy";

export const RECALL_SKILL = "recall";
export const RECALL_INDEX_DIR = ".recall";
export const RECALL_EPOCH_FILE = "epoch";

/** Opt-in steps that failed in this process. Logged as a count; never fatal. */
export let recallInstallFailures = 0;

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

/**
 * `installRecall`, but an opt-in failure can never abort the core install:
 * the error is counted and logged, and the installer carries on.
 */
export function safeInstallRecall(sourceSkills: string): boolean {
  try {
    installRecall(sourceSkills);
    return true;
  } catch (err) {
    recallInstallFailures++;
    const kind = err instanceof Error ? err.name : typeof err;
    console.warn(`  warning: recall opt-in step failed (${kind}; failures=${recallInstallFailures}) — core install continues`);
    return false;
  }
}

/** Delete the derived recall index and its query-hash key; keep the epoch marker. */
export function removeRecallIndex(): void {
  const dir = join(hermesHome(), RECALL_INDEX_DIR);
  if (!existsSync(dir)) return;
  let removed = 0;
  for (const name of readdirSync(dir)) {
    if (name === RECALL_EPOCH_FILE) continue;
    rmSync(join(dir, name), { recursive: true, force: true });
    removed++;
  }
  if (removed > 0) console.log(`→ removed ${RECALL_INDEX_DIR}/ index files (derived recall index)`);
}

/**
 * `--wipe-user`: delete the index and write `.recall/epoch` (seconds since the
 * Unix epoch). The indexer never indexes a session message older than it, so
 * a previous occupant's conversations — which Hermes keeps in `state.db` —
 * never enter a new index.
 */
export function wipeRecallIndex(now: Date = new Date()): void {
  const dir = join(hermesHome(), RECALL_INDEX_DIR);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, RECALL_EPOCH_FILE), `${now.getTime() / 1000}\n`, { mode: 0o600 });
  console.log(`→ reset ${RECALL_INDEX_DIR}/ and wrote the wipe epoch (--wipe-user)`);
}

/**
 * `reset.ts`: take `recall` out of `plugins.enabled` and delete the index
 * (keeping the epoch); on `--wipe-user`, write a fresh epoch too.
 */
export function resetRecall(wipeUser: boolean): void {
  if (existsSync(join(hermesHome(), "config.yaml"))) {
    setRecallPluginEnabled(false);
    console.log("→ removed recall from plugins.enabled");
  }
  if (wipeUser) wipeRecallIndex();
  else removeRecallIndex();
}
