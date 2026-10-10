/** Patch only the pinned plugin's owned morning adapter. Hermes remains the timer owner. */
import { readFileSync, lstatSync, writeFileSync, renameSync } from "node:fs";
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
