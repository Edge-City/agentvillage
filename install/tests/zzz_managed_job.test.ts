import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { REVIEWED_MINI_APPS, zzzMarkerOnDisk, zzzMarkerScan } from "../install_miniapps";
import { reconcileZzzManagedJob, ZZZ_JOB_NAME, ZZZ_JOB_SCRIPT, ZZZ_JOB_TOOLSETS, ZZZ_SHIPPED_SHA256, zzzShippedFile } from "../zzz_managed_job";
import { withSymlinkPlantedAfterCheck } from "./plant_after_check";

const fake = join(import.meta.dir, "fake_hermes.ts");
const fakeJobPython = join(import.meta.dir, "fake_hermes_job_python.ts");
const saved = { HERMES_HOME: process.env.HERMES_HOME, HERMES_BIN: process.env.HERMES_BIN,
  PYTHONPATH: process.env.PYTHONPATH, PYTHONHOME: process.env.PYTHONHOME };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A box with a fake bound Hermes; `stage` runs the real CLI helper as the cp's runHelper does (stdin). */
function fakeBox() {
  const home = mkdtempSync(join(tmpdir(), "av-zzz-job-"));
  roots.push(home);
  const bin = join(home, "bin", "hermes");
  const python = join(home, "venv", "bin", "python");
  const entrypoint = join(home, "hermes_cli", "main.py");
  mkdirSync(join(home, "bin"));
  mkdirSync(join(home, "venv", "bin"), { recursive: true });
  mkdirSync(join(home, "hermes_cli"));
  writeFileSync(entrypoint, "# fake bound Hermes entrypoint\n");
  writeFileSync(bin, `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${python}" "${entrypoint}" "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(join(home, "bin", "python"), "#!/usr/bin/env bash\nexit 99\n");
  chmodSync(join(home, "bin", "python"), 0o755);
  writeFileSync(python, `#!/usr/bin/env bash\nif [ "$1" = "-c" ]; then\n  shift 2\n  exec "${process.execPath}" "${fakeJobPython}" "$@"\nfi\nshift\nexec "${process.execPath}" "${fake}" "$@"\n`);
  chmodSync(python, 0o755);
  process.env.HERMES_HOME = home;
  process.env.HERMES_BIN = bin;
  process.env.PYTHONPATH = join(home, "untrusted-imports");
  process.env.PYTHONHOME = join(home, "untrusted-home");
  const stage = (value: unknown, args: string[] = [], env: Record<string, string> = {}) => spawnSync(process.execPath,
    ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args],
    { cwd: join(import.meta.dir, "../.."), input: typeof value === "string" ? value : JSON.stringify(value),
      env: { ...process.env, ...env, HERMES_HOME: home }, encoding: "utf8" });
  const jobs = () => existsSync(join(home, "cron", "jobs.json")) ? JSON.parse(readFileSync(join(home, "cron", "jobs.json"), "utf8")).jobs : [];
  return { home, stage, jobs };
}
const zzzbot = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
/** The bytes this installer ships for its managed files (the runner is copied verbatim into scripts/). */
const SHIPPED_SHIM = readFileSync(join(import.meta.dir, "../../skills/zzzbot/scripts", ZZZ_JOB_SCRIPT));
const SHIPPED_PROMPT = readFileSync(join(import.meta.dir, "../../skills/zzzbot/prompts/participate.md"));
const SHIPPED_RUNNER = readFileSync(join(import.meta.dir, "../../skills/zzzbot/scripts/zzz_managed_runner.py"));
const SHIPPED_LEGACY_SHIM = readFileSync(join(import.meta.dir, "../../skills/zzzbot/scripts/agentvillage_zzz_pairs.sh"));
const bridge = REVIEWED_MINI_APPS.find(app => app.id === "zzz-bridge")!;
const alone = { version: 1, apps: [zzzbot] };
const projection = { version: 1, apps: [zzzbot, bridge] };
/** Nothing of managed participation on the box: no job, shim, prompt, script or cursor state. */
function expectOff(home: string, jobs: () => unknown[]) {
  expect(jobs()).toHaveLength(0);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "scripts", "zzz_managed_runner.py"))).toBe(false);
  expect(existsSync(join(home, "zzzbot"))).toBe(false);
}

test("installed ZZZ projection owns one script-only Hermes job; revocation removes it", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(alone).status).toBe(0);
  expect(existsSync(join(home, "cron", "jobs.json"))).toBe(false);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  expect(existsSync(join(home, "zzzbot"))).toBe(false);
  expect(stage(projection).status).toBe(0);
  reconcileZzzManagedJob(home, true);
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0]).toMatchObject({ name: ZZZ_JOB_NAME, script: ZZZ_JOB_SCRIPT, enabled: true,
    enabled_toolsets: [...ZZZ_JOB_TOOLSETS] });
  expect(jobs()[0].no_agent).toBe(true);
  expect(jobs()[0].workdir).toBeNull();
  const id = jobs()[0].id;
  reconcileZzzManagedJob(home, true);
  expect(jobs()).toHaveLength(1);
  expect(jobs()[0].id).toBe(id);
  // Installer repairs a stale, overbroad record before another run.
  const widened = jobs();
  widened[0].enabled_toolsets = ["all"];
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: widened }));
  reconcileZzzManagedJob(home, true);
  expect(jobs()[0].enabled_toolsets).toEqual([...ZZZ_JOB_TOOLSETS]);
  expect(jobs()[0].id).not.toBe(id);
  // An old agent job has already entered an unsafe runtime. Rotate its ID,
  // leave no old shell entrypoint, and keep the new record script-only.
  const previous = jobs()[0].id;
  const legacy = jobs();
  legacy[0] = { ...legacy[0], script: "agentvillage_zzz_pairs.sh", no_agent: false, workdir: home };
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: legacy }));
  writeFileSync(join(home, "scripts", "agentvillage_zzz_pairs.sh"), SHIPPED_LEGACY_SHIM);
  reconcileZzzManagedJob(home, true);
  expect(jobs()[0].id).not.toBe(previous);
  expect(jobs()[0]).toMatchObject({ script: ZZZ_JOB_SCRIPT, no_agent: true });
  expect(existsSync(join(home, "scripts", "agentvillage_zzz_pairs.sh"))).toBe(false);
  mkdirSync(join(home, "zzzbot"));
  writeFileSync(join(home, "zzzbot", "managed-pairs.json"), "{}");
  writeFileSync(join(home, "zzzbot", "managed-pairs.lock"), "");
  // The no_agent runner's whole-turn lock is managed state too.
  writeFileSync(join(home, "zzzbot", "managed-run.lock"), "", { mode: 0o600 });
  expect(stage(alone).status).toBe(0);
  expect(jobs()).toHaveLength(0);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "prompts", "participate.md"))).toBe(false);
  expect(existsSync(join(home, "zzzbot"))).toBe(false);
  expect(existsSync(join(home, "skills", "zzzbot", "SKILL.md"))).toBe(true);
});

test("v2.1.20: a symlink swapped in after the shim check is replaced, never followed (temp file + rename)", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  const shim = join(home, "scripts", ZZZ_JOB_SCRIPT);
  const outside = join(home, "outside-target");
  rmSync(shim);
  writeFileSync(outside, "resident outside file");
  // plainFile(shim) sees no shim; the symlink lands between that check and the write.
  expect(withSymlinkPlantedAfterCheck(shim, outside, () => reconcileZzzManagedJob(home, true)).planted).toBe(true);
  expect(readFileSync(outside, "utf8")).toBe("resident outside file");
  const meta = lstatSync(shim);
  expect(meta.isFile() && !meta.isSymbolicLink()).toBe(true);
  expect(meta.mode & 0o777).toBe(0o700);
  expect(readFileSync(shim)).toEqual(SHIPPED_SHIM);
  expect(readdirSync(join(home, "scripts")).filter(name => name.endsWith(".tmp"))).toEqual([]);
  expect(jobs()).toHaveLength(1);
});

test("N7: the whole-turn lock alone marks managed state and revocation removes it", () => {
  const { home, stage, jobs } = fakeBox();
  mkdirSync(join(home, "zzzbot"));
  writeFileSync(join(home, "zzzbot", "managed-run.lock"), "", { mode: 0o600 });
  expect(zzzMarkerOnDisk(home)).toBe(true);
  expect(stage(alone).status).toBe(0);
  expectOff(home, jobs);
});

