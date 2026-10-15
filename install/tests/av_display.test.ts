/**
 * RC28 slice 5: Hermes plugins are opt-in, so the installer lists `av-display`
 * in plugins.enabled (the plugin makes Telegram progress lines name the tool,
 * never the command; plugins/av-display).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { AV_DISPLAY_PLUGIN, configureAvDisplay } from "../av_display";

const ORIGINAL_HOME = process.env.HERMES_HOME;
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-av-display-"));
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

test("appended to plugins.enabled once, the other plugin keys and the rest of the file kept", () => {
  writeFileSync(configPath(), YAML.stringify({ model: { default: "m" }, plugins: { enabled: ["av-events", "index-links"], hook_callback_timeout: 600 } }));
  configureAvDisplay();
  expect(read()).toEqual({ model: { default: "m" }, plugins: { enabled: ["av-events", "index-links", "av-display"], hook_callback_timeout: 600 } });
  expect(logged()).toBe("→ enabled plugin av-display (Telegram progress lines name the tool, not the command)");
  expect(AV_DISPLAY_PLUGIN).toBe("av-display");
});

test("a second run changes nothing and does not rewrite the file", () => {
  configureAvDisplay();
  const once = readFileSync(configPath(), "utf8");
  writeFileSync(configPath(), `# kept only if not rewritten\n${once}`);
  logSpy.mockClear();
  configureAvDisplay();
  expect(readFileSync(configPath(), "utf8")).toBe(`# kept only if not rewritten\n${once}`);
  expect(logged()).toBe("→ plugin av-display already enabled");
});

test("no config.yaml: written with only the plugin list", () => {
  expect(existsSync(configPath())).toBe(false);
  configureAvDisplay();
  expect(read()).toEqual({ plugins: { enabled: ["av-display"] } });
});

test("plugins.disabled is the rollback switch: kept, with a warning", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: [], disabled: ["av-display"] } }));
  configureAvDisplay();
  expect(read().plugins.disabled).toEqual(["av-display"]);
  expect(logged()).toContain("→ warning: av-display is in plugins.disabled; Hermes will not load it");
});

test("an unusable shape is left alone with a warning", () => {
  for (const [text, why] of [
    ["- a\n", "the top level of config.yaml is not a mapping"],
    ["plugins: off\n", "plugins in config.yaml is not a mapping"],
    ["plugins:\n  enabled: av-events\n", "plugins.enabled is not a list"],
  ] as const) {
    logSpy.mockClear();
    writeFileSync(configPath(), text);
    configureAvDisplay();
    expect(readFileSync(configPath(), "utf8")).toBe(text);
    expect(logged()).toBe(`→ warning: ${why}; av-display not enabled`);
  }
});

test("install.ts runs the step right after configureIndexLinks, as a bare statement in main()", () => {
  const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const main = text.slice(text.indexOf("function main(): void {"));
  const body = main.slice(0, main.indexOf("\n}\n"));
  expect(body.match(/^.*configureAvDisplay.*$/gm)).toEqual(["  configureAvDisplay();"]);
  expect(body).toMatch(/^  configureIndexLinks\(\);\n  configureAvDisplay\(\);$/m);
});

test("the plugin directory exists where the installer stages plugins from", () => {
  const dir = join(import.meta.dir, "..", "..", "plugins", "av-display");
  expect(existsSync(join(dir, "plugin.yaml"))).toBe(true);
  expect(existsSync(join(dir, "__init__.py"))).toBe(true);
});

/**
 * rc42 (QUIET HERMES NOTICES): Hermes's "Context compression deferred — summary still streaming"
 * and its three sibling compaction notices are kept out of residents' chats by av-display 0.3.0
 * (a wrap of gateway.run_turn GatewayTurnMixin._hmwa_hygiene_notify), not by a config key. The only
 * key that reaches them at v2026.9.24, display.suppress_warning_notifications (default false,
 * gateway/display_config.py:24; read in gateway/warning_notifications.py:90-101), also hides failures
 * a resident must act on, so the box config never carries it: the pinned key/value is "unset", and the
 * pinned switch is av-display in plugins.enabled at a version that carries the wrap.
 */
test("rc42: the box config enables av-display and never writes display.suppress_warning_notifications", async () => {
  const { setCompactionSettings } = await import("../config");
  const { configureTelegramDisplay } = await import("../display_defaults");
  writeFileSync(configPath(), YAML.stringify({ model: { default: "m" } }));
  setCompactionSettings();
  configureTelegramDisplay();
  configureAvDisplay();
  const doc = read();
  expect(doc.plugins.enabled).toContain(AV_DISPLAY_PLUGIN);
  expect(doc.compression.hygiene_max_turn_hold_seconds).toBe(25);
  expect(readFileSync(configPath(), "utf8")).not.toContain("suppress_warning_notifications");
  // No installer step writes the key: it appears in install/*.ts only inside comments.
  const { readdirSync } = await import("node:fs");
  const dir = join(import.meta.dir, "..");
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".ts"))) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      if (line.includes("suppress_warning_notifications")) expect(line.trim()).toMatch(/^(\*|\/\/|\/\*)/);
    }
  }
  const plugin = join(dir, "..", "plugins", "av-display");
  const manifest = YAML.parse(readFileSync(join(plugin, "plugin.yaml"), "utf8")) as { version: string };
  expect(manifest.version).toBe("0.3.0");
  const source = readFileSync(join(plugin, "__init__.py"), "utf8");
  expect(source).toContain('("gateway.run_turn", apply_hygiene_notices)');
  expect(source).toContain('"compression-turnhold notice",');
});
