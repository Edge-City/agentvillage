/** Hermes plugins are opt-in: the installer lists `av-help` in plugins.enabled (plugins/av-help). */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { AV_HELP_PLUGIN, configureAvHelp } from "../av_help";

const ORIGINAL_HOME = process.env.HERMES_HOME;
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-av-help-"));
  process.env.HERMES_HOME = home;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  if (ORIGINAL_HOME === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = ORIGINAL_HOME;
  rmSync(home, { recursive: true, force: true });
});

const configPath = () => join(home, "config.yaml");
const read = () => YAML.parse(readFileSync(configPath(), "utf8")) as Record<string, any>;
const logged = () => logSpy.mock.calls.map((c) => String(c[0])).join("\n");

test("appended to plugins.enabled once; the other plugins and keys are kept", () => {
  writeFileSync(configPath(), YAML.stringify({ model: { default: "m" }, plugins: { enabled: ["av-events", "av-display"], hook_callback_timeout: 600 } }));
  configureAvHelp();
  expect(read()).toEqual({ model: { default: "m" }, plugins: { enabled: ["av-events", "av-display", "av-help"], hook_callback_timeout: 600 } });
  const once = readFileSync(configPath(), "utf8");
  configureAvHelp();
  expect(readFileSync(configPath(), "utf8")).toBe(once);
  expect(logged()).toContain("→ plugin av-help already enabled");
  expect(AV_HELP_PLUGIN).toBe("av-help");
});

test("a plugins.disabled entry is the rollback switch: kept, with a warning", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: [], disabled: ["av-help"] } }));
  configureAvHelp();
  expect(read().plugins.disabled).toEqual(["av-help"]);
  expect(logged()).toContain("→ warning: av-help is in plugins.disabled; Hermes will not load it");
});

test.each([
  ["a top level that is not a mapping", "- a\n- b\n", "the top level of config.yaml is not a mapping"],
  ["plugins that is not a mapping", "plugins: nope\n", "plugins in config.yaml is not a mapping"],
  ["plugins.enabled that is not a list", "plugins:\n  enabled: nope\n", "plugins.enabled is not a list"],
])("%s is left alone with a warning", (_name, body, why) => {
  writeFileSync(configPath(), body);
  configureAvHelp();
  expect(readFileSync(configPath(), "utf8")).toBe(body);
  expect(logged()).toBe(`→ warning: ${why}; av-help not enabled`);
});

test("the plugin directory ships with its manifest and entrypoint", () => {
  const dir = join(import.meta.dir, "..", "..", "plugins", "av-help");
  expect(existsSync(join(dir, "plugin.yaml"))).toBe(true);
  expect(existsSync(join(dir, "__init__.py"))).toBe(true);
});
