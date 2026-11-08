#!/usr/bin/env bun
/**
 * Archive a box's complete state for a nap (P-COST NAP design v2: 1.2-1.4, 4.2-4.4, 4.9, 10.A; sections 12
 * and 13: M1 whole-home walk, M2 support, M3 secret classes, S1 WAL fold, S4, S6 resume and pid file, S10).
 *
 * The control plane fences the tenant, stops the writers, stages the pinned nap bundle (review-a S-n4:
 * `BUNDLE_FILES` plus `nap-state-paths.json`, one directory), runs the WAL fold as its own exec
 * (`nap-sqlite-fold.ts`, S-n1), runs its root piece (the approvald store tar, WITHOUT the daemon's token
 * files, staged 0600 at `$HERMES_HOME/av-events/nap/approvald-store.tar.gz`) and its root count, stages the
 * run file, then starts this from the bundle as a detached one-shot and polls `av-events/nap/progress.json`:
 *
 *   bun --no-env-file --no-install <bundle>/nap-archive.ts --tenant <id> [--home <dir>] [--root <dir>]
 *       --run-id <uuid> --served-commit <sha40> --tool-sha256 <sha64> --mode presigned [--paths <file>]
 *       [--run-file <path>] [--chunk-bytes N] [--progress <path>] [--pid-file <path>]
 *   bun --no-env-file --no-install <bundle>/nap-archive.ts --tenant <id> [--home <dir>] [--root <dir>] --dry-run
 *
 * `--root` is the walk root (`$HOME`, `/home/hermes` on a box); `--home` is `$HERMES_HOME`, inside it.
 *   0. refuses (exit 64) unless: the bundle it runs from hashes to `--tool-sha256` (`tool_mismatch`), the
 *      `--paths` document (default `nap-state-paths.json` next to this file) is exactly the rules it was
 *      built with (`paths_mismatch`, so the control plane's count and this walk use one exclude list),
 *      `fold.json` records this run's fold (`fold_missing`, `fold_mismatch`), and no gateway runs
 *      (`writers_alive`). It holds `av-events/nap/archive.pid` (its pid) for its whole life, so the control
 *      plane can kill it and see it dead before any restart; aborts (`gateway_running`) if a gateway comes
 *      back mid-run;
 *   1. never folds: a `-wal` file of any name still non-empty refuses (`wal_unfolded`);
 *   2. walks the whole root against the EXCLUDE list in `install/nap-state-paths.ts` (the only thing that
 *      keeps a file out), counting every excluded path per exclude name; symlinks are recorded (class
 *      `link`, target) and never followed, and one whose target is absolute or climbs out of the root
 *      refuses (`link_unsafe`: a restore would refuse it); hard links are read once by inode. A file that
 *      cannot be read, a special file, or a file that changes while it is read FAILS the run (exit 1,
 *      `file_unreadable` / `file_unsupported` / `file_changed`): nothing is ever skipped;
 *      The staged approvald store tar is packed as one entry, and each of its members is listed in
 *      `files.json` under `/var/lib/approvald/<tenant>/` with its size and SHA-256 (S-n2);
 *   3. streams a USTAR tar (`files.json` first: path, bytes, sha256, mtime_ms, mode, class for every entry;
 *      then `data/<index>` per file, the approvald store tar included) through gzip and SHA-256 into
 *      AES-256-GCM under a fresh random data key wrapped RSA-OAEP-SHA256 to `NAP_WRAP_PUBLIC_KEY` (the box
 *      can never decrypt what it wrote), cut into `--chunk-bytes` chunks under `av-events/nap/chunks/`;
 *      `progress.json` (0600) gets the wrapped key, IV, `key_id` and run id at stream start and the GCM tag
 *      and `stream_complete: true` at its end, BEFORE any upload;
 *   4. PUTs each chunk to its presigned URL (`NAP_UPLOAD_PARALLEL` at a time), recording each ack and then
 *      deleting the chunk; then PUTs the plaintext envelope `state_manifest.v1` (counts, tree totals, chunk
 *      hashes, `key_id`; no path, no provider id) last, to the run file's manifest slot.
 *
 * Resume: a re-run with the same `--run-id` resumes only a COMPLETE stream (`stream_complete` with the
 * persisted key material): it re-hashes the chunks still on disk, skips the acked ones and PUTs the rest.
 * Anything else (a stream cut mid-way, a chunk neither on disk nor acked) fails `resume_needs_new_run`:
 * the control plane starts a new run (new key, new prefix). GCM is never continued mid-stream.
 *
 * `--dry-run` (batch 0, writers live; review-a N-n1) needs no key, run file or fold, writes nothing, and never
 * fails on the tree: it prints `tool_sha256`, the walk totals, the per-exclude counts, and how many entries
 * it could not read, could not archive, or that another uid owns, how many `-wal` files are non-empty and
 * whether a store tar is staged. Exit 0.
 *
 * Environment (names only): `NAP_WRAP_PUBLIC_KEY` (RSA-4096 public key PEM), `NAP_CHUNK_BYTES` (25165824),
 * `NAP_UPLOAD_TIMEOUT_S` (30), `NAP_UPLOAD_PARALLEL` (3), `NAP_UPLOAD_RETRY_MS` (1000), `NAP_RUN_ID`,
 * `NAP_SERVED_COMMIT`, `NAP_TOOL_SHA256`, `NAP_PATHS_FILE`, `NAP_MODE`, `NAP_HERMES_VERSION`, `NAP_APPROVALD_VERSION`,
 * `NAP_APPROVALD_SECRET_NAMES` (the root piece's count), `NAP_PROC_ROOT` (/proc), `HERMES_HOME`, `HOME`,
 * `AV_TENANT_ID`. A flag and its variable must agree when both are given.
 *
 * Output: one JSON line, also stored in `progress.json`:
 *   {"status":"archived","manifest_key":"nap/<t>/<date>/<run>/state_manifest.<sha>.json","files":N,...}
 *   {"status":"refused"|"error","reason":"<code>","chunks_acked":N}
 * Exit: 0 archived (or `dry_run`); 64 refused before any write but `progress.json`; 1 failed (acked chunks
 * stay in the bucket, `.part` files removed, `progress.json` `failed`); 2 usage; 130/143 on INT/TERM (as 1).
 * It writes nowhere but `$HERMES_HOME/av-events/nap/`. On every exit it reaches (archived, refused, failed,
 * INT/TERM; all but `nap_already_running`, whose tar belongs to the live run) it deletes the run file, the
 * pid file and the staged approvald tar, which holds the chain's signing keys (S-n3); the control plane's
 * root `rm` of the tar, checked absent before any restart, is the backstop for a KILL or an OOM.
 * Never a path, a URL, a token or file content in any output.
 */

