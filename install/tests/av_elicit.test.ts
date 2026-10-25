/**
 * GC-ELICIT (contract v1, 3a): the installer's half of the av-elicit plugin. Opt-in on
 * AV_ELICIT_ENABLED (environment, else $HERMES_HOME/.env): on lists the plugin, allows it to inject
 * (plugins.entries.av-elicit.allow_gateway_injection: true) and raises memory.memory_char_limit to
 * 8000; unset changes nothing; off unlists it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { AV_ELICIT_ENV, AV_ELICIT_PLUGIN, configureAvElicit, ELICIT_MEMORY_CHAR_LIMIT, safeConfigureAvElicit } from "../av_elicit";
import { EDGE_SKILL_NAMES, RETIRED_SKILL_DIRS } from "../paths";
import { RESIDENT_ONLY_PLUGINS } from "../profile";

const ORIGINAL_HOME = process.env.HERMES_HOME;
const ORIGINAL_FLAG = process.env[AV_ELICIT_ENV];
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-av-elicit-"));
  process.env.HERMES_HOME = home;
  delete process.env[AV_ELICIT_ENV];
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (ORIGINAL_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = ORIGINAL_HOME;
  if (ORIGINAL_FLAG === undefined) delete process.env[AV_ELICIT_ENV];
  else process.env[AV_ELICIT_ENV] = ORIGINAL_FLAG;
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, "config.yaml");
const write = (doc: unknown) => writeFileSync(configPath(), YAML.stringify(doc));
const raw = () => readFileSync(configPath(), "utf8");
const read = () => YAML.parse(raw()) as Record<string, any>;
const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");
const on = () => { process.env[AV_ELICIT_ENV] = "1"; };

test("the names the contract fixes", () => {
  expect(AV_ELICIT_PLUGIN).toBe("av-elicit");
  expect(AV_ELICIT_ENV).toBe("AV_ELICIT_ENABLED");
  expect(ELICIT_MEMORY_CHAR_LIMIT).toBe(8000);
});

test("flag unset: nothing is read or written, a fresh box stays without config.yaml", () => {
  expect(configureAvElicit()).toBe("skipped");
  expect(() => raw()).toThrow();
  write({ plugins: { enabled: ["av-vote"] }, memory: { memory_char_limit: 2200 } });
  const before = raw();
  process.env[AV_ELICIT_ENV] = "  ";
  expect(configureAvElicit()).toBe("skipped");
  expect(raw()).toBe(before);
  expect(logged()).toContain("→ skipped plugin av-elicit (opt-in: AV_ELICIT_ENABLED=1, set by the control plane)");
});

test("on: listed, allowed to inject, memory cap raised from the fleet default, the rest kept", () => {
  on();
  write({
    model: { default: "m" },
    memory: { memory_char_limit: 2200, user_char_limit: 1375, provider: "village-memory" },
    plugins: { enabled: ["av-events", "av-vote"], entries: { "av-rate": { allow_gateway_injection: true } }, hook_callback_timeout: 600 },
  });
  expect(configureAvElicit()).toBe("enabled");
  expect(read()).toEqual({
    model: { default: "m" },
    memory: { memory_char_limit: 8000, user_char_limit: 1375, provider: "village-memory" },
    plugins: {
      enabled: ["av-events", "av-vote", "av-elicit"],
      entries: { "av-rate": { allow_gateway_injection: true }, "av-elicit": { allow_gateway_injection: true } },
      hook_callback_timeout: 600,
    },
  });
  expect(logged()).toContain("set memory.memory_char_limit: 8000");
});

test("on with no config.yaml: written with the plugin, the entry and the cap", () => {
  on();
  expect(configureAvElicit()).toBe("enabled");
  expect(read()).toEqual({
    plugins: { enabled: ["av-elicit"], entries: { "av-elicit": { allow_gateway_injection: true } } },
    memory: { memory_char_limit: 8000 },
  });
});

test("idempotent: a second run reports kept and does not rewrite the file", () => {
  on();
  write({ plugins: { enabled: ["av-vote"] }, memory: { memory_char_limit: 2200 } });
  expect(configureAvElicit()).toBe("enabled");
  const after = raw();
  expect(configureAvElicit()).toBe("kept");
  expect(raw()).toBe(after);
  expect(logged()).toContain("→ plugin av-elicit already enabled");
});

test("the memory cap is only ever raised: a higher value is kept, a string Hermes int()s counts", () => {
  on();
  for (const higher of [8000, 12000, "16000"]) {
    write({ plugins: { enabled: ["av-elicit"], entries: { "av-elicit": { allow_gateway_injection: true } } }, memory: { memory_char_limit: higher } });
    const before = raw();
    expect(configureAvElicit()).toBe("kept");
    expect(raw()).toBe(before);
  }
  // Higher cap, plugin not yet listed: the plugin keys are written, the cap is untouched.
  write({ memory: { memory_char_limit: 10000 } });
  expect(configureAvElicit()).toBe("enabled");
  expect(read().memory).toEqual({ memory_char_limit: 10000 });
  // Lower, null or unreadable: set to 8000.
  for (const lower of [2200, 7999, "3000", null, "lots", true]) {
    write({ memory: { memory_char_limit: lower } });
    configureAvElicit();
    expect(read().memory.memory_char_limit).toBe(8000);
  }
});

test("enabled but not allowed to inject: the entry is added, its other keys kept", () => {
  on();
  write({ plugins: { enabled: ["av-elicit"], entries: { "av-elicit": { allow_gateway_injection: "true", other: 1 } } }, memory: { memory_char_limit: 9000 } });
  expect(configureAvElicit()).toBe("enabled");
  expect(read().plugins).toEqual({ enabled: ["av-elicit"], entries: { "av-elicit": { allow_gateway_injection: true, other: 1 } } });
});

test("the flag is read from $HERMES_HOME/.env when the environment lacks it", () => {
  writeFileSync(join(home, ".env"), "OTHER=1\nAV_ELICIT_ENABLED=yes  # set by the control plane\n");
  expect(configureAvElicit()).toBe("enabled");
  expect(read().plugins.enabled).toEqual(["av-elicit"]);
});

test("off: unlisted and the injection key removed; other entry keys and the memory cap kept", () => {
  write({
    plugins: { enabled: ["av-vote", "av-elicit"], entries: { "av-elicit": { allow_gateway_injection: true, other: 1 }, "av-rate": { x: 1 } } },
    memory: { memory_char_limit: 8000 },
  });
  process.env[AV_ELICIT_ENV] = "0";
  expect(configureAvElicit()).toBe("disabled");
  expect(read()).toEqual({
    plugins: { enabled: ["av-vote"], entries: { "av-elicit": { other: 1 }, "av-rate": { x: 1 } } },
    memory: { memory_char_limit: 8000 },
  });
  // A lone entry is removed with its mapping; a second run writes nothing.
  write({ plugins: { enabled: ["av-elicit"], entries: { "av-elicit": { allow_gateway_injection: true } } } });
  expect(configureAvElicit()).toBe("disabled");
  expect(read()).toEqual({ plugins: { enabled: [] } });
  const before = raw();
  expect(configureAvElicit()).toBe("unchanged");
  expect(raw()).toBe(before);
});

test("plugins.disabled is the rollback switch: kept, with a warning", () => {
  on();
  write({ plugins: { enabled: [], disabled: ["av-elicit"] } });
  configureAvElicit();
  expect(read().plugins.disabled).toEqual(["av-elicit"]);
  expect(logged()).toContain("→ warning: av-elicit is in plugins.disabled; Hermes will not load it");
});

test("an unusable shape leaves the whole file alone with a warning and echoes no value", () => {
  on();
  const shapes: [unknown, string][] = [
    [{ plugins: { enabled: "av-events" } }, "plugins.enabled is not a list"],
    [{ plugins: ["x"] }, "plugins in config.yaml is not a mapping"],
    [{ plugins: { entries: [] } }, "plugins.entries is not a mapping"],
    [{ plugins: { entries: { "av-elicit": true } } }, "plugins.entries.av-elicit is not a mapping"],
    [{ memory: "SENTINEL-VALUE" }, "memory in config.yaml is not a mapping"],
  ];
  for (const [doc, why] of shapes) {
    write(doc);
    const before = raw();
    expect(configureAvElicit()).toBe("refused");
    expect(raw()).toBe(before);
    expect(logged()).toContain(`→ warning: ${why}; av-elicit left unconfigured`);
  }
  writeFileSync(configPath(), "base: &b\n  memory_char_limit: 100\nmemory:\n  <<: *b\n");
  const before = raw();
  expect(configureAvElicit()).toBe("refused");
  expect(raw()).toBe(before);
  expect(logged()).not.toContain("SENTINEL");
});

test("the safe wrapper never throws", () => {
  on();
  writeFileSync(configPath(), "plugins: [unclosed\n");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(safeConfigureAvElicit()).toBe(false);
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("av-elicit step failed");
  } finally {
    warn.mockRestore();
  }
});

test("install.ts runs the step once, resident only, after av-vote, the /village menu and recall, before the memory provider", () => {
  const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const main = text.slice(text.indexOf("function main(): void {"));
  const body = main.slice(0, main.indexOf("\n}\n"));
  expect(body.match(/^.*AvElicit.*$/gm)).toEqual(["  if (resident) safeConfigureAvElicit();"]);
  const at = (s: string) => body.indexOf(s);
  expect(at("if (resident) configureAvVote();")).toBeGreaterThan(-1);
  expect(at("if (resident) configureAvVote();")).toBeLessThan(at("  configureVillageMenu();"));
  expect(at("  configureVillageMenu();")).toBeLessThan(at("  safeInstallRecall(SOURCE_SKILLS);"));
  expect(at("  safeInstallRecall(SOURCE_SKILLS);")).toBeLessThan(at("  if (resident) safeConfigureAvElicit();"));
  // Before the memory provider step, which keeps every other memory key (the cap set here included).
  expect(at("  if (resident) safeConfigureAvElicit();")).toBeLessThan(at("  safeConfigureVillageMemory();"));
});

test("the control plane's brief skill is never copied over or removed by the installer", () => {
  // odin-constitution since GC-ELICIT v5 (Carter's review); constitution-elicitation was its name before, and a
  // box may still hold that dir from a window opened under the old name: neither is shipped nor retired.
  for (const dir of ["odin-constitution", "constitution-elicitation"]) {
    expect(EDGE_SKILL_NAMES as readonly string[]).not.toContain(dir);
    expect(RETIRED_SKILL_DIRS as readonly string[]).not.toContain(dir);
    expect(existsSync(join(import.meta.dir, "..", "..", "skills", dir))).toBe(false);
  }
});

test("ODIN never gets av-elicit: it is resident-only, and a full odin install with the flag on unlists it", () => {
  expect(RESIDENT_ONLY_PLUGINS).toContain(AV_ELICIT_PLUGIN);
  // The control plane wrote the flag (and an earlier install listed the plugin) on what is now an ODIN box.
  writeFileSync(join(home, ".env"), "AV_PROFILE=odin\nAV_ELICIT_ENABLED=1\n");
  write({ plugins: { enabled: ["av-events", "av-elicit"] }, memory: { memory_char_limit: 2200 } });
  const env: Record<string, string | undefined> = { ...process.env, HERMES_HOME: home };
  delete env.AV_PROFILE;
  delete env.AV_ELICIT_ENABLED;
  delete env.INDEX_API_KEY;
  const run = spawnSync("bun", [join(import.meta.dir, "..", "install.ts"), "--no-restart"], { env, encoding: "utf8", timeout: 30000 });
  expect(run.status).toBe(0);
  expect(run.stdout).toContain("→ removed plugin av-elicit from plugins.enabled (profile odin)");
  expect(run.stdout).not.toContain("enabled plugin av-elicit");
  const config = read();
  expect(config.plugins.enabled).not.toContain(AV_ELICIT_PLUGIN);
  expect(config.plugins.entries?.[AV_ELICIT_PLUGIN]).toBeUndefined();
  expect(config.memory.memory_char_limit).toBe(2200);
}, 40000);
