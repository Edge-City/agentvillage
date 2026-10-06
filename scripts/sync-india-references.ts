#!/usr/bin/env bun
/**
 * Copies the generated Edge City India reference tree from the upstream
 * indexer checkout (`aromeoes/edge-agent-skill`, `references/`) into
 * `skills/edge-india/references/`, all or nothing.
 *
 * The upstream repo owns content generation: its indexer reads only an
 * allowlist of public sources (the India wiki, website and Substack) and never
 * private housing sheets, forms, portals or Telegram history. This script does
 * not fetch anything; it validates what the upstream checkout holds and
 * replaces the local snapshot only when the new one is complete.
 *
 *   - Every document `references/manifest.json` lists must exist, be a regular
 *     Markdown file under `references/`, and be within the size limits. Files
 *     outside the manifest (except `index.md`) are not copied.
 *   - Every published file, `manifest.json` and `index.md` included, is a
 *     regular file of at most MAX_DOCUMENT_BYTES (the smaller of the job's and
 *     refs.ts's per-file caps), so no agent's job or refs.ts refuses it.
 *   - Each document's manifest `url` is published only when it is https on one
 *     of the hosts the guide comes from (refs.ts `SOURCE_URL_HOSTS`); any other
 *     value is replaced by the mirror's own link to the document, never
 *     passed through. refs.ts applies the same rule when it prints a link.
 *   - `SNAPSHOT.json` records the upstream commit the tree was copied from
 *     (`--source-commit`; the workflow passes the checked-out sha of the
 *     moving upstream `main`), so every publish is attributable.
 *   - The manifest must name event `edge-india-2026`, and the wiki must be the
 *     India wiki, so an Esmeralda-era or half-migrated tree is refused.
 *   - A document the manifest no longer lists is removed here too (the
 *     upstream index already keeps articles that only dropped out of a feed).
 *     A snapshot that loses more than half its documents at once is refused
 *     unless `--allow-shrink` is passed, because that looks like a broken run.
 *   - Any refusal exits non-zero and leaves the previous snapshot untouched.
 *   - `SNAPSHOT.json` records the upstream commit, its date, when this copy was
 *     made, and each file's sha256. It is rewritten only when a file changed,
 *     so an unchanged run makes no commit.
 *   - The tree must be one the agents' "Edge — knowledge sync" job accepts
 *     (`skills/edge-india/scripts/knowledge-sync.ts`, which fetches this
 *     mirror and verifies every file against `SNAPSHOT.json`): its path rule
 *     (`documentPathValid`), its document count (`MAX_DOCUMENTS`) and its text
 *     check (`textOk`: UTF-8, no NUL, Markdown that does not open like an HTML
 *     page) are imported from it, so a snapshot that would fail every agent's
 *     sync is refused here and never published.
 *   - Everything is written under the target directory: the new tree is staged
 *     beside it and swapped in by rename, and the staging and retired copies
 *     are removed whether the run succeeds or fails.
 *
 * Usage:
 *   bun scripts/sync-india-references.ts --source <upstream checkout> \
 *     [--target skills/edge-india/references] [--source-repo aromeoes/edge-agent-skill] \
 *     --source-commit <sha> [--source-commit-date <iso>] [--allow-shrink]
 *
 *   `--source-commit` is required on the command line: without the upstream
 *   checkout's commit sha (40 or 64 hex), it refuses (exit 1) and publishes
 *   nothing, so every publish is attributable.
 *
 * Standard library only (plus the knowledge-sync script and refs.ts, both
 * standard library only), so the workflow needs no `bun install`.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  FILE_CAP_BYTES as CRON_FILE_CAP_BYTES,
  MAX_DOCUMENTS as CRON_MAX_DOCUMENTS,
  TOTAL_CAP_BYTES as CRON_TOTAL_CAP_BYTES,
  documentPathValid as cronAcceptsPath,
  textOk as cronTextOk,
} from "../skills/edge-india/scripts/knowledge-sync";
import { MAX_FILE_BYTES as REFS_FILE_CAP_BYTES, sourceUrl, sourceUrlValid } from "../skills/edge-india/scripts/refs";

export const EVENT = "edge-india-2026";
export const SNAPSHOT_FILE = "SNAPSHOT.json";
export const REQUIRED_DOCUMENTS = ["wiki-content.md", "website-content.md"];
/** Every published file (documents, index.md and manifest.json): the smaller of the job's and refs.ts's per-file caps. */
export const MAX_DOCUMENT_BYTES = Math.min(CRON_FILE_CAP_BYTES, REFS_FILE_CAP_BYTES);
export const MAX_TOTAL_BYTES = 8_000_000;
/** The knowledge-sync job refuses a manifest with more documents than this. */
export const MAX_DOCUMENTS = CRON_MAX_DOCUMENTS;
// The mirror's caps sit inside the job's and refs.ts's, so a snapshot published here always fits both.
if (MAX_DOCUMENT_BYTES > CRON_FILE_CAP_BYTES || MAX_DOCUMENT_BYTES > REFS_FILE_CAP_BYTES || MAX_TOTAL_BYTES > CRON_TOTAL_CAP_BYTES) {
  throw new Error("sync-india-references caps exceed the knowledge-sync job's or refs.ts's caps");
}
/** A relative path of lowercase segments ending in `.md`; no `..`, no leading `/`. */
const DOCUMENT_PATH = /^(?:[a-z0-9][a-z0-9_-]*\/)*[a-z0-9][a-z0-9._-]*\.md$/;

