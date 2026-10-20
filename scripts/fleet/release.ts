/**
 * FLEET-AT-SCALE spike (DARK): the signed release format and the verifier a box runs before it
 * applies anything. Design: private/handover/lanes-lead/FLEET-AT-SCALE-design.md §2a and §3.
 *
 * A release is three files:
 *   bundle-<v>.tar.zst      `git archive <commit>` compressed with zstd
 *   release-<v>.json        the manifest below, canonical JSON (sorted keys, no spaces) + "\n"
 *   release-<v>.json.sig    a detached Ed25519 signature over the manifest's exact bytes, base64
 *
 * Nothing here runs on a box today: no installer, roll or cp path imports this file. The box-side
 * caller is scripts/fleet/av-updater.ts, itself off unless AV_PULL_UPDATER=1.
 *
 * verifyRelease() refuses anything that is not exactly right, and says why with one closed code:
 * the signature first (over the bytes as received, before any parse), then the manifest's exact
 * shape, the bundle's size and sha256, not_before, expires, min_updater, floor_version (against
 * the manifest's own floor AND the highest floor this box has already verified, so a replayed old
 * release is refused once a newer floor has been seen), and the version the cp asked for.
 */
import { createHash, createPublicKey, verify as edVerify, type KeyObject } from "node:crypto";

/** The tag shape the Roll button takes (scripts/tag-release.ts RELEASE_TAG_RE), and nothing else. */
export const VERSION_RE = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-rc(\d{1,6}))?$/;
export const COMMIT_RE = /^[0-9a-f]{40}$/;
export const SHA256_RE = /^[0-9a-f]{64}$/;
/** UTC, whole seconds, Z: one spelling only, so two manifests never disagree on a time's form. */
export const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/** The manifest's fields, exactly (design §2a). An extra or a missing key is a refusal. */
export const MANIFEST_KEYS = ["commit", "expires", "floor_version", "min_updater", "not_before", "sha256", "size", "version"] as const;
/** A manifest is small; anything bigger is refused before it is parsed. */
export const MAX_MANIFEST_BYTES = 4096;
/** A bundle bigger than this is refused before it is hashed (the overlay archive is ~a few MB). */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

export type Manifest = {
  version: string;
  commit: string;
  sha256: string;
  size: number;
  min_updater: string;
  not_before: string;
  expires: string;
  floor_version: string;
};

export type Refusal =
  | "manifest_too_large"
  | "signature_malformed"
  | "signature_invalid"
  | "manifest_unparsable"
  | "manifest_shape"
  | "version_mismatch"
  | "bundle_too_large"
  | "size_mismatch"
  | "sha256_mismatch"
  | "not_yet_valid"
  | "expired"
  | "updater_too_old"
  | "below_floor"
  | "no_trusted_keys";

export type VerifyResult = { ok: true; manifest: Manifest } | { ok: false; reason: Refusal };

/** Parse a version into a sortable tuple; a final release sorts above every rc of the same x.y.z. */
export function parseVersion(v: string): [number, number, number, number] | null {
  const m = VERSION_RE.exec(v);
  if (!m) return null;
  const rc = m[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), rc];
}

/** -1, 0 or 1. Throws on a malformed version: callers check the shape first. */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error("malformed version");
  for (let i = 0; i < 4; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** The manifest's bytes as signed: keys sorted, no whitespace, one trailing newline. */
export function canonicalManifest(m: Manifest): Buffer {
  const sorted: Record<string, unknown> = {};
  for (const k of MANIFEST_KEYS) sorted[k] = m[k];
  return Buffer.from(JSON.stringify(sorted) + "\n", "utf8");
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Exactly the design's fields with exactly the right types and forms, or null. */
export function parseManifestShape(value: unknown): Manifest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== MANIFEST_KEYS.length || keys.some((k, i) => k !== MANIFEST_KEYS[i])) return null;
  const m = value as Record<string, unknown>;
  const str = (k: string) => (typeof m[k] === "string" ? (m[k] as string) : null);
  const version = str("version"), commit = str("commit"), sha256 = str("sha256");
  const minUpdater = str("min_updater"), notBefore = str("not_before"), expires = str("expires");
  const floor = str("floor_version");
  if (!version || !parseVersion(version)) return null;
  if (!floor || !parseVersion(floor)) return null;
  if (!minUpdater || !parseVersion(minUpdater)) return null;
  if (!commit || !COMMIT_RE.test(commit)) return null;
  if (!sha256 || !SHA256_RE.test(sha256)) return null;
  if (!notBefore || !TIME_RE.test(notBefore) || Number.isNaN(Date.parse(notBefore))) return null;
  if (!expires || !TIME_RE.test(expires) || Number.isNaN(Date.parse(expires))) return null;
  if (Date.parse(expires) <= Date.parse(notBefore)) return null;
  if (typeof m.size !== "number" || !Number.isSafeInteger(m.size) || m.size <= 0) return null;
  // A release's own floor never sits above itself (it could never be applied).
  if (compareVersions(floor, version) > 0) return null;
  return { version, commit, sha256, size: m.size as number, min_updater: minUpdater, not_before: notBefore, expires, floor_version: floor };
}

