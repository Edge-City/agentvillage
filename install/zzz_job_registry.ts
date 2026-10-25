/** The ZZZ cron's narrow provenance marker in av-events/installed_jobs.json. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HERMES_JOB_ID_RE, installedJobsPath } from "../skills/index-network/scripts/message-labels";

export const ZZZ_JOB_NAME = "Edge — zzz pairs";
export const ZZZ_JOB_SCRIPT = "zzz_managed_runner.py";
const TOOLSETS = ["village", "no_mcp"];

type Registry = { ids: string[]; zzzJobId?: string };
const emptyJobField = (value: unknown): boolean => value == null || value === ""
  || (Array.isArray(value) && value.length === 0);

/** Only the job shape confirmed by the ZZZ installer can acquire a name. */
export function isExactZzzManagedJob(value: unknown): value is { id: string } {
  if (!value || typeof value !== "object") return false;
  const job = value as Record<string, unknown>;
  return typeof job.id === "string" && HERMES_JOB_ID_RE.test(job.id)
    && job.name === ZZZ_JOB_NAME && job.script === ZZZ_JOB_SCRIPT
    && job.enabled === true && job.no_agent === true && !job.workdir
    && JSON.stringify(job.enabled_toolsets) === JSON.stringify(TOOLSETS)
    && job.deliver === "local" && job.failure_deliver === "local"
    && typeof job.schedule === "object" && job.schedule !== null
    && (job.schedule as { kind?: unknown; expr?: unknown }).kind === "cron"
    && (job.schedule as { expr?: unknown }).expr === "*/10 * * * *"
    && typeof job.repeat === "object" && job.repeat !== null
    && (job.repeat as { times?: unknown }).times === null
    && emptyJobField(job.skills) && emptyJobField(job.skill) && emptyJobField(job.context_from)
    && !job.monitor_script && !job.monitor_url;
}

export function readJobRegistry(home: string): Registry {
  const path = installedJobsPath(home);
  if (!existsSync(path)) return { ids: [] };
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!data || typeof data !== "object") throw new Error("zzz_registry_invalid");
  const record = data as Record<string, unknown>;
  // Older Index registries and some test fixtures contain non-Hermes IDs;
  // av-events filters those on read. Keep them untouched on a ZZZ update.
  if (!Array.isArray(record.ids) || !record.ids.every((id) => typeof id === "string"))
    throw new Error("zzz_registry_invalid");
  if (record.zzzJobId !== undefined && (typeof record.zzzJobId !== "string" || !HERMES_JOB_ID_RE.test(record.zzzJobId)))
    throw new Error("zzz_registry_invalid");
  return { ids: record.ids, ...(record.zzzJobId ? { zzzJobId: record.zzzJobId } : {}) };
}

export function writeJobRegistry(home: string, record: Registry): void {
  const dir = join(home, "av-events");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = installedJobsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ids: [...new Set(record.ids)].sort(), ...(record.zzzJobId ? { zzzJobId: record.zzzJobId } : {}) })}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Call after Hermes confirms install/removal; preserve all unrelated recorded IDs. */
export function syncZzzInstalledJobId(home: string, id: string | null): void {
  if (id === null && !existsSync(installedJobsPath(home))) return;
  if (id !== null) {
    if (!HERMES_JOB_ID_RE.test(id)) throw new Error("zzz_job_invalid");
    const path = join(home, "cron", "jobs.json");
    const store: unknown = JSON.parse(readFileSync(path, "utf8"));
    const jobs = store && typeof store === "object" ? (store as { jobs?: unknown }).jobs : undefined;
    if (!Array.isArray(jobs) || jobs.filter((job) => job && typeof job === "object" && (job as { name?: unknown }).name === ZZZ_JOB_NAME).length !== 1
        || !jobs.some((job) => isExactZzzManagedJob(job) && job.id === id)) throw new Error("zzz_job_not_confirmed");
  }
  const current = readJobRegistry(home);
  const ids = current.ids.filter((existing) => existing !== current.zzzJobId);
  if (id !== null) ids.push(id);
  writeJobRegistry(home, { ids, ...(id !== null ? { zzzJobId: id } : {}) });
}
