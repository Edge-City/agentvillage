/**
 * K1: the "Edge — knowledge sync" cron job as a roll leaves it, end to end
 * against the stand-in Hermes that keeps jobs.json (fake_hermes.ts): created
 * no_agent with no delivery target, failures local, every 15 minutes on the
 * tenant's offset; a roll onto an rc14 tenant adds only this job; a resident's
 * pause survives every later roll, including one that edits the job's shape.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { DIGEST_CRON_SPECS, KNOWLEDGE_SYNC_JOB, KNOWLEDGE_SYNC_PROMPT, installedJobsPath, reconcileDigestCronJobs, staggeredSchedule } from "../install_index";
import { EDGE_SKILL_NAMES } from "../paths";

const REPO_SKILLS = join(import.meta.dir, "..", "..", "skills");
const FAKE = join(import.meta.dir, "fake_hermes.ts");
const SEED = "ix_knowledge_sync_seed";
const KNOWLEDGE = DIGEST_CRON_SPECS.find((spec) => spec.name === KNOWLEDGE_SYNC_JOB)!;
const ENV_KEYS = ["HERMES_HOME", "HERMES_BIN", "INDEX_API_KEY", "TOKEN_USAGE_AUDIT_CRON", "KNOWLEDGE_SYNC_CRON", "FAKE_HERMES_FAIL", "HERMES_TIMEZONE",
  "DIGEST_SIGNALS_CRON", "DIGEST_PREPARE_CRON", "DIGEST_SEND_CRON"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let home: string;
let bin: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-knowledge-job-"));
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

function job(name: string): Job | undefined {
  return jobs().find((entry) => entry.name === name);
}

function editJobs(change: (all: Job[]) => void): void {
  const all = jobs();
  change(all);
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: all }));
}

function cronCalls(): string[][] {
  const path = join(home, "hermes-calls.jsonl");
  const all: string[][] = existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  return all.filter((argv) => argv[0] === "cron");
}

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

test("the edge-india skill is installed with every other bundle (its sync script and shim travel with it)", () => {
  expect(EDGE_SKILL_NAMES).toContain("edge-india");
  for (const file of ["SKILL.md", "scripts/knowledge-sync.ts", "scripts/shims/agentvillage_knowledge_sync.sh"]) {
    expect(existsSync(join(REPO_SKILLS, "edge-india", file))).toBe(true);
  }
});

test("a fresh roll creates the knowledge sync: no_agent, no delivery, failures local, every 15 minutes on the tenant's offset", () => {
  expect(roll()).toEqual([]);
  const stored = job(KNOWLEDGE_SYNC_JOB)!;
  expect(stored).toBeDefined();
  expect(stored.no_agent).toBe(true);
  expect(stored.deliver ?? null).toBeNull();
  expect(stored.failure_deliver).toBe("local");
  expect(stored.script).toBe("agentvillage_knowledge_sync.sh");
  expect(stored.prompt).toBe(KNOWLEDGE_SYNC_PROMPT);
  const expr = staggeredSchedule(KNOWLEDGE, SEED);
  expect(stored.schedule.expr).toBe(expr);
  const minutes = expr.split(" ")[0].split(",").map(Number);
  expect(minutes.map((m) => m - minutes[0])).toEqual([0, 15, 30, 45]);
  // The shim is copied where Hermes runs scripts from, executable, and the job id is ours (DATA-92).
  const shim = join(home, "scripts", "agentvillage_knowledge_sync.sh");
  expect(readFileSync(shim, "utf8")).toContain("skills/edge-india/scripts/knowledge-sync.ts");
  expect(statSync(shim).mode & 0o111).not.toBe(0);
  expect(JSON.parse(readFileSync(installedJobsPath(home), "utf8")).ids).toContain(stored.id);
  // Created after every agent job and before the prefetch (reconcileOrder).
  const created = cronCalls().filter((argv) => argv[1] === "create").map((argv) => argv[argv.indexOf("--name") + 1]);
  expect(created.slice(-2)).toEqual([KNOWLEDGE_SYNC_JOB, "Edge — digest prepare"]);
});

test("a roll onto an rc14 tenant (every other job current, no knowledge sync) creates only the knowledge sync", () => {
  roll();
  editJobs((all) => all.splice(all.findIndex((entry) => entry.name === KNOWLEDGE_SYNC_JOB), 1));
  const before = cronCalls().length;
  expect(roll()).toEqual([]);
  const after = cronCalls().slice(before);
  expect(after.map((argv) => argv[1])).toEqual(["create"]);
  expect(after[0]).toContain(KNOWLEDGE_SYNC_JOB);
  expect(after[0]).toContain("--no-agent");
});

test("a paused knowledge sync stays paused through a roll that changes nothing and one that edits its shape", () => {
  roll();
  const id = job(KNOWLEDGE_SYNC_JOB)!.id;
  execFileSync(bin, ["cron", "pause", id], { stdio: "ignore", env: process.env });
  expect(job(KNOWLEDGE_SYNC_JOB)).toMatchObject({ enabled: false, state: "paused" });
  const expr = job(KNOWLEDGE_SYNC_JOB)!.schedule.expr;

  let before = cronCalls().length;
  roll();
  expect(cronCalls().slice(before)).toEqual([]);
  expect(job(KNOWLEDGE_SYNC_JOB)).toMatchObject({ id, enabled: false, state: "paused" });

  // An older shape (agent mode, no script, an old prompt): one in-place edit, still paused, same schedule.
  editJobs((all) => {
    const entry = all.find((e) => e.name === KNOWLEDGE_SYNC_JOB)!;
    entry.no_agent = false;
    entry.prompt = "OLD";
    entry.script = null;
  });
  before = cronCalls().length;
  roll();
  const edits = cronCalls().slice(before);
  expect(edits).toHaveLength(1);
  expect(edits[0].slice(0, 3)).toEqual(["cron", "edit", id]);
  expect(edits[0]).toContain("--no-agent");
  expect(edits[0]).not.toContain("pause");
  expect(edits[0]).not.toContain("resume");
  const stored = job(KNOWLEDGE_SYNC_JOB)!;
  expect(stored).toMatchObject({ id, enabled: false, state: "paused", no_agent: true, script: "agentvillage_knowledge_sync.sh", prompt: KNOWLEDGE_SYNC_PROMPT });
  expect(stored.schedule.expr).toBe(expr);
});

test("a schedule a resident or admin set is kept by a roll", () => {
  roll();
  const id = job(KNOWLEDGE_SYNC_JOB)!.id;
  execFileSync(bin, ["cron", "edit", id, "--schedule", "0 * * * *"], { stdio: "ignore", env: process.env });
  const before = cronCalls().length;
  roll();
  expect(cronCalls().slice(before)).toEqual([]);
  expect(job(KNOWLEDGE_SYNC_JOB)!.schedule.expr).toBe("0 * * * *");
});

test("a failed create of the knowledge sync is named in the roll's failures (cron_failed)", () => {
  process.env.FAKE_HERMES_FAIL = "create";
  const failed = roll();
  expect(failed).toContain(KNOWLEDGE_SYNC_JOB);
});
