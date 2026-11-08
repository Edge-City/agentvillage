/**
 * Shared pieces of the nap archive (`install/nap-archive.ts`) and its restore (`install/restore-state.ts`):
 * the formats (`state_manifest.v1`, `files.json`, the run file, the data-key file, `progress.json`), the
 * USTAR writer and streaming reader, the one transport interface, and a direct HTTP client.
 *
 * Package-free (`node:` modules only): the box runs both scripts as `bun --no-env-file --no-install`.
 * Nothing here prints a path, a URL, a token or file content.
 */

import { createHash, type KeyObject, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, readSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, fstatSync } from "node:fs";
import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

export const MANIFEST_SCHEMA = "state_manifest.v1";
export const FILES_SCHEMA = "nap_files.v1";
export const RUN_SCHEMA = "nap_run.v1";
export const KEY_SCHEMA = "nap_key.v1";
export const PROGRESS_SCHEMA = "nap_progress.v1";
/** The cipher suite, recorded in every manifest. A new key pair or cipher is a new string (design 4.3). */
export const CIPHER_MODE = "nap-v1 aes-256-gcm/rsa-oaep-sha256";
export const TRANSPORT_PRESIGNED = "presigned";
/** The `files.json` entry, the first entry of every payload tar. */
export const FILES_ENTRY = "files.json";
/** The fixed name of the manifest's upload slot (a presigned URL cannot name bytes not yet written). */
export const MANIFEST_SLOT_NAME = "state_manifest.json";
export const CHUNK_NAME = /^chunk-([0-9]{4,6})\.bin$/;
export const HEX64 = /^[0-9a-f]{64}$/;
export const HEX40 = /^[0-9a-f]{40}$/;
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
export const REASON = /^[a-z][a-z0-9_]{0,63}$/;
export const VERSION_TEXT = /^[0-9A-Za-z.+_-]{1,64}$/;
/** Largest `files.json` either side accepts. */
export const MAX_FILES_JSON_BYTES = 64 * 1024 * 1024;
/** Largest run, key or manifest document either side reads. */
export const MAX_DOC_BYTES = 8 * 1024 * 1024;
/** USTAR's 11 octal digits. */
export const MAX_TAR_ENTRY_BYTES = 8 ** 11 - 1;

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
export const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export const pad = (n: number, width = 4) => String(n).padStart(width, "0");
export const chunkName = (n: number) => `chunk-${pad(n)}.bin`;
export const manifestName = (sha: string) => `state_manifest.${sha}.json`;

/** A refusal or failure with a reason code; the code is the only thing any output carries. */
export class NapError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function fail(code: string): never {
  throw new NapError(code);
}

// ---------------------------------------------------------------------------------------------------------
// files.json and the manifest
// ---------------------------------------------------------------------------------------------------------

export type FileEntry = {
  path: string;
  /** Regular file: its size; link: the byte length of its target. */
  bytes: number;
  /** Regular file: its SHA-256; link: the SHA-256 of its target text. */
  sha256: string;
  mtime_ms: number;
  mode: number;
  class: "state" | "secret_cp" | "secret_box" | "unclassified" | "link" | "log" | "dir";
  /** Links only. */
  target?: string;
  /** A hard link of an earlier entry: no data of its own in the tar. */
  same_as?: string;
  /** An approvald store member (`/var/lib/approvald/<t>/<member>`): its bytes ride inside the store tar
   * entry this names, so it has no data entry of its own (review-a S-n2). */
  member_of?: string;
};
export type FilesDoc = { schema: string; files: FileEntry[] };

