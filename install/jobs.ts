#!/usr/bin/env bun
/**
 * Per-tenant job commands (J2, overlay half): what the control plane runs
 * inside one tenant to change that tenant's proactive jobs without a roll.
 * The contract, with every output shape and refusal code, is
 * docs/design/job-settings.md.
 *
 *   bun install/jobs.ts list
 *   bun install/jobs.ts set --job <key> [--schedule "<cron>"|default [--allow-frequent]] [--window HH:MM-HH:MM|default] [--tz <zone>|default] [--enabled true|false]
 *   bun install/jobs.ts add --template <brief|digest-preview|evening-ask> --schedule "<cron>" [--allow-frequent] [--window HH:MM-HH:MM] [--tz <zone>]
 *   bun install/jobs.ts remove --template <name>
 *   bun install/jobs.ts preview --job <key>
 *
 * Every command prints exactly one line of JSON on stdout (`{"ok": true, ...}`
 * or `{"ok": false, "error": "<code>", ...}`); everything else goes to
 * stderr. Exit codes: 0 done; 1 a step failed on the way (`applied` lists
 * what is left changed; not a plain retry: read back with `list` first);
 * 2 refused before anything changed; 3 a preview refused on a tenant that is
 * not a team tenant; 4 `busy`: another job command holds the tenant's jobs
 * lock, nothing changed, retry shortly.
 *
 * Every value is checked against a fixed grammar before use; a schedule is
 * sent to Hermes only in its canonical form (job-settings.ts parseStrictCron)
 * and read back. Hermes is only ever started as an argv (execFileSync), never
 * through a shell, only with a job id of Hermes's own shape, and never for
 * longer than HERMES_TIMEOUT_MS. Nothing free-form read from `jobs.json` or
 * the settings file is ever printed.
 *
 * Environment: run it with HERMES_HOME set to the tenant's home. Everything
 * about the tenant is read from files under it: `cron/jobs.json`, the
 * settings file, `.env` (Hermes's zone, the stagger seed) and `config.yaml`
 * (Hermes's zone). The caller's own HERMES_TIMEZONE is never read, and is not
 * passed on to Hermes. (The Hermes binary is found as the installer finds it,
 * and the preview gate reads AV_TEAM_TENANT as job-settings.ts isTeamTenant says.)
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import { dotenvValue } from "./config";
import { hermesBin, hermesExecEnv } from "./hermes_cli";
import {
  DIGEST_CRON_SPECS,
  PROACTIVE_SHIM,
  type DigestCronSpec,
  type StoredCronJob,
  cronCreateArgs,
  cronEditArgs,
  defaultScheduleFor,
  expectedCronScriptArg,
  hermesAvailable,
  installedJobsPath,
  persistedEnvVar,
  readCronPromptBody,
  staleShapeFields,
  storedJobEnabled,
  templateCronSpec,
  writeInstalledJobIds,
} from "./install_index";
import { hermesHome } from "./paths";
import {
  DEFAULT_TZ,
  DEFAULT_WINDOWS,
  SETTINGS_JOB_KEYS,
  type DeliveryWindow,
  type JobKey,
  type ParsedCron,
  type TemplateName,
  adminScheduleKeys,
  cronFrequent,
  cronLeapDayOnly,
  cronNeverFires,
  formatWindow,
  isDefaultJobKey,
  isJobKey,
  isTeamTenant,
  isTemplateName,
  isValidTimeZone,
  parseStoredCron,
  parseStrictCron,
  parseWindow,
  prunePreviewFiles,
  readJobSettings,
  replaceSettingsFile,
  scheduleAdminManaged,
  scheduleWindowFit,
  settingsFileBytes,
  settingsFileText,
  validateEntry,
} from "../skills/index-network/scripts/job-settings";
import { type HeldLock, LOCK_STALE_MS, holdsLock, tryAcquireLock } from "../skills/index-network/scripts/state-lock";

/** The one preview job's name; reconcile removes it on the next roll like any retired name. */
export const PREVIEW_JOB_NAME = "Edge — preview";
/** When the preview job fires: a Hermes one-shot, retired by Hermes after its one run. */
export const PREVIEW_FIRES = "in 1m";

/** Put in front of the job's own prompt for a preview, so the message says it is a test. */
export const PREVIEW_PREAMBLE = [
  "TEST PREVIEW. A member of the Edge City team asked to see this job's message now, on their own test agent. It is not a scheduled message.",
  "Start your reply with the line `[TEST PREVIEW]`, then write the message exactly as the job prompt below says.",
  "When the job prompt says to reply exactly `[SILENT]`, reply exactly `[SILENT]`.",
  "",
  "---",
  "",
].join("\n");

/** Exit codes (docs/design/job-settings.md §2). */
export const EXIT = { done: 0, failed: 1, refused: 2, notTeam: 3, busy: 4 } as const;

/** Hermes's job id: `uuid.uuid4().hex[:12]` (cron/jobs.py:1781 at v2026.9.24). Any other id is never used or printed. */
export const HERMES_ID_RE = /^[0-9a-f]{12}$/;

/** Every argument value is at most this long. */
export const MAX_ARG_CHARS = 200;

/**
 * One Hermes command is killed after this: comfortably below the jobs lock's
 * stale time (LOCK_STALE_MS, 150 s), so a hung CLI cannot hold the lock until
 * another command takes it over while this one may still write.
 */
export const HERMES_TIMEOUT_MS = 60_000;

/** A larger `cron/jobs.json` is unreadable (`jobs-store-unreadable`). */
export const MAX_JOBS_STORE_BYTES = 16 * 1024 * 1024;

/** The five default jobs, the only ones `--schedule default` and admin marks apply to. */
const DEFAULT_JOB_KEYS = SETTINGS_JOB_KEYS.filter(isDefaultJobKey);

/** The tenant's jobs lock: one mutating command at a time (stale after LOCK_STALE_MS, as the state lock). */
export function jobsLockPath(home: string): string {
  return join(home, "av-events", "jobs.lock");
}

export interface CommandResult {
  code: number;
  out: Record<string, unknown>;
}

export interface JobsContext {
  home: string;
  /** Runs one Hermes command (argv after the binary); throws on a non-zero exit, HermesTimeout when killed at its timeout. */
  hermes: (args: string[]) => void;
  /** Whether the Hermes CLI runs at all. */
  hermesReady: () => boolean;
  now: Date;
  /** The real clock, for the lock's age (tests move it); Date.now by default. */
  clock?: () => number;
}

