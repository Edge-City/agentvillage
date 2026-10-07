/**
 * DATA-376: the pause script (skills/index-network/scripts/pause-job.ts) end
 * to end against the stand-in Hermes that keeps jobs.json (fake_hermes.ts),
 * on jobs a roll created: stop and restart a labelled message, the resident
 * hold it records in the control plane's holds file, and what it refuses.
 * The holds file and jobs.json are treated as untrusted input throughout.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { DIGEST_CRON_SPECS, installedJobsPath as installIndexInstalledJobsPath, reconcileDigestCronJobs, storedJobEnabled as installIndexStoredJobEnabled } from "../install_index";
import * as hermesCliReexport from "../hermes_cli";
import * as jobs from "../jobs";
import * as hermesCli from "../../skills/index-network/scripts/hermes-cli";
import {
  CONTACT_STYLE_JOB_NAMES,
  HERMES_JOB_ID_RE,
  HOLD_AT_RE,
  HOLD_BY_WORDS,
  HOLD_STATES,
  HOLDS_MAX_BYTES,
  MESSAGE_LABELS,
  MESSAGE_LABEL_NAMES,
  installedJobsPath,
  isMessageLabel,
  jobHoldsPath,
  jobsLockPath,
  normalizeLabel,
  readJobsStore,
  storedJobEnabled,
} from "../../skills/index-network/scripts/message-labels";
import { EXIT, type PauseJobContext, defaultContext, parseHolds, runPauseJob } from "../../skills/index-network/scripts/pause-job";
import { LOCK_STALE_MS } from "../../skills/index-network/scripts/state-lock";

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");
const SCRIPT = join(REPO_SKILLS, "index-network", "scripts", "pause-job.ts");
const FAKE = join(import.meta.dir, "fake_hermes.ts");
const DIGEST = "Edge — daily digest";
const EVENING = "Edge — evening questions";
const MIDDAY = "Edge — opportunity drop (midday)";
const DROP_EVENING = "Edge — opportunity drop (evening)";
const AUDIT = "Edge — token usage audit";
const ENV_KEYS = ["HERMES_HOME", "HERMES_BIN", "INDEX_API_KEY", "TOKEN_USAGE_AUDIT_CRON", "FAKE_HERMES_FAIL", "FAKE_HERMES_HANG", "FAKE_HERMES_HANG_AFTER", "HERMES_TIMEZONE",
  "DIGEST_SIGNALS_CRON", "DIGEST_PREPARE_CRON", "DIGEST_SEND_CRON"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
/** Another job's hold, an admin's, that every write must keep exactly. */
const OTHER = "aaaaaaaaaaaa";
const OTHER_AT = "2026-10-01T08:00:00.000Z";
const PAST = "2026-01-01T12:13:00+05:30";
const EMPTY_HOLDS = '{"version":1,"holds":{}}';

let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-pause-job-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HERMES_HOME = home;
  process.env.INDEX_API_KEY = "ix_pause_job_seed";
  bin = join(home, "hermes");
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.HERMES_BIN = bin;
  writeFileSync(join(home, "config.yaml"), "timezone: Asia/Kolkata\n");
  for (const spec of DIGEST_CRON_SPECS) {
    for (const file of [spec.promptFile, spec.scriptFile]) {
      if (!file) continue;
      mkdirSync(dirname(join(home, "skills", file)), { recursive: true });
      copyFileSync(join(REPO_SKILLS, file), join(home, "skills", file));
    }
  }
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A roll: the installer's reconcile creates the jobs and installed_jobs.json, quietly. */
function roll(): void {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    reconcileDigestCronJobs({ ...process.env }, ["bun", "install.ts"]);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

type Job = Record<string, any>;

function allJobs(): Job[] {
  const path = join(home, "cron", "jobs.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).jobs : [];
}

function job(name: string): Job {
  const found = allJobs().find((entry) => entry.name === name && HERMES_JOB_ID_RE.test(entry.id) && installedIds().includes(entry.id));
  if (!found) throw new Error(`no installed job ${name}`);
  return found;
}

function editJobs(change: (all: Job[]) => void): void {
  const all = allJobs();
  change(all);
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: all }));
}

function setNextRun(name: string, at: string): void {
  const id = job(name).id;
  editJobs((all) => {
    all.find((entry) => entry.id === id)!.next_run_at = at;
  });
}

function calls(): string[][] {
  const path = join(home, "hermes-calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

function installedIds(): string[] {
  return JSON.parse(readFileSync(installedJobsPath(home), "utf8")).ids;
}

const holdsPath = () => jobHoldsPath(home);
const holdsText = () => (existsSync(holdsPath()) ? readFileSync(holdsPath(), "utf8") : null);
const holdsFile = () => (existsSync(holdsPath()) ? JSON.parse(readFileSync(holdsPath(), "utf8")) : null);

function writeHoldsFile(text: string): void {
  mkdirSync(dirname(holdsPath()), { recursive: true });
  writeFileSync(holdsPath(), text);
}

function seedHolds(body: Record<string, unknown>): void {
  writeHoldsFile(`${JSON.stringify(body)}\n`);
}

/** The script, in-process, with the real context (Hermes found through HERMES_BIN). */
function run(...argv: string[]) {
  return runPauseJob([...argv, "--home", home]);
}

function runWith(ctx: Partial<PauseJobContext>, ...argv: string[]) {
  return runPauseJob([...argv, "--home", home], (h) => ({ ...defaultContext(h), ...ctx }));
}

/** The script as the agent runs it: its own process, both streams read. */
function spawn(argv: string[], env: Record<string, string> = {}) {
  const out = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd: home,
    env: { ...process.env, HERMES_HOME: home, HERMES_BIN: bin, ...env },
    encoding: "utf8",
  });
  return { code: out.status, stdout: out.stdout, stderr: out.stderr };
}

