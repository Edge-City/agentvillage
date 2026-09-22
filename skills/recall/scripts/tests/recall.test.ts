import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertIndexOutsideMemory,
  chunkText,
  fts5Available,
  query,
  queryTerms,
  rebuild,
  resolvePaths,
  sessionIsPrivate,
  sessionVerdict,
  validSince,
  type Paths,
} from "../recall";

// Message dates are local calendar dates; pin the zone for this file only.
const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

const FIXTURE = join(import.meta.dir, "fixtures", "workspace");
const SCRIPT = join(import.meta.dir, "..", "recall.ts");
const DM = { HERMES_SESSION_CHAT_TYPE: "dm" };

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

/** A fresh `$HERMES_HOME` holding a copy of the fixture workspace. */
function workspace(): Paths {
  const home = mkdtempSync(join(tmpdir(), "recall-home-"));
  homes.push(home);
  cpSync(FIXTURE, home, { recursive: true });
  return resolvePaths({ home });
}

/** Name → sha256 of every entry under `memory/`, recursively. */
function snapshotMemory(home: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = `${prefix}${name}`;
      if (statSync(abs).isDirectory()) walk(abs, `${rel}/`);
      else out[rel] = `${statSync(abs).mtimeMs}:${createHash("sha256").update(readFileSync(abs)).digest("hex")}`;
    }
  };
  walk(join(home, "memory"), "memory/");
  return out;
}

const NOON_UTC = (date: string) => Date.parse(`${date}T12:00:00Z`) / 1000;

