#!/usr/bin/env bun
/**
 * The nap's SQLite WAL fold (P-COST NAP design v2 1.3, 13 S1; review-a S-n1): its OWN hermes exec, which the
 * control plane runs after the writers are verified stopped and BEFORE its root count, so the count, the
 * archive and the checkpoint all see the folded tree. `install/nap-archive.ts` never folds; it refuses
 * (`wal_unfolded`) while any `-wal` file is non-empty, and (`fold_missing`) without this run's fold record.
 *
 *   bun --no-env-file --no-install install/nap-sqlite-fold.ts --run-id <uuid> [--home <dir>] [--root <dir>]
 *
 * Every SQLite database under the root (each `*.db`, `*.sqlite`, `*.sqlite3`, and the main file of every
 * `*-wal` file, whatever its name) that starts with the SQLite header is opened with Bun's built-in
 * `bun:sqlite` and checkpointed (`PRAGMA wal_checkpoint(TRUNCATE)`): its committed transactions move into the
 * main file and its `-wal` is left empty. Only a file with the header is opened: SQLite resets a WAL it
 * cannot use when it closes, so opening a file that merely ends in `.db` could destroy bytes the archive
 * must keep. Sidecars are never excluded from the archive.
 *
 * Writes `$HERMES_HOME/av-events/nap/fold.json` (0600) `{schema, run_id, db_count, wal_folded, wal_unfolded,
 * at}`, which the archive copies into its manifest, and prints the same counts as one JSON line.
 * Exit 0 folded; 64 refused (`wal_unfolded`: a `-wal` is still non-empty); 1 error; 2 usage. It writes only
 * into each database's own files and that one record. Never a path in any output.
 */
import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, openSync, readSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { UUID, writeJsonAtomic } from "./nap-common";
import { inRetiredWal, NAP_DIR, walBlocks, walOrphan, type PathRules, SQLITE_SUFFIXES, WAL_SUFFIX, walkHome } from "./nap-state-paths";
import { hermesHome } from "./paths";

export const FOLD_SCHEMA = "nap_fold.v1";
/** The fold's record, relative to `$HERMES_HOME`. */
export const FOLD_FILE = `${NAP_DIR}/fold.json`;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");

/** Whether `path` starts with the SQLite header (never following a symlink). */
export function isSqliteFile(path: string): boolean {
  let fd = -1;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const buf = Buffer.alloc(SQLITE_MAGIC.length);
    return readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeSync(fd);
  }
}

const sizeOf = (path: string): number => {
  try {
    const st = lstatSync(path);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
};

export type FoldResult = { db_count: number; wal_folded: number; wal_unfolded: number; wal_orphan: number };

/** Fold the databases among `rels` (regular files relative to `root`, from an include walk). */
export function foldSqlite(root: string, rels: string[]): FoldResult {
  const candidates = new Set<string>();
  for (const rel of rels) {
    if (inRetiredWal(rel)) continue; // Hermes's hands-off recovery capture: never opened (review-a S3)
    if (SQLITE_SUFFIXES.some((s) => rel.endsWith(s))) candidates.add(rel);
    if (rel.endsWith(WAL_SUFFIX) && rel.length > WAL_SUFFIX.length) candidates.add(rel.slice(0, -WAL_SUFFIX.length));
  }
  let db_count = 0;
  let wal_folded = 0;
  for (const rel of [...candidates].sort()) {
    const path = join(root, ...rel.split("/"));
    if (!isSqliteFile(path)) continue;
    db_count++;
    const before = sizeOf(`${path}${WAL_SUFFIX}`);
    try {
      const db = new Database(path, { readwrite: true, create: false });
      try {
        db.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      } finally {
        db.close();
      }
    } catch {
      // Left as it is: the count below sees a WAL that is still non-empty, and the archive refuses it.
    }
    if (before > 0 && sizeOf(`${path}${WAL_SUFFIX}`) === 0) wal_folded++;
  }
  const regular = new Set(rels);
  const nonEmpty = (rel: string) => sizeOf(join(root, ...rel.split("/"))) > 0;
  const wal_unfolded = rels.filter((rel) => walBlocks(rel, regular) && nonEmpty(rel)).length;
  const wal_orphan = rels.filter((rel) => !inRetiredWal(rel) && walOrphan(rel, regular) && nonEmpty(rel)).length;
  return { db_count, wal_folded, wal_unfolded, wal_orphan };
}

/** Fold the whole tree the archive will walk (by the same rules; this walk is lenient, the archive's is not). */
export function foldTree(root: string, home: string): FoldResult {
  const rules: PathRules = { hermesRel: relative(root, home).split(sep).join("/") };
  const tree = walkHome(root, rules, { lenient: true });
  return foldSqlite(root, tree.items.filter((i) => i.type === "file").map((i) => i.rel));
}

function usage(message: string): never {
  console.error(`nap-sqlite-fold: ${message}`);
  console.error("usage: bun install/nap-sqlite-fold.ts --run-id <uuid> [--home <dir>] [--root <dir>]");
  process.exit(2);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!["--run-id", "--home", "--root"].includes(arg)) usage(`unknown argument ${arg}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) usage(`${arg} needs a value`);
    if (flags[arg] !== undefined) usage(`${arg} given twice`);
    flags[arg] = v;
  }
  const runId = flags["--run-id"] ?? process.env.NAP_RUN_ID?.trim() ?? "";
  if (!UUID.test(runId)) usage("--run-id (or NAP_RUN_ID) must be a lowercase uuid");
  if (!flags["--root"] && !process.env.HOME) usage("--root (or HOME) is required");
  const home = resolve(flags["--home"] ?? hermesHome());
  const root = resolve(flags["--root"] ?? process.env.HOME ?? "");
  if (!home.startsWith(root + sep)) usage("--home must sit inside --root");
  let line: Record<string, unknown>;
  let code: number;
  try {
    const r = foldTree(root, home);
    code = r.wal_unfolded > 0 ? 64 : 0;
    writeJsonAtomic(join(home, ...FOLD_FILE.split("/")), { schema: FOLD_SCHEMA, run_id: runId, ...r, at: new Date().toISOString() });
    line = { status: code === 0 ? "folded" : "refused", ...(code ? { reason: "wal_unfolded" } : {}), ...r };
  } catch {
    code = 1;
    line = { status: "error", reason: "fold_failed" };
  }
  console.log(JSON.stringify(line));
  process.exit(code);
}