const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("the label: one of the five, read leniently, nothing else", () => {
  test("each label resolves in any case, with spaces around or doubled inside", () => {
    const cases: Array<[string, string]> = [
      ["Daily digest", "Daily digest"],
      ["  daily digest  ", "Daily digest"],
      ["DAILY DIGEST", "Daily digest"],
      ["Daily\tdigest", "Daily digest"],
      ["conversation  update", "Conversation update"],
      ["Evening Questions", "Evening questions"],
      ["introduction suggestion", "Introduction suggestion"],
      [" usage REPORT", "Usage report"],
    ];
    for (const [raw, label] of cases) expect({ raw, label: normalizeLabel(raw) }).toEqual({ raw, label });
    for (const label of MESSAGE_LABEL_NAMES) expect(isMessageLabel(label)).toBe(true);
  });

  test("anything else is not a label: punctuation, templates, job names, 41 characters and more", () => {
    const refusedLabels = [
      "Daily Digest!", "Daily digests", "Daily_digest", "Dailydigest", "Daily\ndigest", "", " ",
      "brief", "digest-preview", "evening-ask", "Template: brief", "Edge — daily digest", "Morning brief",
      "Daily digest".padEnd(41, " "), "a".repeat(41), "x".repeat(5000), "Ꭰaily digest", "Daily digest\u0000",
    ];
    for (const raw of refusedLabels) expect({ raw, label: normalizeLabel(raw) }).toEqual({ raw, label: null });
    expect(normalizeLabel(42)).toBeNull();
    expect(isMessageLabel("daily digest")).toBe(false);
  });

  test("a refused label changes nothing, and the reply never echoes it", () => {
    roll();
    const before = allJobs();
    const calledBefore = calls().length;
    for (const raw of ["Daily Digest!", "brief", "a".repeat(41), "PLANTED-LABEL"]) {
      const result = run("pause", "--label", raw);
      expect(result).toEqual({ code: EXIT.refused, out: { ok: false, error: "invalid-label" } });
      expect(JSON.stringify(result.out)).not.toContain("PLANTED");
    }
    expect(calls().length).toBe(calledBefore);
    expect(allJobs()).toEqual(before);
    expect(holdsText()).toBeNull();
  });

  test("the command line: action first, then flags, each once with a value", () => {
    roll();
    const cases: Array<[string[], string]> = [
      [[], "invalid-action"],
      [["stop", "--label", "Daily digest"], "invalid-action"],
      [["PAUSE", "--label", "Daily digest"], "invalid-action"],
      [["pause"], "missing-label"],
      [["resume", "--home", home], "missing-label"],
      [["pause", "--label"], "invalid-args"],
      [["pause", "--label", "Daily digest", "--label", "Usage report"], "invalid-args"],
      [["pause", "--label", "Daily digest", "--job", "brief"], "invalid-args"],
      [["pause", "--label", "Daily digest", "extra"], "invalid-args"],
      [["pause", "--label", "Daily digest", "--home", "relative/home"], "invalid-args"],
      [["pause", "--label", "Daily digest", "--home", `/${"x".repeat(5000)}`], "invalid-args"],
    ];
    for (const [argv, error] of cases) {
      expect({ argv, result: runPauseJob(argv) }).toEqual({ argv, result: { code: EXIT.refused, out: { ok: false, error } } });
    }
    expect(holdsText()).toBeNull();
  });

  test("a home that is not a directory, or a jobs.json that cannot be read: jobs-store-unreadable, nothing changed", () => {
    expect(runPauseJob(["pause", "--label", "Daily digest", "--home", join(home, "missing")])).toEqual({ code: 2, out: { ok: false, error: "jobs-store-unreadable" } });
    expect(existsSync(join(home, "missing"))).toBe(false);
    roll();
    writeFileSync(join(home, "cron", "jobs.json"), "{not json");
    expect(run("pause", "--label", "Daily digest")).toEqual({ code: 2, out: { ok: false, error: "jobs-store-unreadable" } });
    expect(run("status")).toEqual({ code: 2, out: { ok: false, error: "jobs-store-unreadable" } });
    expect(existsSync(jobsLockPath(home))).toBe(false);
    expect(holdsText()).toBeNull();
  });
});

describe("only the jobs the overlay installed", () => {
  test("a resident's own job named like ours is never paused", () => {
    roll();
    const ours = job(DIGEST).id;
    editJobs((all) => {
      all.push({ ...all.find((entry) => entry.id === ours), id: "0123456789ab", next_run_at: null });
      // A job of ours by name whose id has another shape, even if listed: never used.
      all.push({ ...all.find((entry) => entry.id === ours), id: "NOT-A-HERMES-ID" });
    });
    writeFileSync(installedJobsPath(home), JSON.stringify({ ids: [...installedIds(), "NOT-A-HERMES-ID"] }));
    const result = run("pause", "--label", "Daily digest");
    expect(result).toEqual({ code: 0, out: { ok: true, action: "pause", label: "Daily digest", jobs: [{ id: ours, changed: true }], hold: "paused", holds: "ok" } });
    const pauses = calls().filter((argv) => argv[1] === "pause");
    expect(pauses).toEqual([["cron", "pause", ours]]);
    expect(storedJobEnabled(allJobs().find((entry) => entry.id === "0123456789ab")!)).toBe(true);
    expect(Object.keys(holdsFile().holds)).toEqual([ours]);
  });

  test("Usage report with no audit job: job-missing, exit 2, no Hermes call", () => {
    roll();
    const before = calls().length;
    expect(run("pause", "--label", "Usage report")).toEqual({ code: 2, out: { ok: false, error: "job-missing", label: "Usage report" } });
    expect(run("resume", "--label", "usage report")).toEqual({ code: 2, out: { ok: false, error: "job-missing", label: "Usage report" } });
    expect(calls().length).toBe(before);
    expect(holdsText()).toBeNull();
  });

  test("Usage report with the audit installed: paused, and its hold cleared on resume (not a contact-style job)", () => {
    process.env.TOKEN_USAGE_AUDIT_CRON = "0 3 * * *";
    roll();
    const id = job(AUDIT).id;
    expect(run("pause", "--label", "Usage report").out).toMatchObject({ ok: true, jobs: [{ id, changed: true }], hold: "paused" });
    expect(run("resume", "--label", "Usage report").out).toMatchObject({ ok: true, jobs: [{ id, changed: true }], hold: "cleared" });
    expect(holdsFile()).toEqual({ version: 1, holds: {} });
  });

  test("no installed_jobs.json, or one that cannot be read: no job is ours", () => {
    roll();
    rmSync(installedJobsPath(home));
    expect(run("pause", "--label", "Daily digest").out).toEqual({ ok: false, error: "job-missing", label: "Daily digest" });
    writeFileSync(installedJobsPath(home), "[1,2,3]");
    expect(run("pause", "--label", "Daily digest").out).toEqual({ ok: false, error: "job-missing", label: "Daily digest" });
    expect(calls().filter((argv) => argv[1] === "pause")).toEqual([]);
  });
});

