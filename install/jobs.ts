#!/usr/bin/env bun
/**
 * Per-tenant job commands (J2, overlay half): what the control plane runs
 * inside one tenant to change that tenant's proactive jobs without a roll.
 * The contract, with every output shape, is docs/design/job-settings.md.
 *
 *   bun install/jobs.ts list
 *   bun install/jobs.ts set --job <key> [--schedule "<cron>"] [--window HH:MM-HH:MM|default] [--tz <zone>|default] [--enabled true|false]
 *   bun install/jobs.ts add --template <brief|digest-preview|evening-ask> --schedule "<cron>" [--window HH:MM-HH:MM] [--tz <zone>]
 *   bun install/jobs.ts remove --template <name>
 *   bun install/jobs.ts preview --job <key>
 *
 * Every command prints exactly one line of JSON on stdout (`{"ok": true, ...}`
 * or `{"ok": false, "error": "<code>", ...}`); everything else goes to
 * stderr. Exit codes: 0 done; 2 the request was refused before anything
 * changed (a value outside its grammar, an unknown job, a schedule that never
 * lands in its window); 3 a preview refused on a tenant that is not a team
 * tenant; 1 a step failed on the way (`applied` lists what had already
 * changed). Every value is checked against a fixed grammar before use, and
 * Hermes is only ever started as an argv (execFileSync), never through a shell.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import YAML from "yaml";

import { hermesBin, hermesExecEnv } from "./hermes_cli";
import {
  DIGEST_CRON_SPECS,
  PROACTIVE_SHIM,
  type DigestCronSpec,
  type StoredCronJob,
  cronCreateArgs,
  cronEditArgs,
  expectedCronScriptArg,
  hermesAvailable,
  installedJobsPath,
  readCronJobs,
  readCronPromptBody,
  staleShapeFields,
  storedJobEnabled,
  storedSchedule,
  templateCronSpec,
  writeInstalledJobIds,
} from "./install_index";
import { hermesHome } from "./paths";
import {
  DEFAULT_TZ,
  DEFAULT_WINDOWS,
  type DeliveryWindow,
  type JobKey,
  type TemplateName,
  formatWindow,
  isJobKey,
  isTeamTenant,
  isTemplateName,
  isValidTimeZone,
  parseStrictCron,
  parseWindow,
  readJobSettings,
  scheduleMeetsWindow,
  validateEntry,
  writeJobSettings,
} from "../skills/index-network/scripts/job-settings";

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

export interface CommandResult {
  code: number;
  out: Record<string, unknown>;
}

export interface JobsContext {
  home: string;
  /** Runs one Hermes command (argv after the binary); throws on a non-zero exit. */
  hermes: (args: string[]) => void;
  /** Whether the Hermes CLI runs at all. */
  hermesReady: () => boolean;
  now: Date;
}

function ok(out: Record<string, unknown>): CommandResult {
  return { code: 0, out: { ok: true, ...out } };
}

function refused(error: string, extra: Record<string, unknown> = {}): CommandResult {
  return { code: 2, out: { ok: false, error, ...extra } };
}

function failed(error: string, extra: Record<string, unknown> = {}): CommandResult {
  return { code: 1, out: { ok: false, error, ...extra } };
}

// ── Arguments ───────────────────────────────────────────────────────────────

const COMMAND_FLAGS: Record<string, { required: string[]; optional: string[] }> = {
  list: { required: [], optional: [] },
  set: { required: ["--job"], optional: ["--schedule", "--window", "--tz", "--enabled"] },
  add: { required: ["--template", "--schedule"], optional: ["--window", "--tz"] },
  remove: { required: ["--template"], optional: [] },
  preview: { required: ["--job"], optional: [] },
};

