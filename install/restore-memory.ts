#!/usr/bin/env bun
/**
 * Restore a tenant's memory files from its latest backup (DATA-82).
 *
 * The control plane runs this on a recreated sandbox **before the gateway
 * starts**, then emits `memory.restored` from the JSON line it prints. This
 * script emits no event itself. **On `status: "error"` the control plane must
 * not start the gateway**: the sandbox does not hold the tenant's memory, and
 * the marker below keeps the plugin from uploading over the real backup.
 *
 *   bun install/restore-memory.ts --tenant <id> [--home <dir>] [--manifest <YYYY-MM-DD>/manifest.<sha256>.json]
 *                                 [--force] [--dry-run]
 *
 * Environment: `AV_BACKUP_URL` (the ingest service's base URL; a value ending
 * in `/v1/backup` is accepted too; https, or http only to `*.railway.internal`
 * or the local machine), `AV_BACKUP_TOKEN` (the tenant's `backup_write`
 * token), `HERMES_HOME` (default `~/.hermes`). The tenant is `--tenant`, else
 * `AV_TENANT_ID`, else `TENANT_ID`, used exactly as given.
 *
 * Contract (DATA-93, the route side):
 *
 *   GET {base}/v1/backup/<tenant>/latest
 *       200: the latest manifest's bytes, `X-Backup-Key: <date>/manifest.<sha256>.json`
 *       404: the tenant has no backup
 *   GET {base}/v1/backup/<tenant>/<date>/<name>
 *       200: the object's bytes; 404: none
 *
 * All-or-nothing verification before anything is written:
 *
 *   1. the manifest's SHA-256 equals the hash in its key;
 *   2. it is `memory_manifest.v1` for this tenant and date, naming
 *      `memory.<sha256>.tar.gz`;
 *   3. the archive's SHA-256 and length equal the manifest's;
 *   4. the tar holds regular files only, exactly the manifest's paths, each
 *      path on the allowlist (`MEMORY.md`, `USER.md`, `memories/MEMORY.md`,
 *      `memories/USER.md`, `memory/YYYY-MM-DD.md` — the plugin's rule exactly,
 *      shared test vectors in `plugins/av-events/tests/vectors/`), each file's
 *      SHA-256 and size equal to the manifest's.
 *
 * Any mismatch refuses the restore and writes nothing. Then, per file: the
 * same bytes already there → left alone; a local file **newer** than the
 * snapshot's copy (its mtime is later than the manifest's `mtime_ms`) → kept,
 * unless `--force`; otherwise written. A target that is a symlink, directory or
 * other non-regular file, or a `memory/` / `memories/` that is not a real
 * directory, refuses the restore before anything is written.
 *
 * Writing is two-phase: every file is first staged to a temp name in its own
 * directory (mode 0600, mtime set to the manifest's), and only when all are
 * staged is each renamed into place. A staging failure removes every temp and
 * writes nothing; a rename failure stops there. Either is `status: "error"`,
 * `reason: "write_failed"`, with the counts of what was renamed.
 *
 * Marker: `$HERMES_HOME/av-events/restore.json` records `{status, manifest_key,
 * workspace_empty, reason?, at}` with status `restored`, `none` or `error` (a
 * refusal is an error). `workspace_empty` says whether none of the memory
 * files existed before this run. The av-events plugin uploads nothing for 24 h
 * after an `error` on an empty workspace; an error on a populated one blocks
 * nothing. `--dry-run` writes neither files nor marker.
 *
 * Output: one JSON line on stdout, `{status, snapshot_ref, bytes, file_count,
 * written, unchanged, kept_newer, partial, reason?}`. `bytes` / `file_count`
 * are the files written — what `memory.restored` reports. `snapshot_ref` is
 * `backup/<manifest sha256>`, the same value the plugin's `memory.snapshot`
 * carries as `manifest_ref`. `partial` is the manifest's: the snapshot itself
 * left files out (over the byte budget, unreadable, …). Never a token, a URL
 * or any file content.
 *
 * Exit: 0 `restored`, `none` (no backup) or `dry_run`; 1 `refused` or `error`; 2 usage.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { hermesHome } from "./paths";

export const MANIFEST_SCHEMA = "memory_manifest.v1";
/** The daily-note rule, identical to the plugin's `DAILY_NOTE.fullmatch`:
 * ASCII digits, the whole name (JS `$` without the `m` flag is end of input). */