describe("pause", () => {
  beforeEach(() => {
    roll();
  });

  test("pauses the job, then holds it paused by the resident, keeping another job's admin hold exactly", () => {
    seedHolds({ version: 1, holds: { [OTHER]: "paused" }, at: { [OTHER]: OTHER_AT }, by: { [OTHER]: "admin" } });
    const id = job(DIGEST).id;
    const result = run("pause", "--label", "Daily digest");
    expect(result).toEqual({ code: 0, out: { ok: true, action: "pause", label: "Daily digest", jobs: [{ id, changed: true }], hold: "paused", holds: "ok" } });
    expect(calls().filter((argv) => argv[1] === "pause")).toEqual([["cron", "pause", id]]);
    expect(storedJobEnabled(job(DIGEST))).toBe(false);
    const file = holdsFile();
    expect(file).toEqual({
      version: 1,
      holds: { [OTHER]: "paused", [id]: "paused" },
      at: { [OTHER]: OTHER_AT, [id]: expect.stringMatching(ISO_MS) },
      by: { [OTHER]: "admin", [id]: "resident" },
    });
    expect(HOLD_AT_RE.test(file.at[id])).toBe(true);
    // One line, as the control plane writes it.
    expect(holdsText()!.endsWith("}\n")).toBe(true);
    expect(holdsText()!.trimEnd().includes("\n")).toBe(false);
  });

  test("an admin's hold with no `by` is kept with no `by` added", () => {
    seedHolds({ version: 1, holds: { [OTHER]: "paused" } });
    run("pause", "--label", "Daily digest");
    const file = holdsFile();
    expect(file.holds[OTHER]).toBe("paused");
    expect(file.at[OTHER]).toBeUndefined();
    expect(file.by[OTHER]).toBeUndefined();
  });

  test("the hold is in the file before Hermes pauses the job (the control plane never sees it paused and not held)", () => {
    const seen: Array<{ argv: string[]; hold: unknown; by: unknown; enabled: boolean }> = [];
    const watching = (args: string[]) => {
      const file = holdsFile();
      seen.push({ argv: args, hold: file?.holds?.[args[2]] ?? null, by: file?.by?.[args[2]] ?? null, enabled: storedJobEnabled(allJobs().find((entry) => entry.id === args[2])!) });
      execFileSync(bin, args, { stdio: "ignore", env: process.env });
    };
    expect(runWith({ hermes: watching }, "pause", "--label", "Introduction suggestion").out).toMatchObject({ ok: true, hold: "paused" });
    expect(seen.map((entry) => entry.argv[1])).toEqual(["pause", "pause"]);
    for (const entry of seen) expect({ hold: entry.hold, by: entry.by, enabled: entry.enabled }).toEqual({ hold: "paused", by: "resident", enabled: true });
  });

  test("a second pause changes nothing: no Hermes call at all, and the file byte for byte", () => {
    run("pause", "--label", "Daily digest");
    const text = holdsText();
    const before = calls().length;
    expect(run("pause", "--label", "daily digest")).toEqual({ code: 0, out: { ok: true, action: "pause", label: "Daily digest", jobs: [{ id: job(DIGEST).id, changed: false }], hold: "paused", holds: "ok" } });
    expect(calls().length).toBe(before);
    expect(holdsText()).toBe(text);
  });

  test("Introduction suggestion pauses both drops: two calls, two holds", () => {
    const midday = job(MIDDAY).id;
    const evening = job(DROP_EVENING).id;
    const result = run("pause", "--label", "Introduction suggestion");
    const byId = (a: Job, b: Job) => a.id.localeCompare(b.id);
    expect([...(result.out.jobs as Job[])].sort(byId)).toEqual([{ id: midday, changed: true }, { id: evening, changed: true }].sort(byId));
    expect(result.out).toMatchObject({ ok: true, hold: "paused", holds: "ok" });
    expect(calls().filter((argv) => argv[1] === "pause").sort()).toEqual([["cron", "pause", midday], ["cron", "pause", evening]].sort());
    expect(holdsFile().holds).toEqual({ [midday]: "paused", [evening]: "paused" });
    expect(holdsFile().by).toEqual({ [midday]: "resident", [evening]: "resident" });
  });

  test("a job already paused with no hold (a cronjob_manage pause) gets the resident's hold, with no Hermes call", () => {
    execFileSync(bin, ["cron", "pause", job(EVENING).id], { stdio: "ignore", env: process.env });
    const before = calls().length;
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: true, jobs: [{ id: job(EVENING).id, changed: false }], hold: "paused" });
    expect(calls().length).toBe(before);
    expect(holdsFile().by[job(EVENING).id]).toBe("resident");
  });

  test("an admin's paused hold on the job itself stays the admin's; a settings, active or resident hold becomes the resident's pause", () => {
    const id = job(EVENING).id;
    seedHolds({ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "admin" } });
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: true, jobs: [{ id, changed: true }], hold: "paused" });
    expect(holdsFile()).toEqual({ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "admin" } });
    for (const [state, by] of [["paused", "desired"], ["active", "desired"], ["active", "admin"], ["active", "resident"]] as const) {
      execFileSync(bin, ["cron", "resume", id], { stdio: "ignore", env: process.env });
      seedHolds({ version: 1, holds: { [id]: state }, at: { [id]: OTHER_AT }, by: { [id]: by } });
      expect({ state, by, out: run("pause", "--label", "Evening questions").out }).toMatchObject({ state, by, out: { ok: true, hold: "paused" } });
      const file = holdsFile();
      expect({ state, by, hold: file.holds[id], placed: file.by[id], fresh: file.at[id] !== OTHER_AT }).toEqual({ state, by, hold: "paused", placed: "resident", fresh: true });
    }
  });

  test("a job the resident paused earlier and something resumed since: paused again, with a fresh time", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    const first = holdsFile().at[id];
    execFileSync(bin, ["cron", "resume", id], { stdio: "ignore", env: process.env });
    seedHolds({ ...holdsFile(), at: { [id]: OTHER_AT } });
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: true, jobs: [{ id, changed: true }] });
    expect(holdsFile().at[id]).not.toBe(OTHER_AT);
    expect(Date.parse(holdsFile().at[id])).toBeGreaterThanOrEqual(Date.parse(first));
  });
});

