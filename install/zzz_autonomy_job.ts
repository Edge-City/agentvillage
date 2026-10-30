/** Separate, projection-gated no-agent ZZZ event job. No pair-gate dependency. */
import { constants, lstatSync, mkdirSync, openSync, readFileSync, closeSync, fstatSync, rmdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import { hermesAvailable } from "../skills/index-network/scripts/hermes-cli";
import { jobApi, jobPython, parseHermesJobs, replaceFileNoFollow } from "./zzz_managed_job";

export const AUTONOMY_GATE = "zzz-autonomy-runner";
export const AUTONOMY_JOB_NAME = "Edge — zzz event autonomy";
export const AUTONOMY_JOB_SCRIPT = "zzz_autonomy_runner.py";
// cp#467: the control plane mirrors these receipt paths (mini-apps-skills.js ZZZ_AUTONOMY_FILE_LISTS); change it first.
export const AUTONOMY_FILES = ["scripts/zzz_autonomy_runner.py", "prompts/autonomy.md"] as const;
const ID = /^[0-9a-f]{12}$/;
const TOKEN = /^avb_[A-Za-z0-9_-]{43}$/;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const source = (relative: string) => readFileSync(join(import.meta.dir, "..", "skills", "zzzbot", relative));

/** Every runner/prompt byte sequence this installer has ever staged, oldest first. Keep old digests when changing
 *  shipped files, so a box holding older bytes still upgrades and tears down as "ours". */
export const AUTONOMY_SHIPPED = {
  "scripts/zzz_autonomy_runner.py": [
    "f25327ecfb2781969d511c23c1c1c4e5e93e829f9abae1384d3b582174b3061e", // ov#528 9d80c106 (the runner PR alone)
    "95b64ed6eef6d42897e7ad4f922266fbbf1320abeaeeee9f28e06ca9a1d51c9c", // + untrusted event_brief + ZZZ 0031 reuse (ov#526)
    "f71f3c5d48c90ca8dcbdfa22a58c945dcf3d6e54640536ca30194722e0d97a32", // + topic tags, only with the app's room_tags (lead L30725)
    "cd566df9f69d257a4f75e0d59e331902381ff9bb61ed0e2945d1bedf6e7a3f78", // + zzzbot 1.1.0 by the bridge's exact ZZZBOT_ACCEPTED (RUNNER-ZZZBOT-110)
    "5db8a0da4210b5145b55d713e0a97a5a0627332b1f6728c4bf30261432838e45", // + stdlib-only model route read and a stderr reason line (ov#550 8821169a)
    "e6edc00f2b8f02ab87787f0592645fa134c6bbfa68de36a349f34c0f6113c498", // + PyYAML first, the stdlib reader only when PyYAML is not importable (review-b ov#550 S1)
    "06607497360fc59bd9507eccab0a40280a321f9bab6bf6e31e6c574f1dee8ef5", // + provider auto takes config.yaml's own OpenRouter api_key only with the OpenRouter base_url (RUNNER-MODEL-RESOLVE + review-b ov#553 S1, canary aa9a5de3)
    "0fb7fbc2a1b652ce4d5ecbf64a292c0af0879d436942d2962599642b06c24450", // + ODIN's seat_answer posted as given or silent with no model call (data L32206, context L32211) + resident_brief grounding (lead L32261, data L32263) + one run deadline, context read up to 75 s for the seat hold (review-b S1 on app#932) + brief name/voice may be null (review-b ov#554 S1) + thread_replies grounding (lead L32986) + context reply cap 64 KiB (review-b ov#554 L33044 S1)
    "4db2093acdff5aa40dba2f9569bab5a07e2dcc9cbec69221ba883a9fa9e4605c", // + owner_instruction read from the context reply, appended last to the system message (lead L34271, release L34319)
  ],
  "prompts/autonomy.md": ["93b8442797de1957ac5e64eb7477e1288601654fdaccb56fc4791f0bfd608587"],
} as const;

function ownedFile(path: string, relative: typeof AUTONOMY_FILES[number]): "absent" | "ours" | "not_ours" {
  let meta;
  try { meta = lstatSync(path); } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "not_ours"; }
  if (!meta.isFile() || meta.size > 65536) return "not_ours";
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.ino !== meta.ino || actual.dev !== meta.dev) return "not_ours";
    return (AUTONOMY_SHIPPED[relative] as readonly string[]).includes(sha(readFileSync(fd))) ? "ours" : "not_ours";
  } catch { return "not_ours"; } finally { if (fd !== undefined) closeSync(fd); }
}