import {
  constants as cryptoConstants,
  createCipheriv,
  createHash,
  createPublicKey,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createGzip } from "node:zlib";

import {
  chunkName,
  CIPHER_MODE,
  dataEntryName,
  type ExcludedCounts,
  fail,
  FILES_ENTRY,
  FILES_SCHEMA,
  type FileEntry,
  gatewayRunning,
  hasData,
  HEX40,
  HEX64,
  type HttpBody,
  isInt,
  keyIdOf,
  listStoreMembers,
  MANIFEST_SCHEMA,
  MAX_FILES_JSON_BYTES,
  MANIFEST_SLOT_NAME,
  type Manifest,
  type ManifestChunk,
  manifestName,
  NapError,
  type NapTransport,
  parsePrefix,
  parseRunFile,
  pidAlive,
  presignedTransport,
  PROGRESS_SCHEMA,
  readPrivateFile,
  removeQuietly,
  sha256,
  TAR_END,
  tarPadding,
  TENANT,
  TRANSPORT_PRESIGNED,
  toolSha256,
  ustarHeader,
  UUID,
  VERSION_TEXT,
  writeJsonAtomic,
} from "./nap-common";
import { FOLD_FILE, FOLD_SCHEMA } from "./nap-sqlite-fold";
import {
  APPROVALD_STORE_ENTRY,
  APPROVALD_STORE_FILE,
  approvaldMemberPath,
  BROWSER_PROFILE_EXCLUDE,
  BUNDLE_FILES,
  classOf,
  linkTargetSafe,
  NAP_DIR,
  napStatePathsDocument,
  type PathRules,
  WAL_SUFFIX,
  walkHome,
  WalkRefused,
} from "./nap-state-paths";
import { hermesHome } from "./paths";

export const DEFAULT_CHUNK_BYTES = 25_165_824;
export const MIN_CHUNK_BYTES = 1024;
export const MAX_CHUNK_BYTES = 256 * 1024 * 1024;
export const MIN_RSA_BITS = 4096;
const READ_BLOCK = 1024 * 1024;

export type ArchiveOptions = {
  tenant: string;
  /** `$HERMES_HOME`. */
  home: string;
  /** The walk root (`$HOME`); `home` sits inside it. */
  root: string;
  runId: string;
  servedCommit: string;
  /** The pinned bundle's sha the control plane staged (S-n4); this file's own bundle must hash to it. */
  toolSha256: string;
  /** The control plane's copy of the path rules (`nap-state-paths.json`); must equal the built-in rules. */
  pathsFile: string;
  mode: string;
  runFile: string;
  chunkBytes: number;
  progress: string;
  pidFile: string;
  dryRun: boolean;
  publicKeyPem: string;
  hermesVersion: string | null;
  approvaldVersion: string | null;
  approvaldSecretNames: number | null;
  parallel: number;
  timeoutMs: number;
  retryMs: number;
  attempts: number;
  procRoot: string;
  /** The restore's own cap on `files.json` (Fable S1): the same constant, so nothing archives that cannot
   * restore. An option only so a test can lower it. */
  maxFilesJsonBytes: number;
};

/** Test seams: each relative path just hashed (pass 1), about to be packed (pass 2), and each chunk before
 * its upload. Never set in production. */
export type ArchiveHooks = { afterHash?: (rel: string) => void; beforePack?: (rel: string) => void; beforeUpload?: (n: number) => void };

/** What `progress.json` keeps of the stream (13 S6): the key material from the start, the tag at the end. */
type Stream = {
  run_id: string;
  prefix: string;
  tool_sha256: string;
  key_id: string;
  wrapped_key_b64: string;
  iv_b64: string;
  gcm_tag_b64?: string;
  stream_complete: boolean;
  date?: string;
  created_at?: string;
  served?: Manifest["served"];
  payload?: Manifest["payload"];
  tree?: Manifest["tree"];
  chunks?: ManifestChunk[];
  chunk_bytes?: number;
};

type Progress = {
  schema: string;
  phase: "running" | "done" | "failed" | "refused";
  step?: "walking" | "packing" | "uploading" | "manifest";
  pid: number;
  run_id: string;
  started_at: string;
  updated_at: string;
  reason?: string;
  stream?: Stream;
  acked: number[];
  /** A run whose stream was discarded, or that failed before any stream: its id is never reused (Fable M1). */
  spent?: boolean;
  /** Chunks a discarded stream had acked: in the bucket, named by no manifest. */
  orphan_chunks?: number;
  result?: Record<string, unknown>;
};

export type ArchiveOutcome = { code: number; line: Record<string, unknown> };

function readProgress(path: string): Progress | null {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8"));
    return doc && typeof doc === "object" && doc.schema === PROGRESS_SCHEMA ? (doc as Progress) : null;
  } catch {
    return null;
  }
}

function readPidFile(path: string): number | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    return /^[0-9]+$/.test(text) ? Number(text) : null;
  } catch {
    return null;
  }
}

/** What the INT/TERM handler needs to leave the right things on disk. */
type Live = { progress: string; chunks: string; runFile: string; pidFile: string; storeTar: string; doc: Progress | null };
let live: Live | null = null;

function removeParts(dir: string): void {
  let names: string[] = [];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) if (name.endsWith(".part")) rmSync(join(dir, name), { force: true });
}

/** Validate the public key: a PEM RSA public key of at least 4096 bits, and never a private key. */
export function loadPublicKey(pem: string): KeyObject {
  if (!pem || !pem.trim()) fail("public_key_missing");
  if (/PRIVATE KEY/.test(pem)) fail("public_key_invalid");
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    fail("public_key_invalid");
  }
  if (key.type !== "public" || key.asymmetricKeyType !== "rsa") fail("public_key_invalid");
  if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < MIN_RSA_BITS) fail("public_key_invalid");
  return key;
}

