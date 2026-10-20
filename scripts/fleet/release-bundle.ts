#!/usr/bin/env bun
/**
 * FLEET-AT-SCALE spike (DARK): build and sign one release (design §2a), the job tag-release.yml
 * would gain. Nothing calls it: no workflow, no roll, no installer. It writes three files into
 * --out and touches nothing else (no upload, no tag, no network).
 *
 *   bun scripts/fleet/release-bundle.ts --commit <full sha> --version <vX.Y.Z[-rcN]>
 *       --floor-version <v> --min-updater <v> --not-before <UTC Z> --expires <UTC Z>
 *       --signing-key-file <path to an Ed25519 PKCS#8 PEM> --out <dir> [--repo <dir>]
 *
 * The signing key (the RELEASE key) is read from a file path, never from the environment or argv.
 * D3 (Carter RULED L14276 (2)): in the real build it lives in the GitHub Actions environment
 * `release-sign`, whose required reviewers are Carter plus named maintainers, any ONE of them
 * approving the run; the ROOT key stays offline with Carter and signs only key-rotation statements
 * (release.ts verifyKeyRotation). Setting up that environment is a human act and is not done here.
 * The tests generate throwaway keys in memory and no key is ever committed.
 * Exit codes: 0 written, 1 refused (nothing written), 2 bad usage.
 */
import { spawnSync } from "node:child_process";
import { createPrivateKey, sign as edSign, type KeyObject } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalManifest, COMMIT_RE, parseManifestShape, sha256Hex, type Manifest } from "./release";

export type BuildInput = {
  repoDir: string;
  commit: string;
  version: string;
  floorVersion: string;
  minUpdater: string;
  notBefore: string;
  expires: string;
  signingKey: KeyObject;
  /** zstd level: 19 by default (overlay main df434d46: 10.9 MB tar -> 2.0 MB); tests pass 3. */
  level?: number;
};

export type Built = { manifest: Manifest; manifestBytes: Buffer; signature: string; bundle: Buffer };

/** `git archive` of exactly one full commit id, as tar, zstd-compressed in process. */
export function archiveCommit(repoDir: string, commit: string, level = 19): Buffer {
  if (!COMMIT_RE.test(commit)) throw new Error("commit must be a full 40-hex id");
  const resolved = spawnSync("git", ["-C", repoDir, "rev-parse", "--verify", "--quiet", `${commit}^{commit}`], { encoding: "utf8" });
  if (resolved.status !== 0 || resolved.stdout.trim() !== commit) throw new Error("commit not found in the repository");
  const tar = spawnSync("git", ["-C", repoDir, "archive", "--format=tar", commit], { maxBuffer: 1024 * 1024 * 1024 });
  if (tar.status !== 0 || !tar.stdout?.length) throw new Error("git archive failed");
  return Buffer.from(Bun.zstdCompressSync(tar.stdout, { level }));
}

export function signManifest(manifestBytes: Uint8Array, key: KeyObject): string {
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") throw new Error("signing key must be an Ed25519 private key");
  return edSign(null, Buffer.from(manifestBytes), key).toString("base64");
}

/** Build, then check the manifest against the verifier's own shape rules before returning it. */
export function buildRelease(input: BuildInput): Built {
  const bundle = archiveCommit(input.repoDir, input.commit, input.level ?? 19);
  const draft: Manifest = {
    version: input.version,
    commit: input.commit,
    sha256: sha256Hex(bundle),
    size: bundle.byteLength,
    min_updater: input.minUpdater,
    not_before: input.notBefore,
    expires: input.expires,
    floor_version: input.floorVersion,
  };
  const manifest = parseManifestShape(draft);
  if (!manifest) throw new Error("manifest refused by its own shape check (version, floor, times)");
  const manifestBytes = canonicalManifest(manifest);
  return { manifest, manifestBytes, signature: signManifest(manifestBytes, input.signingKey), bundle };
}

export function writeRelease(outDir: string, built: Built): string[] {
  mkdirSync(outDir, { recursive: true });
  const v = built.manifest.version;
  const files = [`bundle-${v}.tar.zst`, `release-${v}.json`, `release-${v}.json.sig`];
  writeFileSync(join(outDir, files[0]), built.bundle);
  writeFileSync(join(outDir, files[1]), built.manifestBytes);
  writeFileSync(join(outDir, files[2]), built.signature + "\n");
  return files;
}

function parseArgs(argv: string[]): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    const v = argv[i + 1];
    if (!k?.startsWith("--") || v === undefined) return null;
    out[k.slice(2)] = v;
  }
  return out;
}

if (import.meta.main) {
  const a = parseArgs(process.argv.slice(2));
  const need = ["commit", "version", "floor-version", "min-updater", "not-before", "expires", "signing-key-file", "out"];
  if (!a || need.some((k) => !a[k])) {
    console.error(`usage: release-bundle.ts ${need.map((k) => `--${k} <v>`).join(" ")} [--repo <dir>]`);
    process.exit(2);
  }
  try {
    const signingKey = createPrivateKey(readFileSync(a["signing-key-file"]));
    const built = buildRelease({
      repoDir: a.repo ?? ".",
      commit: a.commit,
      version: a.version,
      floorVersion: a["floor-version"],
      minUpdater: a["min-updater"],
      notBefore: a["not-before"],
      expires: a.expires,
      signingKey,
    });
    for (const f of writeRelease(a.out, built)) console.log(join(a.out, f));
    console.log(`size=${built.manifest.size} sha256=${built.manifest.sha256}`);
  } catch (e) {
    console.error(`refused: ${(e as Error).message}`);
    process.exit(1);
  }
}
