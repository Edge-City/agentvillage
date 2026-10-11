/**
 * OV-249 post-hoc refute, M1 and M2.
 *
 * M1: the managed MoralMod lifecycle runs for ON residents only. With `AV_MORALMOD_ARM` off or
 * unset, MoralMod files (`MORALMOD_RELEASE_DIR`, `MORALMOD_RESIDENT_CONFIG`, or
 * `index/moralmod/active.json`) change nothing: no plugin, no negotiator replacement, morning.py
 * untouched, no morning job, and the result says why (`note: moralmod_arm_not_on`).
 *
 * M2: the release bundle must be the one pinned in `MORALMOD_RELEASE_SHA256`. A bundle whose files
 * match its own release.json but whose release.json is not the pinned one is withheld
 * (`release_unpinned`) before any Hermes call and nothing is replaced; the pin computed from the
 * fixture activates (that test needs the pinned plugin checkout, as moralmod_morning.test.ts does).
 *
 * ov#277 refute S1: the pin holds on every ON run. A managed loader an earlier run left in the
 * plugin's negotiator.js (`--skip-index`, keyless, or keyed with active.json gone and MORALMOD_*
 * unset, probe P3) withholds the plugin as `release_unpinned` and is taken out unless it is exactly
 * the pinned release's loader and that release is intact. S2: the first OFF run after an ON-to-OFF
 * flip takes the loader out. ov#282 M1: once active.json exists, the plugin's own negotiator.js (a
 * Hermes reinstall puts it back) is accepted as well as the recorded loader; a customized file never is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import YAML from "yaml";

import {
  INDEX_PLUGIN,
  INDEX_PLUGIN_REF,
  INDEX_PLUGIN_SOURCE,
  MORALMOD_ARM_ENV,
  MORNING_JOB,
  MORNING_LAUNCHER,
  NEGOTIATOR_SEED,
  SIDECAR_PATCHED,
  indexPluginFailedLine,
  installIndexPlugin,
  installMetadataPath,
  negotiatorPath,
  recordIndexPluginStatus,
} from "../install_index_plugin";
import { managedLoaderSource } from "../moralmod_host";
import { morningSource } from "../moralmod_morning";
import { INDEX_PLUGIN_REVISION, MORALMOD_HOOK_VERSION, MORALMOD_RELEASE_SHA256, installMoralmodRelease } from "../moralmod_release";
import { installStatusPath, writeInstallStatus } from "../install_status";

const ENV_KEYS = ["HERMES_HOME", "INDEX_API_KEY", MORALMOD_ARM_ENV, "MORALMOD_RELEASE_DIR", "MORALMOD_RESIDENT_CONFIG"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const ARGV = ["bun", "install.ts", "--index-api-key", "ix_arm_pin_test"];
const FRESH = ["plugins", "install", INDEX_PLUGIN_SOURCE, "--ref", INDEX_PLUGIN_REF, "--no-enable"];
const BASE = "plugins:\n  enabled:\n    - av-events\n";
const OFF_LINE = `→ index-network plugin: off (${MORALMOD_ARM_ENV} is not on); MoralMod release or resident config present, not activated: the managed negotiator runs only for ON`;
const UNPINNED_LINE = "  warning: index-network plugin: not enabled, MoralMod release not pinned (its release.json is not MORALMOD_RELEASE_SHA256)";
const STALE = "a managed loader on disk is not MORALMOD_RELEASE_SHA256's release; managed loader removed";
const STALE_LINE = `  warning: index-network plugin: not enabled, MoralMod release not pinned (${STALE}); removed from plugins.enabled`;

// The pinned plugin checkout, as moralmod_morning.test.ts finds it (CI: AV_INDEX_PLUGIN_TEST_DIR).
const pluginRepo = resolve(process.env.AV_INDEX_PLUGIN_TEST_DIR ?? resolve(import.meta.dir, "../../../index-hermes-plugin"));
const havePlugin =
  existsSync(pluginRepo) && Bun.spawnSync(["git", "cat-file", "-e", `${INDEX_PLUGIN_REVISION}^{commit}`], { cwd: pluginRepo }).exitCode === 0;

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

let home: string;
let outside: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-mm-arm-"));
  outside = mkdtempSync(join(tmpdir(), "av-mm-supply-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HERMES_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/**
 * A self-consistent release (every file matches its own release.json) and a valid 0600 resident
 * config, both handed to the installer as an operator would; returns the release.json's sha256.
 */
