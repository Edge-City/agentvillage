#!/usr/bin/env bun
/**
 * DREAM-1 PR-1b: Index's matches already waiting for the resident, as evidence for the nightly
 * memory signal sync (memory_signal_gate.py runs this on a wake only, never to decide one).
 *
 *   bun skills/index-network/scripts/match-evidence.ts [--now <iso>]
 *
 * Reads the 02:00 prefetch, `$HERMES_HOME/av-events/proactive/brief-context.json` (runPrefetch
 * in proactive.ts writes `{date, builtAt, context}`), with readPrefetch's guards: the file
 * exists, is at most 4 MiB, parses as JSON, and its `context` is a record. It is used when its
 * `builtAt` parses and lies within MAX_AGE_MS of now (either side): the gate runs at 01:00, so
 * the newest prefetch is about 23 hours old. No network, no Index read.
 *
 * Rows: `context.opportunities`, then `context.connectionOpportunities`, one per opportunity id
 * (by name and headline when a row has none), the first MAX_ROWS. Per row, the name through
 * cleanName and Index's headline through matchFieldVerdict at MATCH_HEADLINE_MAX, the cleaner
 * and the cap the morning brief uses for the same headline (proactive.ts matchHeadline). A row
 * whose name and headline both fail is dropped.
 *
 * Output: exactly one JSON line on stdout,
 *   {"status":"ok"|"stale"|"missing"|"unreadable"|"error","listed":n,"shown":n,"withheld":n,"rows":[{"name","headline"}]}
 * `listed` is the rows read (at most MAX_ROWS), `shown` the rows output, `withheld` the
 * headlines withheld or flagged. Never an id, a URL, a summary, `mainText`, a flag or a reason.
 * No DATA-487 flag file either: the 08:00 brief flags the same headlines (matchHeadline), and a
 * second flag would count them twice. Nothing of the text is logged; stderr stays empty. Exits 0
 * in every case (an exception is status `error` with zeros).
 */

import { closeSync, fstatSync, openSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { MATCH_HEADLINE_MAX, PREFETCH_FILE, homeDir, proactiveDir } from "./proactive";
import { cleanName, matchFieldVerdict } from "./proactive-text";

/** Most rows read from the prefetch (and so shown). */
export const MAX_ROWS = 12;
/** The prefetch is used when its `builtAt` is within this of now, either side. */
export const MAX_AGE_MS = 36 * 3600 * 1000;
/** readPrefetch's size guard. */
export const MAX_PREFETCH_BYTES = 4 * 1024 * 1024;

export type MatchEvidenceStatus = "ok" | "stale" | "missing" | "unreadable" | "error";

export interface MatchEvidenceRow {
  /** cleanName of Index's name for the counterpart, or null when it did not clean. */
  name: string | null;
  /** matchFieldVerdict's text for Index's headline, or null (absent, withheld or flagged). */
  headline: string | null;
}

export interface MatchEvidence {
  status: MatchEvidenceStatus;
  listed: number;
  shown: number;
  withheld: number;
  rows: MatchEvidenceRow[];
}

const none = (status: MatchEvidenceStatus): MatchEvidence => ({ status, listed: 0, shown: 0, withheld: 0, rows: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The prefetch as a record, or the status that stops the read. */
function readPrefetchFile(home: string): Record<string, unknown> | MatchEvidenceStatus {
  const path = join(proactiveDir(home), PREFETCH_FILE);
  let fd: number;
  try {
    // A FIFO, a directory or a device is not a prefetch: never opened (a FIFO would block).
    if (!statSync(path).isFile()) return "unreadable";
    fd = openSync(path, "r");
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? "missing" : "unreadable";
  }
  try {
    // The size of the file opened, not of the path checked.
    if (fstatSync(fd).size > MAX_PREFETCH_BYTES) return "unreadable";
    const raw: unknown = JSON.parse(readFileSync(fd, "utf8"));
    return isRecord(raw) && isRecord(raw.context) ? raw : "unreadable";
  } catch {
    return "unreadable";
  } finally {
    closeSync(fd);
  }
}

function rowKey(row: Record<string, unknown>): string {
  const id = row.opportunityId;
  if (typeof id === "string" && id.trim()) return `id:${id.trim()}`;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return `nh:${JSON.stringify([text(row.name), text(row.headline)])}`;
}

/** The rows of `opportunities` then `connectionOpportunities`, one per key, the first MAX_ROWS. */
function prefetchRows(context: Record<string, unknown>): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const list of [context.opportunities, context.connectionOpportunities]) {
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (out.length >= MAX_ROWS) return out;
      if (!isRecord(row)) continue;
      const key = rowKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
    }
  }
  return out;
}

/** The matches waiting for the resident, cleaned, from the prefetch under `home`. Never throws. */
export function matchEvidence(home: string, now: Date): MatchEvidence {
  try {
    const raw = readPrefetchFile(home);
    if (typeof raw === "string") return none(raw);
    const built = typeof raw.builtAt === "string" ? Date.parse(raw.builtAt) : Number.NaN;
    if (!Number.isFinite(built) || Math.abs(now.getTime() - built) > MAX_AGE_MS) return none("stale");
    const rows = prefetchRows(raw.context as Record<string, unknown>);
    const out: MatchEvidenceRow[] = [];
    let withheld = 0;
    for (const row of rows) {
      const name = cleanName(row.name);
      const verdict = matchFieldVerdict(row.headline, MATCH_HEADLINE_MAX);
      if (verdict.flag) withheld++;
      if (name || verdict.text) out.push({ name, headline: verdict.text });
    }
    return { status: "ok", listed: rows.length, shown: out.length, withheld, rows: out };
  } catch {
    return none("error");
  }
}

/** `--now <iso>` (tests), else the clock. Anything else on the command line is an error. */
function parseNow(argv: string[]): Date | null {
  if (argv.length === 0) return new Date();
  if (argv.length !== 2 || argv[0] !== "--now") return null;
  const at = Date.parse(argv[1]);
  return Number.isFinite(at) ? new Date(at) : null;
}

export function main(argv: string[] = process.argv.slice(2)): MatchEvidence {
  const now = parseNow(argv);
  return now ? matchEvidence(homeDir(), now) : none("error");
}

if (import.meta.main) {
  // stdout is the gate's input: anything a library prints goes nowhere.
  console.log = () => {};
  console.error = () => {};
  let result: MatchEvidence;
  try {
    result = main();
  } catch {
    result = none("error");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
}