describe("resume: the missed slot never fires at once (AC#2)", () => {
  beforeEach(() => {
    roll();
  });

  test("a contact-style job: resume, then the schedule re-applied; the next run is in the future; held active by the resident", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    setNextRun(EVENING, PAST);
    const schedule = job(EVENING).schedule.expr;
    const before = calls().length;
    const result = run("resume", "--label", "Evening questions");
    expect(result).toEqual({ code: 0, out: { ok: true, action: "resume", label: "Evening questions", jobs: [{ id, changed: true, missedSlot: "dropped" }], hold: "active", holds: "ok" } });
    expect(calls().slice(before).filter((argv) => argv[0] === "cron")).toEqual([["cron", "resume", id], ["cron", "edit", id, "--schedule", schedule]]);
    expect(Date.parse(job(EVENING).next_run_at)).toBeGreaterThan(Date.now());
    expect(storedJobEnabled(job(EVENING))).toBe(true);
    expect(holdsFile()).toEqual({ version: 1, holds: { [id]: "active" }, at: { [id]: expect.stringMatching(ISO_MS) }, by: { [id]: "resident" } });
  });

  test("the daily digest: re-anchored too, though it has a delivery window (unlike jobs.ts set), and its hold removed", () => {
    seedHolds({ version: 1, holds: { [OTHER]: "paused" }, at: { [OTHER]: OTHER_AT }, by: { [OTHER]: "admin" } });
    const id = job(DIGEST).id;
    run("pause", "--label", "Daily digest");
    setNextRun(DIGEST, PAST);
    const result = run("resume", "--label", "Daily digest");
    expect(result.out).toEqual({ ok: true, action: "resume", label: "Daily digest", jobs: [{ id, changed: true, missedSlot: "dropped" }], hold: "cleared", holds: "ok" });
    expect(calls().at(-1)).toEqual(["cron", "edit", id, "--schedule", job(DIGEST).schedule.expr]);
    expect(Date.parse(job(DIGEST).next_run_at)).toBeGreaterThan(Date.now());
    expect(holdsFile()).toEqual({ version: 1, holds: { [OTHER]: "paused" }, at: { [OTHER]: OTHER_AT }, by: { [OTHER]: "admin" } });
  });

  test("no missed slot: resume only, no edit", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    setNextRun(EVENING, new Date(Date.now() + 3_600_000).toISOString());
    const before = calls().length;
    expect(run("resume", "--label", "Evening questions").out).toEqual({ ok: true, action: "resume", label: "Evening questions", jobs: [{ id, changed: true }], hold: "active", holds: "ok" });
    expect(calls().slice(before).filter((argv) => argv[0] === "cron")).toEqual([["cron", "resume", id]]);
  });

  test("a stored schedule it cannot read: no guess, no edit, and the reply says it may fire", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    editJobs((all) => {
      const entry = all.find((e) => e.id === id)!;
      entry.schedule = { expr: "18 19 * * MON" };
      entry.next_run_at = PAST;
    });
    const before = calls().length;
    expect(run("resume", "--label", "Evening questions").out).toEqual({ ok: true, action: "resume", label: "Evening questions", jobs: [{ id, changed: true, resumeMayFire: true }], hold: "active", holds: "ok", resumeMayFire: true });
    expect(calls().slice(before).filter((argv) => argv[0] === "cron")).toEqual([["cron", "resume", id]]);
  });

  test("Introduction suggestion: both drops resumed and re-anchored, both held active", () => {
    const midday = job(MIDDAY).id;
    const evening = job(DROP_EVENING).id;
    run("pause", "--label", "Introduction suggestion");
    setNextRun(MIDDAY, PAST);
    setNextRun(DROP_EVENING, PAST);
    const result = run("resume", "--label", "Introduction suggestion");
    expect(result.out).toMatchObject({ ok: true, hold: "active" });
    expect([...(result.out.jobs as Job[])].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [{ id: midday, changed: true, missedSlot: "dropped" }, { id: evening, changed: true, missedSlot: "dropped" }].sort((a, b) => a.id.localeCompare(b.id)),
    );
    expect(holdsFile().holds).toEqual({ [midday]: "active", [evening]: "active" });
    for (const name of [MIDDAY, DROP_EVENING]) expect(Date.parse(job(name).next_run_at)).toBeGreaterThan(Date.now());
  });

  test("a job paused with no hold entry (a cronjob_manage pause from before this script) resumes", () => {
    const id = job(EVENING).id;
    execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env });
    expect(holdsText()).toBeNull();
    expect(run("resume", "--label", "Evening questions").out).toMatchObject({ ok: true, jobs: [{ id, changed: true }], hold: "active" });
    expect(storedJobEnabled(job(EVENING))).toBe(true);
  });

  test("the post-resume hold is in the file before Hermes resumes the job: active for a contact-style job, removed for the digest", () => {
    const seen: Array<[string, unknown]> = [];
    const watching = (args: string[]) => {
      if (args[1] === "resume") seen.push([args[2], holdsFile()?.holds?.[args[2]] ?? null]);
      execFileSync(bin, args, { stdio: "ignore", env: process.env });
    };
    run("pause", "--label", "Evening questions");
    run("pause", "--label", "Daily digest");
    expect(runWith({ hermes: watching }, "resume", "--label", "Evening questions").out).toMatchObject({ ok: true, hold: "active" });
    expect(runWith({ hermes: watching }, "resume", "--label", "Daily digest").out).toMatchObject({ ok: true, hold: "cleared" });
    expect(seen).toEqual([[job(EVENING).id, "active"], [job(DIGEST).id, null]]);
  });

  test("a retry after a failed re-anchor finishes it: the edit runs, the next run is in the future (B1)", () => {
    const id = job(DIGEST).id;
    run("pause", "--label", "Daily digest");
    setNextRun(DIGEST, PAST);
    process.env.FAKE_HERMES_FAIL = "edit";
    expect(run("resume", "--label", "Daily digest").out).toMatchObject({ ok: false, error: "hermes-failed", step: "reanchor", applied: [id], resumeMayFire: true });
    expect(storedJobEnabled(job(DIGEST))).toBe(true);
    expect(job(DIGEST).next_run_at).toBe(PAST);
    delete process.env.FAKE_HERMES_FAIL;
    const before = calls().length;
    expect(run("resume", "--label", "Daily digest")).toEqual({ code: 0, out: { ok: true, action: "resume", label: "Daily digest", jobs: [{ id, changed: false, missedSlot: "dropped" }], hold: "cleared", holds: "ok" } });
    expect(calls().slice(before).filter((argv) => argv[0] === "cron")).toEqual([["cron", "edit", id, "--schedule", job(DIGEST).schedule.expr]]);
    expect(Date.parse(job(DIGEST).next_run_at)).toBeGreaterThan(Date.now());
  });

  test("a running job whose next run is already due is re-anchored on resume too; a non-canonical one says it may fire", () => {
    const id = job(EVENING).id;
    setNextRun(EVENING, PAST);
    const before = calls().length;
    expect(run("resume", "--label", "Evening questions").out).toEqual({ ok: true, action: "resume", label: "Evening questions", jobs: [{ id, changed: false, missedSlot: "dropped" }], hold: "active", holds: "ok" });
    expect(calls().slice(before).filter((argv) => argv[0] === "cron")).toEqual([["cron", "edit", id, "--schedule", job(EVENING).schedule.expr]]);
    expect(Date.parse(job(EVENING).next_run_at)).toBeGreaterThan(Date.now());
    editJobs((all) => {
      const entry = all.find((e) => e.id === id)!;
      entry.schedule = { expr: "18 19 * * MON" };
      entry.next_run_at = PAST;
    });
    const later = calls().length;
    expect(run("resume", "--label", "Evening questions").out).toEqual({ ok: true, action: "resume", label: "Evening questions", jobs: [{ id, changed: false, resumeMayFire: true }], hold: "active", holds: "ok", resumeMayFire: true });
    expect(calls().slice(later).filter((argv) => argv[0] === "cron")).toEqual([]);
  });

  test("a job already running: no Hermes call; the resident's old pause hold gives way", () => {
    const id = job(DIGEST).id;
    seedHolds({ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "resident" } });
    const before = calls().length;
    expect(run("resume", "--label", "Daily digest").out).toEqual({ ok: true, action: "resume", label: "Daily digest", jobs: [{ id, changed: false }], hold: "cleared", holds: "ok" });
    expect(calls().length).toBe(before);
    expect(holdsFile()).toEqual({ version: 1, holds: {} });
  });

  test("refused when the Edge City team or the settings paused it: held-by-admin / held-by-settings, no Hermes call, the file unchanged", () => {
    const id = job(EVENING).id;
    execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "admin" } }, "held-by-admin"],
      [{ version: 1, holds: { [id]: "paused" } }, "held-by-admin"],
      // A `by` the control plane does not know reads as an admin's.
      [{ version: 1, holds: { [id]: "paused" }, by: { [id]: "root" } }, "held-by-admin"],
      [{ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "desired" } }, "held-by-settings"],
    ];
    for (const [body, error] of cases) {
      seedHolds(body);
      const text = holdsText();
      const before = calls().length;
      expect({ body, result: run("resume", "--label", "Evening questions") }).toEqual({ body, result: { code: 2, out: { ok: false, error, label: "Evening questions" } } });
      expect(calls().length).toBe(before);
      expect(holdsText()).toBe(text);
      expect(storedJobEnabled(job(EVENING))).toBe(false);
    }
  });

  test("Introduction suggestion with one drop held by an admin: refused before any Hermes call for either", () => {
    const midday = job(MIDDAY).id;
    run("pause", "--label", "Introduction suggestion");
    seedHolds({ ...holdsFile(), by: { ...holdsFile().by, [midday]: "admin" } });
    const before = calls().length;
    expect(run("resume", "--label", "Introduction suggestion").out).toEqual({ ok: false, error: "held-by-admin", label: "Introduction suggestion" });
    expect(calls().length).toBe(before);
    expect(storedJobEnabled(job(DROP_EVENING))).toBe(false);
  });
});