export interface SnapshotFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface Snapshot {
  schema: 1;
  event: typeof EVENT;
  source: { repo: string; path: "references"; commit: string | null; commit_date: string | null };
  synced_at: string;
  files: SnapshotFile[];
}

export interface SyncOptions {
  /** Upstream checkout root (the directory that holds `references/`). */
  source: string;
  /** Local snapshot directory, e.g. `skills/edge-india/references`. */
  target: string;
  sourceRepo?: string;
  sourceCommit?: string | null;
  sourceCommitDate?: string | null;
  allowShrink?: boolean;
  now?: () => Date;
}

export interface SyncResult {
  changed: boolean;
  added: string[];
  updated: string[];
  removed: string[];
  documents: number;
}

export class SyncRefused extends Error {
  constructor(public readonly code: string, detail: string) {
    super(`${code}: ${detail}`);
  }
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** The knowledge-sync job's text check, as a refusal here. */
function cronText(path: string, buffer: Buffer, markdown: boolean): void {
  try {
    cronTextOk(buffer, markdown);
  } catch (error) {
    throw new SyncRefused("not_text", `${path} would be refused by the knowledge-sync job (${(error as Error).message})`);
  }
}

function regularFile(path: string, code: string, tooLarge = "document_too_large"): Buffer {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    throw new SyncRefused(code, `${path} does not exist`);
  }
  if (!stat.isFile()) throw new SyncRefused("not_a_regular_file", `${path} is not a regular file`);
  if (stat.size === 0) throw new SyncRefused("empty_document", `${path} is empty`);
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new SyncRefused(tooLarge, `${path} is ${stat.size} bytes (limit ${MAX_DOCUMENT_BYTES})`);
  }
  return readFileSync(path);
}

/**
 * The manifest as published: each document's `url` kept when refs.ts would
 * print it (https on one of the guide's hosts), otherwise replaced by the
 * mirror's own link to the document, never passed through. Unchanged bytes
 * when every url is fine.
 */
function publishedManifest(raw: Buffer, manifest: { documents: { path: string; url?: unknown }[] }): Buffer {
  let replaced = false;
  for (const entry of manifest.documents) {
    if (sourceUrlValid(entry.url)) continue;
    entry.url = sourceUrl(entry.url, entry.path);
    replaced = true;
  }
  return replaced ? Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) : raw;
}

/** Reads the previous snapshot record, or null when there is none or it is unreadable. */
export function readSnapshot(dir: string): Snapshot | null {
  const path = join(dir, SNAPSHOT_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && parsed.schema === 1 && Array.isArray(parsed.files) ? parsed : null;
  } catch {
    return null;
  }
}

