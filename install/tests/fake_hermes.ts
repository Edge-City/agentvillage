/**
 * A stand-in `hermes` for the J2 job command and reconcile tests: it keeps
 * `$HERMES_HOME/cron/jobs.json` the way Hermes does for the commands the
 * overlay runs (cron create/edit/pause/resume/remove, kanban init,
 * --version), so a test can run add, then a roll, then another roll, and read
 * what a real tenant would hold. Every call is appended to
 * `$HERMES_HOME/hermes-calls.jsonl` as its argv (and the HERMES_TIMEZONE it was
 * started with to `hermes-env.jsonl`). Not a test file itself.
 *
 * Mirrors Hermes v2026.9.24 where it matters here (file:line in cron/jobs.py
 * unless named):
 * - a new job's id is `uuid4().hex[:12]` (:1781), and it records `created_at`;
 * - a cron schedule is stored as `{kind, expr, display}` with the expression
 *   as given (:765); one croniter cannot find a next run for (a day of month
 *   none of the listed months has, `0 8 31 2 *`) is refused on create and
 *   edit, exit 1 (croniter get_next in compute_next_run, :1204; the tool
 *   layer turns the raise into a failure, tools/cronjob_tools.py:945);
 * - `in <n>m` is a one-shot due n minutes from now (:824-834);
 * - `next_run_at` is computed from now in Asia/Kolkata on create, and on a
 *   schedule edit unless the job is paused (:1994-2004); `cron edit` keeps
 *   the id and the pause state;
 * - `pause` clears `enabled`, sets `state: paused` and `paused_at`, and keeps
 *   `next_run_at`; `resume` keeps a `next_run_at` already due (so the next
 *   tick fires it, :2080-2105) and recomputes a future one;
 * - a script must exist under `$HERMES_HOME/scripts/`;
 * - `cron create --paused [--paused-reason <text>]` stores the job disabled
 *   in the one write: `enabled: false`, `state: paused`, `paused_at`, the
 *   reason (Hermes's default when none), `next_run_at: null` (:1827-1832).
 * Test switches: FAKE_HERMES_FAIL=<sub> exits 1 before acting;
 * FAKE_HERMES_NOOP=<sub> exits 0 without acting (a CLI that says done and
 * saved nothing); FAKE_HERMES_PAUSED=refuse exits 2 on `--paused` as a Hermes
 * before v2026.9.11 does (argparse: unrecognized arguments), and
 * FAKE_HERMES_PAUSED=ignore creates the job running despite it;
 * FAKE_HERMES_HANG=<sub> hangs before acting, and FAKE_HERMES_HANG_AFTER=<sub>
 * hangs after saving (each writes its pid to `$HERMES_HOME/hermes-hang.pid`),
 * as a hung CLI would, until it is killed.
 * What it does not do: fire anything (there is no ticker), or apply the
 * late / catch-up policy. Tests read `next_run_at` to see what a tick would do.
 *
 * `plugins` (the Index Hermes plugin step, install_index_plugin.ts), after
 * hermes_cli/plugins_cmd.py and subcommands/plugins.py at v2026.9.24:
 * - `plugins install <owner/repo> [--force] [--ref <40-hex>] [--enable|--no-enable]`
 *   refuses a `--ref` that is not 40 hex, an existing directory without
 *   `--force`, and an existing pinned plugin without `--ref` (exit 1); else it
 *   writes `plugins/<name>/plugin.yaml` (the name is the repo's, `index-network`
 *   for indexnetwork/hermes-plugin) and the plugin's record in
 *   `plugins/.install-metadata.json`, `{pinned, revision, source}` (sorted
 *   keys, indent 2), the revision being the `--ref` or a fixed fake HEAD;
 *   `--enable` lists it in `plugins.enabled` and drops it from
 *   `plugins.disabled`, as `_set_plugin_enabled` does;
 * - `plugins update <name>` refuses a pinned plugin (exit 1) and otherwise
 *   records the fake HEAD; `plugins enable <name>` does what `--enable` does;
 *   `plugins remove <name>` deletes the directory and its record and drops the
 *   name from both lists;
 * - FAKE_HERMES_FAIL=<plugins sub> exits 1 before acting.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

import { cronNeverFires, nextFiring, parseStoredCron, parseStrictCron } from "../../skills/index-network/scripts/job-settings";

const home = process.env.HERMES_HOME!;
const argv = process.argv.slice(2);
appendFileSync(join(home, "hermes-calls.jsonl"), `${JSON.stringify(argv)}\n`);
// The zone Hermes's CLI would read from its environment (install/jobs.ts must not pass the caller's on).
appendFileSync(join(home, "hermes-env.jsonl"), `${JSON.stringify({ HERMES_TIMEZONE: process.env.HERMES_TIMEZONE ?? null })}\n`);

const ZONE = "Asia/Kolkata";

type Job = Record<string, unknown> & { id: string; name: string };
const jobsPath = join(home, "cron", "jobs.json");

function load(): Job[] {
  return existsSync(jobsPath) ? (JSON.parse(readFileSync(jobsPath, "utf8")).jobs as Job[]) : [];
}

function hang(): Promise<never> {
  writeFileSync(join(home, "hermes-hang.pid"), String(process.pid));
  return new Promise<never>(() => setInterval(() => {}, 1_000));
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

/** A schedule as Hermes stores it, with its next run from now; exits 1 where Hermes refuses. */
function parseSchedule(text: string): { schedule: Record<string, unknown>; next: string | null } {
  const once = /^in (\d+)m$/.exec(text);
  if (once) {
    const runAt = new Date(Date.now() + Number(once[1]) * 60_000).toISOString();
    return { schedule: { kind: "once", run_at: runAt, display: `once ${text}` }, next: runAt };
  }
  // A canonical form longer than an input may be (job-settings.ts MAX_CANONICAL_SCHEDULE_CHARS) is read too.
  const cron = parseStrictCron(text) ?? parseStoredCron(text);
  if (cron && cronNeverFires(cron)) fail(`Invalid cron expression '${text}': CroniterBadDateError: failed to find next date`);
  const next = cron ? nextFiring(cron, ZONE, new Date()) : null;
  return { schedule: { kind: "cron", expr: text, display: text }, next: next === null ? null : new Date(next).toISOString() };
}

