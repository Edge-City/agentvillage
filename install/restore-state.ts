#!/usr/bin/env bun
/**
 * Restore a box's state from its nap archive, before the gateway starts (P-COST NAP design v2: 1.4, 6.1,
 * 6.2 step 5, 10.A; section 12 M2; 13 M1, M3, S3, S4). The control plane runs it on the woken runtime
 * exactly as it runs `install/restore-memory.ts`, and acts on the one JSON line it prints: on anything but
 * `restored` (or `verified` with `--verify-only`) it must not start the gateway.
 *
 *   bun --no-env-file --no-install install/restore-state.ts --tenant <id> --manifest <key> --mode presigned
 *       [--run-file <path>] [--key-file <path>] [--home <dir>] [--root <dir>]
 *       [--approvald-out <dir>] [--verify-only] [--repair] [--no-merge-env] [--dry-run]
 *
 * `--manifest` is the copy of record the `naps` row names: `nap/<tenant>/<date>/<run>/state_manifest.<sha256>.json`
 * (never "latest"). `--root` is the home the archive walked (`$HOME`); `--home` is `$HERMES_HOME` inside it.
 * The run file (`av-events/nap/run.json`, 0600) holds presigned GET URLs for the manifest and each chunk.
 *
 * The key (12 M2): the box never holds the fleet private key, and nothing here reads key material from the
 * environment. The control plane unwraps this run's data key in its own process and hands over only
 * `{"schema":"nap_key.v1","data_key_b64":…,"iv_b64":…}` in a 0600 file (`--key-file`, default
 * `av-events/nap/restore-key.json`), written by the control plane with `files.write` or from the exec
 * environment, never in a command's text (review-a N-n4); the key is read from that file and nowhere else.
 * The run file and the key file are deleted on exit.
 *
 * All-or-nothing verification before anything is written: the manifest hashes to its key and names this
 * tenant, date and run; the data key's IV is the manifest's; each chunk's size and SHA-256 equal the
 * manifest's before its bytes are decrypted; AES-256-GCM's tag verifies; the plaintext payload's SHA-256
 * and length equal the manifest's; the tar holds `files.json` then exactly one data entry per file, in
 * order; every path is clean, under the root and not on the CURRENT exclude list, whatever rules the
 * archive says it was made under; every file's class is a known one; every file's size and SHA-256 equal
 * `files.json`'s; no target is (or sits under) a symlink or the wrong kind of file. Any mismatch is
 * `status: "refused"` and writes nothing.
 *
 * What is written back, by class (13 M3), each file's class taken from the CURRENT rules (`classOf`), never
 * from `files.json` (the box wrote it; a file whose recorded class differs is counted `class_reclassified`;
 * `paths_sha256` is informational, `paths_match` in the line): `state`, `unclassified`, `log` and `link` as archived;
 * `secret_box` with mode 0600, except `$HERMES_HOME/.env`, which is MERGED by default: every archived line
 * whose key is not in `CP_REMINTABLE.env_keys` and is not already set is added to the file the control
 * plane wrote (`--no-merge-env` leaves it alone, a batch-1 diagnostic); `secret_cp` is never written (the
 * wake re-minted it). The approvald store copy (13 S3, S4; review-a (b) at L43357, release L43372) is an
 * opaque pair the cp encrypted to its own key: the store blob and its member list. The box never decrypts or
 * parses either, and neither ever lands in the home: with `--approvald-out <dir>` (a directory outside the
 * root) both are written there 0600 as `nap-store.enc` and `nap-store.members.enc`, byte-verified against
 * `files.json` and the manifest's shas, for the control plane's root step to decrypt, check and restore into
 * `/var/lib/approvald/<t>/`; without it, they are verified and not written. An archive with
 * `store_copy: none` (shape (a)) has neither, and nothing is written.
 *
 * Two-phase write: each file to write is staged (mode and mtime from `files.json`) under
 * `av-events/nap/restore-staging/`, every one is moved next to its target under a temp name, and only then
 * is each renamed into place. A failure before the renames removes every temp and writes nothing.
 *
 * `--verify-only` (a checkpoint boot, route (i)): writes nothing; walks the whole root with the same
 * exclude list and compares it with `files.json` BOTH ways (`drift_missing`, `drift_changed`, and
 * `drift_extra` for a file on disk the archive does not hold); `secret_cp` files and `$HERMES_HOME/.env`
 * are not compared (the wake rewrote them). `--repair` with it writes the archive's copy of each changed or
 * missing file, and refuses when there are extra files (it never deletes).
 *
 * Marker: `$HERMES_HOME/av-events/nap/restore.json` `{status, manifest_key, reason?, written, at}` on a
 * restore or a repair (not on `--verify-only` alone or `--dry-run`).
 *
 * Output: one JSON line `{status, manifest_key, files, bytes, written, unchanged, drift_missing, drift_extra,
 * drift_changed, secret_cp_skipped, secret_box_written, env_merged, links, class_reclassified, store_copy,
 * store_written, paths_match, reason?}`; `status` is restored,
 * verified, repaired, dry_run, drift, refused or error. Never a path, a URL, a key or file content.
 * Exit: 0 restored, verified, repaired or dry_run; 1 drift, refused or error; 2 usage.
 */