/** Index in `files.json` → the tar entry name of its data. */
export const dataEntryName = (index: number) => `data/${pad(index, 6)}`;
/** Whether an entry has its own data entry in the tar (regular files that are not a later hard link). */
export const hasData = (f: FileEntry) => f.class !== "link" && f.class !== "dir" && f.same_as === undefined && f.member_of === undefined;
/** A directory's entry carries no bytes: size 0 and the SHA-256 of nothing. */
export const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export type ManifestChunk = { n: number; name: string; bytes: number; sha256: string };
export type ExcludedCounts = Record<string, { files: number; bytes: number }>;
export type Manifest = {
  schema: string;
  tenant_id: string;
  date: string;
  run_id: string;
  created_at: string;
  transport: string;
  prefix: string;
  served: { overlay_commit: string; hermes_version: string | null; approvald_version: string | null };
  /** The pinned nap bundle this ran from (review-a S-n4; `BUNDLE_FILES`), and the path rules it walked by. */
  tool_sha256: string;
  paths_sha256: string;
  mode: string;
  /** SHA-256 of the wrapping public key's SPKI DER: which key pair opens this archive (13 N2). */
  key_id: string;
  wrapped_key_b64: string;
  iv_b64: string;
  gcm_tag_b64: string;
  payload: {
    sha256: string;
    bytes: number;
    file_count: number;
    total_file_bytes: number;
    secret_cp_count: number;
    secret_box_count: number;
    unclassified_count: number;
    link_count: number;
    log_count: number;
    /** Directories recorded (Fable S2). */
    dir_count: number;
  };
  /** The script's own count of the walked tree (13 M2 support), the per-exclude counts, the WAL fold. */
  tree: {
    /** Regular files and symlinks (a link's bytes are its target's length). */
    live_files: number;
    live_bytes: number;
    /** Directories under the root, the root itself not counted (Fable S2). */
    live_dirs: number;
    excluded: ExcludedCounts;
    db_count: number;
    wal_folded: number;
    /** How many approvald token files the root piece left out (their names never; 13 S4). */
    approvald_secret_names: number | null;
    /** The approvald store's members, as listed in `files.json` (review-a S-n2: the root count's parity). */
    approvald_files: number;
    approvald_bytes: number;
    /** Browser-profile files left out (review-a N-n3), and whether any were. */
    browser_profile_files: number;
    browser_profile_dropped: boolean;
  };
  chunks: ManifestChunk[];
};

/** Every key a manifest carries, at each level (design v2 4.2). Provider-neutral (12 W5): no Railway id,
 * checkpoint name or sandbox path, ever; those live only in the control plane's `naps` table. */
export const MANIFEST_KEYS = [
  "schema", "tenant_id", "date", "run_id", "created_at", "transport", "prefix", "served", "tool_sha256", "paths_sha256", "mode", "key_id",
  "wrapped_key_b64", "iv_b64", "gcm_tag_b64", "payload", "tree", "chunks",
] as const;
export const MANIFEST_SERVED_KEYS = ["overlay_commit", "hermes_version", "approvald_version"] as const;
export const MANIFEST_PAYLOAD_KEYS = [
  "sha256", "bytes", "file_count", "total_file_bytes", "secret_cp_count", "secret_box_count", "unclassified_count", "link_count", "log_count", "dir_count",
] as const;
export const MANIFEST_TREE_KEYS = [
  "live_files", "live_bytes", "live_dirs", "excluded", "db_count", "wal_folded", "approvald_secret_names", "approvald_files", "approvald_bytes",
  "browser_profile_files", "browser_profile_dropped",
] as const;
const EXCLUDE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function runPrefix(tenant: string, date: string, runId: string): string {
  return `nap/${tenant}/${date}/${runId}/`;
}

const PREFIX = /^nap\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([0-9]{4}-[0-9]{2}-[0-9]{2})\/([0-9a-f-]{36})\/$/;
export function parsePrefix(prefix: string): { tenant: string; date: string; runId: string } | null {
  const m = typeof prefix === "string" ? PREFIX.exec(prefix) : null;
  if (!m || !UUID.test(m[3])) return null;
  return { tenant: m[1], date: m[2], runId: m[3] };
}

const MANIFEST_KEY = /^(nap\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[0-9]{4}-[0-9]{2}-[0-9]{2}\/[0-9a-f-]{36}\/)state_manifest\.([0-9a-f]{64})\.json$/;
/** `nap/<tenant>/<date>/<run>/state_manifest.<sha256>.json` → its prefix and sha. */
export function parseManifestKey(key: string): { prefix: string; sha: string; tenant: string; date: string; runId: string } | null {
  const m = typeof key === "string" ? MANIFEST_KEY.exec(key) : null;
  if (!m) return null;
  const p = parsePrefix(m[1]);
  return p ? { prefix: m[1], sha: m[2], ...p } : null;
}

