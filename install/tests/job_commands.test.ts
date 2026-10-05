/**
 * J2: the per-tenant job commands (install/jobs.ts) and what a roll's
 * reconcile does to their results, end to end against a stand-in Hermes that
 * keeps jobs.json (fake_hermes.ts): add, then two rolls, then read what the
 * tenant holds.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { DIGEST_CRON_SPECS, PROACTIVE_SHIM, installedJobsPath, reconcileDigestCronJobs, staggeredSchedule } from "../install_index";
import { PREVIEW_JOB_NAME, PREVIEW_PREAMBLE, type JobsContext, hermesZone, runJobsCommand } from "../jobs";
import { jobSettingsPath } from "../../skills/index-network/scripts/job-settings";
import { cronScanHit } from "../../skills/index-network/scripts/proactive-text";

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");
const FAKE = join(import.meta.dir, "fake_hermes.ts");
const SEED = "ix_job_commands_seed";
const SEND = DIGEST_CRON_SPECS.find((spec) => spec.name === "Edge — daily digest")!;
const ENV_KEYS = ["HERMES_HOME", "HERMES_BIN", "INDEX_API_KEY", "TOKEN_USAGE_AUDIT_CRON", "AV_TEAM_TENANT", "FAKE_HERMES_FAIL", "HERMES_TIMEZONE",
  "DIGEST_SIGNALS_CRON", "DIGEST_PREPARE_CRON", "DIGEST_SEND_CRON"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-job-commands-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HERMES_HOME = home;
  process.env.INDEX_API_KEY = SEED;
  bin = join(home, "hermes");
  writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(bin, 0o755);
  process.env.HERMES_BIN = bin;
  // The installed skills a tenant has: every prompt and script the specs name, and the shim.
  for (const spec of DIGEST_CRON_SPECS) {
    for (const file of [spec.promptFile, spec.scriptFile]) {
      if (!file) continue;
      mkdirSync(dirname(join(home, "skills", file)), { recursive: true });
      copyFileSync(join(REPO_SKILLS, file), join(home, "skills", file));
    }
  }
  copyFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts/ask-questions.md"), join(home, "skills", "edge-esmeralda/prompts/ask-questions.md"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function ctx(over: Partial<JobsContext> = {}): JobsContext {
  return {
    home,
    hermes: (args) => {
      execFileSync(bin, args, { stdio: ["ignore", "ignore", "ignore"], env: process.env });
    },
    hermesReady: () => true,
    now: new Date("2026-10-12T00:00:00Z"),
    ...over,
  };
}

function run(...argv: string[]) {
  return runJobsCommand(argv, ctx());
}

type Job = Record<string, any>;

function jobs(): Job[] {
  const path = join(home, "cron", "jobs.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).jobs : [];
}

function job(name: string): Job | undefined {
  return jobs().find((entry) => entry.name === name);
}

function calls(): string[][] {
  const path = join(home, "hermes-calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

function cronCalls(): string[][] {
  return calls().filter((argv) => argv[0] === "cron");
}

function settingsFile(): Record<string, any> | null {
  return existsSync(jobSettingsPath(home)) ? JSON.parse(readFileSync(jobSettingsPath(home), "utf8")) : null;
}

function installedIds(): string[] {
  return existsSync(installedJobsPath(home)) ? JSON.parse(readFileSync(installedJobsPath(home), "utf8")).ids : [];
}

/** A roll: the installer's reconcile, quietly. */
function roll(): string[] {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return reconcileDigestCronJobs({ ...process.env }, ["bun", "install.ts"]);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

describe("every value is checked against a fixed grammar before anything runs", () => {
  test("the command line itself", () => {
    const cases: Array<[string[], string]> = [
      [[], "unknown-command"],
      [["rm"], "unknown-command"],
      [["set", "--job", "brief", "--bogus", "x"], "unknown-flag"],
      [["set", "--job", "brief", "--job", "brief"], "duplicate-flag"],
      [["set", "--job"], "missing-value"],
      [["set", "--window", "06:00-09:00"], "missing-flag"],
      [["add", "--template", "brief"], "missing-flag"],
      [["set", "--job", "brief"], "nothing-to-set"],
      [["list", "--job", "brief"], "unknown-flag"],
      [["set", "--job", "brief", "--window", "x".repeat(201)], "missing-value"],
    ];
    for (const [argv, error] of cases) {
      const result = run(...argv);
      expect({ argv, code: result.code, ok: result.out.ok, error: result.out.error }).toEqual({ argv, code: 2, ok: false, error });
    }
    expect(calls()).toEqual([]);
  });

  test("job, template, schedule, window, zone and enabled values outside their grammar", () => {
    const cases: Array<[string[], string]> = [
      [["set", "--job", "prefetch", "--window", "06:00-09:00"], "invalid-job"],
      [["set", "--job", "brief; rm -rf /", "--window", "06:00-09:00"], "invalid-job"],
      [["preview", "--job", "memory-signals"], "invalid-job"],
      [["add", "--template", "heartbeat", "--schedule", "0 8 * * *"], "invalid-template"],
      [["remove", "--template", "../brief"], "invalid-template"],
      [["set", "--job", "brief", "--schedule", "0 8-8 * * *"], "invalid-schedule"],
      [["set", "--job", "brief", "--schedule", "0 8 * * MON"], "invalid-schedule"],
      [["set", "--job", "brief", "--schedule", "0 8 * * * *"], "invalid-schedule"],
      [["set", "--job", "brief", "--schedule", "0 8 * * *; touch /tmp/x"], "invalid-schedule"],
      [["set", "--job", "brief", "--schedule", "$(id) 8 * * *"], "invalid-schedule"],
      [["set", "--job", "brief", "--schedule", "every 2h"], "invalid-schedule"],
      [["add", "--template", "brief", "--schedule", "@daily"], "invalid-schedule"],
      [["set", "--job", "brief", "--window", "05:00-24:00"], "invalid-window"],
      [["set", "--job", "brief", "--window", "all-day"], "invalid-window"],
      [["add", "--template", "brief", "--schedule", "0 8 * * *", "--window", "default"], "invalid-window"],
      [["set", "--job", "brief", "--tz", "Etc/UTC"], "invalid-tz"],
      [["set", "--job", "brief", "--tz", "+05:30"], "invalid-tz"],
      [["set", "--job", "brief", "--enabled", "yes"], "invalid-enabled"],
    ];
    for (const [argv, error] of cases) {
      expect({ argv, result: run(...argv) }).toEqual({ argv, result: { code: 2, out: { ok: false, error } } });
    }
    expect(calls()).toEqual([]);
    expect(settingsFile()).toBeNull();
  });
});

describe("set: one job's schedule, window, zone and enabled state", () => {
  beforeEach(() => {
    roll();
  });

  test("a window alone is a settings write and no Hermes call", () => {
    const before = cronCalls().length;
    const result = run("set", "--job", "brief", "--window", "06:00-09:30");
    expect(result).toEqual({ code: 0, out: { ok: true, job: "brief", id: job(SEND.name)!.id, changed: ["settings"], schedule: staggeredSchedule(SEND, SEED), enabled: true, window: "06:00-09:30", tz: "Asia/Kolkata" } });
    expect(settingsFile()).toEqual({ v: 1, jobs: { brief: { window: "06:00-09:30" } } });
    expect(cronCalls().length).toBe(before);
  });

  test("a schedule that would never land in the window is refused and nothing changes", () => {
    const result = run("set", "--job", "brief", "--schedule", "0 15 * * *");
    expect(result).toEqual({ code: 2, out: { ok: false, error: "schedule-outside-window", schedule: "0 15 * * *", window: "05:00-11:00", tz: "Asia/Kolkata" } });
    expect(storedExpr(SEND.name)).toBe(staggeredSchedule(SEND, SEED));
    expect(settingsFile()).toBeNull();
    // Moving the window with it is accepted; the schedule reaches Hermes as one argv element.
    const moved = run("set", "--job", "brief", "--schedule", "30  14 * * *", "--window", "14:00-16:00");
    expect(moved.code).toBe(0);
    expect(moved.out).toMatchObject({ changed: ["schedule", "settings"], schedule: "30 14 * * *", window: "14:00-16:00" });
    expect(cronCalls().at(-1)).toEqual(["cron", "edit", job(SEND.name)!.id, "--schedule", "30 14 * * *"]);
    expect(storedExpr(SEND.name)).toBe("30 14 * * *");
  });

  test("a resident's zone: the schedule stays in Hermes's zone and is checked against the window in theirs", () => {
    expect(run("set", "--job", "drop-evening", "--schedule", "30 19 * * *", "--window", "07:00-09:00", "--tz", "America/New_York").out.error).toBe("schedule-outside-window");
    const ok = run("set", "--job", "drop-evening", "--schedule", "30 17 * * *", "--window", "07:00-09:00", "--tz", "America/New_York");
    expect(ok.out).toMatchObject({ ok: true, schedule: "30 17 * * *", window: "07:00-09:00", tz: "America/New_York" });
  });

  test("enabled is Hermes's pause state: pause, resume, and no call when already so", () => {
    const id = job("Edge — opportunity drop (midday)")!.id;
    expect(run("set", "--job", "drop-midday", "--enabled", "false").out).toMatchObject({ ok: true, changed: ["enabled"], enabled: false });
    expect(cronCalls().at(-1)).toEqual(["cron", "pause", id]);
    expect(job("Edge — opportunity drop (midday)")).toMatchObject({ enabled: false, state: "paused" });
    expect(settingsFile()).toBeNull();
    const before = cronCalls().length;
    expect(run("set", "--job", "drop-midday", "--enabled", "false").out).toMatchObject({ changed: [] });
    expect(cronCalls().length).toBe(before);
    expect(run("set", "--job", "drop-midday", "--enabled", "true").out).toMatchObject({ changed: ["enabled"], enabled: true });
    expect(cronCalls().at(-1)).toEqual(["cron", "resume", id]);
    expect(run("list").out.jobs).toContainEqual(expect.objectContaining({ key: "drop-midday", enabled: true }));
  });

  test("default removes an override; an invalid field of the old entry is dropped and reported", () => {
    expect(run("set", "--job", "negotiation", "--window", "13:00-15:00", "--tz", "Asia/Calcutta").code).toBe(0);
    expect(run("set", "--job", "negotiation", "--tz", "default").out).toMatchObject({ window: "13:00-15:00", tz: "Asia/Kolkata" });
    expect(settingsFile()!.jobs.negotiation).toEqual({ window: "13:00-15:00" });
    writeFileSync(jobSettingsPath(home), JSON.stringify({ v: 1, jobs: { negotiation: { window: "13:00-15:00", tz: "Mars/Olympus", extra: 1 }, evening: { window: "bad" } } }));
    const fixed = run("set", "--job", "negotiation", "--window", "13:00-16:00");
    expect(fixed.out).toMatchObject({ ok: true, dropped: ["tz"], tz: "Asia/Kolkata" });
    // Another job's entry is left exactly as it was.
    expect(settingsFile()).toEqual({ v: 1, jobs: { evening: { window: "bad" }, negotiation: { window: "13:00-16:00" } } });
  });

  test("over an unreadable settings file: the file is replaced and the reply says so", () => {
    writeFileSync(jobSettingsPath(home), "{oops");
    expect(run("set", "--job", "brief", "--window", "06:00-09:00").out).toMatchObject({ ok: true, replaced: "invalid:file-not-json" });
    expect(settingsFile()).toEqual({ v: 1, jobs: { brief: { window: "06:00-09:00" } } });
  });

  test("a failed Hermes edit changes nothing else and says what was applied", () => {
    process.env.FAKE_HERMES_FAIL = "edit";
    const result = run("set", "--job", "brief", "--schedule", "45 9 * * *", "--window", "09:00-10:00");
    expect(result).toEqual({ code: 1, out: { ok: false, error: "hermes-failed", step: "schedule", applied: [] } });
    expect(settingsFile()).toBeNull();
  });

  test("a job that is not installed, and a template job before it is added", () => {
    expect(run("set", "--job", "tpl-brief", "--window", "14:00-16:00").out).toEqual({ ok: false, error: "job-not-installed", job: "tpl-brief" });
  });
});

function storedExpr(name: string): string {
  return job(name)!.schedule.expr;
}

describe("add and remove: one job from a template, for one tenant", () => {
  test("adds the job on its base prompt and its own shim name, records it, and is idempotent", () => {
    roll();
    expect(run("add", "--template", "brief", "--schedule", "0 15 * * *").out).toMatchObject({ error: "schedule-outside-window", window: "05:00-11:00" });
    const added = run("add", "--template", "brief", "--schedule", "0 15 * * *", "--window", "14:00-16:00");
    expect(added.code).toBe(0);
    const created = job("Edge — template: brief")!;
    expect(added.out).toEqual({ ok: true, job: "tpl-brief", id: created.id, result: "created", schedule: "0 15 * * *", window: "14:00-16:00", tz: "Asia/Kolkata" });
    expect(created).toMatchObject({ schedule: { expr: "0 15 * * *" }, script: "agentvillage_proactive_tpl-brief.sh", deliver: "telegram", failure_deliver: "local", enabled: true });
    expect(created.prompt).toBe(readFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts/brief.md"), "utf8").trim());
    expect(created.no_agent).toBeUndefined();
    expect(readFileSync(join(home, "scripts", "agentvillage_proactive_tpl-brief.sh"), "utf8")).toBe(readFileSync(join(REPO_SKILLS, PROACTIVE_SHIM), "utf8"));
    expect(installedIds()).toContain(created.id);
    expect(settingsFile()!.jobs["tpl-brief"]).toEqual({ window: "14:00-16:00" });

    const creates = cronCalls().filter((argv) => argv[1] === "create").length;
    expect(run("add", "--template", "brief", "--schedule", "0 15 * * *").out).toMatchObject({ result: "unchanged", id: created.id, window: "14:00-16:00" });
    expect(run("add", "--template", "brief", "--schedule", "30 14 * * *").out).toMatchObject({ result: "updated", id: created.id, schedule: "30 14 * * *" });
    expect(cronCalls().filter((argv) => argv[1] === "create").length).toBe(creates);
    expect(jobs().filter((entry) => entry.name === "Edge — template: brief")).toHaveLength(1);
  });

  test("each template maps to its base job's prompt; the drop template has no default window", () => {
    expect(run("add", "--template", "digest-preview", "--schedule", "0 16 * * *").out).toMatchObject({ ok: true, window: null });
    expect(job("Edge — template: digest-preview")!.prompt).toBe(readFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts/opportunity-drop.md"), "utf8").trim());
    expect(run("add", "--template", "evening-ask", "--schedule", "0 20 * * *").out).toMatchObject({ ok: true });
    expect(job("Edge — template: evening-ask")!.prompt).toBe(readFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts/ask-questions.md"), "utf8").trim());
    expect(job("Edge — template: evening-ask")!.script).toBe("agentvillage_proactive_tpl-evening-ask.sh");
  });

  test("remove takes the job, its settings and its record away; a second remove is absent", () => {
    roll();
    run("add", "--template", "digest-preview", "--schedule", "0 16 * * *", "--window", "15:00-18:00");
    const id = job("Edge — template: digest-preview")!.id;
    run("set", "--job", "brief", "--window", "06:00-09:00");
    expect(run("remove", "--template", "digest-preview").out).toEqual({ ok: true, job: "tpl-digest-preview", result: "removed", removed: 1 });
    expect(job("Edge — template: digest-preview")).toBeUndefined();
    expect(installedIds()).not.toContain(id);
    expect(settingsFile()).toEqual({ v: 1, jobs: { brief: { window: "06:00-09:00" } } });
    expect(run("remove", "--template", "digest-preview").out).toEqual({ ok: true, job: "tpl-digest-preview", result: "absent", removed: 0 });
  });
});

describe("what a roll keeps", () => {
  test("a template job, its schedule, its pause state and its settings survive two consecutive rolls", () => {
    roll();
    run("add", "--template", "brief", "--schedule", "0 15 * * *", "--window", "14:00-16:00", "--tz", "Asia/Kolkata");
    run("set", "--job", "tpl-brief", "--enabled", "false");
    const before = job("Edge — template: brief")!;
    const settingsBefore = readFileSync(jobSettingsPath(home), "utf8");
    for (const n of [1, 2]) {
      const callsBefore = cronCalls().length;
      expect({ n, failed: roll() }).toEqual({ n, failed: [] });
      expect({ n, job: job("Edge — template: brief") }).toEqual({ n, job: before });
      expect(jobs().filter((entry) => entry.name === "Edge — template: brief")).toHaveLength(1);
      expect(installedIds()).toContain(before.id);
      expect(readFileSync(jobSettingsPath(home), "utf8")).toBe(settingsBefore);
      // Nothing to change: no create, edit or remove at all.
      expect(cronCalls().slice(callsBefore)).toEqual([]);
    }
  });

  test("an admin's schedule, window, zone and pause on a default job survive two rolls", () => {
    roll();
    run("set", "--job", "brief", "--schedule", "45 9 * * *", "--window", "09:00-10:30", "--tz", "Asia/Kolkata");
    run("set", "--job", "negotiation", "--enabled", "false");
    const brief = job(SEND.name)!;
    const negotiation = job("Edge — negotiation summary")!;
    roll();
    roll();
    expect(job(SEND.name)).toEqual(brief);
    expect(job("Edge — negotiation summary")).toEqual(negotiation);
    expect(settingsFile()!.jobs.brief).toEqual({ window: "09:00-10:30", tz: "Asia/Kolkata" });
  });

  test("an admin who sets the old synchronized default on purpose keeps it; without an entry it is migrated as before", () => {
    roll();
    run("set", "--job", "brief", "--schedule", "0 8 * * *");
    expect(settingsFile()!.jobs.brief).toEqual({});
    roll();
    expect(storedExpr(SEND.name)).toBe("0 8 * * *");
    // Without an entry (the legacy case the migration exists for): moved to the staggered slot.
    rmSync(jobSettingsPath(home));
    roll();
    expect(storedExpr(SEND.name)).toBe(staggeredSchedule(SEND, SEED));
  });

  test("a fleet change still lands: a stale prompt on a template job and on an admin-managed job is edited in place", () => {
    roll();
    run("add", "--template", "evening-ask", "--schedule", "0 20 * * *");
    run("set", "--job", "brief", "--window", "06:00-09:00");
    const all = jobs();
    for (const entry of all) if (entry.name === "Edge — template: evening-ask" || entry.name === SEND.name) entry.prompt = "AN OLD PROMPT";
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: all }));
    roll();
    expect(job("Edge — template: evening-ask")!.prompt).toBe(readFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts/ask-questions.md"), "utf8").trim());
    expect(job("Edge — template: evening-ask")!.schedule.expr).toBe("0 20 * * *");
    expect(job(SEND.name)!.prompt).toBe(readFileSync(join(REPO_SKILLS, SEND.promptFile!), "utf8").trim());
  });

  test("a retired template's job and a leftover preview job are removed by the roll", () => {
    roll();
    const all = jobs();
    all.push({ id: "retired1", name: "Edge — template: weekly-recap", prompt: "x", schedule: { expr: "0 9 * * 1" }, enabled: true });
    all.push({ id: "preview1", name: PREVIEW_JOB_NAME, prompt: "x", schedule: { expr: "in 1m" }, enabled: false, state: "completed" });
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: all }));
    roll();
    expect(job("Edge — template: weekly-recap")).toBeUndefined();
    expect(job(PREVIEW_JOB_NAME)).toBeUndefined();
  });
});