import { createDecipheriv, createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";

import {
  type DataKey,
  dataEntryName,
  fail,
  FILES_ENTRY,
  FILES_SCHEMA,
  type FileEntry,
  EMPTY_SHA256,
  hasData,
  HEX64,
  isInt,
  type Manifest,
  MANIFEST_SLOT_NAME,
  manifestName,
  MAX_DOC_BYTES,
  MAX_FILES_JSON_BYTES,
  NapError,
  type NapTransport,
  parseKeyDoc,
  parseManifest,
  parseManifestKey,
  parseRunFile,
  presignedTransport,
  readPrivateFile,
  removeQuietly,
  sha256,
  TarReader,
  type TarSink,
  tarPadding,
  TENANT,
  TRANSPORT_PRESIGNED,
  writeJsonAtomic,
} from "./nap-common";
import {
  cleanRelPath,
  classOf,
  CP_REMINTABLE,
  ENV_FILE,
  linkTargetValid,
  napPathsSha256,
  NAP_DIR,
  STORE_BLOB_ENTRY,
  STORE_ENTRIES,
  type PathRules,
  restorable,
  walkHome,
  WalkRefused,
} from "./nap-state-paths";
import { hermesHome } from "./paths";

/** Where `--approvald-out <dir>` receives a store entry: `nap-store.enc`, `nap-store.members.enc`. */
const storeOutPath = (dir: string, entry: string) => join(dir, entry.slice(entry.lastIndexOf("/") + 2));

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/;
const MAX_ENV_BYTES = 1024 * 1024;

export type RestoreOptions = {
  tenant: string;
  manifestKey: string;
  mode: string;
  runFile: string;
  keyFile: string;
  home: string;
  root: string;
  approvaldOut: string | null;
  verifyOnly: boolean;
  repair: boolean;
  mergeEnv: boolean;
  dryRun: boolean;
  timeoutMs: number;
  retryMs: number;
  attempts: number;
};

export type RestoreLine = {
  status: "restored" | "verified" | "repaired" | "dry_run" | "drift" | "refused" | "error";
  manifest_key: string;
  files: number;
  bytes: number;
  written: number;
  unchanged: number;
  drift_missing: number;
  drift_extra: number;
  drift_changed: number;
  secret_cp_skipped: number;
  secret_box_written: number;
  env_merged: number;
  links: number;
  /** The archive's store copy (`blob` or `none`) and how many of its two files went to `--approvald-out`. */
  store_copy?: "blob" | "none";
  store_written: number;
  /** Files whose recorded class differs from the current rules' class; written by the current class. */
  class_reclassified: number;
  /** Whether the archive was made under the rules this restore carries (informational only). */
  paths_match?: boolean;
  reason?: string;
};

type Act = "write" | "unchanged" | "skip" | "env" | "store" | "same" | "missing" | "changed";
type Plan = { entry: FileEntry; index: number; act: Act };

const segments = (rel: string) => rel.split("/");

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

const FILE_CLASSES: readonly string[] = ["state", "secret_cp", "secret_box", "unclassified", "log"];
/** A regular file of the home (not a link, a directory or the store pair). */
const isHomeFile = (f: FileEntry) => FILE_CLASSES.includes(f.class) && !STORE_ENTRIES.includes(f.path);

/** Validate `files.json` against the manifest's counts and the path rules. */
export function validateFiles(doc: unknown, manifest: Manifest, rules: PathRules): FileEntry[] {
  const d = doc as { schema?: unknown; files?: unknown };
  if (!d || typeof d !== "object" || d.schema !== FILES_SCHEMA || !Array.isArray(d.files)) fail("files_invalid");
  const files = d.files as FileEntry[];
  const allowed = new Set(["path", "bytes", "sha256", "mtime_ms", "mode", "class", "target", "same_as"]);
  const byPath = new Map<string, FileEntry>();
  let last = "";
  let stores = 0;
  // The manifest and files.json are written on the box, so a tampered box can craft both: paths_sha256
  // never relaxes anything. Every entry meets the CURRENT exclude list, and the current classOf decides
  // secret handling (plan, commit); the recorded class only has to be a known one.
  for (const f of files) {
    if (!f || typeof f !== "object" || Object.keys(f).some((k) => !allowed.has(k))) fail("files_invalid");
    if (!isInt(f.bytes) || !isInt(f.mtime_ms) || !isInt(f.mode) || f.mode > 0o777 || typeof f.sha256 !== "string" || !HEX64.test(f.sha256)) {
      fail("files_invalid");
    }
    if (STORE_ENTRIES.includes(f.path)) {
      // The store copy's encrypted blob, then its encrypted list (in that order), each once, opaque `state` entries.
      if (f.class !== "state" || f.target !== undefined || f.same_as !== undefined) fail("files_invalid");
      if (f.path !== STORE_ENTRIES[stores++]) fail("files_invalid");
      const want = f.path === STORE_BLOB_ENTRY ? manifest.store_blob_sha256 : manifest.store_members_sha256;
      if (manifest.store_copy !== "blob" || f.sha256 !== want) fail("files_invalid");
      continue;
    }
    if (stores > 0) fail("files_invalid"); // home entries come first, then the store pair
    // Nothing is ever written through a link (Fable S4): every ancestor files.json names is a directory.
    if (typeof f.path === "string") {
      const parts = f.path.split("/");
      for (let i = 1; i < parts.length; i++) {
        const up = byPath.get(parts.slice(0, i).join("/"));
        if (up && up.class !== "dir") fail("files_invalid");
      }
    }
    if (typeof f.path !== "string" || !cleanRelPath(f.path)) fail("path_not_allowed");
    if (!restorable(f.path, rules, f.class === "dir")) fail("path_not_allowed");
    if (last && !(f.path > last)) fail("files_invalid");
    last = f.path;
    if (f.class === "dir") {
      if (f.target !== undefined || f.same_as !== undefined || f.bytes !== 0 || f.sha256 !== EMPTY_SHA256) fail("files_invalid");
    } else if (f.class === "link") {
      if (!linkTargetValid(f.target) || f.same_as !== undefined) fail("files_invalid");
      if (f.bytes !== Buffer.byteLength(f.target) || f.sha256 !== sha256(f.target)) fail("files_invalid");
    } else {
      if (f.target !== undefined) fail("files_invalid");
      if (!FILE_CLASSES.includes(f.class)) fail("class_mismatch");
      if (f.same_as !== undefined) {
        const first = byPath.get(f.same_as);
        if (!first || !hasData(first) || first.bytes !== f.bytes || first.sha256 !== f.sha256) fail("files_invalid");
      }
    }
    byPath.set(f.path, f);
  }
  if ((manifest.store_copy === "blob") !== (stores === 2)) fail("files_invalid");
  const p = manifest.payload;
  const count = (c: FileEntry["class"]) => files.filter((f) => f.class === c).length;
  if (
    files.length !== p.file_count ||
    files.filter((f) => f.class !== "link").reduce((n, f) => n + f.bytes, 0) !== p.total_file_bytes ||
    count("secret_cp") !== p.secret_cp_count ||
    count("secret_box") !== p.secret_box_count ||
    count("unclassified") !== p.unclassified_count ||
    count("link") !== p.link_count ||
    count("log") !== p.log_count ||
    count("dir") !== p.dir_count
  ) {
    fail("counts_mismatch");
  }
  return files;
}

type DiskState = "same" | "missing" | "differs" | "parent_bad" | "kind_bad";

/** Compare one entry with the disk under `root`, never following a symlink. */
function diskState(root: string, f: FileEntry): DiskState {
  const parts = segments(f.path);
  for (let i = 1; i < parts.length; i++) {
    const st = lstatOrNull(join(root, ...parts.slice(0, i)));
    if (!st) return "missing";
    if (!st.isDirectory()) return "parent_bad";
  }
  const path = join(root, ...parts);
  const st = lstatOrNull(path);
  if (!st) return "missing";
  if (f.class === "dir") {
    if (!st.isDirectory()) return "kind_bad";
    return (st.mode & 0o777) === f.mode ? "same" : "differs";
  }
  if (f.class === "link") {
    if (!st.isSymbolicLink()) return "kind_bad";
    return readlinkSync(path) === f.target ? "same" : "differs";
  }
  if (!st.isFile()) return "kind_bad";
  if (st.size !== f.bytes) return "differs";
  return sha256(readFileSync(path)) === f.sha256 ? "same" : "differs";
}

type EnvEntry = { key: string; lines: string[] };

/** The `.env` assignments in order, a quoted value that spans lines kept whole (Fable N2); comments and
 * blank lines are not entries. */
export function envEntries(text: string): EnvEntry[] {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const out: EnvEntry[] = [];
  const closes = (q: string, s: string) => {
    for (let i = 0; i < s.length; i++) {
      if (q === '"' && s[i] === "\\") {
        i++;
        continue;
      }
      if (s[i] === q) return true;
    }
    return false;
  };
  for (let i = 0; i < lines.length; i++) {
    const m = ENV_LINE.exec(lines[i]);
    if (!m) continue;
    const value = lines[i].slice(lines[i].indexOf("=") + 1).trimStart();
    const block = [lines[i]];
    const q = value[0];
    if ((q === '"' || q === "'") && !closes(q, value.slice(1))) {
      let j = i + 1;
      while (j < lines.length) {
        block.push(lines[j]);
        if (closes(q, lines[j])) break;
        j++;
      }
      if (j >= lines.length) continue; // never closed: not a value a merge can carry; env.archived keeps it
      i = j;
    }
    out.push({ key: m[1], lines: block });
  }
  return out;
}

/** The archived `.env` entries a restore adds: keys the control plane does not re-mint, not set in `current`. */
export function envEntriesToMerge(archived: string, current: string): EnvEntry[] {
  const have = new Set(envEntries(current).map((e) => e.key));
  const add: EnvEntry[] = [];
  const seen = new Set<string>();
  for (const e of envEntries(archived)) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    if (!CP_REMINTABLE.env_keys.includes(e.key) && !have.has(e.key)) add.push(e);
  }
  return add;
}