describe("the holds file is read as the control plane reads it; resume never runs on one it cannot read", () => {
  /** Each unreadable shape, made fresh. */
  const unreadable: Array<[string, () => void]> = [
    ["array", () => writeHoldsFile("[]")],
    ["string", () => writeHoldsFile('"paused"')],
    ["null", () => writeHoldsFile("null")],
    ["number", () => writeHoldsFile("42")],
    ["malformed", () => writeHoldsFile('{"version":1,"holds":{')],
    // Its first 65536 bytes are not a whole JSON value, which is what the control plane parses.
    ["70 KB, cut by the 64 KiB read", () => writeHoldsFile(JSON.stringify({ version: 1, holds: {}, pad: "x".repeat(70_000) }))],
  ];

  test("pause on an unreadable file: the job is paused, the file is never written, the reply says so", () => {
    roll();
    const id = job(EVENING).id;
    for (const [name, make] of unreadable) {
      execFileSync(bin, ["cron", "resume", id], { stdio: "ignore", env: process.env });
      make();
      const bytes = readFileSync(holdsPath());
      const paused = run("pause", "--label", "Evening questions");
      expect({ name, paused }).toEqual({ name, paused: { code: 0, out: { ok: true, action: "pause", label: "Evening questions", jobs: [{ id, changed: true }], hold: null, holds: "unreadable" } } });
      expect(storedJobEnabled(job(EVENING))).toBe(false);
      expect({ name, same: readFileSync(holdsPath()).equals(bytes) }).toEqual({ name, same: true });
      expect(run("status", "--label", "Evening questions").out).toMatchObject({ holds: "unreadable", labels: [{ jobs: [{ hold: null, by: null }] }] });
    }
  });

  test("resume on an unreadable file: holds-unreadable, exit 2, no Hermes call, nothing changed", () => {
    roll();
    const id = job(EVENING).id;
    execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env });
    for (const [name, make] of unreadable) {
      make();
      const bytes = readFileSync(holdsPath());
      const before = calls().length;
      expect({ name, result: run("resume", "--label", "Evening questions") }).toEqual({ name, result: { code: 2, out: { ok: false, error: "holds-unreadable", label: "Evening questions" } } });
      expect(calls().length).toBe(before);
      expect(storedJobEnabled(job(EVENING))).toBe(false);
      expect({ name, same: readFileSync(holdsPath()).equals(bytes) }).toEqual({ name, same: true });
    }
    // A directory at the path: unreadable too.
    rmSync(holdsPath());
    mkdirSync(holdsPath());
    expect(run("resume", "--label", "Evening questions").out).toEqual({ ok: false, error: "holds-unreadable", label: "Evening questions" });
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: true, hold: null, holds: "unreadable" });
  });

  test("a hold the control plane can read refuses the resume, however the file is padded or encoded", () => {
    roll();
    const id = job(DIGEST).id;
    run("pause", "--label", "Daily digest");
    const cases: Array<[string, Buffer | string, string]> = [
      // One byte that is not UTF-8, in an unrelated string: the control plane decodes it as a replacement character.
      ["an admin's hold with a stray byte", Buffer.concat([Buffer.from(`{"version":1,"holds":{"${id}":"paused"},"by":{"${id}":"admin"},"note":"`), Buffer.from([0xe9]), Buffer.from('"}\n')]), "held-by-admin"],
      // Padding past 65536 bytes: the control plane parses the first 65536, which hold the whole object.
      ["the settings' hold padded to 65537 bytes", (() => {
        const body = JSON.stringify({ version: 1, holds: { [id]: "paused" }, by: { [id]: "desired" } });
        return `${body}${" ".repeat(HOLDS_MAX_BYTES + 1 - body.length - 1)}\n`;
      })(), "held-by-settings"],
      ["an admin's hold behind a byte-order mark", `﻿{"version":1,"holds":{"${id}":"paused"}}\r\n`, "held-by-admin"],
    ];
    for (const [name, text, error] of cases) {
      writeHoldsFile(text as string);
      const bytes = readFileSync(holdsPath());
      const before = calls().length;
      expect({ name, out: run("resume", "--label", "Daily digest").out }).toEqual({ name, out: { ok: false, error, label: "Daily digest" } });
      expect(calls().length).toBe(before);
      expect(storedJobEnabled(job(DIGEST))).toBe(false);
      expect(readFileSync(holdsPath()).equals(bytes)).toBe(true);
    }
  });

  test("a file longer than 64 KiB whose first 64 KiB parse is read, and rewritten whole", () => {
    roll();
    const id = job(DIGEST).id;
    const body = JSON.stringify({ version: 1, holds: { [OTHER]: "paused" }, at: { [OTHER]: OTHER_AT }, by: { [OTHER]: "admin" } });
    writeHoldsFile(`${body}${" ".repeat(HOLDS_MAX_BYTES * 2)}`);
    expect(run("pause", "--label", "Daily digest").out).toMatchObject({ ok: true, hold: "paused", holds: "ok" });
    expect(holdsFile()).toEqual({
      version: 1,
      holds: { [OTHER]: "paused", [id]: "paused" },
      at: { [OTHER]: OTHER_AT, [id]: expect.stringMatching(ISO_MS) },
      by: { [OTHER]: "admin", [id]: "resident" },
    });
    expect(readFileSync(holdsPath()).length).toBeLessThan(1000);
  });

  test("a FIFO at the path is never opened (the run does not hang)", () => {
    roll();
    mkdirSync(dirname(holdsPath()), { recursive: true });
    execFileSync("mkfifo", [holdsPath()]);
    const started = Date.now();
    expect(run("pause", "--label", "Daily digest").out).toMatchObject({ ok: true, hold: null, holds: "unreadable" });
    expect(run("resume", "--label", "Daily digest").out).toEqual({ ok: false, error: "holds-unreadable", label: "Daily digest" });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  test("an empty file is no holds, and is replaced", () => {
    roll();
    writeHoldsFile("  \n");
    const id = job(DIGEST).id;
    expect(run("pause", "--label", "Daily digest").out).toMatchObject({ ok: true, hold: "paused", holds: "ok" });
    expect(holdsFile().holds).toEqual({ [id]: "paused" });
  });
});

