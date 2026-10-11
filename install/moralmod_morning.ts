/** Patch only the pinned plugin's owned morning adapter. Hermes remains the timer owner. */
import { randomUUID } from "node:crypto";
import { readFileSync, lstatSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INDEX_PLUGIN_REVISION } from "./moralmod_release";
const preference = `    prefs = user.get("notificationPreferences")
    if not isinstance(prefs, dict):
        return False
    return prefs.get("morningBrief") is True`;
const opted = `    prefs = user.get("notificationPreferences")
    if prefs is None:
        return True
    if not isinstance(prefs, dict):
        return False
    value = prefs.get("morningBrief")
    return value is None or value is True`;
const prior = `    if jobs:
        return`;
const reconciled = `    if jobs:
        for extra in jobs[1:]:
            remove_job(extra["id"])
        job = jobs[0]
        if job.get("schedule_display") != SCHEDULE:
            update_job(job["id"], {"schedule": SCHEDULE})
        return`;
export function morningSource(pinned: string): string {
  for(const anchor of [preference, prior, 'SCHEDULE = "0 8 * * *"', 'from cron.jobs import create_job, list_jobs, remove_job'])
    if(pinned.split(anchor).length !== 2) throw Error("Pinned morning adapter differs");
  return pinned.replace(preference,opted).replace(prior,reconciled)
    .replace('SCHEDULE = "0 8 * * *"','SCHEDULE = "*/5 * * * *"  # local-day/due/once authority is in the callback')
    .replace('from cron.jobs import create_job, list_jobs, remove_job','from cron.jobs import create_job, list_jobs, remove_job, update_job')
    .replace('Missing means off.','Missing means on; unreadable preferences hold.')
    .replace('only when the account has turned the morning brief on.','unless the account has explicitly turned the morning brief off.');
}
export function installMorning(home: string): void {
  const plugin=join(home,"plugins/index-network"), path=join(plugin,"morning.py");
  const head=Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:plugin});
  if(head.exitCode || head.stdout.toString().trim()!==INDEX_PLUGIN_REVISION) throw Error("Morning plugin revision differs");
  const original=Bun.spawnSync(["git","show","HEAD:morning.py"],{cwd:plugin});
  if(original.exitCode) throw Error("Pinned morning adapter missing");
  const stat=lstatSync(path);
  if(!stat.isFile() || stat.isSymbolicLink()) throw Error("Morning adapter must be a regular file");
  const base=original.stdout.toString(), wanted=morningSource(base), current=readFileSync(path,"utf8");
  if(current===wanted) return;
  if(current!==base) throw Error("Unowned morning adapter changed");
  const temp=path+`.av-morning-${process.pid}.tmp`;
  writeFileSync(temp,wanted,{flag:"wx",mode:stat.mode & 0o777});
  renameSync(temp,path);
  if(readFileSync(path,"utf8")!==wanted) throw Error("Morning adapter verification failed");
}
/**
 * ov#284 refute M1, M2: put the plugin's own `morning.py` back when the file is exactly the managed
 * rewrite of it (`morningSource` of the checkout's `HEAD:morning.py`, the checkout at
 * `INDEX_PLUGIN_REVISION`). Decided on the file's own bytes, never on a loader hash, so it works after
 * the loader is already gone. `unmanaged` (left as it is): any other content, no checkout at the
 * pin, a link or no file; `failed`: the managed rewrite is there and could not be replaced.
 */
export function restoreMorning(home: string): "restored" | "unmanaged" | "failed" {
  const plugin=join(home,"plugins/index-network"), path=join(plugin,"morning.py");
  let base: string, mode: number;
  try {
    const stat=lstatSync(path);
    if(!stat.isFile()) return "unmanaged";
    const head=Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:plugin});
    if(head.exitCode || head.stdout.toString().trim()!==INDEX_PLUGIN_REVISION) return "unmanaged";
    const original=Bun.spawnSync(["git","show","HEAD:morning.py"],{cwd:plugin});
    if(original.exitCode) return "unmanaged";
    base=original.stdout.toString();
    if(readFileSync(path,"utf8")!==morningSource(base)) return "unmanaged";
    mode=stat.mode & 0o777;
  } catch {
    return "unmanaged";
  }
  const temp=path+`.av-morning-${randomUUID()}.tmp`;
  try {
    writeFileSync(temp,base,{flag:"wx",mode});
    renameSync(temp,path);
    return readFileSync(path,"utf8")===base ? "restored" : "failed";
  } catch {
    try { rmSync(temp,{force:true}); } catch { /* the word below already says it */ }
    return "failed";
  }
}