/** The lines of those entries, in order. */
export const envLinesToMerge = (archived: string, current: string): string[] => envEntriesToMerge(archived, current).flatMap((e) => e.lines);

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** Resolve on the stream's next `drain`, `error` or `close`, whichever comes first. */
function drainOrEnd(stream: NodeJS.EventEmitter): Promise<void> {
  return new Promise<void>((res) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("error", done);
      stream.off("close", done);
      res();
    };
    stream.once("drain", done);
    stream.once("error", done);
    stream.once("close", done);
  });
}

async function download(transport: NapTransport, name: string, maxBytes: number, opts: RestoreOptions): Promise<Uint8Array | null> {
  for (let attempt = 1; ; attempt++) {
    const parts: Uint8Array[] = [];
    let size = 0;
    let outcome: string;
    try {
      outcome = await transport.get(name, maxBytes, (b) => {
        size += b.length;
        if (size > maxBytes) fail("download_too_large");
        parts.push(Buffer.from(b));
      });
    } catch (err) {
      if (err instanceof NapError) throw err;
      outcome = "retry"; // timeout or network; the URL is never in the message
    }
    if (outcome === "ok") return Buffer.concat(parts);
    if (outcome === "missing") return null;
    if (outcome !== "retry") throw new NapError(outcome);
    if (attempt >= opts.attempts) throw new NapError("download_unavailable");
    await sleep(opts.retryMs * 2 ** (attempt - 1));
  }
}

