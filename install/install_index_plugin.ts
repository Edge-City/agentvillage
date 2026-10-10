/** The managed MoralMod lifecycle (`docs/moralmod_lifecycle.md`) runs for ON residents only
 * (OV-249 post-hoc M1): with `AV_MORALMOD_ARM` off or unset, MoralMod files on the box or in the
 * installer environment change nothing, the OFF path below runs and its line says why. Its release
 * must be the one pinned in `MORALMOD_RELEASE_SHA256` (post-hoc M2), else the plugin is withheld
 * (`release_unpinned`).
 */
/**
 * The Index Hermes plugin (`index-network`), MoralMod's carrier, for ON
 * residents only, and the negotiator file it loads.
 *
 * - The arm: `AV_MORALMOD_ARM`, read as the gateway sees it: `$HERMES_HOME/.env`
 *   first (the control plane writes `on|off` there per tenant), the install
 *   environment only when `.env` does not assign it, as the approval switch
 *   does (`gatewayValue`): the control plane's install shell carries
 *   create-time variables that must not beat a later `.env` flip. `on`,
 *   trimmed and in any case, is ON; absent, blank or anything else is OFF.
 * - ON: the plugin is installed at one reviewed commit, `INDEX_PLUGIN_REF`.
 *   When Hermes's own record (`plugins/.install-metadata.json`) says
 *   `index-network` is pinned at that commit and its `plugin.yaml` is on disk,
 *   no Hermes command runs. Otherwise one runs:
 *   `hermes plugins install indexnetwork/hermes-plugin --ref <REF> --no-enable`,
 *   with `--force` when the directory exists (another revision, an unpinned
 *   install or a half-installed tree). Never `plugins update` (a git pull past
 *   the review) and never `plugins enable` (it deletes an operator's
 *   `plugins.disabled` entry and hot-loads the plugin into the running
 *   gateway): the plugin is enabled by listing it in `plugins.enabled` through
 *   `writeConfig`, as `setRecallPluginEnabled` does. A bump is a PR that
 *   changes the constant (and the tool list in the test that holds it).
 * - An `index-network` entry in `plugins.disabled` is the operator's: the step
 *   prints one warning and does nothing else.
 * - OFF: `index-network` is dropped from `plugins.enabled` when listed, and
 *   the plugin's own scheduled code is stopped: its `Index morning` cron job
 *   (exact name, script `index-morning.py`) is removed with `hermes cron
 *   remove <id>`, as the Index cron reconcile removes a retired job, and its
 *   launcher `$HERMES_HOME/scripts/index-morning.py` is deleted. The plugin
 *   removes both only from its `on_unload`, which Hermes does not run when
 *   the gateway exits (morning.py `sync_morning_cron` at REF). No other
 *   Hermes command; nothing is uninstalled (`plugins remove` would also
 *   clear an operator's `plugins.disabled` entry). ON leaves both to the
 *   plugin.
 * - ON clears Hermes's own temporary clones (`plugins/.install-` + 8 of
 *   `[a-z0-9_]`, Python's `TemporaryDirectory`, plugins_cmd.py:864) that a
 *   killed install left: those holding an `index-network` manifest, and after
 *   a failed or timed-out call those it created. Hermes's discovery does not
 *   skip dot directories, so one would load as a second `index-network`.
 * - Withheld (OV-249 B, fail closed): ON is honoured only when this run's
 *   approval step installed the gate, its live fire was answered by the
 *   facade, and Hermes routes exactly `APPROVAL_GATED_TOOLS`, which holds the
 *   plugin's eight write tools (`lastInstallVerified`). Otherwise the step does
 *   what OFF does and reports `gate` (`config` when the drop failed). That
 *   makes the writes reach the resident's daemon; whether one waits for a tap
 *   is the policy's row (`opportunity.accept` is autonomous in the template),
 *   which the installer neither reads nor writes.
 * - Sidecar env allowlist (OV-249 A3, the lead's R11): at REF the plugin's
 *   `sidecar.py` builds the Bun negotiator's env with its own
 *   `negotiator_child_env()`: six names, widened by any name listed in
 *   `INDEX_NEGOTIATOR_ENV_PASSTHROUGH` from the gateway's environment, minus
 *   `INDEX_SESSION_TOKEN` (before 04d833b8 it was `os.environ.copy()`, every
 *   gateway secret included). That knob is open-ended and owned by whatever
 *   writes the gateway env, so the overlay keeps its own fixed list (refute S1
 *   at 04d833b8). Every ON run, after the Hermes install or no-op and before
 *   enabling, the installed `plugins/index-network/sidecar.py` has that exact
 *   one-line call replaced by an allowlist (`SIDECAR_ENV_ALLOWLIST` from
 *   `os.environ`, plus `BUN_OPTIONS=--no-env-file` so Bun loads no `.env*`
 *   from the gateway's working directory, then the plugin's own `INDEX_*`
 *   names, unchanged). `negotiator_child_env()` stays defined but is never
 *   called, so `INDEX_NEGOTIATOR_ENV_PASSTHROUGH` is never read. An
 *   already-patched file is left byte for byte; a file the first A3 patch
 *   wrote (`SIDECAR_PATCHED_V1`, exactly) is brought to the current block.
 *   A pin bump reaches a box patched at the previous REF through the
 *   `--force` reinstall: Hermes writes a fresh `sidecar.py` at the new REF,
 *   which this step then patches (a bump that fails leaves the previous tree,
 *   patched or not, and it is judged as it stands).
 *   Anything else (anchor missing or twice, unreadable, write or re-read
 *   failed) is fail closed: the step does what withheld does, reports
 *   `sidecar` and logs one line naming the reason. Comes out when the plugin
 *   offers a hook (the request to Index on #249).
 * - `--skip-index`, or no Index key, skips the ON install as `installIndex()`
 *   is skipped. An entry an earlier run put in `plugins.enabled` stays only
 *   with the sidecar patched (A3, as above); otherwise it is dropped.
 * - `$HERMES_HOME/index/negotiator.ts` is seeded for ON residents only when
 *   absent, whether or not the Hermes command succeeded, so an update never
 *   replaces a resident's negotiator. The seed calls `next()`, the built-in
 *   negotiator.
 * - A failure never stops the install: it is returned as one fixed word,
 *   recorded in `av-events/install-status.json` (`index_plugin_failed`) and
 *   printed as one fixed line by install.ts.
 */

