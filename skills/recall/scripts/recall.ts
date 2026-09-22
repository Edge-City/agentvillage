#!/usr/bin/env bun
/**
 * Tenant-local recall index (DATA-83).
 *
 * A SQLite FTS5 index over the agent's own memory — daily notes
 * (`memory/YYYY-MM-DD.md`), long-term memory (`MEMORY.md`) and the owner's
 * private conversations in the local Hermes session store — queried with
 * plain BM25. No LLM, no embeddings, no network. Everything stays inside the
 * sandbox.
 *
 *   bun recall.ts rebuild [--home DIR] [--index FILE] [--state-db FILE]
 *   bun recall.ts query --query-stdin [--since YYYY-MM-DD] [--limit N] [...]
 *   bun recall.ts query --query "text" [...]
 *
 * Both commands print exactly one JSON object on stdout and exit 0 on a
 * handled outcome (`ok`, `unavailable`, `error`); exit 1 is reserved for an
 * unexpected crash. `--query-stdin` exists so the query never appears in a
 * process listing.
 *
 * Invariants (tests in `tests/recall.test.ts`):
 *   - never writes under `memory/`; the index lives at `.recall/index.sqlite`
 *   - opens the Hermes session store read-only
 *   - `query` refuses outside the owner's main session and returns no data
 *   - ordering is deterministic: score, then date (newest first), then ref
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const SCHEMA_VERSION = "1";

/** Daily notes only. Other markdown under `memory/` (e.g. the legacy
 * `digest-outgoing.md` draft) is deliberately not indexed: drafts must not
 * become future source context. */
export const DAILY_NOTE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const ISO_DATE_RE = /\b(20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))\b/;
const SINCE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const DEFAULT_LIMIT = 8;
export const MAX_LIMIT = 20;
export const MAX_QUERY_CHARS = 500;
/** Wall-clock budget for the incremental rebuild a query does first. */
export const QUERY_REBUILD_BUDGET_MS = 3000;
const MAX_QUERY_TERMS = 16;
const MAX_TERM_CHARS = 64;
const CHUNK_MAX_LINES = 12;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
const SNIPPET_TOKENS = 32;
const OPEN_RETRIES = 6;

/** Chat types that are a one-to-one conversation with the owner. */
export const DIRECT_CHAT_TYPES = new Set(["dm", "private", "direct", "c2c"]);

/**
 * Surfaces that are the owner's own machine. A session with no chat type is
 * the main session only on one of these; a cron run, an API-server turn, a
 * webhook, or anything unrecognised with no chat type is refused.
 */
export const LOCAL_SURFACES = new Set(["cli", "tui", "desktop", "acp", "local"]);

export type Kind = "daily_note" | "long_term" | "session";
export type DateSource = "filename" | "inline" | "mtime" | "message";

export interface Paths {
  home: string;
  index: string;
  stateDb: string;
  /** Written by `--wipe-user`: session messages older than it are never indexed. */
  epoch: string;
}

export interface Chunk {
  lineStart: number;
  lineEnd: number;
  body: string;
  heading: string | null;
}

export interface Hit {
  date: string;
  date_source: DateSource;
  kind: Kind;
  ref: string;
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  score: number;
}

export interface RebuildStats {
  files: { scanned: number; indexed: number; unchanged: number; removed: number; skipped: number };
  sessions: {
    scanned: number;
    indexed: number;
    appended: number;
    unchanged: number;
    removed: number;
    status: string;
  };
  chunks: number;
  /** True when the rebuild stopped at its deadline; the index is consistent but not current. */
  partial: boolean;
}

export interface RebuildOptions {
  /** Epoch ms after which no further source is processed. */
  deadline?: number;
  /**
   * Scrub removed text from the file: `secure_delete`, FTS `optimize`, and a
   * `VACUUM` when a non-secure pass left deletions behind. Background rebuilds
   * only; the query path skips it to stay fast and records that a scrub is owed.
   */
  secure?: boolean;
}

export type QueryResult =
  | {
      status: "ok";
      match: "all" | "any" | "none";
      terms: number;
      since: string | null;
      hit_count: number;
      top_score: number | null;
      hits: Hit[];
      partial: boolean;
      index: RebuildStats | null;
    }
  | { status: "unavailable"; reason: string; hit_count: 0; hits: [] }
  | { status: "error"; reason: string; hit_count: 0; hits: [] };