export const DAILY_NOTE_NAME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}\.md$/;
export const RESTORE_PATH = /^(MEMORY\.md|USER\.md|memories\/MEMORY\.md|memories\/USER\.md|memory\/[0-9]{4}-[0-9]{2}-[0-9]{2}\.md)$/;
const MANIFEST_KEY = /^([0-9]{4}-[0-9]{2}-[0-9]{2})\/manifest\.([0-9a-f]{64})\.json$/;
const ARCHIVE_NAME = /^memory\.([0-9a-f]{64})\.tar\.gz$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REASON_CODE = /^[a-z_]{1,32}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Refuse a manifest or an archive larger than this before parsing it. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** And a tar that inflates past this (a gzip bomb). */
export const MAX_TAR_BYTES = 256 * 1024 * 1024;

export class RestoreRefused extends Error {}
class WriteFailed extends Error {
  constructor(readonly written: Action[]) {
    super("write_failed");
  }
}

export type ManifestFile = { path: string; sha256: string; bytes: number; mtime_ms: number };
export type Manifest = {
  schema: string;
  tenant_id: string;
  date: string;
  created_at: string;
  plugin_version: string;
  archive: { name: string; sha256: string; bytes: number };
  file_count: number;
  total_bytes: number;
  partial?: boolean;
  skipped?: { count: number; reasons: Record<string, number> };
  files: ManifestFile[];
};

export type RestoreResult = {
  status: "restored" | "none" | "refused" | "error" | "dry_run";
  snapshot_ref: string | null;
  bytes: number;
  file_count: number;
  written: number;
  unchanged: number;
  kept_newer: number;
  partial: boolean;
  reason?: string;
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refuse(reason: string): never {
  throw new RestoreRefused(reason);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** https anywhere; http only to `*.railway.internal` or the local machine; no
 * userinfo, query or fragment. The plugin's `backup_url_allowed`, in TS. */
export function backupUrlAllowed(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (!host || u.username || u.password || u.search || u.hash) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return LOCAL_HOSTS.has(host) || host.endsWith(".railway.internal");
  return false;
}

/** Parse and check a manifest against its key and the tenant. */
export function parseManifest(bytes: Uint8Array, key: string, tenant: string): { manifest: Manifest; ref: string } {
  const m = MANIFEST_KEY.exec(key);
  if (!m) refuse("manifest_key_invalid");
  const [, date, keyHash] = m;
  if (sha256(bytes) !== keyHash) refuse("manifest_hash_mismatch");
  let doc: Manifest;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse("manifest_unreadable");
  }
  if (!doc || typeof doc !== "object") refuse("manifest_unreadable");
  if (doc.schema !== MANIFEST_SCHEMA) refuse("manifest_schema");
  if (doc.tenant_id !== tenant) refuse("manifest_tenant_mismatch");
  if (doc.date !== date) refuse("manifest_date_mismatch");
  const a = doc.archive;
  const nameMatch = a && typeof a.name === "string" ? ARCHIVE_NAME.exec(a.name) : null;
  if (!nameMatch || a.sha256 !== nameMatch[1] || !isInt(a.bytes)) refuse("manifest_archive_invalid");
  if (!Array.isArray(doc.files) || doc.files.length === 0) refuse("manifest_files_invalid");
  const seen = new Set<string>();
  let total = 0;
  for (const f of doc.files) {
    if (!f || typeof f.path !== "string" || !RESTORE_PATH.test(f.path)) refuse("manifest_path_not_allowed");
    if (seen.has(f.path)) refuse("manifest_duplicate_path");
    seen.add(f.path);
    if (typeof f.sha256 !== "string" || !HEX64.test(f.sha256) || !isInt(f.bytes) || !isInt(f.mtime_ms)) {
      refuse("manifest_files_invalid");
    }
    total += f.bytes;
  }
  if (doc.file_count !== doc.files.length || doc.total_bytes !== total) refuse("manifest_counts_mismatch");
  if (doc.partial !== undefined && typeof doc.partial !== "boolean") refuse("manifest_skipped_invalid");
  if (doc.skipped !== undefined) {
    const s = doc.skipped;
    const reasons = s && typeof s === "object" ? s.reasons : null;
    if (!s || !isInt(s.count) || !reasons || typeof reasons !== "object" || Array.isArray(reasons)) {
      refuse("manifest_skipped_invalid");
    }
    let sum = 0;
    for (const [code, n] of Object.entries(reasons)) {
      if (!REASON_CODE.test(code) || !isInt(n)) refuse("manifest_skipped_invalid");
      sum += n;
    }
    if (sum !== s.count || (doc.partial !== undefined && doc.partial !== s.count > 0)) refuse("manifest_skipped_invalid");
  }
  return { manifest: doc, ref: `backup/${keyHash}` };
}

function octal(field: Uint8Array): number {
  const text = new TextDecoder().decode(field).replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) refuse("tar_malformed");
  return parseInt(text, 8);
}