function supplyRelease(): string {
  const source = join(outside, "release");
  mkdirSync(source, { recursive: true });
  const content = {
    "negotiator-core.js": "export const hookVersion='moralmod-lifecycle-2';",
    "negotiator-runtime.js": "export async function startResident(){return {port:1,stop(){}}}",
    "INDEX-LICENSE": "fixture MIT license",
  };
  for (const [name, value] of Object.entries(content)) writeFileSync(join(source, name), value);
  const manifest = {
    schema: "moralmod-negotiator-release-1",
    hook_version: MORALMOD_HOOK_VERSION,
    hermes_plugin_revision: INDEX_PLUGIN_REVISION,
    bun_version: "1.4.2",
    files: Object.fromEntries(Object.entries(content).map(([name, value]) => [name, sha256(value)])),
  };
  writeFileSync(join(source, "release.json"), JSON.stringify(manifest));
  const config = join(outside, "resident.json");
  writeFileSync(
    config,
    JSON.stringify({
      DECISION_SERVICE_URL: "http://127.0.0.1:1",
      DECISION_EXPERIMENT_ID: "00000000-0000-4000-8000-000000000000",
      DECISION_INPUT_KIND: "synthetic",
      DECISION_RUNTIME_REVISION: "release-1",
      VILLAGE_CONTROL_PLANE_URL: "http://127.0.0.1:2",
      VILLAGE_SUBJECT_REF: "mm_" + "a".repeat(32),
      VILLAGE_INSTALLATION_CREDENTIAL: "r".repeat(32),
    }),
    { mode: 0o600 },
  );
  process.env.MORALMOD_RELEASE_DIR = source;
  process.env.MORALMOD_RESIDENT_CONFIG = config;
  return sha256(readFileSync(join(source, "release.json")));
}

function setArm(where: "env" | "dotenv" | "unset", value = ""): void {
  if (where === "env") process.env[MORALMOD_ARM_ENV] = value;
  if (where === "dotenv") writeFileSync(join(home, ".env"), `${MORALMOD_ARM_ENV}=${value}\n`);
}

type Job = { id: string; name: string; script?: string };
function cronJobs(): Job[] {
  const path = join(home, "cron", "jobs.json");
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).jobs : [];
}
function writeJobs(jobs: Job[]): void {
  mkdirSync(join(home, "cron"), { recursive: true });
  writeFileSync(join(home, "cron", "jobs.json"), JSON.stringify({ jobs }, null, 2));
}
const launcher = () => join(home, "scripts", MORNING_LAUNCHER);
/** The plugin's `Index morning` job and launcher as the plugin creates them, beside a job that is not it. */
function plantMorningJob(): void {
  mkdirSync(join(home, "scripts"), { recursive: true });
  writeFileSync(launcher(), "import runpy\n");
  writeJobs([
    { id: "aaaaaaaaaaaa", name: MORNING_JOB, script: launcher() },
    { id: "bbbbbbbbbbbb", name: "Edge — morning brief", script: "index-digest-send.py" },
  ]);
}

/** A runner that records each argv; `plugins install` clones the pinned checkout (when present), `cron remove` edits jobs.json. */
function recorder() {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === "plugins" && args[1] === "install") {
      const dest = join(home, "plugins", INDEX_PLUGIN);
      mkdirSync(join(home, "plugins"), { recursive: true });
      if (Bun.spawnSync(["git", "clone", "--quiet", pluginRepo, dest]).exitCode !== 0) throw new Error("clone failed");
      if (Bun.spawnSync(["git", "checkout", "--quiet", INDEX_PLUGIN_REVISION], { cwd: dest }).exitCode !== 0) throw new Error("checkout failed");
      writeFileSync(installMetadataPath(home), JSON.stringify({ [INDEX_PLUGIN]: { pinned: true, revision: INDEX_PLUGIN_REF, source: "https://github.com/indexnetwork/hermes-plugin.git" } }));
    }
    if (args[0] === "cron" && args[1] === "remove") writeJobs(cronJobs().filter((job) => job.id !== args[2]));
  };
  return { calls, run };
}

