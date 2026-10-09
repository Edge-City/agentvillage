/**
 * DATA-430 follow-up (Carter's ruling, rc29): the hourly `Edge — pending
 * opportunity` job ships PRESENT and PAUSED, and PENDING_ALERT_ENABLED turns
 * it on. End to end against the stand-in Hermes that keeps jobs.json
 * (fake_hermes.ts): fresh install, later rolls, the switch both ways, an
 * admin's resume without the switch, a resident's hold, and every other job
 * exactly as before.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  DIGEST_CRON_SPECS,
  PENDING_ALERT_JOB,
  PENDING_ALERT_SWITCH_ENV,
  PENDING_ALERT_SWITCH_FLAG,
  installedJobsPath,
  pendingAlertSettledPath,
  pendingAlertStep,
  pendingAlertSwitch,
  readPendingAlertSettled,
  reconcileDigestCronJobs,
  staggeredSchedule,
  storedJobEnabled,
} from "../install_index";
import { jobHoldsPath } from "../../skills/index-network/scripts/message-labels";

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");
const FAKE = join(import.meta.dir, "fake_hermes.ts");
const SEED = "ix_pending_alert_off_seed";
const ENV_KEYS = ["HERMES_HOME", "HERMES_BIN", "INDEX_API_KEY", "TOKEN_USAGE_AUDIT_CRON", "FAKE_HERMES_FAIL", "HERMES_TIMEZONE",
  "PENDING_ALERT_ENABLED", "PENDING_ALERT_CRON"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-pending-alert-off-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HERMES_HOME = home;
  process.env.INDEX_API_KEY = SEED;
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

type Job = Record<string, any>;

function jobs(): Job[] {
  const path = join(home, "cron", "jobs.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).jobs : [];
}

function job(name: string): Job {
  const found = jobs().filter((entry) => entry.name === name);
  if (found.length !== 1) throw new Error(`expected one job ${name}, found ${found.length}`);
  return found[0];
}

function pending(): Job {
  return job(PENDING_ALERT_JOB);
}

function editJob(id: string, change: Record<string, unknown>): void {
  const all = jobs();
  Object.assign(all.find((entry) => entry.id === id)!, change);
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: all }));
}

function calls(): string[][] {
  const path = join(home, "hermes-calls.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

/** The pause, resume and schedule calls a roll made on one job. */
function stateCalls(id: string): string[][] {
  return calls().filter((argv) => argv[0] === "cron" && argv[2] === id && (argv[1] === "pause" || argv[1] === "resume" || argv.includes("--schedule")));
}

function clearCalls(): void {
  rmSync(join(home, "hermes-calls.jsonl"), { force: true });
}

function installedIds(): string[] {
  return JSON.parse(readFileSync(installedJobsPath(home), "utf8")).ids;
}

