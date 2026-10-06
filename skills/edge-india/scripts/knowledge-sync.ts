#!/usr/bin/env bun
/**
 * Edge India knowledge sync: the script of the no_agent cron job
 * "Edge — knowledge sync" (install/install_index.ts), run every 30 minutes
 * through the shim `skills/edge-india/scripts/shims/agentvillage_knowledge_sync.sh`.
 * No model takes part. It copies the published Edge City India snapshot (the
 * wiki, website and newsletter, indexed into Markdown upstream) onto the
 * agent's disk, so the `edge-india` skill reads a local copy and the agent
 * never fetches inside a resident's turn.
 *
 *   KNOWLEDGE_SNAPSHOT_URL  the snapshot's manifest.json. No line (or, with no
 *     `.env` file, no variable): the built-in DEFAULT_SNAPSHOT_URL,
 *     https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/manifest.json
 *     Set empty (`KNOWLEDGE_SNAPSHOT_URL=`): switched off, status
 *     `unconfigured`, exit 0, no knowledge file written.
 *   KNOWLEDGE_SNAPSHOT_HOSTS  optional, comma-separated extra host names.
 *   When `$HERMES_HOME/.env` exists (the file the control plane writes) it is
 *   the only source for both: a key it does not carry means the default (the
 *   URL above; no extra hosts), whatever the process environment holds, since
 *   that is the gateway's environment from its start and goes stale when a line
 *   is deleted. The process environment counts only when there is no `.env`.
 *
 * Which URLs it fetches (`urlAllowed`): https, no user name or password, no
 * port, no query or fragment, and either host raw.githubusercontent.com with a
 * path under `/p2p-lanes/edge-agent-skill/` or `/Edge-City/`, or a host named
 * in KNOWLEDGE_SNAPSHOT_HOSTS (a dotted name, never an IP literal; the list
 * never widens raw.githubusercontent.com past those two prefixes). Every file
 * is fetched from the manifest's own directory: same host, path under the
 * manifest's directory. A redirect is followed (at most 3) only to a URL that
 * passes the same check; anything else fails the run.
 *
 * What it fetches: the manifest, `index.md` beside it (the skill's entry
 * point), and every `documents[].path` the manifest lists (relative `.md`
 * paths of plain segments). Each response must be 200 with a text type
 * (`text/plain`, `text/markdown`, `text/x-markdown`; `application/json` too for
 * the manifest), valid UTF-8, no NUL, and a Markdown file must not open like
 * an HTML page. Caps: 2 MB a file, 20 MB in all, 20 s a fetch, 90 s for the
 * run (Hermes's script timeout is 120 s).
 *
 * Where it writes: the whole set into `$HERMES_HOME/knowledge/edge-india/`
 * (with `_sync.json`: source, manifest sha256, ETag, files, bytes, each
 * document's manifest `hash` as fetched, `fetched_at` = when this content was
 * written, `checked_at` = the last run that confirmed it current), built in a
 * temp directory beside it and swapped in by rename; the set it replaces is
 * kept as `$HERMES_HOME/knowledge-prev/edge-india/`, outside `knowledge/` so a
 * search of `knowledge/` never finds the stale copy. A run that fails anywhere
 * leaves the current set untouched. Unchanged: the manifest answers 304 to the
 * stored ETag, or its sha256 equals the stored one (same source, every file
 * present): only `checked_at` is rewritten. One run at a time
 * (`knowledge/.edge-india.lock`).
 *
 * A mixed snapshot (the manifest is new but a document URL still serves the
 * CDN's old copy, `max-age=300`): a document whose manifest `hash` changed but
 * whose fetched bytes equal the stored copy is stale, so the run is
 * `incomplete`: nothing is written and the ETag and sha256 stay as they were,
 * so the next run fetches everything again.
 *
 * What it says: one line per run in `$HERMES_HOME/av-events/knowledge/sync.jsonl`
 * (`{v, event: "knowledge_sync", status, reason, files, bytes, sha256,
 * fetched_at}` where `fetched_at` is the run's time, plus `path` on
 * `incomplete`; codes, counts and that manifest path only, never a URL or any
 * text; rotated to `.1` at 1 MB), then on stdout the wake line
 * `{"wakeAgent": false, ...}`, so Hermes delivers nothing. Exit 1 on `failed`
 * and `incomplete` (Hermes records the failure and notifies the job's failure
 * target, `local`); 0 on `ok`, `unchanged`, `unconfigured` and `skipped` (a run
 * that found another one holding the lock).
 */