const TRANSPORT_ERRORS = new Set(["download_unavailable", "url_expired", "auth_refused", "download_too_large"]);
const kindOf = (code: string) => (TRANSPORT_ERRORS.has(code) || code.startsWith("download_http_") ? "error" : "refused");

export async function runRestore(opts: RestoreOptions): Promise<{ code: number; line: RestoreLine }> {
  const napDir = join(opts.home, ...NAP_DIR.split("/"));
  const staging = join(napDir, "restore-staging");
  const line: RestoreLine = {
    status: "refused",
    manifest_key: opts.manifestKey,
    files: 0,
    bytes: 0,
    written: 0,
    unchanged: 0,
    drift_missing: 0,
    drift_extra: 0,
    drift_changed: 0,
    secret_cp_skipped: 0,
    secret_box_written: 0,
    env_merged: 0,
    links: 0,
    class_reclassified: 0,
    store_written: 0,
  };
  const writes = !opts.dryRun && (!opts.verifyOnly || opts.repair);
  const end = (status: RestoreLine["status"], reason?: string) => {
    line.status = status;
    if (reason) line.reason = reason;
    else delete line.reason;
    rmSync(staging, { recursive: true, force: true });
    if (writes) {
      try {
        writeJsonAtomic(join(napDir, "restore.json"), {
          status,
          manifest_key: opts.manifestKey,
          ...(reason ? { reason } : {}),
          written: line.written,
          verify_only: opts.verifyOnly,
          at: new Date().toISOString(),
        });
      } catch {
        // the JSON line still reports it
      }
    }
    const ok = status === "restored" || status === "verified" || status === "repaired" || status === "dry_run";
    return { code: ok ? 0 : 1, line };
  };

  let key: DataKey;
  try {
    key = parseKeyDoc(readPrivateFile(opts.keyFile, "data_key_missing", "data_key_invalid", "key_file_mode"));
  } catch (err) {
    removeQuietly(opts.keyFile);
    removeQuietly(opts.runFile);
    if (err instanceof NapError) return end("refused", err.code);
    throw err;
  }
  removeQuietly(opts.keyFile);
  try {
    return await restoreInner(opts, key, line, staging, end);
  } finally {
    key.key.fill(0);
    removeQuietly(opts.runFile);
  }
}

