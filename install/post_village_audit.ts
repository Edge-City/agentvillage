import { indexRunnableShapeVerified } from "../skills/index-network/scripts/post-village-runnable";
/** Read-only covered-job audit. It proves no tenant runtime, remote repeat state, or AGENTS load. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { INDIA_END_MS, POST_VILLAGE_JOB_NAMES, postVillageKeyForJob, postVillageRuntimeAllowed, type PostVillageKey } from "../skills/index-network/scripts/post-village-policy";
import { HERMES_JOB_ID_RE, MAX_JOBS_STORE_BYTES, readJobsStore, storedJobEnabled } from "../skills/index-network/scripts/message-labels";
import { validateProjection, zzzParticipation, zzzAutonomyParticipation } from "./install_miniapps";
import { verifyZzzManagedJob } from "./zzz_managed_job";
import { verifyAutonomyJob } from "./zzz_autonomy_job";
export type PostVillageAudit = { status: "verified" | "unverified"; pausedKeys: PostVillageKey[]; absentKeys: PostVillageKey[]; operatorAllowedKeys: PostVillageKey[]; reasons: string[] };
const CRON_KEYS = Object.keys(POST_VILLAGE_JOB_NAMES) as PostVillageKey[];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
function validPauseTimestamp(value: unknown): boolean {
  if (typeof value !== "string" || !ISO.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const date = value.slice(0, 10), hour = Number(value.slice(11, 13)), minute = Number(value.slice(14, 16)), second = Number(value.slice(17, 19));
  if (Number(value.slice(0, 4)) < 1 || hour > 23 || minute > 59 || second > 59) return false;
  try { return new Date(date + "T00:00:00Z").toISOString().slice(0, 10) === date; } catch { return false; }
}
function safelyPaused(job: Record<string, unknown>): boolean {
  if (job.enabled === false) return true;
  if (job.state !== undefined && typeof job.state !== "string") return false;
  if (job.paused_at != null && job.paused_at !== "" && !validPauseTimestamp(job.paused_at)) return false;
  return !storedJobEnabled(job);
}
function directorySafe(path: string): boolean {
  const meta = lstatSync(path); return meta.isDirectory() && !meta.isSymbolicLink();
}
function plainText(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const meta = fstatSync(fd); if (!meta.isFile() || meta.size > limit) throw new Error("unsafe"); return readFileSync(fd, "utf8"); } finally { closeSync(fd); }
}
function plainJson(path: string, limit: number): unknown { return JSON.parse(plainText(path, limit)); }
function installedMatches(home: string, relative: string): boolean {
  return plainText(join(home, relative), 2 * 1024 * 1024) === plainText(join(import.meta.dir, "..", relative), 2 * 1024 * 1024);
}
export function postVillageRunnableGatesVerified(home: string, key: PostVillageKey, job: Record<string, unknown>, now: Date): boolean {
  if (!postVillageRuntimeAllowed(home, key, now)) return false;
  try {
    if (key === "zzz_pairs" || key === "zzz_event_autonomy") {
      if (!installedMatches(home, "plugins/village-bridge/_post_village_policy.py")) return false;
      const projection = validateProjection(plainJson(join(home, "mini-apps.json"), 65536));
      if (key === "zzz_pairs") {
        if (!zzzParticipation(projection)) return false;
        verifyZzzManagedJob(home, true, readFileSync(join(import.meta.dir, "../skills/zzzbot/scripts/zzz_managed_runner.py")));
      } else {
        if (!zzzAutonomyParticipation(projection)) return false;
        verifyAutonomyJob(home, true, readFileSync(join(import.meta.dir, "../skills/zzzbot/scripts/zzz_autonomy_runner.py")));
      }
      return true;
    }
    return indexRunnableShapeVerified(home, job);
  } catch { return false; }
}
export function auditPostVillageJobs(home: string, now: Date = new Date()): PostVillageAudit {
  const paused = new Set<PostVillageKey>(), allowed = new Set<PostVillageKey>(), seen = new Set<PostVillageKey>();
  const reasons = new Set<string>();
  const badKeys = new Set<PostVillageKey>();
  let storeKnown = false;
  const result = (): PostVillageAudit => ({ status: reasons.size ? "unverified" : "verified", pausedKeys: [...paused].filter((key) => !badKeys.has(key)), absentKeys: storeKnown ? CRON_KEYS.filter((key) => !seen.has(key)) : [], operatorAllowedKeys: [...allowed].filter((key) => !badKeys.has(key)), reasons: [...reasons] });
  if (!Number.isFinite(now.getTime())) { reasons.add("clock-invalid"); return result(); }
  if (now.getTime() < INDIA_END_MS) return { status: "verified", pausedKeys: [], absentKeys: [], operatorAllowedKeys: [], reasons: [] };
  try {
    if (!directorySafe(home)) throw new Error("unsafe");
    try { if (!directorySafe(join(home, "cron"))) throw new Error("unsafe"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { storeKnown = true; return result(); } throw error; }
    try {
      const meta = lstatSync(join(home, "cron/jobs.json"));
      if (!meta.isFile() || meta.isSymbolicLink() || meta.size > MAX_JOBS_STORE_BYTES) throw new Error("unsafe");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { storeKnown = true; return result(); } throw error; }
    const store = readJobsStore(home);
    if ("unreadable" in store) throw new Error("unsafe");
    storeKnown = true;
    for (const value of store.jobs) {
      if (!value || typeof value !== "object" || Array.isArray(value)) { reasons.add("job-row-invalid"); storeKnown = false; continue; }
      const job = value as Record<string, unknown>;
      if (typeof job.name !== "string" || typeof job.id !== "string" || !HERMES_JOB_ID_RE.test(job.id)) { reasons.add("job-row-invalid"); storeKnown = false; continue; }
      const key = postVillageKeyForJob(job.name); if (!key) continue;
      seen.add(key);
      if (safelyPaused(job)) paused.add(key);
      else if (postVillageRuntimeAllowed(home, key, now)) {
        if (postVillageRunnableGatesVerified(home, key, job, now)) allowed.add(key); else { reasons.add("operator-allowed-existing-gates-unverified"); badKeys.add(key); }
      }
      else { reasons.add("off-job-not-paused"); badKeys.add(key); }
    }
  } catch { reasons.add("jobs-store-unreadable"); }
  return result();
}