/** A Hermes command killed at HERMES_TIMEOUT_MS. */
export class HermesTimeout extends Error {
  constructor() {
    super("hermes-timeout");
    this.name = "HermesTimeout";
  }
}

/** The jobs lock is no longer this command's, or would go stale before the next step could finish. */
class LockLost extends Error {
  /** Fields the `lock-lost` reply adds (`resumeMayFire` after a resume whose re-anchor never ran). */
  constructor(readonly extra: Record<string, unknown> = {}) {
    super("lock-lost");
  }
}

/** `cron/jobs.json` is present and cannot be read as Hermes's job list. */
class StoreUnreadable extends Error {}

/** The context a mutating command runs in: every write first checks the lock (`guard`). */
interface GuardedContext extends JobsContext {
  /** Throws LockLost unless the lock is still held and a step of `budgetMs` ends before it goes stale. */
  guard: (budgetMs: number) => void;
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

/** A lost lock or an unreadable store is not a step's failure: it stops the whole command (runJobsCommand). */
function passUp(err: unknown): void {
  if (err instanceof LockLost || err instanceof StoreUnreadable) throw err;
}

/** A Hermes step that failed: `hermes-timeout` when it was killed at its timeout, else `hermes-failed`. */
function hermesFailure(err: unknown, extra: Record<string, unknown>): CommandResult {
  return failed(err instanceof HermesTimeout ? "hermes-timeout" : "hermes-failed", extra);
}

/** Write the settings file, once the lock is known to be still held. */
function writeSettings(ctx: GuardedContext, text: string | null): void {
  ctx.guard(0);
  replaceSettingsFile(ctx.home, text);
}

/** Write `installed_jobs.json`, once the lock is known to be still held. */
function writeIds(ctx: GuardedContext, ids: string[]): void {
  ctx.guard(0);
  writeInstalledJobIds(ctx.home, ids);
}

// ── Arguments ───────────────────────────────────────────────────────────────

const COMMAND_FLAGS: Record<string, { required: string[]; optional: string[]; switches: string[] }> = {
  list: { required: [], optional: [], switches: [] },
  set: { required: ["--job"], optional: ["--schedule", "--window", "--tz", "--enabled"], switches: ["--allow-frequent"] },
  add: { required: ["--template", "--schedule"], optional: ["--window", "--tz"], switches: ["--allow-frequent"] },
  remove: { required: ["--template"], optional: [], switches: [] },
  preview: { required: ["--job"], optional: [], switches: [] },
};

/**
 * `<command> --flag value ... [--switch]`, each flag once and only the
 * command's own (a switch such as `--allow-frequent` takes no value); or the
 * refusal.
 */
export function parseCommand(argv: string[]): { command: string; flags: Map<string, string> } | CommandResult {
  const [command, ...rest] = argv;
  const spec = command === undefined ? undefined : COMMAND_FLAGS[command];
  if (!spec) return refused("unknown-command");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; ) {
    const flag = rest[i];
    const isSwitch = spec.switches.includes(flag);
    if (!isSwitch && ![...spec.required, ...spec.optional].includes(flag)) return refused("unknown-flag");
    if (flags.has(flag)) return refused("duplicate-flag", { flag });
    if (isSwitch) {
      flags.set(flag, "true");
      i += 1;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.length > MAX_ARG_CHARS) return refused("missing-value", { flag });
    flags.set(flag, value);
    i += 2;
  }
  for (const flag of spec.required) if (!flags.has(flag)) return refused("missing-flag", { flag });
  // `--allow-frequent` qualifies a schedule: alone it means nothing.
  if (flags.has("--allow-frequent") && !flags.has("--schedule")) return refused("missing-flag", { flag: "--schedule" });
  return { command, flags };
}

/** A settings field from a flag: a value, `default` (remove the override), or absent. */
type FieldChange = { set: string } | { clear: true } | undefined;

function fieldChange(value: string | undefined, valid: (raw: string) => boolean): FieldChange | "invalid" {
  if (value === undefined) return undefined;
  if (value === "default") return { clear: true };
  return valid(value) ? { set: value } : "invalid";
}

/** A schedule flag: canonical, or the refusal (outside the grammar, never fires, or too frequent without leave). */
function scheduleFlag(raw: string, allowFrequent: boolean): ParsedCron | CommandResult {
  const cron = parseStrictCron(raw);
  if (!cron) return refused("invalid-schedule");
  if (cronNeverFires(cron) || cronLeapDayOnly(cron)) return refused("schedule-never-fires");
  if (cronFrequent(cron) && !allowFrequent) return refused("schedule-frequent");
  return cron;
}

function isResult(value: unknown): value is CommandResult {
  return Boolean(value) && typeof value === "object" && "code" in (value as object) && "out" in (value as object);
}

// ── Jobs ────────────────────────────────────────────────────────────────────

/** The spec that names a job key's Hermes job; a template's schedule is filled in by the caller. */
export function specForKey(key: JobKey, schedule = ""): DigestCronSpec {
  if (key.startsWith("tpl-")) return templateCronSpec(key.slice(4) as TemplateName, schedule);
  const spec = DIGEST_CRON_SPECS.find((entry) => entry.scriptInstallName === `agentvillage_proactive_${key}.sh`);
  if (!spec) throw new Error(`no spec for ${key}`);
  return spec;
}

/** A Hermes job this command may use: its id has Hermes's shape. */
type UsableJob = StoredCronJob & { id: string };

/**
 * Hermes's job store, `$HERMES_HOME/cron/jobs.json`, as these commands read
 * it. No file is no jobs (as Hermes reads it). A file that is not a regular
 * file, is over MAX_JOBS_STORE_BYTES, cannot be read, is not JSON, or is not
 * `{"jobs": [...]}` (an object without `jobs` is no jobs, as Hermes reads it)
 * is unreadable: never "no jobs", so `list` never reports a job `missing`
 * because of it. Reconcile's own reader (install_index.ts readCronJobs) is
 * unchanged. (Hermes repairs some shapes on its next write: a bare list, an
 * id-keyed map, control characters in strings. They are unreadable here until then.)
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

/** Every job in the store, or StoreUnreadable. */
function storeJobs(home: string): unknown[] {
  const store = readJobsStore(home);
  if ("unreadable" in store) throw new StoreUnreadable();
  return store.jobs;
}

/**
 * The Hermes jobs named exactly `name`, read defensively from `jobs.json`
 * (which the resident can write): every one usable, or `unreadable` when any
 * has an id outside Hermes's shape, in which case none is used.
 */
function jobsNamed(home: string, name: string): { jobs: UsableJob[] } | { unreadable: true } {
  return namedIn(storeJobs(home), name);
}

