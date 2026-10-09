/**
 * OV-249: the Index Hermes plugin (`index-network`), MoralMod's carrier, for
 * ON residents only (`AV_MORALMOD_ARM=on`), pinned at one reviewed commit,
 * never updated past it, never enabled or removed through Hermes (that would
 * clear an operator's `plugins.disabled` entry), enabled and disabled through
 * `writeConfig`; a failure is recorded and never fails the install. The step
 * runs against an injected runner, then once end to end through install.ts
 * against the stand-in Hermes (fake_hermes.ts, taught `plugins install`).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { APPROVAL_GATED_TOOLS } from "../install_approval";
import {
  INDEX_PLUGIN,
  INDEX_PLUGIN_REF,
  INDEX_PLUGIN_SOURCE,
  MORALMOD_ARM_ENV,
  MORNING_JOB,
  MORNING_LAUNCHER,
  NEGOTIATOR_SEED,
  indexPluginFailedLine,
  installIndexPlugin,
  installMetadataPath,
  negotiatorPath,
  recordIndexPluginStatus,
} from "../install_index_plugin";
import { installStatusPath, writeInstallStatus } from "../install_status";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const FAKE = join(import.meta.dir, "fake_hermes.ts");
const ENV_KEYS = ["HERMES_HOME", "HERMES_BIN", "INDEX_API_KEY", MORALMOD_ARM_ENV, "FAKE_HERMES_FAIL"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const FRESH = ["plugins", "install", INDEX_PLUGIN_SOURCE, "--ref", INDEX_PLUGIN_REF, "--no-enable"];
const FORCED = ["plugins", "install", INDEX_PLUGIN_SOURCE, "--force", "--ref", INDEX_PLUGIN_REF, "--no-enable"];
const ARGV = ["bun", "install.ts", "--index-api-key", "ix_plugin_test"];
const OTHER_REF = "42cf64fb".padEnd(40, "0");

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-index-plugin-"));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HERMES_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

/** A runner that records each argv and, unless told to fail, does what Hermes's `plugins install` leaves on disk. */
function recorder(fail = false) {
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    if (fail) throw new Error("hermes exited 1");
    if (args[0] === "plugins" && args[1] === "install") {
      const ref = args[args.indexOf("--ref") + 1]!;
      installedAt(ref, true);
    }
    if (args[0] === "cron" && args[1] === "remove") writeJobs(cronJobs().filter((job) => job.id !== args[2]));
  };
  return { calls, run };
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
/** The plugin's `Index morning` job and launcher as morning.py creates them at REF, beside three jobs that are not it. */
function plantMorning(): void {
  mkdirSync(join(home, "scripts"), { recursive: true });
  writeFileSync(launcher(), "import runpy\n");
  writeJobs([
    { id: "aaaaaaaaaaaa", name: MORNING_JOB, script: launcher() },
    { id: "bbbbbbbbbbbb", name: "Edge — morning brief", script: "index-digest-send.py" },
    { id: "cccccccccccc", name: MORNING_JOB, script: "someone-else.py" },
    { id: "dddddddddddd", name: "Index morning (mine)", script: launcher() },
  ]);
}

/** The tree and record Hermes leaves after an install at `revision`. */
function installedAt(revision: string, pinned: boolean, manifest = true): void {
  mkdirSync(join(home, "plugins", INDEX_PLUGIN), { recursive: true });
  if (manifest) writeFileSync(join(home, "plugins", INDEX_PLUGIN, "plugin.yaml"), `name: ${INDEX_PLUGIN}\n`);
  const path = installMetadataPath(home);
  let prior = {};
  try {
    prior = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // absent, or the unreadable-record case (real Hermes refuses that install; the step only decides the argv)
  }
  writeFileSync(path, JSON.stringify({ ...prior, [INDEX_PLUGIN]: { pinned, revision, source: "https://github.com/indexnetwork/hermes-plugin.git" } }, null, 2));
}

function config(text: string): void {
  writeFileSync(join(home, "config.yaml"), text);
}
function configText(): string {
  return existsSync(join(home, "config.yaml")) ? readFileSync(join(home, "config.yaml"), "utf8") : "";
}
function plugins(): { enabled?: string[]; disabled?: string[] } {
  return (YAML.parse(configText()) ?? {}).plugins ?? {};
}