import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SET_NAME = "edge-india";
export const STATE_FILE = "_sync.json";
export const ENTRY_FILE = "index.md";
export const MANIFEST_FILE = "manifest.json";
export const FILE_CAP_BYTES = 2 * 1024 * 1024;
export const TOTAL_CAP_BYTES = 20 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 20_000;
export const RUN_BUDGET_MS = 90_000;
export const MAX_DOCUMENTS = 500;
export const MAX_REDIRECTS = 3;
export const LOG_MAX_BYTES = 1024 * 1024;
export const LOCK_STALE_MS = 3 * 60 * 1000; // past Hermes's 120 s script timeout: the holder is dead
const CONCURRENCY = 4;

/** The snapshot used when no `.env` line (or, with no `.env`, no variable) names one. */
export const DEFAULT_SNAPSHOT_URL = "https://raw.githubusercontent.com/p2p-lanes/edge-agent-skill/main/references/manifest.json";

/** raw.githubusercontent.com paths always allowed (owner/repo prefixes). */
export const RAW_HOST = "raw.githubusercontent.com";
export const RAW_PREFIXES = ["/p2p-lanes/edge-agent-skill/", "/Edge-City/"];

const MD_TYPES = new Set(["text/plain", "text/markdown", "text/x-markdown"]);
const MANIFEST_TYPES = new Set([...MD_TYPES, "application/json"]);

export type SyncStatus = "ok" | "unchanged" | "failed" | "incomplete" | "unconfigured" | "skipped";

export interface SyncResult {
  status: SyncStatus;
  reason: string;
  files: number;
  bytes: number;
  sha256: string | null;
  /** The run's time (in `_sync.json`, `fetched_at` is the time of the last write). */
  fetched_at: string;
  /** `incomplete` only: the manifest path of the stale document. */
  path?: string;
}

/** The job's exit code: a failure for Hermes only when the run failed or must be retried. */
export function exitCode(result: SyncResult): 0 | 1 {
  return result.status === "failed" || result.status === "incomplete" ? 1 : 0;
}

export interface SyncOptions {
  home: string;
  /** Stand-in for the process environment (tests); `.env` still wins. */
  env?: Record<string, string | undefined>;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => Date;
  fetchTimeoutMs?: number;
  runBudgetMs?: number;
  fileCapBytes?: number;
  totalCapBytes?: number;
}

interface SyncState {
  v: 1;
  source: string;
  manifest_sha256: string;
  etag: string | null;
  files: string[];
  bytes: number;
  /** Per document path: the manifest `hash` it was fetched under. */
  hashes: Record<string, string>;
  /** When this content was written. */
  fetched_at: string;
  /** The last run that confirmed this content current (`ok` or `unchanged`). */
  checked_at: string;
}

class SyncFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// ── Configuration ───────────────────────────────────────────────────────────

/**
 * A variable, trimmed, or undefined when it is not set. When `<home>/.env`
 * exists it is the only source (a key it does not carry is undefined, whatever
 * the environment holds); the environment counts only when there is no `.env`.
 * An `.env` that exists but cannot be read fails the run (`env-unreadable`).
 */
export function configValue(name: string, home: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const file = join(home, ".env");
  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new SyncFailure("env-unreadable");
    }
    let found: string | undefined;
    for (const line of text.split("\n")) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (match && match[1] === name) found = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
    return found?.trim();
  }
  return env[name]?.trim();
}

/** The manifest URL to sync: the configured one, DEFAULT_SNAPSHOT_URL when none is set, "" when set empty (off). */
export function snapshotUrl(home: string, env: Record<string, string | undefined> = process.env): string {
  return configValue("KNOWLEDGE_SNAPSHOT_URL", home, env) ?? DEFAULT_SNAPSHOT_URL;
}