test("S1 (b): zzzbot without zzz-bridge, and zzz-bridge without zzzbot, schedule nothing; no flag or env turns it on", () => {
  const { home, stage, jobs } = fakeBox();
  // (d) The app's and pair flags, and any would-be overlay switch, are not read by the installer.
  const flags = { ZZZ_BRIDGE: "1", AV_PAIR_ENABLED: "1", ZZZ_MANAGED_PARTICIPATION: "true", ZZZ_BRIDGE_ENABLED: "1" };
  expect(stage(alone, [], flags).status).toBe(0);
  expectOff(home, jobs);
  expect(stage({ version: 1, apps: [bridge] }, [], flags).status).toBe(0);
  expectOff(home, jobs);
  // zzzbot's skill is unstaged; the installer never removes a directory (a resident's files may sit in it).
  expect(readdirSync(join(home, "skills", "zzzbot"))).toEqual([]);
  // (a) The pair turns it on.
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(true);
});

test("S1 (c): an unreadable or malformed projection is OFF: the CLI tears the job, shim, files and state down", () => {
  const { home, stage, jobs } = fakeBox();
  const underscore = { version: 1, apps: [zzzbot, { ...bridge, id: "zzz_bridge" }] };
  const malformed: unknown[] = [
    "not json", "", "{\"version\":1,\"apps\":[", { version: 2, apps: [zzzbot, bridge] }, { version: 1, apps: [zzzbot, bridge], extra: 1 },
    underscore, { version: 1, apps: [zzzbot, bridge, { ...bridge, id: "zzz_bridge" }] },
    { version: 1, apps: [zzzbot, { ...bridge, operations: ["zzz.pairs"] }] }, { version: 1, apps: [zzzbot, { ...bridge, skills: ["zzz-bridge"] }] },
    { version: 1, apps: [zzzbot, bridge, bridge] }, "x".repeat(16385),
  ];
  for (const value of malformed) {
    expect(stage(projection).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    mkdirSync(join(home, "zzzbot"), { recursive: true });
    writeFileSync(join(home, "zzzbot", "managed-pairs.json"), "{}");
    // --verify never mutates, even on a malformed input.
    expect(stage(value, ["--verify"]).status).toBe(1);
    expect(jobs()).toHaveLength(1);
    const result = stage(value);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mini_apps_reconcile_failed");
    expectOff(home, jobs);
  }
});

/** Every file under `root` with its bytes and mode (directories by mode), for "nothing else changed" proofs. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = statSync(path);
      if (st.isDirectory()) { out[relative(root, path) + "/"] = String(st.mode); walk(path); }
      else out[relative(root, path)] = `${st.mode}:${readFileSync(path, "base64")}`;
    }
  };
  walk(root);
  return out;
}
const FAILED = `${JSON.stringify({ error: "mini_apps_reconcile_failed" })}\n`;
/** Exactly the paths a fail-closed teardown may remove: the job's shim, managed files, and cursor state. */
const ZZZ_OWNED = [`scripts/${ZZZ_JOB_SCRIPT}`, `skills/zzzbot/scripts/${ZZZ_JOB_SCRIPT}`, "skills/zzzbot/prompts/participate.md",
  "zzzbot/managed-pairs.json", "zzzbot/managed-pairs.lock", "zzzbot/managed-run.lock", "zzzbot/.managed-123"];
/** Managed cursor state as the poll leaves it, beside a resident's own file in the same folder. */
function seedState(home: string) {
  mkdirSync(join(home, "zzzbot"), { recursive: true });
  writeFileSync(join(home, "zzzbot", "managed-pairs.json"), "{}");
  writeFileSync(join(home, "zzzbot", "managed-pairs.lock"), "");
  writeFileSync(join(home, "zzzbot", "managed-run.lock"), "");
  writeFileSync(join(home, "zzzbot", ".managed-123"), "{}");
}

test("S1 teardown scope (nonav L17033): a failed stage removes ONLY the zzz job, shim, managed files and state", () => {
  const { home, stage, jobs } = fakeBox();
  const legacyReviewed = REVIEWED_MINI_APPS.filter(app=>app.id!=="zzz-autonomy-runner");
  const full = { version: 1, apps: legacyReviewed };
  const unknown = { version: 1, apps: [...legacyReviewed, { id: "unknown_app", version: "1.0.0", operations: ["mini-app.read"], skills: ["unknown_app"] }] };
  for (const failure of [{ input: "not json" as unknown, args: [] as string[] }, { input: unknown, args: [] }, { input: full, args: ["--force"] }]) {
    expect(stage(full).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    seedState(home);
    // Everything else a box holds: other jobs (the near-miss name included), resident files beside every
    // managed path, the other mini-apps' skills and Gold Stars (baseline skill + its projection authority).
    const others = [{ id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true },
      { id: "bbbbbbbbbbbb", name: `${ZZZ_JOB_NAME} (resident copy)`, script: ZZZ_JOB_SCRIPT, enabled: true }];
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [...others, ...jobs()] }));
    for (const [path, bytes] of [["zzzbot/resident.txt", "mine"], ["scripts/resident.sh", "#!/bin/sh\n"],
      ["skills/zzzbot/scripts/resident.sh", "#!/bin/sh\n"], ["skills/zzzbot/prompts/resident.md", "mine"],
      ["skills/zzzbot/notes.md", "mine"], ["memories/MEMORY.md", "resident memory"], ["village-bridge.json", "{}"]]) {
      mkdirSync(join(home, path, ".."), { recursive: true });
      writeFileSync(join(home, path), bytes);
    }
    // The shared av-events registry also contains jobs managed by Index.
    // Revoke must remove only the ZZZ id, keeping those unrelated ids intact.
    const registryPath = join(home, "av-events", "installed_jobs.json");
    const unrelatedId = "cccccccccccc";
    const managedId = jobs().find((job: { name: string }) => job.name === ZZZ_JOB_NAME)!.id;
    writeFileSync(registryPath, `${JSON.stringify({ ids: [unrelatedId, managedId], zzzJobId: managedId })}\n`);
    const before = snapshot(home);
    for (const path of ZZZ_OWNED) expect(before).toHaveProperty([path]);
    for (const app of REVIEWED_MINI_APPS) if (app.skills.length) expect(before).toHaveProperty([`skills/${app.id}/SKILL.md`]);
    const result = stage(failure.input, failure.args);
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(FAILED);
    expect(jobs()).toEqual(others);
    const after = snapshot(home);
    const expected = { ...before };
    // jobs.json is compared above; the fake Hermes's own call logs are the harness's, not the box's.
    const harness = ["cron/jobs.json", "hermes-calls.jsonl", "hermes-env.jsonl"];
    for (const path of [...ZZZ_OWNED, ...harness]) delete expected[path];
    for (const path of harness) delete after[path];
    expect(JSON.parse(readFileSync(registryPath, "utf8"))).toEqual({ ids: [unrelatedId] });
    delete expected["av-events/installed_jobs.json"];
    delete after["av-events/installed_jobs.json"];
    expect(after).toEqual(expected);
    // Gold Stars and every other app keep their authority: the projection file is untouched.
    expect(after["mini-apps.json"]).toBe(before["mini-apps.json"]);
    expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(full);
    rmSync(join(home, "cron", "jobs.json"));
  }
});

test("S1 teardown is idempotent (nonav L17033): a second failed run on a clean box exits cleanly and changes nothing", () => {
  const { home, stage, jobs } = fakeBox();
  // A box that never had participation: a failed stage writes nothing and needs no Hermes.
  const fresh = snapshot(home);
  let result = stage("not json");
  expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
  expect(snapshot(home)).toEqual(fresh);
  // Participation on, then torn down by a failed stage, then failed again (and again with Hermes gone).
  expect(stage(projection).status).toBe(0);
  seedState(home);
  result = stage("not json");
  expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
  expectOff(home, jobs);
  const clean = snapshot(home);
  for (const env of [{}, { HERMES_BIN: join(home, "missing", "hermes") }]) {
    for (const input of ["not json", JSON.stringify({ version: 1, apps: [zzzbot, { ...bridge, id: "zzz_bridge" }] })]) {
      result = stage(input, [], env);
      expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
      expect(snapshot(home)).toEqual(clean);
    }
  }
  expectOff(home, jobs);
});

test("S1 review follow-up: after a failed stage the pair may stay in mini-apps.json, but only a fresh good stage reinstalls", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  seedState(home);
  expect(stage("not json").status).toBe(1);
  expectOff(home, jobs);
  // Teardown never touches the projection file (Gold Stars and the other apps keep their authority).
  expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(projection);
  // Nothing short of a good stage carrying the pair puts the job back: --verify of the pair, failed stages,
  // zzzbot alone, the bridge alone.
  for (const [input, args, status] of [[projection, ["--verify"], 1], ["not json", [], 1], [alone, [], 0],
    [{ version: 1, apps: [bridge] }, [], 0], [{ version: 1, apps: [zzzbot, { ...bridge, id: "zzz_bridge" }] }, [], 1]] as [unknown, string[], number][]) {
    expect(stage(input, args).status).toBe(status);
    expectOff(home, jobs);
  }
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
});