/** A roll (the installer's reconcile), quietly, with this install's argv; returns the failed names. */
function roll(...args: string[]): string[] {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return reconcileDigestCronJobs({ ...process.env }, ["bun", "install.ts", ...args]);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function seedHolds(holds: Record<string, string>, by: Record<string, string>): void {
  mkdirSync(dirname(jobHoldsPath(home)), { recursive: true });
  writeFileSync(jobHoldsPath(home), `${JSON.stringify({ version: 1, holds, at: Object.fromEntries(Object.keys(holds).map((id) => [id, "2026-10-09T09:00:00Z"])), by })}\n`);
}

describe("rc29 installs the hourly pending alert present and paused", () => {
  test("a fresh install (a future box, or an rc28 box where the job does not exist yet) creates it, then pauses it; its id is recorded", () => {
    expect(roll()).toEqual([]);
    const job = pending();
    expect({ enabled: job.enabled, state: job.state, paused: Boolean(job.paused_at) }).toEqual({ enabled: false, state: "paused", paused: true });
    expect(storedJobEnabled(job)).toBe(false);
    expect(stateCalls(job.id)).toEqual([["cron", "pause", job.id]]);
    // Still installed and still ours: av-events classifies its cron.run rows by this id.
    expect(installedIds()).toContain(job.id);
    expect(readPendingAlertSettled(home)).toBe(job.id);
    // Its schedule, prompt and shape are the spec's, as before.
    expect(job.schedule.expr).toBe(staggeredSchedule(DIGEST_CRON_SPECS.find((spec) => spec.name === PENDING_ALERT_JOB)!, SEED));
    expect(job.script).toBe("agentvillage_proactive_pending.sh");
    expect(job.deliver).toBe("telegram");
    expect(job.failure_deliver).toBe("local");
  });

  test("a second and a third install leave it paused: no pause or resume, same id", () => {
    roll();
    const id = pending().id;
    clearCalls();
    expect(roll()).toEqual([]);
    expect(roll()).toEqual([]);
    expect(pending().id).toBe(id);
    expect(storedJobEnabled(pending())).toBe(false);
    expect(stateCalls(id)).toEqual([]);
    expect(installedIds()).toContain(id);
  });

  test("every other job is created running, exactly as before: names, schedules, delivery", () => {
    roll();
    const expected = [
      ["Edge — memory signal sync", "0 1 * * *", 50, false],
      ["Edge — digest prepare", "0 2 * * *", 50, false],
      ["Edge — daily digest", "0 8 * * *", 25, true],
      ["Edge — negotiation summary", "0 14 * * *", 25, true],
      ["Edge — evening questions", "0 19 * * *", 25, true],
      ["Edge — opportunity drop (midday)", "0 12 * * *", 25, true],
      ["Edge — opportunity drop (evening)", "0 17 * * *", 25, true],
      ["Edge — pending opportunity", "20 * * * *", 10, true],
      ["Edge — token usage audit", "0 9 * * *", 50, true],
      ["Edge — knowledge sync", "*/30 * * * *", 30, false],
    ];
    expect(DIGEST_CRON_SPECS.map((spec) => [spec.name, spec.schedule, spec.staggerWindowMinutes, spec.deliver])).toEqual(expected);
    // The audit is not installed without its own opt-in; every other spec is, on its staggered slot.
    const installed = DIGEST_CRON_SPECS.filter((spec) => spec.name !== "Edge — token usage audit");
    expect(jobs().map((entry) => entry.name).sort()).toEqual(installed.map((spec) => spec.name).sort());
    for (const spec of installed) {
      const stored = job(spec.name);
      expect({ name: spec.name, expr: stored.schedule.expr }).toEqual({ name: spec.name, expr: staggeredSchedule(spec, SEED) });
      expect({ name: spec.name, deliver: stored.deliver === "telegram" }).toEqual({ name: spec.name, deliver: spec.deliver });
      expect({ name: spec.name, enabled: storedJobEnabled(stored) }).toEqual({ name: spec.name, enabled: spec.name !== PENDING_ALERT_JOB });
    }
    // The only pause a roll makes is the pending alert's.
    expect(calls().filter((argv) => argv[1] === "pause" || argv[1] === "resume")).toEqual([["cron", "pause", pending().id]]);
    expect(installedIds().sort()).toEqual(jobs().map((entry) => entry.id).sort());
  });

  test("a box whose job an earlier main build created running is paused once by the first rc29 roll, then left alone", () => {
    roll(PENDING_ALERT_SWITCH_FLAG, "true");
    const id = pending().id;
    rmSync(pendingAlertSettledPath(home));
    expect(storedJobEnabled(pending())).toBe(true);
    clearCalls();
    roll();
    expect(stateCalls(id)).toEqual([["cron", "pause", id]]);
    expect(storedJobEnabled(pending())).toBe(false);
    clearCalls();
    roll();
    expect(stateCalls(id)).toEqual([]);
  });
});

describe("the switch: PENDING_ALERT_ENABLED", () => {
  test("on at the first install: created running, never paused; later installs, with or without the switch, keep it running", () => {
    process.env.PENDING_ALERT_ENABLED = "true";
    expect(roll()).toEqual([]);
    const id = pending().id;
    expect(storedJobEnabled(pending())).toBe(true);
    expect(stateCalls(id)).toEqual([]);
    clearCalls();
    roll();
    delete process.env.PENDING_ALERT_ENABLED;
    roll();
    expect(storedJobEnabled(pending())).toBe(true);
    expect(stateCalls(id)).toEqual([]);
  });

  test("turned on later, by a roll: the paused job is resumed, and a missed slot is re-anchored, not fired", () => {
    roll();
    const id = pending().id;
    // Paused for a while: the slot it was due at has passed.
    editJob(id, { next_run_at: "2026-10-09T03:50:00+00:00" });
    clearCalls();
    process.env.PENDING_ALERT_ENABLED = "true";
    expect(roll()).toEqual([]);
    expect(storedJobEnabled(pending())).toBe(true);
    expect(stateCalls(id)).toEqual([["cron", "resume", id], ["cron", "edit", id, "--schedule", pending().schedule.expr]]);
    expect(Date.parse(pending().next_run_at)).toBeGreaterThan(Date.now());
    // The switch left on: later rolls change nothing.
    clearCalls();
    roll();
    roll();
    expect(stateCalls(id)).toEqual([]);
  });

  test("the switch in $HERMES_HOME/.env (one line) is read by a roll that is given nothing", () => {
    roll();
    writeFileSync(join(home, ".env"), `INDEX_API_KEY=${SEED}\nPENDING_ALERT_ENABLED=true\n`);
    roll();
    expect(storedJobEnabled(pending())).toBe(true);
    writeFileSync(join(home, ".env"), `INDEX_API_KEY=${SEED}\nPENDING_ALERT_ENABLED=false\n`);
    roll();
    expect(storedJobEnabled(pending())).toBe(false);
  });

  test("on, then off: the job is paused again, and stays paused", () => {
    process.env.PENDING_ALERT_ENABLED = "on";
    roll();
    const id = pending().id;
    expect(storedJobEnabled(pending())).toBe(true);
    process.env.PENDING_ALERT_ENABLED = "off";
    clearCalls();
    expect(roll()).toEqual([]);
    expect(storedJobEnabled(pending())).toBe(false);
    expect(stateCalls(id)).toEqual([["cron", "pause", id]]);
    clearCalls();
    roll();
    expect(stateCalls(id)).toEqual([]);
  });

  test("an admin's resume without the switch (jobs.ts set --enabled true: `hermes cron resume`) survives every later roll", () => {
    roll();
    const id = pending().id;
    execFileSync(bin, ["cron", "resume", id], { stdio: "ignore", env: process.env });
    clearCalls();
    roll();
    roll();
    expect(storedJobEnabled(pending())).toBe(true);
    expect(stateCalls(id)).toEqual([]);
    // And an admin's pause of a job the switch turned on survives a roll without the switch.
    execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env });
    roll();
    expect(storedJobEnabled(pending())).toBe(false);
  });

  test("a resident's hold keeps it paused with the switch on or off; an admin's or the settings' hold, or an unreadable holds file, too", () => {
    process.env.PENDING_ALERT_ENABLED = "true";
    roll();
    const id = pending().id;
    // The resident paused it from chat (pause-job.ts): the hold, then `hermes cron pause`.
    seedHolds({ [id]: "paused" }, { [id]: "resident" });
    execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env });
    for (const value of ["true", "false", "true"]) {
      process.env.PENDING_ALERT_ENABLED = value;
      clearCalls();
      expect(roll()).toEqual([]);
      expect({ value, enabled: storedJobEnabled(pending()) }).toEqual({ value, enabled: false });
      expect(stateCalls(id)).toEqual([]);
    }
    delete process.env.PENDING_ALERT_ENABLED;
    roll();
    expect(storedJobEnabled(pending())).toBe(false);
    process.env.PENDING_ALERT_ENABLED = "true";
    for (const by of ["admin", "desired"]) {
      seedHolds({ [id]: "paused" }, { [id]: by });
      roll();
      expect({ by, enabled: storedJobEnabled(pending()) }).toEqual({ by, enabled: false });
    }
    writeFileSync(jobHoldsPath(home), "not json");
    roll();
    expect(storedJobEnabled(pending())).toBe(false);
    // The hold gone (the resident resumed it from chat, which removes the hold of a job that is not contact-style): the switch resumes it.
    writeFileSync(jobHoldsPath(home), `${JSON.stringify({ version: 1, holds: {} })}\n`);
    roll();
    expect(storedJobEnabled(pending())).toBe(true);
  });

  test("a failed pause is named as a failed job, nothing is recorded, and the next roll pauses it", () => {
    process.env.FAKE_HERMES_FAIL = "pause";
    expect(roll()).toEqual([PENDING_ALERT_JOB]);
    expect(storedJobEnabled(pending())).toBe(true);
    expect(existsSync(pendingAlertSettledPath(home))).toBe(false);
    delete process.env.FAKE_HERMES_FAIL;
    expect(roll()).toEqual([]);
    expect(storedJobEnabled(pending())).toBe(false);
  });
});

