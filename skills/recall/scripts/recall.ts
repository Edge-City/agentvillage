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
 *   - `query` refuses in a group/shared session and returns no data at all
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
const MAX_QUERY_TERMS = 16;
const MAX_TERM_CHARS = 64;
const CHUNK_MAX_LINES = 12;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 64 * 1024;
const SNIPPET_TOKENS = 32;

/**
 * Chat types that are the owner's private surface. Anything else (group,
 * forum, channel, thread, guild, or a value we have never seen) is refused:
 * default-deny, so a platform that invents a new shared chat type cannot leak
 * long-term memory into it.
 */
export const PRIVATE_CHAT_TYPES = new Set(["", "dm", "private", "direct", "c2c"]);

/** Session sources with no chat type that are still the owner's own surface. */
const PRIVATE_SESSION_SOURCES = new Set(["cli", "tui", "desktop", "acp", "local"]);

export type Kind = "daily_note" | "long_term" | "session";
export type DateSource = "filename" | "inline" | "mtime" | "message";

export interface Paths {
  home: string;
  index: string;
  stateDb: string;
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
  sessions: { scanned: number; indexed: number; unchanged: number; removed: number; status: string };
  chunks: number;
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
  return { home, index, stateDb };
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

/** True when the calling session is the owner's private surface. */
export function sessionIsPrivate(env: Record<string, string | undefined> = process.env): boolean {
  const chatType = (env.HERMES_SESSION_CHAT_TYPE ?? "").trim().toLowerCase();
  return PRIVATE_CHAT_TYPES.has(chatType);
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

/**
 * Open (creating if needed) the index. The index is derived data: if the file
 * is not a usable SQLite database it is discarded and rebuilt from sources.
 */
export function openIndex(paths: Paths): Database {
  try {
    return openIndexOnce(paths);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/not a database|malformed|corrupt/i.test(message)) throw err;
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${paths.index}${suffix}`, { force: true });
    return openIndexOnce(paths);
  }
}

function openIndexOnce(paths: Paths): Database {
  assertIndexOutsideMemory(paths);
  const dir = dirname(paths.index);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = !existsSync(paths.index);
  const db = new Database(paths.index, { create: true });
  if (fresh) {
    try {
      chmodSync(paths.index, 0o600);
    } catch {
      /* best effort */
    }
  }
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA journal_mode = WAL");
  // Deleted notes and sessions must not linger in free pages.
  db.run("PRAGMA secure_delete = ON");

  const version = (() => {
    try {
      return (db.query("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | null)
        ?.value;
    } catch {
      return undefined;
    }
  })();
  if (version !== undefined && version !== SCHEMA_VERSION) {
    db.run("DROP TABLE IF EXISTS chunks_fts");
    db.run("DROP TABLE IF EXISTS chunks");
    db.run("DROP TABLE IF EXISTS sources");
    db.run("DROP TABLE IF EXISTS meta");
  }
  for (const stmt of DDL) db.run(stmt);
  try {
    // FTS5 keeps deleted tokens in its segments until a merge unless told not to.
    db.run("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('secure-delete', 1)");
  } catch {
    /* SQLite < 3.42: deletions are merged away on `optimize` below */
  }
  db.run("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", [SCHEMA_VERSION]);
  return db;
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

function syncFiles(db: Database, home: string, stats: RebuildStats): void {
  const sources = listMarkdownSources(home);
  const present = new Set<string>();

  for (const source of sources) {
    let st;
    try {
      st = lstatSync(source.abs);
    } catch {
      continue; // absent: purged below
    }
    // Never follow a symlink out of the workspace, never read a huge file.
    if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) {
      stats.files.skipped++;
      continue;
    }
    present.add(source.sourceId);
    stats.files.scanned++;
    const mtimeMs = Math.trunc(st.mtimeMs);

    const stored = db
      .query("SELECT mtime_ms, size, fingerprint FROM sources WHERE source_id = ?")
      .get(source.sourceId) as { mtime_ms: number; size: number; fingerprint: string } | null;
    if (stored && stored.mtime_ms === mtimeMs && stored.size === st.size) {
      stats.files.unchanged++;
      continue; // cheap path: stat only
    }

    const bytes = readFileSync(source.abs);
    const digest = sha256(bytes);
    const tx = db.transaction(() => {
      const current = db
        .query("SELECT fingerprint FROM sources WHERE source_id = ?")
        .get(source.sourceId) as { fingerprint: string } | null;
      if (current && current.fingerprint === digest) {
        // Touched but identical (and no inline-vs-mtime date drift worth a
        // re-chunk): record the new mtime so the next pass is stat-only.
        db.run("UPDATE sources SET mtime_ms = ?, size = ? WHERE source_id = ?", [mtimeMs, st.size, source.sourceId]);
        return false;
      }
      deleteSource(db, source.sourceId);
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

  const known = db.query("SELECT source_id FROM sources WHERE kind != 'session'").all() as { source_id: string }[];
  for (const { source_id } of known) {
    if (present.has(source_id)) continue;
    db.transaction(() => deleteSource(db, source_id)).immediate();
    stats.files.removed++;
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

/**
 * Read the owner's private conversations from `state.db`.
 *
 * Opened read-only. Eligible sessions: `chat_type = 'dm'` (Telegram and other
 * messaging DMs), or no chat type with a local source (cli, tui, desktop).
 * Everything else — group chats, cron runs (whose transcripts hold the brief
 * drafts that must not become source context), subagents, webhooks, unknown
 * sources — is excluded. Only `user` and `assistant` text is indexed; tool
 * results are not.
 *
 * If the store is absent or its schema lacks a column this depends on, the
 * session side is skipped with a status and the markdown index still works.
 */
function syncSessions(db: Database, stateDbPath: string, stats: RebuildStats): void {
  if (!existsSync(stateDbPath)) {
    stats.sessions.status = "no_session_store";
    purgeSessions(db, new Set(), stats);
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
      purgeSessions(db, new Set(), stats);
      return;
    }
    const filters = ["m.role IN ('user', 'assistant')", "m.content IS NOT NULL", "m.content != ''"];
    if (mCols.has("active")) filters.push("m.active = 1");
    if (mCols.has("_compressed_summary")) filters.push("m._compressed_summary = 0");
    const privateSources = [...PRIVATE_SESSION_SOURCES].map((s) => `'${s}'`).join(", ");
    const eligible = `(s.chat_type = 'dm' OR ((s.chat_type IS NULL OR s.chat_type = '') AND s.source IN (${privateSources})))`;
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

    const present = new Set<string>();
    const messageQuery = store.query(
      `SELECT m.id AS id, m.content AS content, m.timestamp AS ts
         FROM sessions s JOIN messages m ON m.session_id = s.id
        WHERE s.id = ? AND ${where}
        ORDER BY m.id`,
    );

    for (const session of sessions) {
      const sourceId = `session:${session.id}`;
      present.add(sourceId);
      stats.sessions.scanned++;
      const fingerprint = `${session.n}:${session.max_id}:${session.chars}`;
      const stored = db.query("SELECT fingerprint FROM sources WHERE source_id = ?").get(sourceId) as
        | { fingerprint: string }
        | null;
      if (stored && stored.fingerprint === fingerprint) {
        stats.sessions.unchanged++;
        continue;
      }
      const messages = messageQuery.all(session.id) as { id: number; content: string; ts: number }[];
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
        deleteSource(db, sourceId);
        insertChunks(db, sourceId, pending);
        db.run(
          "INSERT INTO sources(source_id, kind, mtime_ms, size, fingerprint) VALUES (?, 'session', NULL, NULL, ?)",
          [sourceId, fingerprint],
        );
      }).immediate();
      stats.sessions.indexed++;
    }
    purgeSessions(db, present, stats);
    stats.sessions.status = "ok";
  } finally {
    store.close();
  }
}

function purgeSessions(db: Database, present: Set<string>, stats: RebuildStats): void {
  const known = db.query("SELECT source_id FROM sources WHERE kind = 'session'").all() as { source_id: string }[];
  for (const { source_id } of known) {
    if (present.has(source_id)) continue;
    db.transaction(() => deleteSource(db, source_id)).immediate();
    stats.sessions.removed++;
  }
}

// ── Public operations ────────────────────────────────────────────────────────

export function rebuild(paths: Paths): RebuildStats {
  const stats: RebuildStats = {
    files: { scanned: 0, indexed: 0, unchanged: 0, removed: 0, skipped: 0 },
    sessions: { scanned: 0, indexed: 0, unchanged: 0, removed: 0, status: "not_run" },
    chunks: 0,
  };
  const db = openIndex(paths);
  try {
    syncFiles(db, paths.home, stats);
    syncSessions(db, paths.stateDb, stats);
    if (stats.files.removed + stats.sessions.removed > 0) {
      // Merge FTS segments so removed text is gone from the index b-trees too.
      db.run("INSERT INTO chunks_fts(chunks_fts) VALUES('optimize')");
    }
    stats.chunks = (db.query("SELECT COUNT(*) AS n FROM chunks").get() as { n: number }).n;
  } finally {
    db.close();
  }
  return stats;
}

/** Word terms from free text, lowercased and de-duplicated in order. Each is
 * quoted, so FTS5 operators in user text (`OR`, `NEAR`, `*`, `:`) are inert. */
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
  opts: { query: string; since?: string | null; limit?: number; rebuildFirst?: boolean; env?: Record<string, string | undefined> },
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

  const stats = opts.rebuildFirst === false ? null : rebuild(paths);
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
        index: stats,
      };
    }
    return { status: "ok", match: "none", terms: terms.length, since, hit_count: 0, top_score: null, hits: [], index: stats };
  } finally {
    db.close();
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
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
      print({ status: "ok", ...rebuild(paths) });
      return 0;
    }
    if (command === "query") {
      const text = args.includes("--query-stdin") ? await Bun.stdin.text() : (argValue(args, "--query") ?? "");
      const limitArg = argValue(args, "--limit");
      print(
        query(paths, {
          query: text,
          since: argValue(args, "--since") ?? null,
          limit: limitArg ? Number(limitArg) : undefined,
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