// ── Paths and guards ─────────────────────────────────────────────────────────

export function resolvePaths(opts: { home?: string; index?: string; stateDb?: string } = {}): Paths {
  const home = resolve(
    opts.home || process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes"),
  );
  const index = resolve(home, opts.index || process.env.AV_RECALL_INDEX?.trim() || join(".recall", "index.sqlite"));
  const stateDb = resolve(home, opts.stateDb || process.env.AV_RECALL_STATE_DB?.trim() || "state.db");
  return { home, index, stateDb, epoch: join(home, ".recall", "epoch") };
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks on the deepest existing ancestor, so `memory -> elsewhere`
 * or an index path routed through a symlink cannot sneak past the check. */
function realish(path: string): string {
  let current = path;
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    current = parent;
  }
  return join(realpathSync(current), ...tail);
}

/** The index must never live under `memory/` — nothing this tool produces may
 * become future source context. Throws on violation. */
export function assertIndexOutsideMemory(paths: Paths): void {
  const memoryDir = join(paths.home, "memory");
  const candidates = [paths.index, realish(paths.index)];
  const memoryDirs = [memoryDir, realish(memoryDir)];
  for (const candidate of candidates) {
    for (const dir of memoryDirs) {
      if (isInside(candidate, dir)) {
        throw new Error("index_path_inside_memory");
      }
    }
  }
  if (realish(paths.index) === realish(join(paths.home, "MEMORY.md"))) {
    throw new Error("index_path_is_source");
  }
}