/** The extra host names: lowercase dotted DNS names, never an IP literal or `localhost`. */
export function parseExtraHosts(raw: string): Set<string> {
  const hosts = new Set<string>();
  for (const entry of raw.split(/[\s,]+/)) {
    const host = entry.trim().toLowerCase().replace(/\.$/, "");
    if (!host) continue;
    if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) continue;
    hosts.add(host);
  }
  return hosts;
}

/**
 * Whether a URL may be fetched at all: https, no credentials, no explicit
 * port, no query or fragment, and an allowed host (raw.githubusercontent.com
 * only under RAW_PREFIXES; any other host only when listed).
 */
export function urlAllowed(url: URL, extraHosts: Set<string>): boolean {
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash) return false;
  const host = url.hostname.toLowerCase();
  if (host === RAW_HOST) return RAW_PREFIXES.some((prefix) => url.pathname.startsWith(prefix));
  return extraHosts.has(host);
}

/** The snapshot's manifest URL and the directory every file must come from, or a refusal code. */
export function snapshotSource(raw: string, extraHosts: Set<string>): { ok: true; manifest: URL; base: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "bad-url" };
  }
  if (!url.pathname.endsWith(".json") || url.pathname.includes("%")) return { ok: false, reason: "bad-url" };
  if (!urlAllowed(url, extraHosts)) return { ok: false, reason: "host-not-allowed" };
  return { ok: true, manifest: url, base: new URL("./", url) };
}

/** Under the base directory: same origin, path below the base's path. */
export function underBase(url: URL, base: URL): boolean {
  return url.origin === base.origin && url.pathname.startsWith(base.pathname) && url.pathname.length > base.pathname.length;
}

/** A manifest document path: relative, plain directory segments, a `.md` file name. */
export function documentPathValid(path: unknown): path is string {
  if (typeof path !== "string" || path.length === 0 || path.length > 200) return false;
  const segments = path.split("/");
  const file = segments.pop()!;
  if (!segments.every((segment) => /^[A-Za-z0-9_-]{1,80}$/.test(segment))) return false;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._-]{0,120}\.md$/.test(file) || file.includes("..")) return false;
  return path !== STATE_FILE && path !== MANIFEST_FILE;
}

/**
 * The files a manifest names, index.md first, and each document's `hash`
 * where the manifest gives one as a string; throws `bad-manifest` / `bad-path`.
 */
export function manifestFiles(text: string): { paths: string[]; hashes: Record<string, string> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyncFailure("bad-manifest");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SyncFailure("bad-manifest");
  const { documents, event } = parsed as { documents?: unknown; event?: unknown };
  if (typeof event !== "string" || !Array.isArray(documents) || documents.length === 0 || documents.length > MAX_DOCUMENTS) {
    throw new SyncFailure("bad-manifest");
  }
  const files = [ENTRY_FILE];
  const hashes: Record<string, string> = {};
  const seen = new Set(files);
  for (const doc of documents) {
    const path = doc && typeof doc === "object" ? (doc as { path?: unknown }).path : undefined;
    if (!documentPathValid(path)) throw new SyncFailure("bad-path");
    if (seen.has(path)) {
      if (path === ENTRY_FILE) continue;
      throw new SyncFailure("bad-path");
    }
    seen.add(path);
    files.push(path);
    const hash = (doc as { hash?: unknown }).hash;
    if (typeof hash === "string" && hash.length > 0 && hash.length <= 200) hashes[path] = hash;
  }
  return { paths: files, hashes };
}

// ── Fetching ────────────────────────────────────────────────────────────────

/** The body is UTF-8 text with no NUL, and a Markdown body does not open like an HTML page. */
export function textOk(bytes: Uint8Array, markdown: boolean): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new SyncFailure("not-utf8");
  }
  if (text.includes("\u0000")) throw new SyncFailure("not-utf8");
  if (markdown && /^\s*<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>])/i.test(text.replace(/^﻿/, ""))) throw new SyncFailure("html");
  return text;
}

interface Fetched {
  status: 200 | 304;
  bytes: Uint8Array;
  etag: string | null;
}

interface FetchContext {
  fetchImpl: (url: string, init: RequestInit) => Promise<Response>;
  extraHosts: Set<string>;
  base: URL;
  deadline: number;
  fetchTimeoutMs: number;
  fileCapBytes: number;
}

