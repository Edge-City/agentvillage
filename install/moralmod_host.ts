import { installMorning, restoreMorning } from "./moralmod_morning";
/** Managed V2 replacement for the pinned plugin's runtime executable.
 * The existing sidecar still owns the per-home process lock and Hermes model bridge.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  readdirSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  INDEX_PLUGIN_REVISION,
  RELEASE_DIRECTORY_FILES,
  SHA256_HEX,
  installedReleasePinned,
  type InstalledRelease,
} from "./moralmod_release";
import { NEGOTIATOR_SEED, negotiatorPath } from "./install_index_plugin";
const hash = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const marker =
  "// Managed MoralMod lifecycle 2; see index/moralmod/active.json.";
const fields = [
  "DECISION_SERVICE_URL",
  "DECISION_EXPERIMENT_ID",
  "DECISION_INPUT_KIND",
  "DECISION_RUNTIME_REVISION",
  "VILLAGE_CONTROL_PLANE_URL",
  "VILLAGE_SUBJECT_REF",
  "VILLAGE_INSTALLATION_CREDENTIAL",
  "DECISION_ASSESSMENT_BYTES",
] as const;
type ResidentConfig = Record<(typeof fields)[number], string>;
function regular(p: string) {
  if (
    existsSync(p) &&
    (!lstatSync(p).isFile() || lstatSync(p).isSymbolicLink())
  )
    throw Error("Unsafe managed file");
}
function atomic(path: string, body: string) {
  regular(path);
  const tmp = path + "." + randomUUID() + ".tmp";
  writeFileSync(tmp, body, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}
export function residentConfiguration(path: string): ResidentConfig {
  regular(path);
  if ((lstatSync(path).mode & 0o077) !== 0)
    throw Error("Resident config must be private (0600)");
  const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw Error("Invalid resident config");
  const values = raw as Record<string, unknown>;
  if (
    Object.keys(values).some(
      (k) => !fields.includes(k as (typeof fields)[number]),
    )
  )
    throw Error("Unknown resident credential/config field");
  for (const name of fields.filter((n) => n !== "DECISION_ASSESSMENT_BYTES"))
    if (typeof values[name] !== "string" || !values[name])
      throw Error("Missing " + name);
  for (const name of ["DECISION_SERVICE_URL", "VILLAGE_CONTROL_PLANE_URL"]) {
    const url = new URL(String(values[name]));
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["localhost", "127.0.0.1"].includes(url.hostname)
        ))
    )
      throw Error("Invalid service origin");
  }
  if (
    !/^mm_[a-f0-9]{32}$/.test(String(values.VILLAGE_SUBJECT_REF)) ||
    !/^\w{8}-(?:\w{4}-){3}\w{12}$/.test(
      String(values.DECISION_EXPERIMENT_ID),
    ) ||
    !["synthetic", "live"].includes(String(values.DECISION_INPUT_KIND)) ||
    String(values.VILLAGE_INSTALLATION_CREDENTIAL).length < 32
  )
    throw Error("Invalid scoped resident identity");
  return Object.fromEntries(
    fields
      .filter((k) => values[k] !== undefined)
      .map((k) => [k, String(values[k])]),
  ) as ResidentConfig;
}
export function checkResidentHook(home: string): void {
  const path = negotiatorPath(home);
  regular(path);
  if (existsSync(path)) {
    const body = readFileSync(path, "utf8");
    if (body !== NEGOTIATOR_SEED && body !== marker + "\n")
      throw Error(
        "Resident negotiator is customized; explicit migration required",
      );
  }
}
/** The pinned plugin's runtime file, which a managed activation replaces with the loader. */
function runtimePath(home: string): string {
  return join(home, "plugins", "index-network", "runtime", "dist", "negotiator.js");
}
/**
 * The loader a managed activation writes over the plugin's `runtime/dist/negotiator.js`; it imports
 * the release installed at `directory` (`index/moralmod/<release.json sha256>`).
 */
export function managedLoaderSource(home: string, directory: string): string {
  const configFile = join(home, "index", "moralmod", "resident.json");
  return `${marker}\nimport {readFileSync} from 'node:fs';\nimport {startResident} from ${JSON.stringify(join(directory, "negotiator-runtime.js"))};\nconst config=JSON.parse(readFileSync(${JSON.stringify(configFile)},'utf8'));\ntry {\n const resident=await startResident({...process.env,...config,DECISION_JOURNAL_PATH:${JSON.stringify(join(home,"index","moralmod","fallback.sqlite"))}});\n const stop=()=>void resident.stop().finally(()=>process.exit(0));\n process.on('SIGTERM',stop);process.on('SIGINT',stop);\n console.log(JSON.stringify({ready:true,port:resident.port}));\n} catch { console.error(JSON.stringify({level:'warn',event:'moralmod_startup_unready'}));process.exit(1); }\n`;
}
/**
 * The plugin's own `runtime/dist/negotiator.js` from its checkout's `HEAD`, or null. With `revision`,
 * only when the checkout is at that revision (retirement puts back only the pinned plugin's file).
 */