async function restoreInner(
  opts: RestoreOptions,
  key: DataKey,
  line: RestoreLine,
  staging: string,
  end: (status: RestoreLine["status"], reason?: string) => { code: number; line: RestoreLine },
): Promise<{ code: number; line: RestoreLine }> {
  const root = opts.root;
  const rules: PathRules = { hermesRel: relative(opts.root, opts.home).split(sep).join("/") };
  const envRel = rules.hermesRel ? `${rules.hermesRel}/${ENV_FILE}` : ENV_FILE;
  let manifest: Manifest;
  let transport: NapTransport;
  try {
    if (opts.mode !== TRANSPORT_PRESIGNED) fail("transport_not_built");
    const k = parseManifestKey(opts.manifestKey)!;
    const run = parseRunFile(readPrivateFile(opts.runFile, "run_file_missing", "run_file_invalid", "run_file_mode"), {
      direction: "get",
      tenant: opts.tenant,
      runId: k.runId,
      manifestNames: [MANIFEST_SLOT_NAME, manifestName(k.sha)],
    });
    if (run.prefix !== k.prefix) fail("run_file_mismatch");
    transport = presignedTransport(run, opts.timeoutMs);
    const bytes = await download(transport, "manifest", MAX_DOC_BYTES, opts);
    if (!bytes) fail("manifest_missing");
    manifest = parseManifest(bytes, opts.manifestKey, opts.tenant);
    if (!key.iv.equals(Buffer.from(manifest.iv_b64, "base64"))) fail("key_mismatch");
    if (run.chunks.length < manifest.chunks.length) fail("run_file_invalid");
  } catch (err) {
    if (err instanceof NapError) return end(kindOf(err.code), err.code);
    throw err;
  }

  // ---- stream: chunk (hash-checked first) → AES-256-GCM → gunzip → tar ----
  const decipher = createDecipheriv("aes-256-gcm", key.key, key.iv);
  decipher.setAuthTag(Buffer.from(manifest.gcm_tag_b64, "base64"));
  const gunzip = createGunzip();
  const payloadHash = createHash("sha256");
  let payloadBytes = 0;
  let decodeError: string | null = null;
  let files: FileEntry[] | null = null;
  let plans: Plan[] = [];
  const filesJsonParts: Buffer[] = [];
  let dataOrder: number[] = [];
  let nextData = 0;
  let tarLimit = Infinity;
  let tarSeen = 0;
  let envArchived: Buffer | null = null;
  let envCurrent = "";
  const stagedPath = (index: number) => join(staging, String(index).padStart(6, "0"));
  const toStage = new Set<number>();

  const plan = (entries: FileEntry[]): void => {
    const index = new Map(entries.map((f, i) => [f.path, i]));
    plans = entries.map((entry, i) => {
      const act = (a: Act): Plan => ({ entry, index: i, act: a });
      if (STORE_ENTRIES.includes(entry.path)) return act("store");
      // What the CURRENT rules call secret_cp is skipped; the recorded class is never consulted (it is box-written).
      const isCp = (f: FileEntry) => isHomeFile(f) && classOf(f.path, rules) === "secret_cp";
      if (isCp(entry)) return act("skip");
      // A hard link to a secret_cp file carries the same stale bytes: skipped too (Fable N3).
      if (entry.same_as !== undefined && isCp(entries[index.get(entry.same_as)!])) return act("skip");
      if (entry.path === envRel) return act("env");
      const state = diskState(root, entry);
      if (opts.verifyOnly) {
        if ((state === "parent_bad" || state === "kind_bad") && opts.repair) {
          throw new NapError(state === "parent_bad" ? "target_parent_not_directory" : "target_not_regular");
        }
        return act(state === "same" ? "same" : state === "missing" ? "missing" : "changed");
      }
      if (state === "parent_bad") throw new NapError("target_parent_not_directory");
      if (state === "kind_bad") {
        throw new NapError(entry.class === "link" ? "target_kind_mismatch" : entry.class === "dir" ? "target_not_directory" : "target_not_regular");
      }
      return act(state === "same" ? "unchanged" : "write");
    });
    if (opts.verifyOnly) {
      let walked;
      try {
        walked = walkHome(root, rules);
      } catch (err) {
        if (err instanceof WalkRefused) throw new NapError(err.message);
        throw err;
      }
      for (const w of walked.items) {
        if (index.has(w.rel) || w.rel === envRel) continue;
        if (w.type === "file" && classOf(w.rel, rules) === "secret_cp") continue;
        line.drift_extra++;
      }
    } else if (!opts.dryRun) {
      if (opts.mergeEnv && entries.some((f) => f.path === envRel)) {
        const st = lstatOrNull(join(root, ...segments(envRel)));
        if (st && !st.isFile()) throw new NapError("target_not_regular");
        envCurrent = st ? readFileSync(join(root, ...segments(envRel)), "utf8") : "";
      }
      if (opts.approvaldOut && entries.some((f) => STORE_ENTRIES.includes(f.path))) {
        const dir = lstatOrNull(opts.approvaldOut);
        if (!dir || !dir.isDirectory()) throw new NapError("approvald_out_invalid");
        for (const e of STORE_ENTRIES) {
          const target = lstatOrNull(storeOutPath(opts.approvaldOut, e));
          if (target && !target.isFile()) throw new NapError("approvald_out_invalid");
        }
      }
    }
    // What gets staged: the data of every entry to write (a hard link's data comes from its first entry).
    const stageAll = !opts.dryRun && (!opts.verifyOnly || (opts.repair && line.drift_extra === 0));
    for (const p of plans) {
      if (!stageAll || p.entry.class === "link" || p.entry.class === "dir") continue;
      const wanted = p.act === "write" || (p.act === "store" && !!opts.approvaldOut && !opts.verifyOnly) ||
        ((p.act === "missing" || p.act === "changed") && opts.repair);
      if (wanted) toStage.add(p.entry.same_as !== undefined ? index.get(p.entry.same_as)! : p.index);
    }
    if (toStage.size > 0) mkdirSync(staging, { recursive: true, mode: 0o700 });
  };

  const open = (name: string, size: number): TarSink => {
    if (!files) {
      if (name !== FILES_ENTRY || size > MAX_FILES_JSON_BYTES) fail("archive_files_mismatch");
      return {
        write: (b) => void filesJsonParts.push(Buffer.from(b)),
        end: () => {
          let doc: unknown;
          try {
            doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(filesJsonParts)));
          } catch {
            fail("files_invalid");
          }
          files = validateFiles(doc, manifest, rules);
          line.paths_match = manifest.paths_sha256 === napPathsSha256();
          line.class_reclassified = files.filter((f) => isHomeFile(f) && f.class !== classOf(f.path, rules)).length;
          line.store_copy = manifest.store_copy;
          dataOrder = files.map((f, i) => (hasData(f) ? i : -1)).filter((i) => i >= 0);
          tarLimit = 512 + size + tarPadding(size) + 10240 +
            dataOrder.reduce((n, i) => n + 512 + files![i].bytes + tarPadding(files![i].bytes), 0);
          plan(files);
        },
      };
    }
    if (nextData >= dataOrder.length) fail("archive_files_mismatch");
    const i = dataOrder[nextData++];
    const f = files[i];
    if (name !== dataEntryName(i) || size !== f.bytes) fail("archive_files_mismatch");
    const hash = createHash("sha256");
    let fd = toStage.has(i) ? openSync(stagedPath(i), "wx", 0o600) : -1;
    // The archived .env is always captured on a restore: kept whole as env.archived (Fable N2), merged when
    // it is under MAX_ENV_BYTES and --no-merge-env is not given.
    const captureEnv = f.path === envRel && !opts.verifyOnly && !opts.dryRun;
    const envParts: Buffer[] = [];
    let got = 0;
    return {
      write: (b) => {
        hash.update(b);
        got += b.length;
        if (fd >= 0) {
          let off = 0;
          while (off < b.length) off += writeSync(fd, b, off, b.length - off);
        }
        if (captureEnv) envParts.push(Buffer.from(b));
      },
      end: () => {
        if (fd >= 0) {
          fsyncSync(fd);
          closeSync(fd);
          fd = -1;
        }
        if (got !== f.bytes || hash.digest("hex") !== f.sha256) fail("file_hash_mismatch");
        if (captureEnv) envArchived = Buffer.concat(envParts);
      },
    };
  };
  const tar = new TarReader(open);
  gunzip.on("data", (buf: Buffer) => {
    if (decodeError) return;
    tarSeen += buf.length;
    try {
      if (tarSeen > tarLimit) fail("payload_too_large");
      tar.push(buf);
    } catch (err) {
      decodeError = err instanceof NapError ? err.code : "payload_unreadable";
    }
  });
  const gunzipDone = new Promise<void>((res) => {
    gunzip.on("end", () => res());
    gunzip.on("error", () => {
      decodeError ??= "payload_unreadable";
      res();
    });
  });
  const feed = async (bytes: Uint8Array) => {
    if (decodeError || gunzip.destroyed || bytes.length === 0) return;
    // A payload that does not gunzip (a wrong key decrypts to noise until the tag is checked) errors the
    // stream, which never drains again: stop waiting on any of the three.
    if (!gunzip.write(bytes)) await drainOrEnd(gunzip);
  };

  try {
    for (const c of manifest.chunks) {
      const bytes = await download(transport, c.name, c.bytes, opts);
      if (!bytes) fail("chunk_missing");
      if (bytes.length !== c.bytes) fail("chunk_size_mismatch");
      if (sha256(bytes) !== c.sha256) fail("chunk_hash_mismatch");
      const plain = decipher.update(bytes);
      payloadHash.update(plain);
      payloadBytes += plain.length;
      await feed(plain);
    }
    let tagOk = true;
    try {
      const tail = decipher.final();
      if (tail.length) {
        payloadHash.update(tail);
        payloadBytes += tail.length;
        await feed(tail);
      }
    } catch {
      tagOk = false;
    }
    gunzip.end();
    await gunzipDone;
    if (!tagOk) fail("gcm_tag_invalid");
    if (payloadBytes !== manifest.payload.bytes || payloadHash.digest("hex") !== manifest.payload.sha256) fail("payload_hash_mismatch");
    if (decodeError) fail(decodeError);
    tar.finish();
    if (!files || nextData !== dataOrder.length) fail("archive_files_mismatch");
  } catch (err) {
    gunzip.destroy();
    if (err instanceof NapError) return end(kindOf(err.code), err.code);
    return end("error", "restore_failed");
  }

  // ---- counts, then the writes ----
  const all = files as FileEntry[];
  line.files = all.length;
  line.links = all.filter((f) => f.class === "link").length;
  line.secret_cp_skipped = plans.filter((p) => p.act === "skip").length;
  const bytesOf = (items: Plan[]) => items.reduce((n, p) => n + (p.entry.class === "link" ? 0 : p.entry.bytes), 0);
  if (opts.verifyOnly) {
    const missing = plans.filter((p) => p.act === "missing");
    const changed = plans.filter((p) => p.act === "changed");
    line.drift_missing = missing.length;
    line.drift_changed = changed.length;
    line.unchanged = plans.filter((p) => p.act === "same").length;
    const drift = missing.length + changed.length + line.drift_extra;
    if (drift === 0) return end(opts.dryRun ? "dry_run" : "verified");
    if (!opts.repair) return end(opts.dryRun ? "dry_run" : "drift", opts.dryRun ? undefined : "checkpoint_drift");
    if (line.drift_extra > 0) return end("drift", "checkpoint_drift");
    if (opts.dryRun) {
      line.written = missing.length + changed.length;
      line.bytes = bytesOf([...missing, ...changed]);
      return end("dry_run");
    }
    return commit([...missing, ...changed], "repaired");
  }
  const toWrite = plans.filter((p) => p.act === "write");
  line.unchanged = plans.filter((p) => p.act === "unchanged").length;
  if (opts.dryRun) {
    line.written = toWrite.length;
    line.bytes = bytesOf(toWrite);
    return end("dry_run");
  }
  const store = opts.approvaldOut ? plans.filter((p) => p.act === "store") : [];
  return commit([...toWrite, ...store], "restored");

  function commit(items: Plan[], status: "restored" | "repaired") {
    const indexOf = new Map(all.map((f, i) => [f.path, i]));
    const moved: { tmp: string; target: string; item: Plan }[] = [];
    const tmpName = (dir: string, base: string) => join(dir, `.${base}.nap-restore-${process.pid}-${randomBytes(4).toString("hex")}`);
    let envTmp: string | null = null;
    let keptTmp: string | null = null;
    const napDirPath = join(opts.home, ...NAP_DIR.split("/"));
    let envAdd: EnvEntry[] = [];
    // Directories (Fable S2): created now, their mode and mtime set last, deepest first, after every rename.
    const dirItems = items.filter((i) => i.entry.class === "dir");
    try {
      for (const item of dirItems) mkdirSync(join(root, ...segments(item.entry.path)), { recursive: true, mode: 0o700 });
      for (const item of items) {
        if (item.entry.class === "dir") continue;
        const isStore = STORE_ENTRIES.includes(item.entry.path);
        const target = isStore ? storeOutPath(opts.approvaldOut!, item.entry.path) : join(root, ...segments(item.entry.path));
        const dir = dirname(target);
        if (!isStore) mkdirSync(dir, { recursive: true, mode: 0o700 });
        const tmp = tmpName(dir, target.slice(dir.length + 1));
        if (item.entry.class === "link") {
          symlinkSync(item.entry.target!, tmp);
        } else {
          const src = stagedPath(item.entry.same_as !== undefined ? indexOf.get(item.entry.same_as)! : item.index);
          copyFileSync(src, tmp);
          const secret = !isStore && classOf(item.entry.path, rules) === "secret_box";
          chmodSync(tmp, secret || isStore ? 0o600 : item.entry.mode);
          const when = new Date(item.entry.mtime_ms);
          utimesSync(tmp, when, when);
        }
        moved.push({ tmp, target, item });
      }
      // `$HERMES_HOME/.env`: the merge is staged with the rest.
      if (status === "restored" && envArchived !== null) {
        keptTmp = tmpName(napDirPath, "env.archived");
        mkdirSync(napDirPath, { recursive: true, mode: 0o700 });
        writeFileSync(keptTmp, envArchived, { mode: 0o600, flag: "wx" });
      }
      if (status === "restored" && envArchived !== null && opts.mergeEnv && envArchived.length <= MAX_ENV_BYTES) {
        envAdd = envEntriesToMerge(envArchived.toString("utf8"), envCurrent);
        if (envAdd.length > 0) {
          const envPath = join(root, ...segments(envRel));
          mkdirSync(dirname(envPath), { recursive: true, mode: 0o700 });
          envTmp = tmpName(dirname(envPath), ENV_FILE);
          const text = `${envCurrent}${envCurrent && !envCurrent.endsWith("\n") ? "\n" : ""}${envAdd.flatMap((e) => e.lines).join("\n")}\n`;
          writeFileSync(envTmp, text, { mode: 0o600, flag: "wx" });
        }
      }
    } catch {
      for (const m of moved) rmSync(m.tmp, { force: true });
      if (envTmp) rmSync(envTmp, { force: true });
      if (keptTmp) rmSync(keptTmp, { force: true });
      return end("error", "write_failed");
    }
    for (let i = 0; i < moved.length; i++) {
      try {
        renameSync(moved[i].tmp, moved[i].target);
        const e = moved[i].item.entry;
        if (STORE_ENTRIES.includes(e.path)) {
          line.store_written++;
          continue;
        }
        line.written++;
        line.bytes += e.class === "link" ? 0 : e.bytes;
        if (isHomeFile(e) && classOf(e.path, rules) === "secret_box") line.secret_box_written++;
      } catch {
        for (const m of moved.slice(i)) rmSync(m.tmp, { force: true });
        if (envTmp) rmSync(envTmp, { force: true });
        if (keptTmp) rmSync(keptTmp, { force: true });
        return end("error", "write_failed");
      }
    }
    if (keptTmp) {
      try {
        renameSync(keptTmp, join(napDirPath, "env.archived"));
      } catch {
        rmSync(keptTmp, { force: true });
        if (envTmp) rmSync(envTmp, { force: true });
        return end("error", "write_failed");
      }
    }
    if (envTmp) {
      try {
        renameSync(envTmp, join(root, ...segments(envRel)));
        line.env_merged = envAdd.length;
      } catch {
        rmSync(envTmp, { force: true });
        return end("error", "write_failed");
      }
    }
    const depth = (p: string) => p.split("/").length;
    for (const item of [...dirItems].sort((a, b) => depth(b.entry.path) - depth(a.entry.path))) {
      try {
        const path = join(root, ...segments(item.entry.path));
        if (!lstatSync(path).isDirectory()) throw new Error("not a directory");
        chmodSync(path, item.entry.mode);
        const when = new Date(item.entry.mtime_ms);
        utimesSync(path, when, when);
        line.written++;
      } catch {
        return end("error", "write_failed");
      }
    }
    return end(status);
  }
}