/** `<command> --flag value ...`, each flag once and only the command's own; or the refusal. */
export function parseCommand(argv: string[]): { command: string; flags: Map<string, string> } | CommandResult {
  const [command, ...rest] = argv;
  const spec = command === undefined ? undefined : COMMAND_FLAGS[command];
  if (!spec) return refused("unknown-command");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    if (![...spec.required, ...spec.optional].includes(flag)) return refused("unknown-flag");
    if (flags.has(flag)) return refused("duplicate-flag", { flag });
    const value = rest[i + 1];
    if (value === undefined || value.length > 200) return refused("missing-value", { flag });
    flags.set(flag, value);
  }
  for (const flag of spec.required) if (!flags.has(flag)) return refused("missing-flag", { flag });
  return { command, flags };
}

/** A settings field from a flag: a value, `default` (remove the override), or absent. */
type FieldChange = { set: string } | { clear: true } | undefined;

function fieldChange(value: string | undefined, valid: (raw: string) => boolean): FieldChange | "invalid" {
  if (value === undefined) return undefined;
  if (value === "default") return { clear: true };
  return valid(value) ? { set: value } : "invalid";
}

// ── Jobs and settings ───────────────────────────────────────────────────────

/** The spec that names a job key's Hermes job; a template's schedule is filled in by the caller. */
export function specForKey(key: JobKey, schedule = ""): DigestCronSpec {
  if (key.startsWith("tpl-")) return templateCronSpec(key.slice(4) as TemplateName, schedule);
  const spec = DIGEST_CRON_SPECS.find((entry) => entry.scriptInstallName === `agentvillage_proactive_${key}.sh`);
  if (!spec) throw new Error(`no spec for ${key}`);
  return spec;
}

function jobsNamed(name: string): StoredCronJob[] {
  return readCronJobs().filter((job) => job.name === name);
}

type Entry = { window?: string; tz?: string };

/** The settings file's jobs as they are now, for a rewrite (an invalid file starts empty and is reported). */
function currentEntries(home: string): { jobs: Record<string, unknown>; replaced?: string } {
  const read = readJobSettings(home);
  if (read.status === "ok") return { jobs: { ...read.jobs } };
  if (read.status === "invalid") return { jobs: {}, replaced: `invalid:${read.code}` };
  return { jobs: {} };
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
  return { entry, dropped };
}

/** The window and zone an entry gives a job (its default window when the entry names none). */
function effective(key: JobKey, entry: Entry): { window: DeliveryWindow | null; tz: string } {
  const valid = validateEntry(entry);
  if ("invalid" in valid) throw new Error("merged entry invalid");
  return { window: valid.window ?? DEFAULT_WINDOWS[key] ?? null, tz: valid.tz ?? DEFAULT_TZ };
}

/**
 * The zone Hermes reads schedules in: `timezone` in config.yaml, else
 * `HERMES_TIMEZONE` (environment, else `.env`), else the village zone the
 * installer sets (config.ts configureVillageTimezone).
 */
