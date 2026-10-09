/**
 * `$HERMES_HOME/av-events/install-status.json`: what the last install left
 * undone, written on every run so a stale failure never outlives a clean run
 * (B1-fix2 R1). The install exits 0 when the only problem is Index cron jobs
 * that failed to update; this file and one fixed stdout line are how that is
 * reported. The control plane reads it as a report only, never failing an update for it.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const INSTALL_STATUS_VERSION = 1;

export interface InstallStatus {
  version: number;
  /** UTC ISO time of the run. */
  at: string;
  /** Names of the Index cron jobs this run failed to update; empty when none did. */
  cron_failed: string[];
}

export function installStatusPath(home: string): string {
  return join(home, "av-events", "install-status.json");
}

/** The one stdout line printed when any cron job failed: the count only. */
export function cronFailedLine(count: number): string {
  return `agentvillage-install: cron_failed=${count}`;
}

/** Write the status file atomically (temp file and rename), mode 0600, its directory 0700. */
export function writeInstallStatus(home: string, cronFailed: string[], at: Date = new Date()): InstallStatus {
  const status: InstallStatus = { version: INSTALL_STATUS_VERSION, at: at.toISOString(), cron_failed: [...cronFailed] };
  const path = installStatusPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(status)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return status;
}