const PLUGIN = join(import.meta.dir, "..", "..", "plugins", "village-bridge");
/** The plugin's participation_on(home), through its package (python3 -I, the probe outside the plugin folder). */
function pluginParticipation(home: string): string {
  const which = Bun.which("python3");
  expect(which).not.toBeNull();
  const python = spawnSync(which!, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const probe = mkdtempSync(join(tmpdir(), "av-zzz-probe-"));
  roots.push(probe);
  writeFileSync(join(probe, "probe.py"), [
    "import importlib.util, sys",
    "from pathlib import Path",
    'spec = importlib.util.spec_from_file_location("village_bridge", Path(sys.argv[1]) / "__init__.py")',
    "package = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = package",
    "spec.loader.exec_module(package)",
    'print(sys.modules["village_bridge._zzz_managed"].participation_on(Path(sys.argv[2])))',
    "",
  ].join("\n"));
  const env: Record<string, string> = { HERMES_HOME: home, PATH: "/usr/bin:/bin" };
  const run = spawnSync(python, ["-I", join(probe, "probe.py"), PLUGIN, home], { cwd: probe, env, encoding: "utf8" });
  expect(run.status).toBe(0);
  return run.stdout.trim();
}

test("S1 (nonav L17033): a malformed mini-apps.json with the job present is OFF, and the next install run removes the job", () => {
  const { home, stage, jobs } = fakeBox();
  const next: { label: string; input: unknown; status: number }[] = [
    { label: "zzzbot alone", input: alone, status: 0 },
    { label: "nothing projected", input: { version: 1, apps: [] }, status: 0 },
    { label: "a failed stage", input: "not json", status: 1 },
  ];
  for (const { label, input, status } of next) {
    expect(stage(projection).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    expect(pluginParticipation(home)).toBe("True");
    for (const bad of ["{\"version\":1,\"apps\":[", JSON.stringify({ version: 1, apps: [zzzbot, bridge], extra: 1 }), ""]) {
      writeFileSync(join(home, "mini-apps.json"), bad);
      expect(jobs()).toHaveLength(1);
      expect(`${label}: ${pluginParticipation(home)}`).toBe(`${label}: False`);
    }
    seedState(home);
    expect(`${label}: ${stage(input).status}`).toBe(`${label}: ${status}`);
    expectOff(home, jobs);
  }
  // The cp re-staging the pair repairs the file and turns participation back on (that is the grant, not a leak).
  writeFileSync(join(home, "mini-apps.json"), "{");
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(pluginParticipation(home)).toBe("True");
});

/** The plugin's installed(home, app, op) for each pair, through its package (python3 -I, outside the plugin folder). */
function pluginInstalled(home: string, pairs: [string, string][]): boolean[] {
  const which = Bun.which("python3");
  expect(which).not.toBeNull();
  const python = spawnSync(which!, ["-I", "-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).stdout.trim();
  const probe = mkdtempSync(join(tmpdir(), "av-zzz-probe-"));
  roots.push(probe);
  writeFileSync(join(probe, "probe.py"), [
    "import importlib.util, json, sys",
    "from pathlib import Path",
    'spec = importlib.util.spec_from_file_location("village_bridge", Path(sys.argv[1]) / "__init__.py")',
    "package = importlib.util.module_from_spec(spec)",
    "sys.modules[spec.name] = package",
    "spec.loader.exec_module(package)",
    'mini = sys.modules["village_bridge._mini_apps"]',
    "print(json.dumps([mini.installed(Path(sys.argv[2]), app, op) for app, op in json.loads(sys.argv[3])]))",
    "",
  ].join("\n"));
  const run = spawnSync(python, ["-I", join(probe, "probe.py"), PLUGIN, home, JSON.stringify(pairs)],
    { cwd: probe, env: { HERMES_HOME: home, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout);
}
const gold = REVIEWED_MINI_APPS.find(app => app.id === "gold-stars")!;
const forkicks = REVIEWED_MINI_APPS.find(app => app.id === "forkicks")!;
/**
 * No Hermes anywhere: HERMES_BIN missing, and HOME (a separate empty folder, so bun's own cache stays out of the box)
 * and PATH isolated so no fixed launcher (~/.local/bin/hermes on a dev machine) resolves.
 */
function HERMES_GONE(home: string) {
  const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-nohome-"));
  roots.push(elsewhere);
  return { HERMES_BIN: join(home, "missing", "hermes"), HOME: elsewhere, PATH: "/usr/bin:/bin" };
}

test("review-b S3: a failed job install keeps Gold Stars and For Kicks authorised and tears down only the zzz-managed items", () => {
  const { home, stage, jobs } = fakeBox();
  const before = { version: 1, apps: [gold, forkicks, zzzbot] };
  const granted = { version: 1, apps: [gold, forkicks, zzzbot, bridge] };
  const others: [string, string][] = [["gold-stars", "rolodex.search"], ["forkicks", "forkicks.menu"]];
  expect(stage(before).status).toBe(0);
  expect(pluginInstalled(home, others)).toEqual([true, true]);
  // The cp grants zzz-bridge on a box whose Hermes is missing: the stage fails on every retry, and every retry leaves
  // the other apps' authority published (the projection is written before the job install, never apps:[]).
  for (let retry = 0; retry < 3; retry++) {
    seedState(home);
    const result = stage(granted, [], HERMES_GONE(home));
    expect([result.status, result.stdout, result.stderr]).toEqual([1, "", FAILED]);
    expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(granted);
    expect(pluginInstalled(home, others)).toEqual([true, true]);
    expect(existsSync(join(home, "skills", "forkicks", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, "skills", "zzzbot", "SKILL.md"))).toBe(true);
    // The zzz-managed job, shim, prompt, script and cursor state are torn down (expectOff), so nothing managed runs.
    expectOff(home, jobs);
    expect(pluginParticipation(home)).toBe("True");
  }
  // Hermes back: the next good stage installs the job.
  expect(stage(granted).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(pluginInstalled(home, others)).toEqual([true, true]);
});

test("review-b N2: with the gate off, a jobs.json or scripts/ shape the installer never wrote never fails the stage", () => {
  type Shape = { label: string; seed: (home: string, elsewhere: string) => void };
  const shapes: Shape[] = [
    { label: "bare-list jobs.json", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "[]"); } },
    { label: "bare-list jobs.json with a resident job", seed: home => { mkdirSync(join(home, "cron"));
      writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify([{ id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true }])); } },
    { label: "unparseable jobs.json", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "{not json"); } },
    { label: "jobs.json of another shape", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "\"jobs\""); } },
    { label: "symlinked scripts/", seed: (home, elsewhere) => {
      writeFileSync(join(elsewhere, ZZZ_JOB_SCRIPT), "#!/bin/sh\necho resident\n");
      writeFileSync(join(elsewhere, "resident.sh"), "#!/bin/sh\n");
      symlinkSync(elsewhere, join(home, "scripts")); } },
  ];
  const projections = [{ version: 1, apps: [] }, { version: 1, apps: [gold] }, alone, { version: 1, apps: [bridge] }];
  for (const { label, seed } of shapes) {
    for (const value of projections) {
      const { home, stage } = fakeBox();
      const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
      roots.push(elsewhere);
      seed(home, elsewhere);
      const name = `${label} / ${value.apps.map(app => app.id).join("+") || "nothing"}`;
      const cron = existsSync(join(home, "cron", "jobs.json")) ? readFileSync(join(home, "cron", "jobs.json"), "utf8") : null;
      const outside = snapshot(elsewhere);
      const empty = value.apps.length === 0 ? snapshot(home) : null;
      // No Hermes is needed (nor called): there is no managed job to remove.
      for (const args of [[], ["--verify"]]) {
        const result = stage(value, args, HERMES_GONE(home));
        expect(`${name} ${args}: ${result.status} ${result.stderr}`).toBe(`${name} ${args}: 0 `);
      }
      const cronAfter = existsSync(join(home, "cron", "jobs.json")) ? readFileSync(join(home, "cron", "jobs.json"), "utf8") : null;
      expect(`${name}: ${cronAfter}`).toBe(`${name}: ${cron}`);
      expect(snapshot(elsewhere)).toEqual(outside);
      if (empty) expect(snapshot(home)).toEqual(empty);
      expect(existsSync(join(home, "hermes-calls.jsonl"))).toBe(false);
      expect(existsSync(join(home, "zzzbot"))).toBe(false);
      if (value.apps.length) expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(value);
    }
  }
});