function norm(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * True when the calling session is the owner's main session.
 *
 * Mirrors `is_private_session` in `plugins/recall/__init__.py`, and is what a
 * terminal invocation of this CLI is held to (Hermes exports the gateway's
 * session variables to terminal commands):
 *
 *   - a cron run is never the main session, whatever it binds: Hermes cron
 *     binds an empty chat type and delivers to the chat the job was created
 *     in, which may be a group (`HERMES_CRON_SESSION=1`, a `cron_` session id,
 *     or a `cron` platform/source);
 *   - a one-to-one chat type (`dm`, …) is the main session;
 *   - an empty chat type is the main session only when every surface identity
 *     that is set is local (cli, tui, desktop, acp); none set is the plain CLI;
 *   - anything else (group, forum, channel, api_server, webhook, unknown) is not.
 */
export function sessionIsPrivate(env: Record<string, string | undefined> = process.env): boolean {
  const chatType = norm(env.HERMES_SESSION_CHAT_TYPE);
  const idents = [env.HERMES_PLATFORM, env.HERMES_SESSION_PLATFORM, env.HERMES_SESSION_SOURCE]
    .map(norm)
    .filter((v) => v !== "");
  const sessionId = (env.HERMES_SESSION_ID ?? "").trim();
  if (norm(env.HERMES_CRON_SESSION) === "1" || sessionId.startsWith("cron_") || idents.includes("cron")) {
    return false;
  }
  if (DIRECT_CHAT_TYPES.has(chatType)) return true;
  if (chatType !== "") return false;
  return idents.every((ident) => LOCAL_SURFACES.has(ident));
}

// ── Dates ────────────────────────────────────────────────────────────────────

/** Local calendar date, matching how the agent names its daily notes. */
export function localDate(epochMs: number): string {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function validSince(value: string | undefined | null): string | null | "invalid" {
  if (value === undefined || value === null || value.trim() === "") return null;
  const text = value.trim();
  const datePart = text.length > 10 && /^\d{4}-\d{2}-\d{2}T/.test(text) ? text.slice(0, 10) : text;
  if (!SINCE_RE.test(datePart)) return "invalid";
  const parsed = new Date(`${datePart}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== datePart) return "invalid";
  return datePart;
}

/**
 * Seconds since the Unix epoch before which session messages are excluded, or
 * 0. `--wipe-user` writes this file so a previous occupant's conversations,
 * which Hermes keeps in `state.db`, never enter a new index. An unreadable
 * marker fails closed to its own modification time.
 */
export function readEpoch(paths: Paths): number {
  let st: Stats;
  try {
    st = statSync(paths.epoch);
  } catch {
    return 0;
  }
  try {
    const value = Number.parseFloat(readFileSync(paths.epoch, "utf8").trim());
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    /* fall through */
  }
  return st.mtimeMs / 1000;
}

// ── Chunking ─────────────────────────────────────────────────────────────────

/**
 * Split text into blocks of consecutive non-blank lines, cut at headings and
 * at CHUNK_MAX_LINES. Line numbers are 1-based and refer to the source text.
 */
export function chunkText(text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];
  let heading: string | null = null;
  let current: { start: number; lines: string[]; heading: string | null } | null = null;

  const flush = () => {
    if (current && current.lines.some((l) => l.trim() !== "")) {
      chunks.push({
        lineStart: current.start,
        lineEnd: current.start + current.lines.length - 1,
        body: current.lines.join("\n"),
        heading: current.heading,
      });
    }
    current = null;
  };

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const isHeading = /^#{1,6}\s/.test(line);
    if (line.trim() === "") {
      flush();
      return;
    }
    if (isHeading) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
    }
    if (current === null) current = { start: lineNo, lines: [], heading };
    current.lines.push(line);
    if (current.lines.length >= CHUNK_MAX_LINES) flush();
  });
  flush();
  return chunks;
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

// ── Index database ───────────────────────────────────────────────────────────

const DDL = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS sources (
     source_id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     mtime_ms INTEGER,
     size INTEGER,
     fingerprint TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS chunks (
     id INTEGER PRIMARY KEY,
     source_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     path TEXT NOT NULL,
     line_start INTEGER NOT NULL,
     line_end INTEGER NOT NULL,
     date TEXT NOT NULL,
     date_source TEXT NOT NULL,
     body TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS chunks_source ON chunks(source_id)`,
  `CREATE INDEX IF NOT EXISTS chunks_date ON chunks(date)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
     body, content='chunks', content_rowid='id',
     tokenize='porter unicode61 remove_diacritics 2'
   )`,
];

export function fts5Available(): boolean {
  const db = new Database(":memory:");
  try {
    db.run("CREATE VIRTUAL TABLE probe USING fts5(x)");
    return true;
  } catch {
    return false;
  } finally {
    db.close();
  }
}

function isLockError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(message);
}

/**
 * Open (creating if needed) the index. The index is derived data: if the file
 * is not a usable SQLite database it is discarded and rebuilt from sources.
 * First creation races (two processes switching a new file to WAL) are retried
 * with backoff.
 */
export function openIndex(paths: Paths, opts: { secure?: boolean } = {}): Database {
  for (let attempt = 0; ; attempt++) {
    try {
      try {
        return openIndexOnce(paths, opts);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/not a database|malformed|corrupt/i.test(message)) throw err;
        for (const suffix of ["", "-wal", "-shm"]) rmSync(`${paths.index}${suffix}`, { force: true });
        return openIndexOnce(paths, opts);
      }
    } catch (err) {
      if (!isLockError(err) || attempt >= OPEN_RETRIES - 1) throw err;
      Bun.sleepSync(25 * 2 ** attempt);
    }
  }
}

function openIndexOnce(paths: Paths, opts: { secure?: boolean }): Database {
  assertIndexOutsideMemory(paths);
  const dir = dirname(paths.index);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(paths.index);
  const db = new Database(paths.index, { create: true });
  try {
    if (fresh) {
      try {
        chmodSync(paths.index, 0o600);
      } catch {
        /* best effort */
      }
    }
    db.run("PRAGMA busy_timeout = 5000");
    // Switching to WAL takes an exclusive lock; only the first opener needs to.
    const mode = (db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null)?.journal_mode;
    if (String(mode).toLowerCase() !== "wal") db.run("PRAGMA journal_mode = WAL");
    if (opts.secure) db.run("PRAGMA secure_delete = ON");

    const version = (() => {
      try {
        return (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)
          ?.value;
      } catch {
        return undefined;
      }
    })();
    if (version !== SCHEMA_VERSION) {
      if (version !== undefined) {
        db.run("DROP TABLE IF EXISTS chunks_fts");
        db.run("DROP TABLE IF EXISTS chunks");
        db.run("DROP TABLE IF EXISTS sources");
        db.run("DROP TABLE IF EXISTS meta");
      }
      for (const stmt of DDL) db.run(stmt);
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", [SCHEMA_VERSION]);
    }
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

function deleteSource(db: Database, sourceId: string): number {
  const rows = db.query("SELECT id, body FROM chunks WHERE source_id = ?").all(sourceId) as {
    id: number;
    body: string;
  }[];
  const del = db.prepare("INSERT INTO chunks_fts(chunks_fts, rowid, body) VALUES('delete', ?, ?)");
  for (const row of rows) del.run(row.id, row.body);
  db.run("DELETE FROM chunks WHERE source_id = ?", [sourceId]);
  db.run("DELETE FROM sources WHERE source_id = ?", [sourceId]);
  return rows.length;
}

interface PendingChunk {
  kind: Kind;
  path: string;
  lineStart: number;
  lineEnd: number;
  date: string;
  dateSource: DateSource;
  body: string;
}

function insertChunks(db: Database, sourceId: string, chunks: PendingChunk[]): void {
  const ins = db.prepare(
    `INSERT INTO chunks(source_id, kind, path, line_start, line_end, date, date_source, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const fts = db.prepare("INSERT INTO chunks_fts(rowid, body) VALUES (?, ?)");
  for (const c of chunks) {
    const res = ins.run(sourceId, c.kind, c.path, c.lineStart, c.lineEnd, c.date, c.dateSource, c.body);
    fts.run(Number(res.lastInsertRowid), c.body);
  }
}

/** Counts chunk rows deleted in this pass (re-chunking or purging). */
interface Pass {
  stats: RebuildStats;
  deadline: number | null;
  deleted: number;
}

function pastDeadline(pass: Pass): boolean {
  if (pass.deadline !== null && Date.now() > pass.deadline) {
    pass.stats.partial = true;
    return true;
  }
  return false;
}

// ── Markdown sources ─────────────────────────────────────────────────────────

interface FileSource {
  sourceId: string;
  kind: Kind;
  abs: string;
  rel: string;
  filenameDate: string | null;
}

export function listMarkdownSources(home: string): FileSource[] {
  const out: FileSource[] = [];
  const longTerm = join(home, "MEMORY.md");
  out.push({ sourceId: "file:MEMORY.md", kind: "long_term", abs: longTerm, rel: "MEMORY.md", filenameDate: null });
  const memoryDir = join(home, "memory");
  let names: string[] = [];
  try {
    const st = lstatSync(memoryDir);
    if (st.isDirectory() && !st.isSymbolicLink()) names = readdirSync(memoryDir);
  } catch {
    names = [];
  }
  for (const name of names.sort()) {
    const m = DAILY_NOTE_RE.exec(name);
    if (!m) continue;
    const rel = `memory/${name}`;
    out.push({ sourceId: `file:${rel}`, kind: "daily_note", abs: join(memoryDir, name), rel, filenameDate: m[1]! });
  }
  return out;
}

function chunkDate(
  chunk: Chunk,
  source: FileSource,
  mtimeMs: number,
): { date: string; dateSource: DateSource } {
  if (source.filenameDate) return { date: source.filenameDate, dateSource: "filename" };
  const inline = ISO_DATE_RE.exec(chunk.body) ?? (chunk.heading ? ISO_DATE_RE.exec(chunk.heading) : null);
  if (inline) return { date: inline[1]!, dateSource: "inline" };
  return { date: localDate(mtimeMs), dateSource: "mtime" };
}

function syncFiles(db: Database, home: string, pass: Pass): void {
  const { stats } = pass;
  // Presence first, over the full listing, so removals are applied even when
  // the pass later stops at its deadline.
  const eligible: { source: FileSource; st: Stats }[] = [];
  for (const source of listMarkdownSources(home)) {
    let st: Stats;
    try {
      st = lstatSync(source.abs);
    } catch {
      continue; // absent: purged below
    }
    // Never follow a symlink or a hard link out of the workspace, never read a huge file.
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1 || st.size > MAX_FILE_BYTES) {
      stats.files.skipped++;
      continue;
    }
    eligible.push({ source, st });
  }
  const present = new Set(eligible.map((e) => e.source.sourceId));
  const known = db.query("SELECT source_id FROM sources WHERE kind != 'session'").all() as { source_id: string }[];
  for (const { source_id } of known) {
    if (present.has(source_id)) continue;
    db.transaction(() => {
      pass.deleted += deleteSource(db, source_id);
    }).immediate();
    stats.files.removed++;
  }

  for (const { source, st } of eligible) {
    stats.files.scanned++;
    const mtimeMs = Math.trunc(st.mtimeMs);
    const stored = db
      .query("SELECT mtime_ms, size, fingerprint FROM sources WHERE source_id = ?")
      .get(source.sourceId) as { mtime_ms: number; size: number; fingerprint: string } | null;
    if (stored && stored.mtime_ms === mtimeMs && stored.size === st.size) {
      stats.files.unchanged++;
      continue; // cheap path: stat only
    }
    if (pastDeadline(pass)) break;

    const bytes = readFileSync(source.abs);
    const digest = sha256(bytes);
    const tx = db.transaction(() => {
      const current = db
        .query("SELECT fingerprint FROM sources WHERE source_id = ?")
        .get(source.sourceId) as { fingerprint: string } | null;
      if (current && current.fingerprint === digest) {
        // Touched but identical: record the new mtime so the next pass is stat-only.
        db.run("UPDATE sources SET mtime_ms = ?, size = ? WHERE source_id = ?", [mtimeMs, st.size, source.sourceId]);
        return false;
      }
      pass.deleted += deleteSource(db, source.sourceId);
      const text = bytes.toString("utf8");
      const pending = chunkText(text).map((chunk) => {
        const { date, dateSource } = chunkDate(chunk, source, mtimeMs);
        return {
          kind: source.kind,
          path: source.rel,
          lineStart: chunk.lineStart,
          lineEnd: chunk.lineEnd,
          date,
          dateSource,
          body: chunk.body,
        } satisfies PendingChunk;
      });
      insertChunks(db, source.sourceId, pending);
      db.run(
        "INSERT INTO sources(source_id, kind, mtime_ms, size, fingerprint) VALUES (?, ?, ?, ?, ?)",
        [source.sourceId, source.kind, mtimeMs, st.size, digest],
      );
      return true;
    });
    if (tx.immediate()) stats.files.indexed++;
    else stats.files.unchanged++;
  }
}

// ── Hermes session store (read-only) ─────────────────────────────────────────

function columns(db: Database, table: string): Set<string> {
  try {
    return new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name));
  } catch {
    return new Set();
  }
}

interface SessionPrint {
  n: number;
  maxId: number;
  chars: number;
}

function parsePrint(value: string | undefined): SessionPrint | null {
  const m = /^(\d+):(\d+):(\d+)$/.exec(value ?? "");
  return m ? { n: Number(m[1]), maxId: Number(m[2]), chars: Number(m[3]) } : null;
}

function printOf(p: SessionPrint): string {
  return `${p.n}:${p.maxId}:${p.chars}`;
}

/**
 * Read the owner's private conversations from `state.db`.
 *
 * Opened read-only. Eligible sessions: `chat_type = 'dm'` (Telegram and other
 * messaging DMs), or no chat type with a local source (cli, tui, desktop).
 * Everything else — group chats, cron runs (whose transcripts hold the brief
 * drafts that must not become source context), subagents, webhooks, unknown
 * sources — is excluded. Only `user` and `assistant` text is indexed; tool
 * results are not. Messages older than the `--wipe-user` epoch are excluded.
 *
 * A session that only grew gets its new messages appended; one whose earlier
 * messages changed (rewind, compaction) is re-indexed whole.
 *
 * If the store is absent or its schema lacks a column this depends on, the
 * session side is skipped with a status and the markdown index still works.
 */
function syncSessions(db: Database, stateDbPath: string, epoch: number, pass: Pass): void {
  const { stats } = pass;
  if (!existsSync(stateDbPath)) {
    stats.sessions.status = "no_session_store";
    purgeSessions(db, new Set(), pass);
    return;
  }
  let store: Database;
  try {
    store = new Database(stateDbPath, { readonly: true });
    store.run("PRAGMA busy_timeout = 2000");
  } catch {
    stats.sessions.status = "session_store_unreadable";
    return; // keep what we have; do not purge on a transient open failure
  }
  try {
    const sCols = columns(store, "sessions");
    const mCols = columns(store, "messages");
    const required = ["id", "source", "chat_type"].every((c) => sCols.has(c)) &&
      ["id", "session_id", "role", "content", "timestamp"].every((c) => mCols.has(c));
    if (!required) {
      // Eligibility can no longer be verified, so nothing session-derived stays.
      stats.sessions.status = "session_schema_unsupported";
      purgeSessions(db, new Set(), pass);
      return;
    }
    const filters = ["m.role IN ('user', 'assistant')", "m.content IS NOT NULL", "m.content != ''"];
    if (mCols.has("active")) filters.push("m.active = 1");
    if (mCols.has("_compressed_summary")) filters.push("m._compressed_summary = 0");
    if (epoch > 0) filters.push(`m.timestamp >= ${Number(epoch)}`);
    const localSources = [...LOCAL_SURFACES].map((s) => `'${s}'`).join(", ");
    const eligible = `(s.chat_type = 'dm' OR ((s.chat_type IS NULL OR s.chat_type = '') AND s.source IN (${localSources})))`;
    const where = `${eligible} AND ${filters.join(" AND ")}`;

    const sessions = store
      .query(
        `SELECT s.id AS id, COUNT(m.id) AS n, MAX(m.id) AS max_id, SUM(LENGTH(m.content)) AS chars
           FROM sessions s JOIN messages m ON m.session_id = s.id
          WHERE ${where}
          GROUP BY s.id
          ORDER BY s.id`,
      )
      .all() as { id: string; n: number; max_id: number; chars: number }[];

    // Removals first, over the full list, so they land even on a partial pass.
    purgeSessions(db, new Set(sessions.map((s) => `session:${s.id}`)), pass);

    const prefixQuery = store.query(
      `SELECT COUNT(m.id) AS n, COALESCE(SUM(LENGTH(m.content)), 0) AS chars
         FROM sessions s JOIN messages m ON m.session_id = s.id
        WHERE s.id = ? AND m.id <= ? AND ${where}`,
    );
    const messageQuery = store.query(
      `SELECT m.id AS id, m.content AS content, m.timestamp AS ts
         FROM sessions s JOIN messages m ON m.session_id = s.id
        WHERE s.id = ? AND m.id > ? AND ${where}
        ORDER BY m.id`,
    );

    for (const session of sessions) {
      const sourceId = `session:${session.id}`;
      stats.sessions.scanned++;
      const current: SessionPrint = { n: session.n, maxId: session.max_id, chars: session.chars };
      const storedRow = db.query("SELECT fingerprint FROM sources WHERE source_id = ?").get(sourceId) as
        | { fingerprint: string }
        | null;
      const stored = parsePrint(storedRow?.fingerprint);
      if (stored && printOf(stored) === printOf(current)) {
        stats.sessions.unchanged++;
        continue;
      }
      if (pastDeadline(pass)) break;

      // Append-only when every message we indexed is still there unchanged.
      let append = false;
      if (stored && current.maxId > stored.maxId) {
        const prefix = prefixQuery.get(session.id, stored.maxId) as { n: number; chars: number };
        append = prefix.n === stored.n && prefix.chars === stored.chars;
      }
      const afterId = append && stored ? stored.maxId : 0;
      const messages = messageQuery.all(session.id, afterId) as { id: number; content: string; ts: number }[];
      const pending: PendingChunk[] = [];
      for (const message of messages) {
        const text = String(message.content).slice(0, MAX_MESSAGE_CHARS);
        const date = localDate(Number(message.ts) * 1000);
        for (const chunk of chunkText(text)) {
          pending.push({
            kind: "session",
            path: `session:${session.id}#${message.id}`,
            lineStart: chunk.lineStart,
            lineEnd: chunk.lineEnd,
            date,
            dateSource: "message",
            body: chunk.body,
          });
        }
      }
      db.transaction(() => {
        if (append) {
          insertChunks(db, sourceId, pending);
          db.run("UPDATE sources SET fingerprint = ? WHERE source_id = ?", [printOf(current), sourceId]);
        } else {
          pass.deleted += deleteSource(db, sourceId);
          insertChunks(db, sourceId, pending);
          db.run(
            "INSERT INTO sources(source_id, kind, mtime_ms, size, fingerprint) VALUES (?, 'session', NULL, NULL, ?)",
            [sourceId, printOf(current)],
          );
        }
      }).immediate();
      if (append) stats.sessions.appended++;
      else stats.sessions.indexed++;
    }
    stats.sessions.status = "ok";
  } finally {
    store.close();
  }
}