describe("hostile holds and jobs content is never carried or printed", () => {
  const PLANTED = "PLANTED";
  const hostile = (id: string) => ({
    version: `${PLANTED}-version`,
    evil: `${PLANTED}-top`,
    holds: {
      [OTHER]: "paused",
      bbbbbbbbbbbb: "active",
      ABCDEF123456: "paused",
      "../../etc/x": "paused",
      aaaaaaaaaaa: "paused",
      ["__proto__"]: "paused",
      constructor: "paused",
      [`${PLANTED}-id`]: "paused",
      cccccccccccc: "PAUSED",
      dddddddddddd: "stopped",
      eeeeeeeeeeee: { nested: `${PLANTED}-nested` },
      ffffffffffff: `${PLANTED}-${"x".repeat(20_000)}`,
      [id]: "active",
    },
    at: {
      [OTHER]: OTHER_AT,
      bbbbbbbbbbbb: `${PLANTED}-yesterday`,
      [id]: "2026-13-45T99:99:99Z",
      cccccccccccc: OTHER_AT,
      [`${PLANTED}-at-id`]: OTHER_AT,
    },
    by: {
      [OTHER]: "root",
      bbbbbbbbbbbb: { who: `${PLANTED}-by` },
      [id]: "RESIDENT",
      cccccccccccc: "admin",
      [`${PLANTED}-by-id`]: "admin",
    },
  });

  test("the writer keeps only valid entries, and neither the file nor the reply carries a planted string", () => {
    roll();
    const id = job(EVENING).id;
    seedHolds(hostile(id));
    // Hostile jobs.json fields on our own job too.
    editJobs((all) => {
      Object.assign(all.find((entry) => entry.id === id)!, { prompt: `${PLANTED}-prompt`, schedule_display: `${PLANTED}-display`, extra: { [PLANTED]: true } });
    });
    const paused = spawn(["pause", "--label", "Evening questions"]);
    expect(paused.code).toBe(0);
    expect(paused.stderr).toBe("");
    expect(paused.stdout).not.toContain(PLANTED);
    expect(JSON.parse(paused.stdout)).toEqual({ ok: true, action: "pause", label: "Evening questions", jobs: [{ id, changed: true }], hold: "paused", holds: "ok" });
    const text = holdsText()!;
    expect(text).not.toContain(PLANTED);
    expect(text).not.toContain("root");
    expect(text).not.toContain("RESIDENT");
    const file = JSON.parse(text);
    expect(file).toEqual({
      version: 1,
      // OTHER keeps its state and time; its unknown `by` is dropped, so it reads as an admin's, as before.
      holds: { [OTHER]: "paused", bbbbbbbbbbbb: "active", [id]: "paused" },
      at: { [OTHER]: OTHER_AT, [id]: expect.stringMatching(ISO_MS) },
      by: { [id]: "resident" },
    });
    expect(Object.keys(file)).toEqual(["version", "holds", "at", "by"]);
    const status = spawn(["status"]);
    expect(status.code).toBe(0);
    expect(status.stderr).toBe("");
    expect(status.stdout).not.toContain(PLANTED);
  });

  test("the parser reads exactly what the control plane's readers read", () => {
    const parsed = parseHolds(JSON.stringify(hostile("123456789abc")));
    expect(parsed.status).toBe("ok");
    if (parsed.status !== "ok") return;
    expect(Object.fromEntries(parsed.holds)).toEqual({
      [OTHER]: { state: "paused", at: OTHER_AT },
      bbbbbbbbbbbb: { state: "active" },
      "123456789abc": { state: "active" },
    });
  });
});

describe("one mutating run at a time: the jobs lock", () => {
  test("a held lock: busy, exit 4, no Hermes call; status still answers", () => {
    roll();
    mkdirSync(dirname(jobsLockPath(home)), { recursive: true });
    writeFileSync(jobsLockPath(home), JSON.stringify({ token: "held-by-another-command", pid: 1, at: new Date().toISOString() }));
    const before = calls().length;
    expect(run("pause", "--label", "Daily digest")).toEqual({ code: EXIT.busy, out: { ok: false, error: "busy" } });
    expect(run("resume", "--label", "Daily digest")).toEqual({ code: 4, out: { ok: false, error: "busy" } });
    expect(calls().length).toBe(before);
    expect(holdsText()).toBeNull();
    expect(run("status").code).toBe(0);
    // A grammar refusal is never busy.
    expect(run("pause", "--label", "bogus").out.error).toBe("invalid-label");
    expect(JSON.parse(readFileSync(jobsLockPath(home), "utf8")).token).toBe("held-by-another-command");
  });

  test("a stale lock (older than LOCK_STALE_MS) is taken over, and the run releases its own", () => {
    roll();
    mkdirSync(dirname(jobsLockPath(home)), { recursive: true });
    writeFileSync(jobsLockPath(home), "{}");
    const old = new Date(Date.now() - LOCK_STALE_MS - 60_000);
    utimesSync(jobsLockPath(home), old, old);
    expect(run("pause", "--label", "Daily digest").code).toBe(0);
    expect(existsSync(jobsLockPath(home))).toBe(false);
  });

  test("the lock is the one install/jobs.ts takes", () => {
    expect(jobsLockPath(home)).toBe(jobs.jobsLockPath(home));
    expect(jobsLockPath(home)).toBe(join(home, "av-events", "jobs.lock"));
  });
});