test("review-b N2: gate off still removes a managed job from a bare-list store, and refuses a store Hermes cannot load that names it", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  const managedJob = jobs()[0];
  const resident = { id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true };
  // A bare list holding the managed job: removed, the resident's job kept (Hermes then saves the store canonical).
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify([resident, managedJob]));
  expect(stage(alone).status).toBe(0);
  expect(jobs()).toEqual([resident]);
  expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  // On a box still marked as one that was on (S4-r: here the installer's own shim), an unloadable store that names the managed
  // job (as written, or with Python's ensure_ascii em dash) may hold one that cannot be confirmed gone: the stage fails
  // loudly, and changes nothing in the store. Unmarked, the gate-off stage is main's and never reads the store.
  for (const text of [`{"jobs": [{"name": "${ZZZ_JOB_NAME}"`, '{"jobs": [{"name": "Edge \\u2014 zzz pairs", "x": NaN}]}']) {
    writeFileSync(join(home, "cron", "jobs.json"), text);
    expect(zzzMarkerOnDisk(home)).toBe(false);
    expect(stage(alone).status).toBe(0);
    expect(stage(alone, ["--verify"]).status).toBe(0);
    writeFileSync(join(home, "scripts", ZZZ_JOB_SCRIPT), SHIPPED_SHIM, { mode: 0o700 });
    expect(stage(alone).status).toBe(1);
    expect(stage(alone, ["--verify"]).status).toBe(1);
    expect(readFileSync(join(home, "cron", "jobs.json"), "utf8")).toBe(text);
    rmSync(join(home, "scripts", ZZZ_JOB_SCRIPT));
  }
});

const HERMES_LOADABLE_STORES = (() => {
  const resident = { id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true };
  return {
    "empty bare list": "[]",
    "bare list": JSON.stringify([resident]),
    "id-keyed map": JSON.stringify({ jobs: { aaaaaaaaaaaa: { name: resident.name, script: resident.script, enabled: true } } }),
    "object without jobs": "{}",
    "BOM": "﻿" + JSON.stringify({ jobs: [resident] }),
    "raw control character in a string": `{"jobs": [{"id": "aaaaaaaaaaaa", "name": "Morning\tdigest", "script": "digest.sh", "enabled": true}]}`,
  };
})();

for (const [label, text] of Object.entries(HERMES_LOADABLE_STORES)) {
  test(`review-b N2: gate on handles Hermes-loadable jobs.json shape: ${label}`, () => {
    const { home, stage, jobs } = fakeBox();
    mkdirSync(join(home, "cron"));
    writeFileSync(join(home, "cron", "jobs.json"), text);
    expect(`${label}: ${stage(projection).status}`).toBe(`${label}: 0`);
    const managedJobs = jobs().filter((job: { name: string }) => job.name === ZZZ_JOB_NAME);
    expect(managedJobs).toHaveLength(1);
    expect(`${label}: ${stage(projection, ["--verify"]).status}`).toBe(`${label}: 0`);
  });
}

test("review-b N2: gate on refuses jobs.json shapes Hermes cannot load", () => {
  // Hermes refuses any other top-level shape, and so does the installer with the gate on (fail closed, stage fails).
  const { home, stage } = fakeBox();
  mkdirSync(join(home, "cron"));
  for (const text of ["{not json", "\"jobs\"", "{\"jobs\": 7}"]) {
    writeFileSync(join(home, "cron", "jobs.json"), text);
    expect(stage(projection).status).toBe(1);
    expect(readFileSync(join(home, "cron", "jobs.json"), "utf8")).toBe(text);
    expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
  }
});

test("review-b N3: --verify checks the job record: exactly the installer's job while the pair is projected, none once it is not", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  const good = readFileSync(join(home, "cron", "jobs.json"), "utf8");
  const verify = (value: unknown) => {
    const before = snapshot(home);
    const result = stage(value, ["--verify"], HERMES_GONE(home));
    expect(snapshot(home)).toEqual(before);
    return result.status;
  };
  expect(verify(projection)).toBe(0);
  const job = jobs()[0];
  const variants: [string, unknown][] = [
    ["job gone", { jobs: [] }], ["job disabled", { jobs: [{ ...job, enabled: false }] }],
    ["toolsets widened", { jobs: [{ ...job, enabled_toolsets: ["all"] }] }], ["no_agent", { jobs: [{ ...job, no_agent: false }] }],
    ["workdir", { jobs: [{ ...job, workdir: home }] }],
    ["another script", { jobs: [{ ...job, script: "other.sh" }] }], ["duplicate", { jobs: [job, { ...job, id: "bbbbbbbbbbbb" }] }],
  ];
  for (const [label, doc] of variants) {
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify(doc));
    expect(`${label}: ${verify(projection)}`).toBe(`${label}: 1`);
  }
  writeFileSync(join(home, "cron", "jobs.json"), good);
  expect(verify(projection)).toBe(0);
  // The shim the job runs: missing or altered is a mismatch.
  const shim = join(home, "scripts", ZZZ_JOB_SCRIPT);
  const shimBytes = readFileSync(shim);
  writeFileSync(shim, "#!/bin/sh\necho altered\n");
  expect(verify(projection)).toBe(1);
  rmSync(shim);
  expect(verify(projection)).toBe(1);
  writeFileSync(shim, shimBytes, { mode: 0o700 });
  expect(verify(projection)).toBe(0);
  // Gate off on a box the job's shim still marks (S4-r): a lingering managed job (files and state already gone) is
  // removal pending; so is the shim alone in a real scripts/ (review-b N9, M30), and leftover state alone.
  expect(stage(alone).status).toBe(0);
  expect(verify(alone)).toBe(0);
  writeFileSync(shim, shimBytes, { mode: 0o700 });
  writeFileSync(join(home, "cron", "jobs.json"), good);
  expect(verify(alone)).toBe(1);
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [] }));
  expect(zzzMarkerOnDisk(home)).toBe(true);
  expect(verify(alone)).toBe(1);
  rmSync(shim);
  expect(verify(alone)).toBe(0);
  seedState(home);
  expect(verify(alone)).toBe(1);
  expect(stage(alone).status).toBe(0);
  expect(verify(alone)).toBe(0);
});

test("review-b N3: a box with no projection left heals a lingering job and state (the stateless branch), and verify sees it", () => {
  const { home, stage, jobs } = fakeBox();
  expect(stage(projection).status).toBe(0);
  seedState(home);
  // An interrupted uninstall: the projection and every owned skill are gone, the job, shim and cursor state linger.
  for (const path of ["mini-apps.json", "skills/zzzbot/SKILL.md", "skills/zzzbot/prompts/participate.md", `skills/zzzbot/scripts/${ZZZ_JOB_SCRIPT}`])
    rmSync(join(home, path));
  const empty = { version: 1, apps: [] };
  expect(jobs()).toHaveLength(1);
  expect(stage(empty, ["--verify"]).status).toBe(1);
  expect(jobs()).toHaveLength(1);
  expect(stage(empty).status).toBe(0);
  expectOff(home, jobs);
  expect(existsSync(join(home, "mini-apps.json"))).toBe(false);
  expect(stage(empty, ["--verify"]).status).toBe(0);
});

/** snapshot(), lstat only: a symlink is its target (never followed), an unreadable file its mode, size and mtime. */
function lsnapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const st = lstatSync(path);
      if (st.isSymbolicLink()) out[relative(root, path)] = `link:${readlinkSync(path)}`;
      else if (st.isDirectory()) { out[relative(root, path) + "/"] = String(st.mode); walk(path); }
      else if (!st.isFile()) out[relative(root, path)] = `special:${st.mode}:${st.ino}`;
      else {
        try { out[relative(root, path)] = `${st.mode}:${readFileSync(path, "base64")}`; }
        catch { out[relative(root, path)] = `${st.mode}:unreadable:${st.size}:${st.mtimeMs}`; }
      }
    }
  };
  walk(root);
  return out;
}
/** The fake Hermes bound, but HOME and PATH isolated (no ~/.local/bin/hermes or PATH hermes can resolve). */
function ISOLATED() {
  const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-nohome-"));
  roots.push(elsewhere);
  return { HOME: elsewhere, PATH: "/usr/bin:/bin" };
}
const RESIDENT_JOB = { id: "aaaaaaaaaaaa", name: "Morning digest", script: "digest.sh", enabled: true };
/** A loadable store whose job carries the managed name: on an unmarked gate-off box it is never even read. */
const NAMING_STORE = JSON.stringify({ jobs: [RESIDENT_JOB, { id: "cccccccccccc", name: ZZZ_JOB_NAME, script: ZZZ_JOB_SCRIPT,
  enabled: true, enabled_toolsets: [...ZZZ_JOB_TOOLSETS] }] });