const exactKeys = (obj: unknown, keys: readonly string[]) =>
  !!obj && typeof obj === "object" && !Array.isArray(obj) &&
  Object.keys(obj as object).length === keys.length && keys.every((k) => Object.hasOwn(obj as object, k));

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Parse a manifest's bytes and check its shape against the key it was fetched as. Refuses (throws). */
export function parseManifest(bytes: Uint8Array, key: string, tenant: string): Manifest {
  const k = parseManifestKey(key);
  if (!k) fail("manifest_key_invalid");
  if (k.tenant !== tenant) fail("manifest_mismatch");
  if (sha256(bytes) !== k.sha) fail("manifest_hash_mismatch");
  let doc: Manifest;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("manifest_unreadable");
  }
  if (!exactKeys(doc, MANIFEST_KEYS)) fail("manifest_invalid");
  if (doc.schema !== MANIFEST_SCHEMA) fail("manifest_schema");
  if (doc.tenant_id !== tenant || doc.date !== k.date || doc.run_id !== k.runId || doc.prefix !== k.prefix) {
    fail("manifest_mismatch");
  }
  if (doc.transport !== TRANSPORT_PRESIGNED) fail("manifest_transport");
  if (doc.mode !== CIPHER_MODE) fail("manifest_mode");
  if (!exactKeys(doc.served, MANIFEST_SERVED_KEYS) || !HEX40.test(doc.served.overlay_commit)) fail("manifest_invalid");
  if (typeof doc.tool_sha256 !== "string" || !HEX64.test(doc.tool_sha256)) fail("manifest_invalid");
  if (typeof doc.paths_sha256 !== "string" || !HEX64.test(doc.paths_sha256)) fail("manifest_invalid");
  for (const b of [doc.wrapped_key_b64, doc.iv_b64, doc.gcm_tag_b64]) if (typeof b !== "string" || !B64.test(b)) fail("manifest_invalid");
  if (Buffer.from(doc.iv_b64, "base64").length !== 12 || Buffer.from(doc.gcm_tag_b64, "base64").length !== 16) fail("manifest_invalid");
  if (typeof doc.key_id !== "string" || !HEX64.test(doc.key_id)) fail("manifest_invalid");
  const p = doc.payload;
  if (!exactKeys(p, MANIFEST_PAYLOAD_KEYS) || !HEX64.test(p.sha256)) fail("manifest_invalid");
  for (const k of MANIFEST_PAYLOAD_KEYS) if (k !== "sha256" && !isInt(p[k])) fail("manifest_invalid");
  const t = doc.tree;
  if (!exactKeys(t, MANIFEST_TREE_KEYS) || !isInt(t.live_files) || !isInt(t.live_bytes) || !isInt(t.db_count) || !isInt(t.wal_folded)) {
    fail("manifest_invalid");
  }
  if (t.approvald_secret_names !== null && !isInt(t.approvald_secret_names)) fail("manifest_invalid");
  if (!isInt(t.live_dirs) || !isInt(t.approvald_files) || !isInt(t.approvald_bytes) || !isInt(t.browser_profile_files)) fail("manifest_invalid");
  if (t.browser_profile_dropped !== t.browser_profile_files > 0) fail("manifest_invalid");
  if (!t.excluded || typeof t.excluded !== "object" || Array.isArray(t.excluded)) fail("manifest_invalid");
  for (const [name, c] of Object.entries(t.excluded)) {
    if (!EXCLUDE_NAME.test(name) || !exactKeys(c, ["files", "bytes"]) || !isInt(c.files) || !isInt(c.bytes)) fail("manifest_invalid");
  }
  if (!Array.isArray(doc.chunks) || doc.chunks.length === 0) fail("manifest_invalid");
  let total = 0;
  doc.chunks.forEach((c, i) => {
    if (!exactKeys(c, ["n", "name", "bytes", "sha256"]) || c.n !== i || c.name !== chunkName(i) || !isInt(c.bytes) ||
      c.bytes === 0 || !HEX64.test(c.sha256)) fail("manifest_invalid");
    total += c.bytes;
  });
  // AES-GCM: the ciphertext is exactly as long as the plaintext payload.
  if (total !== p.bytes) fail("counts_mismatch");
  return doc;
}

// ---------------------------------------------------------------------------------------------------------
// The run file (presigned URLs, staged 0600 by the control plane) and the data-key file
// ---------------------------------------------------------------------------------------------------------

