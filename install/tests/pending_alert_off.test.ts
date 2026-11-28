import { allowPostVillageFixture } from "../../skills/index-network/scripts/tests/post-village-fixtures";
import { postVillageKeyForJob, POST_VILLAGE_KEYS } from "../../skills/index-network/scripts/post-village-policy";
import { runJobsCommand } from "../jobs";
/**
 * DATA-430 follow-up (Carter's ruling, rc29): the hourly `Edge — pending
 * opportunity` remains PRESENT and PAUSED after the event. Operator allow
 * and current gate bytes are required for explicit admin enable; legacy OFF
 * remains an additional gate and legacy ON never auto-resumes. End to end
 * against the stand-in Hermes: identity/schedule preservation, holds and
 * pause/readback failures, with unrelated jobs retaining their own rules.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  DIGEST_CRON_SPECS,
  PENDING_ALERT_JOB,
  PENDING_ALERT_PAUSED_REASON,
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
  "PENDING_ALERT_ENABLED", "PENDING_ALERT_CRON", "FAKE_HERMES_HANG", "FAKE_HERMES_NOOP", "FAKE_HERMES_PAUSED"];
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
  // Current bytes are required for a later explicit admin enable; policy is OFF by default.
  for (const file of ["post-village-policy.ts", "job-holds.ts", "post-village-runnable.ts", "post-village-runnable-pins.json", "proactive.ts", "send-daily-brief.ts", "drop-opportunity.ts", "pending-alert.ts", "summarize-negotiations.ts"]) {
    const relative = join("index-network/scripts", file);
    mkdirSync(dirname(join(home, "skills", relative)), { recursive: true });
    copyFileSync(join(REPO_SKILLS, relative), join(home, "skills", relative));
  }
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
  return rollWithTimeout(undefined, ...args);
}

/** A roll whose pending-alert Hermes calls are killed after `timeoutMs` (undefined: the installer's own). */
function rollWithTimeout(timeoutMs: number | undefined, ...args: string[]): string[] {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return reconcileDigestCronJobs({ ...process.env }, ["bun", "install.ts", ...args], timeoutMs);
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** The `cron create` call for the pending alert, as Hermes was given it. */
function pendingCreate(): string[] | undefined {
  return calls().find((argv) => argv[0] === "cron" && argv[1] === "create" && argv.includes(PENDING_ALERT_JOB));
}

/** A legacy active pending record: OFF must pause it in place, not delete it. */
function runningUnsettled(): string {
  roll();
  // A pre-policy active record, not an installer enable. OFF must pause it in place.
  execFileSync(bin, ["cron", "resume", pending().id], { stdio: "ignore", env: process.env });
  rmSync(pendingAlertSettledPath(home), { force: true });
  expect(storedJobEnabled(pending())).toBe(true);
  clearCalls();
  return pending().id;
}

function enablePending() {
  return runJobsCommand(["set", "--job", "pending", "--enabled", "true"], {
    home, hermesReady: () => true,
    hermes: (args) => { execFileSync(bin, args, { stdio: "ignore", env: process.env }); },
    now: new Date(),
  });
}


function seedHolds(holds: Record<string, string>, by: Record<string, string>): void {
  mkdirSync(dirname(jobHoldsPath(home)), { recursive: true });
  writeFileSync(jobHoldsPath(home), `${JSON.stringify({ version: 1, holds, at: Object.fromEntries(Object.keys(holds).map((id) => [id, "2026-10-09T09:00:00Z"])), by })}\n`);
}

describe("post-village pending alert preserves pause state and requires explicit operator allow", () => {
  test("the policy has nine closed keys; all covered fresh jobs are atomically paused with stable shape", () => {
    expect(POST_VILLAGE_KEYS).toHaveLength(9);
    expect(roll()).toEqual([]);
    const covered = DIGEST_CRON_SPECS.filter((spec) => postVillageKeyForJob(spec.name));
    for (const spec of DIGEST_CRON_SPECS.filter((spec) => spec.name !== "Edge — token usage audit")) {
      const stored = job(spec.name);
      expect(stored.schedule.expr).toBe(staggeredSchedule(spec, SEED));
      expect(storedJobEnabled(stored)).toBe(!postVillageKeyForJob(spec.name));
      expect(stored.deliver === "telegram").toBe(spec.deliver);
    }
    expect(calls().filter((args) => args[1] === "create" && args.includes("--paused")).map((args) => args[args.indexOf("--name") + 1]).sort()).toEqual(covered.map((spec) => spec.name).sort());
    expect(pendingCreate()).toContain("--paused");
    expect(pending().paused_reason).toBe("Post-village operator opt-in required");
    expect(pending().next_run_at).toBeNull();
    expect(installedIds()).toContain(pending().id);
    expect(readPendingAlertSettled(home)).toBeNull();
    expect(calls().filter((args) => ["pause", "resume"].includes(args[1]))).toEqual([]);
  });

  test("successive OFF installs preserve the same paused id and schedule without state calls", () => {
    roll(); const before = { ...pending(), schedule: { ...pending().schedule } }; clearCalls();
    expect(roll()).toEqual([]); expect(roll()).toEqual([]);
    expect(pending()).toEqual(before); expect(stateCalls(before.id)).toEqual([]);
  });

  test("OFF confirms pause of a legacy active job in place, preserving its id and custom schedule", () => {
    const id = runningUnsettled(); editJob(id, { schedule: { kind: "cron", expr: "37 * * * *" } });
    expect(roll()).toEqual([]); expect(pending().id).toBe(id); expect(pending().schedule.expr).toBe("37 * * * *");
    expect(storedJobEnabled(pending())).toBe(false); expect(stateCalls(id)).toEqual([["cron", "pause", id]]);
    expect(calls().filter((args) => args[1] === "remove")).toEqual([]);
  });

  test("legacy ON alone cannot enable a fresh or existing covered job", () => {
    process.env.PENDING_ALERT_ENABLED = "true"; expect(roll()).toEqual([]);
    const id = pending().id; expect(storedJobEnabled(pending())).toBe(false); expect(pendingCreate()).toContain("--paused");
    expect(enablePending().code).toBe(2); expect(roll()).toEqual([]); expect(storedJobEnabled(pending())).toBe(false);
    expect(stateCalls(id)).toEqual([]);
  });

  test("operator allow plus legacy ON still creates paused and never auto-resumes a later paused job", () => {
    allowPostVillageFixture(home, "pending_alert"); process.env.PENDING_ALERT_ENABLED = "true";
    expect(roll()).toEqual([]); const id = pending().id; clearCalls();
    expect(roll()).toEqual([]); expect(pending().id).toBe(id); expect(storedJobEnabled(pending())).toBe(false);
    expect(stateCalls(id)).toEqual([]);
  });

  test("explicit admin enable requires the one allowed key and current bytes; allowed rolls preserve existing state", () => {
    allowPostVillageFixture(home, "pending_alert"); roll(); const id = pending().id;
    expect(enablePending().code).toBe(0); expect(storedJobEnabled(pending())).toBe(true); clearCalls();
    expect(roll()).toEqual([]); expect(roll()).toEqual([]); expect(storedJobEnabled(pending())).toBe(true);
    expect(pending().id).toBe(id); expect(stateCalls(id)).toEqual([]);
    execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env }); clearCalls();
    roll(); expect(storedJobEnabled(pending())).toBe(false); expect(stateCalls(id)).toEqual([]);
  });

  for (const off of ["env", "dotenv", "flag"]) test(`legacy OFF remains an AND gate (${off}); later ON does not resume`, () => {
    allowPostVillageFixture(home, "pending_alert"); roll(); const id = pending().id; expect(enablePending().code).toBe(0); clearCalls();
    if (off === "env") process.env.PENDING_ALERT_ENABLED = "false";
    if (off === "dotenv") writeFileSync(join(home, ".env"), `INDEX_API_KEY=${SEED}\nPENDING_ALERT_ENABLED=false\n`);
    expect(roll(...(off === "flag" ? ["--pending-alert-enabled=false"] : []))).toEqual([]);
    expect(storedJobEnabled(pending())).toBe(false); expect(pending().id).toBe(id); expect(stateCalls(id)).toEqual([["cron", "pause", id]]);
    delete process.env.PENDING_ALERT_ENABLED; rmSync(join(home, ".env"), { force: true }); clearCalls();
    expect(roll("--pending-alert-enabled=true")).toEqual([]); expect(storedJobEnabled(pending())).toBe(false); expect(stateCalls(id)).toEqual([]);
  });

  test("resident, admin, settings and unreadable holds block explicit allowed enable without changing the hold", () => {
    allowPostVillageFixture(home, "pending_alert"); process.env.PENDING_ALERT_ENABLED = "true"; roll(); const id = pending().id;
    for (const by of ["resident", "admin", "desired"]) {
      seedHolds({ [id]: "paused" }, { [id]: by }); const before = readFileSync(jobHoldsPath(home), "utf8"); clearCalls();
      expect(enablePending().code).toBe(2); expect(roll()).toEqual([]); expect(storedJobEnabled(pending())).toBe(false);
      expect(readFileSync(jobHoldsPath(home), "utf8")).toBe(before); expect(stateCalls(id)).toEqual([]);
    }
    writeFileSync(jobHoldsPath(home), "not json"); expect(enablePending().code).toBe(2); expect(storedJobEnabled(pending())).toBe(false);
  });
});

