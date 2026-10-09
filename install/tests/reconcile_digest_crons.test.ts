/**
 * Integration tests for reconcileDigestCronJobs: run the real reconcile loop
 * against a stub `hermes` binary (records every invocation to a log file) and
 * a temp HERMES_HOME, covering the create / prompt-edit / schedule-migrate /
 * preserve paths end-to-end.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DIGEST_CRON_SPECS,
  PREFETCH_PROMPT,
  reconcileDigestCronJobs,
  staggeredSchedule,
} from "../install_index";
import { cronFailedLine, installStatusPath, writeInstallStatus } from "../install_status";
import YAML from "yaml";

const SEED = "ix_integration_seed";
const [SIGNALS, PREPARE, SEND, NEGOTIATION, EVENING, DROP_MIDDAY, DROP_EVENING, PENDING, TOKEN_AUDIT, KNOWLEDGE] = DIGEST_CRON_SPECS;
// The retired "Edge — heartbeat" cron name — used to assert it is torn down.
const RETIRED_HEARTBEAT_NAME = "Edge — heartbeat";
const RETIRED_PLAZA_SELFIE_NAME = "Edge — Agent Plaza selfie";
const PROMPT_BODIES = new Map([
  [SIGNALS.promptFile, "SIGNALS_BODY"],
  [PREPARE.promptFile, "PREPARE_BODY"],
  [SEND.promptFile, "SEND_BODY"],
  [NEGOTIATION.promptFile, "NEGOTIATION_BODY"],
  [EVENING.promptFile, "EVENING_BODY"],
  // Both opportunity-drop crons share one prompt file.
  [DROP_MIDDAY.promptFile, "DROP_BODY"],
  [PENDING.promptFile, "PENDING_BODY"],
]);

let home: string;
let stubLog: string;
let savedEnv: Record<string, string | undefined>;

function writeStubHermes(dir: string, { rejectScheduleFlag = false, failEditIds = [] as string[] } = {}): string {
  const bin = join(dir, "hermes");
  const rejectBlock = rejectScheduleFlag
    ? `for arg in "$@"; do if [ "$arg" = "--schedule" ]; then exit 2; fi; done\n`
    : "";
  // Logged first, so a failed edit still shows as attempted.
  const failBlock = failEditIds.map((id) => `if [ "$1" = "cron" ] && [ "$2" = "edit" ] && [ "$3" = "${id}" ]; then exit 1; fi\n`).join("");
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "stub 0.0.0"; exit 0; fi
${rejectBlock}printf '%s\x1e' "$(printf '%s\x1f' "$@")" >> "${join(dir, "calls.log")}"
${failBlock}exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Parse the stub's call log into argv arrays (one per invocation). Calls end
 * with \x1e, not a newline: an inline prompt (the token usage audit's) spans
 * lines.
 */
function stubCalls(): string[][] {
  let raw: string;
  try {
    raw = readFileSync(stubLog, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\x1e")
    .filter(Boolean)
    .map((line) => line.split("\x1f").filter((part) => part !== ""));
}

function cronCalls(): string[][] {
  return stubCalls().filter((argv) => argv[0] === "cron");
}

function writePrompts(): void {
  const skills = join(home, "skills");
  for (const [promptFile, body] of PROMPT_BODIES) {
    if (!promptFile) continue;
    const promptPath = join(skills, promptFile);
    mkdirSync(dirname(promptPath), { recursive: true });
    writeFileSync(promptPath, body);
  }
  for (const spec of DIGEST_CRON_SPECS) {
    if (!spec.scriptFile) continue;
    const scriptPath = join(skills, spec.scriptFile);
    mkdirSync(dirname(scriptPath), { recursive: true });
    writeFileSync(scriptPath, "#!/usr/bin/env python3\nprint('{\"wakeAgent\":false}')\n");
  }
}

function writeJobs(jobs: unknown[]): void {
  mkdirSync(join(home, "cron"), { recursive: true });
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs }));
}

function installedTokenAuditScript(): string {
  return join(home, "scripts", TOKEN_AUDIT.scriptInstallName!);
}