export type RunFile = {
  schema: string;
  direction: "put" | "get";
  tenant_id: string;
  run_id: string;
  prefix: string;
  expires_at?: string;
  manifest: { url: string };
  chunks: { name: string; url: string }[];
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** restore-memory.ts's `backupUrlAllowed` rule (https anywhere; http only to `*.railway.internal` or the
 * local machine; no userinfo, no fragment), with a query allowed (a presigned URL's signature rides
 * there), and the URL's path must end with the object key it is staged for. */
export function presignedUrlAllowed(url: string, objectKeys: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (url !== url.trim() || u.username || u.password || u.hash) return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  if (u.protocol === "http:") {
    if (!LOCAL_HOSTS.has(host) && !host.endsWith(".railway.internal")) return false;
  } else if (u.protocol !== "https:") return false;
  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return false;
  }
  return objectKeys.some((key) => path.endsWith(`/${key}`));
}

/** Refuse anything but a regular, non-symlink file that only its owner can read or write. */
export function readPrivateFile(path: string, missing: string, invalid: string, modeCode: string): Uint8Array {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    fail(missing);
  }
  if (!st.isFile()) fail(invalid);
  if ((st.mode & 0o077) !== 0) fail(modeCode);
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) fail(modeCode);
  if (st.size > MAX_DOC_BYTES) fail(invalid);
  const fd = openSync(path, "r");
  try {
    const f = fstatSync(fd);
    if (f.ino !== st.ino || f.dev !== st.dev) fail(invalid);
    const buf = Buffer.alloc(f.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/** Parse and check a run file for `direction`, `tenant` and `runId`. Every URL must be allowed and must end
 * with the object key it is staged for: chunk `n` at `<prefix>chunk-<nnnn>.bin`, the manifest at one of
 * `manifestNames` under the prefix. */
export function parseRunFile(
  bytes: Uint8Array,
  want: { direction: "put" | "get"; tenant: string; runId: string; manifestNames: string[] },
): RunFile {
  let doc: RunFile;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("run_file_invalid");
  }
  if (!doc || typeof doc !== "object" || doc.schema !== RUN_SCHEMA || doc.direction !== want.direction) fail("run_file_invalid");
  const p = parsePrefix(doc.prefix);
  if (!p || doc.tenant_id !== p.tenant || doc.run_id !== p.runId) fail("run_file_invalid");
  if (doc.tenant_id !== want.tenant || doc.run_id !== want.runId) fail("run_file_mismatch");
  if (!doc.manifest || typeof doc.manifest.url !== "string" || !Array.isArray(doc.chunks)) fail("run_file_invalid");
  if (!presignedUrlAllowed(doc.manifest.url, want.manifestNames.map((n) => `${doc.prefix}${n}`))) fail("url_not_allowed");
  doc.chunks.forEach((c, i) => {
    if (!c || typeof c.name !== "string" || typeof c.url !== "string" || c.name !== chunkName(i)) fail("run_file_invalid");
    if (!presignedUrlAllowed(c.url, [`${doc.prefix}${c.name}`])) fail("url_not_allowed");
  });
  if (doc.chunks.length === 0) fail("run_file_invalid");
  return doc;
}

/** The data key and IV the control plane unwrapped in-process (design 12, M2): the only key material a
 * restore ever receives, from a 0600 file or stdin, never the environment. */
export type DataKey = { key: Buffer; iv: Buffer };
export function parseKeyDoc(bytes: Uint8Array): DataKey {
  let doc: { schema?: unknown; data_key_b64?: unknown; iv_b64?: unknown };
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    fail("data_key_invalid");
  }
  if (!exactKeys(doc, ["schema", "data_key_b64", "iv_b64"]) || doc.schema !== KEY_SCHEMA) fail("data_key_invalid");
  if (typeof doc.data_key_b64 !== "string" || typeof doc.iv_b64 !== "string" || !B64.test(doc.data_key_b64) || !B64.test(doc.iv_b64)) {
    fail("data_key_invalid");
  }
  const key = Buffer.from(doc.data_key_b64, "base64");
  const iv = Buffer.from(doc.iv_b64, "base64");
  if (key.length !== 32 || iv.length !== 12) fail("data_key_invalid");
  return { key, iv };
}

// ---------------------------------------------------------------------------------------------------------
// Files on the box
// ---------------------------------------------------------------------------------------------------------