function step(run: (args: string[]) => void, gate = true, pin?: string, argv = ARGV) {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    return { ...(pin === undefined ? installIndexPlugin(run, argv, gate) : installIndexPlugin(run, argv, gate, pin)), lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

function configText(): string {
  return existsSync(join(home, "config.yaml")) ? readFileSync(join(home, "config.yaml"), "utf8") : "";
}
function enabled(): string[] {
  return ((YAML.parse(configText()) ?? {}).plugins ?? {}).enabled ?? [];
}
function listPlugin(): void {
  writeFileSync(join(home, "config.yaml"), `${BASE}    - ${INDEX_PLUGIN}\n`);
}

/** Every file a managed ON install leaves, byte for byte, so a later OFF run can be shown to leave them. */
function snapshot(paths: string[]): Record<string, string | null> {
  return Object.fromEntries(paths.map((p) => [p, existsSync(p) ? readFileSync(p, "utf8") : null]));
}

const ARMS: [string, "env" | "dotenv" | "unset", string][] = [
  ["unset", "unset", ""],
  ["env off", "env", "off"],
  [".env off", "dotenv", "off"],
  [".env blank", "dotenv", ""],
  ["env yes (not on)", "env", "yes"],
];

describe("rewire paths are read from the box .env first", () => {
  test.skipIf(!havePlugin)("persisted paths activate even when the shell paths are stale", () => {
    const pin = supplyRelease();
    writeFileSync(join(home, ".env"), `${MORALMOD_ARM_ENV}=on\nMORALMOD_RELEASE_DIR=${process.env.MORALMOD_RELEASE_DIR}\nMORALMOD_RESIDENT_CONFIG=${process.env.MORALMOD_RESIDENT_CONFIG}\n`);
    process.env.MORALMOD_RELEASE_DIR = "/missing-old-release";
    process.env.MORALMOD_RESIDENT_CONFIG = "/missing-old-resident.json";
    const { run } = recorder();
    expect(step(run, true, pin)).toMatchObject({ state: "installed", failed: null });
    expect(JSON.parse(readFileSync(join(home, "index/moralmod/active.json"), "utf8")).release_digest).toBe(pin);
  });

  test("an explicitly blank persisted path does not fall back to a stale shell value", () => {
    const pin = supplyRelease();
    writeFileSync(join(home, ".env"), `${MORALMOD_ARM_ENV}=on\nMORALMOD_RELEASE_DIR=\nMORALMOD_RESIDENT_CONFIG=${process.env.MORALMOD_RESIDENT_CONFIG}\n`);
    const { run, calls } = recorder();
    expect(step(run, true, pin)).toMatchObject({ state: "failed" });
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "index/moralmod/active.json"))).toBe(false);
  });
});

