import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import YAML from "yaml";

import { recallChoice } from "../config";
import { installRecall } from "../install_recall";

const SOURCE_SKILLS = join(import.meta.dir, "..", "..", "skills");
const ORIGINAL_ENV = {
  HERMES_HOME: process.env.HERMES_HOME,
  AV_RECALL_ENABLED: process.env.AV_RECALL_ENABLED,
};
const homes: string[] = [];

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function tenant(enabled: string[] = ["av-events"]): string {
  const home = mkdtempSync(join(tmpdir(), "agentvillage-recall-"));
  homes.push(home);
  process.env.HERMES_HOME = home;
  writeFileSync(join(home, "config.yaml"), YAML.stringify({ plugins: { enabled } }));
  return home;
}

function enabledPlugins(home: string): string[] {
  const doc = YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")) as { plugins?: { enabled?: string[] } };
  return doc.plugins?.enabled ?? [];
}

test("recallChoice reads AV_RECALL_ENABLED as on, off, or unset", () => {
  delete process.env.AV_RECALL_ENABLED;
  expect(recallChoice()).toBeNull();
  process.env.AV_RECALL_ENABLED = "  ";
  expect(recallChoice()).toBeNull();
  process.env.AV_RECALL_ENABLED = "1";
  expect(recallChoice()).toBe(true);
  process.env.AV_RECALL_ENABLED = "OFF";
  expect(recallChoice()).toBe(false);
});

test("a tenant that never opted in gets nothing", () => {
  const home = tenant();
  delete process.env.AV_RECALL_ENABLED;
  installRecall(SOURCE_SKILLS);
  expect(enabledPlugins(home)).toEqual(["av-events"]);
  expect(existsSync(join(home, "skills", "recall"))).toBe(false);
});

test("opting in enables the plugin and stages the skill without tests or fixtures", () => {
  const home = tenant();
  process.env.AV_RECALL_ENABLED = "1";
  installRecall(SOURCE_SKILLS);
  installRecall(SOURCE_SKILLS);
  expect(enabledPlugins(home)).toEqual(["av-events", "recall"]);
  const skill = join(home, "skills", "recall");
  expect(existsSync(join(skill, "SKILL.md"))).toBe(true);
  expect(existsSync(join(skill, "scripts", "recall.ts"))).toBe(true);
  expect(existsSync(join(skill, "scripts", "tests"))).toBe(false);
});

test("opting out disables the plugin, removes the skill, and deletes the derived index", () => {
  const home = tenant();
  process.env.AV_RECALL_ENABLED = "1";
  installRecall(SOURCE_SKILLS);
  mkdirSync(join(home, ".recall"), { recursive: true });
  writeFileSync(join(home, ".recall", "index.sqlite"), "derived");
  mkdirSync(join(home, "memory"), { recursive: true });
  writeFileSync(join(home, "memory", "2026-09-22.md"), "- a note");

  process.env.AV_RECALL_ENABLED = "0";
  installRecall(SOURCE_SKILLS);
  expect(enabledPlugins(home)).toEqual(["av-events"]);
  expect(existsSync(join(home, "skills", "recall"))).toBe(false);
  expect(existsSync(join(home, ".recall"))).toBe(false);
  // The attendee's own notes are untouched.
  expect(readFileSync(join(home, "memory", "2026-09-22.md"), "utf8")).toBe("- a note");
});
