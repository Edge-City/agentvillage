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
 *
 * ov#284 refute M1: OFF removes every managed asset (resident.json, the loader, the marker hook, the
 * managed morning.py, active.json, the release) and finishes a half-done removal. M2: taking the
 * loader out takes the marker and the managed morning.py with it, and a marker left without its
 * loader is taken out by the next ON run, so the plugin's own negotiator.js never runs beside it.
 * S1: an active.json naming another release withholds every ON run not handed a release.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";

import {
  INDEX_PLUGIN,
  INDEX_PLUGIN_REF,
  INDEX_PLUGIN_SOURCE,
  MORALMOD_ARM_ENV,
  MORNING_JOB,
  MORNING_LAUNCHER,
  NEGOTIATOR_SEED,
  SIDECAR_ANCHOR,
  SIDECAR_PATCHED,
  SIDECAR_PATCHED_V1,
  indexPluginFailedLine,
  installIndexPlugin,
  installMetadataPath,
  negotiatorPath,
  patchSidecarSource,
  recordIndexPluginStatus,
} from "../install_index_plugin";
import { managedLoaderSource, managedRuntimeReplaceable } from "../moralmod_host";
import { morningSource } from "../moralmod_morning";
import { INDEX_PLUGIN_REVISION, MORALMOD_HOOK_VERSION, MORALMOD_RELEASE_SHA256, installMoralmodRelease } from "../moralmod_release";
import { installStatusPath, writeInstallStatus } from "../install_status";