describe("M1: arm off or unset with MoralMod files present is OFF", () => {
  for (const [label, where, value] of ARMS) {
    for (const gate of [true, false]) {
      test(`${label}, gate ${gate ? "verified" : "not verified"}, release (pinned as itself) and resident config supplied: no Hermes call, not enabled, nothing seeded or activated, the line and the note say why`, () => {
        writeFileSync(join(home, "config.yaml"), BASE);
        const pin = supplyRelease();
        setArm(where, value);
        const { calls, run } = recorder();
        const result = step(run, gate, pin);
        expect(result).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
        expect(calls).toEqual([]);
        expect(enabled()).toEqual(["av-events"]);
        expect(configText()).toBe(BASE);
        expect(existsSync(negotiatorPath(home))).toBe(false);
        expect(existsSync(join(home, "index", "moralmod"))).toBe(false);
        expect(existsSync(join(home, "plugins", INDEX_PLUGIN))).toBe(false);
        expect(result.lines).toEqual([OFF_LINE]);
      });
    }
  }

  test("only one of MORALMOD_RELEASE_DIR / MORALMOD_RESIDENT_CONFIG, or only index/moralmod/active.json, arm unset: OFF with the note", () => {
    const pin = supplyRelease();
    const source = process.env.MORALMOD_RELEASE_DIR!;
    const config = process.env.MORALMOD_RESIDENT_CONFIG!;
    for (const [release, resident] of [[source, undefined], [undefined, config]] as const) {
      if (release) process.env.MORALMOD_RELEASE_DIR = release;
      else delete process.env.MORALMOD_RELEASE_DIR;
      if (resident) process.env.MORALMOD_RESIDENT_CONFIG = resident;
      else delete process.env.MORALMOD_RESIDENT_CONFIG;
      const { calls, run } = recorder();
      expect(step(run, true, pin)).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
      expect(calls).toEqual([]);
    }
    delete process.env.MORALMOD_RELEASE_DIR;
    delete process.env.MORALMOD_RESIDENT_CONFIG;
    mkdirSync(join(home, "index", "moralmod"), { recursive: true });
    writeFileSync(join(home, "index", "moralmod", "active.json"), "{}\n");
    const { calls, run } = recorder();
    expect(step(run, true, pin)).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
    expect(calls).toEqual([]);
  });

  test("no MoralMod files, arm unset: OFF as before, no note and the old line", () => {
    const { calls, run } = recorder();
    const result = step(run);
    expect(result).toEqual({ state: "off", failed: null, lines: [`→ index-network plugin: off (${MORALMOD_ARM_ENV} is not on)`] });
    expect(calls).toEqual([]);
  });

  test("a box an earlier managed ON run left (plugin listed, morning job, active.json, loader) flipped to off or unset: dropped from plugins.enabled, the job removed with cron remove and its launcher deleted, the managed loader taken out of negotiator.js (ov#277 refute S2); plugin.yaml, morning.py, active.json and the seed are left byte for byte", () => {
    for (const [label, where, value] of [ARMS[0]!, ARMS[1]!]) {
      rmSync(join(home, ".env"), { force: true });
      delete process.env[MORALMOD_ARM_ENV];
      const pin = supplyRelease();
      listPlugin();
      plantMorningJob();
      const plugin = join(home, "plugins", INDEX_PLUGIN);
      mkdirSync(join(plugin, "runtime", "dist"), { recursive: true });
      writeFileSync(join(plugin, "plugin.yaml"), `name: ${INDEX_PLUGIN}\n`);
      writeFileSync(join(plugin, "runtime", "dist", "negotiator.js"), "// Managed MoralMod lifecycle 2; loader\n");
      writeFileSync(join(plugin, "morning.py"), 'SCHEDULE = "*/5 * * * *"\n');
      mkdirSync(join(home, "index", "moralmod"), { recursive: true });
      writeFileSync(join(home, "index", "moralmod", "active.json"), JSON.stringify({ release_digest: pin }) + "\n");
      writeFileSync(negotiatorPath(home), "// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n");
      const kept = snapshot([
        join(plugin, "plugin.yaml"),
        join(plugin, "morning.py"),
        join(home, "index", "moralmod", "active.json"),
        negotiatorPath(home),
      ]);
      setArm(where, value);
      const { calls, run } = recorder();
      const result = step(run, true, pin);
      expect([label, result.state, result.failed, result.note]).toEqual([label, "off", null, "moralmod_arm_not_on"]);
      expect([label, calls]).toEqual([label, [["cron", "remove", "aaaaaaaaaaaa"]]]);
      expect([label, enabled()]).toEqual([label, ["av-events"]]);
      expect(cronJobs().map((job) => job.id)).toEqual(["bbbbbbbbbbbb"]);
      expect(existsSync(launcher())).toBe(false);
      expect(snapshot(Object.keys(kept))).toEqual(kept);
      // No pinned checkout under this stand-in tree to put the plugin's own file back from: deleted.
      expect(existsSync(join(plugin, "runtime", "dist", "negotiator.js"))).toBe(false);
      expect(result.lines[0]).toBe(`${OFF_LINE}; managed loader removed; removed from plugins.enabled`);
    }
  });

  test("ON still takes the managed path: a missing resident config with the release supplied is withheld as before (sidecar), not OFF", () => {
    supplyRelease();
    delete process.env.MORALMOD_RESIDENT_CONFIG;
    process.env[MORALMOD_ARM_ENV] = "on";
    const { calls, run } = recorder();
    expect(step(run)).toMatchObject({ state: "failed", failed: "sidecar" });
    expect(calls).toEqual([]);
  });
});

