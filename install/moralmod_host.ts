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
} from "node:fs";
import { join } from "node:path";
import {
  INDEX_PLUGIN_REVISION,
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
    if (hash(readFileSync(runtime)) !== previous.entry_sha256)
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
  const entry = `${marker}\nimport {readFileSync} from 'node:fs';\nimport {startResident} from ${JSON.stringify(join(release.directory, "negotiator-runtime.js"))};\nconst config=JSON.parse(readFileSync(${JSON.stringify(configFile)},'utf8'));\ntry {\n const resident=await startResident({...process.env,...config,DECISION_JOURNAL_PATH:${JSON.stringify(join(home,"index","moralmod","fallback.sqlite"))}});\n const stop=()=>void resident.stop().finally(()=>process.exit(0));\n process.on('SIGTERM',stop);process.on('SIGINT',stop);\n console.log(JSON.stringify({ready:true,port:resident.port}));\n} catch { console.error(JSON.stringify({level:'warn',event:'moralmod_startup_unready'}));process.exit(1); }\n`;
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