function namedIn(all: unknown[], name: string): { jobs: UsableJob[] } | { unreadable: true } {
  const named = all.filter(
    (job): job is StoredCronJob => Boolean(job) && typeof job === "object" && (job as StoredCronJob).name === name,
  );
  if (named.some((job) => typeof job.id !== "string" || !HERMES_ID_RE.test(job.id))) return { unreadable: true };
  return { jobs: named as UsableJob[] };
}

/** The job a key names with this id, as `jobs.json` holds it now. */
function rereadJob(home: string, key: JobKey, id: string): UsableJob | undefined {
  const found = jobsNamed(home, specForKey(key).name);
  return "jobs" in found ? found.jobs.find((job) => job.id === id) : undefined;
}

/** Whether that job's stored schedule is now exactly `expr` (the read-back after an edit). */
function scheduleIs(home: string, key: JobKey, id: string, expr: string): boolean {
  const job = rereadJob(home, key, id);
  return job !== undefined && rawSchedule(job) === expr;
}

/** The ids of every job now in `jobs.json` that has Hermes's shape. */
function usableIds(home: string): Set<string> {
  return new Set(
    storeJobs(home)
      .map((job) => (job && typeof job === "object" ? (job as StoredCronJob).id : undefined))
      .filter((id): id is string => typeof id === "string" && HERMES_ID_RE.test(id)),
  );
}

/** The schedule text a stored job holds, read defensively (never trusted, never printed). */
function rawSchedule(job: StoredCronJob): string {
  const schedule: unknown = job.schedule;
  if (typeof schedule === "string") return schedule.trim();
  if (schedule && typeof schedule === "object" && typeof (schedule as { expr?: unknown }).expr === "string") return (schedule as { expr: string }).expr.trim();
  return typeof job.schedule_display === "string" ? job.schedule_display.trim() : "";
}

/**
 * The stored schedule when it is readable: canonical exactly, up to the
 * canonical bound rather than the input bound, so every schedule these
 * commands set reads back (job-settings.ts parseStoredCron). A schedule in any
 * other form is not guessed at.
 */
function storedCron(job: StoredCronJob): ParsedCron | null {
  return parseStoredCron(rawSchedule(job));
}

/** The schedule as printed: the canonical form, or null with `scheduleUnreadable`. */
function scheduleOut(job: StoredCronJob): { schedule: string | null; scheduleUnreadable?: true } {
  const cron = storedCron(job);
  return cron ? { schedule: cron.expr } : { schedule: null, scheduleUnreadable: true };
}

/** Whether the job's stored next run is already due (an occurrence passed while it was paused), by Hermes's clock: the real one. */
function missedSlot(job: StoredCronJob, now: Date): boolean {
  const next = (job as { next_run_at?: unknown }).next_run_at;
  if (typeof next !== "string") return false;
  const at = Date.parse(next);
  return Number.isFinite(at) && at <= now.getTime();
}