/** The step, quietly; returns its result and the lines it printed. */
function step(run: (args: string[]) => void, argv: string[] = ARGV) {
  const lines: string[] = [];
  const log = console.log;
  const warn = console.warn;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  console.warn = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    return { ...installIndexPlugin(run, argv), lines };
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

const BASE = "plugins:\n  enabled:\n    - av-events\n    - index-links\n";

describe("the arm: only `on` installs", () => {
  test("arm absent: no Hermes call, not enabled, no seed, config.yaml not rewritten", () => {
    config(BASE);
    const { calls, run } = recorder();
    const result = step(run);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ state: "off", failed: null });
    expect(plugins().enabled).toEqual(["av-events", "index-links"]);
    expect(configText()).toBe(BASE);
    expect(existsSync(negotiatorPath(home))).toBe(false);
  });

  test("arm off, blank or any other word (`1`, `true`, `yes`, `onn`): no Hermes call, not enabled", () => {
    for (const value of ["off", "OFF", "", "  ", "1", "true", "yes", "onn", "o n"]) {
      config(BASE);
      process.env[MORALMOD_ARM_ENV] = value;
      const { calls, run } = recorder();
      expect([value, step(run).state]).toEqual([value, "off"]);
      expect([value, calls]).toEqual([value, []]);
      expect([value, plugins().enabled]).toEqual([value, ["av-events", "index-links"]]);
      expect([value, existsSync(negotiatorPath(home))]).toEqual([value, false]);
    }
  });

  test("`on` trimmed and in any case is ON; read from $HERMES_HOME/.env when the environment has none; .env wins over the environment", () => {
    for (const value of ["on", " ON ", "On"]) {
      rmSync(join(home, "plugins"), { recursive: true, force: true });
      process.env[MORALMOD_ARM_ENV] = value;
      const { calls, run } = recorder();
      expect([value, step(run).state]).toEqual([value, "installed"]);
      expect([value, calls]).toEqual([value, [FRESH]]);
    }
    rmSync(join(home, "plugins"), { recursive: true, force: true });
    delete process.env[MORALMOD_ARM_ENV];
    writeFileSync(join(home, ".env"), `INDEX_API_KEY=ix_x\n${MORALMOD_ARM_ENV}=on\n`);
    const fromFile = recorder();
    expect(step(fromFile.run).state).toBe("installed");
    expect(fromFile.calls).toEqual([FRESH]);
    // A create-time `off` in the install shell does not beat the control plane's later `.env` on.
    process.env[MORALMOD_ARM_ENV] = "off";
    const overridden = recorder();
    expect(step(overridden.run).state).toBe("pinned");
    expect(overridden.calls).toEqual([]);
  });

  test("refute S1: environment on, .env off -> OFF (the .env flip wins); .env blank -> OFF; .env silent -> the environment", () => {
    config(BASE);
    process.env[MORALMOD_ARM_ENV] = "on";
    writeFileSync(join(home, ".env"), `INDEX_API_KEY=ix_x\n${MORALMOD_ARM_ENV}=off\n`);
    const flipped = recorder();
    expect(step(flipped.run).state).toBe("off");
    expect(flipped.calls).toEqual([]);
    expect(plugins().enabled).toEqual(["av-events", "index-links"]);
    writeFileSync(join(home, ".env"), `INDEX_API_KEY=ix_x\n${MORALMOD_ARM_ENV}=\n`);
    expect(step(recorder().run).state).toBe("off");
    writeFileSync(join(home, ".env"), "INDEX_API_KEY=ix_x\n");
    expect(step(recorder().run).state).toBe("installed");
  });

  test("ON but --skip-index or no Index key (no flag, no INDEX_API_KEY, none in .env): skipped, no Hermes call", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const skip = recorder();
    expect(step(skip.run, [...ARGV, "--skip-index"]).state).toBe("skipped");
    const nokey = recorder();
    expect(step(nokey.run, ["bun", "install.ts"]).state).toBe("skipped");
    expect([...skip.calls, ...nokey.calls]).toEqual([]);
    expect(existsSync(negotiatorPath(home))).toBe(false);
    process.env.INDEX_API_KEY = "ix_env";
    const fromEnv = recorder();
    expect(step(fromEnv.run, ["bun", "install.ts"]).state).toBe("installed");
  });
});