export function hermesZone(home: string): string {
  try {
    const doc = YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")) as { timezone?: unknown } | null;
    if (doc && isValidTimeZone(doc.timezone)) return doc.timezone;
  } catch {
    // no config: below
  }
  let fromEnv = process.env.HERMES_TIMEZONE?.trim();
  if (fromEnv === undefined) {
    try {
      const line = readFileSync(join(home, ".env"), "utf8").split("\n").find((entry) => entry.startsWith("HERMES_TIMEZONE="));
      fromEnv = line?.slice("HERMES_TIMEZONE=".length).trim().replace(/^["']|["']$/g, "");
    } catch {
      // no .env
    }
  }
  return isValidTimeZone(fromEnv) ? fromEnv : DEFAULT_TZ;
}

/** Refuses a schedule that would never deliver: none of its times of day lands in the job's window over 14 days. */
function windowCheck(ctx: JobsContext, schedule: string, delivery: { window: DeliveryWindow | null; tz: string }): CommandResult | "skipped" | null {
  if (!delivery.window) return null;
  const cron = parseStrictCron(schedule);
  // A schedule set outside these commands (a Hermes phrase, an interval) cannot be checked here.
  if (!cron) return "skipped";
  if (scheduleMeetsWindow(cron, delivery.window, delivery.tz, hermesZone(ctx.home), ctx.now)) return null;
  return refused("schedule-outside-window", { schedule: cron.expr, window: formatWindow(delivery.window), tz: delivery.tz });
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

function installShim(home: string, scriptName: string): void {
  mkdirSync(join(home, "scripts"), { recursive: true });
  copyFileSync(join(home, "skills", PROACTIVE_SHIM), join(home, "scripts", scriptName));
}

function describeJob(key: JobKey, job: StoredCronJob, settings: ReturnType<typeof readJobSettings>): Record<string, unknown> {
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
    name: job.name,
    schedule: storedSchedule(job),
    enabled: storedJobEnabled(job),
    window: delivery.window ? formatWindow(delivery.window) : null,
    tz: delivery.tz,
    settings: state,
  };
}

// ── Commands ────────────────────────────────────────────────────────────────

function listCommand(ctx: JobsContext): CommandResult {
  const settings = readJobSettings(ctx.home);
  const jobs: Record<string, unknown>[] = [];
  const missing: string[] = [];
  for (const key of ["brief", "drop-midday", "drop-evening", "negotiation", "evening", "tpl-brief", "tpl-digest-preview", "tpl-evening-ask"] as JobKey[]) {
    const found = jobsNamed(specForKey(key).name);
    if (found.length === 0 && !key.startsWith("tpl-")) missing.push(key);
    for (const job of found) jobs.push(describeJob(key, job, settings));
  }
  return ok({ settings: settings.status === "invalid" ? `invalid:${settings.code}` : settings.status, jobs, missing });
}

function setCommand(ctx: JobsContext, flags: Map<string, string>): CommandResult {
  const key = flags.get("--job")!;
  if (!isJobKey(key)) return refused("invalid-job");
  const scheduleFlag = flags.get("--schedule");
  const cron = scheduleFlag === undefined ? undefined : parseStrictCron(scheduleFlag);
  if (cron === null) return refused("invalid-schedule");
  const window = fieldChange(flags.get("--window"), (raw) => parseWindow(raw) !== null);
  if (window === "invalid") return refused("invalid-window");
  const tz = fieldChange(flags.get("--tz"), isValidTimeZone);
  if (tz === "invalid") return refused("invalid-tz");
  const enabledFlag = flags.get("--enabled");
  if (enabledFlag !== undefined && enabledFlag !== "true" && enabledFlag !== "false") return refused("invalid-enabled");
  if (!cron && !window && !tz && enabledFlag === undefined) return refused("nothing-to-set");

  const found = jobsNamed(specForKey(key).name);
  if (found.length === 0) return refused("job-not-installed", { job: key });
  if (found.length > 1) return refused("job-ambiguous", { job: key, count: found.length });
  const job = found[0];
  if (!ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });

  const current = currentEntries(ctx.home);
  const { entry, dropped } = mergeEntry(current.jobs[key], window, tz);
  const delivery = effective(key, entry);
  const schedule = cron?.expr ?? storedSchedule(job);
  // Pausing or resuming alone is never refused; a change of when or where is checked.
  const check = cron || window || tz ? windowCheck(ctx, schedule, delivery) : null;
  if (check && check !== "skipped") return check;

  const applied: string[] = [];
  // 1. The schedule (Hermes keeps the job's id and pause state on an edit).
  if (cron && cron.expr !== storedSchedule(job)) {
    try {
      ctx.hermes(cronEditArgs(job.id, { schedule: cron.expr }));
    } catch {
      return failed("hermes-failed", { step: "schedule", applied });
    }
    applied.push("schedule");
  }
  // 2. The settings entry. Written whenever the schedule, window or zone is
  // set, so the job counts as admin-managed (reconcile never migrates it).
  if (cron || window || tz) {
    try {
      writeJobSettings(ctx.home, { ...(current.jobs as Record<string, Entry>), [key]: entry });
    } catch {
      return failed("settings-write-failed", { applied });
    }
    if (window || tz || dropped.length > 0) applied.push("settings");
  }
  // 3. Enabled is Hermes's pause state, the only place it is kept.
  if (enabledFlag !== undefined) {
    const want = enabledFlag === "true";
    if (want !== storedJobEnabled(job)) {
      try {
        ctx.hermes(["cron", want ? "resume" : "pause", job.id]);
      } catch {
        return failed("hermes-failed", { step: "enabled", applied });
      }
      applied.push("enabled");
    }
  }
  return ok({
    job: key,
    id: job.id,
    changed: applied,
    schedule,
    enabled: enabledFlag === undefined ? storedJobEnabled(job) : enabledFlag === "true",
    window: delivery.window ? formatWindow(delivery.window) : null,
    tz: delivery.tz,
    ...(check === "skipped" ? { check: "skipped" } : {}),
    ...(dropped.length ? { dropped } : {}),
    ...(current.replaced ? { replaced: current.replaced } : {}),
  });
}

function addCommand(ctx: JobsContext, flags: Map<string, string>): CommandResult {
  const template = flags.get("--template")!;
  if (!isTemplateName(template)) return refused("invalid-template");
  const cron = parseStrictCron(flags.get("--schedule"));
  if (!cron) return refused("invalid-schedule");
  const window = fieldChange(flags.get("--window"), (raw) => parseWindow(raw) !== null);
  if (window === "invalid" || (window && "clear" in window)) return refused("invalid-window");
  const tz = fieldChange(flags.get("--tz"), isValidTimeZone);
  if (tz === "invalid" || (tz && "clear" in tz)) return refused("invalid-tz");

  const key = `tpl-${template}` as JobKey;
  const spec = templateCronSpec(template, cron.expr);
  const current = currentEntries(ctx.home);
  const { entry, dropped } = mergeEntry(current.jobs[key], window, tz);
  const delivery = effective(key, entry);
  const check = windowCheck(ctx, cron.expr, delivery);
  if (check) return check;
  const missing = filesMissing(ctx.home, spec);
  if (missing) return missing;
  if (!ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });
  const found = jobsNamed(spec.name);
  if (found.length > 1) return refused("job-ambiguous", { job: key, count: found.length });

  const applied: string[] = [];
  // 1. The settings first: an entry for a job that does not exist yet is inert,
  // and a job never runs, even once, without its window.
  try {
    writeJobSettings(ctx.home, { ...(current.jobs as Record<string, Entry>), [key]: entry });
  } catch {
    return failed("settings-write-failed", { applied });
  }
  applied.push("settings");
  // 2. The shim under the template's name, then the job.
  installShim(ctx.home, expectedCronScriptArg(spec)!);
  const promptBody = readCronPromptBody(spec, join(ctx.home, "skills")).trimEnd();
  let result: "created" | "updated" | "unchanged";
  let id: string | undefined;
  if (found.length === 0) {
    const before = new Set(readCronJobs().map((job) => job.id));
    try {
      ctx.hermes(cronCreateArgs(spec, promptBody, ctx.home));
    } catch {
      return failed("hermes-failed", { step: "create", applied });
    }
    id = jobsNamed(spec.name).find((job) => !before.has(job.id))?.id;
    if (!id) return failed("job-not-found-after-create", { applied });
    writeInstalledJobIds(ctx.home, [...readInstalledIds(ctx.home), id]);
    result = "created";
  } else {
    const job = found[0];
    id = job.id;
    const stale = staleShapeFields(job, spec, promptBody);
    const scheduleChanged = storedSchedule(job) !== cron.expr;
    try {
      if (Object.keys(stale).length > 0) ctx.hermes(cronEditArgs(job.id, stale));
      if (scheduleChanged) ctx.hermes(cronEditArgs(job.id, { schedule: cron.expr }));
    } catch {
      return failed("hermes-failed", { step: "edit", applied });
    }
    if (!readInstalledIds(ctx.home).includes(job.id)) writeInstalledJobIds(ctx.home, [...readInstalledIds(ctx.home), job.id]);
    result = Object.keys(stale).length > 0 || scheduleChanged || window || tz ? "updated" : "unchanged";
  }
  return ok({
    job: key,
    id,
    result,
    schedule: cron.expr,
    window: delivery.window ? formatWindow(delivery.window) : null,
    tz: delivery.tz,
    ...(dropped.length ? { dropped } : {}),
    ...(current.replaced ? { replaced: current.replaced } : {}),
  });
}