function purgeSessions(db: Database, present: Set<string>, pass: Pass): void {
  const known = db.query("SELECT source_id FROM sources WHERE kind = 'session'").all() as { source_id: string }[];
  for (const { source_id } of known) {
    if (present.has(source_id)) continue;
    db.transaction(() => {
      pass.deleted += deleteSource(db, source_id);
    }).immediate();
    pass.stats.sessions.removed++;
  }
}

// ── Public operations ────────────────────────────────────────────────────────

export function rebuild(paths: Paths, opts: RebuildOptions = {}): RebuildStats {
  const stats: RebuildStats = {
    files: { scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0 },
    sessions: { scanned: 0, indexed: 0, appended: 0, unchanged: 0, removed: 0, status: "not_run" },
    chunks: 0,
    partial: false,
  };
  const secure = opts.secure ?? true;
  const pass: Pass = { stats, deadline: opts.deadline ?? null, deleted: 0 };
  const db = openIndex(paths, { secure });
  try {
    syncFiles(db, paths.home, pass);
    syncSessions(db, paths.stateDb, readEpoch(paths), pass);
    const owed = (db.query("SELECT value FROM meta WHERE key = 'scrub_owed'").get() as { value: string } | null)
      ?.value === "1";
    if (secure) {
      if (pass.deleted > 0 || owed) {
        // Merge FTS segments so removed text leaves the index b-trees; with
        // secure_delete on, the pages freed here are zeroed.
        db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
      }
      if (owed) {
        // Pages freed earlier by a non-secure pass still hold text: rewrite.
        db.run("DELETE FROM meta WHERE key = 'scrub_owed'");
        db.run("VACUUM");
        db.run("PRAGMA wal_checkpoint(TRUNCATE)");
      }
    } else if (pass.deleted > 0 && !owed) {
      db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('scrub_owed', '1')");
    }
    stats.chunks = (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  } finally {
    db.close();
  }
  return stats;
}

/** Word terms from free text, lowercased and de-duplicated in order. Each is
 * quoted, so FTS5 operators in user text (`OR`, `NEAR`, `*`, `:`) are inert.
 * `plugins/recall` hashes the query with the same extraction. */
export function queryTerms(query: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of query.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const term = match[0].slice(0, MAX_TERM_CHARS);
    if (seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_QUERY_TERMS) break;
  }
  return out;
}