describe("pinned, never updated", () => {
  beforeEach(() => {
    process.env[MORALMOD_ARM_ENV] = "on";
  });

  test("ON, fresh: one `plugins install … --ref <REF> --no-enable`, enabled through config.yaml (other entries kept), seeded", () => {
    config(BASE);
    const { calls, run } = recorder();
    const result = step(run);
    expect(calls).toEqual([FRESH]);
    expect(result).toMatchObject({ state: "installed", failed: null });
    expect(plugins().enabled).toEqual(["av-events", "index-links", INDEX_PLUGIN]);
    expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
  });

  test("ON, a re-roll already at REF: no Hermes call; enabled; a resident's negotiator left in place", () => {
    installedAt(INDEX_PLUGIN_REF, true);
    mkdirSync(join(home, "index"), { recursive: true });
    writeFileSync(negotiatorPath(home), "export default async (i, next) => next();\n");
    const { calls, run } = recorder();
    expect(step(run)).toMatchObject({ state: "pinned", failed: null });
    expect(calls).toEqual([]);
    expect(plugins().enabled).toEqual([INDEX_PLUGIN]);
    expect(readFileSync(negotiatorPath(home), "utf8")).toBe("export default async (i, next) => next();\n");
    // and again: still nothing, and config.yaml is not rewritten
    const before = configText();
    expect(step(run).state).toBe("pinned");
    expect(calls).toEqual([]);
    expect(configText()).toBe(before);
  });

  test("ON, another revision, an unpinned install at REF, no record, or no plugin.yaml: `plugins install … --force --ref <REF> --no-enable`", () => {
    const cases: Array<[string, () => void]> = [
      ["pinned at another revision", () => installedAt(OTHER_REF, true)],
      ["unpinned at REF", () => installedAt(INDEX_PLUGIN_REF, false)],
      ["unpinned at another revision", () => installedAt(OTHER_REF, false)],
      ["directory without a record", () => {
        mkdirSync(join(home, "plugins", INDEX_PLUGIN), { recursive: true });
        writeFileSync(join(home, "plugins", INDEX_PLUGIN, "plugin.yaml"), "name: index-network\n");
      }],
      ["half-installed: pinned at REF, no plugin.yaml", () => installedAt(INDEX_PLUGIN_REF, true, false)],
      ["unreadable record", () => {
        installedAt(INDEX_PLUGIN_REF, true);
        writeFileSync(installMetadataPath(home), "{not json");
      }],
    ];
    for (const [label, arrange] of cases) {
      rmSync(join(home, "plugins"), { recursive: true, force: true });
      arrange();
      const { calls, run } = recorder();
      expect([label, step(run).state]).toEqual([label, "installed"]);
      expect([label, calls]).toEqual([label, [FORCED]]);
    }
  });

  test("no `plugins update`, `enable` or `remove` on any path; every install carries --ref <REF> and --no-enable", () => {
    const seen: string[][] = [];
    const scenarios: Array<() => void> = [
      () => {},
      () => installedAt(INDEX_PLUGIN_REF, true),
      () => installedAt(OTHER_REF, true),
      () => installedAt(OTHER_REF, false),
      () => { process.env[MORALMOD_ARM_ENV] = "off"; },
      () => config("plugins:\n  disabled:\n    - index-network\n"),
    ];
    for (const arrange of scenarios) {
      rmSync(join(home, "plugins"), { recursive: true, force: true });
      rmSync(join(home, "config.yaml"), { force: true });
      process.env[MORALMOD_ARM_ENV] = "on";
      arrange();
      const { calls, run } = recorder();
      step(run);
      seen.push(...calls);
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const argv of seen) {
      expect(argv.slice(0, 3)).toEqual(["plugins", "install", INDEX_PLUGIN_SOURCE]);
      expect(argv[argv.indexOf("--ref") + 1]).toBe(INDEX_PLUGIN_REF);
      expect(argv).toContain("--no-enable");
      expect(argv).not.toContain("--enable");
    }
  });

  test("INDEX_PLUGIN_REF is one full lowercase commit SHA", () => {
    expect(INDEX_PLUGIN_REF).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("the operator's off switches", () => {
  test("ON with index-network in plugins.disabled: no Hermes call, one warning, stays disabled, not enabled, config.yaml not rewritten, no seed", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const text = "plugins:\n  enabled:\n    - av-events\n  disabled:\n    - index-network\n";
    config(text);
    const { calls, run } = recorder();
    const result = step(run);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ state: "disabled", failed: null });
    expect(result.lines).toEqual([`→ warning: ${INDEX_PLUGIN} is in plugins.disabled; the installer leaves it off`]);
    expect(configText()).toBe(text);
    expect(existsSync(negotiatorPath(home))).toBe(false);
  });

  test("on, then off: removed from plugins.enabled with no Hermes call; the tree, the record, the seed and other entries are left", () => {
    config(BASE);
    process.env[MORALMOD_ARM_ENV] = "on";
    const on = recorder();
    step(on.run);
    expect(plugins().enabled).toContain(INDEX_PLUGIN);
    process.env[MORALMOD_ARM_ENV] = "off";
    const off = recorder();
    const result = step(off.run);
    expect(off.calls).toEqual([]);
    expect(result.state).toBe("off");
    expect(plugins().enabled).toEqual(["av-events", "index-links"]);
    expect(existsSync(join(home, "plugins", INDEX_PLUGIN, "plugin.yaml"))).toBe(true);
    expect(existsSync(installMetadataPath(home))).toBe(true);
    expect(existsSync(negotiatorPath(home))).toBe(true);
    // on again: already at REF, so no Hermes call
    process.env[MORALMOD_ARM_ENV] = "on";
    const again = recorder();
    expect(step(again.run).state).toBe("pinned");
    expect(again.calls).toEqual([]);
    expect(plugins().enabled).toContain(INDEX_PLUGIN);
  });

  test("refute S2: OFF after ON removes the plugin's `Index morning` job (cron remove <id>) and its launcher; jobs that are not it stay", () => {
    config(BASE);
    process.env[MORALMOD_ARM_ENV] = "on";
    step(recorder().run);
    plantMorning();
    // ON leaves both to the plugin
    const on = recorder();
    expect(step(on.run).state).toBe("pinned");
    expect(on.calls).toEqual([]);
    expect(cronJobs().map((job) => job.id)).toEqual(["aaaaaaaaaaaa", "bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]);
    expect(existsSync(launcher())).toBe(true);
    process.env[MORALMOD_ARM_ENV] = "off";
    const off = recorder();
    expect(step(off.run)).toMatchObject({ state: "off", failed: null });
    expect(off.calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
    expect(cronJobs().map((job) => job.id)).toEqual(["bbbbbbbbbbbb", "cccccccccccc", "dddddddddddd"]);
    expect(existsSync(launcher())).toBe(false);
    // and the next OFF roll: nothing left to do
    const again = recorder();
    expect(step(again.run)).toMatchObject({ state: "off", failed: null });
    expect(again.calls).toEqual([]);
  });

  test("refute S2: OFF on a box that never had them is a no-op (no Hermes call, jobs.json and scripts/ untouched)", () => {
    writeJobs([{ id: "bbbbbbbbbbbb", name: "Edge — morning brief", script: "index-digest-send.py" }]);
    const before = readFileSync(join(home, "cron", "jobs.json"), "utf8");
    const { calls, run } = recorder();
    expect(step(run)).toMatchObject({ state: "off", failed: null });
    expect(calls).toEqual([]);
    expect(readFileSync(join(home, "cron", "jobs.json"), "utf8")).toBe(before);
    expect(existsSync(join(home, "scripts"))).toBe(false);
  });

  test("refute S2: a failed or ineffective cron remove is failed=hermes, and the launcher is still deleted", () => {
    plantMorning();
    expect(step(recorder(true).run)).toMatchObject({ state: "off", failed: "hermes" });
    expect(existsSync(launcher())).toBe(false);
    plantMorning();
    const calls: string[][] = [];
    expect(step((args) => { calls.push(args); }).failed).toBe("hermes");
    expect(calls).toEqual([["cron", "remove", "aaaaaaaaaaaa"]]);
    expect(existsSync(launcher())).toBe(false);
  });

  test("off with index-network in both lists: dropped from enabled, kept in disabled", () => {
    config("plugins:\n  enabled:\n    - index-network\n  disabled:\n    - index-network\n");
    step(recorder().run);
    expect(plugins()).toEqual({ enabled: [], disabled: [INDEX_PLUGIN] });
  });
});

describe("writes and failures", () => {
  test("config.yaml goes through writeConfig: YAML 1.1 words stay quoted, the hooks block is untouched", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const hooks = { pre_tool_call: [{ matcher: "terminal", command: "/x/shim" }] };
    config(YAML.stringify({ hooks, display: { platforms: { telegram: { tool_progress: "off" } } }, plugins: { enabled: ["av-events"] } }).replace("tool_progress: off", 'tool_progress: "off"'));
    step(recorder().run);
    expect(configText()).toContain('tool_progress: "off"');
    expect(YAML.parse(configText()).hooks).toEqual(hooks);
    process.env[MORALMOD_ARM_ENV] = "off";
    step(recorder().run);
    expect(configText()).toContain('tool_progress: "off"');
    expect(YAML.parse(configText()).hooks).toEqual(hooks);
  });

  test("Hermes fails on a fresh box: failed=hermes, the seed is still written, not enabled (nothing to load)", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    config(BASE);
    const { calls, run } = recorder(true);
    const result = step(run);
    expect(calls).toEqual([FRESH]);
    expect(result).toMatchObject({ state: "failed", failed: "hermes" });
    expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
    expect(plugins().enabled).toEqual(["av-events", "index-links"]);
  });

  test("Hermes fails moving an older tree to REF: failed=hermes, the tree Hermes kept stays enabled", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    installedAt(OTHER_REF, true);
    const { calls, run } = recorder(true);
    expect(step(run)).toMatchObject({ state: "failed", failed: "hermes" });
    expect(calls).toEqual([FORCED]);
    expect(plugins().enabled).toEqual([INDEX_PLUGIN]);
  });

  test("refute N1: a failed or timed-out install removes the temporary clones it left; another plugin's, Hermes's metadata files and other names stay", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    const plugins_ = join(home, "plugins");
    const clone = (name: string, manifest?: string) => {
      mkdirSync(join(plugins_, name, "plugin"), { recursive: true });
      if (manifest) writeFileSync(join(plugins_, name, "plugin", "plugin.yaml"), `name: ${manifest}\n`);
    };
    clone(".install-zzzz9999", "other-plugin"); // another install's, there before the call
    writeFileSync(join(plugins_, ".install-metadata.json"), "{}\n");
    writeFileSync(join(plugins_, ".install-metadata.json.lock"), "");
    const calls: string[][] = [];
    const killed = (args: string[]) => {
      calls.push(args);
      clone(".install-abcd_123", INDEX_PLUGIN); // killed after checkout
      clone(".install-efgh5678"); // killed mid-clone
      const err = new Error("hermes-timeout");
      err.name = "HermesTimeout";
      throw err;
    };
    expect(step(killed)).toMatchObject({ state: "failed", failed: "hermes" });
    expect(calls).toEqual([FRESH]);
    const left = readdirSync(plugins_).sort();
    expect(left).toEqual([".install-metadata.json", ".install-metadata.json.lock", ".install-zzzz9999"]);
  });

  test("refute N1: an index-network clone a killed earlier run left is removed on an ON roll, with no Hermes call when pinned; a name off Hermes's pattern stays", () => {
    process.env[MORALMOD_ARM_ENV] = "on";
    installedAt(INDEX_PLUGIN_REF, true);
    for (const name of [".install-old_0001", ".install-toolongname1"]) {
      mkdirSync(join(home, "plugins", name, "plugin"), { recursive: true });
      writeFileSync(join(home, "plugins", name, "plugin", "plugin.yaml"), `name: ${INDEX_PLUGIN}\n`);
    }
    const { calls, run } = recorder();
    expect(step(run).state).toBe("pinned");
    expect(calls).toEqual([]);
    expect(existsSync(join(home, "plugins", ".install-old_0001"))).toBe(false);
    expect(existsSync(join(home, "plugins", ".install-toolongname1"))).toBe(true);
  });

  test("an unreadable config.yaml: failed=config and no Hermes call, ON or OFF", () => {
    config("plugins: [unclosed\n");
    process.env[MORALMOD_ARM_ENV] = "on";
    const on = recorder();
    expect(step(on.run)).toMatchObject({ failed: "config" });
    process.env[MORALMOD_ARM_ENV] = "off";
    const off = recorder();
    expect(step(off.run)).toMatchObject({ failed: "config" });
    expect([...on.calls, ...off.calls]).toEqual([]);
  });

  test("the status file gains index_plugin_failed (null when clean), keeps cron_failed, 0600; a missing file is left alone; the line is fixed", () => {
    expect(recordIndexPluginStatus(home, "hermes")).toBe(false);
    expect(existsSync(installStatusPath(home))).toBe(false);
    const at = new Date("2026-10-10T00:00:00Z");
    writeInstallStatus(home, ["Edge — morning brief"], at);
    expect(recordIndexPluginStatus(home, "hermes")).toBe(true);
    expect(JSON.parse(readFileSync(installStatusPath(home), "utf8"))).toEqual({
      version: 1, at: at.toISOString(), cron_failed: ["Edge — morning brief"], index_plugin_failed: "hermes",
    });
    expect(statSync(installStatusPath(home)).mode & 0o777).toBe(0o600);
    writeInstallStatus(home, [], at);
    expect(recordIndexPluginStatus(home, null)).toBe(true);
    expect(JSON.parse(readFileSync(installStatusPath(home), "utf8")).index_plugin_failed).toBeNull();
    expect(indexPluginFailedLine("hermes")).toBe("agentvillage-install: index_plugin_failed=hermes");
  });
});

