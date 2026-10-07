#!/usr/bin/env bun
/**
 * DATA-376: stop or restart one scheduled message from chat, so that an
 * update or a roll keeps it that way.
 *
 *   bun skills/index-network/scripts/pause-job.ts <pause|resume|status> [--label "<Label>"] [--home DIR]
 *
 * The agent runs it through `terminal` when a resident asks to stop or
 * restart a message (workspace/AGENTS.md, "Cron schedule"). `<Label>` is one
 * of the five labels the messages end with (message-labels.ts
 * MESSAGE_LABELS). The home is `--home`, else `HERMES_HOME`, else `~/.hermes`.
 *
 * pause and resume record a hold with `by: resident` in the control plane's
 * holds file, `$HERMES_HOME/av-events/job-holds.json`, then run
 * `hermes cron pause|resume <id>` on each installed job the label names. The
 * hold goes first, so the control plane never finds the job changed and not
 * yet held; a job whose Hermes step does not happen gets its entry back. The
 * control plane reads that file before it re-applies the contact style or the
 * job settings (control-plane/src/job-control.js, tenants.js,
 * job-settings.js), so a held job is left as the resident asked. A resume
 * refuses a job held `paused` by an admin or by the settings, and refuses
 * outright when the file cannot be read, as every control-plane resume path
 * does; a pause on an unreadable file still pauses and writes nothing. The
 * format and the hold rules are docs/design/job-settings.md, "Resident holds
 * (DATA-376)".
 *
 * Output: exactly one JSON line on stdout, `{"ok": true, ...}` or
 * `{"ok": false, "error": "<code>", ...}`, and nothing on stderr (Hermes's
 * `terminal` tool hands the agent both streams). Exit codes, as
 * install/jobs.ts: 0 done; 1 a step failed on the way (`applied` lists the
 * jobs Hermes changed; every step is idempotent, so running it again is
 * safe and finishes the job, a missed re-anchor included); 2 refused before
 * anything changed; 4 `busy`: another job command
 * holds the tenant's jobs lock, nothing changed, try again shortly.
 *
 * The files it reads (`cron/jobs.json`, `installed_jobs.json`, the holds
 * file) can be written by the resident's own agent, so each value is checked
 * against a fixed grammar before use, and nothing free-form read from them is
 * ever printed or passed on: the reply carries job ids of Hermes's shape and
 * fixed words only. Hermes is only ever started as an argv, never through a
 * shell, never for longer than HERMES_TIMEOUT_MS, and its output is never
 * read or printed.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import { HERMES_TIMEOUT_MS, HermesTimeout, hermesAvailable, hermesBin, hermesExecEnv, hermesRunner } from "./hermes-cli";
import { parseStoredCron } from "./job-settings";
import {
  CONTACT_STYLE_JOB_NAMES,
  HERMES_JOB_ID_RE,
  HOLDS_MAX_BYTES,
  MESSAGE_LABELS,
  MESSAGE_LABEL_NAMES,
  type HoldBy,
  type HoldState,
  type MessageLabel,
  installedJobsPath,
  isHoldAt,
  isHoldBy,
  isHoldState,
  jobHoldsPath,
  jobsLockPath,
  missedSlot,
  normalizeLabel,
  rawSchedule,
  readJobsStore,
  storedJobEnabled,
} from "./message-labels";
import { type HeldLock, LOCK_STALE_MS, holdsLock, tryAcquireLock } from "./state-lock";

/** Exit codes (install/jobs.ts EXIT, without the preview's 3). */
export const EXIT = { done: 0, failed: 1, refused: 2, busy: 4 } as const;

export const ACTIONS = ["pause", "resume", "status"] as const;
export type Action = (typeof ACTIONS)[number];

/** A `--home` longer than this is refused. */
export const MAX_HOME_CHARS = 4096;

/** A larger `installed_jobs.json` reads as no installed jobs. */
export const MAX_INSTALLED_IDS_BYTES = 1024 * 1024;

export interface CommandResult {
  code: number;
  out: Record<string, unknown>;
}

