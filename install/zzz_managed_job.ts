/** Installer-owned Hermes job for enabled zzzbot projections. No resident-created cron. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { hermesAvailable } from "../skills/index-network/scripts/hermes-cli";
import { syncZzzInstalledJobId } from "./zzz_job_registry";

export const ZZZ_JOB_NAME = "Edge — zzz pairs";
export const ZZZ_JOB_SCRIPT = "zzz_managed_runner.py";
const LEGACY_JOB_SCRIPT = "agentvillage_zzz_pairs.sh";
export const ZZZ_JOB_SCHEDULE = "*/10 * * * *";
export const ZZZ_JOB_TOOLSETS = ["village", "no_mcp"] as const;
const PROMPT = "skills/zzzbot/prompts/participate.md";
const SCRIPT = "skills/zzzbot/scripts/zzz_managed_runner.py";

type Job = { id?: unknown; name?: unknown; prompt?: unknown; script?: unknown; enabled?: unknown;
  enabled_toolsets?: unknown; no_agent?: unknown; workdir?: unknown; deliver?: unknown;
  failure_deliver?: unknown; schedule?: unknown; repeat?: unknown; skills?: unknown;
  skill?: unknown; context_from?: unknown; monitor_script?: unknown; monitor_url?: unknown };
const ID = /^[0-9a-f]{12}$/;

/**
 * ov#441 S5 + N12 (nonav OWNER CALL, pick (a)): the sha256 of every version of the installer-written managed files
 * this installer ever shipped. The runner and legacy shim are copied byte for byte from skills/zzzbot/scripts to
 * scripts/. Keep the legacy shim hash so a box running an older installer can still be torn down. Append new hashes
 * when shipped source changes; a test pins the current source hashes.
 */
export const ZZZ_SHIPPED_SHA256 = {
  shim: ["1db538dc9d5d602bfbc71bbb8da0b49b4fee0280b603f75222df94e43ef82eff"],
  runner: ["7986413386089ff3cfa6934999e949ad3cb14d3d35e4214ee9809fe19919c5e0",
    "db049dbca131fce6cd63f67d40bb15d4ead37b8f62aa159f360dc7d2814f1765",
    "ec5b5b3332891048ff1270757af105877d0e84f7d3222f5a0ec76e2b2930aa02"],
  prompt: ["f5d0d69e6af8a9076e92d31114fc7ff8ec6f99b54a0b980c7a308f5e8b7f42d2",
    "d62b2354eda4702795472a89ca163225c6c2d9979b0cdce3afa023b792a4c133"],
} as const;
export type ZzzShippedKind = keyof typeof ZZZ_SHIPPED_SHA256;
const SHIPPED_MAX_BYTES = 65536;
/**
 * Whether the object at `path` is the installer's own file: "absent" (nothing there), "ours" (a regular file, not a
 * symlink, whose bytes hash to a shipped version) or "not_ours" (anything else: a symlink, directory, FIFO, an
 * unreadable or different file). Opened with O_NOFOLLOW | O_NONBLOCK and the fd checked to be the lstat'ed file, so a
 * swap after the lstat is never followed and a FIFO never blocks. Never throws.
 */
export function zzzShippedFile(path: string, kind: ZzzShippedKind): "absent" | "ours" | "not_ours" {
  let meta;
  try { meta = lstatSync(path); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "not_ours"; }
  if (!meta.isFile() || meta.size > SHIPPED_MAX_BYTES) return "not_ours";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const open = fstatSync(fd);
    if (!open.isFile() || open.ino !== meta.ino || open.dev !== meta.dev) return "not_ours";
    const sha = createHash("sha256").update(readFileSync(fd)).digest("hex");
    return (ZZZ_SHIPPED_SHA256[kind] as readonly string[]).includes(sha) ? "ours" : "not_ours";
  } catch { return "not_ours"; } finally { if (fd !== undefined) closeSync(fd); }
}