async function readCapped(response: Response, cap: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > cap) throw new SyncFailure("too-large");
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel().catch(() => {});
      throw new SyncFailure("too-large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** GET one file of the snapshot, following only allowed same-base redirects. */
async function fetchFile(ctx: FetchContext, start: URL, types: Set<string>, etag: string | null = null): Promise<Fetched> {
  let url = start;
  for (let hop = 0; ; hop++) {
    if (!urlAllowed(url, ctx.extraHosts) || !underBase(url, ctx.base)) throw new SyncFailure(hop === 0 ? "host-not-allowed" : "redirect-refused");
    const remaining = ctx.deadline - Date.now();
    if (remaining <= 0) throw new SyncFailure("budget");
    // The abort fires at whichever comes first: this fetch's timeout or the run's budget.
    const timedOut = remaining <= ctx.fetchTimeoutMs ? "budget" : "timeout";
    const headers: Record<string, string> = { accept: "text/markdown, text/plain, application/json;q=0.9" };
    if (etag) headers["if-none-match"] = etag;
    let response: Response;
    try {
      response = await ctx.fetchImpl(url.href, {
        redirect: "manual",
        headers,
        signal: AbortSignal.timeout(Math.min(ctx.fetchTimeoutMs, remaining)),
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      throw new SyncFailure(name === "TimeoutError" || name === "AbortError" ? timedOut : "network");
    }
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      await response.body?.cancel().catch(() => {});
      if (hop >= MAX_REDIRECTS) throw new SyncFailure("too-many-redirects");
      const location = response.headers.get("location");
      if (!location) throw new SyncFailure("redirect-refused");
      try {
        url = new URL(location, url);
      } catch {
        throw new SyncFailure("redirect-refused");
      }
      continue;
    }
    if (response.status === 304 && etag) return { status: 304, bytes: new Uint8Array(0), etag };
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new SyncFailure(`http-${response.status}`);
    }
    const type = (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!types.has(type)) {
      await response.body?.cancel().catch(() => {});
      throw new SyncFailure(type === "text/html" ? "html" : "bad-content-type");
    }
    let bytes: Uint8Array;
    try {
      bytes = await readCapped(response, ctx.fileCapBytes);
    } catch (err) {
      if (err instanceof SyncFailure) throw err;
      const name = (err as { name?: string })?.name;
      throw new SyncFailure(name === "TimeoutError" || name === "AbortError" ? timedOut : "network");
    }
    return { status: 200, bytes, etag: response.headers.get("etag") };
  }
}

// ── Disk ────────────────────────────────────────────────────────────────────

export function knowledgeDir(home: string): string {
  return join(home, "knowledge");
}

export function currentSetDir(home: string): string {
  return join(knowledgeDir(home), SET_NAME);
}

/** Where the replaced set is kept: outside `knowledge/`, so a search there never finds the stale copy. */
export function previousRoot(home: string): string {
  return join(home, "knowledge-prev");
}

export function previousSetDir(home: string): string {
  return join(previousRoot(home), SET_NAME);
}

export function syncLogPath(home: string): string {
  return join(home, "av-events", "knowledge", "sync.jsonl");
}

function readState(home: string): SyncState | null {
  try {
    const parsed = JSON.parse(readFileSync(join(currentSetDir(home), STATE_FILE), "utf8"));
    if (parsed && parsed.v === 1 && typeof parsed.manifest_sha256 === "string" && Array.isArray(parsed.files)) {
      const hashes = parsed.hashes && typeof parsed.hashes === "object" && !Array.isArray(parsed.hashes) ? parsed.hashes : {};
      return { ...parsed, hashes } as SyncState;
    }
  } catch {
    // no set yet, or an unreadable one: a full sync
  }
  return null;
}

/**
 * An unchanged run: rewrite `_sync.json` with the new `checked_at` (temp file
 * and rename, so a reader never sees half a file). Best effort: a failed
 * rewrite leaves the old time, which only makes the copy look older.
 */
function touchChecked(home: string, state: SyncState, checkedAt: string): void {
  const target = join(currentSetDir(home), STATE_FILE);
  const tmp = join(currentSetDir(home), `.${STATE_FILE}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ ...state, checked_at: checkedAt }, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  } catch {
    rmSync(tmp, { force: true });
  }
}

/** The stored copy of a document in the current set, or null. */
function storedBytes(home: string, path: string): Uint8Array | null {
  try {
    return readFileSync(join(currentSetDir(home), path));
  } catch {
    return null;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
}

function setComplete(home: string, state: SyncState): boolean {
  const dir = currentSetDir(home);
  return [MANIFEST_FILE, ...state.files].every((file) => typeof file === "string" && existsSync(join(dir, file)));
}

/**
 * Before any work, under the lock: a run killed between the two renames of a
 * swap left no current set and the previous one, so the previous one comes
 * back; temp directories a killed run left behind are removed.
 */
function recover(home: string): void {
  const dir = knowledgeDir(home);
  if (!existsSync(currentSetDir(home)) && existsSync(previousSetDir(home))) {
    try {
      renameSync(previousSetDir(home), currentSetDir(home));
    } catch {
      // the next run tries again
    }
  }
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(`.${SET_NAME}.tmp-`)) rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

function acquireLock(home: string, now: number): string | null {
  const lock = join(knowledgeDir(home), `.${SET_NAME}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lock, { mode: 0o700 });
      return lock;
    } catch {
      try {
        if (now - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      return null;
    }
  }
  return null;
}

/** Build the set in a temp directory, then swap it in: current → prev, temp → current. */
function writeSet(home: string, files: Map<string, Uint8Array>, state: SyncState): void {
  const root = knowledgeDir(home);
  const tmp = join(root, `.${SET_NAME}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    mkdirSync(tmp, { mode: 0o700 });
    for (const [path, bytes] of files) {
      const target = join(tmp, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
    }
    writeFileSync(join(tmp, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  } catch {
    rmSync(tmp, { recursive: true, force: true });
    throw new SyncFailure("write-failed");
  }
  const current = currentSetDir(home);
  const prev = previousSetDir(home);
  try {
    mkdirSync(previousRoot(home), { recursive: true, mode: 0o700 });
    rmSync(prev, { recursive: true, force: true });
    if (existsSync(current)) renameSync(current, prev);
    renameSync(tmp, current);
  } catch {
    // The current set is either still in place or sits in prev: put it back.
    if (!existsSync(current) && existsSync(prev)) {
      try {
        renameSync(prev, current);
      } catch {
        // recover() at the next run
      }
    }
    rmSync(tmp, { recursive: true, force: true });
    throw new SyncFailure("write-failed");
  }
}

export function appendSyncLog(home: string, result: SyncResult): void {
  try {
    const path = syncLogPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
      if (statSync(path).size >= LOG_MAX_BYTES) renameSync(path, `${path}.1`);
    } catch {
      // no log yet
    }
    appendFileSync(path, `${JSON.stringify({ v: 1, event: "knowledge_sync", ...result })}\n`, { mode: 0o600 });
  } catch {
    // the log is best effort
  }
}

// ── The run ─────────────────────────────────────────────────────────────────

async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown = null;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (failure === null && next < items.length) {
      const at = next++;
      try {
        results[at] = await work(items[at]);
      } catch (err) {
        failure ??= err;
      }
    }
  });
  await Promise.all(lanes);
  if (failure !== null) throw failure;
  return results;
}

async function sync(options: SyncOptions, fetchedAt: string): Promise<SyncResult> {
  const { home } = options;
  const env = options.env ?? process.env;
  const result = (status: SyncStatus, reason: string, files = 0, bytes = 0, sha256: string | null = null): SyncResult =>
    ({ status, reason, files, bytes, sha256, fetched_at: fetchedAt });

  let raw: string;
  let extraHosts: Set<string>;
  try {
    raw = snapshotUrl(home, env);
    extraHosts = parseExtraHosts(configValue("KNOWLEDGE_SNAPSHOT_HOSTS", home, env) ?? "");
  } catch (err) {
    return result("failed", err instanceof SyncFailure ? err.code : "error");
  }
  if (!raw) return result("unconfigured", "unset");
  const source = snapshotSource(raw, extraHosts);
  if (!source.ok) return result("failed", source.reason);

  mkdirSync(knowledgeDir(home), { recursive: true, mode: 0o700 });
  const lock = acquireLock(home, Date.now());
  // Another run holds the lock (a manual `hermes cron run` overlapping a scheduled one): benign.
  if (!lock) return result("skipped", "locked");
  try {
    recover(home);
    const ctx: FetchContext = {
      fetchImpl: options.fetchImpl ?? ((url, init) => fetch(url, init)),
      extraHosts,
      base: source.base,
      deadline: Date.now() + (options.runBudgetMs ?? RUN_BUDGET_MS),
      fetchTimeoutMs: options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS,
      fileCapBytes: options.fileCapBytes ?? FILE_CAP_BYTES,
    };
    const totalCap = options.totalCapBytes ?? TOTAL_CAP_BYTES;
    const state = readState(home);
    const sameSource = state !== null && state.source === source.manifest.href && setComplete(home, state);

    const manifest = await fetchFile(ctx, source.manifest, MANIFEST_TYPES, sameSource ? state!.etag : null);
    if (manifest.status === 304) {
      touchChecked(home, state!, fetchedAt);
      return result("unchanged", "etag", state!.files.length, state!.bytes, state!.manifest_sha256);
    }
    const manifestText = textOk(manifest.bytes, false);
    const sha256 = createHash("sha256").update(manifest.bytes).digest("hex");
    if (sameSource && state!.manifest_sha256 === sha256) {
      touchChecked(home, state!, fetchedAt);
      return result("unchanged", "same-sha256", state!.files.length, state!.bytes, sha256);
    }

    const { paths, hashes } = manifestFiles(manifestText);
    let total = manifest.bytes.byteLength;
    const bodies = await pool(paths, CONCURRENCY, async (path) => {
      const fetched = await fetchFile(ctx, new URL(path, source.base), MD_TYPES);
      textOk(fetched.bytes, true);
      total += fetched.bytes.byteLength;
      if (total > totalCap) throw new SyncFailure("total-too-large");
      return fetched.bytes;
    });

    // A mixed snapshot: the manifest says a document changed, but its URL
    // still serves exactly the bytes stored under the old hash (the CDN's
    // cached copy). Write nothing and keep the ETag and sha256, so the next
    // run fetches it all again once the CDN has the new copy.
    if (state !== null && state.source === source.manifest.href) {
      for (const [at, path] of paths.entries()) {
        const before = state.hashes[path];
        if (before === undefined || hashes[path] === undefined || before === hashes[path]) continue;
        const stored = storedBytes(home, path);
        if (stored !== null && sameBytes(stored, bodies[at])) return { ...result("incomplete", "stale-document"), path };
      }
    }

    const files = new Map<string, Uint8Array>([[MANIFEST_FILE, manifest.bytes]]);
    paths.forEach((path, at) => files.set(path, bodies[at]));
    writeSet(home, files, {
      v: 1,
      source: source.manifest.href,
      manifest_sha256: sha256,
      etag: manifest.etag,
      files: paths,
      bytes: total,
      hashes,
      fetched_at: fetchedAt,
      checked_at: fetchedAt,
    });
    return result("ok", "written", paths.length, total, sha256);
  } catch (err) {
    return result("failed", err instanceof SyncFailure ? err.code : "error");
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** One sync run, logged. Never throws. */
export async function runKnowledgeSync(options: SyncOptions): Promise<SyncResult> {
  const fetchedAt = (options.now ?? (() => new Date()))().toISOString();
  let result: SyncResult;
  try {
    result = await sync(options, fetchedAt);
  } catch {
    result = { status: "failed", reason: "error", files: 0, bytes: 0, sha256: null, fetched_at: fetchedAt };
  }
  appendSyncLog(options.home, result);
  return result;
}

export function wakeLine(result: SyncResult): string {
  return JSON.stringify({ wakeAgent: false, reason: `knowledge-${result.status}-${result.reason}`.replace(/[^A-Za-z0-9:_-]/g, "").slice(0, 64) });
}

if (import.meta.main) {
  // stdout is the job's output: anything else goes to stderr.
  console.log = console.error;
  const home = process.env.HERMES_HOME?.trim() || process.cwd();
  const result = await runKnowledgeSync({ home });
  process.stderr.write(`knowledge-sync: ${result.status} ${result.reason} files=${result.files} bytes=${result.bytes}\n`);
  process.stdout.write(`${wakeLine(result)}\n`, () => process.exit(exitCode(result)));
}