/** What the script runs Hermes with; tests pass their own. */
export interface PauseJobContext {
  /** Runs one Hermes command (argv after the binary); throws on a non-zero exit, HermesTimeout when killed at its timeout. */
  hermes: (args: string[]) => void;
  /** Whether the Hermes CLI runs at all (`hermes --version`). */
  hermesReady: () => boolean;
  /** The timeout `hermes` kills a command at; the lock check budgets for it. HERMES_TIMEOUT_MS by default. */
  hermesTimeoutMs?: number;
  /** The real clock (the lock's age, missed slots, a hold's time); Date.now by default. */
  clock?: () => number;
}

function ok(out: Record<string, unknown>): CommandResult {
  return { code: EXIT.done, out: { ok: true, ...out } };
}

function refused(error: string, extra: Record<string, unknown> = {}): CommandResult {
  return { code: EXIT.refused, out: { ok: false, error, ...extra } };
}

function failed(error: string, extra: Record<string, unknown> = {}): CommandResult {
  return { code: EXIT.failed, out: { ok: false, error, ...extra } };
}

function isResult(value: unknown): value is CommandResult {
  return Boolean(value) && typeof value === "object" && "code" in (value as object) && "out" in (value as object);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// ── Arguments ───────────────────────────────────────────────────────────────

interface Request {
  action: Action;
  label: MessageLabel | null;
  home: string | null;
}

/**
 * `<action> [--label <label>] [--home <dir>]`, each flag at most once; or the
 * refusal: `invalid-action`, `invalid-args` (an unknown or repeated flag, a
 * flag without a value, a `--home` that is not an absolute path),
 * `invalid-label` (not one of the five labels), `missing-label` (pause and
 * resume need one).
 */
export function parseArgs(argv: string[]): Request | CommandResult {
  const [action, ...rest] = argv;
  if (!(ACTIONS as readonly string[]).includes(action ?? "")) return refused("invalid-action");
  let label: string | undefined;
  let home: string | undefined;
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if ((flag !== "--label" && flag !== "--home") || value === undefined) return refused("invalid-args");
    if (flag === "--label") {
      if (label !== undefined) return refused("invalid-args");
      label = value;
    } else {
      if (home !== undefined) return refused("invalid-args");
      home = value;
    }
  }
  if (home !== undefined && (home.length > MAX_HOME_CHARS || !isAbsolute(home) || home.includes("\0"))) return refused("invalid-args");
  let named: MessageLabel | null = null;
  if (label !== undefined) {
    named = normalizeLabel(label);
    if (!named) return refused("invalid-label");
  } else if (action !== "status") {
    return refused("missing-label");
  }
  return { action: action as Action, label: named, home: home ?? null };
}

function resolveHome(flag: string | null): string {
  return flag ?? (process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes"));
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

/** A job this script may act on: installed by the overlay, with Hermes's id shape. */
interface LabelJob {
  id: string;
  name: string;
  raw: Record<string, unknown>;
}

/** The ids in `installed_jobs.json` that have Hermes's shape; none when it is missing or unreadable. */
export function readInstalledIds(home: string): Set<string> {
  try {
    const path = installedJobsPath(home);
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_INSTALLED_IDS_BYTES) return new Set();
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const ids = isPlainObject(raw) ? raw.ids : undefined;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string" && HERMES_JOB_ID_RE.test(id)) : []);
  } catch {
    return new Set();
  }
}

/**
 * The jobs `label` stands for: named exactly as one of its job names, with an
 * id of Hermes's shape that `installed_jobs.json` lists. A job with one of
 * those names that the overlay did not install is the resident's own, and is
 * never touched. Each id once, in the store's order.
 */
function labelJobs(all: unknown[], label: MessageLabel, installed: Set<string>): LabelJob[] {
  const names: readonly string[] = MESSAGE_LABELS[label];
  const seen = new Set<string>();
  const out: LabelJob[] = [];
  for (const entry of all) {
    if (!isPlainObject(entry)) continue;
    const { id, name } = entry;
    if (typeof name !== "string" || !names.includes(name)) continue;
    if (typeof id !== "string" || !HERMES_JOB_ID_RE.test(id) || !installed.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name, raw: entry });
  }
  return out;
}