describe("M2: the release must be the one pinned in MORALMOD_RELEASE_SHA256", () => {
  test("ON, gate verified, a self-consistent fixture differs from the shipped pin: withheld as release_unpinned before any Hermes call; an earlier listing and the morning job are removed; nothing is installed or seeded", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const fixturePin = supplyRelease();
    listPlugin();
    plantMorningJob();
    expect(MORALMOD_RELEASE_SHA256).not.toBe(fixturePin);
    const { calls, run } = recorder();
    const result = step(run);
    expect(result).toMatchObject({ state: "failed", failed: "release_unpinned" });
    expect(result.note).toBeUndefined();
    expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
    expect(enabled()).toEqual(["av-events"]);
    expect(existsSync(launcher())).toBe(false);
    expect(existsSync(join(home, "index", "moralmod"))).toBe(false);
    expect(existsSync(negotiatorPath(home))).toBe(false);
    expect(existsSync(join(home, "plugins", INDEX_PLUGIN))).toBe(false);
    expect(result.lines).toContain(`${UNPINNED_LINE}; removed from plugins.enabled`);
    expect(indexPluginFailedLine(result.failed!)).toBe("agentvillage-install: index_plugin_failed=release_unpinned");
  });

  test("ON with the plugin already at REF: a sha256 pin that is not this release.json's leaves its negotiator.js, morning.py and sidecar.py byte for byte", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const pin = supplyRelease();
    const plugin = join(home, "plugins", INDEX_PLUGIN);
    mkdirSync(join(plugin, "runtime", "dist"), { recursive: true });
    writeFileSync(join(plugin, "plugin.yaml"), `name: ${INDEX_PLUGIN}\n`);
    writeFileSync(join(plugin, "runtime", "dist", "negotiator.js"), "// upstream negotiator\n");
    writeFileSync(join(plugin, "morning.py"), 'SCHEDULE = "0 8 * * *"\n');
    writeFileSync(join(plugin, "sidecar.py"), "# upstream sidecar\n");
    writeFileSync(installMetadataPath(home), JSON.stringify({ [INDEX_PLUGIN]: { pinned: true, revision: INDEX_PLUGIN_REF } }));
    mkdirSync(join(home, "index"), { recursive: true });
    writeFileSync(negotiatorPath(home), NEGOTIATOR_SEED);
    listPlugin();
    const kept = snapshot([join(plugin, "runtime", "dist", "negotiator.js"), join(plugin, "morning.py"), join(plugin, "sidecar.py"), negotiatorPath(home)]);
    const other = pin.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    const { calls, run } = recorder();
    expect(step(run, true, other)).toMatchObject({ state: "failed", failed: "release_unpinned" });
    expect(calls).toEqual([]);
    expect(enabled()).toEqual(["av-events"]);
    expect(snapshot(Object.keys(kept))).toEqual(kept);
    expect(existsSync(join(home, "index", "moralmod"))).toBe(false);
  });

  test("the status file carries release_unpinned, and the OFF note beside a null failure", () => {
    writeInstallStatus(home, []);
    expect(recordIndexPluginStatus(home, "release_unpinned")).toBe(true);
    const status = JSON.parse(readFileSync(installStatusPath(home), "utf8"));
    expect(status.index_plugin_failed).toBe("release_unpinned");
    expect("index_plugin_note" in status).toBe(false);
    writeInstallStatus(home, []);
    expect(recordIndexPluginStatus(home, null, "moralmod_arm_not_on")).toBe(true);
    expect(JSON.parse(readFileSync(installStatusPath(home), "utf8"))).toMatchObject({ index_plugin_failed: null, index_plugin_note: "moralmod_arm_not_on" });
  });

  test.skipIf(!havePlugin)(
    "the pin computed from the fixture activates for ON (loader imports that digest's runtime, active.json names it, morning.py patched, enabled); a moved pin then withholds it; a flip to OFF puts the plugin's own negotiator.js back and drops the plugin",
    () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      const { calls, run } = recorder();
      const on = step(run, true, pin);
      expect(on).toMatchObject({ state: "installed", failed: null });
      expect(calls).toEqual([FRESH]);
      const plugin = join(home, "plugins", INDEX_PLUGIN);
      const runtime = join(plugin, "runtime", "dist", "negotiator.js");
      expect(readFileSync(runtime, "utf8")).toContain(`import {startResident} from ${JSON.stringify(join(home, "index", "moralmod", pin, "negotiator-runtime.js"))}`);
      expect(JSON.parse(readFileSync(join(home, "index", "moralmod", "active.json"), "utf8"))).toMatchObject({ release_digest: pin, plugin_revision: INDEX_PLUGIN_REVISION });
      const upstreamMorning = Bun.spawnSync(["git", "show", "HEAD:morning.py"], { cwd: plugin }).stdout.toString();
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(morningSource(upstreamMorning));
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);

      // The pin moves (a reviewed PR) while the box is still handed the old bundle: withheld, and the
      // old release's loader taken out, the plugin's own negotiator.js put back (ov#277 refute S1).
      const upstream = Bun.spawnSync(["git", "show", "HEAD:runtime/dist/negotiator.js"], { cwd: plugin }).stdout.toString();
      const kept = snapshot([join(plugin, "morning.py")]);
      const moved = recorder();
      const movedResult = step(moved.run, true, "f".repeat(64));
      expect(movedResult).toMatchObject({ state: "failed", failed: "release_unpinned" });
      expect(moved.calls).toEqual([]);
      expect(enabled()).toEqual(["av-events"]);
      expect(snapshot(Object.keys(kept))).toEqual(kept);
      expect(readFileSync(runtime, "utf8")).toBe(upstream);
      expect(movedResult.lines).toContain("  warning: index-network plugin: a managed loader on disk is not MORALMOD_RELEASE_SHA256's release; managed loader replaced by the plugin's own negotiator.js");

      // Back on the pin: activated again over the plugin's own file (active.json still names the old loader).
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      const loader = readFileSync(runtime, "utf8");
      expect(loader).toBe(managedLoaderSource(home, join(home, "index", "moralmod", pin)));

      // The arm flips off: on this first OFF run, OFF, the note, the plugin's own negotiator.js put
      // back (ov#277 refute S2); morning.py and active.json kept.
      process.env[MORALMOD_ARM_ENV] = "off";
      const off = recorder();
      const offResult = step(off.run, true, pin);
      expect(offResult).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
      expect(off.calls).toEqual([]);
      expect(enabled()).toEqual(["av-events"]);
      expect(snapshot(Object.keys(kept))).toEqual(kept);
      expect(readFileSync(runtime, "utf8")).toBe(upstream);
      expect(existsSync(join(home, "index", "moralmod", "active.json"))).toBe(true);
      expect(offResult.lines[0]).toBe(`${OFF_LINE}; managed loader replaced by the plugin's own negotiator.js; removed from plugins.enabled`);

      // Flipped back on: activated again.
      process.env[MORALMOD_ARM_ENV] = "on";
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(readFileSync(runtime, "utf8")).toBe(loader);
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    },
    60_000,
  );
});