describe("the switch and the rule, read directly", () => {
  test("flag, then the environment (present even blank), then .env; the words", () => {
    const argv = (value: string) => ["bun", "install.ts", PENDING_ALERT_SWITCH_FLAG, value];
    expect(PENDING_ALERT_SWITCH_ENV).toBe("PENDING_ALERT_ENABLED");
    expect(PENDING_ALERT_SWITCH_FLAG).toBe("--pending-alert-enabled");
    expect(pendingAlertSwitch([], {})).toBe("unset");
    for (const word of ["true", "TRUE", "on", "1", "yes", "enabled", " true "]) expect({ word, sw: pendingAlertSwitch([], { PENDING_ALERT_ENABLED: word }) }).toEqual({ word, sw: "on" });
    for (const word of ["false", "off", "0", "no", "disabled"]) expect({ word, sw: pendingAlertSwitch([], { PENDING_ALERT_ENABLED: word }) }).toEqual({ word, sw: "off" });
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(pendingAlertSwitch([], { PENDING_ALERT_ENABLED: "20 * * * *" })).toBe("unset");
    } finally {
      console.warn = warn;
    }
    expect(pendingAlertSwitch(argv("false"), { PENDING_ALERT_ENABLED: "true" })).toBe("off");
    writeFileSync(join(home, ".env"), "PENDING_ALERT_ENABLED='true' # turned on\n");
    expect(pendingAlertSwitch([], {})).toBe("on");
    expect(pendingAlertSwitch([], { PENDING_ALERT_ENABLED: "" })).toBe("unset");
    expect(pendingAlertSwitch([], { PENDING_ALERT_ENABLED: "off" })).toBe("off");
    // The schedule override is not the switch.
    rmSync(join(home, ".env"));
    expect(pendingAlertSwitch([], { PENDING_ALERT_CRON: "50 * * * *" })).toBe("unset");
  });

  test("pendingAlertStep", () => {
    const id = "0123456789ab";
    const none = () => ({ status: "ok" as const, holds: new Map() });
    const held = () => ({ status: "ok" as const, holds: new Map([[id, { state: "paused" as const, by: "resident" as const }]]) });
    const unreadable = () => ({ status: "unreadable" as const });
    const noHolds = () => {
      throw new Error("holds read when not needed");
    };
    expect(pendingAlertStep("unset", { id, enabled: true }, null, noHolds)).toBe("pause");
    expect(pendingAlertStep("unset", { id, enabled: true }, "ffffffffffff", noHolds)).toBe("pause");
    expect(pendingAlertStep("unset", { id, enabled: true }, id, noHolds)).toBe("keep");
    expect(pendingAlertStep("unset", { id, enabled: false }, id, noHolds)).toBe("keep");
    expect(pendingAlertStep("unset", { id, enabled: false }, null, noHolds)).toBe("keep");
    expect(pendingAlertStep("off", { id, enabled: true }, id, noHolds)).toBe("pause");
    expect(pendingAlertStep("off", { id, enabled: false }, id, noHolds)).toBe("keep");
    expect(pendingAlertStep("on", { id, enabled: true }, null, noHolds)).toBe("keep");
    expect(pendingAlertStep("on", { id, enabled: false }, null, none)).toBe("resume");
    expect(pendingAlertStep("on", { id, enabled: false }, id, held)).toBe("held");
    expect(pendingAlertStep("on", { id, enabled: false }, id, unreadable)).toBe("held");
  });

  test("the settled record: one shape, else none", () => {
    mkdirSync(join(home, "av-events"), { recursive: true });
    for (const text of ["", "{}", '{"v":1,"settled":"NOT-AN-ID"}', '{"v":2,"settled":"0123456789ab"}', "[]", "null"]) {
      writeFileSync(pendingAlertSettledPath(home), text);
      expect({ text, settled: readPendingAlertSettled(home) }).toEqual({ text, settled: null });
    }
    writeFileSync(pendingAlertSettledPath(home), '{"v":1,"settled":"0123456789ab"}\n');
    expect(readPendingAlertSettled(home)).toBe("0123456789ab");
  });
});