/** The job with this id as `jobs.json` holds it now; undefined when it is gone or the store is unreadable. */
function rereadJob(home: string, id: string): Record<string, unknown> | undefined {
  const store = readJobsStore(home);
  if ("unreadable" in store) return undefined;
  return store.jobs.find((entry): entry is Record<string, unknown> => isPlainObject(entry) && entry.id === id);
}

/** Whether Hermes now has the job in the asked state (the read-back after a pause or resume). */
function enabledIs(home: string, id: string, enabled: boolean): boolean {
  const job = rereadJob(home, id);
  return job !== undefined && storedJobEnabled(job) === enabled;
}

// ── The holds file ──────────────────────────────────────────────────────────

/** One job's hold as read: a hold without `by` is an admin's; one without `at` has no time. */
export interface Hold {
  state: HoldState;
  at?: string;
  by?: HoldBy;
}

export type HoldsRead = { status: "ok"; holds: Map<string, Hold> } | { status: "unreadable" };

const UNREADABLE: HoldsRead = Object.freeze({ status: "unreadable" });

/**
 * The holds in the file's text, with the control plane's readers' rules
 * (job-control.js parseHolds, parseHoldTimes, parseHoldBy): empty text is no
 * holds; text that is not JSON, or not a JSON object, is unreadable. Only
 * entries whose id has Hermes's shape and whose state is `paused` or `active`
 * are kept (the control plane's id grammar is wider, but an id of any other
 * shape names no Hermes job, so dropping it changes nothing it acts on). Each
 * kept entry keeps its `at` when that is an ISO time, and its `by` when that
 * is one of HOLD_BY_WORDS. Everything else is dropped.
 */
export function parseHolds(text: string): HoldsRead {
  const trimmed = text.trim();
  if (!trimmed) return { status: "ok", holds: new Map() };
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return UNREADABLE;
  }
  if (!isPlainObject(data)) return UNREADABLE;
  const states = isPlainObject(data.holds) ? data.holds : {};
  const times = isPlainObject(data.at) ? data.at : {};
  const placers = isPlainObject(data.by) ? data.by : {};
  const holds = new Map<string, Hold>();
  for (const [id, state] of Object.entries(states)) {
    if (!HERMES_JOB_ID_RE.test(id) || !isHoldState(state)) continue;
    const hold: Hold = { state };
    const at = Object.hasOwn(times, id) ? times[id] : undefined;
    if (isHoldAt(at)) hold.at = at;
    const by = Object.hasOwn(placers, id) ? placers[id] : undefined;
    if (isHoldBy(by)) hold.by = by;
    holds.set(id, hold);
  }
  return { status: "ok", holds };
}

/**
 * The holds file, read as the control plane reads it (job-control.js
 * READ_HOLDS_CMD, `head -c 65536`, then parseHolds): its first
 * HOLDS_MAX_BYTES bytes, decoded as UTF-8 with replacement characters, then
 * parsed. A longer file is not unreadable by itself: its prefix is what is
 * parsed. Missing is no holds. A path that is not a regular file, a failed
 * read, or a prefix that is not a JSON object is unreadable.
 */
export function readHolds(home: string): HoldsRead {
  const path = jobHoldsPath(home);
  try {
    // Checked before the open, so a FIFO or a directory is never opened.
    if (!statSync(path).isFile()) return UNREADABLE;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT" ? { status: "ok", holds: new Map() } : UNREADABLE;
  }
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    return UNREADABLE;
  }
  try {
    if (!fstatSync(fd).isFile()) return UNREADABLE;
    const buffer = Buffer.alloc(HOLDS_MAX_BYTES);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    return parseHolds(buffer.toString("utf8", 0, length));
  } catch {
    return UNREADABLE;
  } finally {
    closeSync(fd);
  }
}

