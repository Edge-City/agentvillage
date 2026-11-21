/**
 * Suggestion rating cards (plugins/av-rate): the installer lists `av-rate` in plugins.enabled and
 * allows it to inject the recorded rating into the resident's session
 * (plugins.entries.av-rate.allow_gateway_injection: true, Hermes's gate on ctx.inject_message).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { AV_RATE_PLUGIN, configureAvRate } from "../av_rate";

const ORIGINAL_HOME = process.env.HERMES_HOME;
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-av-rate-"));
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

test("appended to plugins.enabled and allowed to inject, the rest of the file kept", () => {
  writeFileSync(configPath(), YAML.stringify({ model: { default: "m" }, plugins: { enabled: ["av-events", "av-vote"], hook_callback_timeout: 600 } }));
  configureAvRate();
  expect(read()).toEqual({
    model: { default: "m" },
    plugins: { enabled: ["av-events", "av-vote", "av-rate"], hook_callback_timeout: 600, entries: { "av-rate": { allow_gateway_injection: true } } },
  });
  expect(logged()).toBe("→ enabled plugin av-rate (suggestion rating cards; the recorded rating is handed to the agent)");
});

test("a second run changes nothing and does not rewrite the file", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: ["av-rate"], entries: { "av-rate": { allow_gateway_injection: true, other: 1 } } } }));
  const before = readFileSync(configPath(), "utf8");
  configureAvRate();
  expect(readFileSync(configPath(), "utf8")).toBe(before);
  expect(logged()).toBe("→ plugin av-rate already enabled");
});

test("enabled but not yet allowed to inject: the entry is added, other entries kept", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: ["av-rate"], entries: { "av-vote": { x: 1 } } } }));
  configureAvRate();
  expect(read().plugins).toEqual({ enabled: ["av-rate"], entries: { "av-vote": { x: 1 }, "av-rate": { allow_gateway_injection: true } } });
});

test("no config.yaml: written with the plugin list and the entry", () => {
  configureAvRate();
  expect(read()).toEqual({ plugins: { enabled: ["av-rate"], entries: { "av-rate": { allow_gateway_injection: true } } } });
});

test("plugins.disabled is the rollback switch: kept, with a warning", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: [], disabled: ["av-rate"] } }));
  configureAvRate();
  expect(read().plugins.disabled).toEqual(["av-rate"]);
  expect(logged()).toContain("→ warning: av-rate is in plugins.disabled; Hermes will not load it");
});

test("an unusable shape is left alone with a warning", () => {
  writeFileSync(configPath(), YAML.stringify({ plugins: { enabled: "av-events" } }));
  const before = readFileSync(configPath(), "utf8");
  configureAvRate();
  expect(readFileSync(configPath(), "utf8")).toBe(before);
  expect(logged()).toBe("→ warning: plugins.enabled is not a list; av-rate not enabled");
});

test("install.ts runs the step right after configureVillageMenu, as a bare statement in main()", () => {
  const text = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  const main = text.slice(text.indexOf("function main(): void {"));
  const body = main.slice(0, main.indexOf("\n}\n"));
  expect(body.match(/^.*configureAvRate.*$/gm)).toEqual(["  configureAvRate();"]);
  expect(body).toMatch(/^  configureVillageMenu\(\);\n(?:  \/\/.*\n)?  configureAvRate\(\);$/m);
});

test("the plugin directory exists where the installer stages plugins from", () => {
  const dir = join(import.meta.dir, "..", "..", "plugins", AV_RATE_PLUGIN);
  expect(existsSync(join(dir, "plugin.yaml"))).toBe(true);
  expect(existsSync(join(dir, "__init__.py"))).toBe(true);
});
