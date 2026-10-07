/**
 * The scheduled messages a resident can stop and restart from chat
 * (DATA-376), and the definitions the pause script (pause-job.ts) shares with
 * install/jobs.ts and install/install_index.ts. Those re-export the moved
 * ones, so each has one definition. Skill scripts run on a box where install/
 * is not present, so the shared code lives here.
 *
 * Every message a resident gets from a job ends with a label line,
 * `(<Label> message - you can ask me to stop or manage it)` (DATA-373).
 * MESSAGE_LABELS maps each label to its job names; workspace/AGENTS.md
 * ("Cron schedule") lists the same mapping, and install/tests/
 * cron_wrapper.test.ts pins both to the prompts' own lines.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ── Labels ──────────────────────────────────────────────────────────────────

/** Each label and the names of the jobs it stands for. Templates are operator previews and are not here. */
export const MESSAGE_LABELS = Object.freeze({
  "Daily digest": Object.freeze(["Edge — daily digest"]),
  "Conversation update": Object.freeze(["Edge — negotiation summary"]),
  "Evening questions": Object.freeze(["Edge — evening questions"]),
  "Introduction suggestion": Object.freeze(["Edge — opportunity drop (midday)", "Edge — opportunity drop (evening)"]),
  // Opt-in: absent on most boxes.
  "Usage report": Object.freeze(["Edge — token usage audit"]),
} as const);

export type MessageLabel = keyof typeof MESSAGE_LABELS;

/** The labels in a fixed order. */
export const MESSAGE_LABEL_NAMES = Object.freeze(Object.keys(MESSAGE_LABELS) as MessageLabel[]);

/** A `--label` value longer than this is not a label. */
export const MAX_LABEL_CHARS = 40;

/** Whether `value` is one of the labels exactly as written. */
export function isMessageLabel(value: unknown): value is MessageLabel {
  return typeof value === "string" && Object.hasOwn(MESSAGE_LABELS, value);
}

/**
 * The label `raw` names, or null. At most MAX_LABEL_CHARS characters; leading
 * and trailing spaces are dropped, a run of spaces or tabs inside counts as
 * one space, and case does not matter. Anything else (punctuation, another
 * word, a template's name) is not a label.
 */
export function normalizeLabel(raw: unknown): MessageLabel | null {
  if (typeof raw !== "string" || raw.length > MAX_LABEL_CHARS) return null;
  const folded = raw.replace(/[ \t]+/g, " ").trim().toLowerCase();
  return MESSAGE_LABEL_NAMES.find((label) => label.toLowerCase() === folded) ?? null;
}

/**
 * The four contact-style jobs: the control plane's CONTACT_STYLE_CRONS
 * (control-plane/src/tenants.js). Its contact-style apply resumes or pauses
 * these to match the resident's style, except a job with a hold. A resume
 * from chat therefore holds them `active`; any other job's hold is removed.
 */
export const CONTACT_STYLE_JOB_NAMES = Object.freeze([
  "Edge — evening questions",
  "Edge — opportunity drop (midday)",
  "Edge — opportunity drop (evening)",
  "Edge — negotiation summary",
] as const);

// ── Ids and paths ───────────────────────────────────────────────────────────

/** Hermes's job id: `uuid.uuid4().hex[:12]` (cron/jobs.py:1781 at v2026.9.24). Any other id is never used or printed. */
export const HERMES_JOB_ID_RE = /^[0-9a-f]{12}$/;

/**
 * `$HERMES_HOME/av-events/installed_jobs.json`: the ids of the cron jobs this
 * installer created or manages (DATA-92). The av-events plugin reports a
 * `cron.run` job name only for these ids: a participant can ask the agent for
 * a job named exactly like one of ours, and its name is then their words.
 */
export function installedJobsPath(home: string): string {
  return join(home, "av-events", "installed_jobs.json");
}

/** The tenant's jobs lock: one mutating command at a time (stale after state-lock.ts LOCK_STALE_MS). */
export function jobsLockPath(home: string): string {
  return join(home, "av-events", "jobs.lock");
}

/** The control plane's holds file (control-plane/src/job-control.js HOLDS_FILE). */
export function jobHoldsPath(home: string): string {
  return join(home, "av-events", "job-holds.json");
}

