/**
 * FLEET-AT-SCALE spike (DARK): the signed release bundle and the box's verifier
 * (scripts/fleet/release.ts, scripts/fleet/release-bundle.ts). Every key here is generated in
 * memory for the test and thrown away; no key is read from or written to the repository.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRelease, writeRelease } from "../fleet/release-bundle";
import { canonicalManifest, canonicalRotation, compareVersions, rawOf, releaseKeysOf, sha256Hex, verifyKeyRotation, verifyRelease, type KeyRotation, type Manifest, type TrustStore } from "../fleet/release";

const REPO = join(import.meta.dir, "..", "..");
const NOW = new Date("2026-10-19T12:00:00Z");
const keys = () => generateKeyPairSync("ed25519");
const pem = (k: ReturnType<typeof keys>["publicKey"]) => k.export({ type: "spki", format: "pem" }).toString();

function git(dir: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.test", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.test" } });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

/** A throwaway one-commit repository, so the tests never depend on this checkout's history. */
function tinyRepo(): { dir: string; commit: string } {
  const dir = mkdtempSync(join(tmpdir(), "fleet-release-"));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "spike\n");
  writeFileSync(join(dir, "install.ts"), "console.log('installer');\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  return { dir, commit: git(dir, "rev-parse", "HEAD") };
}

const base = {
  version: "v2.1.4",
  floorVersion: "v2.1.0",
  minUpdater: "v0.1.0",
  notBefore: "2026-10-19T00:00:00Z",
  expires: "2026-11-02T00:00:00Z",
  level: 3,
};