function cstring(field: Uint8Array): string {
  const end = field.indexOf(0);
  return new TextDecoder("utf-8", { fatal: true }).decode(end === -1 ? field : field.subarray(0, end));
}

/** Regular files from a USTAR archive. Anything else (a link, a directory, a
 * pax header, a device) refuses: the plugin writes none of them. */
export function parseTar(tar: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) return out;
    let name: string;
    try {
      name = cstring(header.subarray(0, 100));
      const prefix = cstring(header.subarray(345, 500));
      if (prefix) name = `${prefix}/${name}`;
    } catch {
      refuse("tar_malformed");
    }
    const size = octal(header.subarray(124, 136));
    const type = header[156];
    if (type !== 0x30 && type !== 0) refuse("tar_entry_not_regular");
    if (out.has(name)) refuse("tar_duplicate_entry");
    const start = offset + 512;
    if (start + size > tar.length) refuse("tar_truncated");
    out.set(name, tar.slice(start, start + size));
    offset = start + Math.ceil(size / 512) * 512;
  }
  refuse("tar_truncated");
}

/** Check the archive against the manifest; returns path → bytes. */
export function verifyArchive(archive: Uint8Array, manifest: Manifest): Map<string, Uint8Array> {
  if (archive.length !== manifest.archive.bytes || sha256(archive) !== manifest.archive.sha256) {
    refuse("archive_hash_mismatch");
  }
  let tar: Uint8Array;
  try {
    tar = new Uint8Array(gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES }));
  } catch {
    refuse("archive_unreadable");
  }
  const entries = parseTar(tar);
  if (entries.size !== manifest.files.length) refuse("archive_files_mismatch");
  for (const f of manifest.files) {
    const data = entries.get(f.path);
    if (!data) refuse("archive_files_mismatch");
    if (data.length !== f.bytes || sha256(data) !== f.sha256) refuse("file_hash_mismatch");
  }
  return entries;
}

type Action = { file: ManifestFile; data: Uint8Array; act: "write" | "unchanged" | "kept_newer" };

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return null;
    throw err;
  }
}

/** Decide what to do with each file. Refuses (writing nothing) on a target that is not a regular file. */
export function planRestore(home: string, manifest: Manifest, entries: Map<string, Uint8Array>, force: boolean): Action[] {
  for (const dir of ["memory", "memories"]) {
    const st = lstatOrNull(join(home, dir));
    if (st && !st.isDirectory()) refuse("target_dir_not_directory");
  }
  return manifest.files.map((file) => {
    const data = entries.get(file.path)!;
    const st = lstatOrNull(join(home, ...file.path.split("/")));
    if (!st) return { file, data, act: "write" as const };
    if (!st.isFile()) refuse("target_not_regular");
    const local = readFileSync(join(home, ...file.path.split("/")));
    if (local.length === data.length && sha256(local) === file.sha256) return { file, data, act: "unchanged" as const };
    if (!force && Math.floor(st.mtimeMs) > file.mtime_ms) return { file, data, act: "kept_newer" as const };
    return { file, data, act: "write" as const };
  });
}