type Walked = {
  files: FileEntry[];
  /** files.json path → where its bytes are read from, and the inode seen in pass 1. */
  sources: Map<string, { path: string; dev: number; ino: number }>;
  liveFiles: number;
  liveBytes: number;
  excluded: ExcludedCounts;
  approvaldFiles: number;
  approvaldBytes: number;
};

/** Hash one regular file, failing (`file_changed`) when it moves under the read. */
function hashFile(path: string, rel: string, st: { dev: number; ino: number; size: number; mtimeMs: number }, after?: (rel: string) => void) {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as { code?: string }).code;
    fail(code === "ENOENT" || code === "ELOOP" ? "file_changed" : "file_unreadable");
  }
  try {
    const before = fstatSync(fd);
    if (before.ino !== st.ino || before.dev !== st.dev || before.size !== st.size || before.mtimeMs !== st.mtimeMs) fail("file_changed");
    const hash = createHash("sha256");
    const buf = Buffer.alloc(READ_BLOCK);
    let total = 0;
    for (;;) {
      let n: number;
      try {
        n = readSync(fd, buf, 0, buf.length, total);
      } catch {
        fail("file_unreadable");
      }
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      total += n;
    }
    after?.(rel);
    const end = fstatSync(fd);
    if (total !== st.size || end.size !== st.size || end.mtimeMs !== st.mtimeMs) fail("file_changed");
    return { bytes: total, sha256: hash.digest("hex") };
  } finally {
    closeSync(fd);
  }
}

const walk = (root: string, rules: PathRules) => {
  try {
    return walkHome(root, rules);
  } catch (err) {
    if (err instanceof WalkRefused) fail(err.message);
    throw err;
  }
};

/**
 * Pass 1: the walk and `files.json`'s entries: the home's, then the approvald store tar, then each of its
 * members under `/var/lib/approvald/<tenant>/` (S-n2). Throws `NapError`.
 */
export function walkAndHash(root: string, rules: PathRules, storeTar: string | null, tenant: string, hooks: ArchiveHooks = {}): Walked {
  const tree = walk(root, rules);
  const files: FileEntry[] = [];
  const sources = new Map<string, { path: string; dev: number; ino: number }>();
  const firstByInode = new Map<string, FileEntry>();
  let liveBytes = 0;
  for (const item of tree.items) {
    const mode = item.st.mode & 0o777;
    const mtime_ms = Math.floor(item.st.mtimeMs);
    const path = join(root, ...item.rel.split("/"));
    if (item.type === "link") {
      let target: string;
      try {
        target = readlinkSync(path);
      } catch {
        fail("file_changed");
      }
      if (!linkTargetSafe(item.rel, target)) fail("link_unsafe");
      const bytes = Buffer.byteLength(target);
      liveBytes += bytes;
      files.push({ path: item.rel, bytes, sha256: sha256(target), mtime_ms, mode, class: "link", target });
      continue;
    }
    liveBytes += item.st.size;
    const cls = classOf(item.rel, rules);
    const inodeKey = `${item.st.dev}:${item.st.ino}`;
    const first = item.st.nlink > 1 ? firstByInode.get(inodeKey) : undefined;
    if (first) {
      files.push({ path: item.rel, bytes: first.bytes, sha256: first.sha256, mtime_ms, mode, class: cls, same_as: first.path });
      continue;
    }
    const { bytes, sha256: digest } = hashFile(path, item.rel, item.st, hooks.afterHash);
    const entry: FileEntry = { path: item.rel, bytes, sha256: digest, mtime_ms, mode, class: cls };
    files.push(entry);
    sources.set(item.rel, { path, dev: item.st.dev, ino: item.st.ino });
    if (item.st.nlink > 1) firstByInode.set(inodeKey, entry);
  }
  const liveFiles = tree.items.length;
  if (storeTar !== null) {
    let st;
    try {
      st = lstatSync(storeTar);
    } catch {
      fail("approvald_tar_missing");
    }
    if (!st.isFile()) fail("approvald_tar_invalid");
    if ((st.mode & 0o077) !== 0) fail("approvald_tar_mode");
    const { bytes, sha256: digest } = hashFile(storeTar, APPROVALD_STORE_ENTRY, st, hooks.afterHash);
    files.push({ path: APPROVALD_STORE_ENTRY, bytes, sha256: digest, mtime_ms: Math.floor(st.mtimeMs), mode: 0o600, class: "state" });
    sources.set(APPROVALD_STORE_ENTRY, { path: storeTar, dev: st.dev, ino: st.ino });
    // The members, from the same bytes that were hashed.
    let gz: Buffer;
    try {
      gz = readFileSync(storeTar);
    } catch {
      fail("file_changed");
    }
    if (sha256(gz) !== digest) fail("file_changed");
    for (const m of listStoreMembers(gz)) {
      files.push({
        path: approvaldMemberPath(tenant, m.path),
        bytes: m.bytes,
        sha256: m.sha256,
        mtime_ms: m.mtime_ms,
        mode: m.mode,
        class: "state",
        member_of: APPROVALD_STORE_ENTRY,
      });
    }
  }
  const members = files.filter((f) => f.member_of !== undefined);
  return {
    files,
    sources,
    liveFiles,
    liveBytes,
    excluded: tree.excluded,
    approvaldFiles: members.length,
    approvaldBytes: members.reduce((n, f) => n + f.bytes, 0),
  };
}

