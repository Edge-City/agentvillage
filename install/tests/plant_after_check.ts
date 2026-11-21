/**
 * v2.1.20 test seam for the zzz job shims' check-then-write window: wraps node:fs lstatSync (live bindings, so the
 * installer modules see it) so that the FIRST lstat of `path` (the installer's refusal check) runs normally, and right
 * after it a symlink to `outside` is planted at `path`, as a racing resident would. node:fs is restored afterwards.
 */
import { mock } from "bun:test";
import * as fs from "node:fs";

const real = { ...fs };

export function withSymlinkPlantedAfterCheck<T>(path: string, outside: string, run: () => T): { result: T; planted: boolean } {
  let planted = false;
  mock.module("node:fs", () => ({
    ...real,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (planted || args[0] !== path) return real.lstatSync(...args);
      try { return real.lstatSync(...args); } finally { planted = true; real.symlinkSync(outside, path); }
    },
  }));
  try { return { result: run(), planted }; } finally { mock.module("node:fs", () => real); }
}
