/**
 * An exclusive lock around `memory/heartbeat-state.json` for the proactive
 * triggers (DATA-314). Hermes runs missed jobs on wake (catch-up) and runs
 * jobs in parallel, so two triggers can read-modify-write the state file at
 * the same time; the lock serialises them.
 *
 * The lock is a file created with O_EXCL next to the state file, holding a
 * random token, the pid and the time. Release removes it only when the token
 * is still ours. A lock older than `staleMs` is taken over: its holder was
 * killed (Hermes kills a pre-run script at `cron.script_timeout_seconds`) and
 * can no longer write. Waiting polls; it gives up after `waitMs` and the
 * caller stays silent for that run.
 *
 * Only these triggers take the lock. The memory signal sync's model still
 * writes the file itself (phase 3 moves that write into its gate).
 */

import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export interface LockOptions {
  /** How long to wait for a held lock before giving up. */
  waitMs?: number;
  /** A lock file older than this is taken over. Above the script timeout (120 s). */
  staleMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** Clock, for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export const LOCK_WAIT_MS = 60_000;
export const LOCK_STALE_MS = 150_000;

export interface HeldLock {
  path: string;
  token: string;
  release(): void;
}

export class LockTimeout extends Error {
  constructor() {
    super("state-locked");
    this.name = "LockTimeout";
  }
}

/** Locks this process holds, so an emergency exit can release them (releaseHeldLocks). */
const held = new Set<HeldLock>();

/** Release every lock this process holds (the hard stop calls it before exiting). */
export function releaseHeldLocks(): void {
  for (const lock of [...held]) lock.release();
}

export function lockPathFor(stateFile: string): string {
  return `${stateFile}.lock`;
}

function tryCreate(path: string, token: string, now: number): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
  try {
    writeSync(fd, JSON.stringify({ token, pid: process.pid, at: new Date(now).toISOString() }));
  } finally {
    closeSync(fd);
  }
  return true;
}

function ageMs(path: string, now: number): number | null {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function heldToken(path: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown };
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    return null;
  }
}

/** Take the lock for `stateFile`, waiting up to `waitMs`. Throws LockTimeout. */
export async function acquireStateLock(stateFile: string, options: LockOptions = {}): Promise<HeldLock> {
  const path = lockPathFor(stateFile);
  // A home without memory/ yet (a fresh tenant) is a first run, not a fault.
  mkdirSync(dirname(path), { recursive: true });
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const pollMs = options.pollMs ?? 200;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const token = randomBytes(12).toString("hex");
  const deadline = now() + waitMs;

  for (;;) {
    if (tryCreate(path, token, now())) {
      const lock: HeldLock = {
        path,
        token,
        release() {
          held.delete(lock);
          if (heldToken(path) === token) {
            try {
              unlinkSync(path);
            } catch {
              // already gone
            }
          }
        },
      };
      held.add(lock);
      return lock;
    }
    const observed = heldToken(path);
    const age = ageMs(path, now());
    // A lock dated in the future (a clock jump, or a touched file) is as dead
    // as an old one: otherwise it would block every later run forever.
    if (age !== null && (age > staleMs || age < -staleMs)) {
      // The holder is gone (killed at the script timeout). Remove only the
      // file we judged stale: a fresh lock taken meanwhile has a new token.
      if (heldToken(path) === observed) {
        try {
          unlinkSync(path);
        } catch {
          // someone else removed it
        }
      }
      continue;
    }
    if (now() >= deadline) throw new LockTimeout();
    await sleep(pollMs);
  }
}

/** Run `fn` holding the lock; the lock is released whatever `fn` does. */
export async function withStateLock<T>(stateFile: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const lock = await acquireStateLock(stateFile, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