function readInstalledIds(home: string): string[] {
  try {
    const raw = JSON.parse(readFileSync(installedJobsPath(home), "utf8")) as { ids?: unknown };
    return Array.isArray(raw.ids) ? raw.ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** The prompt and the shim a job needs, present before Hermes is asked to point a job at them. */
function filesMissing(home: string, spec: DigestCronSpec): CommandResult | null {
  if (spec.promptFile && !existsSync(join(home, "skills", spec.promptFile))) return failed("prompt-missing", { applied: [] });
  if (!existsSync(join(home, "skills", PROACTIVE_SHIM))) return failed("shim-missing", { applied: [] });
  return null;
}

function installShim(ctx: GuardedContext, scriptName: string): void {
  ctx.guard(0);
  mkdirSync(join(ctx.home, "scripts"), { recursive: true });
  copyFileSync(join(ctx.home, "skills", PROACTIVE_SHIM), join(ctx.home, "scripts", scriptName));
}

// ── Settings ────────────────────────────────────────────────────────────────

type Entry = { window?: string; tz?: string };

interface CurrentSettings {
  /** The file's bytes now (null: no file), restored on a rollback. */
  bytes: string | null;
  jobs: Record<string, unknown>;
  adminSchedules: JobKey[];
  /** The file was unreadable and a rewrite replaces it: `invalid:<code>`. */
  replaced?: string;
  /**
   * `adminSchedules` held entries that are not default job keys (a rewrite
   * keeps only the keys), or was not a list at all (a rewrite writes all five
   * default keys, the jobs reconcile was already treating as admin-managed).
   */
  adminDropped?: true;
  /**
   * `adminSchedules` was not a list: a rewrite writes all five default keys,
   * so every default job is now admin-managed on file. The reply says so as
   * `adminSchedulesRepaired: true`, beside `dropped: ["adminSchedules"]`.
   */
  adminRepaired?: true;
}

function currentSettings(home: string): CurrentSettings {
  const bytes = settingsFileBytes(home);
  const read = readJobSettings(home);
  if (read.status === "absent") return { bytes, jobs: {}, adminSchedules: [] };
  if (read.status === "invalid") return { bytes, jobs: {}, adminSchedules: [], replaced: `invalid:${read.code}` };
  const admin = adminScheduleKeys(read);
  return {
    bytes,
    jobs: { ...read.jobs },
    adminSchedules: admin.invalid ? [...DEFAULT_JOB_KEYS] : admin.keys,
    ...(admin.invalid || admin.ignored ? { adminDropped: true as const } : {}),
    ...(admin.invalid ? { adminRepaired: true as const } : {}),
  };
}

/**
 * One job's entry after a change: each field the change names is set or
 * removed; each other field is kept when it is valid and dropped (and
 * reported) when it is not; unknown fields are dropped.
 */
function mergeEntry(existing: unknown, window: FieldChange, tz: FieldChange): { entry: Entry; dropped: string[] } {
  const old = existing && typeof existing === "object" && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  const entry: Entry = {};
  const dropped: string[] = [];
  const keep = (field: "window" | "tz", change: FieldChange, valid: (raw: unknown) => boolean) => {
    if (change && "set" in change) entry[field] = change.set;
    else if (change) return;
    else if (old[field] !== undefined) {
      if (valid(old[field])) entry[field] = old[field] as string;
      else dropped.push(field);
    }
  };
  keep("window", window, (raw) => parseWindow(raw) !== null);
  keep("tz", tz, isValidTimeZone);
  if (existing !== undefined && !(existing && typeof existing === "object" && !Array.isArray(existing))) dropped.push("entry");
  return { entry, dropped };
}

/** The settings with one job's entry replaced (deleted when empty) and, maybe, its admin mark added or cleared. */
function nextSettingsText(current: CurrentSettings, key: JobKey, entry: Entry, admin: "add" | "clear" | "keep"): string | null {
  const jobs = { ...current.jobs };
  if (Object.keys(entry).length > 0) jobs[key] = entry;
  else delete jobs[key];
  const marks = new Set<string>(current.adminSchedules);
  if (admin === "add") marks.add(key);
  if (admin === "clear") marks.delete(key);
  return settingsFileText(jobs, [...marks]);
}

/** The window and zone an entry gives a job (its default window when the entry names none). */
function effective(key: JobKey, entry: Entry): { window: DeliveryWindow | null; tz: string } {
  const valid = validateEntry(entry);
  if ("invalid" in valid) throw new Error("merged entry invalid");
  return { window: valid.window ?? DEFAULT_WINDOWS[key] ?? null, tz: valid.tz ?? DEFAULT_TZ };
}

// ── Hermes's zone ───────────────────────────────────────────────────────────

/**
 * A zone name Hermes's zoneinfo accepts, as far as this runtime can tell: an
 * IANA key (`Area/Location`, a backward link such as `US/Eastern` or
 * `Asia/Calcutta`, `Etc/UTC`, `Etc/GMT+5`, `UTC`, `EST5EDT`) with IANA
 * capitalisation, which this runtime's zone database knows. Case variants
 * (`asia/kolkata`) and offsets are refused.
 */
export function isHermesZoneName(name: unknown): name is string {
  if (typeof name !== "string" || name.length > 64) return false;
  if (!/^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*)*$/.test(name)) return false;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    return !(resolved !== name && resolved.toLowerCase() === name.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Links the runtime does not resolve, to their canonical IANA zone: the
 * installer's other spelling of the village zone (install/config.ts
 * VILLAGE_ZONE_NAMES), and the backward links of UTC. Bun resolves no link
 * (`Asia/Calcutta` stays `Asia/Calcutta`); a runtime on ICU may resolve the
 * other way (`Asia/Kolkata` to `Asia/Calcutta`, `Etc/UTC` to `UTC`), so the
 * table applies after the runtime's own resolution and both ends meet.
 * Only these names resolve: any other pair of names for one zone
 * (`US/Eastern` and `America/New_York`, `Europe/Kiev` and `Europe/Kyiv`) is
 * two zones to hermesZone, refused as `hermes-zone-unknown`, which is the
 * conservative direction. Bun 1.4.2 (the CI pin) was checked to resolve no
 * link; a test pins it.
 */
const ZONE_LINKS: Record<string, string> = {
  "Asia/Calcutta": "Asia/Kolkata",
  UTC: "Etc/UTC",
  UCT: "Etc/UTC",
  Universal: "Etc/UTC",
  Zulu: "Etc/UTC",
  "Etc/UCT": "Etc/UTC",
  "Etc/Universal": "Etc/UTC",
  "Etc/Zulu": "Etc/UTC",
};

/** A zone name Hermes accepts, resolved to its canonical IANA zone: the runtime's resolution, then ZONE_LINKS. */
export function canonicalZone(name: string): string {
  let resolved = name;
  try {
    resolved = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    // not a zone this runtime knows: isHermesZoneName refuses it first
  }
  return ZONE_LINKS[resolved] ?? resolved;
}

/** The last assignment of `name` in the tenant's `<home>/.env`, as python-dotenv reads it (config.ts dotenvValue); undefined when none. */
function tenantDotenv(home: string, name: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(join(home, ".env"), "utf8");
  } catch {
    return undefined;
  }
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  let found: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const match = assignment.exec(line);
    if (match) found = dotenvValue(match[1] ?? "");
  }
  return found;
}

/**
 * The zone Hermes reads every schedule in, canonical, or null when it cannot
 * be determined. Hermes's CLI (hermes_time.py `_resolve_timezone_name`, which
 * `cron create|edit|resume` use to compute the next run) reads
 * `HERMES_TIMEZONE` first (its `.env` value overriding the process
 * environment: hermes_cli/env_loader.py:434), then `timezone` in config.yaml,
 * else the host's local time; the gateway, whose ticker fires the jobs, copies
 * config.yaml's `timezone` over `HERMES_TIMEZONE` at startup
 * (gateway/run.py:2087-2089), so there config.yaml wins.
 *
 * Only the tenant's files are read: `HERMES_TIMEZONE` in `<home>/.env` and
 * `timezone` in `<home>/config.yaml`, never the caller's process environment
 * (and defaultContext does not pass the caller's HERMES_TIMEZONE on to
 * Hermes, so the CLI reads the same two). Each set name must be one Hermes
 * accepts; the two are compared after canonicalZone, so two names of one zone
 * (`Asia/Calcutta`, `Asia/Kolkata`) agree. Null when neither is set (Hermes
 * would use the host's local time, unknown here), when a set name is not one
 * Hermes accepts (it would fall back to local time), or when the two name
 * different zones (the CLI and the ticker would disagree).
 */
export function hermesZone(home: string): string | null {
  const envZone = tenantDotenv(home, "HERMES_TIMEZONE")?.trim() || undefined;
  let configZone: string | undefined;
  try {
    const doc = YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")) as { timezone?: unknown } | null;
    if (doc && typeof doc === "object" && typeof doc.timezone === "string") configZone = doc.timezone.trim() || undefined;
  } catch {
    // no config, or unparseable (Hermes reads that as unset too)
  }
  const names = [envZone, configZone].filter((name): name is string => name !== undefined);
  if (names.length === 0 || !names.every(isHermesZoneName)) return null;
  const zones = [...new Set(names.map(canonicalZone))];
  return zones.length === 1 ? zones[0] : null;
}

/**
 * The window check, over a full year: refused when no firing ever lands in
 * the window, accepted with a warning when only some days do (DST in either
 * zone), accepted when every day does. Null: no window, so nothing to check.
 */
function windowCheck(
  ctx: JobsContext,
  cron: ParsedCron | null,
  delivery: { window: DeliveryWindow | null; tz: string },
): CommandResult | { check?: "skipped"; warning?: "window-seasonal"; outsideFrom?: string } | null {
  if (!delivery.window) return null;
  // A stored schedule that is not canonical (set by hand) cannot be checked.
  if (!cron) return { check: "skipped" };
  const zone = hermesZone(ctx.home);
  if (!zone) return refused("hermes-zone-unknown");
  const fit = scheduleWindowFit(cron, delivery.window, delivery.tz, zone, ctx.now);
  if (fit.fit === "no-firing") return refused("schedule-never-fires");
  if (fit.fit === "never") return refused("schedule-outside-window", { schedule: cron.expr, window: formatWindow(delivery.window), tz: delivery.tz });
  if (fit.fit === "seasonal") return { warning: "window-seasonal", outsideFrom: fit.outsideFrom };
  return {};
}

