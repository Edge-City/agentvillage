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
 *   `sidecar.py` starts the Bun negotiator with `os.environ.copy()` minus
 *   `INDEX_SESSION_TOKEN`, every gateway secret included. Every ON run, after
 *   the Hermes install or no-op and before enabling, the installed
 *   `plugins/index-network/sidecar.py` has that exact two-line anchor replaced
 *   by an allowlist (`SIDECAR_ENV_ALLOWLIST` from `os.environ`, then the
 *   plugin's own `INDEX_*` names, unchanged). An already-patched file is left
 *   byte for byte. Anything else (anchor missing or twice, unreadable, write or
 *   re-read failed) is fail closed: the step does what withheld does, reports
 *   `sidecar` and logs one line naming the reason. Comes out when the plugin
 *   offers a hook (the request to Index on #249).
 * - `--skip-index`, or no Index key, skips the ON install as `installIndex()`
 *   is skipped.
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

export const INDEX_PLUGIN = "index-network";
export const INDEX_PLUGIN_SOURCE = "indexnetwork/hermes-plugin";
/** The reviewed commit of indexnetwork/hermes-plugin (dev = main on 2026-10-08; Hermes's install scan: safe). */
export const INDEX_PLUGIN_REF = "eaec4fc02ffc251fca2cfd56b728c845562f6a3b";
/**
 * OV-249 A3: the exact bytes of `sidecar.py:149-150` at `INDEX_PLUGIN_REF` (the negotiator child's
 * env: the gateway's whole environment minus the device session), which the installer replaces.
 * A pin bump must re-take the anchor from the new ref (`gh api
 * repos/indexnetwork/hermes-plugin/contents/sidecar.py?ref=<REF>`) and move `SIDECAR_ANCHOR_PIN`
 * with it: a pin whose `ref` is not `INDEX_PLUGIN_REF`, or whose sha256 is not the anchor's, fails
 * closed at run time and fails the test that holds the pairing.
 */
export const SIDECAR_ANCHOR = '            child_env = os.environ.copy()\n            child_env.pop("INDEX_SESSION_TOKEN", None)\n';
export const SIDECAR_ANCHOR_PIN = {
  ref: "eaec4fc02ffc251fca2cfd56b728c845562f6a3b",
  sha256: "15dbfddb11217ba5162aff96ec473cca8f949b5386fd466650d2906f8636a1b6",
} as const;
/** The names the negotiator child keeps from the gateway's environment (Bun needs PATH and HOME). */
export const SIDECAR_ENV_ALLOWLIST = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const;
/** Marks the patched region, so a re-run recognises an already-patched file. */
export const SIDECAR_MARKER = "# agentvillage OV-249 A3: env allowlist";
/** What replaces `SIDECAR_ANCHOR`, at its indent; the plugin's `child_env.update({INDEX_*})` follows unchanged. */
export const SIDECAR_PATCHED = [
  `            ${SIDECAR_MARKER} (installer patch: no gateway secret reaches the child)`,
  `            child_env = {name: os.environ[name] for name in (${SIDECAR_ENV_ALLOWLIST.map((n) => `"${n}"`).join(", ")}) if name in os.environ}`,
  "",
].join("\n");
export const MORALMOD_ARM_ENV = "AV_MORALMOD_ARM";
/** The plugin's own cron job and its launcher under `$HERMES_HOME/scripts/` (morning.py `JOB_NAME`, `LAUNCHER` at REF). */
export const MORNING_JOB = "Index morning";
export const MORNING_LAUNCHER = "index-morning.py";
/** Hermes's temporary clone directory: `TemporaryDirectory(prefix=".install-")`, 8 of Python's `[a-z0-9_]`. */
export const HERMES_INSTALL_TMP = /^\.install-[a-z0-9_]{8}$/;

/**
 * Why the step failed, one fixed word each: the Hermes command, the config.yaml write, the
 * negotiator seed, `gate`: the arm is on but this run's approval step did not verify the gate, or
 * `sidecar`: the installed sidecar.py could not be brought to the env allowlist (OV-249 A3).
 */
export type IndexPluginFailure = "hermes" | "config" | "seed" | "gate" | "sidecar";

export interface IndexPluginResult {
  /** What the step did. */
  state: "off" | "withheld" | "skipped" | "disabled" | "pinned" | "installed" | "failed";
  /** The first failure, or null. */
  failed: IndexPluginFailure | null;
}

export const NEGOTIATOR_SEED = [
  "// Runs before the built-in negotiator. Return next() to keep it.",
  "// Or return { turn: { action, message } } or { stall: { reason, suggestedAsk } }.",
  "// action is \"propose\" | \"counter\" | \"accept\" | \"decline\".",
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
 * `source` with the anchor replaced by the allowlist (OV-249 A3), or the reason it cannot be: one
 * fixed phrase, never file content. Already patched (the exact patched block once, no anchor) is
 * returned unchanged.
 */
export function patchSidecarSource(source: string): { source: string; changed: boolean } | { reason: string } {
  if (SIDECAR_ANCHOR_PIN.ref !== INDEX_PLUGIN_REF) return { reason: "the anchor was not re-taken at INDEX_PLUGIN_REF" };
  if (createHash("sha256").update(SIDECAR_ANCHOR).digest("hex") !== SIDECAR_ANCHOR_PIN.sha256) return { reason: "the anchor is not the pinned one" };
  const anchors = count(source, SIDECAR_ANCHOR);
  const patched = count(source, SIDECAR_PATCHED);
  if (patched === 1 && anchors === 0) return { source, changed: false };
  if (patched > 0 || count(source, SIDECAR_MARKER) > 0) return { reason: "a partial or altered patch" };
  if (anchors === 0) return { reason: "anchor missing" };
  if (anchors > 1) return { reason: "anchor ambiguous" };
  return { source: source.replace(SIDECAR_ANCHOR, SIDECAR_PATCHED), changed: true };
}

export function sidecarPath(home: string): string {
  return join(pluginDir(home), "sidecar.py");
}

/**
 * Bring the installed sidecar.py to the env allowlist: no write when already patched; otherwise a
 * temp file beside it, with its mode and owner, renamed over it and read back.
 *
 * @returns `patched`, `already`, or the reason (fixed phrase) the plugin must not be enabled.
 */
export function patchInstalledSidecar(home: string): "patched" | "already" | { reason: string } {
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
  try {
    writeFileSync(tmp, result.source, { mode: mode & 0o7777 });
    chmodSync(tmp, mode & 0o7777);
    chownSync(tmp, uid, gid);
    renameSync(tmp, path);
  } catch {
    rmSync(tmp, { force: true });
    return { reason: "write failed" };
  }
  try {
    if (readFileSync(path, "utf8") !== result.source) return { reason: "re-read differs" };
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
 */
export function installIndexPlugin(run: (args: string[]) => void, argv: string[] = process.argv, gateVerified = false): IndexPluginResult {
  const home = hermesHome();
  const armOn = moralmodArmOn();
  if (!armOn || !gateVerified) {
    let off: IndexPluginFailure | null = null;
    const why = armOn ? "withheld: the approval gate was not installed and live-checked on this run" : `off (${MORALMOD_ARM_ENV} is not on)`;
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
    return { state: "off", failed: off };
  }
  if (argv.includes("--skip-index") || !hasIndexKey(argv, home)) {
    console.log("→ index-network plugin: skipped (no Index key or --skip-index)");
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
    if (typeof sidecar === "object") {
      let dropped = false;
      try {
        dropped = setIndexPluginEnabled(false);
      } catch {
        failed = "config";
      }
      const tail = failed === "config" ? "; could not update plugins.enabled in config.yaml" : dropped ? "; removed from plugins.enabled" : "";
      console.warn(`  warning: index-network plugin: not enabled, sidecar.py env not allowlisted (${sidecar.reason})${tail}`);
      stopMorningJob(run, home);
      // `config` first (the plugin may still be listed), else the first failure, else `sidecar`.
      failed ??= "sidecar";
      return { state: "failed", failed };
    }
    if (sidecar === "patched") console.log(`→ index-network plugin: sidecar.py env allowlisted (${sidecarPath(home)})`);
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
 * in the run; the same temp-file-and-rename write, mode 0600. A missing or
 * unreadable file is left alone (the run could not write it either).
 *
 * @returns Whether the field was written.
 */
export function recordIndexPluginStatus(home: string, failed: IndexPluginFailure | null): boolean {
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
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return true;
}
