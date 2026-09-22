import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, test } from "bun:test";
import YAML from "yaml";

import { recallChoice } from "../config";
import { installRecall, recallInstallFailures, resetRecall, safeInstallRecall, wipeRecallIndex } from "../install_recall";

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

test("recallChoice: only 1|true|yes|on is on, blank or unset is no choice, anything else is off", () => {
  tenant();
  delete process.env.AV_RECALL_ENABLED;
  expect(recallChoice()).toBeNull();
  process.env.AV_RECALL_ENABLED = "  ";
  expect(recallChoice()).toBeNull();
  for (const on of ["1", "true", "YES", " On "]) {
    process.env.AV_RECALL_ENABLED = on;
    expect(recallChoice()).toBe(true);
  }
  for (const off of ["0", "OFF", "disabled", "n", "none", "null", "enable"]) {
    process.env.AV_RECALL_ENABLED = off;
    expect(recallChoice()).toBe(false);
  }
});

test("recallChoice falls back to $HERMES_HOME/.env when the variable is absent from the environment", () => {
  const home = tenant();
  delete process.env.AV_RECALL_ENABLED;
  writeFileSync(join(home, ".env"), "OTHER=1\nexport AV_RECALL_ENABLED=\"1\"  \n");
  expect(recallChoice()).toBe(true);
  writeFileSync(join(home, ".env"), "AV_RECALL_ENABLED=1\nAV_RECALL_ENABLED=off # changed my mind\n");
  expect(recallChoice()).toBe(false);
  // Present in the environment (even blank) wins over the file.
  process.env.AV_RECALL_ENABLED = "";
  expect(recallChoice()).toBeNull();
});

test("the sidecar /update path honours an opt-in written only to .env", () => {
  const home = tenant();
  delete process.env.AV_RECALL_ENABLED;
  writeFileSync(join(home, ".env"), "AV_RECALL_ENABLED=yes\n");
  installRecall(SOURCE_SKILLS);
  expect(enabledPlugins(home)).toEqual(["av-events", "recall"]);
  expect(existsSync(join(home, "skills", "recall", "SKILL.md"))).toBe(true);
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
  expect(existsSync(join(home, ".recall", "index.sqlite"))).toBe(false);
  // The attendee's own notes are untouched.
  expect(readFileSync(join(home, "memory", "2026-09-22.md"), "utf8")).toBe("- a note");
});


test("opting out keeps the --wipe-user epoch, so a later opt-in still excludes old conversations", () => {
  const home = tenant();
  wipeRecallIndex(new Date("2026-10-11T00:00:00Z"));
  writeFileSync(join(home, ".recall", "index.sqlite"), "derived");
  process.env.AV_RECALL_ENABLED = "0";
  installRecall(SOURCE_SKILLS);
  expect(existsSync(join(home, ".recall", "index.sqlite"))).toBe(false);
  expect(readFileSync(join(home, ".recall", "epoch"), "utf8").trim()).toBe(String(Date.parse("2026-10-11T00:00:00Z") / 1000));
});

test("--wipe-user replaces the index with a fresh epoch marker", () => {
  const home = tenant();
  mkdirSync(join(home, ".recall"), { recursive: true });
  writeFileSync(join(home, ".recall", "index.sqlite"), "old occupant");
  writeFileSync(join(home, ".recall", "query-hash.key"), "a".repeat(64));
  const before = Date.now() / 1000;
  wipeRecallIndex();
  expect(existsSync(join(home, ".recall", "index.sqlite"))).toBe(false);
  expect(existsSync(join(home, ".recall", "query-hash.key"))).toBe(false);
  const epoch = Number(readFileSync(join(home, ".recall", "epoch"), "utf8"));
  expect(epoch).toBeGreaterThanOrEqual(Math.floor(before));
});

test("reset removes recall from plugins.enabled and, with --wipe-user, resets the index", () => {
  const home = tenant(["av-events", "recall", "dashboard-auth-edgecity"]);
  mkdirSync(join(home, ".recall"), { recursive: true });
  writeFileSync(join(home, ".recall", "index.sqlite"), "derived");
  writeFileSync(join(home, ".recall", "epoch"), "1760140800\n");
  resetRecall(false);
  expect(enabledPlugins(home)).toEqual(["av-events", "dashboard-auth-edgecity"]);
  expect(existsSync(join(home, ".recall", "index.sqlite"))).toBe(false);
  expect(readFileSync(join(home, ".recall", "epoch"), "utf8")).toBe("1760140800\n");
  resetRecall(true);
  expect(existsSync(join(home, ".recall", "epoch"))).toBe(true);
});

test("an opt-in failure never aborts the core install", () => {
  const home = tenant();
  writeFileSync(join(home, "config.yaml"), "plugins: [unclosed\n  - {\n");
  process.env.AV_RECALL_ENABLED = "1";
  const before = recallInstallFailures;
  expect(() => safeInstallRecall(SOURCE_SKILLS)).not.toThrow();
  expect(safeInstallRecall(SOURCE_SKILLS)).toBe(false);
  expect(recallInstallFailures).toBe(before + 2);
});

test("install.ts calls the guarded opt-in step, not the throwing one", () => {
  const source = readFileSync(join(import.meta.dir, "..", "install.ts"), "utf8");
  expect(source).toContain("safeInstallRecall(SOURCE_SKILLS)");
  expect(source).not.toMatch(/\binstallRecall\(/);
});