/** Write JSON by temp file and rename (mode 0600), as restore-memory.ts writes its marker. */
export function writeJsonAtomic(path: string, doc: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(path), `.${path.slice(dirname(path).length + 1)}.${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, JSON.stringify(doc), { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Remove a staged input (run file, key file); never fails. */
export function removeQuietly(path: string | undefined): void {
  if (!path) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // nothing else to do: the control plane's next stage replaces it
  }
}

/** Whether `pid` is a live process (EPERM counts as alive). */
export function pidAlive(pid: unknown): boolean {
  if (!isInt(pid) || pid === 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as { code?: string }).code === "EPERM";
  }
}

// ---------------------------------------------------------------------------------------------------------
// USTAR
// ---------------------------------------------------------------------------------------------------------

function putString(buf: Uint8Array, offset: number, length: number, text: string): void {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > length) throw new Error("tar_field_too_long");
  buf.set(bytes, offset);
}
function putOctal(buf: Uint8Array, offset: number, length: number, value: number): void {
  putString(buf, offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
}

/** One USTAR header for a regular file. Mode 0600 and mtime 0: the real ones ride in `files.json`. */
export function ustarHeader(name: string, size: number): Uint8Array {
  if (!isInt(size) || size > MAX_TAR_ENTRY_BYTES) fail("file_too_large");
  const h = new Uint8Array(512);
  putString(h, 0, 100, name);
  putOctal(h, 100, 8, 0o600);
  putOctal(h, 108, 8, 0);
  putOctal(h, 116, 8, 0);
  putOctal(h, 124, 12, size);
  putOctal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h[156] = 0x30;
  putString(h, 257, 6, "ustar\0");
  putString(h, 263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  putString(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}
export const tarPadding = (size: number) => (512 - (size % 512)) % 512;
export const TAR_END = new Uint8Array(1024);

function octalField(field: Uint8Array): number {
  const text = new TextDecoder().decode(field).replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) fail("tar_malformed");
  return parseInt(text, 8);
}

export type TarSink = { write(bytes: Uint8Array): void; end(): void };

/**
 * A streaming USTAR reader for the payload: regular files only, every header's checksum checked, then
 * two zero blocks and nothing but zeros after them. `open(name, size)` returns where the entry's bytes go
 * (or throws to refuse). Throws `NapError` with a `tar_*` code on anything malformed.
 */
export class TarReader {
  private buf: Uint8Array = new Uint8Array(0);
  private remaining = 0;
  private padding = 0;
  private sink: TarSink | null = null;
  private zeroBlocks = 0;
  done = false;

  constructor(private readonly open: (name: string, size: number) => TarSink) {}

  push(bytes: Uint8Array): void {
    let data = bytes;
    while (data.length > 0) {
      if (this.sink) {
        const n = Math.min(this.remaining, data.length);
        if (n > 0) this.sink.write(data.subarray(0, n));
        this.remaining -= n;
        data = data.subarray(n);
        if (this.remaining === 0) {
          this.sink.end();
          this.sink = null;
        }
        continue;
      }
      if (this.padding > 0) {
        const n = Math.min(this.padding, data.length);
        this.padding -= n;
        data = data.subarray(n);
        continue;
      }
      // Header (or end) blocks: gather 512 bytes.
      const need = 512 - this.buf.length;
      const take = data.subarray(0, need);
      const merged = new Uint8Array(this.buf.length + take.length);
      merged.set(this.buf);
      merged.set(take, this.buf.length);
      this.buf = merged;
      data = data.subarray(take.length);
      if (this.buf.length < 512) return;
      const header = this.buf;
      this.buf = new Uint8Array(0);
      if (header.every((b) => b === 0)) {
        this.zeroBlocks++;
        if (this.zeroBlocks >= 2) this.done = true;
        continue;
      }
      if (this.zeroBlocks > 0) fail("tar_malformed");
      this.header(header);
    }
  }

  private header(h: Uint8Array): void {
    const stored = octalField(h.subarray(148, 156));
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== stored) fail("tar_malformed");
    if (h[156] !== 0x30 && h[156] !== 0) fail("tar_entry_not_regular");
    const end = h.subarray(0, 100).indexOf(0);
    let name: string;
    try {
      name = new TextDecoder("utf-8", { fatal: true }).decode(h.subarray(0, end === -1 ? 100 : end));
    } catch {
      fail("tar_malformed");
    }
    if (h.subarray(345, 500).some((b) => b !== 0)) fail("tar_malformed");
    const size = octalField(h.subarray(124, 136));
    this.sink = this.open(name, size);
    this.remaining = size;
    this.padding = tarPadding(size);
    if (size === 0) {
      this.sink.end();
      this.sink = null;
    }
  }

  /** Call when the stream ends: refuses a truncated tar. */
  finish(): void {
    if (!this.done || this.sink || this.remaining > 0) fail("tar_truncated");
  }
}

// ---------------------------------------------------------------------------------------------------------
// The approvald store tar (review-a S-n2): list its members, file by file
// ---------------------------------------------------------------------------------------------------------

export type StoreMember = { path: string; bytes: number; sha256: string; mtime_ms: number; mode: number };
/** The store is small (policy, chain, a few ids); a bigger one is refused, never truncated. */
export const MAX_STORE_TAR_BYTES = 1024 * 1024 * 1024;

const SAFE_MEMBER = (rel: string) =>
  rel.length > 0 && rel.length <= 4096 && !rel.startsWith("/") &&
  rel.split("/").every((s) => s.length > 0 && s !== "." && s !== ".." && !s.includes("\\") && !s.includes("\0"));

/**
 * The regular-file members of a gzipped tar as the root piece writes it (`tar -czf … -C <dir> .`, GNU tar on a
 * box): directories are skipped, a leading `./` is dropped, pax (`x`, `g`) and GNU long-name (`L`) headers are
 * honoured, and anything else (a link, a device) or a bad checksum, name or size refuses
 * `approvald_tar_invalid`. Sorted by path; a repeated path refuses too.
 */
export function listStoreMembers(gz: Uint8Array): StoreMember[] {
  let tar: Buffer;
  try {
    tar = gunzipSync(gz, { maxOutputLength: MAX_STORE_TAR_BYTES });
  } catch {
    fail("approvald_tar_invalid");
  }
  const text = (b: Uint8Array) => {
    const end = b.indexOf(0);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(b.subarray(0, end === -1 ? b.length : end));
    } catch {
      fail("approvald_tar_invalid");
    }
  };
  const octal = (b: Uint8Array) => {
    const t = new TextDecoder().decode(b).replace(/\0.*$/s, "").trim();
    if (!/^[0-7]+$/.test(t)) fail("approvald_tar_invalid");
    return parseInt(t, 8);
  };
  const members: StoreMember[] = [];
  const seen = new Set<string>();
  let off = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let ended = false;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== octal(h.subarray(148, 156))) fail("approvald_tar_invalid");
    const size = octal(h.subarray(124, 136));
    const body = off + 512;
    if (body + size > tar.length) fail("approvald_tar_invalid");
    const data = tar.subarray(body, body + size);
    off = body + size + tarPadding(size);
    const type = String.fromCharCode(h[156] || 0x30);
    if (type === "L") {
      longName = text(data);
      continue;
    }
    if (type === "x" || type === "g") {
      if (type === "x") {
        for (const rec of text(data).split("\n")) {
          const m = /^[0-9]+ path=(.*)$/s.exec(rec);
          if (m) paxPath = m[1];
        }
      }
      continue;
    }
    const ustar = text(h.subarray(257, 263)) === "ustar";
    const prefix = ustar ? text(h.subarray(345, 500)) : "";
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${text(h.subarray(0, 100))}` : text(h.subarray(0, 100)));
    longName = null;
    paxPath = null;
    while (name.startsWith("./")) name = name.slice(2);
    if (name.endsWith("/")) name = name.slice(0, -1);
    if (type === "5") {
      if (size !== 0) fail("approvald_tar_invalid");
      continue;
    }
    if (type !== "0") fail("approvald_tar_invalid");
    if (!SAFE_MEMBER(name) || seen.has(name)) fail("approvald_tar_invalid");
    seen.add(name);
    members.push({
      path: name,
      bytes: size,
      sha256: sha256(data),
      mtime_ms: octal(h.subarray(136, 148)) * 1000,
      mode: octal(h.subarray(100, 108)) & 0o777,
    });
  }
  if (!ended) fail("approvald_tar_invalid");
  return members.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------