// Hermes v2026.9.24's CLI cannot set enabled_toolsets. Its cron.jobs API is
// the same locked job store used by the cronjob tool. Create paused with the
// exact allowlist, then resume; a failure leaves the job disabled.
export const JOB_API = String.raw`
import json, sys
from cron.jobs import create_job, get_job, pause_job, resume_job, remove_job, update_job
r = json.load(sys.stdin)
if r['action'] == 'remove':
    old = get_job(r['id'])
    if not old or old.get('name') != r['name']:
        raise RuntimeError('zzz_job_mismatch')
    pause_job(r['id'])
    if not remove_job(r['id']):
        raise RuntimeError('zzz_job_remove_failed')
else:
    if r.get('id'):
        old = get_job(r['id'])
        if not old or old.get('name') != r['name']:
            raise RuntimeError('zzz_job_mismatch')
        pause_job(r['id'])
        schedule = old.get('schedule')
        repeat = old.get('repeat')
        safe = (old.get('script') == r['script'] and old.get('no_agent') is True
            and old.get('enabled_toolsets') == r['toolsets'] and not old.get('workdir')
            and old.get('deliver') == 'local' and old.get('failure_deliver') == 'local'
            and isinstance(schedule, dict) and schedule.get('kind') == 'cron'
            and schedule.get('expr') == r['schedule']
            and isinstance(repeat, dict) and repeat.get('times') is None
            and not old.get('skills') and not old.get('skill') and not old.get('context_from')
            and not old.get('monitor_script') and not old.get('monitor_url'))
        if safe:
            job = update_job(r['id'], {'prompt': r['prompt'], 'script': r['script'],
                'enabled_toolsets': r['toolsets'], 'no_agent': True,
                'failure_deliver': 'local', 'workdir': None})
        else:
            # A running agent retains its tool snapshot. Removal invalidates
            # that old cron ID at the native gate before the new job resumes.
            if not remove_job(r['id']):
                raise RuntimeError('zzz_unsafe_job_remove_failed')
            job = create_job(prompt=r['prompt'], schedule=r['schedule'], name=r['name'], deliver='local',
                script=r['script'], enabled_toolsets=r['toolsets'], no_agent=True,
                failure_deliver='local', paused=True, paused_reason='Configuring ZZZ tool scope')
    else:
        job = create_job(prompt=r['prompt'], schedule=r['schedule'], name=r['name'], deliver='local',
            script=r['script'], enabled_toolsets=r['toolsets'], no_agent=True,
            failure_deliver='local', paused=True, paused_reason='Configuring ZZZ tool scope')
    if not job or job.get('enabled_toolsets') != r['toolsets'] or job.get('enabled'):
        raise RuntimeError('zzz_job_scope_failed')
    resumed = resume_job(job['id'])
    if not resumed or resumed.get('enabled_toolsets') != r['toolsets'] or resumed.get('enabled') is not True:
        pause_job(job['id'])
        raise RuntimeError('zzz_job_resume_failed')
`;

export function jobPython(bin: string): string {
  if (!isAbsolute(bin)) throw new Error("zzz_hermes_bin_unbound");
  const resolved = realpathSync(bin);
  const source = readFileSync(resolved, "utf8");
  // install.sh's public launcher is a bash wrapper, even when an unrelated
  // python happens to sit beside it. Bind to the interpreter in its one exec.
  if (source.startsWith("#!/usr/bin/env bash\n")) {
    const wrapper = /^#!\/usr\/bin\/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "(\/[^"\n]+\/python(?:[0-9.]*)?)" "(\/[^"\n]+)" "\$@"\n?$/.exec(source);
    if (!wrapper || !/(?:\/hermes|\/hermes_cli\/main\.py)$/.test(wrapper[2])
        || !existsSync(wrapper[1]) || !existsSync(wrapper[2]))
      throw new Error("zzz_hermes_wrapper_unbound");
    return wrapper[1];
  }
  // pipx/uv entrypoints can live outside their venv; their absolute shebang
  // still selects the same interpreter. Never search PATH for another Python.
  const shebang = source.split("\n", 1)[0];
  const match = /^#!(\/\S*\/python(?:[0-9.]*)?)$/.exec(shebang);
  if (match && existsSync(match[1])) return match[1];
  const beside = join(dirname(resolved), "python");
  if (/(?:^|\/)\.?venv\/bin\/[^/]+$/.test(resolved) && existsSync(beside)) return beside;
  throw new Error("zzz_hermes_python_missing");
}

