/**
 * DATA-314 B1-fix F2: a stale lock that cannot be removed must end the wait,
 * the deadline holds on every iteration, and every iteration yields so the
 * trigger's own hard stop can fire. Each case runs in a child process the
 * parent kills after a few seconds: a wait that spins without yielding cannot
 * be stopped from inside its own process (that was the bug).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LockStuck, acquireStateLock, lockPathFor, tryAcquireLock } from "../state-lock";

const CHILD = join(import.meta.dir, "fixtures", "lock-wait-child.ts");
const KILL_AFTER_MS = 6_000;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

let home: string;
let stateFile: string;
const old = new Date(Date.now() - 3_600_000);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-state-lock-"));
  mkdirSync(join(home, "memory"), { recursive: true });
  stateFile = join(home, "memory", "heartbeat-state.json");
});

afterEach(() => {
  try {
    chmodSync(join(home, "memory"), 0o755);
  } catch {
    // already gone
  }
  rmSync(home, { recursive: true, force: true });
});

/** Run the child; resolve with its one-word output, or `killed` when it had to be killed. */
async function child(mode: string, hardStopMs = 4_000): Promise<{ out: string; ms: number }> {
  const started = Date.now();
  const proc = Bun.spawn(["bun", CHILD, stateFile, mode, String(hardStopMs)], { stdout: "pipe", stderr: "ignore" });
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    proc.kill(9);
  }, KILL_AFTER_MS);
  await proc.exited;
  clearTimeout(timer);
  const out = (await new Response(proc.stdout).text()).trim();
  return { out: killed ? "killed" : out, ms: Date.now() - started };
}

function oldDirectoryLock(): void {
  mkdirSync(lockPathFor(stateFile));
  utimesSync(lockPathFor(stateFile), old, old);
}

describe("a stale lock that cannot be removed ends the wait", () => {
  test("the lock path is an old directory: LockStuck at once, not a spin", async () => {
    oldDirectoryLock();
    const { out, ms } = await child("wait");
    expect(out).toBe("LockStuck");
    expect(ms).toBeLessThan(KILL_AFTER_MS);
  }, 10_000);

  test.skipIf(isRoot)("an old lock file in a directory the trigger cannot write: LockStuck", async () => {
    writeFileSync(lockPathFor(stateFile), JSON.stringify({ token: "dead", pid: 1, at: old.toISOString() }));
    utimesSync(lockPathFor(stateFile), old, old);
    chmodSync(join(home, "memory"), 0o555);
    const { out } = await child("wait");
    expect(out).toBe("LockStuck");
  }, 10_000);

  test("the trigger stays silent with a code for it", async () => {
    oldDirectoryLock();
    expect((await child("proactive")).out).toBe("state-lock-stuck");
  }, 10_000);
});

describe("the wait always yields and always has a deadline", () => {
  test("stale locks that keep coming back: the hard-stop timer still fires", async () => {
    expect((await child("racing", 300)).out).toBe("hard-stop");
  }, 10_000);

  test("stale locks that keep coming back: the deadline still ends the wait", async () => {
    expect((await child("racing-short")).out).toBe("LockTimeout");
  }, 10_000);

  test("a removable stale lock is still taken over, and a free lock taken at once", async () => {
    writeFileSync(lockPathFor(stateFile), JSON.stringify({ token: "dead", pid: 1, at: old.toISOString() }));
    utimesSync(lockPathFor(stateFile), old, old);
    const lock = await acquireStateLock(stateFile, { waitMs: 50, pollMs: 5 });
    lock.release();
    const again = await acquireStateLock(stateFile, { waitMs: 50, pollMs: 5 });
    again.release();
  });
});

describe("tryAcquireLock: the same lock file and stale rule, answered at once (install/jobs.ts)", () => {
  test("free: taken; held: null at once, the holder's file untouched; released: free again", () => {
    const path = join(home, "av-events", "jobs.lock");
    const first = tryAcquireLock(path);
    expect(first).not.toBeNull();
    const started = Date.now();
    expect(tryAcquireLock(path)).toBeNull();
    expect(Date.now() - started).toBeLessThan(100);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(first!.token);
    first!.release();
    expect(existsSync(path)).toBe(false);
    const second = tryAcquireLock(path);
    expect(second).not.toBeNull();
    second!.release();
  });

  test("a stale lock (old, or dated in the future) is taken over; one that cannot be removed throws LockStuck", () => {
    const path = join(home, "av-events", "jobs.lock");
    mkdirSync(join(home, "av-events"), { recursive: true });
    for (const when of [old, new Date(Date.now() + 3_600_000)]) {
      writeFileSync(path, JSON.stringify({ token: "dead", pid: 1 }));
      utimesSync(path, when, when);
      const lock = tryAcquireLock(path);
      expect(lock).not.toBeNull();
      lock!.release();
    }
    mkdirSync(path);
    utimesSync(path, old, old);
    expect(() => tryAcquireLock(path)).toThrow(LockStuck);
  });
});