// The pinned bundle (review-a S-n4)
// ---------------------------------------------------------------------------------------------------------

/** `tool_sha256` of the bundle in `dir`: SHA-256 of `<name>\n<sha256 of its bytes>\n` per name, in order.
 * Null when a file is missing. */
export function toolSha256(dir: string, names: readonly string[]): string | null {
  const h = createHash("sha256");
  for (const name of names) {
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(dir, name));
    } catch {
      return null;
    }
    h.update(`${name}\n${sha256(bytes)}\n`);
  }
  return h.digest("hex");
}

// ---------------------------------------------------------------------------------------------------------
// HTTP: straight to the host in the URL, never through a proxy, no redirects (restore-memory.ts DATA-191)
// ---------------------------------------------------------------------------------------------------------

export class HttpTimeout extends Error {}
export class HttpNetwork extends Error {}

export type HttpBody = { file: string; bytes: number } | { data: Uint8Array };

/**
 * One request. The body is a file streamed from disk (with its length) or bytes; the response body goes to
 * `onData` (at most `maxBody` bytes, more fails `response_too_large`) and is otherwise discarded. Bounded by
 * `idleMs` with no bytes moving. Resolves with the status; rejects with `HttpTimeout` or `HttpNetwork`
 * (whose message never carries the URL).
 */