/**
 * The file's text for `holds`, in the control plane's format
 * (job-control.js writeHoldsCmd): one line,
 * `{"version":1,"holds":{...},"at":{...},"by":{...}}`, `at` and `by` only for
 * ids in `holds` and left out when empty. Every value is checked again; a bad
 * one throws and nothing is written.
 */
export function holdsFileText(holds: Map<string, Hold>): string {
  const states: Record<string, string> = {};
  const times: Record<string, string> = {};
  const placers: Record<string, string> = {};
  for (const [id, hold] of holds) {
    if (!HERMES_JOB_ID_RE.test(id) || !isHoldState(hold.state)) throw new Error("hold-invalid");
    states[id] = hold.state;
    if (hold.at !== undefined) {
      if (!isHoldAt(hold.at)) throw new Error("hold-invalid");
      times[id] = hold.at;
    }
    if (hold.by !== undefined) {
      if (!isHoldBy(hold.by)) throw new Error("hold-invalid");
      placers[id] = hold.by;
    }
  }
  const body = {
    version: 1,
    holds: states,
    ...(Object.keys(times).length ? { at: times } : {}),
    ...(Object.keys(placers).length ? { by: placers } : {}),
  };
  return `${JSON.stringify(body)}\n`;
}

/** Replace the holds file whole: a temp file beside it, then a rename. */
function writeHolds(home: string, holds: Map<string, Hold>): void {
  const path = jobHoldsPath(home);
  const text = holdsFileText(holds);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o644, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw err;
  }
}

/** Who placed a hold, as the control plane reads it: a hold without a known `by` is an admin's. */
function placedBy(hold: Hold): HoldBy {
  return hold.by ?? "admin";
}

/** What a job's entry reads as: its state, or `cleared` when it has none. */
type HoldWord = "paused" | "active" | "cleared";

function wordOf(hold: Hold | undefined): HoldWord {
  return hold ? hold.state : "cleared";
}

function sameHold(a: Hold | undefined, b: Hold | undefined): boolean {
  return a?.state === b?.state && a?.at === b?.at && a?.by === b?.by;
}

function isContactStyle(job: LabelJob): boolean {
  return (CONTACT_STYLE_JOB_NAMES as readonly string[]).includes(job.name);
}

/** The entry the asked action leaves on a job: pause `paused`; resume `active` on a contact-style job, none on any other. */
function targetWord(action: "pause" | "resume", job: LabelJob): HoldWord {
  if (action === "pause") return "paused";
  return isContactStyle(job) ? "active" : "cleared";
}

/**
 * The entry this run writes for one job, or undefined to leave it as it is
 * (`willChange`: Hermes's state is about to change):
 * - pause: `paused`, `by: resident`, now. An admin's `paused` hold is kept as
 *   it is, and so is the resident's own when the job is already paused.
 * - resume: a contact-style job holds `active`, `by: resident`, now (an
 *   admin's `active` hold is kept, and so is the resident's own when the job
 *   is already running); any other job's entry is removed, as the control
 *   plane's resume route does. A `paused` hold by an admin or the settings
 *   never reaches here: the resume is refused first.
 */
function plannedHold(current: Hold | undefined, action: "pause" | "resume", job: LabelJob, willChange: boolean, at: string): { next: Hold | undefined } | undefined {
  const by = current ? placedBy(current) : null;
  const target = targetWord(action, job);
  if (target === "cleared") return current ? { next: undefined } : undefined;
  if (current?.state === target && (by === "admin" || (by === "resident" && !willChange))) return undefined;
  return { next: { state: target, at, by: "resident" } };
}

/**
 * A resume refused before anything changed: the holds file cannot be read
 * (every control-plane resume path fails closed on it too), or a job of the
 * label is held `paused` by the Edge City team or by the app's settings.
 */
