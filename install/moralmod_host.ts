import { installMorning } from "./moralmod_morning";
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
  rmSync,
} from "node:fs";
import { join } from "node:path";
import {
  INDEX_PLUGIN_REVISION,
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
/** The plugin's own `runtime/dist/negotiator.js` from its checkout at `INDEX_PLUGIN_REVISION`, or null. */
function upstreamRuntime(plugin: string): Uint8Array | null {
  try {
    const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: plugin });
    if (head.exitCode !== 0 || head.stdout.toString().trim() !== INDEX_PLUGIN_REVISION) return null;
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
 * loader is deleted (`removed`); `failed` when neither worked. `active.json`, the release and the
 * resident config stay where they are.
 */
export function retireManagedLoader(home: string): "restored" | "removed" | "failed" {
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
  if (existsSync(state)) {
    const previous = JSON.parse(readFileSync(state, "utf8"));
    // The plugin's own file is accepted too: an OFF run or a revoked pin put it back (ov#277 refute S1, S2).
    const current = hash(readFileSync(runtime));
    if (current !== previous.entry_sha256 && current !== upstreamRuntimeSha256(plugin))
      throw Error("Managed plugin runtime was modified");
  } else {
    const upstream = Bun.spawnSync(
      ["git", "show", "HEAD:runtime/dist/negotiator.js"],
      { cwd: plugin },
    );
    if (
      upstream.exitCode !== 0 ||
      !existsSync(runtime) ||
      hash(readFileSync(runtime)) !== hash(upstream.stdout)
    )
      throw Error("Unowned plugin runtime was modified");
  }
  installMorning(home);
  const configFile = join(home, "index", "moralmod", "resident.json");
  const entry = managedLoaderSource(home, release.directory);
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
      entry_sha256: hash(entry),
      installed: true,
      selected: "unverified",
      ready: false,
    }) + "\n",
  );
}
