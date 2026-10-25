/**
 * GC-TELEGRAM-BALLOT: Hermes plugins are opt-in, so the installer lists `av-godconst`
 * in plugins.enabled for a resident (the plugin sends the GODCONST ballot as Telegram
 * cards; plugins/av-godconst).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { AV_GODCONST_PLUGIN, configureAvGodconst } from "../av_godconst";

const ORIGINAL_HOME = process.env.HERMES_HOME;
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-av-godconst-"));
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
  configureAvGodconst();
  expect(read()).toEqual({ model: { default: "m" }, plugins: { enabled: ["av-events", "index-links", "av-godconst"], hook_callback_timeout: 600 } });
  expect(logged()).toBe("→ enabled plugin av-godconst (the GODCONST ballot as Telegram cards, AV_GODCONST_BALLOT)");
  expect(AV_GODCONST_PLUGIN).toBe("av-godconst");
});

test("a second run changes nothing and does not rewrite the file", () => {
  configureAvGodconst();
  const once = readFileSync(configPath(), "utf8");
  writeFileSync(configPath(), `# kept only if not rewritten\n${once}`);
  logSpy.mockClear();
  configureAvGodconst();
  expect(readFileSync(configPath(), "utf8")).toBe(`# kept only if not rewritten\n${once}`);
  expect(logged()).toBe("→ plugin av-godconst already enabled");
});

test("no config.yaml: written with only the plugin list", () => {
  expect(existsSync(configPath())).toBe(false);
  configureAvGodconst();
  expect(read()).toEqual({ plugins: { enabled: ["av-godconst"] } });
});

test("plugins.disabled is the rollback switch: kept, with a warning", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: [], disabled: ["av-godconst"] } }));
  configureAvGodconst();
  expect(read().plugins.disabled).toEqual(["av-godconst"]);
  expect(logged()).toContain("→ warning: av-godconst is in plugins.disabled; Hermes will not load it");
});

test("an unusable shape is left alone with a warning", () => {
  for (const [text, why] of [
    ["- a\n", "the top level of config.yaml is not a mapping"],
    ["plugins: off\n", "plugins in config.yaml is not a mapping"],
    ["plugins:\n  enabled: av-events\n", "plugins.enabled is not a list"],
  ] as const) {
    logSpy.mockClear();
    writeFileSync(configPath(), text);
    configureAvGodconst();
    expect(readFileSync(configPath(), "utf8")).toBe(text);
    expect(logged()).toBe(`→ warning: ${why}; av-godconst not enabled`);
  }
});

test("install.ts runs the step right after configureAvRate (after rc44's menu step), for a resident only", () => {
  const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const main = text.slice(text.indexOf("function main(): void {"));
  const body = main.slice(0, main.indexOf("\n}\n"));
  expect(body.match(/^.*configureAvGodconst.*$/gm)).toEqual(["  if (resident) configureAvGodconst();"]);
  expect(body).toMatch(/^  configureAvRate\(\);\n  \/\/ GC-TELEGRAM-BALLOT .*\n  if \(resident\) configureAvGodconst\(\);$/m);
});

test("the plugin directory exists where the installer stages plugins from", () => {
  const dir = join(import.meta.dir, "..", "..", "plugins", "av-godconst");
  expect(existsSync(join(dir, "plugin.yaml"))).toBe(true);
  expect(existsSync(join(dir, "__init__.py"))).toBe(true);
});