/** A trusted public key: an Ed25519 KeyObject, or SPKI PEM text. Anything else is not a key. */
export function trustedKey(k: KeyObject | string): KeyObject | null {
  try {
    const key = typeof k === "string" ? createPublicKey(k) : k;
    return key.type === "public" && key.asymmetricKeyType === "ed25519" ? key : null;
  } catch {
    return null;
  }
}

export type VerifyInput = {
  manifestBytes: Uint8Array;
  /** The .sig file's text: base64 of a 64-byte Ed25519 signature (surrounding whitespace allowed). */
  signature: string;
  bundleBytes: Uint8Array;
  /** The release public keys baked into the box (design §3); a root-signed rotation changes them. */
  publicKeys: Array<KeyObject | string>;
  now: Date;
  /** This updater's own version, checked against the manifest's min_updater. */
  updaterVersion: string;
  /** The highest floor_version this box has already verified (persisted; ratchets up only). */
  floorSeen?: string | null;
  /** The version the cp's desired reply named: the manifest must be that release, not another. */
  expectedVersion?: string | null;
};

/** The box's check. Never throws; every failure is one closed code. */
export function verifyRelease(input: VerifyInput): VerifyResult {
  const fail = (reason: Refusal): VerifyResult => ({ ok: false, reason });
  try {
    if (input.manifestBytes.byteLength > MAX_MANIFEST_BYTES) return fail("manifest_too_large");
    const keys = input.publicKeys.map(trustedKey).filter((k): k is KeyObject => k !== null);
    if (keys.length === 0) return fail("no_trusted_keys");
    const sigText = String(input.signature ?? "").trim();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(sigText)) return fail("signature_malformed");
    const sig = Buffer.from(sigText, "base64");
    if (sig.length !== 64) return fail("signature_malformed");
    const data = Buffer.from(input.manifestBytes);
    if (!keys.some((k) => edVerify(null, data, k, sig))) return fail("signature_invalid");

    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      return fail("manifest_unparsable");
    }
    const m = parseManifestShape(parsed);
    if (!m) return fail("manifest_shape");
    // Signed bytes must be the canonical form, so one release has exactly one valid manifest.
    if (!canonicalManifest(m).equals(data)) return fail("manifest_shape");
    if (input.expectedVersion != null && input.expectedVersion !== m.version) return fail("version_mismatch");

    if (input.bundleBytes.byteLength > MAX_BUNDLE_BYTES) return fail("bundle_too_large");
    if (input.bundleBytes.byteLength !== m.size) return fail("size_mismatch");
    if (sha256Hex(input.bundleBytes) !== m.sha256) return fail("sha256_mismatch");

    const now = input.now.getTime();
    if (now < Date.parse(m.not_before)) return fail("not_yet_valid");
    if (now >= Date.parse(m.expires)) return fail("expired");
    if (!parseVersion(input.updaterVersion) || compareVersions(input.updaterVersion, m.min_updater) < 0) return fail("updater_too_old");
    if (compareVersions(m.version, m.floor_version) < 0) return fail("below_floor");
    if (input.floorSeen && parseVersion(input.floorSeen) && compareVersions(m.version, input.floorSeen) < 0) return fail("below_floor");
    return { ok: true, manifest: m };
  } catch {
    return fail("manifest_shape");
  }
}

/* ------------------------------------------------------------------------------------------------
 * Key custody (D3, Carter RULED L14276 (2)). Two keys, two jobs:
 *   - the ROOT key: Ed25519, offline with Carter (plus one sealed backup). It signs ONLY
 *     key-rotation statements, never a release. Its public key is baked into the checkpoint.
 *   - the RELEASE key: Ed25519, in the GitHub Actions environment `release-sign`, whose required
 *     reviewers are Carter plus named maintainers, ANY ONE of them approving a run. It signs only
 *     release manifests (release-bundle.ts), and only from tag-release.yml after the RC-MANIFEST check.
 * The box's verifier trusts the current release key set (TrustStore). Only a statement signed by
 * the root key, with a higher seq than the one the box holds, changes that set. A manifest signed
 * by the root key is refused (the root key is never in the release set), and a rotation signed by
 * a release key is refused (a leaked release key cannot rotate itself in or the root out).
 * ---------------------------------------------------------------------------------------------- */