// ── Commands ────────────────────────────────────────────────────────────────

const LIST_ORDER: JobKey[] = ["brief", "drop-midday", "drop-evening", "negotiation", "evening", "tpl-brief", "tpl-digest-preview", "tpl-evening-ask"];

function describeJob(key: JobKey, job: UsableJob, settings: ReturnType<typeof readJobSettings>): Record<string, unknown> {
  let entry: Entry = {};
  let state = settings.status === "absent" ? "absent" : settings.status === "invalid" ? `invalid:${settings.code}` : "default";
  if (settings.status === "ok" && Object.prototype.hasOwnProperty.call(settings.jobs, key)) {
    const valid = validateEntry(settings.jobs[key]);
    if ("invalid" in valid) state = `invalid:${valid.invalid}`;
    else {
      state = "custom";
      entry = { ...(valid.window ? { window: formatWindow(valid.window) } : {}), ...(valid.tz ? { tz: valid.tz } : {}) };
    }
  }
  const delivery = effective(key, entry);
  return {
    key,
    id: job.id,
    name: specForKey(key).name,
    ...scheduleOut(job),
    enabled: storedJobEnabled(job),
    window: delivery.window ? formatWindow(delivery.window) : null,
    tz: delivery.tz,
    settings: state,
    // The same rule reconcile's legacy migration uses (job-settings.ts scheduleAdminManaged).
    adminSchedule: scheduleAdminManaged(key, settings),
  };
}

function listCommand(ctx: JobsContext): CommandResult {
  const settings = readJobSettings(ctx.home);
  const head = {
    settings: settings.status === "invalid" ? `invalid:${settings.code}` : settings.status,
    ...(adminScheduleKeys(settings).invalid ? { adminSchedulesInvalid: true } : {}),
  };
  // An unreadable store is never "no jobs": nothing is reported missing.
  const store = readJobsStore(ctx.home);
  if ("unreadable" in store) return ok({ store: "unreadable", ...head, jobs: [], missing: [], unreadable: [] });
  const jobs: Record<string, unknown>[] = [];
  const missing: string[] = [];
  const unreadable: string[] = [];
  for (const key of LIST_ORDER) {
    const found = namedIn(store.jobs, specForKey(key).name);
    if ("unreadable" in found) {
      unreadable.push(key);
      continue;
    }
    if (found.jobs.length === 0 && !key.startsWith("tpl-")) missing.push(key);
    for (const job of found.jobs) jobs.push(describeJob(key, job, settings));
  }
  return ok({ store: "ok", ...head, jobs, missing, unreadable });
}

/** The one Hermes job a key names, or the refusal. */
function theJob(home: string, key: JobKey): UsableJob | CommandResult {
  const found = jobsNamed(home, specForKey(key).name);
  if ("unreadable" in found) return refused("job-unreadable", { job: key });
  if (found.jobs.length === 0) return refused("job-not-installed", { job: key });
  if (found.jobs.length > 1) return refused("job-ambiguous", { job: key, count: found.jobs.length });
  return found.jobs[0];
}

interface SetRequest {
  key: JobKey;
  cron?: ParsedCron;
  /** `--schedule default`: the fleet's default schedule for this tenant, and the admin mark cleared. */
  scheduleDefault?: true;
  window: FieldChange;
  tz: FieldChange;
  enabled?: boolean;
}

function validateSet(flags: Map<string, string>): SetRequest | CommandResult {
  const key = flags.get("--job")!;
  if (!isJobKey(key)) return refused("invalid-job");
  let cron: ParsedCron | undefined;
  let scheduleDefault = false;
  if (flags.get("--schedule") === "default") {
    // Only a default job has a fleet schedule to go back to.
    if (!isDefaultJobKey(key)) return refused("invalid-schedule");
    scheduleDefault = true;
  } else if (flags.has("--schedule")) {
    const parsed = scheduleFlag(flags.get("--schedule")!, flags.has("--allow-frequent"));
    if (isResult(parsed)) return parsed;
    cron = parsed;
  }
  const window = fieldChange(flags.get("--window"), (raw) => parseWindow(raw) !== null);
  if (window === "invalid") return refused("invalid-window");
  const tz = fieldChange(flags.get("--tz"), isValidTimeZone);
  if (tz === "invalid") return refused("invalid-tz");
  const enabledFlag = flags.get("--enabled");
  if (enabledFlag !== undefined && enabledFlag !== "true" && enabledFlag !== "false") return refused("invalid-enabled");
  if (!cron && !scheduleDefault && !window && !tz && enabledFlag === undefined) return refused("nothing-to-set");
  return {
    key,
    cron,
    ...(scheduleDefault ? { scheduleDefault: true as const } : {}),
    window,
    tz,
    ...(enabledFlag === undefined ? {} : { enabled: enabledFlag === "true" }),
  };
}

/**
 * The fleet's default schedule for a default job on this tenant, as reconcile
 * computes it (install_index.ts defaultScheduleFor): the job's staggered slot
 * for the tenant's seed, `INDEX_API_KEY` as the installer persisted it in
 * `$HERMES_HOME/.env`, or the spec's own schedule with no seed. An
 * install-time override (`--digest-send-cron`, `DIGEST_SEND_CRON`) lives only
 * in a roll's own arguments and environment, and is not seen here.
 */
function fleetDefaultCron(home: string, key: JobKey): ParsedCron {
  const cron = parseStrictCron(defaultScheduleFor(specForKey(key), persistedEnvVar(home, "INDEX_API_KEY")));
  if (!cron) throw new Error("default schedule outside the grammar");
  return cron;
}