function usage(message: string): never {
  console.error(`restore-state: ${message}`);
  console.error(
    "usage: bun install/restore-state.ts --tenant <id> --manifest <key> --mode presigned [--run-file <path>] " +
      "[--key-file <path>] [--home <dir>] [--root <dir>] [--approvald-out <dir>] [--verify-only] [--repair] " +
      "[--no-merge-env] [--dry-run]",
  );
  process.exit(2);
}

const inside = (dir: string, path: string) => resolve(path).startsWith(resolve(dir) + sep);

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): RestoreOptions {
  const flags: Record<string, string | undefined> = {};
  const bools = { "--verify-only": false, "--repair": false, "--no-merge-env": false, "--dry-run": false };
  const valued = new Set(["--tenant", "--manifest", "--mode", "--run-file", "--key-file", "--home", "--root", "--approvald-out"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg in bools) {
      bools[arg as keyof typeof bools] = true;
      continue;
    }
    if (!valued.has(arg)) usage(`unknown argument ${arg}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${arg} needs a value`);
    if (flags[arg] !== undefined) usage(`${arg} given twice`);
    flags[arg] = v;
  }
  const tenant = (flags["--tenant"] ?? env.AV_TENANT_ID ?? "").trim();
  if (!TENANT.test(tenant)) usage("a valid --tenant (or AV_TENANT_ID) is required");
  const manifestKey = flags["--manifest"] ?? "";
  const k = parseManifestKey(manifestKey);
  if (!k) usage("--manifest must be nap/<tenant>/<date>/<run>/state_manifest.<sha256>.json");
  if (k.tenant !== tenant) usage("--manifest names another tenant");
  const mode = flags["--mode"] ?? "";
  if (mode !== "presigned" && mode !== "ingest") usage("--mode must be presigned or ingest");
  if (bools["--repair"] && !bools["--verify-only"]) usage("--repair needs --verify-only");
  if (!flags["--root"] && !env.HOME) usage("--root (or HOME) is required");
  const home = resolve(flags["--home"] ?? hermesHome());
  const root = resolve(flags["--root"] ?? env.HOME ?? "");
  if (!inside(root, home)) usage("--home must sit inside --root");
  const napDir = join(home, ...NAP_DIR.split("/"));
  const runFile = resolve(flags["--run-file"] ?? join(napDir, "run.json"));
  const keyFile = resolve(flags["--key-file"] ?? join(napDir, "restore-key.json"));
  if (!inside(napDir, runFile) || !inside(napDir, keyFile)) usage("--run-file and --key-file must sit under $HERMES_HOME/av-events/nap/");
  const approvaldOut = flags["--approvald-out"] !== undefined ? resolve(flags["--approvald-out"]) : null;
  if (approvaldOut && (inside(root, approvaldOut) || approvaldOut === root || inside(approvaldOut, root))) {
    usage("--approvald-out must be a directory outside the home (--root)");
  }
  const timeout = Number(env.NAP_UPLOAD_TIMEOUT_S ?? "30");
  const retry = Number(env.NAP_UPLOAD_RETRY_MS ?? "1000");
  return {
    tenant,
    manifestKey,
    mode,
    runFile,
    keyFile,
    home,
    root,
    approvaldOut,
    verifyOnly: bools["--verify-only"],
    repair: bools["--repair"],
    mergeEnv: !bools["--no-merge-env"],
    dryRun: bools["--dry-run"],
    timeoutMs: (Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 3600 ? timeout : 30) * 1000,
    retryMs: Number.isSafeInteger(retry) && retry >= 0 && retry <= 60_000 ? retry : 1000,
    attempts: 4,
  };
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  let result: { code: number; line: RestoreLine | Record<string, unknown> };
  try {
    result = await runRestore(opts);
  } catch {
    removeQuietly(opts.keyFile);
    removeQuietly(opts.runFile);
    result = { code: 1, line: { status: "error", manifest_key: opts.manifestKey, reason: "restore_failed" } };
  }
  console.log(JSON.stringify(result.line));
  process.exit(result.code);
}
