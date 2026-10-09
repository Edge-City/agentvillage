/** Install a reviewed shared lifecycle bundle without changing resident customization.
 * This prepares files only. The V2 host must complete authority/readiness checks
 * before subscribing to Index; the legacy post-brief hook is deliberately refused.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MORALMOD_HOOK_VERSION = "moralmod-lifecycle-2";
export const INDEX_PLUGIN_REVISION = "eaec4fc02ffc251fca2cfd56b728c845562f6a3b";
const FILES = ["negotiator-core.js", "negotiator-runtime.js", "INDEX-LICENSE"] as const;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const regular = (path: string) => { if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("MoralMod managed path must be a regular file"); };
function atomic(path: string, value: string | Uint8Array) {
  regular(path); const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode: 0o600, flag: "wx" }); renameSync(temp, path);
}
export interface InstalledRelease { hookVersion: string; releaseDigest: string; directory: string; changed: boolean }

export function installMoralmodRelease(home: string, source: string): InstalledRelease {
  const raw = readFileSync(join(source, "release.json"), "utf8");
  const manifest: unknown = JSON.parse(raw);
  if (!object(manifest) || manifest.schema !== "moralmod-negotiator-release-1"
      || manifest.hook_version !== MORALMOD_HOOK_VERSION || manifest.hermes_plugin_revision !== INDEX_PLUGIN_REVISION
      || manifest.bun_version !== "1.4.2" || manifest.bun_version !== Bun.version || !object(manifest.files)
      || Object.keys(manifest.files).sort().join() !== [...FILES].sort().join()) throw new Error("Incompatible MoralMod release");
  const expected = manifest.files;
  const files = FILES.map(name => {
    regular(join(source, name)); const bytes = readFileSync(join(source, name));
    if (hash(bytes) !== expected[name]) throw new Error("MoralMod release digest mismatch");
    return { name, bytes };
  });
  const releaseDigest = hash(raw), directory = join(home, "index", "moralmod", releaseDigest);
  const parent = join(home, "index", "moralmod");
  for (const path of [home, join(home, "index"), parent, directory]) {
    if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) throw new Error("MoralMod managed directory is unsafe");
  }
  // Content-addressed install. Verify all existing bytes; never overwrite a customized release.
  if (existsSync(directory)) {
    for (const { name, bytes } of files) { regular(join(directory, name)); if (hash(readFileSync(join(directory, name))) !== hash(bytes)) throw new Error("Managed MoralMod release was modified"); }
    regular(join(directory, "release.json"));
    if (readFileSync(join(directory, "release.json"), "utf8") !== raw) throw new Error("Managed MoralMod manifest was modified");
    return { hookVersion: MORALMOD_HOOK_VERSION, releaseDigest, directory, changed: false };
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = join(parent, `.${randomUUID()}.staging`); mkdirSync(staging, { mode: 0o700 });
  try {
    for (const { name, bytes } of files) atomic(join(staging, name), bytes);
    atomic(join(staging, "release.json"), raw);
    try { renameSync(staging, directory); }
    catch (error) {
      // Concurrent identical installers may race; reverify the winner's bytes.
      if (!existsSync(directory)) throw error;
      return installMoralmodRelease(home, source);
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  // Do not select an agent or claim readiness here. The host adapter owns activation.
  return { hookVersion: MORALMOD_HOOK_VERSION, releaseDigest, directory, changed: true };
}