function setCommand(ctx: GuardedContext, req: SetRequest, applied: string[]): CommandResult {
  const { key, window, tz } = req;
  const job = theJob(ctx.home, key);
  if (isResult(job)) return job;
  if (!ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });

  const cron = req.cron ?? (req.scheduleDefault ? fleetDefaultCron(ctx.home, key) : undefined);
  const current = currentSettings(ctx.home);
  const { entry, dropped } = mergeEntry(current.jobs[key], window, tz);
  const delivery = effective(key, entry);
  const stored = storedCron(job);
  const schedule = cron ?? stored;
  // Pausing or resuming alone is never refused; a change of when or where is checked.
  const check = cron || window || tz ? windowCheck(ctx, schedule, delivery) : null;
  if (isResult(check)) return check;

  // 1. The schedule, in canonical form; Hermes keeps the job's id and pause state on an edit.
  if (cron && cron.expr !== rawSchedule(job)) {
    try {
      ctx.hermes(cronEditArgs(job.id, { schedule: cron.expr }));
    } catch (err) {
      passUp(err);
      // A Hermes that saved and then failed (or was killed) still changed the schedule: say so.
      if (scheduleIs(ctx.home, key, job.id, cron.expr)) applied.push("schedule");
      return hermesFailure(err, { step: "schedule", applied: [...applied] });
    }
    applied.push("schedule");
    if (!scheduleIs(ctx.home, key, job.id, cron.expr)) return failed("schedule-readback-mismatch", { applied: [...applied] });
  }
  // 2. The settings: the entry (deleted when empty) and, for a default job's
  // schedule, the admin mark that keeps reconcile's migration off it: added
  // by a schedule, cleared by `--schedule default`.
  let replaced: string | undefined;
  const settingsDropped = [...dropped, ...(current.adminDropped ? ["adminSchedules"] : [])];
  if (cron || window || tz) {
    const admin = !cron || !isDefaultJobKey(key) ? "keep" : req.scheduleDefault ? "clear" : "add";
    const text = nextSettingsText(current, key, entry, admin);
    if (text !== current.bytes) {
      try {
        writeSettings(ctx, text);
      } catch (err) {
        passUp(err);
        return failed("settings-write-failed", { applied: [...applied] });
      }
      applied.push("settings");
      replaced = current.replaced;
    }
  }
  // 3. Enabled is Hermes's pause state, the only place it is kept.
  let enabled = storedJobEnabled(job);
  const resume: Record<string, unknown> = {};
  if (req.enabled !== undefined && req.enabled !== enabled) {
    const latest = rereadJob(ctx.home, key, job.id) ?? job;
    const missed = req.enabled && missedSlot(latest, new Date());
    try {
      ctx.hermes(["cron", req.enabled ? "resume" : "pause", job.id]);
    } catch (err) {
      passUp(err);
      const now = rereadJob(ctx.home, key, job.id);
      const saved = now !== undefined && storedJobEnabled(now) === req.enabled;
      if (saved) applied.push("enabled");
      // Hermes saved the resume and then failed or was killed: the re-anchor
      // never ran, so a missed occurrence may fire at the next tick.
      return hermesFailure(err, { step: "enabled", applied: [...applied], ...(missed && saved ? { resumeMayFire: true } : {}) });
    }
    applied.push("enabled");
    enabled = req.enabled;
    // Hermes keeps an occurrence that passed while the job was paused as due,
    // and fires it at the next tick (cron/jobs.py resume_job, :2080-2105).
    // Re-applying the schedule re-anchors the next run from now
    // (tools/cronjob_tools.py:837-842, cron/jobs.py :1994-2004), so a job with
    // no window does not send at resume time. A job with a window keeps the
    // catch-up, which its window then gates.
    if (missed) {
      if (!delivery.window && schedule) {
        try {
          ctx.hermes(cronEditArgs(job.id, { schedule: schedule.expr }));
        } catch (err) {
          // The resume is applied and the re-anchor did not run: the missed
          // occurrence may fire at the next tick, on lock-lost too.
          if (err instanceof LockLost) throw new LockLost({ resumeMayFire: true });
          passUp(err);
          return hermesFailure(err, { step: "reanchor", applied: [...applied], resumeMayFire: true });
        }
        resume.missedSlot = "dropped";
      } else {
        resume.resumeMayFire = true;
      }
    }
  }
  return ok({
    job: key,
    id: job.id,
    changed: [...applied],
    ...(cron ? { schedule: cron.expr, adminSchedule: scheduleAdminManaged(key, readJobSettings(ctx.home)) } : scheduleOut(job)),
    enabled,
    window: delivery.window ? formatWindow(delivery.window) : null,
    tz: delivery.tz,
    ...(check ?? {}),
    ...(cron && cronFrequent(cron) ? { frequent: true } : {}),
    ...resume,
    ...(settingsDropped.length && applied.includes("settings") ? { dropped: settingsDropped } : {}),
    ...(current.adminRepaired && applied.includes("settings") ? { adminSchedulesRepaired: true } : {}),
    ...(replaced ? { replaced } : {}),
  });
}

interface AddRequest {
  template: TemplateName;
  cron: ParsedCron;
  window: FieldChange;
  tz: FieldChange;
}

function validateAdd(flags: Map<string, string>): AddRequest | CommandResult {
  const template = flags.get("--template")!;
  if (!isTemplateName(template)) return refused("invalid-template");
  const cron = scheduleFlag(flags.get("--schedule")!, flags.has("--allow-frequent"));
  if (isResult(cron)) return cron;
  const window = fieldChange(flags.get("--window"), (raw) => parseWindow(raw) !== null);
  if (window === "invalid" || (window && "clear" in window)) return refused("invalid-window");
  const tz = fieldChange(flags.get("--tz"), isValidTimeZone);
  if (tz === "invalid" || (tz && "clear" in tz)) return refused("invalid-tz");
  return { template, cron, window, tz };
}