describe("a Hermes step that fails on the way: exit 1, step, applied, and a retry is safe", () => {
  beforeEach(() => {
    roll();
  });

  test("the pause fails: nothing applied, and the hold written before it is put back", () => {
    seedHolds({ version: 1, holds: { [OTHER]: "paused" }, at: { [OTHER]: OTHER_AT }, by: { [OTHER]: "admin" } });
    const text = holdsText();
    process.env.FAKE_HERMES_FAIL = "pause";
    expect(run("pause", "--label", "Evening questions")).toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "pause", label: "Evening questions", applied: [], hold: null, holds: "ok" } });
    expect(holdsText()).toBe(text);
    // With no file before, the file is left with no holds.
    rmSync(holdsPath());
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: false, error: "hermes-failed", hold: null });
    expect(holdsText()).toBe(`${EMPTY_HOLDS}\n`);
    delete process.env.FAKE_HERMES_FAIL;
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: true, hold: "paused" });
  });

  test("the second drop's pause fails: the first is applied and held, the second's hold is put back", () => {
    const midday = job(MIDDAY).id;
    const evening = job(DROP_EVENING).id;
    const order = allJobs().filter((entry) => entry.id === midday || entry.id === evening).map((entry) => entry.id);
    const failing = (args: string[]) => {
      if (args[2] === order[1]) throw new Error("hermes exited 1");
      execFileSync(bin, args, { stdio: "ignore", env: process.env });
    };
    expect(runWith({ hermes: failing }, "pause", "--label", "Introduction suggestion"))
      .toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "pause", label: "Introduction suggestion", applied: [order[0]], hold: null, holds: "ok" } });
    expect(holdsFile().holds).toEqual({ [order[0]]: "paused" });
    expect(run("pause", "--label", "Introduction suggestion").out).toMatchObject({ ok: true, hold: "paused" });
    expect(holdsFile().holds).toEqual({ [midday]: "paused", [evening]: "paused" });
  });

  test("the resume fails before saving: nothing applied, no word of a catch-up, the pause hold is put back byte for byte", () => {
    run("pause", "--label", "Evening questions");
    setNextRun(EVENING, PAST);
    const text = holdsText();
    process.env.FAKE_HERMES_FAIL = "resume";
    expect(run("resume", "--label", "Evening questions")).toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "resume", label: "Evening questions", applied: [], hold: null, holds: "ok" } });
    expect(holdsText()).toBe(text);
  });

  test("the resume saves and then fails, with a missed slot: applied, held active, and the reply says it may fire", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    setNextRun(EVENING, PAST);
    const failing = (args: string[]) => {
      execFileSync(bin, args, { stdio: "ignore", env: process.env });
      if (args[1] === "resume") throw new Error("hermes exited 1 after saving");
    };
    expect(runWith({ hermes: failing }, "resume", "--label", "Evening questions"))
      .toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "resume", label: "Evening questions", applied: [id], hold: "active", holds: "ok", resumeMayFire: true } });
    expect(job(EVENING).next_run_at).toBe(PAST);
  });

  test("the re-anchor fails: exit 1, step reanchor, the resume applied and held, resumeMayFire", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    setNextRun(EVENING, PAST);
    process.env.FAKE_HERMES_FAIL = "edit";
    expect(run("resume", "--label", "Evening questions"))
      .toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "reanchor", label: "Evening questions", applied: [id], hold: "active", holds: "ok", resumeMayFire: true } });
    expect(holdsFile().holds[id]).toBe("active");
  });

  test("a hung Hermes is killed at the timeout: hermes-timeout, exit 1, the lock released", () => {
    const hung = { hermes: hermesCli.hermesRunner(bin, process.env, 400, "ignore"), hermesTimeoutMs: 400 };
    process.env.FAKE_HERMES_HANG = "pause";
    const started = Date.now();
    expect(runWith(hung, "pause", "--label", "Daily digest"))
      .toEqual({ code: 1, out: { ok: false, error: "hermes-timeout", step: "pause", label: "Daily digest", applied: [], hold: null, holds: "ok" } });
    expect(Date.now() - started).toBeLessThan(5_000);
    const pid = Number(readFileSync(join(home, "hermes-hang.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(jobsLockPath(home))).toBe(false);
    expect(holdsText()).toBe(`${EMPTY_HOLDS}\n`);
    // Killed after it saved: read back as applied, and held.
    delete process.env.FAKE_HERMES_HANG;
    process.env.FAKE_HERMES_HANG_AFTER = "pause";
    expect(runWith(hung, "pause", "--label", "Daily digest").out)
      .toEqual({ ok: false, error: "hermes-timeout", step: "pause", label: "Daily digest", applied: [job(DIGEST).id], hold: "paused", holds: "ok" });
  });

  test("the lock is taken over after the resume: lock-lost, no re-anchor, the job held active, and the reply says it may fire", () => {
    const id = job(EVENING).id;
    run("pause", "--label", "Evening questions");
    setNextRun(EVENING, PAST);
    const takeover = (args: string[]) => {
      execFileSync(bin, args, { stdio: "ignore", env: process.env });
      if (args[1] === "resume") writeFileSync(jobsLockPath(home), JSON.stringify({ token: "another-command", pid: 1, at: new Date().toISOString() }));
    };
    expect(runWith({ hermes: takeover }, "resume", "--label", "Evening questions"))
      .toEqual({ code: 1, out: { ok: false, error: "lock-lost", label: "Evening questions", applied: [id], hold: "active", holds: "ok", resumeMayFire: true } });
    expect(calls().at(-1)).toEqual(["cron", "resume", id]);
    // The hold went first, and the job did resume: it stays.
    expect(holdsFile().by[id]).toBe("resident");
    expect(holdsFile().holds[id]).toBe("active");
    expect(JSON.parse(readFileSync(jobsLockPath(home), "utf8")).token).toBe("another-command");
  });

  test("a Hermes step is not started unless it can end before the lock goes stale", () => {
    let t = 1_000_000;
    const slow = {
      clock: () => t,
      hermes: (args: string[]) => {
        execFileSync(bin, args, { stdio: "ignore", env: process.env });
        t += LOCK_STALE_MS - hermesCli.HERMES_TIMEOUT_MS;
      },
    };
    const result = runWith(slow, "pause", "--label", "Introduction suggestion");
    expect(result.out).toMatchObject({ ok: false, error: "lock-lost", hold: null });
    const applied = result.out.applied as string[];
    expect(applied.length).toBe(1);
    // Both holds went first; the one whose pause never started is put back.
    expect(holdsFile().holds).toEqual({ [applied[0]]: "paused" });
  });

  test("a hold that cannot be put back is reported beside the Hermes error, and the reply's hold says what the file holds", () => {
    const id = job(EVENING).id;
    const dir = dirname(holdsPath());
    const failing = (args: string[]) => {
      // The hold is already written; now nothing in av-events/ can be replaced.
      chmodSync(dir, 0o555);
      throw new Error("hermes exited 1");
    };
    try {
      expect(runWith({ hermes: failing }, "pause", "--label", "Evening questions"))
        .toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "pause", label: "Evening questions", applied: [], hold: "paused", holds: "ok", holdError: "hold-restore-failed" } });
    } finally {
      chmodSync(dir, 0o700);
    }
    // The read-only directory kept the lock file too; a real run would find it stale later.
    rmSync(jobsLockPath(home), { force: true });
    expect(holdsFile().holds[id]).toBe("paused");
    expect(storedJobEnabled(job(EVENING))).toBe(true);
    // The retry converges.
    expect(run("pause", "--label", "Evening questions").out).toMatchObject({ ok: true, jobs: [{ id, changed: true }], hold: "paused" });
  });

  test("a hold put back only while it still reads as this run wrote it", () => {
    const id = job(EVENING).id;
    const failing = (args: string[]) => {
      // Someone else (an admin's route) wrote this job's hold after ours.
      seedHolds({ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "admin" } });
      throw new Error("hermes exited 1");
    };
    expect(runWith({ hermes: failing }, "pause", "--label", "Evening questions").out).toMatchObject({ ok: false, error: "hermes-failed", applied: [], hold: "paused" });
    expect(holdsFile()).toEqual({ version: 1, holds: { [id]: "paused" }, at: { [id]: OTHER_AT }, by: { [id]: "admin" } });
  });

  test("Hermes unavailable: hermes-unavailable, exit 2, nothing changed; not probed when nothing needs it", () => {
    const notExecutable = join(home, "not-hermes");
    writeFileSync(notExecutable, "not a program\n");
    chmodSync(notExecutable, 0o644);
    process.env.HERMES_BIN = notExecutable;
    expect(run("pause", "--label", "Daily digest")).toEqual({ code: 2, out: { ok: false, error: "hermes-unavailable", label: "Daily digest" } });
    expect(storedJobEnabled(job(DIGEST))).toBe(true);
    expect(holdsText()).toBeNull();
    process.env.HERMES_BIN = bin;
    run("pause", "--label", "Daily digest");
    process.env.HERMES_BIN = notExecutable;
    expect(run("pause", "--label", "Daily digest").out).toMatchObject({ ok: true, jobs: [{ changed: false }] });
  });
});