describe("the tool surface at INDEX_PLUGIN_REF", () => {
  // provides_tools in plugin.yaml at INDEX_PLUGIN_REF, copied by hand
  // (`gh api repos/indexnetwork/hermes-plugin/contents/plugin.yaml?ref=<REF>`).
  // A pin bump re-copies it, re-sorts each name into READ or WRITE, and moves PINNED_AT.
  const PINNED_AT = "eaec4fc02ffc251fca2cfd56b728c845562f6a3b";
  const PROVIDES_TOOLS = [
    "index_read_intents",
    "index_research_profile",
    "index_create_intent",
    "index_update_intent",
    "index_add_intent_to_network",
    "index_list_intent_networks",
    "index_read_networks",
    "index_read_network_memberships",
    "index_update_network",
    "index_create_network",
    "index_join_network",
    "index_list_opportunities",
    "index_update_opportunity",
    "index_read_docs",
    "index_agent_me",
    "index_open_app",
  ];
  // Side effects on Index (POST/PATCH/PUT): each must be routed through the approval gate.
  const WRITE = [
    "index_create_intent",
    "index_update_intent",
    "index_add_intent_to_network",
    "index_create_network",
    "index_update_network",
    "index_join_network",
    "index_update_opportunity",
    "index_research_profile",
  ];
  // Reads, and index_open_app (opens a URL on the box: not an Index write; unrouted, as at review).
  const NOT_GATED = [
    "index_read_intents",
    "index_list_intent_networks",
    "index_read_networks",
    "index_read_network_memberships",
    "index_list_opportunities",
    "index_read_docs",
    "index_agent_me",
    "index_open_app",
  ];
  const gated = (tool: string) => APPROVAL_GATED_TOOLS.some((pattern) => new RegExp(`^(?:${pattern})$`).test(tool));

  test("the copy is of the pinned ref: bumping INDEX_PLUGIN_REF fails here until the list is re-copied", () => {
    expect(INDEX_PLUGIN_REF).toBe(PINNED_AT);
    expect(PROVIDES_TOOLS).toHaveLength(16);
  });

  test("every tool is sorted into WRITE or NOT_GATED, once", () => {
    expect([...WRITE, ...NOT_GATED].sort()).toEqual([...PROVIDES_TOOLS].sort());
  });

  // refute N5: the names register() registers at INDEX_PLUGIN_REF, in its order, copied by hand
  // (`gh api repos/indexnetwork/hermes-plugin/contents/__init__.py?ref=<REF>`, the ctx.register_tool loop).
  const REGISTERED = [
    "index_read_intents",
    "index_create_intent",
    "index_update_intent",
    "index_list_intent_networks",
    "index_add_intent_to_network",
    "index_read_networks",
    "index_read_network_memberships",
    "index_create_network",
    "index_update_network",
    "index_join_network",
    "index_list_opportunities",
    "index_update_opportunity",
    "index_research_profile",
    "index_read_docs",
    "index_agent_me",
    "index_open_app",
  ];

  test("refute N5: provides_tools is exactly what register() registers at the pin", () => {
    expect(INDEX_PLUGIN_REF).toBe(PINNED_AT);
    expect([...REGISTERED].sort()).toEqual([...PROVIDES_TOOLS].sort());
    expect(new Set(REGISTERED).size).toBe(REGISTERED.length);
  });

  test("every write tool is in APPROVAL_GATED_TOOLS", () => {
    expect(WRITE.filter((tool) => !gated(tool))).toEqual([]);
  });
});