function addCommand(ctx: GuardedContext, req: AddRequest, applied: string[]): CommandResult {
  const { template, cron, window, tz } = req;
  const key = `tpl-${template}` as JobKey;
  const spec = templateCronSpec(template, cron.expr);
  const current = currentSettings(ctx.home);
  const { entry, dropped } = mergeEntry(current.jobs[key], window, tz);
  const delivery = effective(key, entry);
  const check = windowCheck(ctx, cron, delivery);
  if (isResult(check)) return check;
  const missing = filesMissing(ctx.home, spec);
  if (missing) return missing;
  if (!ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });
  const found = jobsNamed(ctx.home, spec.name);
  if ("unreadable" in found) return refused("job-unreadable", { job: key });
  if (found.jobs.length > 1) return refused("job-ambiguous", { job: key, count: found.jobs.length });

  // 1. The settings first, so the job never runs, even once, without its
  // window; rolled back if the Hermes step fails, so a failure leaves no entry.
  const text = nextSettingsText(current, key, entry, "keep");
  const settingsChanged = text !== current.bytes;
  if (settingsChanged) {
    try {
      writeSettings(ctx, text);
    } catch (err) {
      passUp(err);
      return failed("settings-write-failed", { applied: [...applied] });
    }
    applied.push("settings");
  }
  const rollback = (): void => {
    if (!applied.includes("settings")) return;
    try {
      // Never without the lock: a lost lock leaves the entry, and `applied` says so.
      writeSettings(ctx, current.bytes);
      applied.splice(applied.indexOf("settings"), 1);
    } catch {
      // left in place, and `applied` still says so
    }
  };
  let result: "created" | "updated" | "unchanged";
  let id: string;
  try {
    // 2. The shim under the template's name, then the job.
    installShim(ctx, expectedCronScriptArg(spec)!);
    const promptBody = readCronPromptBody(spec, join(ctx.home, "skills")).trimEnd();
    if (found.jobs.length === 0) {
      const before = usableIds(ctx.home);
      try {
        ctx.hermes(cronCreateArgs(spec, promptBody, ctx.home));
      } catch (err) {
        passUp(err);
        // A Hermes that created the job and then failed (or was killed) keeps its entry; otherwise none is left.
        const made = jobsNamed(ctx.home, spec.name);
        if ("jobs" in made && made.jobs.some((job) => !before.has(job.id))) applied.push("create");
        else rollback();
        return hermesFailure(err, { step: "create", applied: [...applied] });
      }
      const after = jobsNamed(ctx.home, spec.name);
      const created = "jobs" in after ? after.jobs.find((job) => !before.has(job.id)) : undefined;
      if (!created) return failed("job-not-found-after-create", { applied: [...applied, "create"] });
      applied.push("create");
      id = created.id;
      if (rawSchedule(created) !== cron.expr) return failed("schedule-readback-mismatch", { applied: [...applied] });
      writeIds(ctx, [...readInstalledIds(ctx.home), id]);
      result = "created";
    } else {
      const job = found.jobs[0];
      id = job.id;
      const stale = staleShapeFields(job, spec, promptBody);
      const scheduleChanged = rawSchedule(job) !== cron.expr;
      if (Object.keys(stale).length > 0) {
        try {
          ctx.hermes(cronEditArgs(job.id, stale));
        } catch (err) {
          passUp(err);
          const now = rereadJob(ctx.home, key, job.id);
          if (now && Object.keys(staleShapeFields(now, spec, promptBody)).length === 0) applied.push("shape");
          rollback();
          return hermesFailure(err, { step: "edit", applied: [...applied] });
        }
        applied.push("shape");
      }
      if (scheduleChanged) {
        try {
          ctx.hermes(cronEditArgs(job.id, { schedule: cron.expr }));
        } catch (err) {
          passUp(err);
          if (scheduleIs(ctx.home, key, job.id, cron.expr)) applied.push("schedule");
          else rollback();
          return hermesFailure(err, { step: "schedule", applied: [...applied] });
        }
        applied.push("schedule");
        if (!scheduleIs(ctx.home, key, job.id, cron.expr)) return failed("schedule-readback-mismatch", { applied: [...applied] });
      }
      if (!readInstalledIds(ctx.home).includes(job.id)) writeIds(ctx, [...readInstalledIds(ctx.home), job.id]);
      result = applied.length > 0 ? "updated" : "unchanged";
    }
  } catch (err) {
    // A fault before Hermes created anything: no entry is left for a job that does not exist.
    if (!applied.includes("create") && !applied.includes("shape") && !applied.includes("schedule")) rollback();
    throw err;
  }
  const settingsDropped = [...dropped, ...(current.adminDropped ? ["adminSchedules"] : [])];
  return ok({
    job: key,
    id,
    result,
    changed: [...applied],
    schedule: cron.expr,
    window: delivery.window ? formatWindow(delivery.window) : null,
    tz: delivery.tz,
    ...(check ?? {}),
    ...(cronFrequent(cron) ? { frequent: true } : {}),
    ...(settingsDropped.length && applied.includes("settings") ? { dropped: settingsDropped } : {}),
    ...(current.adminRepaired && applied.includes("settings") ? { adminSchedulesRepaired: true } : {}),
    ...(current.replaced && applied.includes("settings") ? { replaced: current.replaced } : {}),
  });
}

function validateTemplate(flags: Map<string, string>): TemplateName | CommandResult {
  const template = flags.get("--template")!;
  return isTemplateName(template) ? template : refused("invalid-template");
}

function removeCommand(ctx: GuardedContext, template: TemplateName, applied: string[]): CommandResult {
  const key = `tpl-${template}` as JobKey;
  const found = jobsNamed(ctx.home, templateCronSpec(template, "").name);
  if ("unreadable" in found) return refused("job-unreadable", { job: key });
  if (found.jobs.length > 0 && !ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });
  const removedIds = new Set<string>();
  const forget = (): void => {
    if (removedIds.size > 0) writeIds(ctx, readInstalledIds(ctx.home).filter((id) => !removedIds.has(id)));
  };
  for (const job of found.jobs) {
    try {
      ctx.hermes(["cron", "remove", job.id]);
    } catch (err) {
      passUp(err);
      // A Hermes that removed the job and then failed (or was killed): read back, and say so.
      if (!usableIds(ctx.home).has(job.id)) {
        removedIds.add(job.id);
        if (!applied.includes("job")) applied.push("job");
      }
      try {
        forget();
      } catch (inner) {
        passUp(inner);
      }
      return hermesFailure(err, { step: "remove", applied: [...applied], removed: removedIds.size });
    }
    removedIds.add(job.id);
    if (!applied.includes("job")) applied.push("job");
  }
  forget();
  const current = currentSettings(ctx.home);
  if (current.replaced === undefined && Object.prototype.hasOwnProperty.call(current.jobs, key)) {
    const text = nextSettingsText(current, key, {}, "keep");
    if (text !== current.bytes) {
      try {
        writeSettings(ctx, text);
      } catch (err) {
        passUp(err);
        return failed("settings-write-failed", { applied: [...applied], removed: removedIds.size });
      }
      applied.push("settings");
    }
  }
  return ok({
    job: key,
    result: found.jobs.length > 0 ? "removed" : "absent",
    removed: found.jobs.length,
    changed: [...applied],
    // As set and add report them: what the rewrite dropped, and the repair beside it.
    ...(current.adminDropped && applied.includes("settings") ? { dropped: ["adminSchedules"] } : {}),
    ...(current.adminRepaired && applied.includes("settings") ? { adminSchedulesRepaired: true } : {}),
  });
}