function installedMemorySignalScript(): string {
  return join(home, "scripts", SIGNALS.scriptInstallName!);
}

function currentJob(spec: typeof DIGEST_CRON_SPECS[number], id: string): Record<string, unknown> {
  const job: Record<string, unknown> = {
    id,
    name: spec.name,
    prompt: spec.promptFile ? PROMPT_BODIES.get(spec.promptFile) : spec.promptBody,
    schedule: { expr: staggeredSchedule(spec, SEED) },
  };
  if (spec.scriptFile) job.script = spec.scriptInstallName;
  if (spec.noAgent) job.no_agent = true;
  if (spec.failureDeliver) job.failure_deliver = spec.failureDeliver;
  return { ...job, ...rc29PauseState(spec) };
}

/** rc29 installs the pending alert paused (pending_alert_off.test.ts); a fixture of an installed tenant holds it so. */
function rc29PauseState(spec: typeof DIGEST_CRON_SPECS[number]): Record<string, unknown> {
  return spec === PENDING ? { enabled: false, state: "paused", paused_at: "2026-10-09T09:20:00Z" } : {};
}

/** A job as main left it before DATA-314: no proactive script, agent mode, no failure target. */
function oldShapeJob(spec: typeof DIGEST_CRON_SPECS[number], id: string, prompt: string): Record<string, unknown> {
  return { id, name: spec.name, prompt, schedule: { expr: staggeredSchedule(spec, SEED) }, ...rc29PauseState(spec) };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "edge-reconcile-"));
  stubLog = join(home, "calls.log");
  savedEnv = {
    HERMES_HOME: process.env.HERMES_HOME,
    HERMES_BIN: process.env.HERMES_BIN,
    INDEX_API_KEY: process.env.INDEX_API_KEY,
    HEARTBEAT_CRON: process.env.HEARTBEAT_CRON,
    DIGEST_SIGNALS_CRON: process.env.DIGEST_SIGNALS_CRON,
    DIGEST_PREPARE_CRON: process.env.DIGEST_PREPARE_CRON,
    DIGEST_SEND_CRON: process.env.DIGEST_SEND_CRON,
    TOKEN_USAGE_AUDIT_CRON: process.env.TOKEN_USAGE_AUDIT_CRON,
  };
  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = writeStubHermes(home);
  process.env.INDEX_API_KEY = SEED;
  delete process.env.HEARTBEAT_CRON;
  delete process.env.DIGEST_SIGNALS_CRON;
  delete process.env.DIGEST_PREPARE_CRON;
  delete process.env.DIGEST_SEND_CRON;
  process.env.TOKEN_USAGE_AUDIT_CRON = TOKEN_AUDIT.schedule;
  writePrompts();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test("fresh install creates digest crons (no heartbeat or Plaza selfie) on their staggered schedules", () => {
  reconcileDigestCronJobs({ ...process.env });

  const creates = cronCalls().filter((argv) => argv[1] === "create");
  expect(creates).toHaveLength(DIGEST_CRON_SPECS.length);
  expect(creates.some((argv) => argv.includes(RETIRED_HEARTBEAT_NAME))).toBe(false);

  const signals = creates.find((argv) => argv.includes(SIGNALS.name))!;
  const prepare = creates.find((argv) => argv.includes(PREPARE.name))!;
  const send = creates.find((argv) => argv.includes(SEND.name))!;
  const negotiation = creates.find((argv) => argv.includes(NEGOTIATION.name))!;
  const evening = creates.find((argv) => argv.includes(EVENING.name))!;
  const audit = creates.find((argv) => argv.includes(TOKEN_AUDIT.name))!;
  // DATA-430: the hourly pending alert, staggered over :20 to :29, delivered, failures local.
  const pending = creates.find((argv) => argv.includes(PENDING.name))!;
  expect(PENDING.name).toBe("Edge — pending opportunity");
  expect(pending[2]).toBe(staggeredSchedule(PENDING, SEED));
  expect(Number(pending[2].split(" ")[0])).toBeGreaterThanOrEqual(20);
  expect(Number(pending[2].split(" ")[0])).toBeLessThan(30);
  expect(pending[3]).toBe("PENDING_BODY");
  expect(pending).toContain("agentvillage_proactive_pending.sh");
  expect(pending).toContain("--deliver");
  expect(pending).not.toContain("--no-agent");
  expect(pending[pending.indexOf("--failure-deliver") + 1]).toBe("local");
  expect(readFileSync(join(home, "scripts", "agentvillage_proactive_pending.sh"), "utf8")).toContain("wakeAgent");
  expect(signals[2]).toBe(staggeredSchedule(SIGNALS, SEED));
  expect(signals[3]).toBe("SIGNALS_BODY");
  expect(signals).toContain("--script");
  expect(signals).toContain("agentvillage_memory_signal_gate.py");
  expect(prepare[2]).toBe(staggeredSchedule(PREPARE, SEED));
  expect(prepare[3]).toBe(PREFETCH_PROMPT);
  expect(prepare).toContain("--no-agent");
  expect(prepare).toContain("agentvillage_proactive_prefetch.sh");
  expect(send).toContain("agentvillage_proactive_brief.sh");
  expect(send).not.toContain("--no-agent");
  for (const argv of [prepare, send, negotiation, evening, audit]) {
    expect(argv[argv.indexOf("--failure-deliver") + 1]).toBe("local");
  }
  expect(readFileSync(join(home, "scripts", "agentvillage_proactive_evening.sh"), "utf8")).toContain("wakeAgent");
  expect(send[2]).toBe(staggeredSchedule(SEND, SEED));
  expect(send[3]).toBe("SEND_BODY");
  expect(negotiation[2]).toBe(staggeredSchedule(NEGOTIATION, SEED));
  expect(negotiation[3]).toBe("NEGOTIATION_BODY");
  expect(evening[2]).toBe(staggeredSchedule(EVENING, SEED));
  expect(evening[3]).toBe("EVENING_BODY");
  expect(audit[2]).toBe(TOKEN_AUDIT.schedule);
  expect(audit[3]).toContain("deterministic local token usage audit");
  // The whole multi-line prompt, Usage report line last, is one argument.
  expect(audit[3]).toBe(TOKEN_AUDIT.promptBody!.trimEnd());
  expect(audit[3].endsWith("\n\n(Usage report message - you can ask me to stop or manage it)")).toBe(true);
  expect(audit).toContain("--skill");
  expect(audit).toContain("token-usage-audit");
  expect(audit).toContain("--script");
  expect(audit).toContain(TOKEN_AUDIT.scriptInstallName);
  expect(readFileSync(installedMemorySignalScript(), "utf8")).toContain("wakeAgent");
  expect(readFileSync(installedTokenAuditScript(), "utf8")).toContain("wakeAgent");
  expect(send).toContain("--deliver");
  expect(negotiation).toContain("--deliver");
  expect(evening).toContain("--deliver");
  expect(audit).toContain("--deliver");
  expect(signals).not.toContain("--deliver");
  expect(prepare).not.toContain("--deliver");
});