function ftsExpression(terms: string[], mode: "all" | "any"): string {
  return terms.map((t) => `"${t}"`).join(mode === "all" ? " " : " OR ");
}

function round(value: number, places = 4): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

function refFor(row: { kind: Kind; path: string; line_start: number; line_end: number }): string {
  const lines = row.line_start === row.line_end ? `${row.line_start}` : `${row.line_start}-${row.line_end}`;
  return `${row.path}:${lines}`;
}

export function query(
  paths: Paths,
  opts: {
    query: string;
    since?: string | null;
    limit?: number;
    rebuildFirst?: boolean;
    budgetMs?: number;
    env?: Record<string, string | undefined>;
  },
): QueryResult {
  if (!sessionIsPrivate(opts.env ?? process.env)) {
    return { status: "unavailable", reason: "unavailable in group sessions", hit_count: 0, hits: [] };
  }
  const text = typeof opts.query === "string" ? opts.query : "";
  if (text.trim() === "") return { status: "error", reason: "empty_query", hit_count: 0, hits: [] };
  if (text.length > MAX_QUERY_CHARS) return { status: "error", reason: "query_too_long", hit_count: 0, hits: [] };
  const since = validSince(opts.since);
  if (since === "invalid") return { status: "error", reason: "invalid_since", hit_count: 0, hits: [] };
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT));
  const terms = queryTerms(text);
  if (terms.length === 0) return { status: "error", reason: "empty_query", hit_count: 0, hits: [] };
  if (!fts5Available()) return { status: "unavailable", reason: "fts5_unavailable", hit_count: 0, hits: [] };

  let stats: RebuildStats | null = null;
  let partial = false;
  if (opts.rebuildFirst !== false) {
    try {
      // Bounded and non-secure: the query must stay fast; the next background
      // rebuild finishes the work and scrubs what this pass deleted.
      stats = rebuild(paths, { deadline: Date.now() + (opts.budgetMs ?? QUERY_REBUILD_BUDGET_MS), secure: false });
      partial = stats.partial;
    } catch (err) {
      if (!isLockError(err)) throw err;
      partial = true; // another rebuild holds the index: answer from what it has
    }
  }
  const db = openIndex(paths);
  try {
    const sinceClause = since ? "AND c.date >= $since" : "";
    const countSql = `SELECT COUNT(*) AS n FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
                       WHERE chunks_fts MATCH $match ${sinceClause}`;
    const hitSql = `SELECT c.kind AS kind, c.path AS path, c.line_start AS line_start, c.line_end AS line_end,
                           c.date AS date, c.date_source AS date_source,
                           snippet(chunks_fts, 0, '', '', '…', ${SNIPPET_TOKENS}) AS snippet,
                           bm25(chunks_fts) AS bm25
                      FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid
                     WHERE chunks_fts MATCH $match ${sinceClause}
                     ORDER BY bm25 ASC, c.date DESC, c.path ASC, c.line_start ASC
                     LIMIT $limit`;

    for (const mode of terms.length > 1 ? (["all", "any"] as const) : (["all"] as const)) {
      const params: Record<string, string | number> = { $match: ftsExpression(terms, mode) };
      if (since) params.$since = since;
      const total = (db.query(countSql).get(params) as { n: number }).n;
      if (total === 0) continue;
      const rows = db.query(hitSql).all({ ...params, $limit: limit }) as {
        kind: Kind;
        path: string;
        line_start: number;
        line_end: number;
        date: string;
        date_source: DateSource;
        snippet: string;
        bm25: number;
      }[];
      const hits: Hit[] = rows.map((row) => ({
        date: row.date,
        date_source: row.date_source,
        kind: row.kind,
        ref: refFor(row),
        path: row.path,
        line_start: row.line_start,
        line_end: row.line_end,
        snippet: row.snippet.replace(/\s+/g, " ").trim(),
        // bm25() is lower-is-better and negative; report higher-is-better.
        score: round(-row.bm25),
      }));
      return {
        status: "ok",
        match: mode,
        terms: terms.length,
        since,
        hit_count: total,
        top_score: hits[0]?.score ?? null,
        hits,
        partial,
        index: stats,
      };
    }
    return {
      status: "ok",
      match: "none",
      terms: terms.length,
      since,
      hit_count: 0,
      top_score: null,
      hits: [],
      partial,
      index: stats,
    };
  } finally {
    db.close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** The value after `name`, unless it is missing or is itself a flag. */
function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const paths = resolvePaths({
    home: argValue(args, "--home"),
    index: argValue(args, "--index"),
    stateDb: argValue(args, "--state-db"),
  });
  const print = (obj: unknown) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  try {
    if (command === "rebuild") {
      if (!fts5Available()) {
        print({ status: "unavailable", reason: "fts5_unavailable" });
        return 0;
      }
      print({ status: "ok", ...rebuild(paths, { secure: true }) });
      return 0;
    }
    if (command === "query") {
      const text = args.includes("--query-stdin") ? await Bun.stdin.text() : (argValue(args, "--query") ?? "");
      const limitArg = argValue(args, "--limit");
      const budgetArg = argValue(args, "--budget-ms");
      const sinceGiven = args.includes("--since");
      const since = argValue(args, "--since");
      print(
        query(paths, {
          query: text,
          // `--since` followed by a flag is an invalid date, not an absent one.
          since: sinceGiven && since === undefined ? "invalid" : (since ?? null),
          limit: limitArg ? Number(limitArg) : undefined,
          budgetMs: budgetArg !== undefined && Number.isFinite(Number(budgetArg)) ? Number(budgetArg) : undefined,
          rebuildFirst: !args.includes("--no-rebuild"),
        }),
      );
      return 0;
    }
    print({ status: "error", reason: "usage: recall.ts rebuild|query [--query-stdin|--query TEXT] [--since YYYY-MM-DD]" });
    return 2;
  } catch (err) {
    const reason = err instanceof Error && /^[a-z_]+$/.test(err.message) ? err.message : "internal_error";
    print({ status: "error", reason, hit_count: 0, hits: [] });
    return 0;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
