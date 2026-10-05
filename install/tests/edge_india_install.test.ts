import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

import { EDGE_SKILL_NAMES, REPLACED_SKILL_DIRS } from "../paths";
import { copySkillBundles } from "../skill_copy";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKILLS = join(REPO_ROOT, "skills");
const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function files(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? files(join(dir, entry.name), rel) : [rel];
  });
}

function snapshotPaths(): string[] {
  const snapshot = JSON.parse(readFileSync(join(SKILLS, "edge-india", "references", "SNAPSHOT.json"), "utf8"));
  return snapshot.files.map((file: { path: string }) => file.path);
}

test("edge-india is a registered bundle, separate from the Esmeralda ones", () => {
  expect(EDGE_SKILL_NAMES).toContain("edge-india");
  expect(EDGE_SKILL_NAMES).toContain("edge-esmeralda");
  expect(REPLACED_SKILL_DIRS).toContain("edge-india/references");
  expect(existsSync(join(SKILLS, "edge-india", "SKILL.md"))).toBe(true);
  const skill = readFileSync(join(SKILLS, "edge-india", "SKILL.md"), "utf8");
  expect(skill).toMatch(/^---\nname: edge-india-2026\n/);
});

test("the committed India snapshot is complete: SNAPSHOT.json lists exactly the files present, nested ones included", () => {
  const present = files(join(SKILLS, "edge-india", "references")).filter((path) => path !== "SNAPSHOT.json").sort();
  expect(present).toEqual(snapshotPaths().sort());
  expect(present).toContain("index.md");
  expect(present).toContain("newsletter/housing-for-edge-city-india.md");
  expect(present.some((path) => path.startsWith("residencies/"))).toBe(true);
  expect(present.some((path) => path.startsWith("website/"))).toBe(true);
});

test("copySkillBundles stages the India skill with its nested references into a fresh home", () => {
  const target = join(temp("agentvillage-india-skills-"), "skills");
  copySkillBundles(SKILLS, target);
  for (const path of snapshotPaths()) {
    expect(existsSync(join(target, "edge-india", "references", path))).toBe(true);
  }
  expect(existsSync(join(target, "edge-india", "scripts", "refs.ts"))).toBe(true);
  expect(existsSync(join(target, "edge-esmeralda", "references", "wiki-content.md"))).toBe(true);
});

test("an update removes India documents dropped upstream but keeps other skills' extra files", () => {
  const target = join(temp("agentvillage-india-update-"), "skills");
  copySkillBundles(SKILLS, target);
  const stale = join(target, "edge-india", "references", "newsletter", "retracted-article.md");
  writeFileSync(stale, "# Retracted\n");
  const residentNote = join(target, "edge-esmeralda", "local-note.md");
  writeFileSync(residentNote, "kept\n");

  copySkillBundles(SKILLS, target);

  expect(existsSync(stale)).toBe(false);
  expect(existsSync(residentNote)).toBe(true);
  expect(existsSync(join(target, "edge-india", "references", "index.md"))).toBe(true);
});

test("a source without the references directory never empties an installed copy", () => {
  const root = temp("agentvillage-india-partial-");
  const source = join(root, "src");
  const target = join(root, "skills");
  mkdirSync(join(source, "edge-india"), { recursive: true });
  writeFileSync(join(source, "edge-india", "SKILL.md"), "---\nname: edge-india-2026\n---\n");
  mkdirSync(join(target, "edge-india", "references"), { recursive: true });
  writeFileSync(join(target, "edge-india", "references", "index.md"), "# kept\n");

  copySkillBundles(source, target, ["edge-india"]);

  expect(readFileSync(join(target, "edge-india", "references", "index.md"), "utf8")).toBe("# kept\n");
});

test("the installer puts the India skill and every snapshot file into a temporary Hermes home", () => {
  const home = temp("agentvillage-india-home-");
  const fakeHermes = join(home, "fake-hermes");
  writeFileSync(fakeHermes, "#!/bin/sh\nexit 127\n");
  chmodSync(fakeHermes, 0o755);

  const run = Bun.spawnSync({
    cmd: ["bun", join(REPO_ROOT, "install", "install.ts"), "--no-restart", "--skip-crons", "--skip-index"],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: fakeHermes },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(run.exitCode).toBe(0);
  for (const path of snapshotPaths()) {
    expect(existsSync(join(home, "skills", "edge-india", "references", path))).toBe(true);
  }
  const agents = readFileSync(join(home, "AGENTS.md"), "utf8");
  expect(agents).toContain("`edge-india`");
});