import { createHash } from "node:crypto";
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { dotenvFileValue, readConfig, writeConfig } from "./config";
import { persistedEnvVar, readCronJobs } from "./install_index";
import { installStatusPath } from "./install_status";
import { hermesHome } from "./paths";
import { activateMoralmod, checkResidentHook, residentConfiguration } from "./moralmod_host";
import { MORALMOD_RELEASE_SHA256, MoralmodReleaseUnpinned, installMoralmodRelease } from "./moralmod_release";

export const INDEX_PLUGIN = "index-network";
export const INDEX_PLUGIN_SOURCE = "indexnetwork/hermes-plugin";
/**
 * The reviewed commit of indexnetwork/hermes-plugin (on dev and main 2026-10-10; refute
 * PLUGIN-04d833b8: 0 MUST). Hermes's install scan was last recorded safe at eaec4fc0; re-run it
 * at this ref before the bump ships (04d833b8 adds `tests/test_sidecar_env.py`, which uses
 * `tempfile` and `chmod`).
 */
export const INDEX_PLUGIN_REF = "04d833b840541fedabe78cbdad306c18853d784a";
/**
 * The managed MoralMod release is pinned beside it: `MORALMOD_RELEASE_SHA256` in
 * `moralmod_release.ts`, the sha256 of the reviewed `release.json` (a sentinel until one is supplied).
 */
