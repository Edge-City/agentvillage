/**
 * Child process for state-lock.test.ts (DATA-314 B1-fix F2): runs one lock
 * wait the way the trigger does, with a hard-stop timer beside it, and prints
 * one word: `acquired`, the error's class name, or `hard-stop` when the timer
 * fired first. A wait that spins without yielding prints nothing and is killed
 * by the parent.
 *
 *   bun lock-wait-child.ts <stateFile> <mode> [hardStopMs]
 *
 * mode: `wait` (a plain 60 s wait), `racing` (a writer leaves a fresh stale
 * lock before every attempt; 10 min wait), `racing-short` (the same, 50 ms
 * wait), `proactive` (a whole brief trigger run; prints its reason).
 */
import { existsSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { runProactive } from "../../proactive";
import { acquireStateLock, lockPathFor } from "../../state-lock";

const [stateFile, mode, hardStopArg] = process.argv.slice(2);
const hardStopMs = Number(hardStopArg ?? "4000");
setTimeout(() => {
  process.stdout.write("hard-stop\n", () => process.exit(0));
}, hardStopMs);

const lock = lockPathFor(stateFile!);
const old = new Date(Date.now() - 3_600_000);
/** A clock that, like a racing writer, leaves a stale lock behind each time it is read. */
const racingNow = () => {
  if (!existsSync(lock)) {
    writeFileSync(lock, JSON.stringify({ token: "dead", pid: 1, at: old.toISOString() }));
    utimesSync(lock, old, old);
  }
  return Date.now();
};

try {
  if (mode === "proactive") {
    const result = await runProactive("brief", {
      home: dirname(dirname(stateFile!)),
      now: () => new Date("2026-10-12T02:30:00Z"),
      lock: { waitMs: 60_000 },
      buildContext: async () => {
        throw new Error("must not run");
      },
      approvals: () => 0,
    });
    process.stdout.write(`${result.reason}\n`, () => process.exit(0));
  } else {
    const options =
      mode === "racing" ? { waitMs: 600_000, now: racingNow }
      : mode === "racing-short" ? { waitMs: 50, now: racingNow }
      : { waitMs: 60_000 };
    const held = await acquireStateLock(stateFile!, options);
    held.release();
    process.stdout.write("acquired\n", () => process.exit(0));
  }
} catch (err) {
  process.stdout.write(`${err instanceof Error ? err.name : "unknown"}\n`, () => process.exit(0));
}