/** Writes the ciphertext into `chunks/<nnnn>.part`, each sealed (hashed, renamed `chunk-<nnnn>.bin`) when full. */
class Chunker {
  private n = 0;
  private fd = -1;
  private written = 0;
  private hash = createHash("sha256");
  readonly list: ManifestChunk[] = [];
  constructor(private readonly dir: string, private readonly size: number) {}
  private part(): string {
    return join(this.dir, `${String(this.n).padStart(4, "0")}.part`);
  }
  write(buf: Uint8Array): void {
    let off = 0;
    while (off < buf.length) {
      if (this.fd < 0) {
        this.fd = openSync(this.part(), "wx", 0o600);
        this.hash = createHash("sha256");
      }
      const take = Math.min(this.size - this.written, buf.length - off);
      const piece = buf.subarray(off, off + take);
      let done = 0;
      while (done < piece.length) done += writeSync(this.fd, piece, done, piece.length - done);
      this.hash.update(piece);
      this.written += take;
      off += take;
      if (this.written === this.size) this.seal();
    }
  }
  private seal(): void {
    closeSync(this.fd);
    renameSync(this.part(), join(this.dir, chunkName(this.n)));
    this.list.push({ n: this.n, name: chunkName(this.n), bytes: this.written, sha256: this.hash.digest("hex") });
    this.n++;
    this.fd = -1;
    this.written = 0;
  }
  close(): void {
    if (this.fd < 0) return;
    if (this.written > 0) return this.seal();
    closeSync(this.fd);
    rmSync(this.part(), { force: true });
    this.fd = -1;
  }
  abort(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}

/**
 * Pass 2: tar → gzip (hashed) → AES-256-GCM → chunks. `onStart` receives the wrapped key and IV before the
 * first byte is encrypted (they go to `progress.json`). Fails `file_changed` when a file differs from pass 1.
 */
async function pack(
  walked: Walked,
  publicKey: KeyObject,
  chunksDir: string,
  chunkBytes: number,
  hooks: ArchiveHooks,
  onStart: (wrapped_key_b64: string, iv_b64: string) => void,
) {
  const dataKey = randomBytes(32);
  const iv = randomBytes(12);
  const chunker = new Chunker(chunksDir, chunkBytes);
  const gzip = createGzip({ level: 6 });
  try {
    const wrapped = publicEncrypt({ key: publicKey, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" }, dataKey);
    onStart(wrapped.toString("base64"), iv.toString("base64"));
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    const payloadHash = createHash("sha256");
    let payloadBytes = 0;
    let streamError: unknown = null;
    gzip.on("data", (buf: Buffer) => {
      if (streamError) return;
      try {
        payloadHash.update(buf);
        payloadBytes += buf.length;
        chunker.write(cipher.update(buf));
      } catch (err) {
        streamError = err;
      }
    });
    const ended = new Promise<void>((res, rej) => {
      gzip.on("end", () => res());
      gzip.on("error", rej);
    });
    const feed = async (bytes: Uint8Array) => {
      if (streamError) throw streamError;
      if (gzip.destroyed) fail("pack_failed");
      if (bytes.length === 0) return;
      if (!gzip.write(bytes)) {
        // Never wait on a drain that cannot come: an errored stream only closes.
        await new Promise<void>((res) => {
          const done = () => {
            gzip.off("drain", done);
            gzip.off("error", done);
            gzip.off("close", done);
            res();
          };
          gzip.once("drain", done);
          gzip.once("error", done);
          gzip.once("close", done);
        });
      }
    };
    const filesJson = Buffer.from(JSON.stringify({ schema: FILES_SCHEMA, files: walked.files }));
    await feed(ustarHeader(FILES_ENTRY, filesJson.length));
    await feed(filesJson);
    await feed(new Uint8Array(tarPadding(filesJson.length)));
    for (let i = 0; i < walked.files.length; i++) {
      const f = walked.files[i];
      if (!hasData(f)) continue;
      hooks.beforePack?.(f.path);
      await feed(ustarHeader(dataEntryName(i), f.bytes));
      const src = walked.sources.get(f.path)!;
      let fd: number;
      try {
        fd = openSync(src.path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      } catch {
        fail("file_changed");
      }
      try {
        const st = fstatSync(fd);
        if (st.ino !== src.ino || st.dev !== src.dev || st.size !== f.bytes) fail("file_changed");
        const hash = createHash("sha256");
        let total = 0;
        while (total < f.bytes) {
          const buf = Buffer.alloc(Math.min(READ_BLOCK, f.bytes - total));
          const n = readSync(fd, buf, 0, buf.length, total);
          if (n === 0) fail("file_changed");
          hash.update(buf.subarray(0, n));
          total += n;
          await feed(buf.subarray(0, n));
        }
        if (readSync(fd, Buffer.alloc(1), 0, 1, total) !== 0 || hash.digest("hex") !== f.sha256) fail("file_changed");
      } finally {
        closeSync(fd);
      }
      await feed(new Uint8Array(tarPadding(f.bytes)));
    }
    await feed(TAR_END);
    gzip.end();
    await ended;
    if (streamError) throw streamError;
    const tail = cipher.final();
    if (tail.length) chunker.write(tail);
    chunker.close();
    return { gcm_tag_b64: cipher.getAuthTag().toString("base64"), payloadSha: payloadHash.digest("hex"), payloadBytes, chunks: chunker.list };
  } catch (err) {
    chunker.abort();
    gzip.destroy();
    throw err;
  } finally {
    dataKey.fill(0);
  }
}

/** Re-hash the chunks still on disk; true when every un-acked one is there and intact. */
function chunksIntact(dir: string, chunks: ManifestChunk[], acked: Set<number>): boolean {
  for (const c of chunks) {
    if (acked.has(c.n)) continue;
    const path = join(dir, c.name);
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.size !== c.bytes) return false;
      if (sha256(readFileSync(path)) !== c.sha256) return false;
    } catch {
      return false;
    }
  }
  return true;
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function putWithRetry(transport: NapTransport, name: string, body: HttpBody, opts: ArchiveOptions): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    let outcome: string;
    try {
      outcome = await transport.put(name, body);
    } catch (err) {
      if (err instanceof NapError) throw err;
      outcome = "retry"; // timeout or network: the URL is never in the message, and the PUT is idempotent
    }
    if (outcome !== "retry") return outcome;
    if (attempt >= opts.attempts) return "upload_unavailable";
    await sleep(opts.retryMs * 2 ** (attempt - 1));
  }
}

const isComplete = (s: Stream | undefined): s is Required<Stream> =>
  !!s && s.stream_complete === true && !!s.wrapped_key_b64 && !!s.iv_b64 && !!s.gcm_tag_b64 && Array.isArray(s.chunks) && !!s.payload && !!s.tree;

/** The sha of the bundle this file runs from. */
export const ownToolSha256 = () => toolSha256(import.meta.dir, BUNDLE_FILES);
/** The sha of the path rules this file was built with. */
export const ownPathsSha256 = () => sha256(JSON.stringify(napStatePathsDocument()));

/** `--dry-run` (review-a N-n1): a read-only count that never fails on the tree and writes nothing. */
export function dryCount(opts: Pick<ArchiveOptions, "root" | "home">): ArchiveOutcome {
  const placeholder = "0".repeat(64);
  const rules: PathRules = { hermesRel: relative(opts.root, opts.home).split(sep).join("/") };
  let tree;
  try {
    tree = walkHome(opts.root, rules, { lenient: true });
  } catch (err) {
    if (err instanceof WalkRefused) return { code: 0, line: { status: "dry_run", reason: err.message } };
    throw err;
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  let unreadable = tree.problems.unreadable;
  let walNonEmpty = 0;
  let notOwned = 0;
  let liveBytes = 0;
  // files.json's size as the archive would write it (64-hex placeholders for the hashes; the approvald
  // members are not listed here), against the cap both sides share (Fable S1).
  let filesJsonBytes = Buffer.byteLength(JSON.stringify({ schema: FILES_SCHEMA, files: [] }));
  for (const item of tree.items) {
    liveBytes += item.st.size;
    filesJsonBytes += 1 + Buffer.byteLength(JSON.stringify({
      path: item.rel, bytes: item.st.size, sha256: placeholder, mtime_ms: Math.floor(item.st.mtimeMs), mode: item.st.mode & 0o777,
      class: item.type === "link" ? "link" : "unclassified",
    }));
    if (item.st.uid !== uid) notOwned++;
    if (item.type !== "file") continue;
    if (item.rel.endsWith(WAL_SUFFIX) && item.st.size > 0) walNonEmpty++;
    try {
      closeSync(openSync(join(opts.root, ...item.rel.split("/")), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));
    } catch {
      unreadable++;
    }
  }
  const sum = (k: "files" | "bytes") => Object.values(tree.excluded).reduce((n, c) => n + c[k], 0);
  return {
    code: 0,
    line: {
      status: "dry_run",
      tool_sha256: ownToolSha256(),
      paths_sha256: ownPathsSha256(),
      live_files: tree.items.length,
      live_bytes: liveBytes,
      excluded_files: sum("files"),
      excluded_bytes: sum("bytes"),
      excluded: tree.excluded,
      unreadable,
      unsupported: tree.problems.unsupported,
      not_owned: notOwned,
      wal_nonempty: walNonEmpty,
      approvald_tar_staged: lstatSafe(join(opts.home, ...APPROVALD_STORE_FILE.split("/"))),
      browser_profile_files: tree.excluded[BROWSER_PROFILE_EXCLUDE]?.files ?? 0,
      files_json_bytes: filesJsonBytes,
      files_json_max: MAX_FILES_JSON_BYTES,
    },
  };
}

/** The fold's record for this run (S-n1): its counts, or a refusal code. */
function readFold(home: string, runId: string): { db_count: number; wal_folded: number } {
  const bytes = readPrivateFile(join(home, ...FOLD_FILE.split("/")), "fold_missing", "fold_invalid", "fold_mode");
  let doc: { schema?: unknown; run_id?: unknown; db_count?: unknown; wal_folded?: unknown; wal_unfolded?: unknown };
  try {
    doc = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("fold_invalid");
  }
  if (!doc || doc.schema !== FOLD_SCHEMA || !isInt(doc.db_count) || !isInt(doc.wal_folded) || !isInt(doc.wal_unfolded)) fail("fold_invalid");
  if (doc.run_id !== runId) fail("fold_mismatch");
  if (doc.wal_unfolded !== 0) fail("wal_unfolded");
  return { db_count: doc.db_count, wal_folded: doc.wal_folded };
}

/** The control plane's copy of the rules must be exactly the rules built in here (S-n4). */
function checkPaths(path: string): void {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    fail("paths_missing");
  }
  if (!st.isFile() || st.size > MAX_PATHS_BYTES) fail("paths_invalid");
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("paths_invalid");
  }
  if (JSON.stringify(doc) !== JSON.stringify(napStatePathsDocument())) fail("paths_mismatch");
}
const MAX_PATHS_BYTES = 1024 * 1024;