describe("ov#282 M1: a plugin reinstall on an activated box keeps the receipt valid", () => {
  test.skipIf(!havePlugin)(
    "activated, then Hermes puts the plugin's own negotiator.js back (a --force reinstall in the run, or a fresh tree between runs): the next keyed ON run activates again over it; a customized negotiator.js with the receipt is still refused and left as it is",
    () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const plugin = join(home, "plugins", INDEX_PLUGIN);
      const runtime = join(plugin, "runtime", "dist", "negotiator.js");
      const state = join(home, "index", "moralmod", "active.json");
      const loader = managedLoaderSource(home, join(home, "index", "moralmod", pin));
      expect(readFileSync(runtime, "utf8")).toBe(loader);
      const upstream = Bun.spawnSync(["git", "show", "HEAD:runtime/dist/negotiator.js"], { cwd: plugin }).stdout.toString();
      expect(upstream).not.toBe(loader);

      // A reinstall inside the run (no Hermes record at the ref, so the step calls `plugins install`,
      // which replaces the tree as --force does): the receipt names the loader, the file is upstream again.
      rmSync(installMetadataPath(home));
      const reinstall = recorder();
      const forced = (args: string[]) => {
        if (args[0] === "plugins" && args[1] === "install") rmSync(plugin, { recursive: true, force: true });
        reinstall.run(args);
      };
      expect(step(forced, true, pin)).toMatchObject({ state: "installed", failed: null });
      expect(reinstall.calls).toEqual([["plugins", "install", INDEX_PLUGIN_SOURCE, "--force", "--ref", INDEX_PLUGIN_REF, "--no-enable"]]);
      expect(readFileSync(runtime, "utf8")).toBe(loader);
      expect(JSON.parse(readFileSync(state, "utf8"))).toMatchObject({ release_digest: pin, entry_sha256: sha256(loader) });
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);

      // A fresh tree between runs (refute probe P2): the plugin's own file is back, no Hermes call.
      expect(Bun.spawnSync(["git", "checkout", "--", "runtime/dist/negotiator.js"], { cwd: plugin }).exitCode).toBe(0);
      expect(readFileSync(runtime, "utf8")).toBe(upstream);
      const fresh = recorder();
      expect(step(fresh.run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(fresh.calls).toEqual([]);
      expect(readFileSync(runtime, "utf8")).toBe(loader);
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);

      // Never a customized file: neither the receipt's loader nor the plugin's own bytes. Refused,
      // not enabled, and the file left byte for byte.
      const custom = upstream + "\n// a resident's own change\n";
      writeFileSync(runtime, custom);
      const refused = step(recorder().run, true, pin);
      expect(refused).toMatchObject({ state: "failed", failed: "sidecar" });
      expect(enabled()).toEqual(["av-events"]);
      expect(readFileSync(runtime, "utf8")).toBe(custom);
    },
    60_000,
  );
});