function resumeRefusal(action: "pause" | "resume", holds: HoldsRead, jobs: LabelJob[], label: MessageLabel): CommandResult | null {
  if (action !== "resume") return null;
  if (holds.status === "unreadable") return refused("holds-unreadable", { label });
  for (const job of jobs) {
    const hold = holds.holds.get(job.id);
    if (hold?.state !== "paused") continue;
    if (placedBy(hold) === "admin") return refused("held-by-admin", { label });
    if (placedBy(hold) === "desired") return refused("held-by-settings", { label });
  }
  return null;
}

// ── Commands ────────────────────────────────────────────────────────────────

/** The jobs lock is no longer this run's, or would go stale before the next step could finish. */
class LockLost extends Error {
  constructor() {
    super("lock-lost");
  }
}

interface JobResult {
  id: string;
  changed: boolean;
  missedSlot?: "dropped";
  resumeMayFire?: true;
}

interface Failure {
  error: string;
  step?: string;
}

function hermesFailure(err: unknown): string {
  return err instanceof HermesTimeout ? "hermes-timeout" : "hermes-failed";
}

/**
 * pause or resume, holding the jobs lock. Refuses in this order: the job
 * store, job lookup, a resume the holds file does not allow, Hermes
 * availability. Then:
 * 1. the holds, written first, so the control plane never sees the job
 *    changed and not yet held;
 * 2. each job's Hermes step;
 * 3. for a job whose Hermes step did not happen, its entry put back as it
 *    was, so the file never claims a state Hermes refused.
 */
