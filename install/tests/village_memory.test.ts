/**
 * D3: the installer activates the `village-memory` memory provider (`memory.provider`), keeps every
 * other `memory` key, never lists it in `plugins.enabled`, and takes it out of `plugins.disabled`.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import YAML from "yaml";

import { copyPluginTree } from "../plugin_copy";
import { configureVillageMemory, safeConfigureVillageMemory, VILLAGE_MEMORY_PROVIDER } from "../village_memory";

const ORIGINAL_HOME = process.env.HERMES_HOME;
const SOURCE = join(import.meta.dir, "..", "..", "plugins", "village-memory");
let home: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "agentvillage-village-memory-"));
  process.env.HERMES_HOME = home;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  copyPluginTree(SOURCE, join(home, "plugins", VILLAGE_MEMORY_PROVIDER));
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

test("sets memory.provider, keeps the cp's memory limits, never touches plugins.enabled", () => {
  writeFileSync(configPath(), YAML.stringify({
    model: { context_length: 90000 },
    memory: { user_char_limit: 24000, memory_char_limit: 2200 },
    plugins: { enabled: ["av-events"] },
  }));
  expect(configureVillageMemory()).toBe("set");
  expect(read()).toEqual({
    model: { context_length: 90000 },
    memory: { user_char_limit: 24000, memory_char_limit: 2200, provider: "village-memory" },
    plugins: { enabled: ["av-events"] },
  });
  expect(logged()).toBe("→ set memory.provider: village-memory");
});

test("a fresh config gets a memory section; a second run changes nothing and does not rewrite the file", () => {
  expect(configureVillageMemory()).toBe("set");
  expect(read()).toEqual({ memory: { provider: "village-memory" } });
  const once = readFileSync(configPath(), "utf8");
  writeFileSync(configPath(), `# kept only if not rewritten\n${once}`);
  expect(configureVillageMemory()).toBe("kept");
  expect(readFileSync(configPath(), "utf8")).toBe(`# kept only if not rewritten\n${once}`);
});

test("every run sets it, replacing another provider", () => {
  writeFileSync(configPath(), YAML.stringify({ memory: { provider: "honcho" } }));
  expect(configureVillageMemory()).toBe("set");
  expect(read().memory.provider).toBe("village-memory");
  expect(logged()).toContain("(replaced another provider)");
});

test("a plugins.disabled entry is removed (Hermes refuses a disabled provider); other entries stay", () => {
  writeFileSync(configPath(), YAML.stringify({ memory: { provider: "village-memory" }, plugins: { disabled: ["x", "village-memory"] } }));
  expect(configureVillageMemory()).toBe("set");
  expect(read()).toEqual({ memory: { provider: "village-memory" }, plugins: { disabled: ["x"] } });
});

test("no staged plugin: left alone (Hermes would look for the name in its catalog)", () => {
  rmSync(join(home, "plugins"), { recursive: true, force: true });
  writeFileSync(configPath(), YAML.stringify({ memory: { user_char_limit: 24000 } }));
  expect(configureVillageMemory()).toBe("skipped");
  expect(read()).toEqual({ memory: { user_char_limit: 24000 } });
});

test("unusable shapes are left alone with a warning, and the safe wrapper never throws", () => {
  writeFileSync(configPath(), YAML.stringify({ memory: "builtin" }));
  expect(configureVillageMemory()).toBe("skipped");
  expect(read()).toEqual({ memory: "builtin" });
  writeFileSync(configPath(), "memory: [unclosed\n");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    expect(safeConfigureVillageMemory()).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("the staged copy holds only the runtime: no tests (copyPluginTree), one top-level .py", () => {
  const staged = join(home, "plugins", VILLAGE_MEMORY_PROVIDER);
  mkdirSync(staged, { recursive: true });
  const names = require("node:fs").readdirSync(staged).sort();
  expect(names).toEqual(["README.md", "__init__.py", "plugin.yaml"]);
});
