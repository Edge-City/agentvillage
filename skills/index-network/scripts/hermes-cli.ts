/**
 * Finding and running the Hermes CLI, shared by the installer (install/
 * re-exports these from hermes_cli.ts, install_index.ts and jobs.ts) and the
 * skill scripts that run on a box, where install/ is not present
 * (pause-job.ts).
 *
 * Hermes is only ever started as an argv (execFileSync), never through a
 * shell, and a runner kills it after its timeout.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  join(homedir(), ".local/bin/hermes"),
  "/opt/hermes/.venv/bin/hermes",
  "/usr/local/bin/hermes",
];

/** Resolve Hermes CLI (container image installs under /opt/hermes/.venv/bin). */
export function hermesBin(): string {
  const fromEnv = process.env.HERMES_BIN?.trim();
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const path of CANDIDATES) {
    if (existsSync(path)) return path;
  }
  return "hermes";
}

export function hermesExecEnv(): NodeJS.ProcessEnv {
  const bin = hermesBin();
  const binDir = bin.includes("/") ? bin.slice(0, bin.lastIndexOf("/")) : "";
  const pathParts = [
    binDir,
    "/opt/hermes/.venv/bin",
    `${process.env.HOME}/.npm/bin`,
    `${process.env.HOME}/.local/bin`,
    process.env.PATH ?? "",
  ].filter(Boolean);
  return { ...process.env, PATH: [...new Set(pathParts)].join(":") };
}

/**
 * Probe whether the Hermes CLI can actually run. `hermesBin()` falls back to the
 * bare name `"hermes"` when it finds no fixed-path binary, but that name still
 * resolves on PATH (the augmented env adds ~/.local/bin etc.). So test by
 * executing `hermes --version` rather than string-comparing the resolved name.
 */
export function hermesAvailable(bin: string, timeoutMs?: number, env: NodeJS.ProcessEnv = hermesExecEnv()): boolean {
  try {
    execFileSync(bin, ["--version"], { stdio: "ignore", env, ...(timeoutMs ? { timeout: timeoutMs, killSignal: "SIGKILL" as const } : {}) });
    return true;
  } catch {
    return false;
  }
}

/**
 * One Hermes command is killed after this: comfortably below the jobs lock's
 * stale time (state-lock.ts LOCK_STALE_MS, 150 s), so a hung CLI cannot hold
 * the lock until another command takes it over while this one may still write.
 */
export const HERMES_TIMEOUT_MS = 60_000;

/** A Hermes command killed at its timeout. */
export class HermesTimeout extends Error {
  constructor() {
    super("hermes-timeout");
    this.name = "HermesTimeout";
  }
}

/**
 * Runs Hermes commands as an argv, never through a shell, each killed
 * (SIGKILL) after `timeoutMs`: a killed command throws HermesTimeout, a
 * non-zero exit throws. Hermes's stdout is never read. Its stderr goes to
 * ours (`inherit`, install/jobs.ts) or nowhere (`ignore`, a skill script
 * whose caller reads both streams).
 */
export function hermesRunner(
  bin: string,
  env: NodeJS.ProcessEnv,
  timeoutMs = HERMES_TIMEOUT_MS,
  stderr: "inherit" | "ignore" = "inherit",
): (args: string[]) => void {
  return (args) => {
    try {
      execFileSync(bin, args, { stdio: ["ignore", "ignore", stderr], env, timeout: timeoutMs, killSignal: "SIGKILL" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new HermesTimeout();
      throw err;
    }
  };
}