/** Stage every write, then rename them all. Throws `WriteFailed` carrying what was renamed. */
function applyWrites(home: string, writes: Action[]): void {
  const staged: { tmp: string; target: string; item: Action }[] = [];
  try {
    for (const item of writes) {
      const parts = item.file.path.split("/");
      const dir = join(home, ...parts.slice(0, -1));
      if (parts.length > 1) mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmp = join(dir, `.${parts.at(-1)}.restore-${process.pid}-${randomBytes(4).toString("hex")}`);
      staged.push({ tmp, target: join(home, ...parts), item });
      writeFileSync(tmp, item.data, { mode: 0o600, flag: "wx" });
      const when = new Date(item.file.mtime_ms);
      utimesSync(tmp, when, when);
    }
  } catch {
    for (const s of staged) rmSync(s.tmp, { force: true });
    throw new WriteFailed([]);
  }
  const done: Action[] = [];
  for (let i = 0; i < staged.length; i++) {
    try {
      renameSync(staged[i].tmp, staged[i].target);
      done.push(staged[i].item);
    } catch {
      for (const s of staged.slice(i)) rmSync(s.tmp, { force: true });
      throw new WriteFailed(done);
    }
  }
}

/** `$HERMES_HOME/av-events/restore.json`, written by temp file and rename. Best effort. */
export function writeMarker(home: string, marker: Record<string, unknown>): void {
  try {
    const dir = join(home, "av-events");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.restore.json.${process.pid}-${randomBytes(4).toString("hex")}`);
    writeFileSync(tmp, JSON.stringify(marker), { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(dir, "restore.json"));
  } catch {
    // The JSON line still reports the outcome; the control plane acts on that.
  }
}

export type Fetcher = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

export type RestoreOptions = {
  url: string;
  token: string;
  tenant: string;
  home: string;
  manifestKey?: string;
  force?: boolean;
  dryRun?: boolean;
  fetcher?: Fetcher;
};

export function backupBase(url: string): string {
  let base = url.trim().replace(/\/+$/, "");
  if (base.endsWith("/v1/backup")) base = base.slice(0, -"/v1/backup".length);
  return base;
}

async function download(fetcher: Fetcher, url: string, token: string): Promise<Response | null> {
  const res = await fetcher(url, { headers: { Authorization: `Bearer ${token}`, Accept: "*/*" } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`http_${res.status}`);
  const length = Number(res.headers.get("content-length") ?? "0");
  if (length > MAX_DOWNLOAD_BYTES) refuse("download_too_large");
  return res;
}

async function body(res: Response): Promise<Uint8Array> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_DOWNLOAD_BYTES) refuse("download_too_large");
  return bytes;
}

const empty = (status: RestoreResult["status"], extra: Partial<RestoreResult> = {}): RestoreResult => ({
  status,
  snapshot_ref: null,
  bytes: 0,
  file_count: 0,
  written: 0,
  unchanged: 0,
  kept_newer: 0,
  partial: false,
  ...extra,
});

/** Whether none of the allowlisted memory files exists yet: a recreated sandbox. */
export function workspaceEmpty(home: string): boolean {
  for (const rel of ["MEMORY.md", "USER.md", "memories/MEMORY.md", "memories/USER.md"]) {
    try {
      lstatSync(join(home, ...rel.split("/")));
      return false;
    } catch {
      // absent (or unreadable): keep looking
    }
  }
  try {
    return !readdirSync(join(home, "memory")).some((name) => DAILY_NOTE_NAME.test(name));
  } catch {
    return true;
  }
}

export async function restoreMemory(opts: RestoreOptions): Promise<RestoreResult> {
  // Judged before anything is written. The plugin blocks its uploads only
  // after a failed restore on an empty workspace: there, what the sandbox holds
  // is not the tenant's memory. A refusal on a populated one blocks nothing.
  const wasEmpty = workspaceEmpty(opts.home);
  let key: string | null = null;
  const result = await restoreInner(opts, (k) => {
    key = k;
  });
  if (!opts.dryRun) {
    const status = result.status === "restored" || result.status === "none" ? result.status : "error";
    writeMarker(opts.home, {
      status,
      manifest_key: key,
      workspace_empty: wasEmpty,
      ...(result.reason ? { reason: result.reason } : {}),
      at: new Date().toISOString(),
    });
  }
  return result;
}

async function restoreInner(opts: RestoreOptions, noteKey: (key: string) => void): Promise<RestoreResult> {
  if (!backupUrlAllowed(opts.url)) return empty("error", { reason: "url_not_allowed" });
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, { ...init, redirect: "error" }));
  const base = `${backupBase(opts.url)}/v1/backup/${opts.tenant}`;
  let result = empty("restored");
  try {
    let key: string;
    let manifestBytes: Uint8Array;
    if (opts.manifestKey) {
      key = opts.manifestKey;
      if (!MANIFEST_KEY.test(key)) refuse("manifest_key_invalid");
      const res = await download(fetcher, `${base}/${key}`, opts.token);
      if (!res) return empty("none");
      manifestBytes = await body(res);
    } else {
      const res = await download(fetcher, `${base}/latest`, opts.token);
      if (!res) return empty("none");
      key = res.headers.get("x-backup-key") ?? "";
      manifestBytes = await body(res);
    }
    const { manifest, ref } = parseManifest(manifestBytes, key, opts.tenant);
    noteKey(key);
    const archiveRes = await download(fetcher, `${base}/${manifest.date}/${manifest.archive.name}`, opts.token);
    if (!archiveRes) refuse("archive_missing");
    const entries = verifyArchive(await body(archiveRes), manifest);
    const plan = planRestore(opts.home, manifest, entries, Boolean(opts.force));
    result = empty(opts.dryRun ? "dry_run" : "restored", { snapshot_ref: ref, partial: manifest.partial === true });
    const writes = plan.filter((item) => item.act === "write");
    result.unchanged = plan.filter((item) => item.act === "unchanged").length;
    result.kept_newer = plan.filter((item) => item.act === "kept_newer").length;
    const count = (done: Action[]) => {
      result.written = done.length;
      result.file_count = done.length;
      result.bytes = done.reduce((n, item) => n + item.file.bytes, 0);
    };
    if (opts.dryRun) {
      count(writes);
      return result;
    }
    applyWrites(opts.home, writes);
    count(writes);
    return result;
  } catch (err) {
    if (err instanceof RestoreRefused) return empty("refused", { reason: err.message });
    if (err instanceof WriteFailed) {
      const out = { ...result, status: "error" as const, reason: "write_failed" };
      out.written = err.written.length;
      out.file_count = err.written.length;
      out.bytes = err.written.reduce((n, item) => n + item.file.bytes, 0);
      return out;
    }
    // Never the message of a network error: it can carry the URL.
    const reason = err instanceof Error && /^http_\d{3}$/.test(err.message) ? err.message : "fetch_failed";
    return empty("error", { reason });
  }
}

function usage(message: string): never {
  console.error(`restore-memory: ${message}`);
  console.error(
    "usage: bun install/restore-memory.ts --tenant <id> [--home <dir>] [--manifest <date>/manifest.<sha256>.json] [--force] [--dry-run]",
  );
  process.exit(2);
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = process.env): RestoreOptions {
  const opts: Partial<RestoreOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) usage(`${arg} needs a value`);
      return v;
    };
    if (arg === "--tenant") opts.tenant = value();
    else if (arg === "--home") opts.home = value();
    else if (arg === "--manifest") opts.manifestKey = value();
    else if (arg === "--force") opts.force = true;
    else if (arg === "--dry-run") opts.dryRun = true;
    else usage(`unknown argument ${arg}`);
  }
  opts.tenant = (opts.tenant ?? env.AV_TENANT_ID ?? env.TENANT_ID ?? "").trim();
  if (!opts.tenant || !TENANT.test(opts.tenant)) usage("a valid --tenant (or AV_TENANT_ID / TENANT_ID) is required");
  opts.url = env.AV_BACKUP_URL?.trim() ?? "";
  opts.token = env.AV_BACKUP_TOKEN?.trim() ?? "";
  if (!opts.url) usage("AV_BACKUP_URL is not set");
  if (!opts.token) usage("AV_BACKUP_TOKEN is not set");
  opts.home = opts.home ?? hermesHome();
  return opts as RestoreOptions;
}

if (import.meta.main) {
  const opts = parseArgs(process.argv.slice(2));
  const result = await restoreMemory(opts);
  console.log(JSON.stringify(result));
  process.exit(result.status === "restored" || result.status === "none" || result.status === "dry_run" ? 0 : 1);
}
