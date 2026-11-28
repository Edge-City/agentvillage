import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { DIGEST_CRON_SPECS, reconcileDigestCronJobs, storedJobEnabled } from "../install_index";
import { postVillageKeyForJob } from "../../skills/index-network/scripts/post-village-policy";
const keys = ["HERMES_HOME", "HERMES_BIN", "INDEX_API_KEY", "TOKEN_USAGE_AUDIT_CRON", "FAKE_HERMES_FAIL", "FAKE_HERMES_NOOP", "FAKE_HERMES_PAUSED", "PENDING_ALERT_ENABLED"];
let saved: Record<string, string | undefined>;
let home: string;
const repo = join(import.meta.dir, "../..");
beforeEach(() => {
  saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  home = mkdtempSync(join(tmpdir(), "av-test-policy-reconcile-")); process.env.HERMES_HOME = home; process.env.INDEX_API_KEY = "synthetic-not-an-api-key";
  const bin = join(home, "hermes"); writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${join(repo, "install/tests/fake_hermes.ts")}" "$@"\n`); chmodSync(bin, 0o755); process.env.HERMES_BIN = bin;
  writeFileSync(join(home, "config.yaml"), "timezone: Asia/Kolkata\n");
  for (const spec of DIGEST_CRON_SPECS) for (const file of [spec.promptFile, spec.scriptFile]) if (file) {
    const target = join(home, "skills", file); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repo, "skills", file), target);
  }
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; });
function reconcile() { const log = console.log, warn = console.warn; console.log = console.warn = () => {}; try { return reconcileDigestCronJobs({ ...process.env }, ["bun", "install.ts"]); } finally { console.log = log; console.warn = warn; } }
function jobs(): any[] { return JSON.parse(readFileSync(join(home, "cron/jobs.json"), "utf8")).jobs; }
function calls(): string[][] { return readFileSync(join(home, "hermes-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line)); }
function save(j: any[]) { writeFileSync(join(home, "cron/jobs.json"), JSON.stringify({ jobs: j })); }
test("fresh covered jobs are atomically paused even with the legacy enable flag", () => {
  process.env.PENDING_ALERT_ENABLED = "true"; expect(reconcile()).toEqual([]);
  const covered = jobs().filter((job) => postVillageKeyForJob(job.name)); expect(covered).toHaveLength(6);
  for (const job of covered) expect(storedJobEnabled(job)).toBe(false);
  for (const args of calls().filter((args) => args[1] === "create" && postVillageKeyForJob(args[args.indexOf("--name") + 1]!))) expect(args).toContain("--paused");
  expect(jobs().find((job) => job.name === "Edge — knowledge sync").enabled).toBe(true);
});
test("OFF reconciliation preserves existing ID, schedule and holds while pausing", () => {
  expect(reconcile()).toEqual([]); const before = jobs(); const job = before.find((job) => job.name === "Edge — daily digest");
  Object.assign(job, { enabled: true, state: "scheduled", paused_at: null, schedule: { kind: "cron", expr: "17 10 * * *" } }); save(before);
  mkdirSync(join(home, "av-events"), { recursive: true }); const holds = JSON.stringify({ holds: { [job.id]: "paused" }, by: { [job.id]: "admin" } }); writeFileSync(join(home, "av-events/job-holds.json"), holds);
  expect(reconcile()).toEqual([]); const after = jobs().find((entry) => entry.id === job.id); expect(after.enabled).toBe(false); expect(after.schedule).toEqual(job.schedule);
  expect(readFileSync(join(home, "av-events/job-holds.json"), "utf8")).toBe(holds); expect(calls().some((args) => args[1] === "remove")).toBe(false);
});
test("explicit policy survives reinstall and never resumes an already paused job", () => {
  mkdirSync(join(home, "av-events")); const raw = '{"version":1,"enabled":["daily_digest"]}\n'; writeFileSync(join(home, "av-events/post-village-policy.json"), raw);
  expect(reconcile()).toEqual([]); expect(jobs().find((job) => job.name === "Edge — daily digest").enabled).toBe(false);
  expect(reconcile()).toEqual([]); expect(calls().some((args) => args[1] === "resume")).toBe(false); expect(readFileSync(join(home, "av-events/post-village-policy.json"), "utf8")).toBe(raw);
  const current = jobs(); Object.assign(current.find((job) => job.name === "Edge — daily digest"), { enabled: true, state: "scheduled", paused_at: null }); save(current);
  expect(reconcile()).toEqual([]); expect(jobs().find((job) => job.name === "Edge — daily digest").enabled).toBe(true);
});
test("lying pause readback reports failure and preserves the existing job without delete", () => {
  expect(reconcile()).toEqual([]); const current = jobs(); const job = current.find((entry) => entry.name === "Edge — daily digest"); Object.assign(job, { enabled: true, state: "scheduled", paused_at: null }); save(current);
  process.env.FAKE_HERMES_NOOP = "pause"; expect(reconcile()).toContain(job.name); expect(jobs().find((entry) => entry.id === job.id).enabled).toBe(true); expect(calls().some((args) => args[1] === "remove")).toBe(false);
});
test("ignored atomic paused create cannot claim success or delete the job", () => {
  process.env.FAKE_HERMES_PAUSED = "ignore"; const failed = reconcile(); for (const job of jobs().filter((entry) => postVillageKeyForJob(entry.name))) expect(failed).toContain(job.name); expect(calls().some((args) => args[1] === "remove")).toBe(false);
});

test("explicit operator allow never overrides the existing pending-alert OFF switch", () => {
  expect(reconcile()).toEqual([]); mkdirSync(join(home, "av-events"), { recursive: true });
  const policy = '{"version":1,"enabled":["pending_alert"]}'; writeFileSync(join(home, "av-events/post-village-policy.json"), policy);
  const current = jobs(); const pending = current.find((entry) => entry.name === "Edge — pending opportunity"); Object.assign(pending, { enabled: true, state: "scheduled", paused_at: null }); save(current);
  process.env.PENDING_ALERT_ENABLED = "false"; expect(reconcile()).toEqual([]);
  expect(jobs().find((entry) => entry.id === pending.id).enabled).toBe(false); expect(calls().some((args) => args[1] === "remove")).toBe(false);
  expect(readFileSync(join(home, "av-events/post-village-policy.json"), "utf8")).toBe(policy);
});
test("legacy pending ON plus operator allow preserves current state and never resumes a pause", () => {
  expect(reconcile()).toEqual([]); mkdirSync(join(home, "av-events"), { recursive: true }); writeFileSync(join(home, "av-events/post-village-policy.json"), '{"version":1,"enabled":["pending_alert"]}');
  process.env.PENDING_ALERT_ENABLED = "true"; expect(reconcile()).toEqual([]); expect(jobs().find((entry) => entry.name === "Edge — pending opportunity").enabled).toBe(false);
  const current = jobs(); const pending = current.find((entry) => entry.name === "Edge — pending opportunity"); Object.assign(pending, { enabled: true, state: "scheduled", paused_at: null }); save(current);
  expect(reconcile()).toEqual([]); expect(jobs().find((entry) => entry.id === pending.id).enabled).toBe(true); expect(calls().some((args) => args[1] === "resume")).toBe(false);
});

test("Index preserves only the two reserved ZZZ families, pauses OFF rows in place, and never adopts them", () => {
  expect(reconcile()).toEqual([]);
  const reserved = [
    { id: "a11111111111", name: "Edge — zzz pairs", enabled: true, state: "scheduled", script: "legacy-pairs.sh", schedule: { kind: "cron", expr: "17 10 * * *" } },
    { id: "b11111111111", name: "Edge — zzz event autonomy", enabled: true, state: "scheduled", script: "zzz_autonomy_runner.py", no_agent: true, enabled_toolsets: ["no_mcp"], deliver: "local", failure_deliver: "local", repeat: { times: null }, schedule: { kind: "cron", expr: "2-59/5 * * * *" } },
  ];
  save([...jobs(), ...reserved, { id: "c11111111111", name: "Edge — retired unrelated", enabled: false }]);
  expect(reconcile()).toEqual([]);
  for (const job of reserved) {
    const after = jobs().find((entry) => entry.id === job.id);
    expect(after).toMatchObject({ id: job.id, enabled: false, script: job.script, schedule: job.schedule });
  }
  expect(calls().filter((args) => args[1] === "remove")).toEqual([["cron", "remove", "c11111111111"]]);
  expect(JSON.parse(readFileSync(join(home, "av-events/installed_jobs.json"), "utf8")).zzzJobId).toBeUndefined();
  const policy = '{"version":1,"enabled":["zzz_pairs","zzz_event_autonomy"]}';
  writeFileSync(join(home, "av-events/post-village-policy.json"), policy);
  const allowed = jobs(); allowed.find((entry) => entry.id === reserved[0]!.id).enabled = true; save(allowed);
  const before = readFileSync(join(home, "cron/jobs.json"), "utf8");
  expect(reconcile()).toEqual([]); expect(readFileSync(join(home, "cron/jobs.json"), "utf8")).toBe(before);
  expect(calls().some((args) => args[1] === "resume")).toBe(false);
  expect(JSON.parse(readFileSync(join(home, "av-events/installed_jobs.json"), "utf8")).zzzJobId).toBeUndefined();
});
test("reserved ZZZ OFF pause failure or lying readback reports failure and preserves IDs without removal", () => {
  expect(reconcile()).toEqual([]);
  const reserved = [
    { id: "d11111111111", name: "Edge — zzz pairs", enabled: true, state: "scheduled", script: "legacy-pairs.sh", schedule: { kind: "cron", expr: "17 10 * * *" } },
    { id: "e11111111111", name: "Edge — zzz event autonomy", enabled: true, state: "scheduled", script: "zzz_autonomy_runner.py", schedule: { kind: "cron", expr: "2-59/5 * * * *" } },
  ];
  save([...jobs(), ...reserved]);
  for (const mode of ["FAKE_HERMES_FAIL", "FAKE_HERMES_NOOP"] as const) {
    process.env[mode] = "pause";
    const failed = reconcile(); for (const job of reserved) { expect(failed).toContain(job.name); expect(jobs().find((entry) => entry.id === job.id)).toEqual(job); }
    delete process.env[mode];
  }
  expect(calls().some((args) => args[1] === "remove")).toBe(false);
});