describe("status: read-only, no lock, no Hermes", () => {
  test("every label, whether it is installed, and each job's state and hold", () => {
    roll();
    const digest = job(DIGEST).id;
    const evening = job(EVENING).id;
    run("pause", "--label", "Daily digest");
    seedHolds({ ...holdsFile(), holds: { ...holdsFile().holds, [evening]: "active" } });
    setNextRun(DIGEST, PAST);
    mkdirSync(dirname(jobsLockPath(home)), { recursive: true });
    writeFileSync(jobsLockPath(home), JSON.stringify({ token: "held-by-another-command", pid: 1, at: new Date().toISOString() }));
    const before = calls().length;
    const result = run("status");
    expect(calls().length).toBe(before);
    expect(result.code).toBe(0);
    expect(result.out.holds).toBe("ok");
    const labels = result.out.labels as Array<{ label: string; installed: boolean; jobs: Job[] }>;
    expect(labels.map((entry) => [entry.label, entry.installed])).toEqual([
      ["Daily digest", true],
      ["Conversation update", true],
      ["Evening questions", true],
      ["Introduction suggestion", true],
      ["Usage report", false],
    ]);
    expect(labels[0].jobs).toEqual([{ id: digest, enabled: false, hold: "paused", by: "resident", nextRunDue: true }]);
    // A hold with no `by` is an admin's.
    expect(labels[2].jobs).toEqual([{ id: evening, enabled: true, hold: "active", by: "admin", nextRunDue: false }]);
    expect(labels[3].jobs.length).toBe(2);
    expect(labels[4].jobs).toEqual([]);
    for (const entry of labels.flatMap((l) => l.jobs)) expect(Object.keys(entry).sort()).toEqual(["by", "enabled", "hold", "id", "nextRunDue"]);
    expect(run("status", "--label", "evening questions").out).toEqual({ ok: true, action: "status", labels: [labels[2]], holds: "ok" });
    expect(JSON.parse(readFileSync(jobsLockPath(home), "utf8")).token).toBe("held-by-another-command");
  });
});

describe("as the agent runs it: one JSON line on stdout, nothing on stderr", () => {
  test("done, refused, busy and failed alike, with Hermes's own stderr kept out", () => {
    roll();
    const cases: Array<[string[], Record<string, string>, number, string | null]> = [
      [["pause", "--label", "Evening questions"], {}, 0, null],
      [["pause", "--label", "Evening questions"], {}, 0, null],
      [["resume", "--label", "Evening questions"], {}, 0, null],
      [["status"], {}, 0, null],
      [["pause", "--label", "Nope"], {}, 2, "invalid-label"],
      [["frobnicate"], {}, 2, "invalid-action"],
      [["pause", "--label", "Usage report"], {}, 2, "job-missing"],
      // The stand-in writes "forced failure of pause" to its stderr.
      [["pause", "--label", "Daily digest"], { FAKE_HERMES_FAIL: "pause" }, 1, "hermes-failed"],
    ];
    for (const [argv, env, code, error] of cases) {
      const out = spawn(argv, env);
      expect({ argv, code: out.code, stderr: out.stderr }).toEqual({ argv, code, stderr: "" });
      expect(out.stdout.endsWith("\n")).toBe(true);
      expect(out.stdout.trimEnd().split("\n")).toHaveLength(1);
      const parsed = JSON.parse(out.stdout);
      expect(parsed.ok).toBe(code === 0);
      if (error) expect(parsed.error).toBe(error);
    }
    mkdirSync(dirname(jobsLockPath(home)), { recursive: true });
    writeFileSync(jobsLockPath(home), JSON.stringify({ token: "other", pid: 1, at: new Date().toISOString() }));
    const busy = spawn(["pause", "--label", "Daily digest"]);
    expect({ code: busy.code, stdout: busy.stdout, stderr: busy.stderr }).toEqual({ code: 4, stdout: '{"ok":false,"error":"busy"}\n', stderr: "" });
  });

  test("the home comes from --home, then HERMES_HOME; Hermes runs on that home", () => {
    roll();
    const other = mkdtempSync(join(tmpdir(), "av-pause-job-other-"));
    try {
      const out = spawn(["pause", "--label", "Daily digest", "--home", home], { HERMES_HOME: other });
      expect(out.code).toBe(0);
      expect(storedJobEnabled(job(DIGEST))).toBe(false);
      expect(existsSync(join(other, "cron"))).toBe(false);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("one definition each: the shared names and paths", () => {
  test("the contact-style jobs are the control plane's CONTACT_STYLE_CRONS, and every label's jobs are overlay jobs", () => {
    // control-plane/src/tenants.js CONTACT_STYLE_CRONS (origin/main 32226b0): these four names, matched exactly.
    expect([...CONTACT_STYLE_JOB_NAMES].sort()).toEqual([
      "Edge — evening questions",
      "Edge — negotiation summary",
      "Edge — opportunity drop (evening)",
      "Edge — opportunity drop (midday)",
    ]);
    const names = new Set(DIGEST_CRON_SPECS.map((spec) => spec.name));
    for (const name of [...CONTACT_STYLE_JOB_NAMES, ...Object.values(MESSAGE_LABELS).flat()]) expect({ name, known: names.has(name) }).toEqual({ name, known: true });
  });

  test("the holds file's grammars are the control plane's (job-control.js)", () => {
    // control-plane/src/job-control.js HOLD_STATES, HOLD_AT_RE and HOLD_BY (with DATA-376's `resident`), and the 64 KiB read.
    expect([...HOLD_STATES]).toEqual(["paused", "active"]);
    expect([...HOLD_BY_WORDS]).toEqual(["admin", "desired", "resident"]);
    expect(HOLD_AT_RE.source).toBe(String.raw`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$`);
    expect(HOLDS_MAX_BYTES).toBe(65536);
    expect(jobHoldsPath(home)).toBe(join(home, "av-events", "job-holds.json"));
  });

  test("install/ re-exports the moved definitions, so each has one source", () => {
    expect(jobs.HERMES_ID_RE).toBe(HERMES_JOB_ID_RE);
    expect(jobs.jobsLockPath).toBe(jobsLockPath);
    expect(jobs.readJobsStore).toBe(readJobsStore);
    expect(jobs.HERMES_TIMEOUT_MS).toBe(hermesCli.HERMES_TIMEOUT_MS);
    expect(jobs.HermesTimeout).toBe(hermesCli.HermesTimeout);
    expect(jobs.hermesRunner).toBe(hermesCli.hermesRunner);
    expect(installIndexInstalledJobsPath).toBe(installedJobsPath);
    expect(installIndexStoredJobEnabled).toBe(storedJobEnabled);
    expect(hermesCliReexport.hermesBin).toBe(hermesCli.hermesBin);
    expect(hermesCliReexport.hermesExecEnv).toBe(hermesCli.hermesExecEnv);
    expect(HERMES_JOB_ID_RE.source).toBe("^[0-9a-f]{12}$");
  });
});