function changeCommand(
  action: "pause" | "resume",
  label: MessageLabel,
  home: string,
  ctx: PauseJobContext,
  guard: (budgetMs: number) => void,
): CommandResult {
  const clock = ctx.clock ?? Date.now;
  const now = (): Date => new Date(clock());
  const timeoutMs = ctx.hermesTimeoutMs ?? HERMES_TIMEOUT_MS;
  const store = readJobsStore(home);
  if ("unreadable" in store) return refused("jobs-store-unreadable");
  const jobs = labelJobs(store.jobs, label, readInstalledIds(home));
  if (jobs.length === 0) return refused("job-missing", { label });
  const refusal = resumeRefusal(action, readHolds(home), jobs, label);
  if (refusal) return refusal;

  const wantEnabled = action === "resume";
  const willChange = (job: LabelJob): boolean => storedJobEnabled(job.raw) !== wantEnabled;
  // A resume also re-anchors a running job whose next run is already due: an
  // earlier run that resumed it and was cut off before its re-anchor (B1).
  const needsHermes = (job: LabelJob): boolean => willChange(job) || (wantEnabled && missedSlot(job.raw, now()));
  if (jobs.some(needsHermes) && !ctx.hermesReady()) return refused("hermes-unavailable", { label });

  // 1. The holds first: read again right before the write, and only this run's entries changed.
  let holdsStatus: "ok" | "unreadable" = "ok";
  const placed = new Map<string, { previous: Hold | undefined; next: Hold | undefined }>();
  const current = readHolds(home);
  if (current.status === "unreadable") {
    // Pause still runs (fewer messages is the safe direction) and writes nothing; resume never runs blind.
    if (action === "resume") return refused("holds-unreadable", { label });
    holdsStatus = "unreadable";
  } else {
    const again = resumeRefusal(action, current, jobs, label);
    if (again) return again;
    const at = now().toISOString();
    for (const job of jobs) {
      const plan = plannedHold(current.holds.get(job.id), action, job, willChange(job), at);
      if (!plan) continue;
      placed.set(job.id, { previous: current.holds.get(job.id), next: plan.next });
      if (plan.next) current.holds.set(job.id, plan.next);
      else current.holds.delete(job.id);
    }
    if (placed.size > 0) {
      try {
        guard(0);
        writeHolds(home, current.holds);
      } catch (err) {
        return failed(err instanceof LockLost ? "lock-lost" : "hold-write-failed", { label, applied: [], hold: null, holds: "ok" });
      }
    }
  }

  // 2. Hermes.
  const results: JobResult[] = [];
  const applied: string[] = [];
  const reached = new Set<string>();
  let failure: Failure | null = null;
  let mayFire = false;
  const hermes = (args: string[]): void => {
    guard(timeoutMs);
    ctx.hermes(args);
  };
  for (const job of jobs) {
    const result: JobResult = { id: job.id, changed: false };
    if (willChange(job)) {
      try {
        hermes(["cron", action, job.id]);
      } catch (err) {
        // A Hermes that saved and then failed (or was killed) still changed the job: read back, and say so.
        if (enabledIs(home, job.id, wantEnabled)) {
          applied.push(job.id);
          reached.add(job.id);
          const latest = rereadJob(home, job.id);
          if (wantEnabled && latest && missedSlot(latest, now())) mayFire = true;
        }
        failure = err instanceof LockLost ? { error: "lock-lost" } : { error: hermesFailure(err), step: action };
        break;
      }
      if (!enabledIs(home, job.id, wantEnabled)) {
        failure = { error: "readback-mismatch", step: action };
        break;
      }
      applied.push(job.id);
      result.changed = true;
    }
    reached.add(job.id);
    results.push(result);
    if (!wantEnabled) continue;
    // AC#2: a resume asked in chat never sends the missed slot at once.
    // Hermes's resume keeps a passed next run as due and the next tick fires
    // it (cron/jobs.py:2080-2105); a schedule edit on a running job recomputes
    // the next run from now (cron/jobs.py:1994-2004), so the schedule is
    // re-applied after the resume, in its canonical form. The job is read
    // again first, so the check is by Hermes's own state after the resume. A
    // running job whose next run is already due (an earlier run cut off
    // before its re-anchor) gets the same re-anchor, so a retry finishes it.
    // Unlike install/jobs.ts set, this happens for a job with a delivery
    // window too: the resident asked for the message to come back at its
    // usual time, not now. The two Hermes commands are separate processes,
    // so a tick between them can still fire the slot (docs/design/
    // job-settings.md, "Resident holds").
    const latest = rereadJob(home, job.id) ?? job.raw;
    if (!missedSlot(latest, now())) continue;
    const cron = parseStoredCron(rawSchedule(latest));
    if (!cron) {
      result.resumeMayFire = true;
      mayFire = true;
      continue;
    }
    try {
      hermes(["cron", "edit", job.id, "--schedule", cron.expr]);
    } catch (err) {
      mayFire = true;
      failure = err instanceof LockLost ? { error: "lock-lost" } : { error: hermesFailure(err), step: "reanchor" };
      break;
    }
    const after = rereadJob(home, job.id);
    if (after && !missedSlot(after, now())) {
      result.missedSlot = "dropped";
    } else {
      result.resumeMayFire = true;
      mayFire = true;
    }
  }

  // 3. Put back the entry of every job Hermes did not bring to the asked state.
  // Only an entry that still reads as this run wrote it: anything written
  // since is someone else's, and stays.
  let holdError: string | undefined;
  const undo = [...placed].filter(([id]) => !reached.has(id));
  if (undo.length > 0) {
    const fresh = readHolds(home);
    if (fresh.status === "unreadable") {
      holdError = "hold-restore-failed";
    } else {
      let changed = false;
      for (const [id, { previous, next }] of undo) {
        if (!sameHold(fresh.holds.get(id), next)) continue;
        if (previous) fresh.holds.set(id, previous);
        else fresh.holds.delete(id);
        changed = true;
      }
      if (changed) {
        try {
          writeHolds(home, fresh.holds);
        } catch {
          holdError = "hold-restore-failed";
        }
      }
    }
  }

  // The hold the reply reports: the asked one, when the file now holds it for every job of the label.
  let hold: HoldWord | null = null;
  if (holdsStatus === "ok") {
    const end = readHolds(home);
    if (end.status === "unreadable") {
      holdsStatus = "unreadable";
    } else {
      const words = jobs.map((job) => (wordOf(end.holds.get(job.id)) === targetWord(action, job) ? targetWord(action, job) : null));
      if (words.every((word) => word !== null && word === words[0])) hold = words[0];
    }
  }

  const tail = { hold, holds: holdsStatus, ...(mayFire ? { resumeMayFire: true } : {}) };
  if (failure) {
    const { error, step } = failure;
    return failed(error, { ...(step ? { step } : {}), label, applied, ...tail, ...(holdError ? { holdError } : {}) });
  }
  return ok({ action, label, jobs: results, ...tail });
}