export { MORALMOD_RELEASE_SHA256 } from "./moralmod_release";
/**
 * OV-249 A3: the exact bytes of `sidecar.py:164` at `INDEX_PLUGIN_REF` (the negotiator child's env:
 * upstream's `negotiator_child_env()`, its six names plus whatever `INDEX_NEGOTIATOR_ENV_PASSTHROUGH`
 * lists, refute S1), which the installer replaces with the overlay's fixed list. The sha256 is of
 * the anchor string itself, not the file (`checkAnchorPin`). A pin bump must re-take the anchor
 * from the new ref (`gh api repos/indexnetwork/hermes-plugin/contents/sidecar.py?ref=<REF>`) and
 * move `SIDECAR_ANCHOR_PIN` with it: a pin whose `ref` is not `INDEX_PLUGIN_REF`, or whose sha256
 * is not the anchor's, fails closed at run time and fails the test that holds the pairing.
 */
export const SIDECAR_ANCHOR = "            child_env = negotiator_child_env()\n";
export const SIDECAR_ANCHOR_PIN = {
  ref: "04d833b840541fedabe78cbdad306c18853d784a",
  sha256: "7a8db4b9d74f5aad5a3811ef1a70704f204f9de0828a73a68ff66fc6a8e10b9f",
} as const;
/** The names the negotiator child keeps from the gateway's environment (Bun needs PATH and HOME). */
export const SIDECAR_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ", "AV_MORALMOD_ARM"] as const;
/**
 * Set in the child env, never copied: the child has no `cwd=`, so it runs in the gateway's working
 * directory, and Bun auto-loads `.env`, `.env.local` and `.env.development` from there.
 */
export const SIDECAR_BUN_OPTIONS = "--no-env-file";
/** Marks the patched region, so a re-run recognises an already-patched file. */
export const SIDECAR_MARKER = "# agentvillage OV-249 A3: env allowlist";
/** What replaces `SIDECAR_ANCHOR`, at its indent; the plugin's `child_env.update({INDEX_*})` follows unchanged. */
export const SIDECAR_PATCHED = [
  `            ${SIDECAR_MARKER} (installer patch: no gateway secret reaches the child)`,
  `            child_env = {name: os.environ[name] for name in (${SIDECAR_ENV_ALLOWLIST.map((n) => `"${n}"`).join(", ")}) if name in os.environ}`,
  `            child_env["BUN_OPTIONS"] = "${SIDECAR_BUN_OPTIONS}"`,
  "",
].join("\n");
/**
 * The block the first A3 patch (d1395502) wrote, byte for byte: no `BUN_OPTIONS`. Found exactly once
 * (and no `BUN_OPTIONS` anywhere), it is replaced by `SIDECAR_PATCHED`; it is a prefix of it.
 */
export const SIDECAR_PATCHED_V1 =
  '            # agentvillage OV-249 A3: env allowlist (installer patch: no gateway secret reaches the child)\n' +
  '            child_env = {name: os.environ[name] for name in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ") if name in os.environ}\n';
export const MORALMOD_ARM_ENV = "AV_MORALMOD_ARM";
/** The plugin's own cron job and its launcher under `$HERMES_HOME/scripts/` (morning.py `JOB_NAME`, `LAUNCHER` at REF). */
export const MORNING_JOB = "Index morning";
export const MORNING_LAUNCHER = "index-morning.py";
/** Hermes's temporary clone directory: `TemporaryDirectory(prefix=".install-")`, 8 of Python's `[a-z0-9_]`. */
export const HERMES_INSTALL_TMP = /^\.install-[a-z0-9_]{8}$/;

/**
 * Why the step failed, one fixed word each: the Hermes command, the config.yaml write, the
 * negotiator seed, `gate`: the arm is on but this run's approval step did not verify the gate,
 * `sidecar`: the installed sidecar.py could not be brought to the env allowlist (OV-249 A3), or
 * `release_unpinned`: the managed MoralMod release is not the one pinned in
 * `MORALMOD_RELEASE_SHA256` (OV-249 post-hoc M2).
 */
export type IndexPluginFailure = "hermes" | "config" | "seed" | "gate" | "sidecar" | "release_unpinned";

/**
 * Why a clean run did what it did, when the state alone does not say: `moralmod_arm_not_on`, the
 * arm is off or unset while MoralMod files are present (`MORALMOD_RELEASE_DIR`,
 * `MORALMOD_RESIDENT_CONFIG` or `index/moralmod/active.json`), so nothing MoralMod was activated.
 */