/** A minimal Hermes `state.db` with the columns the indexer relies on. */
function makeStateDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, chat_type TEXT, started_at REAL NOT NULL)`);
  db.run(`CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
            content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1,
            compacted INTEGER NOT NULL DEFAULT 0, _compressed_summary INTEGER NOT NULL DEFAULT 0)`);
  const s = db.prepare("INSERT INTO sessions(id, source, chat_type, started_at) VALUES (?, ?, ?, 0)");
  s.run("tg-dm", "telegram", "dm");
  s.run("tg-group", "telegram", "group");
  s.run("tg-forum", "telegram", "forum");
  s.run("cron-1", "cron", null);
  s.run("cli-1", "cli", null);
  s.run("sub-1", "subagent", null);
  const m = db.prepare("INSERT INTO messages(session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, ?)");
  m.run("tg-dm", "user", "I went kiteboarding at Ashwem this morning", NOON_UTC("2026-09-19"), 1);
  m.run("tg-dm", "assistant", "Noted the kiteboarding trip.\nWant me to find other riders?", NOON_UTC("2026-09-19"), 1);
  m.run("tg-dm", "tool", "toolsecret raw tool output", NOON_UTC("2026-09-19"), 1);
  m.run("tg-dm", "user", "rewoundsecret message", NOON_UTC("2026-09-19"), 0);
  m.run("tg-group", "user", "groupsecret plans for the beach", NOON_UTC("2026-09-19"), 1);
  m.run("tg-forum", "user", "forumsecret topic", NOON_UTC("2026-09-19"), 1);
  m.run("cron-1", "assistant", "cronsecret draft brief body", NOON_UTC("2026-09-20"), 1);
  m.run("cli-1", "user", "cli note about kiteboarding gear", NOON_UTC("2026-09-21"), 1);
  m.run("sub-1", "user", "subagentsecret delegated goal", NOON_UTC("2026-09-21"), 1);
  return db;
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("runtime", () => {
  test("bun:sqlite ships FTS5", () => {
    expect(fts5Available()).toBe(true);
  });
});

describe("chunking and parsing", () => {
  test("chunks are cut at blank lines and headings, with 1-based line numbers", () => {
    const chunks = chunkText("# Title\n- a\n- b\n\n## Next\n- c\n");
    expect(chunks.map((c) => [c.lineStart, c.lineEnd])).toEqual([
      [1, 3],
      [5, 6],
    ]);
    expect(chunks[1]!.heading).toBe("Next");
  });

  test("long blocks are split", () => {
    const text = Array.from({ length: 30 }, (_, i) => `- line ${i}`).join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBe(3);
    expect(chunks[2]!.lineEnd).toBe(30);
  });

  test("query terms are lowercased, de-duplicated, and stripped of FTS syntax", () => {
    expect(queryTerms('Priya OR priya NEAR(x "y") *')).toEqual(["priya", "or", "near", "x", "y"]);
    expect(queryTerms("  ...  ")).toEqual([]);
  });

  test("since accepts a date or an ISO timestamp, nothing else", () => {
    expect(validSince("2026-09-20")).toBe("2026-09-20");
    expect(validSince("2026-09-20T10:00:00Z")).toBe("2026-09-20");
    expect(validSince(undefined)).toBeNull();
    expect(validSince("")).toBeNull();
    expect(validSince("last week")).toBe("invalid");
    expect(validSince("2026-02-30")).toBe("invalid");
  });
});

describe("index build and incremental rebuild", () => {
  test("first build indexes MEMORY.md and dated daily notes only", () => {
    const paths = workspace();
    const stats = rebuild(paths);
    expect(stats.files.indexed).toBe(4);
    expect(stats.files.scanned).toBe(4);
    expect(stats.sessions.status).toBe("no_session_store");
    expect(existsSync(paths.index)).toBe(true);
    // Drafts and JSON ledgers under memory/ are not source context.
    const res = query(paths, { query: "zebracake", env: DM });
    expect(res.status).toBe("ok");
    expect(res.hit_count).toBe(0);
  });

  test("a second rebuild with nothing changed is stat-only", () => {
    const paths = workspace();
    rebuild(paths);
    const stats = rebuild(paths);
    expect(stats.files.indexed).toBe(0);
    expect(stats.files.unchanged).toBe(4);
    expect(stats.files.removed).toBe(0);
  });

  test("a touched but identical file is not re-indexed", () => {
    const paths = workspace();
    rebuild(paths);
    const note = join(paths.home, "memory", "2026-09-20.md");
    const later = new Date(Date.now() + 60_000);
    utimesSync(note, later, later);
    const stats = rebuild(paths);
    expect(stats.files.indexed).toBe(0);
    expect(stats.files.unchanged).toBe(4);
    // And the new mtime is recorded, so the pass after is stat-only again.
    expect(rebuild(paths).files.unchanged).toBe(4);
  });

  test("edits, additions and deletions are picked up", () => {
    const paths = workspace();
    rebuild(paths);
    const edited = join(paths.home, "memory", "2026-09-21.md");
    writeFileSync(edited, "# 2026-09-21\n\n- Swapped the LoRa radio for a mesh module.\n");
    writeFileSync(join(paths.home, "memory", "2026-09-22.md"), "# 2026-09-22\n\n- Tried kombucha with Arjun.\n");
    rmSync(join(paths.home, "memory", "2026-09-18.md"));

    const stats = rebuild(paths);
    expect(stats.files.indexed).toBe(2);
    expect(stats.files.removed).toBe(1);

    expect(query(paths, { query: "fermentation", env: DM }).hit_count).toBe(0);
    expect(query(paths, { query: "kombucha", env: DM }).hit_count).toBe(1);
    const mesh = query(paths, { query: "mesh module", env: DM });
    expect(mesh.status === "ok" && mesh.hits[0]!.ref).toBe("memory/2026-09-21.md:3");
    expect(query(paths, { query: "demo", env: DM }).hit_count).toBe(0);
  });

  test("a corrupt index is discarded and rebuilt", () => {
    const paths = workspace();
    rebuild(paths);
    writeFileSync(paths.index, "this is not sqlite".repeat(100));
    rmSync(`${paths.index}-wal`, { force: true });
    rmSync(`${paths.index}-shm`, { force: true });
    const stats = rebuild(paths);
    expect(stats.files.indexed).toBe(4);
  });
});

describe("query", () => {
  test("returns dated snippets with file and line refs", () => {
    const paths = workspace();
    const res = query(paths, { query: "Priya battery enclosure", env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.match).toBe("all");
    const refs = res.hits.map((h) => h.ref).sort();
    expect(refs).toEqual(["MEMORY.md:7-8", "memory/2026-09-20.md:3-4"].sort());
    const daily = res.hits.find((h) => h.path === "memory/2026-09-20.md")!;
    expect(daily.date).toBe("2026-09-20");
    expect(daily.date_source).toBe("filename");
    expect(daily.kind).toBe("daily_note");
    expect(daily.snippet).toContain("battery enclosure");
    const longTerm = res.hits.find((h) => h.path === "MEMORY.md")!;
    expect(longTerm.date).toBe("2026-09-19");
    expect(longTerm.date_source).toBe("inline");
    expect(longTerm.kind).toBe("long_term");
    expect(res.top_score).toBe(res.hits[0]!.score);
    expect(res.top_score!).toBeGreaterThan(0);
  });

  test("falls back to any-term matching when no chunk has every term", () => {
    const paths = workspace();
    const res = query(paths, { query: "fermentation zzzunmatched", env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.match).toBe("any");
    expect(res.hits[0]!.ref).toBe("memory/2026-09-18.md:3-4");
  });

  test("porter stemming matches inflections", () => {
    const paths = workspace();
    expect(query(paths, { query: "microgrids", env: DM }).hit_count).toBe(2);
  });

  test("since excludes older notes and older inline-dated memory", () => {
    const paths = workspace();
    const all = query(paths, { query: "Priya", env: DM });
    const recent = query(paths, { query: "Priya", since: "2026-09-20", env: DM });
    if (all.status !== "ok" || recent.status !== "ok") throw new Error("not ok");
    expect(all.hits.map((h) => h.date).sort()).toEqual(["2026-09-19", "2026-09-20"]);
    expect(recent.since).toBe("2026-09-20");
    expect(recent.hits.map((h) => h.ref)).toEqual(["memory/2026-09-20.md:3-4"]);
    expect(recent.hits.every((h) => h.date >= "2026-09-20")).toBe(true);
  });

  test("invalid since is an error with no data", () => {
    const paths = workspace();
    expect(query(paths, { query: "Priya", since: "yesterday", env: DM })).toEqual({
      status: "error",
      reason: "invalid_since",
      hit_count: 0,
      hits: [],
    });
  });

  test("empty, operator-only and oversized queries are errors", () => {
    const paths = workspace();
    expect(query(paths, { query: "   ", env: DM }).status).toBe("error");
    expect(query(paths, { query: '"" * ()', env: DM }).status).toBe("error");
    expect(query(paths, { query: "x".repeat(501), env: DM }).status).toBe("error");
  });

  test("FTS operators in user text are inert", () => {
    const paths = workspace();
    const res = query(paths, { query: 'Priya" OR NEAR(* firmware', env: DM });
    expect(res.status).toBe("ok");
  });

  test("ordering is deterministic across runs", () => {
    const paths = workspace();
    const a = query(paths, { query: "microgrid firmware Priya coffee", env: DM });
    const b = query(paths, { query: "microgrid firmware Priya coffee", env: DM });
    if (a.status !== "ok" || b.status !== "ok") throw new Error("not ok");
    expect(a.hits).toEqual(b.hits);
    for (let i = 1; i < a.hits.length; i++) {
      expect(a.hits[i - 1]!.score).toBeGreaterThanOrEqual(a.hits[i]!.score);
    }
  });

  test("limit caps the hits but hit_count reports every match", () => {
    const paths = workspace();
    const res = query(paths, { query: "microgrid firmware Priya coffee", limit: 1, env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.hits.length).toBe(1);
    expect(res.hit_count).toBeGreaterThan(1);
  });
});

describe("group-session refusal", () => {
  for (const chatType of ["group", "forum", "channel", "thread", "guild", "something-new"]) {
    test(`refuses in a ${chatType} session and returns no data`, () => {
      const paths = workspace();
      const res = query(paths, { query: "Priya", env: { HERMES_SESSION_CHAT_TYPE: chatType } });
      expect(res).toEqual({ status: "unavailable", reason: "unavailable in group sessions", hit_count: 0, hits: [] });
      // Refusal happens before the index is even touched.
      expect(existsSync(paths.index)).toBe(false);
    });
  }

  test("DM and local sessions are the main session", () => {
    expect(sessionIsPrivate({ HERMES_SESSION_CHAT_TYPE: "dm", HERMES_SESSION_PLATFORM: "telegram" })).toBe(true);
    expect(sessionIsPrivate({ HERMES_SESSION_CHAT_TYPE: " DM " })).toBe(true);
    expect(sessionIsPrivate({}, true)).toBe(true); // an interactive terminal
    expect(sessionIsPrivate({ HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_SOURCE: "cli" })).toBe(true);
    expect(sessionIsPrivate({ HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_SOURCE: "desktop" })).toBe(true);
  });

  const notMain: Record<string, Record<string, string>> = {
    "a cron run delivering to a group": {
      HERMES_SESSION_CHAT_TYPE: "",
      HERMES_SESSION_PLATFORM: "",
      HERMES_CRON_SESSION: "1",
    },
    "a cron run bound as a DM": { HERMES_SESSION_CHAT_TYPE: "dm", HERMES_CRON_SESSION: "1" },
    "a cron_ session id": { HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_ID: "cron_abc123" },
    "a cron platform": { HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_PLATFORM: "cron" },
    "an api_server turn": { HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_PLATFORM: "api_server" },
    "a webhook": { HERMES_SESSION_CHAT_TYPE: "webhook", HERMES_SESSION_PLATFORM: "webhook" },
    "a messaging platform with no chat type": { HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_PLATFORM: "telegram" },
    "an ACP (editor) turn": { HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_SOURCE: "acp" },
    "a local source on a remote platform": {
      HERMES_SESSION_CHAT_TYPE: "",
      HERMES_SESSION_SOURCE: "cli",
      HERMES_PLATFORM: "api_server",
    },
  };
  for (const [label, env] of Object.entries(notMain)) {
    test(`refuses ${label}`, () => {
      expect(sessionIsPrivate(env, true)).toBe(false);
      const paths = workspace();
      expect(query(paths, { query: "Priya", env, tty: true }).status).toBe("unavailable");
      expect(existsSync(paths.index)).toBe(false);
    });
  }
});

describe("never writes into memory/", () => {
  test("rebuild and query leave memory/ byte-for-byte unchanged", () => {
    const paths = workspace();
    const before = snapshotMemory(paths.home);
    rebuild(paths);
    query(paths, { query: "Priya microgrid", env: DM });
    query(paths, { query: "Priya", since: "2026-09-20", env: DM });
    rebuild(paths);
    expect(snapshotMemory(paths.home)).toEqual(before);
    expect(paths.index).toBe(join(paths.home, ".recall", "index.sqlite"));
  });

  test("an index path under memory/ is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-home-"));
    homes.push(home);
    cpSync(FIXTURE, home, { recursive: true });
    const inside = resolvePaths({ home, index: "memory/recall.sqlite" });
    expect(() => assertIndexOutsideMemory(inside)).toThrow("index_path_inside_memory");
    expect(() => rebuild(inside)).toThrow("index_path_inside_memory");
    expect(existsSync(join(home, "memory", "recall.sqlite"))).toBe(false);
  });

  test("an index path routed into memory/ through a symlink is refused", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-home-"));
    homes.push(home);
    cpSync(FIXTURE, home, { recursive: true });
    symlinkSync(join(home, "memory"), join(home, "sneaky"));
    const routed = resolvePaths({ home, index: "sneaky/index.sqlite" });
    expect(() => assertIndexOutsideMemory(routed)).toThrow("index_path_inside_memory");
  });

  test("the index cannot be MEMORY.md itself", () => {
    const home = mkdtempSync(join(tmpdir(), "recall-home-"));
    homes.push(home);
    cpSync(FIXTURE, home, { recursive: true });
    expect(() => assertIndexOutsideMemory(resolvePaths({ home, index: "MEMORY.md" }))).toThrow("index_path_is_source");
  });
});

describe("session store", () => {
  test("indexes only the owner's private user/assistant messages, read-only", () => {
    const paths = workspace();
    makeStateDb(paths.stateDb).close();
    const before = fileHash(paths.stateDb);

    const stats = rebuild(paths);
    expect(stats.sessions.status).toBe("ok");
    expect(stats.sessions.indexed).toBe(2); // tg-dm and cli-1

    const res = query(paths, { query: "kiteboarding", env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.hit_count).toBe(3);
    const refs = res.hits.map((h) => h.ref).sort();
    expect(refs).toEqual(["session:cli-1#8:1", "session:tg-dm#1:1", "session:tg-dm#2:1-2"]);
    const dm = res.hits.find((h) => h.ref === "session:tg-dm#1:1")!;
    expect(dm.kind).toBe("session");
    expect(dm.date_source).toBe("message");

    for (const secret of ["groupsecret", "forumsecret", "cronsecret", "toolsecret", "subagentsecret", "rewoundsecret"]) {
      expect(query(paths, { query: secret, env: DM }).hit_count).toBe(0);
    }
    expect(fileHash(paths.stateDb)).toBe(before);
  });

  test("changed and deleted sessions are re-indexed and purged", () => {
    const paths = workspace();
    const store = makeStateDb(paths.stateDb);
    rebuild(paths);
    expect(rebuild(paths).sessions.unchanged).toBe(2);

    store.run("INSERT INTO messages(session_id, role, content, timestamp) VALUES ('tg-dm', 'user', 'also paddleboarding', ?)", [
      NOON_UTC("2026-09-22"),
    ]);
    store.run("DELETE FROM messages WHERE session_id = 'cli-1'");
    store.run("DELETE FROM sessions WHERE id = 'cli-1'");
    store.close();

    const stats = rebuild(paths);
    expect(stats.sessions.appended).toBe(1); // only the new message is indexed
    expect(stats.sessions.indexed).toBe(0);
    expect(stats.sessions.removed).toBe(1);
    expect(query(paths, { query: "paddleboarding", env: DM }).hit_count).toBe(1);
    expect(query(paths, { query: "gear", env: DM }).hit_count).toBe(0);
  });

  test("a session store without chat_type is skipped entirely", () => {
    const paths = workspace();
    const db = new Database(paths.stateDb, { create: true });
    db.run("CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL)");
    db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL)");
    db.run("INSERT INTO sessions VALUES ('x', 'telegram')");
    db.run("INSERT INTO messages VALUES (1, 'x', 'user', 'unverifiable kiteboarding', 0)");
    db.close();
    const stats = rebuild(paths);
    expect(stats.sessions.status).toBe("session_schema_unsupported");
    expect(query(paths, { query: "unverifiable", env: DM }).hit_count).toBe(0);
  });

  test("since applies to session messages by message date", () => {
    const paths = workspace();
    makeStateDb(paths.stateDb).close();
    const res = query(paths, { query: "kiteboarding", since: "2026-09-20", env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.hits.map((h) => h.ref)).toEqual(["session:cli-1#8:1"]);
  });
});

describe("CLI", () => {
  async function run(args: string[], env: Record<string, string>, stdin?: string) {
    const proc = Bun.spawn(["bun", SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    return { code, json: JSON.parse(out.trim()) };
  }

  test("query reads the query from stdin and prints one JSON object", async () => {
    const paths = workspace();
    const { code, json } = await run(
      ["query", "--query-stdin", "--since", "2026-09-20"],
      { HERMES_HOME: paths.home, HERMES_SESSION_CHAT_TYPE: "dm" },
      "Priya thermal",
    );
    expect(code).toBe(0);
    expect(json.status).toBe("ok");
    expect(json.hits[0].ref).toBe("memory/2026-09-20.md:3-4");
  });

  test("query refuses in a group session even when run from a terminal", async () => {
    const paths = workspace();
    const { code, json } = await run(
      ["query", "--query-stdin"],
      { HERMES_HOME: paths.home, HERMES_SESSION_CHAT_TYPE: "group" },
      "Priya",
    );
    expect(code).toBe(0);
    expect(json).toEqual({ status: "unavailable", reason: "unavailable in group sessions", hit_count: 0, hits: [] });
    expect(existsSync(paths.index)).toBe(false);
  });

  test("rebuild prints counts only", async () => {
    const paths = workspace();
    const { code, json } = await run(["rebuild"], { HERMES_HOME: paths.home });
    expect(code).toBe(0);
    expect(json.status).toBe("ok");
    expect(json.files.indexed).toBe(4);
    expect(JSON.stringify(json)).not.toContain("Priya");
  });

  test("a refused index path is reported, not thrown", async () => {
    const paths = workspace();
    const { code, json } = await run(["rebuild"], { HERMES_HOME: paths.home, AV_RECALL_INDEX: "memory/x.sqlite" });
    expect(code).toBe(0);
    expect(json).toEqual({ status: "error", reason: "index_path_inside_memory", hit_count: 0, hits: [] });
  });
});

describe("hardening", () => {
  test("a hard-linked note is not indexed (it may point outside the workspace)", () => {
    const paths = workspace();
    const outsideDir = mkdtempSync(join(tmpdir(), "recall-outside-"));
    homes.push(outsideDir);
    const outside = join(outsideDir, "outside.md");
    writeFileSync(outside, "- hardlinksecret from outside the workspace\n");
    linkSync(outside, join(paths.home, "memory", "2026-09-23.md"));
    const stats = rebuild(paths);
    expect(stats.files.skipped).toBe(1);
    expect(query(paths, { query: "hardlinksecret", env: DM }).hit_count).toBe(0);
  });

  test("session messages older than the wipe epoch are never indexed", () => {
    const paths = workspace();
    makeStateDb(paths.stateDb).close();
    mkdirSync(join(paths.home, ".recall"), { recursive: true });
    writeFileSync(paths.epoch, `${NOON_UTC("2026-09-20")}\n`);
    rebuild(paths);
    const res = query(paths, { query: "kiteboarding", env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    // The 2026-09-19 DM belonged to the previous occupant; the 2026-09-21 CLI note is after the wipe.
    expect(res.hits.map((h) => h.ref)).toEqual(["session:cli-1#8:1"]);
  });

  test("an unreadable epoch marker fails closed to its modification time", () => {
    const paths = workspace();
    makeStateDb(paths.stateDb).close();
    mkdirSync(join(paths.home, ".recall"), { recursive: true });
    writeFileSync(paths.epoch, "not a number");
    expect(query(paths, { query: "kiteboarding", env: DM }).hit_count).toBe(0);
  });

  test("a rewound session is re-indexed whole, not appended", () => {
    const paths = workspace();
    const store = makeStateDb(paths.stateDb);
    rebuild(paths);
    store.run("UPDATE messages SET active = 0 WHERE id = 1");
    store.run("INSERT INTO messages(session_id, role, content, timestamp) VALUES ('tg-dm', 'user', 'surfing instead', ?)", [
      NOON_UTC("2026-09-22"),
    ]);
    store.close();
    const stats = rebuild(paths);
    expect(stats.sessions.indexed).toBe(1);
    expect(stats.sessions.appended).toBe(0);
    expect(query(paths, { query: "Ashwem", env: DM }).hit_count).toBe(0);
  });

  test("--since followed by a flag is an invalid date, not a way to skip the rebuild", async () => {
    const paths = workspace();
    const proc = Bun.spawn(["bun", SCRIPT, "query", "--query-stdin", "--since", "--no-rebuild"], {
      env: { ...process.env, HERMES_HOME: paths.home, HERMES_SESSION_CHAT_TYPE: "dm" },
      stdin: new TextEncoder().encode("Priya"),
      stdout: "pipe",
    });
    const json = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(await proc.exited).toBe(0);
    expect(json.reason).toBe("invalid_since");
  });

  test("the CLI refuses a cron run even with an empty chat type", async () => {
    const paths = workspace();
    const proc = Bun.spawn(["bun", SCRIPT, "query", "--query-stdin"], {
      env: { ...process.env, HERMES_HOME: paths.home, HERMES_SESSION_CHAT_TYPE: "", HERMES_CRON_SESSION: "1" },
      stdin: new TextEncoder().encode("Priya"),
      stdout: "pipe",
    });
    const json = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(json.status).toBe("unavailable");
    expect(existsSync(paths.index)).toBe(false);
  });
});

describe("query-path budget and scrubbing", () => {
  test("past its budget the query answers from the existing index and says so", () => {
    const paths = workspace();
    rebuild(paths);
    writeFileSync(join(paths.home, "memory", "2026-09-21.md"), "# 2026-09-21\n\n- Switched to a hydrogen cell.\n");
    const res = query(paths, { query: "microgrid demo", budgetMs: -1, env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.partial).toBe(true);
    // Old text still answers until the next rebuild finishes the work.
    expect(res.hits.map((h) => h.ref)).toContain("memory/2026-09-21.md:3");
    expect(query(paths, { query: "hydrogen", budgetMs: -1, env: DM }).hit_count).toBe(0);
    const done = query(paths, { query: "hydrogen", env: DM });
    expect(done.status === "ok" && done.partial).toBe(false);
    expect(done.hit_count).toBe(1);
  });

  test("a removal on the query path is scrubbed from the file by the next background rebuild", () => {
    const paths = workspace();
    writeFileSync(join(paths.home, "memory", "2026-09-22.md"), "- quokkasecret plans\n");
    rebuild(paths);
    rmSync(join(paths.home, "memory", "2026-09-22.md"));
    expect(query(paths, { query: "quokkasecret", env: DM }).hit_count).toBe(0);
    const meta = new Database(paths.index, { readonly: true });
    expect((meta.query("SELECT value FROM meta WHERE key = 'scrub_owed'").get() as { value: string }).value).toBe("1");
    meta.close();

    rebuild(paths, { secure: true });
    const bytes = [paths.index, `${paths.index}-wal`]
      .filter((p) => existsSync(p))
      .map((p) => readFileSync(p).toString("latin1"))
      .join("");
    expect(bytes).not.toContain("quokkasecret");
    const after = new Database(paths.index, { readonly: true });
    expect(after.query("SELECT value FROM meta WHERE key = 'scrub_owed'").get()).toBeNull();
    after.close();
  });

  test("a large session store: growth is appended and an unchanged query stays within budget", () => {
    const paths = workspace();
    const store = makeStateDb(paths.stateDb);
    const addSession = store.prepare("INSERT INTO sessions(id, source, chat_type, started_at) VALUES (?, 'telegram', 'dm', 0)");
    const addMessage = store.prepare("INSERT INTO messages(session_id, role, content, timestamp) VALUES (?, ?, ?, ?)");
    store.transaction(() => {
      for (let s = 0; s < 200; s++) {
        addSession.run(`big-${s}`);
        for (let m = 0; m < 100; m++) {
          addMessage.run(
            `big-${s}`,
            m % 2 ? "assistant" : "user",
            `session ${s} message ${m} about topic${m % 17} and more words`,
            NOON_UTC("2026-09-15"),
          );
        }
      }
    })();

    const first = rebuild(paths);
    expect(first.sessions.indexed).toBe(202);

    addMessage.run("big-7", "user", "a brand new wombat detail", NOON_UTC("2026-09-22"));
    store.close();

    const started = Date.now();
    const res = query(paths, { query: "wombat", env: DM });
    const elapsed = Date.now() - started;
    if (res.status !== "ok" || !res.index) throw new Error("not ok");
    expect(res.partial).toBe(false);
    expect(res.index.sessions.appended).toBe(1);
    expect(res.index.sessions.indexed).toBe(0);
    expect(res.hits[0]!.ref).toMatch(/^session:big-7#\d+:1$/);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("positive evidence of a main session", () => {
  test("an empty environment without a terminal is no_session", () => {
    expect(sessionVerdict({}, false)).toBe("no_session");
    const paths = workspace();
    expect(query(paths, { query: "Priya", env: {}, tty: false })).toEqual({
      status: "unavailable",
      reason: "no_session",
      hit_count: 0,
      hits: [],
    });
    expect(existsSync(paths.index)).toBe(false);
  });

  /** The environment minus every session variable this process may have inherited. */
  function bareEnv(extra: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined || /^HERMES_(SESSION_|CRON_|PLATFORM)/.test(key)) continue;
      env[key] = value;
    }
    return { ...env, ...extra };
  }

  test("the CLI with piped stdin and no session variables refuses", async () => {
    const paths = workspace();
    const proc = Bun.spawn(["bun", SCRIPT, "query", "--query-stdin"], {
      env: bareEnv({ HERMES_HOME: paths.home }),
      stdin: new TextEncoder().encode("Priya"),
      stdout: "pipe",
    });
    const json = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(json).toEqual({ status: "unavailable", reason: "no_session", hit_count: 0, hits: [] });
  });

  test("the CLI as the plugin drives it (platform cli, piped stdin) answers", async () => {
    const paths = workspace();
    const proc = Bun.spawn(["bun", SCRIPT, "query", "--query-stdin"], {
      env: bareEnv({ HERMES_HOME: paths.home, HERMES_SESSION_CHAT_TYPE: "", HERMES_SESSION_PLATFORM: "cli" }),
      stdin: new TextEncoder().encode("Priya"),
      stdout: "pipe",
    });
    const json = JSON.parse((await new Response(proc.stdout).text()).trim());
    expect(json.status).toBe("ok");
    expect(json.hit_count).toBe(2);
  });

  test("the CLI in a real terminal answers", async () => {
    const script = Bun.which("script");
    if (!script) return; // no pty helper on this host
    const paths = workspace();
    const argv =
      process.platform === "darwin"
        ? [script, "-q", "/dev/null", "bun", SCRIPT, "query", "--query", "Priya"]
        : [script, "-q", "-e", "-c", `bun ${JSON.stringify(SCRIPT)} query --query Priya`, "/dev/null"];
    const proc = Bun.spawn(argv, { env: bareEnv({ HERMES_HOME: paths.home }), stdin: "ignore", stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).replace(/\r/g, "");
    await proc.exited;
    // The pty echoes control characters (e.g. `^D`) ahead of the output on the same line.
    const line = out.split("\n").filter((l) => l.includes("{")).pop() ?? "{}";
    const json = JSON.parse(line.slice(line.indexOf("{")));
    expect(json.status).toBe("ok");
    expect(json.hit_count).toBe(2);
  });
});

describe("session store resilience", () => {
  test("compacted messages stay searchable; rewound ones do not", () => {
    const paths = workspace();
    const store = makeStateDb(paths.stateDb);
    store.run("UPDATE messages SET active = 0, compacted = 1 WHERE id = 1"); // summarised away
    store.run("UPDATE messages SET active = 0, compacted = 0 WHERE id = 2"); // rewound
    store.close();
    rebuild(paths);
    expect(query(paths, { query: "Ashwem", env: DM }).hit_count).toBe(1);
    expect(query(paths, { query: "riders", env: DM }).hit_count).toBe(0);
  });

  test("compaction after indexing appends instead of dropping the summarised messages", () => {
    const paths = workspace();
    const store = makeStateDb(paths.stateDb);
    rebuild(paths);
    store.run("UPDATE messages SET active = 0, compacted = 1 WHERE session_id = 'tg-dm' AND active = 1");
    store.run("INSERT INTO messages(session_id, role, content, timestamp) VALUES ('tg-dm', 'user', 'after compaction: dolphins', ?)", [
      NOON_UTC("2026-09-22"),
    ]);
    store.close();
    const stats = rebuild(paths);
    expect(stats.sessions.appended).toBe(1);
    expect(query(paths, { query: "Ashwem", env: DM }).hit_count).toBe(1);
    expect(query(paths, { query: "dolphins", env: DM }).hit_count).toBe(1);
  });

  test("a WAL store with no holder and no -shm is unreadable, never purged, and answers partial", () => {
    const paths = workspace();
    const store = makeStateDb(paths.stateDb);
    rebuild(paths);
    store.run("PRAGMA wal_checkpoint(TRUNCATE)");
    store.close();
    rmSync(`${paths.stateDb}-wal`, { force: true });
    rmSync(`${paths.stateDb}-shm`, { force: true });

    const stats = rebuild(paths);
    expect(stats.sessions.status).toBe("session_store_unreadable");
    expect(stats.sessions.removed).toBe(0);
    expect(stats.partial).toBe(true);
    const res = query(paths, { query: "kiteboarding", env: DM });
    if (res.status !== "ok") throw new Error(res.reason);
    expect(res.partial).toBe(true);
    expect(res.hit_count).toBe(3);
  });

  test("query terms are cut at 64 code points, not UTF-16 units", () => {
    const term = queryTerms("\u{1D49C}".repeat(70))[0]!;
    expect(Array.from(term).length).toBe(64);
  });
});