// ── The holds file's grammars (control-plane/src/job-control.js) ────────────

/** The control plane reads the holds file's first 65536 bytes (`head -c 65536`); the pause script reads the same prefix. */
export const HOLDS_MAX_BYTES = 65_536;

/** HOLD_STATES. */
export const HOLD_STATES = Object.freeze(["paused", "active"] as const);
export type HoldState = (typeof HOLD_STATES)[number];

/**
 * Who placed a hold. `admin`: the control plane's pause and resume routes (a
 * hold with no `by` reads as admin's too). `desired`: the app's job-settings
 * apply. `resident`: the resident's own agent, through pause-job.ts
 * (DATA-376; the control plane's half adds the word to its HOLD_BY).
 */
export const HOLD_BY_WORDS = Object.freeze(["admin", "desired", "resident"] as const);
export type HoldBy = (typeof HOLD_BY_WORDS)[number];

/** HOLD_AT_RE: when a hold was placed, ISO 8601 UTC. */
export const HOLD_AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function isHoldState(value: unknown): value is HoldState {
  return typeof value === "string" && (HOLD_STATES as readonly string[]).includes(value);
}

export function isHoldBy(value: unknown): value is HoldBy {
  return typeof value === "string" && (HOLD_BY_WORDS as readonly string[]).includes(value);
}

export function isHoldAt(value: unknown): value is string {
  return typeof value === "string" && HOLD_AT_RE.test(value) && Number.isFinite(Date.parse(value));
}

// ── Hermes's job store, read defensively (the resident can write it) ───────

/** A larger `cron/jobs.json` is unreadable (`jobs-store-unreadable`). */
export const MAX_JOBS_STORE_BYTES = 16 * 1024 * 1024;

/**
 * Hermes's job store, `$HERMES_HOME/cron/jobs.json`. No file is no jobs (as
 * Hermes reads it). A file that is not a regular file, is over
 * MAX_JOBS_STORE_BYTES, cannot be read, is not JSON, or is not
 * `{"jobs": [...]}` (an object without `jobs` is no jobs, as Hermes reads it)
 * is unreadable: never "no jobs". (Hermes repairs some shapes on its next
 * write: a bare list, an id-keyed map, control characters in strings. They
 * are unreadable here until then.)
 */
export function readJobsStore(home: string): { jobs: unknown[] } | { unreadable: true } {
  const path = join(home, "cron", "jobs.json");
  let text: string;
  try {
    if (!existsSync(path)) return { jobs: [] };
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_JOBS_STORE_BYTES) return { unreadable: true };
    text = readFileSync(path, "utf8");
  } catch {
    return { unreadable: true };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { unreadable: true };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { unreadable: true };
  const jobs = (raw as { jobs?: unknown }).jobs;
  if (jobs === undefined) return { jobs: [] };
  return Array.isArray(jobs) ? { jobs } : { unreadable: true };
}

/** Whether Hermes will fire a stored job (cron/jobs.py is_job_runnable: `enabled` and no pause mark). */
export function storedJobEnabled(job: { enabled?: unknown; state?: unknown; paused_at?: unknown }): boolean {
  return job.enabled !== false && job.state !== "paused" && !job.paused_at;
}

/** The schedule text a stored job holds, read defensively (never trusted, never printed). */
export function rawSchedule(job: { schedule?: unknown; schedule_display?: unknown }): string {
  const schedule: unknown = job.schedule;
  if (typeof schedule === "string") return schedule.trim();
  if (schedule && typeof schedule === "object" && typeof (schedule as { expr?: unknown }).expr === "string") return (schedule as { expr: string }).expr.trim();
  return typeof job.schedule_display === "string" ? job.schedule_display.trim() : "";
}

/** Whether the job's stored next run is already due (an occurrence passed while it was paused), by Hermes's clock: the real one. */
export function missedSlot(job: object, now: Date): boolean {
  const next = (job as { next_run_at?: unknown }).next_run_at;
  if (typeof next !== "string") return false;
  const at = Date.parse(next);
  return Number.isFinite(at) && at <= now.getTime();
}