describe("end to end: install.ts against the stand-in Hermes", () => {
  function hermes(): string {
    const bin = join(home, "hermes");
    writeFileSync(bin, `#!/usr/bin/env bash\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
    chmodSync(bin, 0o755);
    return bin;
  }
  function install(env: Record<string, string>): { code: number | null; out: string } {
    const run = Bun.spawnSync({
      cmd: ["bun", join(REPO_ROOT, "install", "install.ts"), "--no-restart", "--skip-crons", "--index-api-key", "ix_plugin_e2e"],
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: hermes(), AV_APPROVAL_ENABLED: "", AV_GATE_NONCE: "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: run.exitCode, out: run.stdout.toString() };
  }
  function pluginCalls(): string[][] {
    const path = join(home, "hermes-calls.jsonl");
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === "plugins");
  }
  const status = () => JSON.parse(readFileSync(installStatusPath(home), "utf8"));

  test("ON fresh installs at REF and enables it; a re-roll makes no Hermes call; OFF removes it from plugins.enabled", () => {
    const first = install({ [MORALMOD_ARM_ENV]: "on" });
    expect(first.code).toBe(0);
    expect(pluginCalls()).toEqual([FRESH]);
    expect(JSON.parse(readFileSync(installMetadataPath(home), "utf8"))[INDEX_PLUGIN]).toMatchObject({ pinned: true, revision: INDEX_PLUGIN_REF });
    expect(plugins().enabled).toContain(INDEX_PLUGIN);
    expect(plugins().enabled).toContain("av-events");
    expect(existsSync(negotiatorPath(home))).toBe(true);
    expect(status().index_plugin_failed).toBeNull();
    expect(first.out).not.toContain("index_plugin_failed");

    rmSync(join(home, "hermes-calls.jsonl"));
    const reroll = install({ [MORALMOD_ARM_ENV]: "on" });
    expect(reroll.code).toBe(0);
    expect(pluginCalls()).toEqual([]);
    expect(plugins().enabled).toContain(INDEX_PLUGIN);

    // the plugin's own morning job and launcher, as morning.py leaves them (the fake's jobs.json shape)
    const jobsPath = join(home, "cron", "jobs.json");
    const jobs = existsSync(jobsPath) ? JSON.parse(readFileSync(jobsPath, "utf8")).jobs : [];
    jobs.push({ id: "e2e0morning0", name: MORNING_JOB, script: join(home, "scripts", MORNING_LAUNCHER), no_agent: true });
    jobs.push({ id: "e2e0unrelate", name: "Edge — morning brief", script: "index-digest-send.py" });
    mkdirSync(join(home, "cron"), { recursive: true });
    writeFileSync(jobsPath, JSON.stringify({ jobs }));
    mkdirSync(join(home, "scripts"), { recursive: true });
    writeFileSync(join(home, "scripts", MORNING_LAUNCHER), "import runpy\n");
    rmSync(join(home, "hermes-calls.jsonl"), { force: true });
    const off = install({ [MORALMOD_ARM_ENV]: "off" });
    const cronCalls = readFileSync(join(home, "hermes-calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === "cron");
    expect(cronCalls).toEqual([["cron", "remove", "e2e0morning0"]]);
    expect(JSON.parse(readFileSync(jobsPath, "utf8")).jobs.map((job: { id: string }) => job.id)).toEqual(["e2e0unrelate"]);
    expect(existsSync(join(home, "scripts", MORNING_LAUNCHER))).toBe(false);
    expect(off.code).toBe(0);
    expect(pluginCalls()).toEqual([]);
    expect(plugins().enabled).not.toContain(INDEX_PLUGIN);
    expect(plugins().enabled).toContain("av-events");
  }, 120_000);

  test("Hermes fails: the install exits 0, the status file and one stdout line name it, the seed is written", () => {
    const run = install({ [MORALMOD_ARM_ENV]: "on", FAKE_HERMES_FAIL: "install" });
    expect(run.code).toBe(0);
    expect(pluginCalls()).toEqual([FRESH]);
    expect(status().index_plugin_failed).toBe("hermes");
    expect(run.out.split("\n").filter((l) => l.includes("index_plugin_failed"))).toEqual(["agentvillage-install: index_plugin_failed=hermes"]);
    expect(run.out).toContain("✓ installed");
    expect(readFileSync(negotiatorPath(home), "utf8")).toBe(NEGOTIATOR_SEED);
    expect(plugins().enabled ?? []).not.toContain(INDEX_PLUGIN);
  }, 120_000);
});