function upstreamRuntime(plugin: string, revision: string | null = INDEX_PLUGIN_REVISION): Uint8Array | null {
  try {
    if (revision !== null) {
      const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: plugin });
      if (head.exitCode !== 0 || head.stdout.toString().trim() !== revision) return null;
    }
    const upstream = Bun.spawnSync(["git", "show", "HEAD:runtime/dist/negotiator.js"], { cwd: plugin });
    return upstream.exitCode === 0 ? upstream.stdout : null;
  } catch {
    return null;
  }
}
function upstreamRuntimeSha256(plugin: string): string | null {
  const bytes = upstreamRuntime(plugin);
  return bytes ? hash(bytes) : null;
}
/**
 * ov#277 refute S1, S2: a managed loader (an earlier ON run's, this one's or #249's) is at the
 * plugin's `runtime/dist/negotiator.js`: the marker, or an import from `index/moralmod/`. A file
 * that is there but cannot be read counts as one (fail closed).
 */
export function managedLoaderPresent(home: string): boolean {
  try {
    const text = readFileSync(runtimePath(home), "utf8");
    return text.includes("Managed MoralMod lifecycle") || text.includes("/index/moralmod/");
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}
/** Recognize the complete generated loader and its home-bound, digest-named release path, not just a marker.
 * No receipt or intact release is required. This proves ownership of the loader, not permission to
 * run it. Used only before a forced reinstall (`managedRuntimeReplaceable`); retirement does not
 * need it (ov#288 refute M2: ov#284's take-it-out rule stands, so a changed loader is taken out).
 */
function managedLoaderOwned(home: string): boolean {
  try {
    const runtime = runtimePath(home);
    if (!lstatSync(runtime).isFile()) return false;
    const source = readFileSync(runtime, "utf8");
    const reference = source.match(/import \{startResident\} from (.+);\n/);
    if (!reference) return false;
    const entry: unknown = JSON.parse(reference[1]!);
    if (typeof entry !== "string") return false;
    const directory = dirname(entry);
    return dirname(directory) === join(home, "index", "moralmod") &&
      SHA256_HEX.test(basename(directory)) &&
      entry === join(directory, "negotiator-runtime.js") &&
      source === managedLoaderSource(home, directory);
  } catch {
    return false;
  }
}
/** A forced reinstall replaces the plugin tree before activation can inspect it.
 * Check the current bytes first, even when a resident removed every managed marker.
 * Missing Hermes metadata or an ownership receipt does not authorize unknown content.
 * ov#288 refute M1: the plugin's own file is the checkout's `HEAD`, at whatever revision the tree is
 * (on a plugin bump the tree is still at the old one), and no file at all has nothing to protect.
 */
export function managedRuntimeReplaceable(home: string): boolean {
  try {
    const runtime = runtimePath(home);
    try {
      if (!lstatSync(runtime).isFile()) return false;
    } catch (err) {
      return (err as { code?: unknown } | null)?.code === "ENOENT";
    }
    if (managedLoaderOwned(home)) return true;
    const upstream = upstreamRuntime(join(home, "plugins", "index-network"), null);
    return upstream !== null && hash(readFileSync(runtime)) === hash(upstream);
  } catch {
    return false;
  }
}
/**
 * ov#277 refute S1: the loader on disk is exactly the one an activation of the pinned release writes,
 * and that release, as installed, is the pinned one (`installedReleasePinned`).
 */
export function managedLoaderPinned(home: string, pin: string): boolean {
  if (!installedReleasePinned(home, pin)) return false;
  try {
    return readFileSync(runtimePath(home), "utf8") === managedLoaderSource(home, join(home, "index", "moralmod", pin));
  } catch {
    return false;
  }
}
/**
 * ov#277 refute S1, S2: take a managed loader out of the plugin. The plugin's own negotiator.js is
 * put back from its checkout at `INDEX_PLUGIN_REVISION` (`restored`); without that checkout the
 * loader is deleted (`removed`); `failed` when neither worked. ov#284's take-it-out rule (lead
 * ruling, 11 Oct; ov#288 refute M2): a loader that is not the pinned release's exact one is taken
 * out whoever changed it, so its bytes never run and an OFF box keeps no MoralMod loader.
 */
function retireLoaderFile(home: string): "restored" | "removed" | "failed" {
  const runtime = runtimePath(home);
  const upstream = upstreamRuntime(join(home, "plugins", "index-network"));
  if (upstream) {
    const tmp = runtime + "." + randomUUID() + ".tmp";
    try {
      writeFileSync(tmp, upstream, { mode: 0o644, flag: "wx" });
      renameSync(tmp, runtime);
      return "restored";
    } catch {
      rmSync(tmp, { force: true });
    }
  }
  try {
    rmSync(runtime, { force: true });
    return existsSync(runtime) ? "failed" : "removed";
  } catch {
    return "failed";
  }
}
/**
 * What a retirement did. `loader`: what happened to a managed loader in the plugin's negotiator.js
 * (null: none was there). `cleaned`: the other managed files it removed or put back, by short name.
 * `left`: managed files it found and could not remove or put back (the loader included when `failed`).
 */
export interface Retirement {
  loader: "restored" | "removed" | "failed" | null;
  cleaned: string[];
  left: string[];
}
/** Unlink one managed file (a link is unlinked, never followed); absent is fine. */
function unlinkManaged(path: string, label: string, into: Retirement): void {
  try {
    if (lstatSync(path).isDirectory()) {
      into.left.push(label);
      return;
    }
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") into.left.push(label);
    return;
  }
  try {
    rmSync(path, { force: true });
    into.cleaned.push(label);
  } catch {
    into.left.push(label);
  }
}
/** `index/negotiator.ts` is exactly the managed marker an activation writes (a regular file, not a link). */
export function managedHookPresent(home: string): boolean {
  try {
    const path = negotiatorPath(home);
    return lstatSync(path).isFile() && readFileSync(path, "utf8") === marker + "\n";
  } catch {
    return false;
  }
}
/**
 * ov#284 refute M2: take out what an activation wrote into the plugin and the hook, in this order:
 * the managed loader (as `retireLoaderFile`), `index/negotiator.ts` when it is exactly the managed
 * marker (the plugin's own negotiator.js cannot load it: no default export), and the managed
 * `morning.py` (the plugin's own put back, `restoreMorning`). Each is decided on its own bytes,
 * never on a loader hash, and each step is a no-op when its file is already gone, so a run after a
 * half-finished one completes it. The next ON run seeds `NEGOTIATOR_SEED` where the marker was;
 * an activation writes all three again.
 */
export function retireManagedLoader(home: string): Retirement {
  const out: Retirement = { loader: managedLoaderPresent(home) ? retireLoaderFile(home) : null, cleaned: [], left: [] };
  if (out.loader === "failed") out.left.push("the managed loader");
  if (managedHookPresent(home)) unlinkManaged(negotiatorPath(home), "index/negotiator.ts", out);
  const morning = restoreMorning(home);
  if (morning === "restored") out.cleaned.push("morning.py");
  if (morning === "failed") out.left.push("morning.py");
  return out;
}
/**
 * ov#284 refute M1 (ruling R1): an OFF or withdrawn resident keeps no managed MoralMod asset. In
 * this order: `index/moralmod/resident.json` (the resident credential) first; then the loader, the
 * marker hook and the managed `morning.py` (`retireManagedLoader`); `index/moralmod/active.json`; and
 * each installed release directory, `index/moralmod/<64 hex>/`, when it holds only release files
 * (`RELEASE_DIRECTORY_FILES`, bundle files first, `release.json` last, then the empty directory).
 * Files are matched by name and place, not by digest, so a directory an interrupted run (this one,
 * or the control plane's `clean`) half-emptied is finished too. A release directory with anything
 * else in it is left whole (`left`), so the control plane's `clean` can still verify it. Everything
 * else stays: `fallback.sqlite`, journals, queued evidence, staging directories, the control plane's
 * `sources/` and `provisioned.json`, and the resident's own files. Idempotent.
 */
export function retireManagedAssets(home: string): Retirement {
  const root = join(home, "index", "moralmod");
  const out: Retirement = { loader: null, cleaned: [], left: [] };
  // index/moralmod as a link (or a file) is not the installer's: nothing is removed through it.
  let rootIsDirectory = false;
  let rootPresent = true;
  try {
    rootIsDirectory = lstatSync(root).isDirectory();
  } catch {
    rootPresent = false;
  }
  if (rootPresent && !rootIsDirectory) out.left.push("index/moralmod");
  if (rootIsDirectory) unlinkManaged(join(root, "resident.json"), "resident.json", out);
  const hook = retireManagedLoader(home);
  out.loader = hook.loader;
  out.cleaned.push(...hook.cleaned);
  out.left.push(...hook.left);
  if (!rootIsDirectory) return out;
  unlinkManaged(join(root, "active.json"), "active.json", out);
  let names: string[] = [];
  try {
    names = readdirSync(root);
  } catch {
    out.left.push("index/moralmod");
  }
  for (const name of names.filter((n) => SHA256_HEX.test(n)).sort()) {
    const directory = join(root, name);
    const label = `release ${name.slice(0, 8)}`;
    try {
      if (!lstatSync(directory).isDirectory()) continue;
      const entries = readdirSync(directory);
      if (entries.some((e) => !RELEASE_DIRECTORY_FILES.includes(e) || lstatSync(join(directory, e)).isDirectory())) {
        out.left.push(label);
        continue;
      }
      for (const file of RELEASE_DIRECTORY_FILES) rmSync(join(directory, file), { force: true });
      rmdirSync(directory);
      out.cleaned.push(label);
    } catch {
      out.left.push(label);
    }
  }
  return out;
}
/**
 * ov#284 refute S1: `index/moralmod/active.json` is there and does not name `pin` (a sha256) as its
 * `release_digest`: unreadable, not a regular file, or another release (the pin moved or went back
 * to the sentinel). False when there is no active.json.
 */
export function activeReleaseUnpinned(home: string, pin: string): boolean {
  const state = join(home, "index", "moralmod", "active.json");
  try {
    if (!lstatSync(state).isFile()) return true;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
  try {
    const value: unknown = JSON.parse(readFileSync(state, "utf8"));
    return !(SHA256_HEX.test(pin) && !!value && typeof value === "object" && (value as Record<string, unknown>).release_digest === pin);
  } catch {
    return true;
  }
}
export function activateMoralmod(
  home: string,
  release: InstalledRelease,
  config: ResidentConfig,
): void {
  checkResidentHook(home);
  const plugin = join(home, "plugins", "index-network");
  // The installation command pins the checkout; independently verify the observed ref.
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: plugin });
  if (
    result.exitCode !== 0 ||
    result.stdout.toString().trim() !== INDEX_PLUGIN_REVISION
  )
    throw Error("Index plugin revision mismatch");
  const runtime = join(plugin, "runtime", "dist", "negotiator.js");
  regular(runtime);
  const state = join(home, "index", "moralmod", "active.json");
  regular(state);
  const configFile = join(home, "index", "moralmod", "resident.json");
  const entry = managedLoaderSource(home, release.directory);
  // ov#282: a prior attempt can replace the loader before it commits active.json (first activation),
  // or before it commits the new release's active.json (upgrade). The exact loader generated from this
  // verified release is recoverable without its receipt; the managed marker alone never authorizes
  // other bytes, so a customized loader is still refused.
  const entryHash = hash(entry);
  if (existsSync(state)) {
    const previous = JSON.parse(readFileSync(state, "utf8"));
    // The plugin's own file is accepted too: an OFF run or a revoked pin put it back (ov#277 refute S1, S2).
    const current = hash(readFileSync(runtime));
    if (current !== previous.entry_sha256 && current !== entryHash && current !== upstreamRuntimeSha256(plugin))
      throw Error("Managed plugin runtime was modified");
  } else {
    const upstream = Bun.spawnSync(
      ["git", "show", "HEAD:runtime/dist/negotiator.js"],
      { cwd: plugin },
    );
    if (upstream.exitCode !== 0 || !existsSync(runtime)) throw Error("Unowned plugin runtime was modified");
    const current = hash(readFileSync(runtime));
    if (current !== hash(upstream.stdout) && current !== entryHash)
      throw Error("Unowned plugin runtime was modified");
  }
  installMorning(home);
  mkdirSync(join(plugin, "runtime", "dist"), { recursive: true });
  atomic(configFile, JSON.stringify(config) + "\n");
  atomic(runtime, entry);
  atomic(negotiatorPath(home), marker + "\n");
  atomic(
    state,
    JSON.stringify({
      hook_version: release.hookVersion,
      release_digest: release.releaseDigest,
      plugin_revision: INDEX_PLUGIN_REVISION,
      entry_sha256: entryHash,
      installed: true,
      selected: "unverified",
      ready: false,
    }) + "\n",
  );
}
