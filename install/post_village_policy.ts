#!/usr/bin/env bun
/** Explicit operator entry point. It edits policy only; it never creates, resumes or runs a job. */
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { acquireStateLock } from "../skills/index-network/scripts/state-lock";
import { isPostVillageKey, parsePostVillagePolicy, POST_VILLAGE_KEYS, postVillageAllowed, postVillagePolicyPath, readPostVillagePolicy, type PostVillageKey } from "../skills/index-network/scripts/post-village-policy";

export async function setPostVillageOptIn(home: string, key: PostVillageKey, enabled: boolean): Promise<void> {
  if (!isPostVillageKey(key) || typeof enabled !== "boolean") throw new Error("invalid-arguments");
  const dir = join(home, "av-events");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("policy-invalid");
  const path = postVillagePolicyPath(home);
  const lock = await acquireStateLock(path);
  let temp: string | undefined;
  try {
    const previous = readPostVillagePolicy(home);
    if (previous.status === "invalid") throw new Error("policy-invalid");
    const keys = new Set(previous.status === "ok" ? previous.policy.enabled : []);
    if (enabled) keys.add(key); else keys.delete(key);
    const body = JSON.stringify({ version: 1, enabled: POST_VILLAGE_KEYS.filter((job) => keys.has(job)) }) + "\n";
    parsePostVillagePolicy(body);
    temp = path + ".tmp-" + randomBytes(12).toString("hex");
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    temp = undefined;
  } finally {
    if (temp) { try { unlinkSync(temp); } catch { /* publication failed; preserve prior policy */ } }
    lock.release();
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--home", "--job", "--enabled"].includes(args[i]!) || fields.has(args[i]!) || !args[i + 1]) return 2;
    fields.set(args[i]!, args[i + 1]!);
  }
  const home = fields.get("--home");
  if (!home || (command !== "status" && command !== "set")) return 2;
  try {
    if (command === "set") {
      const key = fields.get("--job");
      const enabled = fields.get("--enabled");
      if (!isPostVillageKey(key) || !["true", "false"].includes(enabled ?? "")) return 2;
      await setPostVillageOptIn(home, key, enabled === "true");
    } else if (fields.has("--job") || fields.has("--enabled")) return 2;
    const read = readPostVillagePolicy(home);
    console.log(JSON.stringify({ policy: read.status, jobs: POST_VILLAGE_KEYS.map((key) => ({ key, allowed: postVillageAllowed(home, key), reason: postVillageAllowed(home, key) ? "policy-allows-existing-gates-still-required" : "post-village-disabled" })) }));
    return read.status === "invalid" ? 2 : 0;
  } catch {
    console.error("post-village-policy: update-failed");
    return 2;
  }
}
if (import.meta.main) process.exitCode = await main();