export function httpCall(
  method: "PUT" | "GET",
  url: string,
  opts: { body?: HttpBody; idleMs: number; maxBody?: number; onData?: (bytes: Uint8Array) => void },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const secure = target.protocol === "https:";
    const send = secure ? httpsRequest : httpRequest;
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const headers: Record<string, string> = { Accept: "*/*", "Accept-Encoding": "identity" };
    if (opts.body) headers["Content-Length"] = String("file" in opts.body ? opts.body.bytes : opts.body.data.length);
    const done = (err: Error | null, status = 0) => {
      if (settled) return;
      settled = true;
      clearTimeout(idle);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(status);
    };
    const touch = () => {
      clearTimeout(idle);
      idle = setTimeout(() => done(new HttpTimeout("timeout")), opts.idleMs);
    };
    const req = send(target, { method, headers, agent: secure ? new HttpsAgent() : new HttpAgent() }, (res: IncomingMessage) => {
      touch();
      const status = res.statusCode ?? 0;
      let size = 0;
      const ok = status >= 200 && status < 300;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        touch();
        size += chunk.length;
        if (ok && opts.onData) {
          if (opts.maxBody !== undefined && size > opts.maxBody) return done(new NapError("response_too_large"));
          try {
            opts.onData(chunk);
          } catch (err) {
            return done(err as Error);
          }
        } else if (size > 64 * 1024) {
          // An error body is never kept; stop reading a large one.
          done(null, status);
          req.destroy();
        }
      });
      res.on("end", () => done(null, status));
      res.on("error", () => done(new HttpNetwork("network")));
    });
    req.on("error", () => done(new HttpNetwork("network")));
    touch();
    if (!opts.body) req.end();
    else if ("data" in opts.body) req.end(opts.body.data);
    else {
      const fd = openSync(opts.body.file, "r");
      const buf = Buffer.alloc(1024 * 1024);
      let off = 0;
      const pump = () => {
        try {
          while (!settled) {
            const n = readSync(fd, buf, 0, buf.length, off);
            if (n === 0) {
              closeSync(fd);
              req.end();
              return;
            }
            off += n;
            touch();
            if (!req.write(Buffer.from(buf.subarray(0, n)))) {
              req.once("drain", pump);
              return;
            }
          }
          closeSync(fd);
        } catch {
          try {
            closeSync(fd);
          } catch {
            // already closed
          }
          done(new HttpNetwork("network"));
        }
      };
      pump();
    }
  });
}

// ---------------------------------------------------------------------------------------------------------
// The transport: one interface; `presigned` is the only mode built (design 12, S4). An `ingest` mode can be
// added behind the same interface with no change to the chunk or manifest formats.
// ---------------------------------------------------------------------------------------------------------

export type PutOutcome = "ok" | "url_expired" | "auth_refused" | "retry" | `upload_http_${number}`;

