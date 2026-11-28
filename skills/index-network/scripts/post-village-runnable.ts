/** Pure proof of the shipped Index entrypoint/shape. No policy or hold mutation. */
import { createHash } from "node:crypto";
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pins from "./post-village-runnable-pins.json";
function hash(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }
function bytes(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const meta = fstatSync(fd); if (!meta.isFile() || meta.size > 2 * 1024 * 1024) throw new Error("unsafe"); return readFileSync(fd); } finally { closeSync(fd); }
}
export function indexRunnableShapeVerified(home: string, job: Record<string, unknown>): boolean {
  try {
    if (typeof job.name !== "string" || !Object.hasOwn(pins.jobs, job.name)) return false;
    const expected = pins.jobs[job.name as keyof typeof pins.jobs];
    if (job.script !== expected.script || typeof job.prompt !== "string" || hash(job.prompt.trimEnd()) !== expected.promptSha256 || Boolean(job.no_agent) !== expected.noAgent || job.failure_deliver !== expected.failureDeliver) return false;
    for (const [relative, digest] of Object.entries(pins.files)) if (hash(bytes(join(home, relative))) !== digest) return false;
    return hash(bytes(join(home, "scripts", expected.script))) === expected.scriptSha256;
  } catch { return false; }
}