/** Validates the upstream tree and returns the files to copy, keyed by relative path. */
export function collectSource(sourceRoot: string): Map<string, Buffer> {
  const referencesDir = join(sourceRoot, "references");
  // The manifest is a published file like any other: regular, non-empty, within the per-file cap.
  const manifestPath = join(referencesDir, "manifest.json");
  const manifestRaw = regularFile(manifestPath, "manifest_missing", "manifest_too_large");
  let manifest: any;
  try {
    manifest = JSON.parse(manifestRaw.toString("utf8"));
  } catch (error) {
    throw new SyncRefused("manifest_missing", `${manifestPath} is not JSON (${(error as Error).message})`);
  }

  if (manifest?.event !== EVENT) {
    throw new SyncRefused("wrong_event", `manifest event is ${JSON.stringify(manifest?.event)}, expected ${EVENT}`);
  }
  if (manifest.version !== 1 || !Array.isArray(manifest.documents) || manifest.documents.length === 0) {
    throw new SyncRefused("manifest_invalid", "manifest has no version 1 document list");
  }
  if (manifest.documents.length > MAX_DOCUMENTS) {
    throw new SyncRefused("too_many_documents", `${manifest.documents.length} documents (the knowledge-sync job takes at most ${MAX_DOCUMENTS})`);
  }

  const files = new Map<string, Buffer>();
  for (const entry of manifest.documents) {
    const path = entry?.path;
    if (typeof path !== "string" || !DOCUMENT_PATH.test(path) || !cronAcceptsPath(path)) {
      throw new SyncRefused("unsafe_path", `manifest path ${JSON.stringify(path)} is not a plain relative .md path`);
    }
    if (files.has(path)) throw new SyncRefused("duplicate_path", `${path} is listed twice`);
    files.set(path, regularFile(join(referencesDir, path), "document_missing"));
  }

  for (const required of REQUIRED_DOCUMENTS) {
    if (!files.has(required)) throw new SyncRefused("required_document_missing", `${required} is not in the manifest`);
  }
  const wikiTitle = files.get("wiki-content.md")!.toString("utf8").split("\n", 1)[0];
  if (!/edge city india/i.test(wikiTitle) || /esmeralda/i.test(wikiTitle)) {
    throw new SyncRefused("wrong_event", `wiki-content.md is titled ${JSON.stringify(wikiTitle)}, not the India wiki`);
  }

  const index = regularFile(join(referencesDir, "index.md"), "index_missing");
  if (!/edge city india 2026/i.test(index.toString("utf8"))) {
    throw new SyncRefused("wrong_event", "index.md does not identify Edge City India 2026");
  }
  files.set("index.md", index);
  const published = publishedManifest(manifestRaw, manifest);
  if (published.length > MAX_DOCUMENT_BYTES) {
    throw new SyncRefused("manifest_too_large", `manifest.json is ${published.length} bytes as published (limit ${MAX_DOCUMENT_BYTES})`);
  }
  files.set("manifest.json", published);
  for (const [path, buffer] of files) cronText(path, buffer, path.endsWith(".md"));

  let total = 0;
  for (const buffer of files.values()) total += buffer.length;
  if (total > MAX_TOTAL_BYTES) {
    throw new SyncRefused("snapshot_too_large", `${total} bytes in total (limit ${MAX_TOTAL_BYTES})`);
  }
  return files;
}

function sameFiles(previous: Snapshot | null, next: SnapshotFile[]): boolean {
  if (!previous || previous.files.length !== next.length) return false;
  const byPath = new Map(previous.files.map((file) => [file.path, file.sha256]));
  return next.every((file) => byPath.get(file.path) === file.sha256);
}