export const ROTATION_KIND = "av-release-keys";
export const ROTATION_KEYS = ["kind", "not_before", "release_keys", "seq"] as const;
export const MAX_RELEASE_KEYS = 4;

/** What a box persists (in /etc/av, 0600 root, in the real build). */
export type TrustStore = { seq: number; release_keys: string[] };

/** `release_keys` are raw 32-byte Ed25519 public keys, base64url (the JWK `x`). */
export type KeyRotation = { kind: typeof ROTATION_KIND; seq: number; release_keys: string[]; not_before: string };

export type RotationRefusal = "rotation_too_large" | "signature_malformed" | "signature_invalid" | "rotation_unparsable" | "rotation_shape" | "rotation_replayed" | "not_yet_valid" | "no_root_key";

export function canonicalRotation(r: KeyRotation): Buffer {
  return Buffer.from(JSON.stringify({ kind: r.kind, not_before: r.not_before, release_keys: r.release_keys, seq: r.seq }) + "\n", "utf8");
}

/** A raw Ed25519 public key (base64url, 43 chars) as a KeyObject, or null. */
export function rawEd25519(x: string): KeyObject | null {
  if (typeof x !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  try {
    return trustedKey(createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" }));
  } catch {
    return null;
  }
}

/** The raw base64url form of an Ed25519 public KeyObject (what a rotation statement lists). */
export function rawOf(key: KeyObject): string {
  const jwk = key.export({ format: "jwk" }) as { x?: string };
  if (!jwk.x) throw new Error("not an Ed25519 public key");
  return jwk.x;
}

/** The release keys a TrustStore names, ready for verifyRelease's publicKeys. */
export function releaseKeysOf(store: TrustStore): KeyObject[] {
  return store.release_keys.map(rawEd25519).filter((k): k is KeyObject => k !== null);
}

/** Verify a root-signed rotation against the box's store; ok = the new store to persist. Never throws. */
export function verifyKeyRotation(input: {
  statementBytes: Uint8Array;
  signature: string;
  rootPublicKey: KeyObject | string;
  store: TrustStore;
  now: Date;
}): { ok: true; store: TrustStore } | { ok: false; reason: RotationRefusal } {
  const fail = (reason: RotationRefusal) => ({ ok: false as const, reason });
  try {
    if (input.statementBytes.byteLength > MAX_MANIFEST_BYTES) return fail("rotation_too_large");
    const root = trustedKey(input.rootPublicKey);
    if (!root) return fail("no_root_key");
    const sigText = String(input.signature ?? "").trim();
    if (!/^[A-Za-z0-9+/]{86}==$/.test(sigText)) return fail("signature_malformed");
    const data = Buffer.from(input.statementBytes);
    if (!edVerify(null, data, root, Buffer.from(sigText, "base64"))) return fail("signature_invalid");
    let v: unknown;
    try {
      v = JSON.parse(data.toString("utf8"));
    } catch {
      return fail("rotation_unparsable");
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) return fail("rotation_shape");
    const o = v as Record<string, unknown>;
    if (Object.keys(o).sort().join(",") !== ROTATION_KEYS.join(",")) return fail("rotation_shape");
    if (o.kind !== ROTATION_KIND || !Number.isSafeInteger(o.seq) || (o.seq as number) < 1) return fail("rotation_shape");
    if (typeof o.not_before !== "string" || !TIME_RE.test(o.not_before) || Number.isNaN(Date.parse(o.not_before))) return fail("rotation_shape");
    const keys = o.release_keys;
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > MAX_RELEASE_KEYS || new Set(keys).size !== keys.length) return fail("rotation_shape");
    if (keys.some((k) => rawEd25519(k as string) === null)) return fail("rotation_shape");
    // The root key never joins the release set: a release must always be signed by a release key.
    if (keys.includes(rawOf(root))) return fail("rotation_shape");
    const statement = o as unknown as KeyRotation;
    if (!canonicalRotation(statement).equals(data)) return fail("rotation_shape");
    if (statement.seq <= input.store.seq) return fail("rotation_replayed");
    if (input.now.getTime() < Date.parse(statement.not_before)) return fail("not_yet_valid");
    return { ok: true, store: { seq: statement.seq, release_keys: [...statement.release_keys] } };
  } catch {
    return fail("rotation_shape");
  }
}