export type IndexPluginNote = "moralmod_arm_not_on";

export interface IndexPluginResult {
  /** What the step did. */
  state: "off" | "withheld" | "skipped" | "disabled" | "pinned" | "installed" | "failed";
  /** The first failure, or null. */
  failed: IndexPluginFailure | null;
  /** Set only when it applies. */
  note?: IndexPluginNote;
}

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

/** `AV_MORALMOD_ARM` is `on` (trimmed, any case), `.env` first. Anything else, absent included, is OFF. */
export function moralmodArmOn(): boolean {
  return (dotenvFileValue(MORALMOD_ARM_ENV) ?? process.env[MORALMOD_ARM_ENV])?.trim().toLowerCase() === "on";
}

/** The plugin's `Index morning` jobs: that exact name and a script whose file is `index-morning.py`. */
export function morningJobIds(): string[] {
  return readCronJobs()
    .filter((job) => job.name === MORNING_JOB && typeof job.script === "string" && basename(job.script.trim()) === MORNING_LAUNCHER)
    .map((job) => job.id);
}

/**
 * OFF: remove the plugin's `Index morning` jobs (`hermes cron remove <id>`, confirmed gone from
 * jobs.json) and delete its launcher. A box that never had them makes no Hermes call.
 *
 * @returns Whether every job is gone.
 */
export function stopMorningJob(run: (args: string[]) => void, home: string): boolean {
  let ok = true;
  for (const id of morningJobIds()) {
    try {
      run(["cron", "remove", id]);
      console.log(`→ removed cron ${MORNING_JOB} (the plugin is not enabled)`);
    } catch {
      ok = false;
      console.warn(`  warning: could not remove cron ${MORNING_JOB}`);
    }
  }
  if (ok && morningJobIds().length > 0) {
    ok = false;
    console.warn(`  warning: cron ${MORNING_JOB} is still there after its removal`);
  }
  const launcher = join(home, "scripts", MORNING_LAUNCHER);
  if (existsSync(launcher)) {
    // Without it the job, if one is left, fails without running the plugin's code.
    rmSync(launcher, { force: true });
    console.log(`→ removed ${launcher}`);
  }
  return ok;
}

function installTmpDirs(home: string): string[] {
  const dir = join(home, "plugins");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => {
    if (!HERMES_INSTALL_TMP.test(name)) return false;
    try {
      return statSync(join(dir, name)).isDirectory();
    } catch {
      return false;
    }
  });
}

