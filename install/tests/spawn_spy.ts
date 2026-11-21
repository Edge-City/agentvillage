/**
 * Test-only preload (`bun --preload install/tests/spawn_spy.ts ...`): appends one line to $SPAWN_LOG for every child
 * process the helper starts (node:child_process and Bun.spawn*), then runs it. ESM named imports see the patched
 * functions, so a gate-off stage that spawns nothing leaves no log at all.
 */
import { appendFileSync } from "node:fs";

const log = process.env.SPAWN_LOG;
if (!log) throw new Error("spawn_spy: SPAWN_LOG unset");
const note = (name: string, what: unknown) => appendFileSync(log, `${name} ${JSON.stringify(Array.isArray(what) ? what[0] : what)}\n`);
const cp = require("node:child_process");
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const real = cp[name];
  cp[name] = (...args: unknown[]) => { note(name, args[0]); return real(...args); };
}
const bun = Bun as unknown as Record<string, (...args: unknown[]) => unknown>;
for (const name of ["spawn", "spawnSync"]) {
  const real = bun[name];
  bun[name] = (...args: unknown[]) => { note(`Bun.${name}`, args[0]); return real(...args); };
}