type BoxShape = { label: string; seed: (home: string, elsewhere: string) => void };
/** review-b S4-r (recheck a819d1cf): the six shapes that still failed a gate-off stage where main passes. */
const S4R_SHAPES: BoxShape[] = [
  { label: "cron/ a symlink", seed: (home, elsewhere) => {
    mkdirSync(join(elsewhere, "cron"));
    writeFileSync(join(elsewhere, "cron", "jobs.json"), NAMING_STORE);
    symlinkSync(join(elsewhere, "cron"), join(home, "cron")); } },
  { label: "cron/jobs.json a symlink", seed: (home, elsewhere) => {
    mkdirSync(join(home, "cron"));
    writeFileSync(join(elsewhere, "jobs.json"), NAMING_STORE);
    symlinkSync(join(elsewhere, "jobs.json"), join(home, "cron", "jobs.json")); } },
  { label: "cron/jobs.json a directory", seed: home => { mkdirSync(join(home, "cron", "jobs.json"), { recursive: true }); } },
  { label: "cron/jobs.json mode 000", seed: home => {
    mkdirSync(join(home, "cron"));
    writeFileSync(join(home, "cron", "jobs.json"), NAMING_STORE);
    chmodSync(join(home, "cron", "jobs.json"), 0); } },
  { label: "~/zzzbot a regular file", seed: home => { writeFileSync(join(home, "zzzbot"), "resident"); } },
  { label: "~/zzzbot a symlink", seed: (home, elsewhere) => {
    mkdirSync(join(elsewhere, "zzzbot"));
    writeFileSync(join(elsewhere, "zzzbot", "managed-pairs.json"), "{}");
    writeFileSync(join(elsewhere, "zzzbot", "managed-pairs.lock"), "");
    symlinkSync(join(elsewhere, "zzzbot"), join(home, "zzzbot")); } },
];
/** The earlier S4 shapes (regression pins), and a store holding a job by the managed name on a box with no marker. */
const S4_PINS: BoxShape[] = [
  { label: "unparseable jobs.json", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), "{not json"); } },
  { label: "bare-list jobs.json", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify([RESIDENT_JOB])); } },
  { label: "id-keyed jobs.json", seed: home => { mkdirSync(join(home, "cron"));
    writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: { aaaaaaaaaaaa: RESIDENT_JOB } })); } },
  { label: "symlinked scripts/ holding a file by the shim's name", seed: (home, elsewhere) => {
    writeFileSync(join(elsewhere, ZZZ_JOB_SCRIPT), "#!/bin/sh\necho resident\n");
    symlinkSync(elsewhere, join(home, "scripts")); } },
  { label: "an unloadable store naming the managed job", seed: home => { mkdirSync(join(home, "cron"));
    writeFileSync(join(home, "cron", "jobs.json"), `{"jobs": [{"name": "${ZZZ_JOB_NAME}"`); } },
  { label: "a job by the managed name with no marker", seed: home => { mkdirSync(join(home, "cron")); writeFileSync(join(home, "cron", "jobs.json"), NAMING_STORE); } },
  { label: "skills/zzzbot/prompts and scripts symlinks", seed: (home, elsewhere) => {
    mkdirSync(join(home, "skills", "zzzbot"), { recursive: true });
    for (const [dir, file] of [["prompts", "participate.md"], ["scripts", ZZZ_JOB_SCRIPT]]) {
      mkdirSync(join(elsewhere, dir));
      writeFileSync(join(elsewhere, dir, file), "resident");
      symlinkSync(join(elsewhere, dir), join(home, "skills", "zzzbot", dir));
    } } },
];
/** What main's stage writes for these projections on a fresh box (nothing for apps:[]). */
const MAIN_WRITES = new Set(["mini-apps.json", "skills/", "skills/gold-stars/", "skills/gold-stars/SKILL.md", "skills/zzzbot/", "skills/zzzbot/SKILL.md"]);

test("review-b S4-r (lead L17296): gate off with no zzz marker is main's stage: rc 0, nothing read or changed, on every box shape", () => {
  const projections = [{ version: 1, apps: [] }, { version: 1, apps: [gold] }, { version: 1, apps: [gold, zzzbot] }];
  for (const { label, seed } of [...S4R_SHAPES, ...S4_PINS]) {
    for (const value of projections) {
      const { home, stage } = fakeBox();
      const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
      roots.push(elsewhere);
      seed(home, elsewhere);
      const name = `${label} / ${value.apps.map(app => app.id).join("+") || "nothing (non-cohort)"}`;
      expect(`${name}: ${zzzMarkerOnDisk(home)}`).toBe(`${name}: false`);
      const fresh = lsnapshot(home);
      const outside = lsnapshot(elsewhere);
      // First stage on the box: every existing entry is untouched; only main's own projection files are added.
      let result = stage(value, [], HERMES_GONE(home));
      expect(`${name}: ${result.status} ${result.stderr}`).toBe(`${name}: 0 `);
      const staged = lsnapshot(home);
      for (const [path, entry] of Object.entries(fresh)) expect(`${name} ${path}: ${staged[path]}`).toBe(`${name} ${path}: ${entry}`);
      const added = Object.keys(staged).filter(path => !(path in fresh));
      expect(added.filter(path => !MAIN_WRITES.has(path))).toEqual([]);
      if (!value.apps.length) expect(added).toEqual([]);
      // Then verify, re-stage and verify again: rc 0 and the tree byte-identical, the shape's targets too.
      for (const args of [["--verify"], [], ["--verify"]]) {
        result = stage(value, args, HERMES_GONE(home));
        expect(`${name} ${args}: ${result.status} ${result.stderr}`).toBe(`${name} ${args}: 0 `);
        expect(lsnapshot(home)).toEqual(staged);
      }
      expect(lsnapshot(elsewhere)).toEqual(outside);
      // A failed stage on the same box (main rc 1) touches nothing ZZZ either, even with a Hermes bound.
      result = stage("not json", [], ISOLATED());
      expect(`${name}: ${result.status} ${result.stderr}`).toBe(`${name}: 1 ${FAILED}`);
      expect(lsnapshot(home)).toEqual(staged);
      expect(existsSync(join(home, "hermes-calls.jsonl"))).toBe(false);
    }
  }
}, 30000);

