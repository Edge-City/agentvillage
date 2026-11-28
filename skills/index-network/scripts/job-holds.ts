/** Shared read-only resident/admin hold semantics. */
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import { HERMES_JOB_ID_RE, HOLDS_MAX_BYTES, type HoldBy, type HoldState, isHoldAt, isHoldBy, isHoldState, jobHoldsPath } from "./message-labels";
function isPlainObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
/** One job's hold as read: a hold without `by` is an admin's; one without `at` has no time. */
export interface Hold {
  state: HoldState;
  at?: string;
  by?: HoldBy;
}

export type HoldsRead = { status: "ok"; holds: Map<string, Hold> } | { status: "unreadable" };

const UNREADABLE: HoldsRead = Object.freeze({ status: "unreadable" });

/**
 * The holds in the file's text, with the control plane's readers' rules
 * (job-control.js parseHolds, parseHoldTimes, parseHoldBy): empty text is no
 * holds; text that is not JSON, or not a JSON object, is unreadable. Only
 * entries whose id has Hermes's shape and whose state is `paused` or `active`
 * are kept (the control plane's id grammar is wider, but an id of any other
 * shape names no Hermes job, so dropping it changes nothing it acts on). Each
 * kept entry keeps its `at` when that is an ISO time, and its `by` when that
 * is one of HOLD_BY_WORDS. Everything else is dropped.
 */
export function parseHolds(text: string): HoldsRead {
  const trimmed = text.trim();
  if (!trimmed) return { status: "ok", holds: new Map() };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return UNREADABLE;
  }
  if (!isPlainObject(data)) return UNREADABLE;
  const states = isPlainObject(data.holds) ? data.holds : {};
  const times = isPlainObject(data.at) ? data.at : {};
  const placers = isPlainObject(data.by) ? data.by : {};
  const holds = new Map<string, Hold>();
  for (const [id, state] of Object.entries(states)) {
    if (!HERMES_JOB_ID_RE.test(id) || !isHoldState(state)) continue;
    const hold: Hold = { state };
    const at = Object.hasOwn(times, id) ? times[id] : undefined;
    if (isHoldAt(at)) hold.at = at;
    const by = Object.hasOwn(placers, id) ? placers[id] : undefined;
    if (isHoldBy(by)) hold.by = by;
    holds.set(id, hold);
  }
  return { status: "ok", holds };
}

/**
 * The holds file, read as the control plane reads it (job-control.js
 * READ_HOLDS_CMD, `head -c 65536`, then parseHolds): its first
 * HOLDS_MAX_BYTES bytes, decoded as UTF-8 with replacement characters, then
 * parsed. A longer file is not unreadable by itself: its prefix is what is
 * parsed. Missing is no holds. A path that is not a regular file, a failed
 * read, or a prefix that is not a JSON object is unreadable.
 */
export function readHolds(home: string): HoldsRead {
  const path = jobHoldsPath(home);
  try {
    // Checked before the open, so a FIFO or a directory is never opened.
    if (!statSync(path).isFile()) return UNREADABLE;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { status: "ok", holds: new Map() } : UNREADABLE;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return UNREADABLE;
  }
  try {
    if (!fstatSync(fd).isFile()) return UNREADABLE;
    const buffer = Buffer.alloc(HOLDS_MAX_BYTES);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return parseHolds(buffer.toString("utf8", 0, length));
  } catch {
    return UNREADABLE;
  } finally {
    closeSync(fd);
  }
}

