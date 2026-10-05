/**
 * Writes of `memory/heartbeat-state.json` (DATA-314): by temp file and
 * rename in the same directory, so a reader, a crash or a kill never sees
 * half a file. The file keeps its mode; a new one is 0600.
 */
import { chmodSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeStateFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    // a new file
  }
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}