export async function runArchive(opts: ArchiveOptions, hooks: ArchiveHooks = {}): Promise<ArchiveOutcome> {
  if (opts.dryRun) return dryCount(opts);
  const startedMs = Date.now();
  const napDir = join(opts.home, ...NAP_DIR.split("/"));
  const chunksDir = join(napDir, "chunks");
  const storeTar = join(opts.home, ...APPROVALD_STORE_FILE.split("/"));
  const rules: PathRules = { hermesRel: relative(opts.root, opts.home).split(sep).join("/") };
  const now = () => new Date().toISOString();
  const prev = readProgress(opts.progress);
  const pidHolder = readPidFile(opts.pidFile);

  // Another live run, or this run already done: refuse without touching anything.
  const otherAlive = (pid: unknown) => pid !== process.pid && pidAlive(pid);
  if ((prev?.phase === "running" && otherAlive(prev.pid)) || (pidHolder !== null && otherAlive(pidHolder))) {
    return { code: 64, line: { status: "refused", reason: "nap_already_running", chunks_acked: 0 } };
  }
  if (prev?.phase === "done" && prev.run_id === opts.runId) {
    removeQuietly(opts.runFile);
    removeQuietly(storeTar); // the signing keys never outlive a run (S-n3)
    return { code: 64, line: { status: "refused", reason: "run_already_archived", chunks_acked: 0 } };
  }

  const sameRun = prev && prev.run_id === opts.runId ? prev : null;
  // Fable M1: a run id whose stream was discarded (or that failed with no stream at all) is spent; only a
  // stream on record can be resumed, and its acks are the only acks that ever count.
  const spent = !!sameRun && (sameRun.spent === true || (sameRun.phase === "failed" && !sameRun.stream));
  let doc: Progress = {
    schema: PROGRESS_SCHEMA,
    phase: "running",
    pid: process.pid,
    run_id: opts.runId,
    started_at: now(),
    updated_at: now(),
    acked: !spent && sameRun?.stream ? (sameRun.acked ?? []).filter(isInt) : [],
    ...(spent ? { spent: true, orphan_chunks: sameRun?.orphan_chunks ?? sameRun?.acked?.length ?? 0 } : {}),
    ...(!spent && sameRun?.stream ? { stream: sameRun.stream } : {}),
  };
  const save = (patch: Partial<Progress>) => {
    doc = { ...doc, ...patch, updated_at: now() };
    writeJsonAtomic(opts.progress, doc);
    if (live) live.doc = doc;
  };
  let pidHeld = false;
  const finish = (code: number, line: Record<string, unknown>, phase: Progress["phase"], extra: Partial<Progress> = {}) => {
    try {
      save({ phase, result: line, ...(line.reason ? { reason: String(line.reason) } : {}), ...extra });
    } catch {
      // The JSON line still reports the outcome.
    }
    removeQuietly(opts.runFile);
    removeQuietly(storeTar);
    if (pidHeld) removeQuietly(opts.pidFile);
    live = null;
    return { code, line };
  };
  const refuse = (reason: string) => finish(64, { status: "refused", reason, chunks_acked: 0 }, "refused");
  const failed = (reason: string, extra: Partial<Progress> = {}) => {
    removeParts(chunksDir);
    const acked = extra.orphan_chunks ?? doc.acked.length;
    // A failure with no stream on record leaves nothing to resume: the id is spent.
    const noStream = extra.stream === undefined && ("stream" in extra || !doc.stream);
    return finish(1, { status: "error", reason, chunks_acked: acked }, "failed", { ...extra, ...(noStream ? { spent: true } : {}) });
  };
  /** A failure after which no chunk of this run may be used: the chunks go, the stream record and its acks
   * go (Fable M1), and the run id is spent; the acked count survives only as `orphan_chunks`. */
  const discard = (reason: string) => {
    rmSync(chunksDir, { recursive: true, force: true });
    return failed(reason, { stream: undefined, acked: [], orphan_chunks: doc.acked.length, spent: true });
  };
  const gatewayBack = () => gatewayRunning(opts.home, opts.procRoot);

  if (spent) return refuse("run_id_spent");

  // Refusals before any write.
  let publicKey: KeyObject;
  let transport: NapTransport | null = null;
  let date = "";
  let prefix = "";
  let fold = { db_count: 0, wal_folded: 0 };
  const toolSha = ownToolSha256();
  const pathsSha = ownPathsSha256();
  try {
    publicKey = loadPublicKey(opts.publicKeyPem);
    if (opts.mode !== TRANSPORT_PRESIGNED) fail("transport_not_built");
    if (!toolSha || toolSha !== opts.toolSha256) fail("tool_mismatch");
    checkPaths(opts.pathsFile);
    const run = parseRunFile(readPrivateFile(opts.runFile, "run_file_missing", "run_file_invalid", "run_file_mode"), {
      direction: "put",
      tenant: opts.tenant,
      runId: opts.runId,
      manifestNames: [MANIFEST_SLOT_NAME],
    });
    transport = presignedTransport(run, opts.timeoutMs);
    prefix = run.prefix;
    date = parsePrefix(run.prefix)!.date;
    fold = readFold(opts.home, opts.runId);
    if (gatewayBack()) fail("writers_alive");
  } catch (err) {
    if (err instanceof NapError) return refuse(err.code);
    throw err;
  }

  // The pid file, held for the run's life (13 S6): the control plane kills this pid, verified dead, before
  // any restart of the writers.
  {
    try {
      mkdirSync(napDir, { recursive: true, mode: 0o700 });
      const tmp = `${opts.pidFile}.${process.pid}.tmp`;
      rmSync(tmp, { force: true });
      writeFileSync(tmp, `${process.pid}\n`, { mode: 0o600, flag: "wx" });
      renameSync(tmp, opts.pidFile);
      pidHeld = true;
    } catch {
      return refuse("pid_file_failed");
    }
    live = { progress: opts.progress, chunks: chunksDir, runFile: opts.runFile, pidFile: opts.pidFile, storeTar, doc: null };
  }

  // Resume only a complete stream of this run whose un-acked chunks are intact (13 S6).
  let stream: Required<Stream> | null = null;
  const acked = new Set<number>(doc.acked); // empty unless a stream of this run is on record
  if (doc.stream) {
    const s = doc.stream;
    if (isComplete(s) && s.prefix === prefix && s.tool_sha256 === toolSha && chunksIntact(chunksDir, s.chunks, acked)) stream = s;
    else return discard("resume_needs_new_run");
  }

  if (!stream) {
    let walked: Walked;
    try {
      save({ phase: "running", step: "walking", acked: [] });
    } catch {
      return failed("progress_write_failed");
    }
    try {
      walked = walkAndHash(opts.root, rules, storeTar, opts.tenant, hooks);
    } catch (err) {
      if (!(err instanceof NapError)) throw err;
      // Before any chunk exists: the run file, key, URL and tree refusals are 64; an unreadable or changed
      // file (13 S10) fails the run.
      const refusals = ["link_unsafe", "approvald_tar_missing", "approvald_tar_invalid", "approvald_tar_mode", "root_invalid"];
      return refusals.includes(err.code) ? refuse(err.code) : failed(err.code);
    }
    // The fold ran in its own exec before the root count (S-n1); here a `-wal` of any name still holding
    // bytes refuses, and nothing is folded again.
    if (walked.files.some((f) => f.member_of === undefined && f.class !== "link" && f.path.endsWith(WAL_SUFFIX) && f.bytes > 0)) {
      return refuse("wal_unfolded");
    }
    // Fable S1: one cap on both sides; an archive the restore would refuse is never made.
    if (Buffer.byteLength(JSON.stringify({ schema: FILES_SCHEMA, files: walked.files })) > opts.maxFilesJsonBytes) {
      return refuse("files_json_too_large");
    }
    const counts = (cls: FileEntry["class"]) => walked.files.filter((f) => f.class === cls).length;
    const keyId = keyIdOf(publicKey);
    try {
      if (gatewayBack()) return discard("gateway_running");
      rmSync(chunksDir, { recursive: true, force: true });
      mkdirSync(chunksDir, { recursive: true, mode: 0o700 });
      save({ step: "packing" });
      const packed = await pack(walked, publicKey, chunksDir, opts.chunkBytes, hooks, (wrapped_key_b64, iv_b64) => {
        // The key material is on record before the first byte is encrypted (13 S6).
        save({ stream: { run_id: opts.runId, prefix, tool_sha256: toolSha!, key_id: keyId, wrapped_key_b64, iv_b64, stream_complete: false } });
      });
      if (gatewayBack()) return discard("gateway_running");
      stream = {
        ...(doc.stream as Stream),
        gcm_tag_b64: packed.gcm_tag_b64,
        stream_complete: true,
        date,
        created_at: now(),
        served: { overlay_commit: opts.servedCommit, hermes_version: opts.hermesVersion, approvald_version: opts.approvaldVersion },
        payload: {
          sha256: packed.payloadSha,
          bytes: packed.payloadBytes,
          file_count: walked.files.length,
          total_file_bytes: walked.files.filter((f) => f.class !== "link").reduce((n, f) => n + f.bytes, 0),
          secret_cp_count: counts("secret_cp"),
          secret_box_count: counts("secret_box"),
          unclassified_count: counts("unclassified"),
          link_count: counts("link"),
          log_count: counts("log"),
        },
        tree: {
          live_files: walked.liveFiles,
          live_bytes: walked.liveBytes,
          excluded: walked.excluded,
          db_count: fold.db_count,
          wal_folded: fold.wal_folded,
          approvald_secret_names: opts.approvaldSecretNames,
          approvald_files: walked.approvaldFiles,
          approvald_bytes: walked.approvaldBytes,
          browser_profile_files: walked.excluded[BROWSER_PROFILE_EXCLUDE]?.files ?? 0,
          browser_profile_dropped: (walked.excluded[BROWSER_PROFILE_EXCLUDE]?.files ?? 0) > 0,
        },
        chunks: packed.chunks,
        chunk_bytes: opts.chunkBytes,
      } as Required<Stream>;
    } catch (err) {
      // A stream that did not finish is never resumed: its chunks go with it.
      return discard(err instanceof NapError ? err.code : "pack_failed");
    }
  }

  // The complete stream, tag included, is on record BEFORE the first upload.
  try {
    save({ phase: "running", step: "uploading", stream, acked: [...acked].sort((a, b) => a - b) });
  } catch {
    return failed("progress_write_failed");
  }
  if (stream.chunks.length > transport!.chunkSlots) return failed("slots_exhausted");

  const queue = stream.chunks.filter((c) => !acked.has(c.n));
  let failure: string | null = null;
  const worker = async () => {
    while (!failure && queue.length > 0) {
      hooks.beforeUpload?.(queue[0].n);
      if (gatewayBack()) {
        failure = "gateway_running";
        return;
      }
      const c = queue.shift()!;
      let outcome: string;
      try {
        outcome = await putWithRetry(transport!, c.name, { file: join(chunksDir, c.name), bytes: c.bytes }, opts);
      } catch (err) {
        outcome = err instanceof NapError ? err.code : "upload_failed";
      }
      if (outcome !== "ok") {
        failure ??= outcome;
        return;
      }
      acked.add(c.n);
      save({ acked: [...acked].sort((a, b) => a - b) });
      rmSync(join(chunksDir, c.name), { force: true });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.parallel) }, worker));
  if (failure === "gateway_running") return discard("gateway_running");
  if (failure) return failed(failure);
  if (gatewayBack()) return discard("gateway_running");

  // The envelope, last.
  const manifest: Manifest = {
    schema: MANIFEST_SCHEMA,
    tenant_id: opts.tenant,
    date: stream.date,
    run_id: opts.runId,
    created_at: stream.created_at,
    transport: TRANSPORT_PRESIGNED,
    prefix: stream.prefix,
    served: stream.served,
    tool_sha256: stream.tool_sha256,
    paths_sha256: pathsSha,
    mode: CIPHER_MODE,
    key_id: stream.key_id,
    wrapped_key_b64: stream.wrapped_key_b64,
    iv_b64: stream.iv_b64,
    gcm_tag_b64: stream.gcm_tag_b64,
    payload: stream.payload,
    tree: stream.tree,
    chunks: stream.chunks,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const manifestSha = sha256(manifestBytes);
  save({ step: "manifest" });
  let outcome: string;
  try {
    outcome = await putWithRetry(transport!, MANIFEST_SLOT_NAME, { data: manifestBytes }, opts);
  } catch (err) {
    outcome = err instanceof NapError ? err.code : "upload_failed";
  }
  if (outcome !== "ok") return failed(outcome);
  rmSync(chunksDir, { recursive: true, force: true });
  const p = stream.payload;
  const t = stream.tree;
  return finish(
    0,
    {
      status: "archived",
      manifest_key: `${stream.prefix}${manifestName(manifestSha)}`,
      files: p.file_count,
      bytes: p.bytes,
      payload_sha256: p.sha256,
      chunks: stream.chunks.length,
      chunk_bytes: stream.chunk_bytes,
      secret_cp: p.secret_cp_count,
      secret_box: p.secret_box_count,
      unclassified: p.unclassified_count,
      excluded_files: Object.values(t.excluded).reduce((n, c) => n + c.files, 0),
      excluded_bytes: Object.values(t.excluded).reduce((n, c) => n + c.bytes, 0),
      live_files: t.live_files,
      live_bytes: t.live_bytes,
      db_count: t.db_count,
      wal_folded: t.wal_folded,
      approvald_files: t.approvald_files,
      approvald_bytes: t.approvald_bytes,
      browser_profile_files: t.browser_profile_files,
      served_commit: stream.served.overlay_commit,
      tool_sha256: stream.tool_sha256,
      key_id: stream.key_id,
      seconds: Math.round((Date.now() - startedMs) / 1000),
    },
    "done",
  );
}

