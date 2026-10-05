/**
 * The morning brief's reminder line (carried from DATA-222, PR #183, into
 * DATA-314 brief-lite): how many things the agent proposed to share are still
 * waiting for the resident's yes or no in their approvals. A count only.
 *
 * 0 (and no process spawned) unless `AV_RECORD_INTENTION` and the approval
 * path (`AV_APPROVAL_ENABLED`, `AV_APPROVAL_URL`) are on. The count comes
 * from the av-events plugin's own read-only reader
 * (`$HERMES_HOME/plugins/av-events/_brief_items.py`), run once with Hermes's
 * Python; this module never reads the plugin's map. Anything that fails
 * counts as 0: the brief goes out without the line.
 */

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { envOrDotenv } from "./proactive-text";

export const READER_RELATIVE_PATH = join("plugins", "av-events", "_brief_items.py");
export const READER_TIMEOUT_MS = 10_000;
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Runs the reader and returns its stdout; throws when it cannot. */
export type ReaderRunner = (home: string) => string;

export function approvalSwitchesOn(home: string): boolean {
  return TRUTHY.has(envOrDotenv("AV_RECORD_INTENTION", home).toLowerCase())
    && TRUTHY.has(envOrDotenv("AV_APPROVAL_ENABLED", home).toLowerCase())
    && envOrDotenv("AV_APPROVAL_URL", home).length > 0;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Hermes's interpreter: `HERMES_PYTHON`, the venv beside `HERMES_BIN`, Hermes's known venv, else `python3`. */
export function hermesPython(): string {
  const fromEnv = process.env.HERMES_PYTHON?.trim();
  if (fromEnv) return fromEnv;
  const bin = process.env.HERMES_BIN?.trim();
  for (const candidate of [bin && isAbsolute(bin) ? join(dirname(bin), "python") : "", "/opt/hermes/.venv/bin/python"]) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  return "python3";
}

export const runPluginReader: ReaderRunner = (home) => {
  const reader = join(home, READER_RELATIVE_PATH);
  if (!existsSync(reader)) throw new Error("reader-missing");
  const result = spawnSync(hermesPython(), ["-I", "-B", reader], {
    env: { ...process.env, HERMES_HOME: home },
    timeout: READER_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  if (result.error || result.status !== 0) throw new Error("reader-failed");
  return String(result.stdout);
};

/** The reader's held count, or 0 when it is off, failed, or answered in any other shape. */
export function parseHeldCount(raw: string): number {
  try {
    const parsed = JSON.parse(raw.trim()) as { v?: unknown; status?: unknown; heldCount?: unknown };
    const count = parsed.heldCount;
    if (parsed.v !== 1 || parsed.status !== "ok") return 0;
    return typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 10_000 ? count : 0;
  } catch {
    return 0;
  }
}

/** How many proposals wait for the resident's answer. Never throws. */
export function approvalsWaiting(home: string, reader: ReaderRunner = runPluginReader): number {
  if (!approvalSwitchesOn(home)) return 0;
  try {
    return parseHeldCount(reader(home));
  } catch {
    return 0;
  }
}