if (argv[0] === "--version") process.exit(0);
if (argv[0] === "kanban") process.exit(0);
if (argv[0] === "plugins") plugins(argv.slice(1));
if (argv[0] !== "cron") fail("unknown command");

const [, sub, ...rest] = argv;
const jobs = load();
if (process.env.FAKE_HERMES_FAIL && process.env.FAKE_HERMES_FAIL === sub) fail(`forced failure of ${sub}`);
if (process.env.FAKE_HERMES_HANG && process.env.FAKE_HERMES_HANG === sub) await hang();
const hangAfter = process.env.FAKE_HERMES_HANG_AFTER === sub;
if (process.env.FAKE_HERMES_NOOP && process.env.FAKE_HERMES_NOOP === sub) process.exit(0);

if (sub === "create") {
  const [scheduleText, prompt, ...flags] = rest;
  const script = flag(flags, "--script");
  if (flags.includes("--paused") && process.env.FAKE_HERMES_PAUSED === "refuse") {
    process.stderr.write("hermes: error: unrecognized arguments: --paused\n");
    process.exit(2);
  }
  if (flags.includes("--paused-reason") && !flags.includes("--paused")) fail("paused_reason requires paused=True.");
  const paused = flags.includes("--paused") && process.env.FAKE_HERMES_PAUSED !== "ignore";
  checkScript(script);
  const { schedule, next } = parseSchedule(scheduleText ?? "");
  const job: Job = {
    id: randomBytes(6).toString("hex"),
    name: flag(flags, "--name") ?? "unnamed",
    prompt: (prompt ?? "").trim(),
    schedule,
    enabled: !paused,
    state: paused ? "paused" : "scheduled",
    created_at: new Date().toISOString(),
    next_run_at: paused ? null : next,
    ...(paused ? { paused_at: new Date().toISOString(), paused_reason: flag(flags, "--paused-reason") ?? "Created paused; awaiting operator approval." } : {}),
    ...(flag(flags, "--deliver") ? { deliver: flag(flags, "--deliver") } : {}),
    ...(flag(flags, "--failure-deliver") ? { failure_deliver: flag(flags, "--failure-deliver") } : {}),
    ...(script ? { script } : {}),
    ...(flags.includes("--no-agent") ? { no_agent: true } : {}),
    ...(flag(flags, "--workdir") ? { workdir: flag(flags, "--workdir") } : {}),
  };
  jobs.push(job);
  save(jobs);
  if (hangAfter) await hang();
  process.stdout.write(`Created job: ${job.id}\n`);
  process.exit(0);
}

const [id, ...flags] = rest;
const job = jobs.find((entry) => entry.id === id);
if (!job) fail(`Job not found: ${id}`);

if (sub === "edit") {
  if (flags.includes("--schedule")) {
    const { schedule, next } = parseSchedule(flag(flags, "--schedule") ?? "");
    job.schedule = schedule;
    if (job.state !== "paused") Object.assign(job, { next_run_at: next, state: "scheduled", enabled: true });
  }
  if (flags.includes("--prompt")) job.prompt = flag(flags, "--prompt");
  if (flags.includes("--script")) {
    checkScript(flag(flags, "--script"));
    job.script = flag(flags, "--script");
  }
  if (flags.includes("--no-agent")) job.no_agent = true;
  if (flags.includes("--agent")) job.no_agent = false;
  if (flags.includes("--failure-deliver")) job.failure_deliver = flag(flags, "--failure-deliver");
} else if (sub === "pause") {
  Object.assign(job, { enabled: false, state: "paused", paused_at: new Date().toISOString() });
} else if (sub === "resume") {
  const stored = typeof job.next_run_at === "string" ? Date.parse(job.next_run_at) : NaN;
  const due = Number.isFinite(stored) && stored <= Date.now();
  const expr = (job.schedule as { expr?: string } | undefined)?.expr ?? "";
  Object.assign(job, { enabled: true, state: "scheduled", paused_at: null, paused_reason: null, next_run_at: due ? job.next_run_at : parseSchedule(expr).next });
} else if (sub === "remove") {
  jobs.splice(jobs.indexOf(job), 1);
} else {
  fail(`unknown cron command ${sub}`);
}
save(jobs);
if (hangAfter) await hang();
process.exit(0);