test("an existing Edge — heartbeat cron is retired on reconcile", () => {
  writeJobs([
    { id: "h1", name: RETIRED_HEARTBEAT_NAME, prompt: "HEARTBEAT_BODY", schedule: { expr: "*/30 * * * *" } },
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([["cron", "remove", "h1"]]);
});

test("an existing Edge — Agent Plaza selfie cron is retired on reconcile", () => {
  writeJobs([
    { id: "z1", name: RETIRED_PLAZA_SELFIE_NAME, prompt: "PLAZA_BODY", schedule: { expr: "0 16 * * *" } },
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([["cron", "remove", "z1"]]);
});

test("jobs still on old synchronized defaults get schedule-only migrations", () => {
  writeJobs([
    { id: "g1", name: SIGNALS.name, prompt: "SIGNALS_BODY", script: SIGNALS.scriptInstallName, schedule: { expr: SIGNALS.schedule } },
    { ...currentJob(PREPARE, "p1"), schedule: { expr: PREPARE.schedule } },
    { ...currentJob(SEND, "s1"), schedule: { expr: SEND.schedule } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const calls = cronCalls();
  expect(calls).toEqual([
    ["cron", "edit", "g1", "--schedule", staggeredSchedule(SIGNALS, SEED)],
    ["cron", "edit", "s1", "--schedule", staggeredSchedule(SEND, SEED)],
    // The prefetch is reconciled last (B1-fix F9).
    ["cron", "edit", "p1", "--schedule", staggeredSchedule(PREPARE, SEED)],
  ]);
});

test("custom schedule is preserved; stale prompt gets a prompt-only edit", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    { ...currentJob(PREPARE, "p1"), prompt: "OLD_BODY", schedule: { expr: "30 4 * * *" } },
    { ...currentJob(SEND, "s1"), schedule: { expr: "15 9 * * *" } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([
    ["cron", "edit", "p1", "--prompt", PREFETCH_PROMPT],
  ]);
});

test("memory signal sync cron gets its script back in place when its script path is stale", () => {
  writeJobs([
    { ...currentJob(SIGNALS, "g1"), script: undefined },
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([["cron", "edit", "g1", "--script", SIGNALS.scriptInstallName!]]);
});

test("stale prompt + old default schedule produce two independent edit calls", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    { ...currentJob(SEND, "s1"), prompt: "OLD_BODY", schedule: { expr: SEND.schedule } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const sendEdits = cronCalls().filter((argv) => argv[2] === "s1");
  expect(sendEdits).toEqual([
    ["cron", "edit", "s1", "--prompt", "SEND_BODY"],
    ["cron", "edit", "s1", "--schedule", staggeredSchedule(SEND, SEED)],
  ]);
});

test("up-to-date jobs (staggered schedule + current prompt) trigger no cron calls", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([]);
});

test("retired Edge-prefixed crons are removed; foreign crons are untouched", () => {
  writeJobs([
    { id: "old1", name: "Edge — old heartbeat", prompt: "X", schedule: { expr: "0 6 * * *" } },
    { id: "user1", name: "my own job", prompt: "Y", schedule: { expr: "0 7 * * *" } },
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const removes = cronCalls().filter((argv) => argv[1] === "remove");
  expect(removes).toEqual([["cron", "remove", "old1"]]);
});

test("token usage audit cron is removed when opted out", () => {
  const env = { ...process.env, TOKEN_USAGE_AUDIT_CRON: "off" };
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs(env);

  expect(cronCalls()).toEqual([["cron", "remove", "a1"]]);
});

test("token usage audit cron is removed when no explicit schedule opts in", () => {
  const env = { ...process.env };
  delete env.TOKEN_USAGE_AUDIT_CRON;
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs(env);

  expect(cronCalls()).toEqual([["cron", "remove", "a1"]]);
});

test("token usage audit cron gets its script back in place when its script path is stale", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    {
      ...currentJob(TOKEN_AUDIT, "a1"),
      script: join(home, "skills", "token-usage-audit/scripts/old_audit.py"),
    },
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([["cron", "edit", "a1", "--script", TOKEN_AUDIT.scriptInstallName!]]);
});

test("a Hermes that rejects --schedule still gets the prompt update (degraded migration)", () => {
  process.env.HERMES_BIN = writeStubHermes(home, { rejectScheduleFlag: true });
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    { ...currentJob(SEND, "s1"), prompt: "OLD_BODY", schedule: { expr: SEND.schedule } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  // The schedule edit died (exit 2, never logged) but the prompt edit landed.
  expect(cronCalls()).toEqual([
    ["cron", "edit", "s1", "--prompt", "SEND_BODY"],
  ]);
});

test("DIGEST_SEND_CRON override beats the staggered default on create", () => {
  process.env.DIGEST_SEND_CRON = "45 7 * * *";

  reconcileDigestCronJobs({ ...process.env });

  const send = cronCalls().find((argv) => argv[1] === "create" && argv.includes(SEND.name))!;
  expect(send[2]).toBe("45 7 * * *");
});

/**
 * A stub `hermes` that keeps `cron/jobs.json` the way Hermes does: `cron
 * create` appends a job with a `uuid4().hex[:12]`-shaped id, `cron remove`
 * drops one. For the installed-job record (DATA-92), which reads ids back.
 */
function writeStatefulStubHermes(dir: string): string {
  const bin = join(dir, "hermes");
  writeFileSync(
    bin,
    `#!${process.execPath}
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { randomBytes } = require("node:crypto");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("stub 0.0.0"); process.exit(0); }
const path = ${JSON.stringify(join(dir, "cron", "jobs.json"))};
const doc = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { jobs: [] };
if (args[0] === "cron" && args[1] === "create") {
  doc.jobs.push({ id: randomBytes(6).toString("hex"), name: args[args.indexOf("--name") + 1] });
} else if (args[0] === "cron" && args[1] === "remove") {
  doc.jobs = doc.jobs.filter((job) => job.id !== args[2]);
}
writeFileSync(path, JSON.stringify(doc));
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function installedIds(): string[] {
  return (JSON.parse(readFileSync(join(home, "av-events", "installed_jobs.json"), "utf8")) as { ids: string[] }).ids;
}

function storedJobs(): { id: string; name: string }[] {
  return (JSON.parse(readFileSync(join(home, "cron", "jobs.json"), "utf8")) as { jobs: { id: string; name: string }[] }).jobs;
}

test("a fresh install records the id of every cron it created (DATA-92)", () => {
  process.env.HERMES_BIN = writeStatefulStubHermes(home);
  writeJobs([]);

  reconcileDigestCronJobs({ ...process.env });

  expect(storedJobs()).toHaveLength(DIGEST_CRON_SPECS.length);
  expect(installedIds()).toEqual(storedJobs().map((job) => job.id).sort());
});

test("a participant's job named like an installer cron is not recorded as ours (DATA-92)", () => {
  process.env.HERMES_BIN = writeStatefulStubHermes(home);
  const ours = DIGEST_CRON_SPECS.map((spec, n) => currentJob(spec, `00000000000${n}`));
  const theirs = { id: "fedcba987654", name: SEND.name, prompt: "remind me about Alice", schedule: { expr: "0 9 * * *" } };
  writeJobs([...ours, theirs]);

  reconcileDigestCronJobs({ ...process.env });

  expect(installedIds()).toEqual(ours.map((job) => job.id as string).sort());
  expect(installedIds()).not.toContain(theirs.id);
});

test("a job edited in place keeps its id in the record (DATA-92, DATA-314)", () => {
  process.env.HERMES_BIN = writeStatefulStubHermes(home);
  const ours = DIGEST_CRON_SPECS.map((spec, n) => currentJob(spec, `00000000000${n}`));
  const signals = ours[DIGEST_CRON_SPECS.indexOf(SIGNALS)];
  signals.script = "stale.py";
  writeJobs(ours);

  reconcileDigestCronJobs({ ...process.env });

  expect(installedIds()).toEqual(ours.map((job) => job.id as string).sort());
});

test("an upgrade roll from the pre-DATA-314 jobs is one in-place edit per job: nothing removed, created or paused", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    oldShapeJob(PREPARE, "p1", "OLD_PREPARE"),
    oldShapeJob(SEND, "s1", "OLD_SEND"),
    oldShapeJob(NEGOTIATION, "n1", "NEGOTIATION_OLD"),
    oldShapeJob(EVENING, "e1", "EVENING_OLD"),
    oldShapeJob(DROP_MIDDAY, "dm1", "DROP_OLD"),
    oldShapeJob(DROP_EVENING, "de1", "DROP_OLD"),
    oldShapeJob(PENDING, "pa1", "PENDING_OLD"),
    { ...currentJob(TOKEN_AUDIT, "a1"), failure_deliver: undefined },
    currentJob(KNOWLEDGE, "k1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const shape = (id: string, prompt: string, action: string) => [
    "cron", "edit", id, "--prompt", prompt, "--script", `agentvillage_proactive_${action}.sh`, "--failure-deliver", "local",
  ];
  expect(cronCalls()).toEqual([
    shape("s1", "SEND_BODY", "brief"),
    shape("n1", "NEGOTIATION_BODY", "negotiation"),
    shape("e1", "EVENING_BODY", "evening"),
    shape("dm1", "DROP_BODY", "drop-midday"),
    shape("de1", "DROP_BODY", "drop-evening"),
    shape("pa1", "PENDING_BODY", "pending"),
    ["cron", "edit", "a1", "--failure-deliver", "local"],
    // The prefetch last: edited before the brief, a cut-short roll would leave no brief (B1-fix F9).
    [...shape("p1", PREFETCH_PROMPT, "prefetch").slice(0, 7), "--no-agent", "--failure-deliver", "local"],
  ]);
  // A second roll finds everything in shape.
  writeJobs(DIGEST_CRON_SPECS.map((spec, n) => currentJob(spec, `job${n}`)));
  writeFileSync(stubLog, "");
  reconcileDigestCronJobs({ ...process.env });
  expect(cronCalls()).toEqual([]);
});

test("a job switched to no_agent by hand goes back to agent mode", () => {
  writeJobs(DIGEST_CRON_SPECS.map((spec) => ({ ...currentJob(spec, spec === SEND ? "s1" : `x${spec.schedule}`), ...(spec === SEND ? { no_agent: true } : {}) })));

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([["cron", "edit", "s1", "--agent"]]);
});

test("F9: one failed edit: every other job is still attempted, the prefetch after the brief, and the failure is named and returned", () => {
  process.env.HERMES_BIN = writeStubHermes(home, { failEditIds: ["s1"] });
  writeJobs([
    currentJob(SIGNALS, "g1"),
    oldShapeJob(PREPARE, "p1", "OLD_PREPARE"),
    oldShapeJob(SEND, "s1", "OLD_SEND"),
    oldShapeJob(NEGOTIATION, "n1", "NEGOTIATION_OLD"),
    oldShapeJob(EVENING, "e1", "EVENING_OLD"),
    oldShapeJob(DROP_MIDDAY, "dm1", "DROP_OLD"),
    oldShapeJob(DROP_EVENING, "de1", "DROP_OLD"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
  const warn = spyOn(console, "warn").mockImplementation(() => {});

  let failed: string[];
  try {
    failed = reconcileDigestCronJobs({ ...process.env });
  } finally {
    log.mockRestore();
    warn.mockRestore();
  }

  expect(failed).toEqual([SEND.name]);
  expect(cronCalls().map((argv) => argv[2])).toEqual(["s1", "n1", "e1", "dm1", "de1", "p1"]);
  const summary = lines.filter((line) => line.includes("Index crons:"));
  expect(summary).toEqual([`→ warning: Index crons: 1 failed (${SEND.name}); the tenant may run a mix of old and new jobs`]);
});

test("F9: nothing failed: an empty list and a one-line all-clear", () => {
  writeJobs(DIGEST_CRON_SPECS.map((spec, n) => currentJob(spec, `job${n}`)));
  const lines: string[] = [];
  const log = spyOn(console, "log").mockImplementation((line: string) => void lines.push(String(line)));
  let failed: string[];
  try {
    failed = reconcileDigestCronJobs({ ...process.env });
  } finally {
    log.mockRestore();
  }
  expect(failed).toEqual([]);
  expect(lines.filter((line) => line.includes("Index crons:"))).toEqual(["→ Index crons: every job in shape"]);
});

test("F9: the standalone reconcile exits non-zero after attempting every job when one fails", () => {
  process.env.HERMES_BIN = writeStubHermes(home, { failEditIds: ["n1"] });
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    oldShapeJob(NEGOTIATION, "n1", "NEGOTIATION_OLD"),
    oldShapeJob(EVENING, "e1", "EVENING_OLD"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(PENDING, "pa1"),
    currentJob(TOKEN_AUDIT, "a1"),
    currentJob(KNOWLEDGE, "k1"),
  ]);
  const done = Bun.spawnSync(["bun", join(import.meta.dir, "..", "reconcile_digest_crons.ts")], {
    env: { ...process.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(done.exitCode).toBe(1);
  expect(done.stderr.toString()).toContain(`1 Index cron job(s) failed to update (${NEGOTIATION.name})`);
  expect(cronCalls().map((argv) => argv[2])).toEqual(["n1", "e1"]);
  // DATA-373: the standalone reconcile also turns Hermes's cron wrapper off, as install.ts does.
  expect(YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")).cron).toEqual({ script_timeout_seconds: 120, wrap_response: false });
});

test("F13: prompts are compared and sent with trailing whitespace trimmed, so a created job is not re-edited", () => {
  // `hermes cron create` stores the prompt stripped; a prompt file ends with a newline.
  writeFileSync(join(home, "skills", SEND.promptFile!), "SEND_BODY\n\n");
  writeJobs(DIGEST_CRON_SPECS.map((spec, n) => currentJob(spec, spec === SEND ? "s1" : `job${n}`)));

  reconcileDigestCronJobs({ ...process.env });
  expect(cronCalls()).toEqual([]);

  // A job an older roll edited stores the raw text: also in shape.
  writeJobs(DIGEST_CRON_SPECS.map((spec, n) => ({ ...currentJob(spec, spec === SEND ? "s1" : `job${n}`), ...(spec === SEND ? { prompt: "SEND_BODY\n\n" } : {}) })));
  reconcileDigestCronJobs({ ...process.env });
  expect(cronCalls()).toEqual([]);

  // A stale one gets the trimmed text; a fresh create sends it trimmed too.
  writeJobs(DIGEST_CRON_SPECS.map((spec, n) => ({ ...currentJob(spec, spec === SEND ? "s1" : `job${n}`), ...(spec === SEND ? { prompt: "OLD" } : {}) })));
  reconcileDigestCronJobs({ ...process.env });
  expect(cronCalls()).toEqual([["cron", "edit", "s1", "--prompt", "SEND_BODY"]]);
  writeFileSync(stubLog, "");
  writeJobs([]);
  reconcileDigestCronJobs({ ...process.env });
  expect(cronCalls().find((argv) => argv[1] === "create" && argv.includes(SEND.name))![3]).toBe("SEND_BODY");
});

test("F9: install.ts records the cron failures before the approval gate and the restart, and never exits on them", () => {
  // install.ts runs main() on import, so its order is pinned on the source.
  const source = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const main = source.slice(source.indexOf("function main(): void {"));
  const recorded = main.indexOf("cronFailures = installIndex();");
  const status = main.indexOf("writeInstallStatus(hermesHome(), cronFailures);");
  const approval = main.indexOf("runApprovalStep(SOURCE_SKILLS)");
  const restart = main.indexOf("restartGateway();");
  const report = main.indexOf("if (cronFailures.length > 0) {");
  expect(recorded).toBeGreaterThan(0);
  expect(status).toBeGreaterThan(recorded);
  expect(approval).toBeGreaterThan(status);
  expect(restart).toBeGreaterThan(approval);
  expect(report).toBeGreaterThan(restart);
  expect(main.slice(report, report + 400)).not.toContain("process.exit");
});

/** Run install.ts itself against the temp HERMES_HOME and the stub hermes, as the control plane does (--no-restart). */
function runInstall(): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home };
  for (const key of ["AV_APPROVAL_ENABLED", "AV_RECALL_ENABLED", "HERMES_TIMEZONE"]) delete env[key];
  const done = Bun.spawnSync(["bun", join(import.meta.dir, "..", "install.ts"), "--index-api-key", SEED, "--no-restart"], {
    cwd: join(import.meta.dir, "..", ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: done.exitCode ?? -1, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

function installStatus(): { version: number; at: string; cron_failed: string[] } {
  return JSON.parse(readFileSync(installStatusPath(home), "utf8"));
}

test("R1: a failed cron edit exits 0, writes the status file with the job's name, and prints the one count line; a clean run empties it", () => {
  process.env.HERMES_BIN = writeStubHermes(home, { failEditIds: ["n1"] });
  // The pending alert is present (paused): the stub keeps no jobs.json, so one it created could not be read back and paused.
  writeJobs([oldShapeJob(NEGOTIATION, "n1", "NEGOTIATION_OLD"), currentJob(PENDING, "pa1")]);

  const failed = runInstall();
  expect({ code: failed.code, stderr: failed.code === 0 ? "" : failed.stderr }).toEqual({ code: 0, stderr: "" });
  const status = installStatus();
  expect(status.version).toBe(1);
  expect(status.cron_failed).toEqual([NEGOTIATION.name]);
  expect(new Date(status.at).toISOString()).toBe(status.at);
  expect(statSync(installStatusPath(home)).mode & 0o777).toBe(0o600);
  expect(failed.stdout.split("\n").filter((line) => line.startsWith("agentvillage-install:"))).toEqual([cronFailedLine(1)]);
  expect(cronFailedLine(1)).toBe("agentvillage-install: cron_failed=1");
  // Nothing claims a gateway restart this process did not do.
  expect(`${failed.stdout}${failed.stderr}`).not.toContain("gateway restart included");
  expect(failed.stderr).toContain(`1 Index cron job(s) failed to update (${NEGOTIATION.name})`);

  process.env.HERMES_BIN = writeStubHermes(home);
  const clean = runInstall();
  expect(clean.code).toBe(0);
  // DATA-373: after install, Hermes's cron wrapper is off.
  expect(YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")).cron.wrap_response).toBe(false);
  expect(installStatus().cron_failed).toEqual([]);
  expect(clean.stdout).not.toContain("agentvillage-install:");
  expect(readdirSync(join(home, "av-events")).filter((name) => name.includes(".tmp"))).toEqual([]);
}, 60_000);

test("R1: the status file is written by temp file and rename, 0600, with an empty list when nothing failed", () => {
  const at = new Date("2026-10-12T02:30:00.000Z");
  expect(writeInstallStatus(home, [SEND.name], at)).toEqual({ version: 1, at: "2026-10-12T02:30:00.000Z", cron_failed: [SEND.name] });
  expect(installStatus()).toEqual({ version: 1, at: "2026-10-12T02:30:00.000Z", cron_failed: [SEND.name] });
  writeInstallStatus(home, [], at);
  expect(installStatus().cron_failed).toEqual([]);
  expect(statSync(installStatusPath(home)).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(home, "av-events"))).toEqual(["install-status.json"]);
});

test("DATA-361: after the prompts and the gate moved to skills/index-network, an existing tenant's jobs are left as they are (same ids, schedules, prompts, script)", () => {
  // The tenant as an update leaves it: the repo's real prompts and gate at
  // their new paths, and the copies an older install left under
  // skills/edge-esmeralda (the skill copy never deletes) still on disk.
  const repoSkills = join(import.meta.dir, "..", "..", "skills");
  const skills = join(home, "skills");
  const moved = [...new Set(DIGEST_CRON_SPECS.flatMap((spec) => [spec.promptFile, spec.scriptFile]).filter((file): file is string => !!file && file.startsWith("index-network/") && !file.includes("/shims/")))];
  expect(moved.sort()).toEqual([
    "index-network/prompts/ask-questions.md",
    "index-network/prompts/brief.md",
    "index-network/prompts/memory-signals.md",
    "index-network/prompts/negotiation-summary.md",
    "index-network/prompts/opportunity-drop.md",
    // DATA-430: new since the move; it never lived under edge-esmeralda (the copy there is harmless).
    "index-network/prompts/pending-alert.md",
    "index-network/scripts/memory_signal_gate.py",
  ]);
  for (const file of moved) {
    const text = readFileSync(join(repoSkills, file), "utf8");
    for (const target of [file, file.replace(/^index-network\//, "edge-esmeralda/")]) {
      mkdirSync(dirname(join(skills, target)), { recursive: true });
      writeFileSync(join(skills, target), text);
    }
  }
  // Its jobs were created before the move from the same prompt text (the move
  // changed no byte of it), on their staggered slots, with their scripts.
  const jobs = DIGEST_CRON_SPECS.map((spec, n) => ({
    ...currentJob(spec, `job${n}`),
    prompt: spec.promptFile ? readFileSync(join(repoSkills, spec.promptFile), "utf8").trimEnd() : spec.promptBody,
  }));
  writeJobs(jobs);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([]);
  expect(installedIds()).toEqual(jobs.map((job) => job.id as string).sort());
  expect(readFileSync(installedMemorySignalScript(), "utf8")).toBe(readFileSync(join(repoSkills, SIGNALS.scriptFile!), "utf8"));
});
