#!/usr/bin/env bun
/**
 * Restore a tenant's memory files from its latest backup (DATA-82).
 *
 * The control plane runs this on a recreated sandbox **before the gateway
 * starts**, then emits `memory.restored` from the JSON line it prints. This
 * script emits no event itself.
 *
 *   bun install/restore-memory.ts --tenant <id> [--home <dir>] [--manifest <YYYY-MM-DD>/manifest.<sha256>.json]
 *                                 [--force] [--dry-run]
 *
 * Environment: `AV_BACKUP_URL` (the ingest service's base URL; a value ending
 * in `/v1/backup` is accepted too), `AV_BACKUP_TOKEN` (the tenant's
 * `backup_write` token), `HERMES_HOME` (default `~/.hermes`). The tenant is
 * `--tenant`, else `AV_TENANT_ID`, else `TENANT_ID`, used exactly as given.
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
 *      `memories/USER.md`, `memory/YYYY-MM-DD.md`), each file's SHA-256 and
 *      size equal to the manifest's.
 *
 * Any mismatch refuses the restore and writes nothing. Then, per file: the
 * same bytes already there → left alone; a local file **newer** than the
 * snapshot's copy (its mtime is later than the manifest's `mtime_ms`) → kept,
 * unless `--force`; otherwise written (temp file + rename, mode 0600, mtime set
 * to the manifest's). A target that is a symlink, directory or other
 * non-regular file, or a `memory/` / `memories/` that is not a real directory,
 * refuses the restore before anything is written.
 *
 * Output: one JSON line on stdout, `{status, snapshot_ref, bytes, file_count,
 * written, unchanged, kept_newer, reason?}`. `bytes` / `file_count` are the
 * files written — what `memory.restored` reports. `snapshot_ref` is
 * `backup/<manifest sha256>`, the same value the plugin's `memory.snapshot`
 * carries as `manifest_ref`. Never a token, a URL or any file content.
 *
 * Exit: 0 `restored` or `none` (no backup), 1 `refused` or `error`, 2 usage.
 */

import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { hermesHome } from "./paths";

export const MANIFEST_SCHEMA = "memory_manifest.v1";
export const RESTORE_PATH = /^(MEMORY\.md|USER\.md|memories\/MEMORY\.md|memories\/USER\.md|memory\/\d{4}-\d{2}-\d{2}\.md)$/;
const MANIFEST_KEY = /^(\d{4}-\d{2}-\d{2})\/manifest\.([0-9a-f]{64})\.json$/;
const ARCHIVE_NAME = /^memory\.([0-9a-f]{64})\.tar\.gz$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** Refuse a manifest or an archive larger than this before parsing it. */
export const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
/** And a tar that inflates past this (a gzip bomb). */
export const MAX_TAR_BYTES = 256 * 1024 * 1024;

export class RestoreRefused extends Error {}

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
  files: ManifestFile[];
};

export type RestoreResult = {
  status: "restored" | "none" | "refused" | "error";
  snapshot_ref: string | null;
  bytes: number;
  file_count: number;
  written: number;
  unchanged: number;
  kept_newer: number;
  reason?: string;
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refuse(reason: string): never {
  throw new RestoreRefused(reason);
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

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

function writeOne(home: string, file: ManifestFile, data: Uint8Array): void {
  const parts = file.path.split("/");
  const target = join(home, ...parts);
  if (parts.length > 1) mkdirSync(join(home, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
  const tmp = join(home, ...parts.slice(0, -1), `.${parts.at(-1)}.restore-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    const when = new Date(file.mtime_ms);
    utimesSync(tmp, when, when);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
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
  ...extra,
});

export async function restoreMemory(opts: RestoreOptions): Promise<RestoreResult> {
  const fetcher: Fetcher = opts.fetcher ?? ((url, init) => fetch(url, { ...init, redirect: "error" }));
  const base = `${backupBase(opts.url)}/v1/backup/${opts.tenant}`;
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
    const archiveRes = await download(fetcher, `${base}/${manifest.date}/${manifest.archive.name}`, opts.token);
    if (!archiveRes) refuse("archive_missing");
    const entries = verifyArchive(await body(archiveRes), manifest);
    const plan = planRestore(opts.home, manifest, entries, Boolean(opts.force));
    const result = empty("restored", { snapshot_ref: ref });
    for (const item of plan) {
      if (item.act === "unchanged") result.unchanged += 1;
      else if (item.act === "kept_newer") result.kept_newer += 1;
      else {
        if (!opts.dryRun) writeOne(opts.home, item.file, item.data);
        result.written += 1;
        result.file_count += 1;
        result.bytes += item.file.bytes;
      }
    }
    return result;
  } catch (err) {
    if (err instanceof RestoreRefused) return empty("refused", { reason: err.message });
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
  process.exit(result.status === "restored" || result.status === "none" ? 0 : 1);
}