function realDir(home: string, ...parts: string[]): string | null {
  let path = home;
  for (const part of parts) {
    path = join(path, part);
    try { const meta = lstatSync(path); if (!meta.isDirectory() || meta.isSymbolicLink()) return null; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  return path;
}

export function autonomyMarkers(home: string): boolean {
  // A job under the reserved name is a marker on its own: a failed Hermes removal keeps the teardown pending, so a
  // later stage retries it instead of leaving an orphan cron. Only a job whose name IS the reserved name counts: a
  // resident or agent job that merely mentions it (in its name or prompt) is not ours. An unreadable store is not a
  // marker here (it must not fail every stage of a box that never had autonomy); reconcile still refuses a store
  // that mentions the reserved name but cannot be parsed.
  let named = false;
  try { named = store(home).jobs.length > 0; } catch { named = false; }
  if (named) return true;
  const scripts = realDir(home, "scripts");
  const skill = realDir(home, "skills", "zzzbot");
  const state = realDir(home, "zzzbot");
  return Boolean((scripts && ownedFile(join(scripts, AUTONOMY_JOB_SCRIPT), AUTONOMY_FILES[0]) === "ours") ||
    (state && (() => { try { return lstatSync(join(state, "autonomy-run.lock")).isFile(); } catch { return false; } })()) ||
    (skill && AUTONOMY_FILES.some(relative => {
      const dir = realDir(skill, ...relative.split("/").slice(0, -1));
      return dir && ownedFile(join(dir, relative.split("/").at(-1)!), relative) === "ours";
    })));
}

export const AUTONOMY_STATE_FILES = ["autonomy-run.lock", "autonomy-backoff.json"] as const;
export function removeAutonomyState(home: string): void {
  const state = realDir(home, "zzzbot");
  if (!state) return;
  // The reserved names are the runner's own: whatever sits there (a regular file, a FIFO, a socket, a symlink, which
  // unlink removes without following) goes. Only a non-empty directory is left, never emptied: it is not a file the
  // runner could have made.
  for (const name of AUTONOMY_STATE_FILES) {
    const path = join(state, name);
    try { if (lstatSync(path).isDirectory()) rmdirSync(path); else unlinkSync(path); }
    catch (error) { if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  }
}

export function removeAutonomyFiles(home: string): void {
  const skill = realDir(home, "skills", "zzzbot");
  if (!skill) return;
  for (const relative of AUTONOMY_FILES) {
    const dir = realDir(skill, ...relative.split("/").slice(0, -1));
    if (dir) { const path = join(dir, relative.split("/").at(-1)!); if (ownedFile(path, relative) === "ours") unlinkSync(path); }
  }
}

export function removeAutonomyShim(home: string): void {
  const dir=realDir(home,"scripts");
  if (!dir) return;
  const path=join(dir,AUTONOMY_JOB_SCRIPT);
  if (ownedFile(path,AUTONOMY_FILES[0])==="ours") unlinkSync(path);
}

function store(home: string) {
  const folder = realDir(home, "cron");
  if (!folder) return { jobs: [] as Record<string, unknown>[] };
  const path = join(folder, "jobs.json");
  let raw: string;
  let fd: number | undefined;
  try {
    const meta=lstatSync(path);
    if (!meta.isFile() || meta.isSymbolicLink() || meta.size>1024*1024) throw new Error("zzz_autonomy_jobs_shape");
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const actual=fstatSync(fd);
    if (!actual.isFile() || actual.ino!==meta.ino || actual.dev!==meta.dev) throw new Error("zzz_autonomy_jobs_shape");
    raw = readFileSync(fd,"utf8");
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { jobs: [] as Record<string, unknown>[] }; throw error; }
  finally { if (fd!==undefined) closeSync(fd); }
  // The substring test only decides whether an UNPARSABLE store is refused (it may hide our job); a parsed store's
  // jobs are matched by exact name below.
  const mentioned = /Edge (?:—|\\u2014) zzz event autonomy/.test(raw);
  const parsed = parseHermesJobs(raw);
  if (!parsed) { if (mentioned) throw new Error("zzz_autonomy_jobs_unreadable"); return { jobs: [] as Record<string, unknown>[] }; }
  // Every job under the reserved name is the installer's, whatever its prompt or toolsets (an older release's
  // prompt, or a resident edit): install updates it in place, teardown removes it. verifyAutonomyJob still demands
  // the exact current shape before a stage succeeds.
  const jobs=parsed.filter((job): job is Record<string, unknown> => !!job && typeof job === "object" &&
    job.name === AUTONOMY_JOB_NAME);
  return {jobs};
}

export function autonomySchedule(token: string): string {
  if (!TOKEN.test(token)) throw new Error("zzz_autonomy_bridge_token");
  const phase = createHash("sha256").update(token).digest()[0] % 5;
  return `${phase}-59/5 * * * *`;
}

function bridgeToken(home: string): string {
  const path = join(home, "village-bridge.json");
  const meta = lstatSync(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 2048) throw new Error("zzz_autonomy_bridge_config");
  let fd: number | undefined;
  let data: unknown;
  try {
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const actual=fstatSync(fd);
    if (!actual.isFile() || actual.ino!==meta.ino || actual.dev!==meta.dev) throw new Error("zzz_autonomy_bridge_config");
    data=JSON.parse(readFileSync(fd,"utf8"));
  } finally { if (fd!==undefined) closeSync(fd); }
  const token = data && typeof data === "object" ? (data as {token?: unknown}).token : null;
  if (typeof token !== "string" || !TOKEN.test(token)) throw new Error("zzz_autonomy_bridge_config");
  return token;
}

function confirmed(job: Record<string, unknown>, schedule: string, prompt: string): boolean {
  const sch = job.schedule as {kind?: unknown;expr?: unknown} | undefined;
  const repeat = job.repeat as {times?: unknown} | undefined;
  const empty = (value: unknown) => value == null || value === "" || (Array.isArray(value) && value.length === 0);
  return typeof job.id === "string" && ID.test(job.id) && job.name === AUTONOMY_JOB_NAME &&
    job.script === AUTONOMY_JOB_SCRIPT && job.prompt === prompt && job.enabled === true && job.no_agent === true &&
    JSON.stringify(job.enabled_toolsets) === '["no_mcp"]' && job.deliver === "local" && job.failure_deliver === "local" &&
    !job.workdir && empty(job.skills) && empty(job.skill) && empty(job.context_from) && !job.monitor_script && !job.monitor_url &&
    sch?.kind === "cron" && sch.expr === schedule && repeat?.times === null;
}

export function verifyAutonomyJob(home: string, installed: boolean, script: Buffer | null): void {
  const jobs = store(home).jobs;
  const dir = realDir(home, "scripts");
  const shim = dir ? join(dir, AUTONOMY_JOB_SCRIPT) : null;
  if (!installed) {
    if (jobs.length || (shim && ownedFile(shim, AUTONOMY_FILES[0]) === "ours")) throw new Error("zzz_autonomy_removal_pending");
    return;
  }
  const prompt = source(AUTONOMY_FILES[1]).toString("utf8").trimEnd();
  if (jobs.length !== 1 || !confirmed(jobs[0], autonomySchedule(bridgeToken(home)), prompt) ||
      !shim || !script || ownedFile(shim, AUTONOMY_FILES[0]) !== "ours" || !readFileSync(shim).equals(script))
    throw new Error("zzz_autonomy_job_not_confirmed");
}

export function reconcileAutonomyJob(home: string, installed: boolean): void {
  const current = store(home), jobs=current.jobs;
  if (!installed) {
    if (jobs.length) {
      const bin = hermesBin();
      if (!hermesAvailable(bin, 15000, hermesExecEnv())) throw new Error("zzz_autonomy_hermes_missing");
      const python = jobPython(bin);
      // Two passes: a transient Hermes failure on the first is retried once here, and any job still left keeps the
      // markers (and the files) in place so the next stage retries again.
      for (let pass = 0; pass < 2 && store(home).jobs.length; pass++) {
        for (const job of store(home).jobs) {
          if (typeof job.id !== "string" || !ID.test(job.id)) throw new Error("zzz_autonomy_job_invalid");
          try { jobApi(python, home, {action:"remove",id:job.id,name:AUTONOMY_JOB_NAME}); } catch { /* checked below */ }
        }
      }
      if (store(home).jobs.length) throw new Error("zzz_autonomy_removal_pending");
    }
    removeAutonomyShim(home);
    return;
  }
  if (jobs.length > 1) throw new Error("zzz_autonomy_duplicate_job");
  const bin = hermesBin();
  if (!hermesAvailable(bin, 15000, hermesExecEnv())) throw new Error("zzz_autonomy_hermes_missing");
  const python = jobPython(bin);
  const prompt = source(AUTONOMY_FILES[1]).toString("utf8").trimEnd();
  const script = source(AUTONOMY_FILES[0]);
  const schedule = autonomySchedule(bridgeToken(home));
  const dir = realDir(home, "scripts");
  if (!dir) {
    try { lstatSync(join(home,"scripts")); throw new Error("zzz_autonomy_scripts_invalid"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=="ENOENT") throw error; }
  }
  const scripts = join(home, "scripts");
  mkdirSync(scripts, {recursive:true,mode:0o700});
  const shim = join(scripts, AUTONOMY_JOB_SCRIPT);
  if (ownedFile(shim, AUTONOMY_FILES[0]) === "not_ours") throw new Error("zzz_autonomy_shim_not_ours");
  replaceFileNoFollow(scripts, AUTONOMY_JOB_SCRIPT, script);
  const id = jobs[0]?.id;
  if (id !== undefined && (typeof id !== "string" || !ID.test(id))) throw new Error("zzz_autonomy_job_invalid");
  jobApi(python, home, {action:"install",...(id?{id}:{}),name:AUTONOMY_JOB_NAME,prompt,
    script:AUTONOMY_JOB_SCRIPT,schedule,toolsets:["no_mcp"]});
  verifyAutonomyJob(home,true,script);
}