function lstatSafe(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function usage(message: string): never {
  console.error(`nap-archive: ${message}`);
  console.error(
    "usage: bun install/nap-archive.ts --tenant <id> [--home <dir>] [--root <dir>] --run-id <uuid> --served-commit <sha40> " +
      "--tool-sha256 <sha64> --mode presigned [--paths <file>] [--run-file <path>] [--chunk-bytes N] [--progress <path>] " +
      "[--pid-file <path>]\n       bun install/nap-archive.ts --tenant <id> [--home <dir>] [--root <dir>] --dry-run",
  );
  process.exit(2);
}

function boundedInt(text: string | undefined, name: string, min: number, max: number, fallback: number): number {
  if (text === undefined || text.trim() === "") return fallback;
  if (!/^[0-9]+$/.test(text.trim())) usage(`${name} must be an integer`);
  const n = Number(text.trim());
  if (!Number.isSafeInteger(n) || n < min || n > max) usage(`${name} must be between ${min} and ${max}`);
  return n;
}

/** The flag, else the variable; both given and different is a usage error. */
function pick(flag: string | undefined, envValue: string | undefined, name: string, varName: string): string | undefined {
  const e = envValue?.trim() || undefined;
  if (flag !== undefined && e !== undefined && flag !== e) usage(`${name} and ${varName} disagree`);
  return flag ?? e;
}

const inside = (dir: string, path: string) => resolve(path).startsWith(resolve(dir) + sep);

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): ArchiveOptions {
  const flags: Record<string, string | undefined> = {};
  let dryRun = false;
  const known = new Set([
    "--tenant", "--home", "--root", "--run-id", "--served-commit", "--tool-sha256", "--paths", "--mode", "--run-file", "--chunk-bytes",
    "--progress", "--pid-file",
  ]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (!known.has(arg)) usage(`unknown argument ${arg}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${arg} needs a value`);
    if (flags[arg] !== undefined) usage(`${arg} given twice`);
    flags[arg] = v;
  }
  const tenant = (flags["--tenant"] ?? env.AV_TENANT_ID ?? "").trim();
  if (!TENANT.test(tenant)) usage("a valid --tenant (or AV_TENANT_ID) is required");
  const runId = pick(flags["--run-id"], env.NAP_RUN_ID, "--run-id", "NAP_RUN_ID") ?? "";
  if (!dryRun && !UUID.test(runId)) usage("--run-id (or NAP_RUN_ID) must be a lowercase uuid");
  const servedCommit = pick(flags["--served-commit"], env.NAP_SERVED_COMMIT, "--served-commit", "NAP_SERVED_COMMIT") ?? "";
  if (!dryRun && !HEX40.test(servedCommit)) usage("--served-commit (or NAP_SERVED_COMMIT) must be 40 lowercase hex");
  const toolSha = pick(flags["--tool-sha256"], env.NAP_TOOL_SHA256, "--tool-sha256", "NAP_TOOL_SHA256") ?? "";
  if (!dryRun && !HEX64.test(toolSha)) usage("--tool-sha256 (or NAP_TOOL_SHA256) must be 64 lowercase hex");
  const mode = pick(flags["--mode"], env.NAP_MODE, "--mode", "NAP_MODE") ?? "";
  if (!dryRun && mode !== "presigned" && mode !== "ingest") usage("--mode must be presigned or ingest");
  if (!flags["--root"] && !env.HOME) usage("--root (or HOME) is required");
  const home = resolve(flags["--home"] ?? hermesHome());
  const root = resolve(flags["--root"] ?? env.HOME ?? "");
  if (!inside(root, home)) usage("--home must sit inside --root");
  const napDir = join(home, ...NAP_DIR.split("/"));
  const runFile = resolve(flags["--run-file"] ?? join(napDir, "run.json"));
  const progress = resolve(flags["--progress"] ?? join(napDir, "progress.json"));
  const pidFile = resolve(flags["--pid-file"] ?? join(napDir, "archive.pid"));
  if (![runFile, progress, pidFile].every((p) => inside(napDir, p))) {
    usage("--run-file, --progress and --pid-file must sit under $HERMES_HOME/av-events/nap/");
  }
  const pathsFile = resolve(pick(flags["--paths"], env.NAP_PATHS_FILE, "--paths", "NAP_PATHS_FILE") ?? join(import.meta.dir, "nap-state-paths.json"));
  const chunkFlag = pick(flags["--chunk-bytes"], env.NAP_CHUNK_BYTES, "--chunk-bytes", "NAP_CHUNK_BYTES");
  const chunkBytes = boundedInt(chunkFlag, "--chunk-bytes", MIN_CHUNK_BYTES, MAX_CHUNK_BYTES, DEFAULT_CHUNK_BYTES);
  const version = (v: string | undefined) => (v && VERSION_TEXT.test(v.trim()) ? v.trim() : null);
  const secretNames = env.NAP_APPROVALD_SECRET_NAMES?.trim();
  return {
    tenant,
    home,
    root,
    runId,
    servedCommit,
    toolSha256: toolSha,
    pathsFile,
    mode,
    runFile,
    chunkBytes,
    progress,
    pidFile,
    dryRun,
    publicKeyPem: env.NAP_WRAP_PUBLIC_KEY ?? "",
    hermesVersion: version(env.NAP_HERMES_VERSION),
    approvaldVersion: version(env.NAP_APPROVALD_VERSION),
    approvaldSecretNames: secretNames ? boundedInt(secretNames, "NAP_APPROVALD_SECRET_NAMES", 0, 1_000_000, 0) : null,
    parallel: boundedInt(env.NAP_UPLOAD_PARALLEL, "NAP_UPLOAD_PARALLEL", 1, 16, 3),
    timeoutMs: boundedInt(env.NAP_UPLOAD_TIMEOUT_S, "NAP_UPLOAD_TIMEOUT_S", 1, 3600, 30) * 1000,
    retryMs: boundedInt(env.NAP_UPLOAD_RETRY_MS, "NAP_UPLOAD_RETRY_MS", 0, 60_000, 1000),
    attempts: 4,
    procRoot: env.NAP_PROC_ROOT?.trim() || "/proc",
    maxFilesJsonBytes: MAX_FILES_JSON_BYTES,
  };
}

/** Leave the disk as a failure does: `.part` files gone, progress `failed`, staged inputs and pid file removed. */
function abandon(reason: string): Record<string, unknown> {
  const l = live;
  const line = { status: "error", reason, chunks_acked: l?.doc?.acked.length ?? 0 };
  if (l) {
    removeParts(l.chunks);
    if (l.doc) {
      try {
        writeJsonAtomic(l.progress, { ...l.doc, phase: "failed", reason, result: line, updated_at: new Date().toISOString() });
      } catch {
        // the line still says it
      }
    }
    removeQuietly(l.runFile);
    removeQuietly(l.storeTar);
    removeQuietly(l.pidFile);
  }
  return line;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  process.on("SIGINT", () => {
    console.log(JSON.stringify(abandon("interrupted")));
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    console.log(JSON.stringify(abandon("interrupted")));
    process.exit(143);
  });
  let outcome: ArchiveOutcome;
  try {
    outcome = await runArchive(opts);
  } catch {
    outcome = { code: 1, line: abandon("internal_error") };
  }
  console.log(JSON.stringify(outcome.line));
  process.exit(outcome.code);
}
