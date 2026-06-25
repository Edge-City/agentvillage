/**
 * Integration tests for reconcileDigestCronJobs: run the real reconcile loop
 * against a stub `hermes` binary (records every invocation to a log file) and
 * a temp HERMES_HOME, covering the create / prompt-edit / schedule-migrate /
 * preserve paths end-to-end.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DIGEST_CRON_SPECS,
  reconcileDigestCronJobs,
  staggeredSchedule,
} from "../install_index";

const SEED = "ix_integration_seed";
const [SIGNALS, PREPARE, SEND, NEGOTIATION, PLAZA, EVENING, DROP_MIDDAY, DROP_EVENING, TOKEN_AUDIT] = DIGEST_CRON_SPECS;
// The retired "Edge — heartbeat" cron name — used to assert it is torn down.
const RETIRED_HEARTBEAT_NAME = "Edge — heartbeat";
const PROMPT_BODIES = new Map([
  [SIGNALS.promptFile, "SIGNALS_BODY"],
  [PREPARE.promptFile, "PREPARE_BODY"],
  [SEND.promptFile, "SEND_BODY"],
  [NEGOTIATION.promptFile, "NEGOTIATION_BODY"],
  [PLAZA.promptFile, "PLAZA_BODY"],
  [EVENING.promptFile, "EVENING_BODY"],
  // Both opportunity-drop crons share one prompt file.
  [DROP_MIDDAY.promptFile, "DROP_BODY"],
]);

let home: string;
let stubLog: string;
let savedEnv: Record<string, string | undefined>;

function writeStubHermes(dir: string, { rejectScheduleFlag = false } = {}): string {
  const bin = join(dir, "hermes");
  const rejectBlock = rejectScheduleFlag
    ? `for arg in "$@"; do if [ "$arg" = "--schedule" ]; then exit 2; fi; done\n`
    : "";
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
if [ "$1" = "--version" ]; then echo "stub 0.0.0"; exit 0; fi
${rejectBlock}printf '%s\n' "$(printf '%s\x1f' "$@")" >> "${join(dir, "calls.log")}"
exit 0
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Parse the stub's call log into argv arrays (one per invocation). */
function stubCalls(): string[][] {
  let raw: string;
  try {
    raw = readFileSync(stubLog, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
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

function installedPlazaScript(): string {
  return join(home, "scripts", PLAZA.scriptInstallName!);
}

function currentJob(spec: typeof DIGEST_CRON_SPECS[number], id: string): Record<string, unknown> {
  const job: Record<string, unknown> = {
    id,
    name: spec.name,
    prompt: spec.promptFile ? PROMPT_BODIES.get(spec.promptFile) : spec.promptBody,
    schedule: { expr: staggeredSchedule(spec, SEED) },
  };
  if (spec.scriptFile) job.script = spec.scriptInstallName;
  return job;
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
    AGENT_PLAZA_SELFIE_CRON: process.env.AGENT_PLAZA_SELFIE_CRON,
    TOKEN_USAGE_AUDIT_CRON: process.env.TOKEN_USAGE_AUDIT_CRON,
  };
  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = writeStubHermes(home);
  process.env.INDEX_API_KEY = SEED;
  delete process.env.HEARTBEAT_CRON;
  delete process.env.DIGEST_SIGNALS_CRON;
  delete process.env.DIGEST_PREPARE_CRON;
  delete process.env.DIGEST_SEND_CRON;
  delete process.env.AGENT_PLAZA_SELFIE_CRON;
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

test("fresh install creates digest crons (no heartbeat) on their staggered schedules", () => {
  reconcileDigestCronJobs({ ...process.env });

  const creates = cronCalls().filter((argv) => argv[1] === "create");
  expect(creates).toHaveLength(DIGEST_CRON_SPECS.length);
  expect(creates.some((argv) => argv.includes(RETIRED_HEARTBEAT_NAME))).toBe(false);

  const signals = creates.find((argv) => argv.includes(SIGNALS.name))!;
  const prepare = creates.find((argv) => argv.includes(PREPARE.name))!;
  const send = creates.find((argv) => argv.includes(SEND.name))!;
  const negotiation = creates.find((argv) => argv.includes(NEGOTIATION.name))!;
  const plaza = creates.find((argv) => argv.includes(PLAZA.name))!;
  const evening = creates.find((argv) => argv.includes(EVENING.name))!;
  const audit = creates.find((argv) => argv.includes(TOKEN_AUDIT.name))!;
  expect(signals[2]).toBe(staggeredSchedule(SIGNALS, SEED));
  expect(signals[3]).toBe("SIGNALS_BODY");
  expect(signals).toContain("--script");
  expect(signals).toContain("agentvillage_memory_signal_gate.py");
  expect(prepare[2]).toBe(staggeredSchedule(PREPARE, SEED));
  expect(prepare[3]).toBe("PREPARE_BODY");
  expect(send[2]).toBe(staggeredSchedule(SEND, SEED));
  expect(send[3]).toBe("SEND_BODY");
  expect(negotiation[2]).toBe(staggeredSchedule(NEGOTIATION, SEED));
  expect(negotiation[3]).toBe("NEGOTIATION_BODY");
  expect(plaza[2]).toBe(staggeredSchedule(PLAZA, SEED));
  expect(plaza[3]).toBe("PLAZA_BODY");
  expect(plaza).toContain("--skill");
  expect(plaza).toContain("agent-plaza");
  expect(plaza).toContain("--script");
  expect(plaza).toContain(PLAZA.scriptInstallName);
  expect(evening[2]).toBe(staggeredSchedule(EVENING, SEED));
  expect(evening[3]).toBe("EVENING_BODY");
  expect(audit[2]).toBe(TOKEN_AUDIT.schedule);
  expect(audit[3]).toContain("deterministic local token usage audit");
  expect(audit).toContain("--skill");
  expect(audit).toContain("token-usage-audit");
  expect(audit).toContain("--script");
  expect(audit).toContain(TOKEN_AUDIT.scriptInstallName);
  expect(readFileSync(installedMemorySignalScript(), "utf8")).toContain("wakeAgent");
  expect(readFileSync(installedPlazaScript(), "utf8")).toContain("wakeAgent");
  expect(readFileSync(installedTokenAuditScript(), "utf8")).toContain("wakeAgent");
  expect(send).toContain("--deliver");
  expect(negotiation).toContain("--deliver");
  expect(plaza).toContain("--deliver");
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
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([["cron", "remove", "h1"]]);
});

test("jobs still on old synchronized defaults get schedule-only migrations", () => {
  writeJobs([
    { id: "g1", name: SIGNALS.name, prompt: "SIGNALS_BODY", script: SIGNALS.scriptInstallName, schedule: { expr: SIGNALS.schedule } },
    { id: "p1", name: PREPARE.name, prompt: "PREPARE_BODY", schedule: { expr: PREPARE.schedule } },
    { id: "s1", name: SEND.name, prompt: "SEND_BODY", schedule: { expr: SEND.schedule } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const calls = cronCalls();
  expect(calls).toEqual([
    ["cron", "edit", "g1", "--schedule", staggeredSchedule(SIGNALS, SEED)],
    ["cron", "edit", "p1", "--schedule", staggeredSchedule(PREPARE, SEED)],
    ["cron", "edit", "s1", "--schedule", staggeredSchedule(SEND, SEED)],
  ]);
});

test("custom schedule is preserved; stale prompt gets a prompt-only edit", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    { id: "p1", name: PREPARE.name, prompt: "OLD_BODY", schedule: { expr: "30 4 * * *" } },
    { id: "s1", name: SEND.name, prompt: "SEND_BODY", schedule: { expr: "15 9 * * *" } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([
    ["cron", "edit", "p1", "--prompt", "PREPARE_BODY"],
  ]);
});

test("memory signal sync cron is recreated when its script path is stale", () => {
  writeJobs([
    { ...currentJob(SIGNALS, "g1"), script: undefined },
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const calls = cronCalls();
  expect(calls[0]).toEqual(["cron", "remove", "g1"]);
  const create = calls[1];
  expect(create[0]).toBe("cron");
  expect(create[1]).toBe("create");
  expect(create).toContain(SIGNALS.name);
  expect(create).toContain("--script");
  expect(create).toContain(SIGNALS.scriptInstallName);
});

test("stale prompt + old default schedule produce two independent edit calls", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    { id: "s1", name: SEND.name, prompt: "OLD_BODY", schedule: { expr: SEND.schedule } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
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
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
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
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
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
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
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
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
  ]);

  reconcileDigestCronJobs(env);

  expect(cronCalls()).toEqual([["cron", "remove", "a1"]]);
});

test("token usage audit cron is recreated when its script path is stale", () => {
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    currentJob(SEND, "s1"),
    currentJob(NEGOTIATION, "n1"),
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    {
      ...currentJob(TOKEN_AUDIT, "a1"),
      script: join(home, "skills", "token-usage-audit/scripts/old_audit.py"),
    },
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const calls = cronCalls();
  expect(calls[0]).toEqual(["cron", "remove", "a1"]);
  const create = calls[1];
  expect(create[0]).toBe("cron");
  expect(create[1]).toBe("create");
  expect(create).toContain(TOKEN_AUDIT.name);
  expect(create).toContain("--script");
  expect(create).toContain(TOKEN_AUDIT.scriptInstallName);
});

test("a Hermes that rejects --schedule still gets the prompt update (degraded migration)", () => {
  process.env.HERMES_BIN = writeStubHermes(home, { rejectScheduleFlag: true });
  writeJobs([
    currentJob(SIGNALS, "g1"),
    currentJob(PREPARE, "p1"),
    { id: "s1", name: SEND.name, prompt: "OLD_BODY", schedule: { expr: SEND.schedule } },
    currentJob(NEGOTIATION, "n1"),
    currentJob(PLAZA, "z1"),
    currentJob(EVENING, "e1"),
    currentJob(DROP_MIDDAY, "dm1"),
    currentJob(DROP_EVENING, "de1"),
    currentJob(TOKEN_AUDIT, "a1"),
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
