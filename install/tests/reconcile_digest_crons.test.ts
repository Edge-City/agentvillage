/**
 * Integration tests for reconcileDigestCronJobs: run the real reconcile loop
 * against a stub `hermes` binary (records every invocation to a log file) and
 * a temp HERMES_HOME, covering the create / prompt-edit / schedule-migrate /
 * preserve paths end-to-end.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIGEST_CRON_SPECS,
  reconcileDigestCronJobs,
  staggeredSchedule,
} from "../install_index";

const SEED = "ix_integration_seed";
const [PREPARE, SEND] = DIGEST_CRON_SPECS;

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
${rejectBlock}printf '%s\\n' "$(printf '%s\\x1f' "$@")" >> "${join(dir, "calls.log")}"
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
  const prompts = join(home, "skills/edge-esmeralda/prompts");
  mkdirSync(prompts, { recursive: true });
  writeFileSync(join(prompts, PREPARE.promptFile), "PREPARE_BODY");
  writeFileSync(join(prompts, SEND.promptFile), "SEND_BODY");
}

function writeJobs(jobs: unknown[]): void {
  mkdirSync(join(home, "cron"), { recursive: true });
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "edge-reconcile-"));
  stubLog = join(home, "calls.log");
  savedEnv = {
    HERMES_HOME: process.env.HERMES_HOME,
    HERMES_BIN: process.env.HERMES_BIN,
    INDEX_API_KEY: process.env.INDEX_API_KEY,
    DIGEST_PREPARE_CRON: process.env.DIGEST_PREPARE_CRON,
    DIGEST_SEND_CRON: process.env.DIGEST_SEND_CRON,
  };
  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = writeStubHermes(home);
  process.env.INDEX_API_KEY = SEED;
  delete process.env.DIGEST_PREPARE_CRON;
  delete process.env.DIGEST_SEND_CRON;
  writePrompts();
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true });
});

test("fresh install creates both crons on their staggered schedules", () => {
  reconcileDigestCronJobs({ ...process.env });

  const creates = cronCalls().filter((argv) => argv[1] === "create");
  expect(creates).toHaveLength(2);

  const prepare = creates.find((argv) => argv.includes(PREPARE.name))!;
  const send = creates.find((argv) => argv.includes(SEND.name))!;
  expect(prepare[2]).toBe(staggeredSchedule(PREPARE, SEED));
  expect(prepare[3]).toBe("PREPARE_BODY");
  expect(send[2]).toBe(staggeredSchedule(SEND, SEED));
  expect(send[3]).toBe("SEND_BODY");
  expect(send).toContain("--deliver");
  expect(prepare).not.toContain("--deliver");
});

test("job still on the old synchronized default gets a schedule-only migration", () => {
  writeJobs([
    { id: "p1", name: PREPARE.name, prompt: "PREPARE_BODY", schedule: { expr: PREPARE.schedule } },
    { id: "s1", name: SEND.name, prompt: "SEND_BODY", schedule: { expr: SEND.schedule } },
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const calls = cronCalls();
  expect(calls).toEqual([
    ["cron", "edit", "p1", "--schedule", staggeredSchedule(PREPARE, SEED)],
    ["cron", "edit", "s1", "--schedule", staggeredSchedule(SEND, SEED)],
  ]);
});

test("custom schedule is preserved; stale prompt gets a prompt-only edit", () => {
  writeJobs([
    { id: "p1", name: PREPARE.name, prompt: "OLD_BODY", schedule: { expr: "30 4 * * *" } },
    { id: "s1", name: SEND.name, prompt: "SEND_BODY", schedule: { expr: "15 9 * * *" } },
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([
    ["cron", "edit", "p1", "--prompt", "PREPARE_BODY"],
  ]);
});

test("stale prompt + old default schedule produce two independent edit calls", () => {
  writeJobs([
    { id: "s1", name: SEND.name, prompt: "OLD_BODY", schedule: { expr: SEND.schedule } },
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
    {
      id: "p1",
      name: PREPARE.name,
      prompt: "PREPARE_BODY",
      schedule: { expr: staggeredSchedule(PREPARE, SEED) },
    },
    {
      id: "s1",
      name: SEND.name,
      prompt: "SEND_BODY",
      schedule: { expr: staggeredSchedule(SEND, SEED) },
    },
  ]);

  reconcileDigestCronJobs({ ...process.env });

  expect(cronCalls()).toEqual([]);
});

test("retired Edge-prefixed crons are removed; foreign crons are untouched", () => {
  writeJobs([
    { id: "old1", name: "Edge — heartbeat", prompt: "X", schedule: { expr: "0 6 * * *" } },
    { id: "user1", name: "my own job", prompt: "Y", schedule: { expr: "0 7 * * *" } },
  ]);

  reconcileDigestCronJobs({ ...process.env });

  const removes = cronCalls().filter((argv) => argv[1] === "remove");
  expect(removes).toEqual([["cron", "remove", "old1"]]);
});

test("a Hermes that rejects --schedule still gets the prompt update (degraded migration)", () => {
  process.env.HERMES_BIN = writeStubHermes(home, { rejectScheduleFlag: true });
  writeJobs([
    {
      id: "p1",
      name: PREPARE.name,
      prompt: "PREPARE_BODY",
      schedule: { expr: staggeredSchedule(PREPARE, SEED) },
    },
    { id: "s1", name: SEND.name, prompt: "OLD_BODY", schedule: { expr: SEND.schedule } },
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