/** Each label (or the one asked for): whether it is installed, and each job's state and hold. Read-only: no lock, no Hermes. */
function statusCommand(home: string, all: unknown[], label: MessageLabel | null): CommandResult {
  const installed = readInstalledIds(home);
  const holds = readHolds(home);
  const now = new Date();
  const labels = (label ? [label] : MESSAGE_LABEL_NAMES).map((name) => {
    const jobs = labelJobs(all, name, installed);
    return {
      label: name,
      installed: jobs.length > 0,
      jobs: jobs.map((job) => {
        const held = holds.status === "ok" ? holds.holds.get(job.id) : undefined;
        return {
          id: job.id,
          enabled: storedJobEnabled(job.raw),
          hold: held?.state ?? null,
          by: held ? placedBy(held) : null,
          nextRunDue: missedSlot(job.raw, now),
        };
      }),
    };
  });
  return ok({ action: "status", labels, holds: holds.status });
}

/** The context the script runs with on a box: the Hermes CLI as the installer finds it, on this home. */
export function defaultContext(home: string): PauseJobContext {
  const bin = hermesBin();
  // Hermes reads this home, whatever the caller's own; the caller's zone is not
  // passed on, so Hermes reads the tenant's `.env` and config.yaml (as install/jobs.ts).
  const env: NodeJS.ProcessEnv = { ...hermesExecEnv(), HERMES_HOME: home };
  delete env.HERMES_TIMEZONE;
  return {
    hermes: hermesRunner(bin, env, HERMES_TIMEOUT_MS, "ignore"),
    hermesReady: () => hermesAvailable(bin, HERMES_TIMEOUT_MS, env),
  };
}

/**
 * Run one command. Never throws: an unexpected error is `{"ok": false,
 * "error": "fault"}`, exit 1. Refuses in this order: the arguments, the home
 * and its job store, the lock (`busy`), then changeCommand's own.
 */
export function runPauseJob(argv: string[], contextFor: (home: string) => PauseJobContext = defaultContext): CommandResult {
  let lock: HeldLock | null = null;
  try {
    const request = parseArgs(argv);
    if (isResult(request)) return request;
    const home = resolveHome(request.home);
    if (!isDirectory(home)) return refused("jobs-store-unreadable");
    const store = readJobsStore(home);
    if ("unreadable" in store) return refused("jobs-store-unreadable");
    if (request.action === "status") return statusCommand(home, store.jobs, request.label);
    // Looked up once before the lock too, so a home with none of the label's jobs is left untouched (no av-events/ made for the lock).
    if (labelJobs(store.jobs, request.label!, readInstalledIds(home)).length === 0) return refused("job-missing", { label: request.label });
    const ctx = contextFor(home);
    const clock = ctx.clock ?? Date.now;
    lock = tryAcquireLock(jobsLockPath(home), { now: clock });
    if (!lock) return { code: EXIT.busy, out: { ok: false, error: "busy" } };
    const held = lock;
    const since = clock();
    const guard = (budgetMs: number): void => {
      if (!holdsLock(held) || clock() - since + budgetMs >= LOCK_STALE_MS) throw new LockLost();
    };
    return changeCommand(request.action, request.label!, home, ctx, guard);
  } catch {
    return failed("fault");
  } finally {
    // Removes the lock file only while it still holds this run's token.
    lock?.release();
  }
}

if (import.meta.main) {
  // stdout carries only the one result line, and stderr nothing.
  const quiet = (): void => {};
  console.log = quiet;
  console.info = quiet;
  console.warn = quiet;
  console.error = quiet;
  console.debug = quiet;
  const result = runPauseJob(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(result.out)}\n`, () => process.exit(result.code));
}