const ENV_KEYS = ["HERMES_HOME", "INDEX_API_KEY", MORALMOD_ARM_ENV, "MORALMOD_RELEASE_DIR", "MORALMOD_RESIDENT_CONFIG"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const ARGV = ["bun", "install.ts", "--index-api-key", "ix_arm_pin_test"];
const FRESH = ["plugins", "install", INDEX_PLUGIN_SOURCE, "--ref", INDEX_PLUGIN_REF, "--no-enable"];
const FORCED = ["plugins", "install", INDEX_PLUGIN_SOURCE, "--force", "--ref", INDEX_PLUGIN_REF, "--no-enable"];
const BASE = "plugins:\n  enabled:\n    - av-events\n";
const OFF_LINE = `→ index-network plugin: off (${MORALMOD_ARM_ENV} is not on); MoralMod release or resident config present, not activated: the managed negotiator runs only for ON`;
const UNPINNED_LINE = "  warning: index-network plugin: not enabled, MoralMod release not pinned (its release.json is not MORALMOD_RELEASE_SHA256)";
const STALE = "a managed loader on disk is not MORALMOD_RELEASE_SHA256's release; managed loader removed; MoralMod files cleaned up: index/negotiator.ts";
const RECEIPT_LINE = "  warning: index-network plugin: not enabled, MoralMod release not pinned (index/moralmod/active.json names a release that is not MORALMOD_RELEASE_SHA256)";
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
function supplyRelease(variant = ""): string {
  const source = join(outside, variant ? `release-${variant}` : "release");
  mkdirSync(source, { recursive: true });
  const content = {
    // A variant is a second, distinct release (another release.json digest), as a new build is.
    "negotiator-core.js": "export const hookVersion='moralmod-lifecycle-2';" + (variant ? `\n// release ${variant}\n` : ""),
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
      if (args.includes("--force")) rmSync(dest, { recursive: true, force: true });
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

  test("a box an earlier managed ON run left (plugin listed, morning job, resident.json, active.json, loader, marker) flipped to off or unset: dropped from plugins.enabled, the job removed with cron remove and its launcher deleted, the managed loader taken out (ov#277 refute S2), resident.json, active.json and the marker removed (ov#284 refute M1); plugin.yaml, a morning.py that is not the managed rewrite, fallback.sqlite and the resident's own files are left byte for byte", () => {
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
      writeFileSync(join(home, "index", "moralmod", "resident.json"), readFileSync(process.env.MORALMOD_RESIDENT_CONFIG!), { mode: 0o600 });
      writeFileSync(join(home, "index", "moralmod", "fallback.sqlite"), "queued evidence\n");
      writeFileSync(join(home, "index", "notes.md"), "the resident's own file\n");
      writeFileSync(negotiatorPath(home), "// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n");
      const kept = snapshot([
        join(plugin, "plugin.yaml"),
        join(plugin, "morning.py"),
        join(home, "index", "moralmod", "fallback.sqlite"),
        join(home, "index", "notes.md"),
        process.env.MORALMOD_RESIDENT_CONFIG!,
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
      expect([label, existsSync(negotiatorPath(home))]).toEqual([label, false]);
      expect([label, readdirSync(join(home, "index", "moralmod"))]).toEqual([label, ["fallback.sqlite"]]);
      expect(result.lines[0]).toBe(`${OFF_LINE}; managed loader removed; MoralMod files cleaned up: resident.json, index/negotiator.ts, active.json; removed from plugins.enabled`);
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
    // The shipped pin is a real digest (not a value that matches no file), and not this fixture's.
    expect(MORALMOD_RELEASE_SHA256).toMatch(/^[0-9a-f]{64}$/);
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
    "the pin computed from the fixture activates for ON (loader imports that digest's runtime, active.json names it, morning.py patched, enabled); a moved pin then withholds it and puts the plugin's own negotiator.js and morning.py back; a flip to OFF leaves no managed file (ov#284 refute M1) and the plugin's own files in place; a flip back ON activates again",
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
      const moralmod = join(home, "index", "moralmod");
      const managedFiles = [join(moralmod, "resident.json"), join(moralmod, "active.json"), join(moralmod, pin), negotiatorPath(home)];
      expect(managedFiles.map(existsSync)).toEqual([true, true, true, true]);
      const moved = recorder();
      const movedResult = step(moved.run, true, "f".repeat(64));
      expect(movedResult).toMatchObject({ state: "failed", failed: "release_unpinned" });
      expect(moved.calls).toEqual([]);
      expect(enabled()).toEqual(["av-events"]);
      // ov#284 refute M2: the marker and the managed morning.py go with the loader.
      expect(readFileSync(runtime, "utf8")).toBe(upstream);
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(upstreamMorning);
      expect(existsSync(negotiatorPath(home))).toBe(false);
      expect(movedResult.lines).toContain("  warning: index-network plugin: a managed loader on disk is not MORALMOD_RELEASE_SHA256's release; managed loader replaced by the plugin's own negotiator.js; MoralMod files cleaned up: index/negotiator.ts, morning.py");

      // Back on the pin: activated again over the plugin's own file (active.json still names the old loader).
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      const loader = readFileSync(runtime, "utf8");
      expect(loader).toBe(managedLoaderSource(home, join(home, "index", "moralmod", pin)));
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(morningSource(upstreamMorning));

      // The arm flips off: on this first OFF run, OFF, the note, and no managed file left (ov#284
      // refute M1): the plugin's own negotiator.js and morning.py back, no marker, no resident.json,
      // no active.json, no release; queued evidence and the resident's own files stay.
      writeFileSync(join(moralmod, "fallback.sqlite"), "queued evidence\n");
      writeFileSync(join(home, "index", "notes.md"), "the resident's own file\n");
      const ownFiles = snapshot([join(moralmod, "fallback.sqlite"), join(home, "index", "notes.md"), process.env.MORALMOD_RESIDENT_CONFIG!]);
      process.env[MORALMOD_ARM_ENV] = "off";
      const off = recorder();
      const offResult = step(off.run, true, pin);
      expect(offResult).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
      expect(off.calls).toEqual([]);
      expect(enabled()).toEqual(["av-events"]);
      expect(readFileSync(runtime, "utf8")).toBe(upstream);
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(upstreamMorning);
      expect(managedFiles.map(existsSync)).toEqual([false, false, false, false]);
      expect(readdirSync(moralmod)).toEqual(["fallback.sqlite"]);
      expect(snapshot(Object.keys(ownFiles))).toEqual(ownFiles);
      // The plugin tree is its pinned checkout again, but for the overlay's own sidecar.py allowlist (A3).
      expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd: plugin }).stdout.toString()).toBe(" M sidecar.py\n");
      expect(offResult.lines[0]).toBe(
        `${OFF_LINE}; managed loader replaced by the plugin's own negotiator.js; MoralMod files cleaned up: resident.json, index/negotiator.ts, morning.py, active.json, release ${pin.slice(0, 8)}; removed from plugins.enabled`,
      );
      // A second OFF run changes nothing.
      const again = step(recorder().run, true, pin);
      expect(again).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
      expect(again.lines).toEqual([OFF_LINE]);
      expect(readdirSync(moralmod)).toEqual(["fallback.sqlite"]);

      // Flipped back on (OFF -> ON): activated again, cleanly, from the MORALMOD_* it is handed.
      process.env[MORALMOD_ARM_ENV] = "on";
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(readFileSync(runtime, "utf8")).toBe(loader);
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      expect(managedFiles.map(existsSync)).toEqual([true, true, true, true]);
      expect(JSON.parse(readFileSync(join(moralmod, "active.json"), "utf8"))).toMatchObject({ release_digest: pin, entry_sha256: sha256(loader) });
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(morningSource(upstreamMorning));
      expect(snapshot(Object.keys(ownFiles))).toEqual(ownFiles);
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

describe("automatic managed reinstalls validate the runtime before replacing the plugin", () => {
  for (const receipt of [true, false]) {
    for (const customization of ["modified upstream", "replacement runtime"] as const) {
      test.skipIf(!havePlugin)(`${customization}, receipt ${receipt}: missing install metadata cannot authorize replacement`, () => {
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        const pin = supplyRelease();
        expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
        const plugin = join(home, "plugins", INDEX_PLUGIN);
        const root = join(home, "index/moralmod");
        const runtime = join(plugin, "runtime/dist/negotiator.js");
        const upstream = Bun.spawnSync(["git", "show", "HEAD:runtime/dist/negotiator.js"], { cwd: plugin }).stdout.toString();
        const customized = customization === "modified upstream"
          ? upstream + "\n// resident customization\n"
          : "export function negotiate() { return 'resident implementation'; }\n";
        expect(customized).not.toContain("Managed MoralMod lifecycle");
        expect(customized).not.toContain("/index/moralmod/");
        writeFileSync(runtime, customized);
        writeFileSync(join(plugin, "resident-notes.txt"), "keep the existing plugin tree\n");
        writeFileSync(join(root, "fallback.sqlite"), "queued research evidence\n");
        rmSync(installMetadataPath(home));
        if (!receipt) rmSync(join(root, "active.json"));
        const { calls, run } = recorder();
        for (let retry = 0; retry < 2; retry++) {
          expect(step(run, true, pin)).toMatchObject({ state: "failed", failed: "sidecar" });
          expect(calls).toEqual([]);
          expect(readFileSync(runtime, "utf8")).toBe(customized);
          expect(readFileSync(join(plugin, "resident-notes.txt"), "utf8")).toBe("keep the existing plugin tree\n");
          expect(readFileSync(join(root, "fallback.sqlite"), "utf8")).toBe("queued research evidence\n");
          expect(enabled()).toEqual(["av-events"]);
          expect(existsSync(installMetadataPath(home))).toBe(false);
        }
      });
    }

    for (const content of ["managed loader", "pinned upstream"] as const) {
      test.skipIf(!havePlugin)(`${content}, receipt ${receipt}: missing install metadata permits a verified reinstall`, () => {
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        const pin = supplyRelease();
        expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
        const plugin = join(home, "plugins", INDEX_PLUGIN);
        const root = join(home, "index/moralmod");
        const runtime = join(plugin, "runtime/dist/negotiator.js");
        if (content === "pinned upstream") {
          expect(Bun.spawnSync(["git", "checkout", "--", "runtime/dist/negotiator.js"], { cwd: plugin }).exitCode).toBe(0);
        }
        rmSync(installMetadataPath(home));
        if (!receipt) rmSync(join(root, "active.json"));
        const { calls, run } = recorder();
        expect(step(run, true, pin)).toMatchObject({ state: "installed", failed: null });
        expect(calls).toEqual([["plugins", "install", INDEX_PLUGIN_SOURCE, "--force", "--ref", INDEX_PLUGIN_REF, "--no-enable"]]);
        expect(readFileSync(runtime, "utf8")).toBe(managedLoaderSource(home, join(root, pin)));
        expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8"))).toMatchObject({ installed: true, entry_sha256: sha256(readFileSync(runtime)) });
        expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      });
    }
  }

  for (const invalid of ["symlink", "directory", "missing checkout"] as const) {
    test.skipIf(!havePlugin)(`${invalid}: existing runtime must be verifiable before a managed reinstall`, () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const plugin = join(home, "plugins", INDEX_PLUGIN);
      const runtime = join(plugin, "runtime/dist/negotiator.js");
      const upstream = Bun.spawnSync(["git", "show", "HEAD:runtime/dist/negotiator.js"], { cwd: plugin }).stdout.toString();
      rmSync(runtime);
      if (invalid === "symlink") {
        writeFileSync(join(outside, "runtime.js"), upstream);
        fs.symlinkSync(join(outside, "runtime.js"), runtime);
      } else if (invalid === "directory") {
        mkdirSync(runtime);
      } else {
        writeFileSync(runtime, upstream);
        rmSync(join(plugin, ".git"), { recursive: true });
      }
      rmSync(installMetadataPath(home));
      const { calls, run } = recorder();
      expect(step(run, true, pin)).toMatchObject({ state: "failed", failed: "sidecar" });
      expect(calls).toEqual([]);
      expect(enabled()).toEqual(["av-events"]);
      if (invalid === "symlink") {
        expect(fs.lstatSync(runtime).isSymbolicLink()).toBe(true);
        expect(readFileSync(join(outside, "runtime.js"), "utf8")).toBe(upstream);
      } else if (invalid === "directory") {
        expect(fs.lstatSync(runtime).isDirectory()).toBe(true);
      } else {
        expect(readFileSync(runtime, "utf8")).toBe(upstream);
        expect(existsSync(join(plugin, ".git"))).toBe(false);
      }
    });
  }
});

describe("automatic managed reinstalls preserve morning and sidecar adapters", () => {
  for (const file of ["morning.py", "sidecar.py"] as const) {
    for (const receipt of [true, false]) {
      for (const metadata of ["present", "missing"] as const) {
        test.skipIf(!havePlugin)(`${file}, receipt ${receipt}, metadata ${metadata}: customized adapter survives repeated retries`, () => {
          process.env[MORALMOD_ARM_ENV] = "on";
          writeFileSync(join(home, "config.yaml"), BASE);
          const pin = supplyRelease();
          expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
          const root = join(home, "index/moralmod"), plugin = join(home, "plugins", INDEX_PLUGIN);
          const path = join(plugin, file), customized = readFileSync(path, "utf8") + "\n# resident customization\n";
          writeFileSync(path, customized);
          writeFileSync(join(root, "fallback.sqlite"), "queued research evidence\n");
          if (!receipt) rmSync(join(root, "active.json"));
          if (metadata === "missing") rmSync(installMetadataPath(home));
          const { calls, run } = recorder();
          for (let retry = 0; retry < 2; retry++) {
            const result = step(run, true, pin);
            if (metadata === "missing" || file === "morning.py")
              expect(result).toMatchObject({ state: "failed", failed: "sidecar" });
            else expect(result).toMatchObject({ state: "pinned", failed: null });
            expect(calls).toEqual([]);
            expect(readFileSync(path, "utf8")).toBe(customized);
            expect(readFileSync(join(root, "fallback.sqlite"), "utf8")).toBe("queued research evidence\n");
            if (metadata === "missing" || file === "morning.py") expect(enabled()).toEqual(["av-events"]);
          }
        });
      }
    }

    test.skipIf(!havePlugin)(`${file}: customization of upstream bytes is preserved before a forced reinstall`, () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const plugin = join(home, "plugins", INDEX_PLUGIN), path = join(plugin, file);
      const upstream = Bun.spawnSync(["git", "show", `HEAD:${file}`], { cwd: plugin }).stdout.toString();
      const customized = upstream + "\n# resident customization\n";
      writeFileSync(path, customized);
      rmSync(installMetadataPath(home));
      const { calls, run } = recorder();
      expect(step(run, true, pin)).toMatchObject({ state: "failed", failed: "sidecar" });
      expect(calls).toEqual([]);
      expect(readFileSync(path, "utf8")).toBe(customized);
    });

    // ov#288 refute M1: a missing adapter has nothing to protect; it is reinstalled (below).
    for (const invalid of ["symlink", "directory"] as const) {
      test.skipIf(!havePlugin)(`${file}, ${invalid}: unverifiable adapter is preserved before reinstall`, () => {
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        const pin = supplyRelease();
        expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
        const path = join(home, "plugins", INDEX_PLUGIN, file), original = readFileSync(path, "utf8");
        rmSync(path);
        if (invalid === "symlink") {
          writeFileSync(join(outside, file), original);
          fs.symlinkSync(join(outside, file), path);
        } else if (invalid === "directory") mkdirSync(path);
        rmSync(installMetadataPath(home));
        const { calls, run } = recorder();
        expect(step(run, true, pin)).toMatchObject({ state: "failed", failed: "sidecar" });
        expect(calls).toEqual([]);
        expect(enabled()).toEqual(["av-events"]);
        if (invalid === "symlink") {
          expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
          expect(readFileSync(join(outside, file), "utf8")).toBe(original);
        } else expect(fs.lstatSync(path).isDirectory()).toBe(true);
      });
    }

    for (const receipt of [true, false]) {
      test.skipIf(!havePlugin)(`${file}, missing, receipt ${receipt}, install record lost: nothing to protect, so run 1 reinstalls (installed) and activates, run 2 is pinned (ov#288 refute M1)`, () => {
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        const pin = supplyRelease();
        expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
        const plugin = join(home, "plugins", INDEX_PLUGIN), root = join(home, "index/moralmod");
        const path = join(plugin, file), managedBytes = readFileSync(path, "utf8");
        rmSync(path);
        rmSync(installMetadataPath(home));
        if (!receipt) rmSync(join(root, "active.json"));
        const first = recorder();
        expect(step(first.run, true, pin)).toMatchObject({ state: "installed", failed: null });
        expect(first.calls).toEqual([FORCED]);
        expect(readFileSync(path, "utf8")).toBe(managedBytes);
        expect(readFileSync(join(plugin, "runtime/dist/negotiator.js"), "utf8")).toBe(managedLoaderSource(home, join(root, pin)));
        expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
        const second = recorder();
        expect(step(second.run, true, pin)).toMatchObject({ state: "pinned", failed: null });
        expect(second.calls).toEqual([]);
      });
    }
  }

  for (const content of ["upstream morning", "upstream sidecar", "v1 sidecar", "v2 sidecar"] as const) {
    test.skipIf(!havePlugin)(`${content}: verified adapter reinstall succeeds without an activation receipt`, () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const plugin = join(home, "plugins", INDEX_PLUGIN), root = join(home, "index/moralmod");
      const file = content === "upstream morning" ? "morning.py" : "sidecar.py";
      const upstream = Bun.spawnSync(["git", "show", `HEAD:${file}`], { cwd: plugin }).stdout.toString();
      const source = content === "v1 sidecar" ? upstream.replace(SIDECAR_ANCHOR, () => SIDECAR_PATCHED_V1)
        : content === "v2 sidecar" ? upstream.replace(SIDECAR_ANCHOR, () => SIDECAR_PATCHED.replace(', "AV_MORALMOD_ARM"', "")) : upstream;
      writeFileSync(join(plugin, file), source);
      rmSync(installMetadataPath(home));
      rmSync(join(root, "active.json"));
      const { calls, run } = recorder();
      expect(step(run, true, pin)).toMatchObject({ state: "installed", failed: null });
      expect(calls).toEqual([["plugins", "install", INDEX_PLUGIN_SOURCE, "--force", "--ref", INDEX_PLUGIN_REF, "--no-enable"]]);
      const baseMorning = Bun.spawnSync(["git", "show", "HEAD:morning.py"], { cwd: plugin }).stdout.toString();
      const baseSidecar = Bun.spawnSync(["git", "show", "HEAD:sidecar.py"], { cwd: plugin }).stdout.toString();
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(morningSource(baseMorning));
      expect(readFileSync(join(plugin, "sidecar.py"), "utf8")).toBe(baseSidecar.replace(SIDECAR_ANCHOR, () => SIDECAR_PATCHED));
      expect(readFileSync(join(plugin, "runtime/dist/negotiator.js"), "utf8")).toBe(managedLoaderSource(home, join(root, pin)));
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    });
  }
});

/**
 * ov#288 refute M1: the checks before a forced reinstall compare each managed file with the box's
 * own checkout (`HEAD`, whatever revision it is at), not with the revision the overlay now pins, and
 * a missing file is reinstalled (there is nothing to protect).
 *
 * The overlay's pins are constants, so a plugin bump is modelled from the box's side: its checkout is
 * at a revision other than `INDEX_PLUGIN_REF` and holds exactly what an overlay pinned at that
 * revision left (the patched sidecar.py; for an activated box the managed morning.py and the loader;
 * Hermes's install record at that revision). The overlay then runs as pinned and is handed a new
 * release, as on the first run after a real bump. Two other revisions: a fixture commit on the pin
 * that rebuilds runtime/dist/negotiator.js and changes morning.py and sidecar.py upstream, and the
 * plugin's real 7f4c3ed5 (upstream's head after the pin; of the managed files only
 * runtime/dist/negotiator.js differs), when the plugin test checkout has it.
 */
const BUMPED = "7f4c3ed5d656f3572ccaa90ab8b4105268fbe866";
const haveBumped = havePlugin && Bun.spawnSync(["git", "cat-file", "-e", `${BUMPED}^{commit}`], { cwd: pluginRepo }).exitCode === 0;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

/** Moves the box's plugin checkout off the pin, as an overlay pinned at the other revision would have left it; returns that revision. */
function moveCheckout(revision: "fixture" | typeof BUMPED, activated: boolean): string {
  const plugin = join(home, "plugins", INDEX_PLUGIN);
  const runtime = join(plugin, "runtime/dist/negotiator.js");
  const loader = activated ? readFileSync(runtime, "utf8") : null;
  git(plugin, "checkout", "--quiet", "--force", INDEX_PLUGIN_REVISION);
  if (revision === "fixture") {
    for (const [file, line] of [["runtime/dist/negotiator.js", "// upstream rebuild"], ["morning.py", "# upstream change"], ["sidecar.py", "# upstream change"]] as const)
      writeFileSync(join(plugin, file), readFileSync(join(plugin, file), "utf8") + `\n${line} after the pin\n`);
    git(plugin, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--quiet", "--no-verify", "-am", "upstream after the pin");
  } else git(plugin, "checkout", "--quiet", revision);
  const head = git(plugin, "rev-parse", "HEAD").trim();
  expect(head).not.toBe(INDEX_PLUGIN_REF);
  const sidecar = patchSidecarSource(git(plugin, "show", "HEAD:sidecar.py"));
  if ("reason" in sidecar) throw new Error(sidecar.reason);
  writeFileSync(join(plugin, "sidecar.py"), sidecar.source);
  if (loader !== null) {
    writeFileSync(join(plugin, "morning.py"), morningSource(git(plugin, "show", "HEAD:morning.py")));
    writeFileSync(runtime, loader);
  }
  writeFileSync(installMetadataPath(home), JSON.stringify({ [INDEX_PLUGIN]: { pinned: true, revision: head, source: "https://github.com/indexnetwork/hermes-plugin.git" } }));
  return head;
}

describe("ov#288 refute M1: a plugin bump reinstalls a managed box, and a missing managed file is reinstalled", () => {
  for (const [label, revision, have] of [["fixture revision", "fixture", havePlugin], ["real revision 7f4c3ed5", BUMPED, haveBumped]] as const) {
    for (const activated of [true, false]) {
      test.skipIf(!have)(`bump from the ${label}, ${activated ? "box activated with release A" : "box provisioned plain, never activated"}: handed release B, run 1 reinstalls at the pin (installed) and activates B, run 2 is pinned`, () => {
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        const plugin = join(home, "plugins", INDEX_PLUGIN), root = join(home, "index/moralmod");
        const runtime = join(plugin, "runtime/dist/negotiator.js");
        if (activated) {
          const pinA = supplyRelease("a");
          expect(step(recorder().run, true, pinA)).toMatchObject({ state: "installed", failed: null });
          writeFileSync(join(root, "fallback.sqlite"), "queued research evidence\n");
        } else {
          expect(step(recorder().run, true)).toMatchObject({ state: "installed", failed: null });
          expect(existsSync(root)).toBe(false);
        }
        expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
        moveCheckout(revision, activated);
        const pinB = supplyRelease("b");
        const first = recorder();
        const result = step(first.run, true, pinB);
        expect([result.state, result.failed, result.lines.filter((l) => l.includes("warning"))]).toEqual(["installed", null, activated ? [expect.stringContaining("a managed loader on disk is not MORALMOD_RELEASE_SHA256's release")] : []]);
        expect(first.calls).toEqual([FORCED]);
        expect(git(plugin, "rev-parse", "HEAD").trim()).toBe(INDEX_PLUGIN_REF);
        expect(readFileSync(runtime, "utf8")).toBe(managedLoaderSource(home, join(root, pinB)));
        expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8"))).toMatchObject({ release_digest: pinB, installed: true, entry_sha256: sha256(readFileSync(runtime)) });
        expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(morningSource(git(plugin, "show", "HEAD:morning.py")));
        expect(readFileSync(join(plugin, "sidecar.py"), "utf8")).toBe(git(plugin, "show", "HEAD:sidecar.py").replace(SIDECAR_ANCHOR, () => SIDECAR_PATCHED));
        expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
        if (activated) expect(readFileSync(join(root, "fallback.sqlite"), "utf8")).toBe("queued research evidence\n");
        const second = recorder();
        expect(step(second.run, true, pinB)).toMatchObject({ state: "pinned", failed: null });
        expect(second.calls).toEqual([]);
        expect(readFileSync(runtime, "utf8")).toBe(managedLoaderSource(home, join(root, pinB)));
        expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      });
    }

    test.skipIf(!have)(`bump from the ${label}: a customized runtime, morning.py or sidecar.py is still kept and the plugin withheld (sidecar), with no Hermes call`, () => {
      for (const file of ["runtime/dist/negotiator.js", "morning.py", "sidecar.py"]) {
        rmSync(join(home, "plugins"), { recursive: true, force: true });
        rmSync(join(home, "index"), { recursive: true, force: true });
        delete process.env.MORALMOD_RELEASE_DIR;
        delete process.env.MORALMOD_RESIDENT_CONFIG;
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        expect(step(recorder().run, true)).toMatchObject({ state: "installed", failed: null });
        moveCheckout(revision, false);
        const path = join(home, "plugins", INDEX_PLUGIN, file);
        const customized = readFileSync(path, "utf8") + "\n// resident customization\n";
        writeFileSync(path, customized);
        const pinB = supplyRelease("b");
        const { calls, run } = recorder();
        expect([file, step(run, true, pinB)]).toMatchObject([file, { state: "failed", failed: "sidecar" }]);
        expect([file, calls]).toEqual([file, []]);
        expect(readFileSync(path, "utf8")).toBe(customized);
        expect(enabled()).toEqual(["av-events"]);
      }
    });
  }

  for (const receipt of [true, false]) {
    test.skipIf(!havePlugin)(`missing runtime, install record lost, receipt ${receipt}: run 1 reinstalls (installed) and activates, run 2 is pinned`, () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const root = join(home, "index/moralmod");
      const runtime = join(home, "plugins", INDEX_PLUGIN, "runtime/dist/negotiator.js");
      rmSync(runtime);
      rmSync(installMetadataPath(home));
      if (!receipt) rmSync(join(root, "active.json"));
      const first = recorder();
      expect(step(first.run, true, pin)).toMatchObject({ state: "installed", failed: null });
      expect(first.calls).toEqual([FORCED]);
      expect(readFileSync(runtime, "utf8")).toBe(managedLoaderSource(home, join(root, pin)));
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      const second = recorder();
      expect(step(second.run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(second.calls).toEqual([]);
    });
  }

  test("managedRuntimeReplaceable: no file, or our exact loader for a release directory of this home, may be replaced; a loader for another home or another directory, a changed loader, unverifiable bytes, a directory or a link may not", () => {
    const runtime = join(home, "plugins", INDEX_PLUGIN, "runtime/dist/negotiator.js");
    mkdirSync(dirname(runtime), { recursive: true });
    expect(managedRuntimeReplaceable(home)).toBe(true);
    const ours = managedLoaderSource(home, join(home, "index/moralmod", "a".repeat(64)));
    writeFileSync(runtime, ours);
    expect(managedRuntimeReplaceable(home)).toBe(true);
    const others: [string, string][] = [
      ["generated for another home", managedLoaderSource(outside, join(outside, "index/moralmod", "a".repeat(64)))],
      ["this home's config, another home's release directory", managedLoaderSource(home, join(outside, "index/moralmod", "a".repeat(64)))],
      ["a directory that is not a release digest", managedLoaderSource(home, join(home, "index/moralmod", "resident-custom-runtime"))],
      ["an uppercase digest", managedLoaderSource(home, join(home, "index/moralmod", "A".repeat(64)))],
      ["changed", ours + "// resident\n"],
      ["no checkout to verify against", "// upstream negotiator\n"],
    ];
    for (const [label, body] of others) {
      writeFileSync(runtime, body);
      expect([label, managedRuntimeReplaceable(home)]).toEqual([label, false]);
    }
    rmSync(runtime);
    writeFileSync(join(outside, "loader.js"), ours);
    fs.symlinkSync(join(outside, "loader.js"), runtime);
    expect(["link", managedRuntimeReplaceable(home)]).toEqual(["link", false]);
    rmSync(runtime);
    mkdirSync(runtime);
    expect(["directory", managedRuntimeReplaceable(home)]).toEqual(["directory", false]);
  });

  // A read-only directory stops a write only for a user other than root.
  test.skipIf(!havePlugin || process.getuid?.() === 0)("a handed run whose retirement of an unpinned loader cannot finish is withheld (sidecar) before any Hermes call, even with the install record lost", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    writeFileSync(join(home, "config.yaml"), BASE);
    const pin = supplyRelease();
    expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
    const dist = join(home, "plugins", INDEX_PLUGIN, "runtime/dist");
    const loader = managedLoaderSource(home, join(home, "index/moralmod", "d".repeat(64)));
    writeFileSync(join(dist, "negotiator.js"), loader);
    rmSync(installMetadataPath(home));
    chmodSync(dist, 0o555);
    try {
      const { calls, run } = recorder();
      expect(step(run, true, pin)).toMatchObject({ state: "failed", failed: "sidecar" });
      expect(calls).toEqual([]);
      expect(readFileSync(join(dist, "negotiator.js"), "utf8")).toBe(loader);
      expect(enabled()).toEqual(["av-events"]);
    } finally {
      chmodSync(dist, 0o755);
    }
  });
});

/**
 * ov#284's take-it-out rule stands (lead ruling, 11 Oct 14:55Z; ov#288 refute M2): a loader with the
 * managed marker that is not the pinned release's exact loader is taken out on every ON run and on
 * OFF, whoever changed it. Its bytes are never run, never kept beside a withheld plugin and never left
 * on an OFF box. The next handed run writes a fresh loader. The resident's own files beside it stay.
 */
describe("ov#284 take-it-out rule: a changed managed loader is taken out on ON retries, reinstalls and OFF, never kept or run; interrupted activation recovers", () => {
  const LOCAL = "export const residentCustomization = true;\n";
  /** The pinned release activated, then its loader changed as `kind` says. */
  function changedLoader(kind: "local runtime import" | "appended code") {
    process.env[MORALMOD_ARM_ENV] = "on";
    writeFileSync(join(home, "config.yaml"), BASE);
    const pin = supplyRelease();
    expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
    const root = join(home, "index/moralmod"), plugin = join(home, "plugins", INDEX_PLUGIN);
    const runtime = join(plugin, "runtime/dist/negotiator.js");
    const local = join(root, "resident-custom-runtime", "negotiator-runtime.js");
    mkdirSync(dirname(local));
    writeFileSync(local, LOCAL);
    const loader = readFileSync(runtime, "utf8");
    const changed = kind === "local runtime import"
      ? loader.replace(JSON.stringify(join(root, pin, "negotiator-runtime.js")), JSON.stringify(local))
      : loader + "\n// resident customization\n";
    expect(changed).not.toBe(loader);
    writeFileSync(runtime, changed);
    writeFileSync(join(root, "fallback.sqlite"), "queued research evidence\n");
    return { pin, root, plugin, runtime, local, changed };
  }

  for (const kind of ["local runtime import", "appended code"] as const) {
    for (const receipt of [true, false]) {
      for (const action of ["ON retry", "ON reinstall", "OFF"] as const) {
        const expected = action === "OFF"
          ? "off with nothing left: the plugin's own negotiator.js put back, the credential, receipt and release removed"
          : action === "ON retry" ? "the loader taken out and the pinned release's loader written (pinned), twice"
          : "the install record lost too: the loader taken out, then a verified reinstall (installed) and activation; run 2 pinned";
        test.skipIf(!havePlugin)(`${kind}, receipt ${receipt}, ${action}: ${expected}; the changed bytes are gone, the resident's own runtime file and queued evidence stay`, () => {
          const { pin, root, plugin, runtime, local, changed } = changedLoader(kind);
          if (!receipt) rmSync(join(root, "active.json"));
          if (action === "ON reinstall") rmSync(installMetadataPath(home));
          if (action === "OFF") process.env[MORALMOD_ARM_ENV] = "off";
          const upstream = git(plugin, "show", "HEAD:runtime/dist/negotiator.js");
          for (const attempt of [1, 2]) {
            const { calls, run } = recorder();
            const result = step(run, true, pin);
            if (action === "OFF") {
              expect([attempt, result.state, result.failed]).toEqual([attempt, "off", null]);
              expect(calls.filter((call) => call[1] === "install")).toEqual([]);
              expect(readFileSync(runtime, "utf8")).toBe(upstream);
              expect(readdirSync(root).sort()).toEqual(["fallback.sqlite", "resident-custom-runtime"]);
              expect(enabled()).toEqual(["av-events"]);
            } else {
              const reinstalled = attempt === 1 && action === "ON reinstall";
              expect([attempt, result.state, result.failed]).toEqual([attempt, reinstalled ? "installed" : "pinned", null]);
              expect(calls).toEqual(reinstalled ? [FORCED] : []);
              expect(readFileSync(runtime, "utf8")).toBe(managedLoaderSource(home, join(root, pin)));
              expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
            }
            expect(readFileSync(runtime, "utf8")).not.toBe(changed);
            expect(readFileSync(local, "utf8")).toBe(LOCAL);
            expect(readFileSync(join(root, "fallback.sqlite"), "utf8")).toBe("queued research evidence\n");
          }
        });
      }
    }
  }

  for (const leaf of ["a".repeat(63), "A".repeat(64), "a".repeat(64) + ".backup"]) {
    test.skipIf(!havePlugin)(`OFF takes out a loader importing ${leaf} and puts the plugin's own negotiator.js back`, () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const plugin = join(home, "plugins", INDEX_PLUGIN), runtime = join(plugin, "runtime/dist/negotiator.js");
      writeFileSync(runtime, readFileSync(runtime, "utf8").replace(pin, leaf));
      process.env[MORALMOD_ARM_ENV] = "off";
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "off", failed: null });
      expect(readFileSync(runtime, "utf8")).toBe(git(plugin, "show", "HEAD:runtime/dist/negotiator.js"));
    });
  }

  test("OFF without a pinned checkout deletes marker-only text and a loader generated for another home (nothing to put back)", () => {
    const runtime = join(home, "plugins", INDEX_PLUGIN, "runtime/dist/negotiator.js");
    mkdirSync(dirname(runtime), { recursive: true });
    for (const changed of ["// Managed MoralMod lifecycle 2; resident code\n", managedLoaderSource(outside, join(outside, "index/moralmod", "a".repeat(64)))]) {
      writeFileSync(runtime, changed);
      expect(step(recorder().run)).toMatchObject({ state: "off", failed: null });
      expect(existsSync(runtime)).toBe(false);
    }
  });

  const rename = fs.renameSync;
  for (const phase of ["before", "after"] as const) {
    for (const target of ["resident.json", "runtime", "hook", "active.json"] as const) {
      test.skipIf(!havePlugin)(`actual installer recovers after interruption ${phase} ${target}`, () => {
        process.env[MORALMOD_ARM_ENV] = "on";
        writeFileSync(join(home, "config.yaml"), BASE);
        const pin = supplyRelease();
        const runtime = join(home, "plugins", INDEX_PLUGIN, "runtime/dist/negotiator.js");
        const root = join(home, "index/moralmod");
        const path = target === "runtime" ? runtime : target === "hook" ? negotiatorPath(home) : join(root, target);
        const interrupted = spyOn(fs, "renameSync").mockImplementation((from, to) => {
          if (String(to) === path && phase === "before") throw Error("controlled activation interruption");
          rename(from, to);
          if (String(to) === path && phase === "after") throw Error("controlled activation interruption");
        });
        try {
          expect(step(recorder().run, true, pin)).toMatchObject({ state: "failed", failed: "sidecar" });
        } finally { interrupted.mockRestore(); }
        const { calls, run } = recorder();
        expect(step(run, true, pin)).toMatchObject({ state: "pinned", failed: null });
        expect(calls).toEqual([]);
        expect(readFileSync(runtime, "utf8")).toBe(managedLoaderSource(home, join(root, pin)));
        expect(JSON.parse(readFileSync(join(root, "active.json"), "utf8"))).toMatchObject({ installed: true, ready: false, entry_sha256: sha256(readFileSync(runtime)) });
        expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      });
    }
  }
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
  const keptFiles = () => [join(plugin(), "plugin.yaml"), join(plugin(), "sidecar.py")];

  for (const [label, argv] of [["--skip-index (P3)", SKIP], ["no Index key (P3b)", KEYLESS]] as const) {
    test(`${label}: arm ON, gate verified, sentinel pin, MORALMOD_* at an unpinned bundle, the loader and active.json for release deadbeef on disk: withheld as release_unpinned, dropped from plugins.enabled, the morning job removed, the loader and the marker taken out; active.json and the tree left; no plugin call; the next such run is withheld again (ov#284 refute S1)`, () => {
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
      expect(existsSync(negotiatorPath(home))).toBe(false);
      expect(result.lines[0]).toBe(STALE_LINE);
      // The next such run finds no loader, but active.json still names deadbeef: withheld again, not skipped.
      const again = step(recorder().run, true, undefined, [...argv]);
      expect(again).toMatchObject({ state: "failed", failed: "release_unpinned" });
      expect(again.lines[0]).toBe(RECEIPT_LINE);
      expect(enabled()).toEqual(["av-events"]);
    });
  }

  test("keyed, active.json deleted and MORALMOD_* unset, the plugin at REF (the pinnedAtRef path, P3c): withheld as release_unpinned before any plugin call, not enabled, the loader and the marker taken out; run 2 enables the plain plugin with the seed hook, never beside the marker (ov#284 refute M2)", () => {
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
    expect(existsSync(negotiatorPath(home))).toBe(false);
    expect(snapshot(Object.keys(kept))).toEqual(kept);
    expect(result.lines[0]).toBe(STALE_LINE);
    // Run 2: no loader, no active.json, no marker: the plain plugin, its hook the seed.
    const second = recorder();
    expect(step(second.run)).toMatchObject({ state: "pinned", failed: null });
    expect(second.calls).toEqual([]);
    expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
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

  test("S2, ov#284 refute M1: an ON-to-OFF flip (the arm line in .env goes to off) takes the OFF path on the first install after it: dropped from plugins.enabled, the morning job removed, the loader, the marker, resident.json, active.json and the release removed; fallback.sqlite, a journal, a staging directory and the operator's resident config stay; a second OFF run changes nothing", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const pin = supplyRelease();
    installMoralmodRelease(home, process.env.MORALMOD_RELEASE_DIR!, pin);
    plantManagedBox(pin);
    writeFileSync(join(moralmod(), "resident.json"), readFileSync(process.env.MORALMOD_RESIDENT_CONFIG!), { mode: 0o600 });
    writeFileSync(join(moralmod(), "fallback.sqlite"), "queued evidence\n");
    writeFileSync(join(moralmod(), "journal-1.jsonl"), "{}\n");
    mkdirSync(join(moralmod(), ".00000000-0000-4000-8000-000000000000.staging"));
    expect(step(recorder().run, true, pin, SKIP)).toMatchObject({ state: "skipped", failed: null });
    expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    const kept = snapshot([
      ...keptFiles(),
      join(moralmod(), "fallback.sqlite"),
      join(moralmod(), "journal-1.jsonl"),
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
      expect(existsSync(negotiatorPath(home))).toBe(false);
      expect(snapshot(Object.keys(kept))).toEqual(kept);
      expect(readdirSync(moralmod()).sort()).toEqual([".00000000-0000-4000-8000-000000000000.staging", "fallback.sqlite", "journal-1.jsonl"]);
      if (argv === ARGV) {
        expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
        expect(existsSync(launcher())).toBe(false);
        expect(result.lines[0]).toBe(`${OFF_LINE}; managed loader removed; MoralMod files cleaned up: resident.json, index/negotiator.ts, active.json, release ${pin.slice(0, 8)}; removed from plugins.enabled`);
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
    expect(existsSync(negotiatorPath(home))).toBe(false);
    expect(result.lines[0]).toBe(`${OFF_LINE}; managed loader removed; MoralMod files cleaned up: index/negotiator.ts; removed from plugins.enabled`);
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

  test("ov#284 refute S1: release A activated, then the pin goes back to the sentinel: run 1 takes the loader out, and every later ON run not handed a release (--skip-index, keyless, keyed without MORALMOD_*) is withheld as release_unpinned, never skipped or pinned; an OFF run then clears active.json and the release, and the next ON run is the plain plugin", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const pin = supplyRelease();
    installMoralmodRelease(home, process.env.MORALMOD_RELEASE_DIR!, pin);
    plantManagedBox(pin);
    delete process.env.MORALMOD_RELEASE_DIR;
    delete process.env.MORALMOD_RESIDENT_CONFIG;
    expect(step(recorder().run, true, pin, SKIP)).toMatchObject({ state: "skipped", failed: null });
    expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    // The shipped constant (the sentinel): no pin argument.
    const first = step(recorder().run, true, undefined, SKIP);
    expect(first).toMatchObject({ state: "failed", failed: "release_unpinned" });
    expect(first.lines[0]).toBe(STALE_LINE);
    expect(existsSync(loaderPath())).toBe(false);
    for (const [label, argv] of [["--skip-index", SKIP], ["keyless", KEYLESS], ["keyed", ARGV], ["--skip-index again", SKIP]] as const) {
      const { calls, run } = recorder();
      const result = step(run, true, undefined, [...argv]);
      expect([label, result.state, result.failed]).toEqual([label, "failed", "release_unpinned"]);
      expect([label, result.lines]).toEqual([label, [RECEIPT_LINE]]);
      expect([label, calls]).toEqual([label, []]);
      expect([label, enabled()]).toEqual([label, ["av-events"]]);
    }
    setArm("env", "off");
    const off = step(recorder().run);
    expect(off).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
    expect(off.lines).toEqual([`${OFF_LINE}; MoralMod files cleaned up: active.json, release ${pin.slice(0, 8)}`]);
    expect(readdirSync(moralmod())).toEqual([]);
    process.env[MORALMOD_ARM_ENV] = "on";
    const plain = recorder();
    expect(step(plain.run)).toMatchObject({ state: "pinned", failed: null });
    expect(plain.calls).toEqual([]);
    expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
    expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
  });

  test("ov#284 refute M1: a half-removed box (resident.json and the loader already gone, a release directory without its release.json, an emptied one, the marker and active.json still there) is finished by the next OFF run; a second OFF run changes nothing", () => {
    plantManagedBox("deadbeef");
    writeFileSync(loaderPath(), "// upstream negotiator\n");
    const half = join(moralmod(), "a".repeat(64));
    mkdirSync(half);
    writeFileSync(join(half, "negotiator-runtime.js"), "export {}\n");
    writeFileSync(join(half, "INDEX-LICENSE"), "license\n");
    mkdirSync(join(moralmod(), "b".repeat(64)));
    writeFileSync(join(moralmod(), "fallback.sqlite"), "queued evidence\n");
    setArm("env", "off");
    const result = step(recorder().run);
    expect(result).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
    expect(readFileSync(loaderPath(), "utf8")).toBe("// upstream negotiator\n");
    expect(existsSync(negotiatorPath(home))).toBe(false);
    expect(readdirSync(moralmod())).toEqual(["fallback.sqlite"]);
    expect(result.lines[0]).toBe(`${OFF_LINE}; MoralMod files cleaned up: index/negotiator.ts, active.json, release aaaaaaaa, release bbbbbbbb; removed from plugins.enabled`);
    const again = step(recorder().run);
    expect(again).toEqual({ state: "off", failed: null, lines: [`→ index-network plugin: off (${MORALMOD_ARM_ENV} is not on)`] });
    expect(readdirSync(moralmod())).toEqual(["fallback.sqlite"]);
  });

  test("ov#284 refute M1: a release directory holding a file that is not a release file is left whole (the control plane's clean can still verify it); the OFF run removes everything else and reports moralmod_cleanup with a warning naming it", () => {
    const pin = supplyRelease();
    installMoralmodRelease(home, process.env.MORALMOD_RELEASE_DIR!, pin);
    plantManagedBox(pin);
    writeFileSync(join(moralmod(), pin, "notes.txt"), "not a release file\n");
    const before = snapshot(readdirSync(join(moralmod(), pin)).map((name) => join(moralmod(), pin, name)));
    setArm("env", "off");
    const result = step(recorder().run);
    expect(result).toMatchObject({ state: "off", failed: "moralmod_cleanup", note: "moralmod_arm_not_on" });
    expect(snapshot(Object.keys(before))).toEqual(before);
    expect(readdirSync(moralmod())).toEqual([pin]);
    expect(existsSync(loaderPath())).toBe(false);
    expect(existsSync(negotiatorPath(home))).toBe(false);
    expect(result.lines).toContain(`  warning: index-network plugin: MoralMod cleanup did not finish (left: release ${pin.slice(0, 8)})`);
    expect(indexPluginFailedLine(result.failed!)).toBe("agentvillage-install: index_plugin_failed=moralmod_cleanup");
  });

  test("ov#284 refute M2: the marker left in index/negotiator.ts without its loader (no active.json, no MORALMOD_*; the control plane's clean or a run before the fix left it): a keyed ON run takes it out, says so, seeds the hook and enables the plain plugin; a --skip-index run with the plugin listed takes it out and keeps the plugin", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    for (const argv of [ARGV, SKIP]) {
      plantManagedBox("deadbeef");
      writeFileSync(loaderPath(), "// upstream negotiator\n");
      rmSync(join(moralmod(), "active.json"));
      const { calls, run } = recorder();
      const result = step(run, true, undefined, [...argv]);
      expect([argv.length, result.state, result.failed]).toEqual([argv.length, argv === SKIP ? "skipped" : "pinned", null]);
      expect(calls).toEqual([]);
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      expect(result.lines[0]).toBe("→ index-network plugin: managed index/negotiator.ts without its loader; MoralMod files cleaned up: index/negotiator.ts; the plugin's own negotiator is used");
      if (argv === SKIP) expect(existsSync(negotiatorPath(home))).toBe(false);
      else expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
    }
  });

  // A read-only directory stops an unlink only for a user other than root.
  test.skipIf(process.getuid?.() === 0)("ov#284 refute M2: when that marker cannot be taken out, the plugin is withheld (sidecar), never enabled beside it", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    plantManagedBox("deadbeef");
    writeFileSync(loaderPath(), "// upstream negotiator\n");
    rmSync(join(moralmod(), "active.json"));
    const index = join(home, "index");
    chmodSync(index, 0o555);
    try {
      const result = step(recorder().run);
      expect(result).toMatchObject({ state: "failed", failed: "sidecar" });
      expect(enabled()).toEqual(["av-events"]);
      expect(readFileSync(negotiatorPath(home), "utf8")).toBe("// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n");
      expect(result.lines[0]).toBe("  warning: index-network plugin: not enabled, managed negotiator hook stale (the managed index/negotiator.ts has no loader and could not be taken out (left: index/negotiator.ts)); removed from plugins.enabled");
    } finally {
      chmodSync(index, 0o755);
    }
  });
});

describe("ov#284 refute M2 with the pinned plugin checkout: the plugin's own negotiator.js is never enabled beside the marker", () => {
  test.skipIf(!havePlugin)(
    "probe R2b: A activated, active.json deleted and MORALMOD_* unset (kept as pinned), then the pin goes to the sentinel: run 1 withholds and puts the plugin's negotiator.js and morning.py back and takes the marker out; run 2 enables the plain plugin with the seed hook. The state the control plane's clean leaves when the loader hash no longer matches (marker and managed morning.py, no active.json) is put right by the next ON run, and by an OFF run",
    () => {
      process.env[MORALMOD_ARM_ENV] = "on";
      writeFileSync(join(home, "config.yaml"), BASE);
      const pin = supplyRelease();
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "installed", failed: null });
      const plugin = join(home, "plugins", INDEX_PLUGIN);
      const runtime = join(plugin, "runtime", "dist", "negotiator.js");
      const upstream = Bun.spawnSync(["git", "show", "HEAD:runtime/dist/negotiator.js"], { cwd: plugin }).stdout.toString();
      const upstreamMorning = Bun.spawnSync(["git", "show", "HEAD:morning.py"], { cwd: plugin }).stdout.toString();
      const loader = readFileSync(runtime, "utf8");
      rmSync(join(home, "index", "moralmod", "active.json"));
      delete process.env.MORALMOD_RELEASE_DIR;
      delete process.env.MORALMOD_RESIDENT_CONFIG;
      expect(step(recorder().run, true, pin)).toMatchObject({ state: "pinned", failed: null });
      expect(readFileSync(runtime, "utf8")).toBe(loader);
      // The pin goes to the sentinel. Run 1:
      expect(step(recorder().run)).toMatchObject({ state: "failed", failed: "release_unpinned" });
      expect(readFileSync(runtime, "utf8")).toBe(upstream);
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(upstreamMorning);
      expect(existsSync(negotiatorPath(home))).toBe(false);
      // Run 2: the plain plugin, the seed hook, never the marker.
      expect(step(recorder().run)).toMatchObject({ state: "pinned", failed: null });
      expect(enabled()).toEqual(["av-events", INDEX_PLUGIN]);
      expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);

      // The clean leftover: the managed morning.py and the marker, the loader already gone, no active.json.
      writeFileSync(join(plugin, "morning.py"), morningSource(upstreamMorning));
      writeFileSync(negotiatorPath(home), "// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n");
      const fixed = step(recorder().run);
      expect(fixed).toMatchObject({ state: "pinned", failed: null });
      expect(fixed.lines[0]).toBe("→ index-network plugin: managed index/negotiator.ts without its loader; MoralMod files cleaned up: index/negotiator.ts, morning.py; the plugin's own negotiator is used");
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(upstreamMorning);
      expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
      expect(readFileSync(runtime, "utf8")).toBe(upstream);

      // The same leftover under OFF: both put right, the plugin dropped.
      writeFileSync(join(plugin, "morning.py"), morningSource(upstreamMorning));
      writeFileSync(negotiatorPath(home), "// Managed MoralMod lifecycle 2; see index/moralmod/active.json.\n");
      process.env[MORALMOD_ARM_ENV] = "off";
      const off = step(recorder().run);
      expect(off).toMatchObject({ state: "off", failed: null, note: "moralmod_arm_not_on" });
      expect(readFileSync(join(plugin, "morning.py"), "utf8")).toBe(upstreamMorning);
      expect(existsSync(negotiatorPath(home))).toBe(false);
      expect(enabled()).toEqual(["av-events"]);
    },
    60_000,
  );
});