describe("pause/readback failures preserve covered job identity and fail visibly", () => {
  test("fresh atomic paused creation does not depend on a later pause command succeeding", () => {
    process.env.FAKE_HERMES_FAIL = "pause";
    expect(roll()).toEqual([]); const id = pending().id;
    expect(storedJobEnabled(pending())).toBe(false); expect(pendingCreate()).toContain("--paused");
    expect(stateCalls(id)).toEqual([]); expect(calls().filter((args) => args[1] === "remove")).toEqual([]);
    expect(installedIds()).toContain(id);
  });

  const coveredNames = () => DIGEST_CRON_SPECS.filter((spec) => postVillageKeyForJob(spec.name)).map((spec) => spec.name).sort();
  test("unsupported atomic paused creation names every covered failure; uncovered jobs still install", () => {
    process.env.FAKE_HERMES_PAUSED = "refuse"; expect(roll().sort()).toEqual(coveredNames());
    expect(jobs().every((entry) => !postVillageKeyForJob(entry.name))).toBe(true);
    expect(jobs().every((entry) => storedJobEnabled(entry))).toBe(true);
    expect(calls().filter((args) => args[1] === "remove")).toEqual([]);
  });

  test("ignored atomic pause is reported and the same created id is preserved for a later confirmed pause", () => {
    process.env.FAKE_HERMES_PAUSED = "ignore"; expect(roll().sort()).toEqual(coveredNames());
    const id = pending().id; expect(storedJobEnabled(pending())).toBe(true); expect(installedIds()).toContain(id);
    expect(calls().filter((args) => args[1] === "remove")).toEqual([]);
    delete process.env.FAKE_HERMES_PAUSED; expect(roll()).toEqual([]); expect(pending().id).toBe(id); expect(storedJobEnabled(pending())).toBe(false);
  });

  for (const mode of ["fail", "noop", "hang"]) test(`existing ${mode} pause preserves id/schedule, names failure and recovers in place`, () => {
    const id = runningUnsettled(); const schedule = JSON.stringify(pending().schedule);
    const env = mode === "fail" ? "FAKE_HERMES_FAIL" : mode === "noop" ? "FAKE_HERMES_NOOP" : "FAKE_HERMES_HANG";
    process.env[env] = "pause"; const started = Date.now(); expect(rollWithTimeout(1_500)).toEqual([PENDING_ALERT_JOB]);
    expect(Date.now() - started).toBeLessThan(20_000); expect(pending().id).toBe(id); expect(JSON.stringify(pending().schedule)).toBe(schedule);
    expect(storedJobEnabled(pending())).toBe(true); expect(installedIds()).toContain(id);
    expect(calls().filter((args) => args[1] === "remove")).toEqual([]);
    delete process.env[env]; clearCalls(); expect(roll()).toEqual([]); expect(pending().id).toBe(id); expect(storedJobEnabled(pending())).toBe(false);
  }, 30_000);

  test("even a remove failure is irrelevant: an unconfirmed pause never attempts destructive fallback", () => {
    const id = runningUnsettled(); process.env.FAKE_HERMES_NOOP = "pause"; process.env.FAKE_HERMES_FAIL = "remove";
    expect(roll()).toEqual([PENDING_ALERT_JOB]); expect(pending().id).toBe(id);
    expect(calls().filter((args) => args[1] === "remove")).toEqual([]);
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
    // readFlag's `=` form too.
    expect(pendingAlertSwitch(["bun", "install.ts", "--pending-alert-enabled=true"], {})).toBe("on");
    expect(pendingAlertSwitch(["bun", "install.ts", "--pending-alert-enabled=false"], { PENDING_ALERT_ENABLED: "true" })).toBe("off");
    // A flag with no value is ignored (with a warning), never an exit: the environment decides.
    const quiet = console.warn;
    console.warn = () => {};
    try {
      expect(pendingAlertSwitch(["bun", "install.ts", PENDING_ALERT_SWITCH_FLAG], { PENDING_ALERT_ENABLED: "true" })).toBe("on");
      expect(pendingAlertSwitch(["bun", "install.ts", PENDING_ALERT_SWITCH_FLAG, "--dev"], {})).toBe("unset");
    } finally {
      console.warn = quiet;
    }
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


test("a failed explicit allowed resume stays paused and a later admin retry recovers in place", () => {
  allowPostVillageFixture(home, "pending_alert"); roll(); const id = pending().id;
  process.env.FAKE_HERMES_FAIL = "resume"; expect(enablePending().code).toBe(1);
  expect(storedJobEnabled(pending())).toBe(false); expect(pending().id).toBe(id);
  delete process.env.FAKE_HERMES_FAIL; expect(enablePending().code).toBe(0);
  expect(storedJobEnabled(pending())).toBe(true); expect(pending().id).toBe(id);
});