export function jobApi(python: string, home: string, request: Record<string, unknown>): void {
  const env = { ...hermesExecEnv(), HERMES_HOME: home };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  execFileSync(python, ["-c", JOB_API], {
    env, input: JSON.stringify(request),
    stdio: ["pipe", "ignore", "ignore"], timeout: 30_000,
  });
}

/**
 * v2.1.20: write `bytes` to dir/name without a check-then-write. A symlink swapped in at dir/name after the caller's
 * refusal checks is never followed: the bytes go to a fresh temp file in the same, already-checked directory (O_EXCL +
 * O_NOFOLLOW, so nothing planted at the temp name is reused), fstat'd as a lone regular file, written, fsynced, then
 * renamed over dir/name (rename replaces a symlink there, never follows it). Any failure unlinks the temp.
 */
export function replaceFileNoFollow(dir: string, name: string, bytes: Buffer, mode = 0o700): void {
  const temp = join(dir, `.${name}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    const meta = fstatSync(fd);
    if (!meta.isFile() || meta.nlink !== 1) throw new Error("zzz_shim_temp_invalid");
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, join(dir, name));
  } catch (error) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already failing */ }
    try { unlinkSync(temp); } catch { /* absent or never created */ }
    throw error;
  }
}

function plainFile(path: string): boolean {
  try {
    const meta = lstatSync(path);
    if (!meta.isFile() || meta.isSymbolicLink()) throw new Error("zzz_shim_invalid");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function scriptsDir(home: string): string {
  const path = join(home, "scripts");
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()))
    throw new Error("zzz_shim_dir_invalid");
  return path;
}

/** scripts/ as a real directory, or null (absent, a symlink or not a directory: never followed, never ours). */
function realScriptsDir(home: string): string | null {
  const path = join(home, "scripts");
  try {
    const meta = lstatSync(path);
    return meta.isDirectory() && !meta.isSymbolicLink() ? path : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * ov#441 S4-r, gate on: the plugin keeps its cursor state in $HERMES_HOME/zzzbot and refuses a symlinked or
 * non-directory folder, so a pair it could never run is not installed. Absent or a real directory, else the stage fails
 * before the shim or job is written (authority is already published; failClosedZzz tears the managed files down).
 */
function stateDirUsable(home: string): void {
  try {
    const meta = lstatSync(join(home, "zzzbot"));
    if (meta.isDirectory() && !meta.isSymbolicLink()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
  }
  throw new Error("zzz_state_dir_invalid");
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Python json.loads(strict=False): raw control characters are allowed inside strings. Escape them for JSON.parse. */
function escapeControlsInStrings(raw: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (inString && !escaped && code < 0x20) { out += "\\u" + code.toString(16).padStart(4, "0"); continue; }
    out += char;
    if (escaped) escaped = false;
    else if (inString && char === "\\") escaped = true;
    else if (char === '"') inString = !inString;
  }
  return out;
}

/**
 * review-b N2: the job list exactly as Hermes v2026.9.24 cron/jobs.py load_jobs() reads cron/jobs.json, or null where
 * Hermes itself refuses the store. utf-8-sig (a BOM is dropped), strict JSON then strict=False; the canonical
 * {"jobs": [...]}, an id-keyed {"jobs": {id: job}} map (flattened: the inline id wins, non-object entries skipped), an
 * object without "jobs" (no jobs), or a bare list (Hermes wraps it on its next save). Any other shape is corruption.
 */
export function parseHermesJobs(raw: string): Job[] | null {
  const text = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
  let data: unknown;
  try { data = JSON.parse(text); } catch {
    try { data = JSON.parse(escapeControlsInStrings(text)); } catch { return null; }
  }
  if (Array.isArray(data)) return data;
  if (!isObject(data)) return null;
  if (!("jobs" in data)) return [];
  const list = data.jobs;
  if (Array.isArray(list)) return list;
  if (isObject(list))
    return Object.entries(list).filter(([, job]) => isObject(job)).map(([key, job]) => ({ ...(job as Job), id: (job as Job).id || key }));
  return null;
}

/** The store's text names the managed job (as written, or as Python's ensure_ascii writes the em dash). */
const NAMES_ZZZ_JOB = /Edge (?:\u2014|\\u2014) zzz pairs/i;
type Store = { jobs: Job[]; namesZzz: boolean } | { jobs: null; namesZzz: boolean };

function store(home: string): Store {
  try {
    const folder = join(home, "cron");
    if (existsSync(folder) && (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()))
      throw new Error("jobs-folder-invalid");
    const path = join(home, "cron", "jobs.json");
    if (!plainFile(path)) return { jobs: [], namesZzz: false };
    const raw = readFileSync(path, "utf8");
    return { jobs: parseHermesJobs(raw), namesZzz: NAMES_ZZZ_JOB.test(raw) };
  } catch { throw new Error("zzz_jobs_unreadable"); }
}

const isZzzJob = (job: unknown): job is Job => isObject(job) && job.name === ZZZ_JOB_NAME;

function jobs(home: string): Job[] {
  const { jobs: list } = store(home);
  if (list === null) throw new Error("zzz_jobs_unreadable");
  return list.filter(isZzzJob);
}

/**
 * The managed jobs to remove when participation is off. A store Hermes cannot load runs no job, so it is left alone
 * unless its text names the managed job (then it may be ours and still cannot be confirmed gone: refuse loudly).
 */
function lingeringJobs(home: string): Job[] {
  const found = store(home);
  if (found.jobs !== null) return found.jobs.filter(isZzzJob);
  if (found.namesZzz) throw new Error("zzz_jobs_unreadable");
  return [];
}

/** The installer's exact job record: what it confirms after an install, and what the plugin's managed_context needs. */
const emptyJobField = (value: unknown): boolean => value == null || value === ""
  || (Array.isArray(value) && value.length === 0);

function confirmed(list: Job[], prompt: string): boolean {
  return list.length === 1 && list[0].script === ZZZ_JOB_SCRIPT && list[0].enabled === true
    && list[0].no_agent === true && !list[0].workdir
    && JSON.stringify(list[0].enabled_toolsets) === JSON.stringify(ZZZ_JOB_TOOLSETS)
    && list[0].deliver === "local" && list[0].failure_deliver === "local"
    && typeof list[0].schedule === "object" && list[0].schedule !== null
    && (list[0].schedule as { kind?: unknown; expr?: unknown }).kind === "cron"
    && (list[0].schedule as { expr?: unknown }).expr === ZZZ_JOB_SCHEDULE
    && typeof list[0].repeat === "object" && list[0].repeat !== null
    && (list[0].repeat as { times?: unknown }).times === null
    && emptyJobField(list[0].skills) && emptyJobField(list[0].skill) && emptyJobField(list[0].context_from)
    && !list[0].monitor_script && !list[0].monitor_url && list[0].prompt === prompt;
}

/**
 * review-b N3, read-only (no Hermes call, nothing written): with participation on, exactly the installer's job record
 * and the reviewed shim bytes; with it off, no managed job (in a store Hermes can load, or named in one it cannot) and
 * no shim in a real scripts/ directory.
 */
export function verifyZzzManagedJob(home: string, installed: boolean, script: Buffer | null): void {
  if (installed) {
    stateDirUsable(home);
    if (!confirmed(jobs(home), readFileSync(join(home, PROMPT), "utf8").trimEnd())) throw new Error("zzz_job_not_confirmed");
    const dir = realScriptsDir(home);
    const shim = dir && join(dir, ZZZ_JOB_SCRIPT);
    if (!shim || !plainFile(shim) || !script || !readFileSync(shim).equals(script)) throw new Error("zzz_shim_mismatch");
    return;
  }
  if (lingeringJobs(home).length) throw new Error("zzz_job_removal_pending");
  // N12: only the installer's own shim is pending removal; any other object by its name is not ours and stays.
  const dir = realScriptsDir(home);
  if (dir && (zzzShippedFile(join(dir, ZZZ_JOB_SCRIPT), "runner") === "ours"
      || zzzShippedFile(join(dir, LEGACY_JOB_SCRIPT), "shim") === "ours")) throw new Error("zzz_shim_removal_pending");
}

/** Reconcile only the installer-owned job; the projection remains app authority. */
export function reconcileZzzManagedJob(home: string, installed: boolean): void {
  const bin = hermesBin();
  const env = hermesExecEnv();
  if (!installed) {
    // review-b N2: with participation off, a job store or scripts/ shape this installer never wrote (and Hermes still
    // accepts) never fails the stage; only a managed job that may still run does.
    const current = lingeringJobs(home);
    if (current.length && !hermesAvailable(bin, 15_000, env)) throw new Error("zzz_hermes_missing");
    const python = current.length ? jobPython(bin) : null;
    for (const job of current) {
      if (typeof job.id !== "string" || !ID.test(job.id)) throw new Error("zzz_job_invalid");
      jobApi(python!, home, { action: "remove", id: job.id, name: ZZZ_JOB_NAME });
    }
    if (lingeringJobs(home).length) throw new Error("zzz_job_removal_pending");
    syncZzzInstalledJobId(home, null);
    // The installer only ever writes the shim into a real scripts/ directory; never follow a symlinked one. N12: it
    // removes only its own shim (a shipped version's bytes); a resident's file or any other object by that name stays.
    const dir = realScriptsDir(home);
    if (dir) {
      for (const [name, kind] of [[ZZZ_JOB_SCRIPT, "runner"], [LEGACY_JOB_SCRIPT, "shim"]] as const) {
        const shim = join(dir, name);
        if (zzzShippedFile(shim, kind) === "ours") unlinkSync(shim);
      }
    }
    return;
  }
  stateDirUsable(home);
  const current = jobs(home);
  if (!hermesAvailable(bin, 15_000, env)) throw new Error("zzz_hermes_missing");
  if (current.length > 1) throw new Error("zzz_job_duplicate");
  const python = jobPython(bin);
  const prompt = readFileSync(join(home, PROMPT), "utf8").trimEnd();
  const script = readFileSync(join(home, SCRIPT));
  const shim = join(scriptsDir(home), ZZZ_JOB_SCRIPT);
  plainFile(shim);
  // The mini-app helper stages the reviewed script before publishing authority.
  mkdirSync(scriptsDir(home), { recursive: true });
  replaceFileNoFollow(scriptsDir(home), ZZZ_JOB_SCRIPT, script);
  const id = current[0]?.id;
  if (id !== undefined && (typeof id !== "string" || !ID.test(id))) throw new Error("zzz_job_invalid");
  jobApi(python, home, { action: "install", ...(id ? { id } : {}), name: ZZZ_JOB_NAME,
    prompt, script: ZZZ_JOB_SCRIPT, schedule: ZZZ_JOB_SCHEDULE,
    toolsets: [...ZZZ_JOB_TOOLSETS], home });
  const installedJob = jobs(home);
  if (!confirmed(installedJob, prompt)) throw new Error("zzz_job_not_confirmed");
  const confirmedId = installedJob[0].id;
  if (typeof confirmedId !== "string" || !ID.test(confirmedId)) throw new Error("zzz_job_invalid");
  syncZzzInstalledJobId(home, confirmedId);
  const legacy = join(scriptsDir(home), LEGACY_JOB_SCRIPT);
  if (zzzShippedFile(legacy, "shim") === "ours") unlinkSync(legacy);
}