function holdsIndexPlugin(tmp: string): boolean {
  try {
    return /^name:\s*["']?index-network["']?\s*$/m.test(readFileSync(join(tmp, "plugin", "plugin.yaml"), "utf8"));
  } catch {
    return false;
  }
}

/**
 * Remove Hermes's temporary clone directories under `plugins/` that hold an `index-network`
 * manifest, and, when `before` is given, every one that was not there before the call.
 *
 * @returns The names removed.
 */
export function removeInstallLeftovers(home: string, before?: Set<string>): string[] {
  const removed: string[] = [];
  for (const name of installTmpDirs(home)) {
    const path = join(home, "plugins", name);
    if (!(before && !before.has(name)) && !holdsIndexPlugin(path)) continue;
    rmSync(path, { recursive: true, force: true });
    removed.push(name);
  }
  if (removed.length > 0) console.log(`→ removed ${removed.length} leftover plugin install director${removed.length === 1 ? "y" : "ies"}`);
  return removed;
}

/** Hermes's record of `--ref` installs (hermes_cli/plugins_cmd.py `_install_metadata_path`, v2026.9.24). */
export function installMetadataPath(home: string): string {
  return join(home, "plugins", ".install-metadata.json");
}

function pluginDir(home: string): string {
  return join(home, "plugins", INDEX_PLUGIN);
}

/**
 * Hermes recorded `index-network` as pinned at `INDEX_PLUGIN_REF` and its
 * `plugin.yaml` is on disk. Hermes writes `{name: {pinned, revision, source}}`
 * after a successful swap (`_install_plugin_core`); an unreadable record is
 * not at the pin.
 */
export function pinnedAtRef(home: string): boolean {
  if (!existsSync(join(pluginDir(home), "plugin.yaml"))) return false;
  try {
    const record = (JSON.parse(readFileSync(installMetadataPath(home), "utf8")) as Record<string, unknown>)?.[INDEX_PLUGIN];
    if (!record || typeof record !== "object") return false;
    const { pinned, revision } = record as { pinned?: unknown; revision?: unknown };
    return pinned === true && typeof revision === "string" && revision.toLowerCase() === INDEX_PLUGIN_REF;
  } catch {
    return false;
  }
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Why `anchor` may not be used, or null: the pin was taken at another ref than `ref`, or its sha256
 * is not the anchor's (a bump that did not re-take the anchor).
 */
export function checkAnchorPin(pin: { ref: string; sha256: string }, ref: string, anchor: string): string | null {
  if (pin.ref !== ref) return "the anchor was not re-taken at INDEX_PLUGIN_REF";
  if (createHash("sha256").update(anchor).digest("hex") !== pin.sha256) return "the anchor is not the pinned one";
  return null;
}

/**
 * `source` with the anchor replaced by the allowlist (OV-249 A3), or the reason it cannot be: one
 * fixed phrase, never file content. Already patched (the exact patched block once, no anchor) is
 * returned unchanged. The first patch's block (`SIDECAR_PATCHED_V1` once, standing alone, no anchor,
 * no `BUN_OPTIONS`) is replaced by the current one.
 *
 * @param pin - The anchor's pin (a seam for the test of the run-time guard).
 */
export function patchSidecarSource(source: string, pin: { ref: string; sha256: string } = SIDECAR_ANCHOR_PIN): { source: string; changed: boolean } | { reason: string } {
  const unpinned = checkAnchorPin(pin, INDEX_PLUGIN_REF, SIDECAR_ANCHOR);
  if (unpinned) return { reason: unpinned };
  const v2 = SIDECAR_PATCHED.replace(', "AV_MORALMOD_ARM"', "");
  if (count(source, v2) === 1 && count(source, SIDECAR_MARKER) === 1 && !source.includes(SIDECAR_ANCHOR))
    return { source: source.replace(v2, () => SIDECAR_PATCHED), changed: true };
  const anchors = count(source, SIDECAR_ANCHOR);
  const patched = count(source, SIDECAR_PATCHED);
  // The V1 block is a prefix of the current one: count only the V1 blocks that stand alone.
  const v1 = count(source, SIDECAR_PATCHED_V1);
  if (patched === 1 && v1 === 0 && anchors === 0) return { source, changed: false };
  if (v1 === 1 && patched === 0 && anchors === 0 && !source.includes("BUN_OPTIONS")) {
    return { source: source.replace(SIDECAR_PATCHED_V1, () => SIDECAR_PATCHED), changed: true };
  }
  if (patched > 0 || v1 > 0 || count(source, SIDECAR_MARKER) > 0) return { reason: "a partial or altered patch" };
  if (anchors === 0) return { reason: "anchor missing" };
  if (anchors > 1) return { reason: "anchor ambiguous" };
  return { source: source.replace(SIDECAR_ANCHOR, () => SIDECAR_PATCHED), changed: true };
}

export function sidecarPath(home: string): string {
  return join(pluginDir(home), "sidecar.py");
}

/**
 * Bring the installed sidecar.py to the env allowlist: no write when already patched; otherwise a
 * temp file beside it, created exclusively (a file, link or directory already at that path is
 * refused, never written through or removed), with its mode and owner, renamed over it and read back.
 *
 * @param reread - Reads the file back after the rename (a seam for the test of the re-read check).
 * @returns `patched`, `already`, or the reason (fixed phrase) the plugin must not be enabled.
 */
export function patchInstalledSidecar(home: string, reread: (path: string) => string = (p) => readFileSync(p, "utf8")): "patched" | "already" | { reason: string } {
  const path = sidecarPath(home);
  let source: string;
  let mode: number;
  let uid: number;
  let gid: number;
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return { reason: "not a regular file" };
    ({ mode, uid, gid } = st);
    source = readFileSync(path, "utf8");
  } catch (err) {
    return { reason: (err as { code?: unknown } | null)?.code === "ENOENT" ? "missing" : "unreadable" };
  }
  const result = patchSidecarSource(source);
  if ("reason" in result) return result;
  if (!result.changed) return "already";
  const tmp = `${path}.av-${process.pid}.tmp`;
  let created = false;
  try {
    // `wx`: O_CREAT|O_EXCL, so a planted file, symlink or directory at `tmp` fails here (EEXIST).
    writeFileSync(tmp, result.source, { mode: mode & 0o7777, flag: "wx" });
    created = true;
    chmodSync(tmp, mode & 0o7777);
    chownSync(tmp, uid, gid);
    renameSync(tmp, path);
  } catch {
    // Only the file this call created, never recursively, and never a throw from the cleanup.
    if (created) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // left behind; the reason below already keeps the plugin off
      }
    }
    return { reason: "write failed" };
  }
  try {
    if (reread(path) !== result.source) return { reason: "re-read differs" };
  } catch {
    return { reason: "re-read failed" };
  }
  return "patched";
}