export interface NapTransport {
  readonly name: string;
  /** The run prefix every object key sits under. */
  readonly prefix: string;
  /** How many chunk slots the transport can take. */
  readonly chunkSlots: number;
  put(objectName: string, body: HttpBody): Promise<PutOutcome>;
  get(objectName: string, maxBytes: number, onData: (bytes: Uint8Array) => void): Promise<"ok" | "missing" | "url_expired" | "auth_refused" | "retry" | `download_http_${number}`>;
}

const putOutcome = (status: number): PutOutcome => {
  if (status >= 200 && status < 300) return "ok";
  if (status === 403) return "url_expired";
  if (status === 401) return "auth_refused";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return `upload_http_${status}`;
};

/** The presigned transport: every object has its own URL in the run file. */
export function presignedTransport(run: RunFile, idleMs: number): NapTransport {
  const urls = new Map<string, string>();
  for (const c of run.chunks) urls.set(c.name, c.url);
  urls.set(run.direction === "put" ? MANIFEST_SLOT_NAME : "manifest", run.manifest.url);
  const urlFor = (name: string) => {
    const url = urls.get(name);
    if (!url) fail("slots_exhausted");
    return url;
  };
  return {
    name: TRANSPORT_PRESIGNED,
    prefix: run.prefix,
    chunkSlots: run.chunks.length,
    async put(objectName, body) {
      return putOutcome(await httpCall("PUT", urlFor(objectName), { body, idleMs }));
    },
    async get(objectName, maxBytes, onData) {
      const status = await httpCall("GET", urlFor(objectName), { idleMs, maxBody: maxBytes, onData });
      if (status >= 200 && status < 300) return "ok";
      if (status === 404) return "missing";
      if (status === 403) return "url_expired";
      if (status === 401) return "auth_refused";
      if (status === 408 || status === 429 || status >= 500) return "retry";
      return `download_http_${status}`;
    },
  };
}

/** `key_id`: the SHA-256 of a public key's SPKI DER (review-a N2: rotation selects keys by id). */
export function keyIdOf(key: KeyObject): string {
  return sha256(key.export({ type: "spki", format: "der" }));
}

/** Read the gateway's pid record (`gateway.pid`: Hermes writes JSON `{pid, ...}` or a bare pid). */
function gatewayPidFromFile(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    if (/^[0-9]+$/.test(text)) return Number(text);
    const doc = JSON.parse(text);
    return doc && isInt(doc.pid) ? doc.pid : null;
  } catch {
    return null;
  }
}

/** Whether a process's argv runs `hermes gateway` (also inside the control plane's `bash -lc` loop). */
export function argvIsGateway(args: string[]): boolean {
  const tokens = args.flatMap((a) => a.split(/\s+/)).filter(Boolean);
  for (let i = 0; i + 1 < tokens.length; i++) {
    const base = tokens[i].slice(tokens[i].lastIndexOf("/") + 1);
    if (base === "hermes" && tokens[i + 1] === "gateway") return true;
  }
  return false;
}

/**
 * Whether the Hermes gateway is running: a live pid in `$HERMES_HOME/gateway.pid` (confirmed by its argv
 * when `procRoot` exists), or any process under `procRoot` whose argv runs `hermes gateway`. This process
 * never counts.
 */
export function gatewayRunning(hermesHomeDir: string, procRoot: string): boolean {
  const procReadable = (() => {
    try {
      return lstatSync(procRoot).isDirectory();
    } catch {
      return false;
    }
  })();
  const argvOf = (pid: number): string[] | null => {
    try {
      return readFileSync(join(procRoot, String(pid), "cmdline"), "utf8").split("\0").filter(Boolean);
    } catch {
      return null;
    }
  };
  const recorded = gatewayPidFromFile(join(hermesHomeDir, "gateway.pid"));
  if (recorded !== null && recorded !== process.pid && pidAlive(recorded)) {
    if (!procReadable) return true;
    const argv = argvOf(recorded);
    if (argv === null || argvIsGateway(argv)) return true;
  }
  if (!procReadable) return false;
  let names: string[] = [];
  try {
    names = readdirSync(procRoot);
  } catch {
    return false;
  }
  for (const name of names) {
    if (!/^[0-9]+$/.test(name) || Number(name) === process.pid) continue;
    const argv = argvOf(Number(name));
    if (argv && argvIsGateway(argv)) return true;
  }
  return false;
}
