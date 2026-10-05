/**
 * A stand-in `hermes` for the J2 job command and reconcile tests: it keeps
 * `$HERMES_HOME/cron/jobs.json` the way Hermes does for the commands the
 * overlay runs (cron create/edit/pause/resume/remove, kanban init,
 * --version), so a test can run add, then a roll, then another roll, and read
 * what a real tenant would hold. Every call is appended to
 * `$HERMES_HOME/hermes-calls.jsonl` as its argv. Not a test file itself.
 *
 * Mirrors Hermes v2026.9.24 where it matters here: `cron edit` keeps the id
 * and the pause state; a script must exist under `$HERMES_HOME/scripts/`;
 * `pause` clears `enabled` and sets `state: paused` and `paused_at`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const home = process.env.HERMES_HOME!;
const argv = process.argv.slice(2);
appendFileSync(join(home, "hermes-calls.jsonl"), `${JSON.stringify(argv)}\n`);

type Job = Record<string, unknown> & { id: string; name: string };
const jobsPath = join(home, "cron", "jobs.json");

function load(): Job[] {
  return existsSync(jobsPath) ? (JSON.parse(readFileSync(jobsPath, "utf8")).jobs as Job[]) : [];
}

function save(jobs: Job[]): void {
  mkdirSync(join(home, "cron"), { recursive: true });
  writeFileSync(jobsPath, JSON.stringify({ jobs }, null, 2));
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function checkScript(script: string | undefined): void {
  if (script !== undefined && script !== "" && !existsSync(join(home, "scripts", script))) fail(`Script not found: ${script}`);
}

if (argv[0] === "--version") process.exit(0);
if (argv[0] === "kanban") process.exit(0);
if (argv[0] !== "cron") fail("unknown command");

const [, sub, ...rest] = argv;
const jobs = load();
if (process.env.FAKE_HERMES_FAIL && process.env.FAKE_HERMES_FAIL === sub) fail(`forced failure of ${sub}`);

if (sub === "create") {
  const [schedule, prompt, ...flags] = rest;
  const script = flag(flags, "--script");
  checkScript(script);
  const job: Job = {
    id: `job${String(jobs.length + 1).padStart(3, "0")}${Math.random().toString(16).slice(2, 8)}`,
    name: flag(flags, "--name") ?? "unnamed",
    prompt: (prompt ?? "").trim(),
    schedule: { expr: schedule },
    enabled: true,
    state: "scheduled",
    ...(flag(flags, "--deliver") ? { deliver: flag(flags, "--deliver") } : {}),
    ...(flag(flags, "--failure-deliver") ? { failure_deliver: flag(flags, "--failure-deliver") } : {}),
    ...(script ? { script } : {}),
    ...(flags.includes("--no-agent") ? { no_agent: true } : {}),
    ...(flag(flags, "--workdir") ? { workdir: flag(flags, "--workdir") } : {}),
  };
  jobs.push(job);
  save(jobs);
  process.stdout.write(`Created job: ${job.id}\n`);
  process.exit(0);
}

const [id, ...flags] = rest;
const job = jobs.find((entry) => entry.id === id);
if (!job) fail(`Job not found: ${id}`);

if (sub === "edit") {
  if (flags.includes("--schedule")) job.schedule = { expr: flag(flags, "--schedule") };
  if (flags.includes("--prompt")) job.prompt = flag(flags, "--prompt");
  if (flags.includes("--script")) {
    checkScript(flag(flags, "--script"));
    job.script = flag(flags, "--script");
  }
  if (flags.includes("--no-agent")) job.no_agent = true;
  if (flags.includes("--agent")) job.no_agent = false;
  if (flags.includes("--failure-deliver")) job.failure_deliver = flag(flags, "--failure-deliver");
} else if (sub === "pause") {
  Object.assign(job, { enabled: false, state: "paused", paused_at: "2026-10-12T00:00:00+05:30" });
} else if (sub === "resume") {
  Object.assign(job, { enabled: true, state: "scheduled", paused_at: null });
} else if (sub === "remove") {
  jobs.splice(jobs.indexOf(job), 1);
} else {
  fail(`unknown cron command ${sub}`);
}
save(jobs);
process.exit(0);