test("review-b S4-r, gate on: each shape fails the stage before any shim or job, other apps keep authority, and revoking is main's stage", () => {
  const before = { version: 1, apps: [gold, forkicks, zzzbot] };
  const granted = { version: 1, apps: [gold, forkicks, zzzbot, bridge] };
  const others: [string, string][] = [["gold-stars", "rolodex.search"], ["forkicks", "forkicks.menu"]];
  const shapeOf = (snap: Record<string, string>) => Object.fromEntries(Object.entries(snap).filter(([path]) => /^(cron|zzzbot)(\/|$)/.test(path)));
  for (const { label, seed } of S4R_SHAPES) {
    const { home, stage } = fakeBox();
    const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
    roots.push(elsewhere);
    const env = ISOLATED();
    expect(stage(before, [], env).status).toBe(0);
    seed(home, elsewhere);
    const shape = shapeOf(lsnapshot(home));
    const outside = lsnapshot(elsewhere);
    for (let retry = 0; retry < 2; retry++) {
      const result = stage(granted, [], env);
      expect(`${label}: ${result.status} ${result.stderr}`).toBe(`${label}: 1 ${FAILED}`);
      // S3: the projection (every other app's authority) is published before the job step fails.
      expect(JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8"))).toEqual(granted);
      expect(pluginInstalled(home, others)).toEqual([true, true]);
      // Nothing managed is left to run: no shim, no managed files, no job API or Hermes call, the shape untouched.
      expect(`${label}: ${zzzMarkerOnDisk(home)}`).toBe(`${label}: false`);
      expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(false);
      expect(existsSync(join(home, "hermes-calls.jsonl"))).toBe(false);
      expect(shapeOf(lsnapshot(home))).toEqual(shape);
      expect(lsnapshot(elsewhere)).toEqual(outside);
      expect(`${label} verify: ${stage(granted, ["--verify"], env).status}`).toBe(`${label} verify: 1`);
    }
    // The grant revoked with the shape still there: no marker, so main's stage (rc 0) and verify (rc 0).
    expect(`${label} revoked: ${stage(before, [], env).status}`).toBe(`${label} revoked: 0`);
    expect(`${label} revoked verify: ${stage(before, ["--verify"], env).status}`).toBe(`${label} revoked verify: 0`);
    expect(shapeOf(lsnapshot(home))).toEqual(shape);
  }
  // An installed pair whose state folder is later replaced by a file or a symlink no longer verifies.
  const { home, stage } = fakeBox();
  expect(stage(granted, [], ISOLATED()).status).toBe(0);
  expect(stage(granted, ["--verify"], ISOLATED()).status).toBe(0);
  writeFileSync(join(home, "zzzbot"), "resident");
  expect(stage(granted, ["--verify"], ISOLATED()).status).toBe(1);
  rmSync(join(home, "zzzbot"));
  symlinkSync(home, join(home, "zzzbot"));
  expect(stage(granted, ["--verify"], ISOLATED()).status).toBe(1);
  rmSync(join(home, "zzzbot"));
  expect(stage(granted, ["--verify"], ISOLATED()).status).toBe(0);
});

test("S4-r (lead L17296): every job API call finds the job's shim on disk, and a failed removal leaves the box marked", () => {
  const { home, stage, jobs } = fakeBox();
  // The fake job API refuses to run unless the shim (the marker that goes last) is already on disk.
  const python = join(home, "venv", "bin", "python");
  const guarded = readFileSync(python, "utf8").replace('if [ "$1" = "-c" ]; then\n',
    `if [ "$1" = "-c" ]; then\n  [ -f "$HERMES_HOME/scripts/${ZZZ_JOB_SCRIPT}" ] || exit 7\n`);
  expect(guarded).toContain("|| exit 7");
  writeFileSync(python, guarded);
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  // The installer replaces an overbroad record (remove + create) through the same API.
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs: [{ ...jobs()[0], enabled_toolsets: ["all"] }] }));
  expect(stage(projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  seedState(home);
  // Revoked (and a failed stage) while Hermes is gone: the job cannot be removed, so the shim stays and so does the job.
  for (const input of [alone as unknown, "not json"]) {
    expect(stage(input, [], HERMES_GONE(home)).status).toBe(1);
    expect(jobs()).toHaveLength(1);
    expect(existsSync(join(home, "scripts", ZZZ_JOB_SCRIPT))).toBe(true);
    expect(zzzMarkerOnDisk(home)).toBe(true);
    expect(stage(alone, ["--verify"], HERMES_GONE(home)).status).toBe(1);
  }
  // Hermes back: the removal runs (with the shim still there), then the shim and everything else goes.
  expect(stage(alone).status).toBe(0);
  expectOff(home, jobs);
  expect(zzzMarkerOnDisk(home)).toBe(false);
  expect(stage(alone, ["--verify"], HERMES_GONE(home)).status).toBe(0);
});

test("S4-r: a box that was on keeps the earlier N2 tolerance in its teardown (store Hermes cannot load, symlinked scripts/)", () => {
  // Unloadable store that does not name the job: Hermes runs nothing from it; the teardown completes.
  {
    const { home, stage, jobs } = fakeBox();
    expect(stage(projection).status).toBe(0);
    seedState(home);
    writeFileSync(join(home, "cron", "jobs.json"), "{not json");
    expect(stage(alone, [], HERMES_GONE(home)).status).toBe(0);
    expect(readFileSync(join(home, "cron", "jobs.json"), "utf8")).toBe("{not json");
    expect(zzzMarkerOnDisk(home)).toBe(false);
    rmSync(join(home, "cron", "jobs.json"));
    expectOff(home, jobs);
  }
  // scripts/ swapped for a symlink after the install: the job is removed, the files and state go, and nothing is
  // followed (a resident's file by the shim's name behind the link is kept).
  {
    const { home, stage, jobs } = fakeBox();
    expect(stage(projection).status).toBe(0);
    const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
    roots.push(elsewhere);
    writeFileSync(join(elsewhere, ZZZ_JOB_SCRIPT), "#!/bin/sh\necho resident\n");
    rmSync(join(home, "scripts"), { recursive: true });
    symlinkSync(elsewhere, join(home, "scripts"));
    const outside = lsnapshot(elsewhere);
    expect(zzzMarkerOnDisk(home)).toBe(true);
    expect(stage(alone).status).toBe(0);
    expect(jobs()).toHaveLength(0);
    expect(lsnapshot(elsewhere)).toEqual(outside);
    expect(zzzMarkerOnDisk(home)).toBe(false);
    expect(stage(alone, ["--verify"], HERMES_GONE(home)).status).toBe(0);
  }
});

/** Every marker path (S4-r), and what the installer or the plugin ever writes there. */
const MARKER_PATHS = [`scripts/${ZZZ_JOB_SCRIPT}`, `skills/zzzbot/scripts/${ZZZ_JOB_SCRIPT}`, "skills/zzzbot/prompts/participate.md",
  "zzzbot/managed-pairs.json", "zzzbot/managed-pairs.lock", "zzzbot/managed-run.lock"];