function removeCommand(ctx: JobsContext, flags: Map<string, string>): CommandResult {
  const template = flags.get("--template")!;
  if (!isTemplateName(template)) return refused("invalid-template");
  const key = `tpl-${template}` as JobKey;
  const found = jobsNamed(templateCronSpec(template, "").name);
  if (found.length > 0 && !ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });
  const applied: string[] = [];
  for (const job of found) {
    try {
      ctx.hermes(["cron", "remove", job.id]);
    } catch {
      return failed("hermes-failed", { step: "remove", applied });
    }
    applied.push(job.id);
  }
  const removedIds = new Set(applied);
  if (removedIds.size > 0) writeInstalledJobIds(ctx.home, readInstalledIds(ctx.home).filter((id) => !removedIds.has(id)));
  const read = readJobSettings(ctx.home);
  if (read.status === "ok" && Object.prototype.hasOwnProperty.call(read.jobs, key)) {
    const { [key]: _gone, ...rest } = read.jobs;
    try {
      writeJobSettings(ctx.home, rest as Record<string, Entry>);
    } catch {
      return failed("settings-write-failed", { applied });
    }
  }
  return ok({ job: key, result: found.length > 0 ? "removed" : "absent", removed: found.length });
}

function previewCommand(ctx: JobsContext, flags: Map<string, string>): CommandResult {
  const key = flags.get("--job")!;
  if (!isJobKey(key)) return refused("invalid-job");
  // The gate is checked here and again by the trigger the preview job runs.
  if (!isTeamTenant(ctx.home)) return { code: 3, out: { ok: false, error: "not-team-tenant" } };
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
  const missing = filesMissing(ctx.home, spec);
  if (missing) return missing;
  if (!ctx.hermesReady()) return failed("hermes-unavailable", { applied: [] });
  installShim(ctx.home, scriptName);
  const applied: string[] = [];
  // One preview job at a time: an earlier one (fired and retired, or not yet fired) goes first.
  for (const job of jobsNamed(PREVIEW_JOB_NAME)) {
    try {
      ctx.hermes(["cron", "remove", job.id]);
    } catch {
      return failed("hermes-failed", { step: "remove-previous", applied });
    }
    applied.push("removed-previous");
  }
  const prompt = `${PREVIEW_PREAMBLE}${readCronPromptBody(spec, join(ctx.home, "skills")).trimEnd()}`;
  const before = new Set(readCronJobs().map((job) => job.id));
  try {
    ctx.hermes(cronCreateArgs(spec, prompt, ctx.home));
  } catch {
    return failed("hermes-failed", { step: "create", applied });
  }
  const id = jobsNamed(PREVIEW_JOB_NAME).find((job) => !before.has(job.id))?.id ?? null;
  return ok({ job: key, id, fires: PREVIEW_FIRES });
}

/** Run one command. Never throws: an unexpected error is `{"ok": false, "error": "fault"}`, exit 1. */
export function runJobsCommand(argv: string[], ctx: JobsContext): CommandResult {
  try {
    const parsed = parseCommand(argv);
    if ("code" in parsed) return parsed;
    const { command, flags } = parsed;
    if (command === "list") return listCommand(ctx);
    if (command === "set") return setCommand(ctx, flags);
    if (command === "add") return addCommand(ctx, flags);
    if (command === "remove") return removeCommand(ctx, flags);
    return previewCommand(ctx, flags);
  } catch {
    return failed("fault");
  }
}

export function defaultContext(): JobsContext {
  const bin = hermesBin();
  const env = hermesExecEnv();
  return {
    home: hermesHome(),
    hermes: (args) => {
      execFileSync(bin, args, { stdio: ["ignore", "ignore", "inherit"], env });
    },
    hermesReady: () => hermesAvailable(bin),
    now: new Date(),
  };
}

if (import.meta.main) {
  // stdout carries only the one result line.
  console.log = console.error;
  const result = runJobsCommand(process.argv.slice(2), defaultContext());
  process.stdout.write(`${JSON.stringify(result.out)}\n`, () => process.exit(result.code));
}