/** The Hermes argv that brings the plugin to the pin. */
export function pinnedInstallArgs(home: string): string[] {
  const force = existsSync(pluginDir(home)) ? ["--force"] : [];
  return ["plugins", "install", INDEX_PLUGIN_SOURCE, ...force, "--ref", INDEX_PLUGIN_REF, "--no-enable"];
}

/** The Index key as `installIndex()` reads it: `--index-api-key`, the environment, then `$HERMES_HOME/.env`. */
function hasIndexKey(argv: string[], home: string): boolean {
  const args = argv.slice(2);
  const at = args.indexOf("--index-api-key");
  const inline = args.find((arg) => arg.startsWith("--index-api-key="))?.slice("--index-api-key=".length);
  const flag = at >= 0 ? args[at + 1] : inline;
  return Boolean(flag?.trim() || process.env.INDEX_API_KEY?.trim() || persistedEnvVar(home, "INDEX_API_KEY"));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? (value as unknown[]).filter((n): n is string => typeof n === "string") : [];
}

/** Add or remove `index-network` in `plugins.enabled`, leaving every other entry and key alone; writes only on a change. */
export function setIndexPluginEnabled(on: boolean): boolean {
  const doc = readConfig();
  const plugins = { ...((doc.plugins as Record<string, unknown>) ?? {}) };
  const enabled = stringList(plugins.enabled);
  const listed = enabled.includes(INDEX_PLUGIN);
  if (listed === on) return false;
  plugins.enabled = on ? [...enabled, INDEX_PLUGIN] : enabled.filter((name) => name !== INDEX_PLUGIN);
  doc.plugins = plugins;
  writeConfig(doc);
  return true;
}

/**
 * OV-249 A3, fail closed: the sidecar could not be brought to the allowlist, so the plugin is
 * dropped from `plugins.enabled` and its morning job removed, as withheld does; one line naming
 * `reason`. The word is `config` when the drop failed (the plugin may still be listed), else
 * `failed` (an earlier failure of this run), else `word` (`sidecar`; `release_unpinned` for the
 * post-hoc M2 refusal, whose line says `what` instead of the sidecar's).
 */
function withholdForSidecar(
  run: (args: string[]) => void,
  home: string,
  reason: string,
  failed: IndexPluginFailure | null,
  word: IndexPluginFailure = "sidecar",
  what = "sidecar.py env not allowlisted",
): IndexPluginResult {
  let dropped = false;
  try {
    dropped = setIndexPluginEnabled(false);
  } catch {
    failed = "config";
  }
  const tail = failed === "config" ? "; could not update plugins.enabled in config.yaml" : dropped ? "; removed from plugins.enabled" : "";
  console.warn(`  warning: index-network plugin: not enabled, ${what} (${reason})${tail}`);
  stopMorningJob(run, home);
  failed ??= word;
  return { state: "failed", failed };
}