function build(over: Partial<typeof base> = {}, k = keys()) {
  const { dir, commit } = tinyRepo();
  try {
    const built = buildRelease({ repoDir: dir, commit, signingKey: k.privateKey, ...base, ...over });
    return { built, k, commit };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function check(b: ReturnType<typeof build>, over: Partial<Parameters<typeof verifyRelease>[0]> = {}) {
  return verifyRelease({
    manifestBytes: b.built.manifestBytes,
    signature: b.built.signature,
    bundleBytes: b.built.bundle,
    publicKeys: [pem(b.k.publicKey)],
    now: NOW,
    updaterVersion: "v0.1.0",
    floorSeen: null,
    expectedVersion: b.built.manifest.version,
    ...over,
  });
}

/** Re-sign a hand-edited manifest with the same (trusted) key: proves each later check, not the signature, refuses. */
function resign(b: ReturnType<typeof build>, edit: (m: Manifest) => Manifest) {
  const m = edit({ ...b.built.manifest });
  const bytes = canonicalManifest(m);
  return { manifestBytes: bytes, signature: edSign(null, bytes, b.k.privateKey).toString("base64") };
}

describe("release bundle builder", () => {
  test("writes bundle, canonical manifest with the design's fields, and a detached signature", () => {
    const b = build();
    expect(Object.keys(JSON.parse(b.built.manifestBytes.toString())).sort()).toEqual(
      ["commit", "expires", "floor_version", "min_updater", "not_before", "sha256", "size", "version"],
    );
    expect(b.built.manifest.commit).toBe(b.commit);
    expect(b.built.manifest.size).toBe(b.built.bundle.byteLength);
    expect(b.built.manifest.sha256).toBe(sha256Hex(b.built.bundle));
    // The bundle is zstd(git archive): it unpacks to the commit's files.
    const tar = Bun.zstdDecompressSync(b.built.bundle);
    const list = spawnSync("tar", ["-t", "-f", "-"], { input: tar, encoding: "utf8" });
    expect(list.stdout.split("\n").filter(Boolean).sort()).toEqual(["README.md", "install.ts"]);
    const out = mkdtempSync(join(tmpdir(), "fleet-out-"));
    try {
      expect(writeRelease(out, b.built)).toEqual(["bundle-v2.1.4.tar.zst", "release-v2.1.4.json", "release-v2.1.4.json.sig"]);
      expect(readFileSync(join(out, "release-v2.1.4.json")).equals(b.built.manifestBytes)).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("refuses a short or unknown commit, a floor above the version, expires before not_before", () => {
    const { dir, commit } = tinyRepo();
    const k = keys();
    try {
      const go = (over: Record<string, unknown>) => () => buildRelease({ repoDir: dir, commit, signingKey: k.privateKey, ...base, ...over } as never);
      expect(go({ commit: commit.slice(0, 12) })).toThrow();
      expect(go({ commit: "0".repeat(40) })).toThrow();
      expect(go({ floorVersion: "v2.2.0" })).toThrow();
      expect(go({ expires: "2026-10-18T00:00:00Z" })).toThrow();
      expect(go({ version: "2.1.4" })).toThrow();
      expect(go({ signingKey: k.publicKey })).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI exits 2 on bad usage and writes nothing", () => {
    const r = spawnSync("bun", [join(REPO, "scripts", "fleet", "release-bundle.ts"), "--commit"], { encoding: "utf8" });
    expect(r.status).toBe(2);
  });
});

describe("box verifier", () => {
  test("accepts a correct release", () => {
    const r = check(build());
    expect(r.ok).toBe(true);
  });

  test("refuses a tampered bundle (one byte changed, same length)", () => {
    const b = build();
    const bundle = Buffer.from(b.built.bundle);
    bundle[bundle.length - 1] ^= 0xff;
    expect(check(b, { bundleBytes: bundle })).toEqual({ ok: false, reason: "sha256_mismatch" });
  });

  test("refuses a bundle of another length", () => {
    const b = build();
    expect(check(b, { bundleBytes: Buffer.concat([b.built.bundle, Buffer.from([0])]) })).toEqual({ ok: false, reason: "size_mismatch" });
  });

  test("refuses a tampered manifest (sha256 swapped to match a planted bundle)", () => {
    const b = build();
    const planted = Buffer.from("evil");
    const m = JSON.parse(b.built.manifestBytes.toString());
    m.sha256 = sha256Hex(planted);
    m.size = planted.length;
    const bytes = canonicalManifest(m);
    expect(check(b, { manifestBytes: bytes, bundleBytes: planted })).toEqual({ ok: false, reason: "signature_invalid" });
  });

  test("refuses a signature by the wrong key, and an empty or non-Ed25519 trust list", () => {
    const b = build();
    const other = keys();
    expect(check(b, { publicKeys: [pem(other.publicKey)] })).toEqual({ ok: false, reason: "signature_invalid" });
    expect(check(b, { publicKeys: [] })).toEqual({ ok: false, reason: "no_trusted_keys" });
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect(check(b, { publicKeys: [rsa, "not a key"] })).toEqual({ ok: false, reason: "no_trusted_keys" });
    // A rotated key set that still holds the signing key accepts.
    expect(check(b, { publicKeys: [pem(other.publicKey), pem(b.k.publicKey)] }).ok).toBe(true);
  });

  test("refuses a malformed signature", () => {
    const b = build();
    expect(check(b, { signature: "" })).toEqual({ ok: false, reason: "signature_malformed" });
    expect(check(b, { signature: b.built.signature.slice(4) })).toEqual({ ok: false, reason: "signature_malformed" });
  });

  test("refuses an expired release, and one not yet valid", () => {
    const b = build();
    expect(check(b, { now: new Date("2026-11-02T00:00:00Z") })).toEqual({ ok: false, reason: "expired" });
    expect(check(b, { now: new Date("2026-11-05T00:00:00Z") })).toEqual({ ok: false, reason: "expired" });
    expect(check(b, { now: new Date("2026-10-18T23:59:59Z") })).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  test("refuses a release below its floor (a re-signed manifest cannot get past the floor check)", () => {
    const b = build();
    // The builder refuses floor > version; a hand-made manifest that does it is refused by shape.
    const r = resign(b, (m) => ({ ...m, floor_version: "v9.0.0" }));
    expect(check(b, r)).toEqual({ ok: false, reason: "manifest_shape" });
  });

  test("refuses a replay of an older, validly signed release once a newer floor was applied", () => {
    const k = keys();
    const old = build({ version: "v2.1.0", floorVersion: "v2.0.0" }, k);
    // The box has applied v2.1.4 whose floor is v2.1.2: v2.1.0 is still signed and unexpired.
    expect(check(old, { floorSeen: "v2.1.2" })).toEqual({ ok: false, reason: "below_floor" });
    // Without that floor it would have passed (the refusal is the floor, nothing else).
    expect(check(old).ok).toBe(true);
    // Carter's revert target at or above the floor still verifies (D2 keeps revert possible).
    const revert = build({ version: "v2.1.2", floorVersion: "v2.1.0" }, k);
    expect(check(revert, { floorSeen: "v2.1.2" }).ok).toBe(true);
  });

  test("refuses a manifest for another version than the cp asked for (a swapped-in old release)", () => {
    const b = build();
    expect(check(b, { expectedVersion: "v2.1.5" })).toEqual({ ok: false, reason: "version_mismatch" });
  });

  test("refuses an updater older than min_updater", () => {
    const b = build({ minUpdater: "v0.2.0" });
    expect(check(b)).toEqual({ ok: false, reason: "updater_too_old" });
  });

  test("refuses any extra, missing or non-canonical field even when signed", () => {
    const b = build();
    const extra = canonicalManifest(b.built.manifest).toString().replace("{", '{"cmd":"rm -rf /",');
    const sigExtra = edSign(null, Buffer.from(extra), b.k.privateKey).toString("base64");
    expect(check(b, { manifestBytes: Buffer.from(extra), signature: sigExtra })).toEqual({ ok: false, reason: "manifest_shape" });
    const pretty = Buffer.from(JSON.stringify(b.built.manifest, null, 2));
    expect(check(b, { manifestBytes: pretty, signature: edSign(null, pretty, b.k.privateKey).toString("base64") })).toEqual({ ok: false, reason: "manifest_shape" });
    const junk = Buffer.from("not json");
    expect(check(b, { manifestBytes: junk, signature: edSign(null, junk, b.k.privateKey).toString("base64") })).toEqual({ ok: false, reason: "manifest_unparsable" });
    expect(check(b, { manifestBytes: Buffer.alloc(5000, 32) })).toEqual({ ok: false, reason: "manifest_too_large" });
  });

  test("version order: a final release sorts above its rcs", () => {
    expect(compareVersions("v2.1.0", "v2.1.0-rc44")).toBe(1);
    expect(compareVersions("v2.0.0-rc9", "v2.0.0-rc44")).toBe(-1);
    expect(compareVersions("v2.1.10", "v2.1.9")).toBe(1);
    expect(compareVersions("v2.1.3", "v2.1.3")).toBe(0);
  });

  test("this checkout's own HEAD builds and verifies end to end", () => {
    const k = keys();
    const commit = git(REPO, "rev-parse", "HEAD");
    const built = buildRelease({ repoDir: REPO, commit, signingKey: k.privateKey, ...base });
    expect(built.manifest.size).toBeGreaterThan(0);
    const r = verifyRelease({
      manifestBytes: built.manifestBytes,
      signature: built.signature,
      bundleBytes: built.bundle,
      publicKeys: [pem(k.publicKey)],
      now: NOW,
      updaterVersion: "v0.1.0",
      expectedVersion: "v2.1.4",
    });
    expect(r.ok).toBe(true);
  });
});

describe("key custody (D3): root signs rotations only, release key signs releases only", () => {
  const root = keys();
  const rel1 = keys();
  const rel2 = keys();
  const store: TrustStore = { seq: 1, release_keys: [rawOf(rel1.publicKey)] };
  const rotation = (over: Partial<KeyRotation> = {}): KeyRotation => ({ kind: "av-release-keys", seq: 2, release_keys: [rawOf(rel2.publicKey)], not_before: "2026-10-19T00:00:00Z", ...over });
  const signed = (r: KeyRotation, by = root.privateKey) => {
    const statementBytes = canonicalRotation(r);
    return { statementBytes, signature: edSign(null, statementBytes, by).toString("base64") };
  };
  const rotate = (r: { statementBytes: Buffer; signature: string }, st = store) => verifyKeyRotation({ ...r, rootPublicKey: pem(root.publicKey), store: st, now: NOW });

  test("a root-signed rotation with a higher seq replaces the release set; releases then verify under the new key only", () => {
    const out = rotate(signed(rotation()));
    expect(out).toEqual({ ok: true, store: { seq: 2, release_keys: [rawOf(rel2.publicKey)] } });
    const newStore = (out as { ok: true; store: TrustStore }).store;
    const byNew = build({}, rel2);
    const byOld = build({}, rel1);
    expect(check(byNew, { publicKeys: releaseKeysOf(newStore) }).ok).toBe(true);
    expect(check(byOld, { publicKeys: releaseKeysOf(newStore) })).toEqual({ ok: false, reason: "signature_invalid" });
    expect(check(byOld, { publicKeys: releaseKeysOf(store) }).ok).toBe(true);
  });

  test("a rotation signed by a release key (a leaked release key rotating itself) is refused", () => {
    expect(rotate(signed(rotation(), rel1.privateKey))).toEqual({ ok: false, reason: "signature_invalid" });
  });

  test("a replayed or same-seq rotation is refused", () => {
    expect(rotate(signed(rotation({ seq: 1 })))).toEqual({ ok: false, reason: "rotation_replayed" });
    expect(rotate(signed(rotation({ seq: 2 })), { seq: 5, release_keys: store.release_keys })).toEqual({ ok: false, reason: "rotation_replayed" });
  });

  test("a rotation that lists the root key itself, an empty or bad key list, or a future not_before is refused", () => {
    expect(rotate(signed(rotation({ release_keys: [rawOf(root.publicKey)] })))).toEqual({ ok: false, reason: "rotation_shape" });
    expect(rotate(signed(rotation({ release_keys: [] })))).toEqual({ ok: false, reason: "rotation_shape" });
    expect(rotate(signed(rotation({ release_keys: ["not+a+key"] })))).toEqual({ ok: false, reason: "rotation_shape" });
    expect(rotate(signed(rotation({ not_before: "2026-10-20T00:00:00Z" })))).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  test("a release manifest signed by the root key is refused: the root key is never a release key", () => {
    const byRoot = build({}, root);
    expect(check(byRoot, { publicKeys: releaseKeysOf(store) })).toEqual({ ok: false, reason: "signature_invalid" });
  });
});