const INSTALLER_MARKERS = MARKER_PATHS.slice(0, 3);
const ownBytes = (path: string) => path.endsWith(ZZZ_JOB_SCRIPT) ? SHIPPED_RUNNER : path.endsWith("participate.md") ? SHIPPED_PROMPT : Buffer.from("{}");
/** S5 (review-b recheck L17481 m1-m4, m7): the non-regular objects an agent could plant at a marker path. */
const S5_SHAPES: { label: string; seed: (path: string, elsewhere: string, marker: string) => void }[] = [
  { label: "dangling symlink", seed: (path, elsewhere) => { symlinkSync(join(elsewhere, "nowhere"), path); } },
  // The outside file holds the installer's own bytes: following the link would make it count.
  { label: "symlink to an outside file", seed: (path, elsewhere, marker) => {
    writeFileSync(join(elsewhere, "outside"), ownBytes(marker));
    symlinkSync(join(elsewhere, "outside"), path); } },
  { label: "directory", seed: path => { mkdirSync(path); writeFileSync(join(path, "inside"), "resident"); } },
  { label: "FIFO", seed: path => { expect(spawnSync("/usr/bin/mkfifo", [path]).status).toBe(0); } },
];
const GATE_OFF = [{ version: 1, apps: [] }, { version: 1, apps: [gold] }, { version: 1, apps: [gold, zzzbot] }];
const SPY = join(import.meta.dir, "spawn_spy.ts");
const notice = (paths: string[]) => `${JSON.stringify({ notice: "zzz_not_ours", paths })}\n`;
/** The real CLI under the spawn spy, Hermes BOUND (so any Hermes or job API call would run and be logged), HOME/PATH isolated. */
function spiedStage(home: string, value: unknown, args: string[] = []) {
  const logs = mkdtempSync(join(tmpdir(), "av-zzz-spy-"));
  roots.push(logs);
  const log = join(logs, "spawns.log");
  const result = spawnSync(process.execPath, ["--no-env-file", "--no-install", "--preload", SPY, "install/install_miniapps.ts", ...args],
    { cwd: join(import.meta.dir, "../.."), input: typeof value === "string" ? value : JSON.stringify(value),
      env: { ...process.env, ...ISOLATED(), HERMES_HOME: home, SPAWN_LOG: log }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, spawns: existsSync(log) ? readFileSync(log, "utf8") : "" };
}
/** A never-granted box with `seed` applied under real parent directories, run stage / verify / re-stage / failed stage. */
function expectMainStage(name: string, seed: (home: string, elsewhere: string) => void, logged: string[]) {
  for (const value of GATE_OFF) {
    const { home } = fakeBox();
    const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
    roots.push(elsewhere);
    seed(home, elsewhere);
    const row = `${name} / ${value.apps.map(app => app.id).join("+") || "nothing (non-cohort)"}`;
    expect(`${row}: ${zzzMarkerOnDisk(home)}`).toBe(`${row}: false`);
    const fresh = lsnapshot(home);
    const outside = lsnapshot(elsewhere);
    let result = spiedStage(home, value);
    expect(`${row}: ${result.status} ${result.stderr}|${result.spawns}`).toBe(`${row}: 0 ${notice(logged)}|`);
    const staged = lsnapshot(home);
    for (const [path, entry] of Object.entries(fresh)) expect(`${row} ${path}: ${staged[path]}`).toBe(`${row} ${path}: ${entry}`);
    const added = Object.keys(staged).filter(path => !(path in fresh));
    expect(added.filter(path => !MAIN_WRITES.has(path))).toEqual([]);
    if (!value.apps.length) expect(added).toEqual([]);
    for (const args of [["--verify"], [], ["--verify"]]) {
      result = spiedStage(home, value, args);
      expect(`${row} ${args}: ${result.status} ${result.stderr}|${result.spawns}`).toBe(`${row} ${args}: 0 ${notice(logged)}|`);
      expect(lsnapshot(home)).toEqual(staged);
    }
    // main's failed stage (rc 1): still nothing ZZZ, nothing spawned.
    result = spiedStage(home, "not json");
    expect(`${row}: ${result.status} ${result.stderr}|${result.spawns}`).toBe(`${row}: 1 ${notice(logged)}${FAILED}|`);
    expect(lsnapshot(home)).toEqual(staged);
    expect(lsnapshot(elsewhere)).toEqual(outside);
    expect(existsSync(join(home, "hermes-calls.jsonl"))).toBe(false);
    expect(existsSync(join(home, "cron"))).toBe(false);
  }
}

test("S5 (review-b L17481, lead RULING): a symlink, directory, FIFO or dangling link at any marker path is main's stage: rc 0, nothing changed, 0 spawns", () => {
  for (const marker of MARKER_PATHS) {
    for (const { label, seed } of S5_SHAPES) {
      expectMainStage(`${label} at ${marker}`, (home, elsewhere) => {
        mkdirSync(join(home, marker, ".."), { recursive: true });
        seed(join(home, marker), elsewhere, marker);
      }, [marker]);
    }
  }
}, 30000);

test("N12 (nonav OWNER CALL, pick (a)): a resident's regular file at an installer marker path is not ours: kept byte-identical, no teardown", () => {
  for (const marker of INSTALLER_MARKERS) {
    // A resident's own file, and a near miss of the shipped bytes (one byte more, one byte less).
    const own = ownBytes(marker);
    for (const [label, bytes] of [["resident's file", Buffer.from("#!/bin/sh\necho mine\n")], ["shipped bytes + 1", Buffer.concat([own, Buffer.from("\n")])],
      ["shipped bytes - 1", own.subarray(0, own.length - 1)]] as [string, Buffer][]) {
      expectMainStage(`${label} at ${marker}`, home => {
        mkdirSync(join(home, marker, ".."), { recursive: true });
        writeFileSync(join(home, marker), bytes, { mode: 0o700 });
      }, [marker]);
    }
  }
  // All three at once: still one notice line naming each.
  expectMainStage("resident files at all three", home => {
    for (const marker of INSTALLER_MARKERS) {
      mkdirSync(join(home, marker, ".."), { recursive: true });
      writeFileSync(join(home, marker), "mine");
    }
  }, INSTALLER_MARKERS);
}, 20000);

test("N12: an installer-written file (shipped sha) still marks a once-on box: each marker alone tears the job down, rc 0, verify 0", () => {
  for (const keep of MARKER_PATHS) {
    const { home, stage, jobs } = fakeBox();
    expect(stage(projection).status).toBe(0);
    expect(jobs()).toHaveLength(1);
    seedState(home);
    for (const marker of MARKER_PATHS) if (marker !== keep) rmSync(join(home, marker));
    rmSync(join(home, "zzzbot", ".managed-123"));
    if (!keep.startsWith("zzzbot/")) rmSync(join(home, "zzzbot"), { recursive: true });
    expect(`${keep}: ${zzzMarkerOnDisk(home)}`).toBe(`${keep}: true`);
    expect(readFileSync(join(home, keep)).equals(ownBytes(keep)) || keep.startsWith("zzzbot/")).toBe(true);
    expect(`${keep} verify: ${spiedStage(home, alone, ["--verify"]).status}`).toBe(`${keep} verify: 1`);
    const result = spiedStage(home, alone);
    expect(`${keep}: ${result.status} ${result.stderr}`).toBe(`${keep}: 0 `);
    // Positive control for the spy: the teardown reaches Hermes's job API.
    expect(result.spawns).not.toBe("");
    expectOff(home, jobs);
    expect(zzzMarkerOnDisk(home)).toBe(false);
    const after = spiedStage(home, alone, ["--verify"]);
    expect(`${keep} verify: ${after.status} ${after.spawns}`).toBe(`${keep} verify: 0 `);
  }
});

for (const replaced of MARKER_PATHS) test(`N12: a once-on box's teardown preserves a resident's object at ${replaced}`, () => {
  const replacements: [string, (path: string, elsewhere: string, original: Buffer) => void][] = [
    ["resident's file", path => writeFileSync(path, "mine", { mode: 0o600 })],
    ["directory", path => { mkdirSync(path); writeFileSync(join(path, "inside"), "resident"); }],
    // The link's target holds what the installer (or plugin) wrote there: following it would make it ours.
    ["symlink to the original bytes", (path, elsewhere, original) => { writeFileSync(join(elsewhere, "copy"), original); symlinkSync(join(elsewhere, "copy"), path); }],
    ["FIFO", path => { expect(spawnSync("/usr/bin/mkfifo", [path]).status).toBe(0); }],
  ];
  // The other (installer-written) markers keep the teardown going; a successful revocation and a failed stage
  // (failClosedZzz) both run it. A regular file by a plugin state name is the plugin's (its bytes vary per box): only
  // non-regular objects there.
  for (const input of [alone as unknown, "not json"]) {
    for (const [label, plant] of replacements) {
      if (replaced.startsWith("zzzbot/") && label === "resident's file") continue;
      const { home, stage, jobs } = fakeBox();
      const elsewhere = mkdtempSync(join(tmpdir(), "av-zzz-elsewhere-"));
      roots.push(elsewhere);
      expect(stage(projection).status).toBe(0);
      seedState(home);
      writeFileSync(join(home, "zzzbot", "resident.txt"), "mine");
      const path = join(home, replaced);
      const original = readFileSync(path);
      rmSync(path);
      plant(path, elsewhere, original);
      const kept = Object.fromEntries(Object.entries(lsnapshot(home)).filter(([key]) => key === replaced || key.startsWith(`${replaced}/`)));
      const outside = lsnapshot(elsewhere);
      const row = `${label} at ${replaced} (${typeof input === "string" ? "failed stage" : "revoked"})`;
      const result = spiedStage(home, input);
      expect(`${row}: ${result.status} ${result.stderr}`).toBe(typeof input === "string"
        ? `${row}: 1 ${notice([replaced])}${FAILED}` : `${row}: 0 ${notice([replaced])}`);
      expect(jobs()).toHaveLength(0);
      for (const marker of MARKER_PATHS) if (marker !== replaced) expect(`${row} ${marker}: ${existsSync(join(home, marker))}`).toBe(`${row} ${marker}: false`);
      // The replaced object is exactly as planted; the resident's file in zzzbot/ (and so the folder) stays.
      expect(Object.fromEntries(Object.entries(lsnapshot(home)).filter(([key]) => key === replaced || key.startsWith(`${replaced}/`)))).toEqual(kept);
      expect(readFileSync(join(home, "zzzbot", "resident.txt"), "utf8")).toBe("mine");
      expect(lsnapshot(elsewhere)).toEqual(outside);
      // Torn down: the next stage and verify are main's (the notice only), with nothing spawned.
      // Stage may normalize mini-apps.json after a failed input, so snapshot after that first stage.
      const again = spiedStage(home, alone);
      expect(`${row} stage: ${again.status} ${again.stderr}|${again.spawns}`).toBe(`${row} stage: 0 ${notice([replaced])}|`);
      const settled = lsnapshot(home);
      const verified = spiedStage(home, alone, ["--verify"]);
      expect(`${row} verify: ${verified.status} ${verified.stderr}|${verified.spawns}`).toBe(`${row} verify: 0 ${notice([replaced])}|`);
      expect(lsnapshot(home)).toEqual(settled);
      // A link to our original bytes following a failed stage is the strongest repeat control at every marker.
      if (label === "symlink to the original bytes" && typeof input === "string") {
        const restaged = spiedStage(home, alone);
        expect(`${row} restage: ${restaged.status} ${restaged.stderr}|${restaged.spawns}`).toBe(`${row} restage: 0 ${notice([replaced])}|`);
        expect(lsnapshot(home)).toEqual(settled);
        const reverified = spiedStage(home, alone, ["--verify"]);
        expect(`${row} reverify: ${reverified.status} ${reverified.stderr}|${reverified.spawns}`).toBe(`${row} reverify: 0 ${notice([replaced])}|`);
        expect(lsnapshot(home)).toEqual(settled);
      }
      expect(Object.fromEntries(Object.entries(lsnapshot(home)).filter(([key]) => key === replaced || key.startsWith(`${replaced}/`)))).toEqual(kept);
      expect(readFileSync(join(home, "zzzbot", "resident.txt"), "utf8")).toBe("mine");
      expect(lsnapshot(elsewhere)).toEqual(outside);
    }
  }
}, 30000);

test("N15: a marker replaced after lstat is never accepted or followed", () => {
  for (const shape of ["control", "other-inode", "symlink", "fifo"] as const) {
    const dir = mkdtempSync(join(tmpdir(), "av-zzz-swap-"));
    roots.push(dir);
    const marker = join(dir, "marker");
    const replacement = join(dir, "replacement");
    const outside = join(dir, "outside");
    writeFileSync(marker, SHIPPED_SHIM);
    writeFileSync(outside, SHIPPED_SHIM);
    if (shape === "other-inode") writeFileSync(replacement, SHIPPED_SHIM);
    if (shape === "symlink") symlinkSync(outside, replacement);
    if (shape === "fifo") expect(spawnSync("/usr/bin/mkfifo", [replacement]).status).toBe(0);
    const run = spawnSync(process.execPath,
      ["--no-env-file", "--no-install", "--preload", join(import.meta.dir, "zzz_swap_preload.ts"), "-e",
        'import { zzzShippedFile } from "./install/zzz_managed_job.ts"; console.log(zzzShippedFile(process.env.ZZZ_SWAP_TARGET!, "runner"));'],
      { cwd: join(import.meta.dir, "../.."), encoding: "utf8", timeout: 3000,
        env: { ...process.env, ZZZ_SWAP_TARGET: marker,
          ...(shape === "control" ? {} : { ZZZ_SWAP_REPLACEMENT: replacement }) } });
    expect(`${shape}: ${run.status} ${run.stderr}`).toBe(`${shape}: 0 `);
    expect(`${shape}: ${run.stdout.trim()}`).toBe(`${shape}: ${shape === "control" ? "ours" : "not_ours"}`);
    expect(readFileSync(outside).equals(SHIPPED_SHIM)).toBe(true);
    if (shape !== "control") expect(existsSync(replacement)).toBe(false);
  }
}, 15000);

test("N12: the shipped sha table holds this checkout's managed-file bytes, and ownership is exact (regular file, shipped bytes, no link)", () => {
  // A source change without a new entry here would leave a box the new installer turned on unmarked once revoked.
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  expect(ZZZ_SHIPPED_SHA256.shim as readonly string[]).toContain(sha(SHIPPED_LEGACY_SHIM));
  expect(ZZZ_SHIPPED_SHA256.prompt as readonly string[]).toContain(sha(SHIPPED_PROMPT));
  expect(ZZZ_SHIPPED_SHA256.runner as readonly string[]).toContain(sha(SHIPPED_RUNNER));
  for (const list of Object.values(ZZZ_SHIPPED_SHA256)) for (const entry of list) expect(entry).toMatch(/^[0-9a-f]{64}$/);
  const dir = mkdtempSync(join(tmpdir(), "av-zzz-owned-"));
  roots.push(dir);
  const at = (name: string) => join(dir, name);
  writeFileSync(at("shim"), SHIPPED_LEGACY_SHIM);
  writeFileSync(at("runner"), SHIPPED_RUNNER);
  writeFileSync(at("prompt"), SHIPPED_PROMPT);
  writeFileSync(at("near"), Buffer.concat([SHIPPED_LEGACY_SHIM, Buffer.from(" ")]));
  writeFileSync(at("big"), Buffer.alloc(65537));
  symlinkSync(at("shim"), at("link"));
  mkdirSync(at("dir"));
  expect(spawnSync("/usr/bin/mkfifo", [at("fifo")]).status).toBe(0);
  writeFileSync(at("locked"), SHIPPED_LEGACY_SHIM, { mode: 0 });
  expect([zzzShippedFile(at("shim"), "shim"), zzzShippedFile(at("prompt"), "prompt"), zzzShippedFile(at("missing"), "shim")])
    .toEqual(["ours", "ours", "absent"]);
  expect(zzzShippedFile(at("runner"), "runner")).toBe("ours");
  // Each kind matches only its own bytes.
  expect([zzzShippedFile(at("shim"), "prompt"), zzzShippedFile(at("prompt"), "shim")]).toEqual(["not_ours", "not_ours"]);
  for (const name of ["near", "big", "link", "dir", "fifo", "locked"]) expect(`${name}: ${zzzShippedFile(at(name), "shim")}`).toBe(`${name}: not_ours`);
  // The scan names what it leaves, and counts nothing for it.
  const { home } = fakeBox();
  mkdirSync(join(home, "scripts"));
  writeFileSync(join(home, "scripts", ZZZ_JOB_SCRIPT), "mine");
  mkdirSync(join(home, "zzzbot"));
  mkdirSync(join(home, "zzzbot", "managed-pairs.json"));
  expect(zzzMarkerScan(home)).toEqual({ ours: false, notOurs: [`scripts/${ZZZ_JOB_SCRIPT}`, "zzzbot/managed-pairs.json"] });
  writeFileSync(join(home, "zzzbot", "managed-pairs.lock"), "");
  expect(zzzMarkerScan(home)).toEqual({ ours: true, notOurs: [`scripts/${ZZZ_JOB_SCRIPT}`, "zzzbot/managed-pairs.json"] });
});

/** A box the pair turned on, then every installer-written file edited (sha mismatch: not ours), the job still there. */
function editedOnceOnBox(withState: boolean) {
  const box = fakeBox();
  expect(box.stage(projection).status).toBe(0);
  expect(box.jobs()).toHaveLength(1);
  for (const marker of INSTALLER_MARKERS) writeFileSync(join(box.home, marker), `${readFileSync(join(box.home, marker), "utf8")}# edited by the resident\n`);
  if (withState) seedState(box.home);
  const edited = Object.fromEntries(INSTALLER_MARKERS.map(marker => [marker, readFileSync(join(box.home, marker), "base64")]));
  return { ...box, edited };
}

test("revocation (security review): with every installer file edited, genuine plugin state alone still removes the job; the edited files stay", () => {
  for (const input of [alone as unknown, "not json"]) {
    const { home, jobs, edited } = editedOnceOnBox(true);
    expect(zzzMarkerScan(home)).toEqual({ ours: true, notOurs: INSTALLER_MARKERS });
    const result = spiedStage(home, input);
    expect(`${result.status} ${result.stderr}`).toBe(typeof input === "string" ? `1 ${notice(INSTALLER_MARKERS)}${FAILED}` : `0 ${notice(INSTALLER_MARKERS)}`);
    expect(result.spawns).not.toBe("");
    // The job is gone and so is the plugin's state; the resident's edited files are exactly as they were.
    expect(jobs()).toHaveLength(0);
    expect(existsSync(join(home, "zzzbot"))).toBe(false);
    for (const marker of INSTALLER_MARKERS) expect(`${marker}: ${readFileSync(join(home, marker), "base64")}`).toBe(`${marker}: ${edited[marker]}`);
    expect(zzzMarkerOnDisk(home)).toBe(false);
    for (const args of [[], ["--verify"]]) expect(spiedStage(home, alone, args).status).toBe(0);
    expect(pluginParticipation(home)).toBe("False");
  }
});

test("documented residual (review-b S4-r (b), N12): a job with NO genuine marker left is not read or removed, and it is inert: participation is projection-only", () => {
  const { home, jobs, edited } = editedOnceOnBox(false);
  const record = jobs();
  expect(zzzMarkerOnDisk(home)).toBe(false);
  // Gate off and no marker is main's stage: jobs.json is never read, nothing is removed or spawned.
  for (const args of [[], ["--verify"]]) {
    const result = spiedStage(home, alone, args);
    expect(`${args}: ${result.status} ${result.stderr}|${result.spawns}`).toBe(`${args}: 0 ${notice(INSTALLER_MARKERS)}|`);
  }
  expect(jobs()).toEqual(record);
  for (const marker of INSTALLER_MARKERS) expect(readFileSync(join(home, marker), "base64")).toBe(edited[marker]);
  // Inert: the plugin's participation (the poll's and the cron root's managed_context gate) reads only the projection.
  expect(pluginParticipation(home)).toBe("False");
  // A good stage carrying the pair again re-takes the job (one record, the installer's) and rewrites its own files.
  expect(spiedStage(home, projection).status).toBe(0);
  expect(jobs()).toHaveLength(1);
  expect(zzzMarkerOnDisk(home)).toBe(true);
});
