/** Install a reviewed shared lifecycle bundle without changing resident customization.
 * This prepares files only. The V2 host must complete authority/readiness checks
 * before subscribing to Index; the legacy post-brief hook is deliberately refused.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MORALMOD_HOOK_VERSION = "moralmod-lifecycle-2";
export const INDEX_PLUGIN_REVISION = "04d833b840541fedabe78cbdad306c18853d784a";
/**
 * OV-249 post-hoc M2: the sha256 of the one reviewed MoralMod release's `release.json`, pinned here
 * as `INDEX_PLUGIN_REF` pins the plugin. `release.json` lists the sha256 of every bundle file, so
 * this one digest pins the whole bundle. A release whose `release.json` hashes to anything else is
 * refused before it is parsed (`MoralmodReleaseUnpinned`), however consistent its own hashes are.
 * Until the reviewed digest is supplied this is a sentinel that is not a sha256 and matches no
 * file, so no bundle activates. Moving it is a PR that changes this constant
 * (docs/moralmod_lifecycle.md, "The release pin").
 */
export const MORALMOD_RELEASE_SHA256 = "unpinned: no reviewed MoralMod release yet";
const FILES = ["negotiator-core.js", "negotiator-runtime.js", "INDEX-LICENSE"] as const;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const regular = (path: string) => { if (existsSync(path) && !lstatSync(path).isFile()) throw new Error("MoralMod managed path must be a regular file"); };
function atomic(path: string, value: string | Uint8Array) {
  regular(path); const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, value, { mode: 0o600, flag: "wx" }); renameSync(temp, path);
}
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** The release's `release.json` is not the one pinned in `MORALMOD_RELEASE_SHA256` (or no release is pinned). */
export class MoralmodReleaseUnpinned extends Error {
  constructor() {
    super("MoralMod release is not the pinned release");
    this.name = "MoralmodReleaseUnpinned";
  }
}
export interface InstalledRelease { hookVersion: string; releaseDigest: string; directory: string; changed: boolean }

/** @param pin - The expected sha256 of `release.json` (a seam for tests; production passes none). */
export function installMoralmodRelease(home: string, source: string, pin: string = MORALMOD_RELEASE_SHA256): InstalledRelease {
  // Pinned first, over the bytes as `shasum -a 256 release.json` reads them: an unreviewed manifest
  // is never trusted for the file digests that follow.
  const manifestBytes = readFileSync(join(source, "release.json"));
  if (!SHA256_HEX.test(pin) || hash(manifestBytes) !== pin) throw new MoralmodReleaseUnpinned();
  const raw = manifestBytes.toString("utf8");
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
  const releaseDigest = hash(manifestBytes), directory = join(home, "index", "moralmod", releaseDigest);
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
    atomic(join(staging, "release.json"), manifestBytes);
    try { renameSync(staging, directory); }
    catch (error) {
      // Concurrent identical installers may race; reverify the winner's bytes.
      if (!existsSync(directory)) throw error;
      return installMoralmodRelease(home, source, pin);
    }
  } finally { rmSync(staging, { recursive: true, force: true }); }
  // Do not select an agent or claim readiness here. The host adapter owns activation.
  return { hookVersion: MORALMOD_HOOK_VERSION, releaseDigest, directory, changed: true };
}