/** The `plugins` subcommands the Index plugin step could run (see the header); always exits. */
function plugins(args: string[]): never {
  const [sub, ...rest] = args;
  if (process.env.FAKE_HERMES_FAIL && process.env.FAKE_HERMES_FAIL === sub) fail(`forced failure of plugins ${sub}`);
  const dir = join(home, "plugins");
  const metaPath = join(dir, ".install-metadata.json");
  const FAKE_HEAD = "0".repeat(40);
  const meta = (): Record<string, Record<string, unknown>> => (existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : {});
  const saveMeta = (value: Record<string, Record<string, unknown>>) => {
    mkdirSync(dir, { recursive: true });
    const sorted = Object.fromEntries(Object.keys(value).sort().map((k) => [k, Object.fromEntries(Object.entries(value[k]!).sort(([a], [b]) => a.localeCompare(b)))]));
    writeFileSync(metaPath, `${JSON.stringify(sorted, null, 2)}\n`);
  };
  const setEnabled = (name: string, on: boolean, both = false) => {
    const configPath = join(home, "config.yaml");
    const doc = (existsSync(configPath) ? YAML.parse(readFileSync(configPath, "utf8")) : null) ?? {};
    const section = (doc.plugins ??= {});
    const list = (key: string) => (Array.isArray(section[key]) ? section[key] : []) as string[];
    section.enabled = on ? [...list("enabled").filter((n) => n !== name), name] : list("enabled").filter((n) => n !== name);
    section.disabled = list("disabled").filter((n) => n !== name);
    if (!on && !both) section.disabled.push(name);
    writeFileSync(configPath, YAML.stringify(doc));
  };
  if (sub === "install") {
    const [identifier, ...flags] = rest;
    const parts = (identifier ?? "").split("/").filter(Boolean);
    if (parts.length < 2) fail(`Invalid plugin identifier: '${identifier}'`);
    const ref = flag(flags, "--ref");
    if (flags.includes("--ref") && !/^[0-9a-fA-F]{40}$/.test(ref ?? "")) fail("--ref must be a full 40-character commit SHA.");
    if (flags.includes("--enable") && flags.includes("--no-enable")) {
      process.stderr.write("hermes: error: argument --no-enable: not allowed with argument --enable\n");
      process.exit(2);
    }
    const name = parts[0] === "indexnetwork" && parts[1] === "hermes-plugin" ? "index-network" : parts[1]!;
    const target = join(dir, name);
    const prior = meta()[name];
    if (existsSync(target) && !flags.includes("--force")) fail(`Plugin '${name}' already exists. Use force reinstall or run \`hermes plugins update ${name}\`.`);
    if (existsSync(target) && ref === undefined && prior?.pinned === true) fail(`Plugin '${name}' is pinned. Reinstall it with an explicit --ref <40-character commit SHA> to change its source or revision.`);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "plugin.yaml"), `name: ${name}\nversion: 0.0.0-fake\n`);
    saveMeta({ ...meta(), [name]: { pinned: ref !== undefined, revision: (ref ?? FAKE_HEAD).toLowerCase(), source: `https://github.com/${parts[0]}/${parts[1]}.git` } });
    if (flags.includes("--enable")) setEnabled(name, true);
    process.exit(0);
  }
  const [name] = rest;
  if (!name) fail(`plugins ${sub}: a name is required`);
  if (sub === "update") {
    const record = meta()[name];
    if (!existsSync(join(dir, name))) fail(`Plugin '${name}' is not installed.`);
    if (record?.pinned === true) fail(`Plugin '${name}' is pinned at ${String(record.revision).slice(0, 8)}; reinstall with --ref to move it.`);
    if (record) saveMeta({ ...meta(), [name]: { ...record, revision: FAKE_HEAD } });
    process.exit(0);
  }
  if (sub === "enable") {
    setEnabled(name, true);
    process.exit(0);
  }
  if (sub === "remove") {
    rmSync(join(dir, name), { recursive: true, force: true });
    const all = meta();
    delete all[name];
    saveMeta(all);
    setEnabled(name, false, true);
    process.exit(0);
  }
  fail(`unknown plugins command ${sub}`);
}