/** Every file under `dir` (relative paths), for checking the local copy matches its record. */
function listTree(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listTree(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

function localCopyIntact(target: string, previous: Snapshot | null): boolean {
  if (!previous) return false;
  const expected = new Set([...previous.files.map((file) => file.path), SNAPSHOT_FILE]);
  const present = listTree(target);
  if (present.length !== expected.size || !present.every((path) => expected.has(path))) return false;
  return previous.files.every((file) => {
    try {
      return sha256(readFileSync(join(target, file.path))) === file.sha256;
    } catch {
      return false;
    }
  });
}

export function syncReferences(options: SyncOptions): SyncResult {
  const target = resolve(options.target);
  const files = collectSource(resolve(options.source));
  const previous = readSnapshot(target);

  const nextFiles: SnapshotFile[] = [...files.entries()]
    .map(([path, buffer]) => ({ path, sha256: sha256(buffer), bytes: buffer.length }))
    .sort((a, b) => a.path.localeCompare(b.path));

  const documents = nextFiles.filter((file) => file.path.endsWith(".md") && file.path !== "index.md").length;
  if (previous && !options.allowShrink) {
    const before = previous.files.filter((file) => file.path.endsWith(".md") && file.path !== "index.md").length;
    if (documents * 2 < before) {
      throw new SyncRefused("snapshot_shrank", `${before} documents before, ${documents} now; pass --allow-shrink if intended`);
    }
  }

  const before = new Map((previous?.files ?? []).map((file) => [file.path, file.sha256]));
  const after = new Map(nextFiles.map((file) => [file.path, file.sha256]));
  const added = nextFiles.filter((file) => !before.has(file.path)).map((file) => file.path);
  const updated = nextFiles.filter((file) => before.has(file.path) && before.get(file.path) !== file.sha256).map((file) => file.path);
  const removed = [...before.keys()].filter((path) => !after.has(path)).sort();

  if (sameFiles(previous, nextFiles) && localCopyIntact(target, previous)) {
    return { changed: false, added: [], updated: [], removed: [], documents };
  }

  const snapshot: Snapshot = {
    schema: 1,
    event: EVENT,
    source: {
      repo: options.sourceRepo ?? "aromeoes/edge-agent-skill",
      path: "references",
      commit: options.sourceCommit ?? null,
      commit_date: options.sourceCommitDate ?? null,
    },
    synced_at: (options.now?.() ?? new Date()).toISOString(),
    files: nextFiles,
  };

  // Stage beside the target, then swap, so a crash never leaves a half-written tree.
  const staging = `${target}.staging-${process.pid}`;
  const retired = `${target}.previous-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  try {
    for (const [path, buffer] of files) {
      const dest = join(staging, path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buffer);
    }
    writeFileSync(join(staging, SNAPSHOT_FILE), `${JSON.stringify(snapshot, null, 2)}\n`);

    mkdirSync(dirname(target), { recursive: true });
    if (existsSync(target)) renameSync(target, retired);
    renameSync(staging, target);
  } catch (error) {
    // Put the previous snapshot back if it was moved aside and not replaced.
    if (!existsSync(target) && existsSync(retired)) renameSync(retired, target);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(retired, { recursive: true, force: true });
  }

  return { changed: true, added, updated, removed, documents };
}

function isoOrNull(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A git commit sha: 40 hex characters (SHA-1) or 64 (SHA-256 repositories). */
export function sourceCommitValid(value: unknown): value is string {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const source = argValue(args, "--source");
  if (!source) {
    console.error("usage: bun scripts/sync-india-references.ts --source <upstream checkout> --source-commit <sha> [--target dir]");
    process.exit(2);
  }
  // Every publish names the upstream commit it came from: without a readable one, nothing is published.
  const sourceCommit = argValue(args, "--source-commit");
  if (!sourceCommitValid(sourceCommit)) {
    console.error(`refused (previous snapshot kept): source_commit_unknown: --source-commit must be the upstream checkout's commit sha (got ${JSON.stringify(sourceCommit ?? null)})`);
    process.exit(1);
  }
  try {
    const result = syncReferences({
      source,
      target: argValue(args, "--target") ?? "skills/edge-india/references",
      sourceRepo: argValue(args, "--source-repo"),
      sourceCommit,
      sourceCommitDate: isoOrNull(argValue(args, "--source-commit-date")),
      allowShrink: args.includes("--allow-shrink"),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    if (error instanceof SyncRefused) {
      console.error(`refused (previous snapshot kept): ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