describe("ov#277 refute S1: a managed loader on disk is held to the pin on every ON run", () => {
  const plugin = () => join(home, "plugins", INDEX_PLUGIN);
  const loaderPath = () => join(plugin(), "runtime", "dist", "negotiator.js");
  const moralmod = () => join(home, "index", "moralmod");
  const SKIP = [...ARGV, "--skip-index"];
  const KEYLESS = ["bun", "install.ts"];

  /**
   * What an earlier managed ON run left (probe P3): the plugin at REF (stand-in tree, sidecar.py
   * already allowlisted) and listed, its morning job, the loader for `digest`'s release in
   * negotiator.js, active.json naming it, the managed seed.
   */
  function plantManagedBox(digest: string): void {
    mkdirSync(join(plugin(), "runtime", "dist"), { recursive: true });
    writeFileSync(join(plugin(), "plugin.yaml"), `name: ${INDEX_PLUGIN}\n`);
    writeFileSync(join(plugin(), "sidecar.py"), `import os\n${SIDECAR_PATCHED}`);
    writeFileSync(installMetadataPath(home), JSON.stringify({ [INDEX_PLUGIN]: { pinned: true, revision: INDEX_PLUGIN_REF } }));
    writeFileSync(loaderPath(), managedLoaderSource(home, join(moralmod(), digest)));
    mkdirSync(moralmod(), { recursive: true });
    writeFileSync(join(moralmod(), "active.json"), JSON.stringify({ release_digest: digest }) + "\n");
    writeFileSync(negotiatorPath(home), "// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n");
    listPlugin();
    plantMorningJob();
  }
  const keptFiles = () => [join(plugin(), "plugin.yaml"), join(plugin(), "sidecar.py"), negotiatorPath(home)];

  for (const [label, argv] of [["--skip-index (P3)", SKIP], ["no Index key (P3b)", KEYLESS]] as const) {
    test(`${label}: arm ON, gate verified, sentinel pin, MORALMOD_* at an unpinned bundle, the loader and active.json for release deadbeef on disk: withheld as release_unpinned, dropped from plugins.enabled, the morning job removed, the loader taken out; active.json, the seed and the tree left; no plugin call`, () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      supplyRelease();
      plantManagedBox("deadbeef");
      const kept = snapshot([...keptFiles(), join(moralmod(), "active.json")]);
      const { calls, run } = recorder();
      const result = step(run, true, undefined, [...argv]);
      expect(result).toMatchObject({ state: "failed", failed: "release_unpinned" });
      expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
      expect(enabled()).toEqual(["av-events"]);
      expect(existsSync(launcher())).toBe(false);
      expect(existsSync(loaderPath())).toBe(false);
      expect(snapshot(Object.keys(kept))).toEqual(kept);
      expect(readdirSync(moralmod())).toEqual(["active.json"]);
      expect(result.lines[0]).toBe(STALE_LINE);
      // The next such run finds no loader: skipped, nothing listed again.
      const again = step(recorder().run, true, undefined, [...argv]);
      expect(again).toMatchObject({ state: "skipped", failed: null });
      expect(enabled()).toEqual(["av-events"]);
    });
  }

  test("keyed, active.json deleted and MORALMOD_* unset, the plugin at REF (the pinnedAtRef path, P3c): withheld as release_unpinned before any plugin call, not enabled, the loader taken out", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    plantManagedBox("deadbeef");
    rmSync(join(moralmod(), "active.json"));
    const kept = snapshot(keptFiles());
    const { calls, run } = recorder();
    const result = step(run);
    expect(result).toMatchObject({ state: "failed", failed: "release_unpinned" });
    expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
    expect(enabled()).toEqual(["av-events"]);
    expect(existsSync(loaderPath())).toBe(false);
    expect(snapshot(Object.keys(kept))).toEqual(kept);
    expect(result.lines[0]).toBe(STALE_LINE);
  });

  test("keyed with MORALMOD_* at an unpinned bundle and active.json present (the managed path): the loader is taken out too, then the bundle is refused as before", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    supplyRelease();
    plantManagedBox("deadbeef");
    const { calls, run } = recorder();
    const result = step(run);
    expect(result).toMatchObject({ state: "failed", failed: "release_unpinned" });
    expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
    expect(enabled()).toEqual(["av-events"]);
    expect(existsSync(loaderPath())).toBe(false);
    expect(result.lines.slice(0, 2)).toEqual([`  warning: index-network plugin: ${STALE}`, `${UNPINNED_LINE}; removed from plugins.enabled`]);
  });

  test("the pinned release's own loader, the release intact on disk: kept and still enabled on a --skip-index and a keyless run; a moved pin, a changed bundle file or a changed loader withholds it", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const pin = supplyRelease();
    installMoralmodRelease(home, process.env.MORALMOD_RELEASE_DIR!, pin);
    for (const argv of [SKIP, KEYLESS]) {
      plantManagedBox(pin);
      const loader = readFileSync(loaderPath(), "utf8");
      const { calls, run } = recorder();
      expect(step(run, true, pin, argv)).toMatchObject({ state: "skipped", failed: null });
      expect(calls).toEqual([]);
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      expect(readFileSync(loaderPath(), "utf8")).toBe(loader);
    }
    const runtimeFile = join(moralmod(), pin, "negotiator-runtime.js");
    const original = readFileSync(runtimeFile, "utf8");
    const changes: [string, () => string][] = [
      ["moved pin", () => "f".repeat(64)],
      ["changed bundle file", () => (writeFileSync(runtimeFile, original + "\n// changed\n"), pin)],
      ["changed loader", () => (writeFileSync(runtimeFile, original), writeFileSync(loaderPath(), readFileSync(loaderPath(), "utf8") + "import './elsewhere.js';\n"), pin)],
    ];
    for (const [label, change] of changes) {
      plantManagedBox(pin);
      const used = change();
      const { run } = recorder();
      const result = step(run, true, used, SKIP);
      expect([label, result.state, result.failed]).toEqual([label, "failed", "release_unpinned"]);
      expect([label, enabled()]).toEqual([label, ["av-events"]]);
      expect([label, existsSync(loaderPath())]).toEqual([label, false]);
    }
  });

  test("S2: an ON-to-OFF flip (the arm line in .env goes to off) takes the OFF path on the first install after it: dropped from plugins.enabled, the morning job removed, the loader taken out; active.json, the release and the resident config stay; a second OFF run changes nothing", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const pin = supplyRelease();
    installMoralmodRelease(home, process.env.MORALMOD_RELEASE_DIR!, pin);
    plantManagedBox(pin);
    expect(step(recorder().run, true, pin, SKIP)).toMatchObject({ state: "skipped", failed: null });
    expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    const kept = snapshot([
      ...keptFiles(),
      join(moralmod(), "active.json"),
      join(moralmod(), pin, "release.json"),
      join(moralmod(), pin, "negotiator-runtime.js"),
      process.env.MORALMOD_RESIDENT_CONFIG!,
    ]);
    // The control plane's rewire writes the arm to .env, which wins over the install environment.
    setArm("dotenv", "off");
    for (const argv of [ARGV, SKIP]) {
      const { calls, run } = recorder();
      const result = step(run, true, pin, argv);
      expect(result).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
      expect(enabled()).toEqual(["av-events"]);
      expect(existsSync(loaderPath())).toBe(false);
      expect(snapshot(Object.keys(kept))).toEqual(kept);
      if (argv === ARGV) {
        expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
        expect(existsSync(launcher())).toBe(false);
        expect(result.lines[0]).toBe(`${OFF_LINE}; managed loader removed; removed from plugins.enabled`);
      } else {
        expect(calls).toEqual([]);
        expect(result.lines).toEqual([OFF_LINE]);
      }
    }
  });

  test("S2: OFF with only a loader on disk (no active.json, no MORALMOD_*): the loader is taken out and the note says MoralMod files were present", () => {
    plantManagedBox("deadbeef");
    rmSync(join(moralmod(), "active.json"));
    setArm("env", "off");
    const result = step(recorder().run);
    expect(result).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
    expect(existsSync(loaderPath())).toBe(false);
    expect(enabled()).toEqual(["av-events"]);
    expect(result.lines[0]).toBe(`${OFF_LINE}; managed loader removed; removed from plugins.enabled`);
  });

  test("an ON box with no loader (the plugin's own negotiator.js) is not touched by the check", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    plantManagedBox("deadbeef");
    writeFileSync(loaderPath(), "// upstream negotiator\n");
    rmSync(join(moralmod(), "active.json"));
    writeFileSync(negotiatorPath(home), NEGOTIATOR_SEED);
    const { calls, run } = recorder();
    expect(step(run, true, undefined, SKIP)).toMatchObject({ state: "skipped", failed: null });
    expect(calls).toEqual([]);
    expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    expect(readFileSync(loaderPath(), "utf8")).toBe("// upstream negotiator\n");
  });
});