function operatorDisabled(): boolean {
  const plugins = readConfig().plugins as Record<string, unknown> | undefined;
  return stringList(plugins?.disabled).includes(INDEX_PLUGIN);
}

/**
 * The step. Never throws for a Hermes, config or seed failure: the first one
 * is returned in `failed`.
 *
 * @param run - One Hermes invocation, argv without the binary.
 * @param argv - The installer's argv (`--skip-index`, `--index-api-key`).
 * @param gateVerified - This run's approval step installed the gate and its live fire passed
 *   (`lastInstallVerified`). False, an ON resident is withheld: treated as OFF, reported `gate`.
 * @param releasePin - The expected sha256 of the managed release's `release.json` (a seam for
 *   tests, as `patchSidecarSource`'s pin is; install.ts passes none).
 */
export function installIndexPlugin(
  run: (args: string[]) => void,
  argv: string[] = process.argv,
  gateVerified = false,
  releasePin: string = MORALMOD_RELEASE_SHA256,
): IndexPluginResult {
  const home = hermesHome();
  const armOn = moralmodArmOn();
  const source = process.env.MORALMOD_RELEASE_DIR;
  const configuration = process.env.MORALMOD_RESIDENT_CONFIG;
  const managed = Boolean(source || configuration || existsSync(join(home, "index", "moralmod", "active.json")));
  // OV-249 post-hoc M1: the managed negotiator is for ON residents only, as the plugin is. With the
  // arm off or unset, MoralMod files present take the OFF path like any other OFF resident: the
  // plugin is not enabled, its morning job and launcher are removed, nothing is seeded, the plugin's
  // negotiator.js and morning.py are not touched; the line and the note say why.
  if (!armOn || !gateVerified) {
    let off: IndexPluginFailure | null = null;
    const why = armOn
      ? "withheld: the approval gate was not installed and live-checked on this run"
      : `off (${MORALMOD_ARM_ENV} is not on)${managed ? "; MoralMod release or resident config present, not activated: the managed negotiator runs only for ON" : ""}`;
    try {
      const dropped = setIndexPluginEnabled(false);
      console.log(`→ index-network plugin: ${why}${dropped ? "; removed from plugins.enabled" : ""}`);
    } catch {
      off = "config";
      console.warn("  warning: index-network plugin: could not update plugins.enabled in config.yaml");
    }
    if (!stopMorningJob(run, home)) off ??= "hermes";
    // Withheld: `config` first (the plugin may still be listed), else `gate`, a cron failure only warned.
    if (armOn) return { state: "withheld", failed: off === "config" ? "config" : "gate" };
    return managed ? { state: "off", failed: off, note: "moralmod_arm_not_on" } : { state: "off", failed: off };
  }
  if (argv.includes("--skip-index") || !hasIndexKey(argv, home)) {
    console.log("→ index-network plugin: skipped (no Index key or --skip-index)");
    // OV-249 A3: an entry an earlier run enabled is not kept over a sidecar.py Hermes or an
    // operator has since reinstalled unpatched. Not listed: nothing is read or written.
    let listed: boolean;
    try {
      listed = stringList((readConfig().plugins as Record<string, unknown> | undefined)?.enabled).includes(INDEX_PLUGIN);
    } catch {
      console.warn("  warning: index-network plugin: could not read config.yaml");
      return { state: "failed", failed: "config" };
    }
    if (listed) {
      const sidecar = patchInstalledSidecar(home);
      if (typeof sidecar === "object") return withholdForSidecar(run, home, sidecar.reason, null);
      if (sidecar === "patched") console.log(`→ index-network plugin: sidecar.py env allowlisted (${sidecarPath(home)})`);
    }
    return { state: "skipped", failed: null };
  }
  try {
    if (operatorDisabled()) {
      console.log(`→ warning: ${INDEX_PLUGIN} is in plugins.disabled; the installer leaves it off`);
      return { state: "disabled", failed: null };
    }
  } catch {
    console.warn("  warning: index-network plugin: could not read config.yaml");
    return { state: "failed", failed: "config" };
  }

  let prepared: { release: ReturnType<typeof installMoralmodRelease>; config: ReturnType<typeof residentConfiguration> } | undefined;
  if (managed) {
    try {
      if (!source || !configuration) throw Error("Managed release configuration missing");
      checkResidentHook(home);
      const config = residentConfiguration(configuration);
      prepared = { config, release: installMoralmodRelease(home, source, releasePin) };
    } catch (err) {
      // OV-249 post-hoc M2: refused exactly like a plugin revision mismatch; nothing is replaced.
      if (err instanceof MoralmodReleaseUnpinned) {
        return withholdForSidecar(run, home, "its release.json is not MORALMOD_RELEASE_SHA256", null, "release_unpinned", "MoralMod release not pinned");
      }
      return withholdForSidecar(run, home, "managed configuration invalid", null);
    }
  }
  let failed: IndexPluginFailure | null = null;
  let state: IndexPluginResult["state"] = "pinned";
  removeInstallLeftovers(home);
  if (pinnedAtRef(home)) {
    console.log(`→ index-network plugin: at ${INDEX_PLUGIN_REF.slice(0, 8)}, no Hermes call`);
  } else {
    const before = new Set(installTmpDirs(home));
    try {
      run(pinnedInstallArgs(home));
      state = "installed";
      console.log(`→ index-network plugin: installed at ${INDEX_PLUGIN_REF.slice(0, 8)}`);
    } catch (err) {
      failed = "hermes";
      const kind = err instanceof Error ? err.name : typeof err;
      console.warn(`  warning: index-network plugin was not installed at ${INDEX_PLUGIN_REF.slice(0, 8)} (${kind}); core install continues`);
      // A call killed at its timeout skips Hermes's own cleanup of its temporary clone.
      removeInstallLeftovers(home, before);
    }
  }
  // Enabled only when there is a plugin on disk to load (a failed first install leaves none; a
  // failed bump leaves the previous tree in place, Hermes swaps only after a good clone).
  if (existsSync(join(pluginDir(home), "plugin.yaml"))) {
    // OV-249 A3: never enabled with a sidecar that hands the negotiator the gateway's environment.
    const sidecar = patchInstalledSidecar(home);
    if (typeof sidecar === "object") return withholdForSidecar(run, home, sidecar.reason, failed);
    if (sidecar === "patched") console.log(`→ index-network plugin: sidecar.py env allowlisted (${sidecarPath(home)})`);
    if (prepared) {
      try { activateMoralmod(home, prepared.release, prepared.config); }
      catch { return withholdForSidecar(run, home, "managed runtime invalid", failed); }
    }
    try {
      if (setIndexPluginEnabled(true)) console.log(`→ enabled plugin ${INDEX_PLUGIN}`);
    } catch {
      failed ??= "config";
      console.warn("  warning: index-network plugin: could not update plugins.enabled in config.yaml");
    }
  }
  try {
    if (seedNegotiator(home)) console.log(`→ seeded ${negotiatorPath(home)}`);
    else console.log(`→ left ${negotiatorPath(home)} in place`);
  } catch {
    failed ??= "seed";
    console.warn("  warning: could not seed index/negotiator.ts");
  }
  return { state: failed ? "failed" : state, failed };
}

/** The one stdout line printed when the step failed: the fixed word only. */
export function indexPluginFailedLine(failed: IndexPluginFailure): string {
  return `agentvillage-install: index_plugin_failed=${failed}`;
}

/**
 * Add `index_plugin_failed` (the fixed word, or null) to this run's
 * `av-events/install-status.json`, which `writeInstallStatus` wrote earlier
 * in the run, and `index_plugin_note` when there is one (`IndexPluginNote`);
 * the same temp-file-and-rename write, mode 0600. A missing or unreadable file
 * is left alone (the run could not write it either).
 *
 * @returns Whether the field was written.
 */
export function recordIndexPluginStatus(home: string, failed: IndexPluginFailure | null, note?: IndexPluginNote): boolean {
  const path = installStatusPath(home);
  let status: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    status = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  status.index_plugin_failed = failed;
  if (note) status.index_plugin_note = note;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return true;
}