describe("preview: a one-shot test job on a team tenant only", () => {
  test("refused (exit 3) unless AV_TEAM_TENANT=1: no job, no Hermes call", () => {
    roll();
    const before = calls().length;
    for (const value of [undefined, "0", "true"]) {
      if (value === undefined) delete process.env.AV_TEAM_TENANT;
      else process.env.AV_TEAM_TENANT = value;
      expect(run("preview", "--job", "brief")).toEqual({ code: 3, out: { ok: false, error: "not-team-tenant" } });
    }
    expect(calls().length).toBe(before);
    expect(job(PREVIEW_JOB_NAME)).toBeUndefined();
  });

  test("on a team tenant: one job that fires once in a minute, under the preview shim name, its prompt marked as a test", () => {
    process.env.AV_TEAM_TENANT = "1";
    const result = run("preview", "--job", "drop-midday");
    const preview = job(PREVIEW_JOB_NAME)!;
    expect(result).toEqual({ code: 0, out: { ok: true, job: "drop-midday", id: preview.id, fires: "in 1m" } });
    expect(preview).toMatchObject({ schedule: { expr: "in 1m" }, script: "agentvillage_proactive_preview-drop-midday.sh", deliver: "telegram", failure_deliver: "local" });
    expect(preview.prompt.startsWith(PREVIEW_PREAMBLE.trim().split("\n")[0])).toBe(true);
    expect(preview.prompt).toContain(readFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts/opportunity-drop.md"), "utf8").trim());
    expect(existsSync(join(home, "scripts", "agentvillage_proactive_preview-drop-midday.sh"))).toBe(true);
    // A second preview replaces the first: one preview job at a time.
    run("preview", "--job", "tpl-evening-ask");
    expect(jobs().filter((entry) => entry.name === PREVIEW_JOB_NAME)).toHaveLength(1);
    expect(job(PREVIEW_JOB_NAME)!.script).toBe("agentvillage_proactive_preview-tpl-evening-ask.sh");
    // Never in the installed record: cron.run carries no name for it.
    expect(installedIds()).not.toContain(job(PREVIEW_JOB_NAME)!.id);
  });

  test("the preview preamble passes the cron prompt scan with every job's prompt", () => {
    expect(cronScanHit(PREVIEW_PREAMBLE)).toBeNull();
    for (const file of ["brief.md", "opportunity-drop.md", "negotiation-summary.md", "ask-questions.md"]) {
      expect({ file, hit: cronScanHit(`${PREVIEW_PREAMBLE}${readFileSync(join(REPO_SKILLS, "edge-esmeralda/prompts", file), "utf8")}`) }).toEqual({ file, hit: null });
    }
  });
});

describe("list, and the zone schedules are read in", () => {
  test("list: every installed proactive job with its schedule, enabled state, window, zone and settings source", () => {
    roll();
    run("set", "--job", "brief", "--window", "06:00-09:00");
    const listed = run("list");
    expect(listed.code).toBe(0);
    expect(listed.out.settings).toBe("ok");
    expect(listed.out.missing).toEqual([]);
    const byKey = Object.fromEntries((listed.out.jobs as Job[]).map((entry) => [entry.key, entry]));
    expect(Object.keys(byKey).sort()).toEqual(["brief", "drop-evening", "drop-midday", "evening", "negotiation"]);
    expect(byKey.brief).toEqual({ key: "brief", id: job(SEND.name)!.id, name: SEND.name, schedule: staggeredSchedule(SEND, SEED), enabled: true, window: "06:00-09:00", tz: "Asia/Kolkata", settings: "custom" });
    expect(byKey.negotiation).toMatchObject({ window: null, settings: "default" });
  });

  test("hermesZone: config.yaml's timezone, else HERMES_TIMEZONE, else the village zone", () => {
    expect(hermesZone(home)).toBe("Asia/Kolkata");
    process.env.HERMES_TIMEZONE = "Europe/Lisbon";
    expect(hermesZone(home)).toBe("Europe/Lisbon");
    writeFileSync(join(home, "config.yaml"), "timezone: America/Denver\n");
    expect(hermesZone(home)).toBe("America/Denver");
    writeFileSync(join(home, "config.yaml"), "timezone: Not/AZone\n");
    expect(hermesZone(home)).toBe("Europe/Lisbon");
  });
});