function validatePreview(ctx: JobsContext, flags: Map<string, string>): JobKey | CommandResult {
  const key = flags.get("--job")!;
  if (!isJobKey(key)) return refused("invalid-job");
  // The gate is checked here and again by the trigger the preview job runs.
  if (!isTeamTenant(ctx.home)) return { code: EXIT.notTeam, out: { ok: false, error: "not-team-tenant" } };
  return key;
}

function previewCommand(ctx: GuardedContext, key: JobKey, applied: string[]): CommandResult {
  // Leftovers of earlier previews older than an hour (file times, so the real clock): state copies and shims. Earlier preview jobs go below.
  ctx.guard(0);
  prunePreviewFiles(ctx.home, Date.now());
  const base = specForKey(key, PREVIEW_FIRES);
  const scriptName = `agentvillage_proactive_preview-${key}.sh`;
  const spec: DigestCronSpec = {
    ...base,
    schedule: PREVIEW_FIRES,
    name: PREVIEW_JOB_NAME,
    deliver: true,
    failureDeliver: "local",
    noAgent: false,
    scriptInstallName: scriptName,
  };
  const earlier = jobsNamed(ctx.home, PREVIEW_JOB_NAME);
  if ("unreadable" in earlier) return refused("job-unreadable", { job: "preview" });
  const missing = filesMissing(ctx.home, spec);
  if (missing) return missing;
  if (!ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });
  installShim(ctx, scriptName);
  // One preview job at a time: an earlier one (fired and completed, or not yet fired) goes first.
  for (const job of earlier.jobs) {
    try {
      ctx.hermes(["cron", "remove", job.id]);
    } catch (err) {
      passUp(err);
      if (!usableIds(ctx.home).has(job.id) && !applied.includes("removed-previous")) applied.push("removed-previous");
      return hermesFailure(err, { step: "remove-previous", applied: [...applied] });
    }
    if (!applied.includes("removed-previous")) applied.push("removed-previous");
  }
  const prompt = `${PREVIEW_PREAMBLE}${readCronPromptBody(spec, join(ctx.home, "skills")).trimEnd()}`;
  const before = usableIds(ctx.home);
  try {
    ctx.hermes(cronCreateArgs(spec, prompt, ctx.home));
  } catch (err) {
    passUp(err);
    const made = jobsNamed(ctx.home, PREVIEW_JOB_NAME);
    if ("jobs" in made && made.jobs.some((job) => !before.has(job.id))) applied.push("create");
    return hermesFailure(err, { step: "create", applied: [...applied] });
  }
  applied.push("create");
  const after = jobsNamed(ctx.home, PREVIEW_JOB_NAME);
  const id = ("jobs" in after ? after.jobs.find((job) => !before.has(job.id))?.id : undefined) ?? null;
  return ok({ job: key, id, fires: PREVIEW_FIRES });
}

/**
 * Run one command. Never throws: an unexpected error is `{"ok": false,
 * "error": "fault", "applied": [...]}`, exit 1. A mutating command holds the
 * jobs lock throughout, and before each write (each Hermes command, each file
 * it writes) checks that the lock still holds its token and that the step can
 * end before the lock goes stale (a Hermes command: HERMES_TIMEOUT_MS); if
 * not, it stops with `lock-lost`, exit 1, and writes nothing more.
 */
export function runJobsCommand(argv: string[], ctx: JobsContext): CommandResult {
  const applied: string[] = [];
  let lock: HeldLock | null = null;
  try {
    const parsed = parseCommand(argv);
    if ("code" in parsed) return parsed;
    const { command, flags } = parsed;
    if (command === "list") return listCommand(ctx);
    // Every value is checked before the lock: a malformed request is refused, never `busy`.
    const request =
      command === "set" ? validateSet(flags)
      : command === "add" ? validateAdd(flags)
      : command === "remove" ? validateTemplate(flags)
      : validatePreview(ctx, flags);
    if (isResult(request)) return request;
    const clock = ctx.clock ?? Date.now;
    lock = tryAcquireLock(jobsLockPath(ctx.home), { now: clock });
    if (!lock) return { code: EXIT.busy, out: { ok: false, error: "busy" } };
    const held = lock;
    const since = clock();
    const guard = (budgetMs: number): void => {
      if (!holdsLock(held) || clock() - since + budgetMs >= LOCK_STALE_MS) throw new LockLost();
    };
    const run: GuardedContext = {
      ...ctx,
      guard,
      hermes: (args) => {
        guard(HERMES_TIMEOUT_MS);
        ctx.hermes(args);
      },
    };
    // An unreadable store is refused before anything is done: it is never read as "no jobs".
    if ("unreadable" in readJobsStore(ctx.home)) return failed("jobs-store-unreadable", { applied: [] });
    if (command === "set") return setCommand(run, request as SetRequest, applied);
    if (command === "add") return addCommand(run, request as AddRequest, applied);
    if (command === "remove") return removeCommand(run, request as TemplateName, applied);
    return previewCommand(run, request as JobKey, applied);
  } catch (err) {
    if (err instanceof LockLost) return failed("lock-lost", { applied: [...applied], ...err.extra });
    if (err instanceof StoreUnreadable) return failed("jobs-store-unreadable", { applied: [...applied] });
    return failed("fault", { applied: [...applied] });
  } finally {
    // Removes the lock file only while it still holds this command's token.
    lock?.release();
  }
}

/**
 * Runs Hermes commands as an argv, never through a shell, each killed
 * (SIGKILL) after `timeoutMs`: a killed command throws HermesTimeout.
 */
export function hermesRunner(bin: string, env: NodeJS.ProcessEnv, timeoutMs = HERMES_TIMEOUT_MS): (args: string[]) => void {
  return (args) => {
    try {
      execFileSync(bin, args, { stdio: ["ignore", "ignore", "inherit"], env, timeout: timeoutMs, killSignal: "SIGKILL" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ETIMEDOUT") throw new HermesTimeout();
      throw err;
    }
  };
}

export function defaultContext(): JobsContext {
  const bin = hermesBin();
  // The caller's own zone is not passed on: Hermes's CLI then reads the
  // tenant's `.env` and config.yaml, the two sources hermesZone checks.
  const env = hermesExecEnv();
  delete env.HERMES_TIMEZONE;
  return {
    home: hermesHome(),
    hermes: hermesRunner(bin, env),
    hermesReady: () => hermesAvailable(bin, HERMES_TIMEOUT_MS),
    now: new Date(),
  };
}

if (import.meta.main) {
  // stdout carries only the one result line.
  console.log = console.error;
  const result = runJobsCommand(process.argv.slice(2), defaultContext());
  process.stdout.write(`${JSON.stringify(result.out)}\n`, () => process.exit(result.code));
}
