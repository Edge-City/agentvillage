/**
 * DATA-360: the installer removes the skill bundles this repo no longer ships
 * (`RETIRED_SKILL_DIRS`) from `$HERMES_HOME/skills/` on every install and
 * update, and never touches a skill on neither list.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, expect, test } from "bun:test";

import { EDGE_SKILL_NAMES, RETIRED_SKILL_DIRS } from "../paths";
import { removeRetiredSkillDirs } from "../skill_copy";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const temps: string[] = [];

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A skill dir with a SKILL.md and one nested file, as Hermes would see it. */
function skill(root: string, name: string): string {
  const dir = join(root, name);
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\n---\n`);
  writeFileSync(join(dir, "references", "notes.md"), "kept\n");
  return dir;
}

function collect(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line: string) => lines.push(line) };
}

test("geo-esmeralda is retired, and no name is both shipped and retired", () => {
  expect(RETIRED_SKILL_DIRS).toContain("geo-esmeralda");
  const shipped = new Set<string>(EDGE_SKILL_NAMES);
  expect(RETIRED_SKILL_DIRS.filter((name) => shipped.has(name))).toEqual([]);
  // edge-esmeralda stays installed as background (orchestrator's call).
  expect(EDGE_SKILL_NAMES).toContain("edge-esmeralda");
  expect(RETIRED_SKILL_DIRS as readonly string[]).not.toContain("edge-esmeralda");
});

test("every retired name is one plain directory name", () => {
  for (const name of RETIRED_SKILL_DIRS) {
    expect(name).toMatch(/^[a-z0-9][a-z0-9-]*$/);
  }
});

test("a retired skill dir is removed, logged once with its name, and returned", () => {
  const root = temp("av-skills-");
  skill(root, "geo-esmeralda");
  const { lines, log } = collect();

  const removed = removeRetiredSkillDirs(root, RETIRED_SKILL_DIRS, log);

  expect(removed).toEqual(["geo-esmeralda"]);
  expect(existsSync(join(root, "geo-esmeralda"))).toBe(false);
  expect(lines).toEqual([`→ removed retired skill geo-esmeralda from ${root}`]);
});

test("a second run removes nothing and logs nothing", () => {
  const root = temp("av-skills-");
  skill(root, "geo-esmeralda");
  removeRetiredSkillDirs(root, RETIRED_SKILL_DIRS, () => {});
  const { lines, log } = collect();

  expect(removeRetiredSkillDirs(root, RETIRED_SKILL_DIRS, log)).toEqual([]);
  expect(lines).toEqual([]);
});

test("a missing skills root is not an error and is not created", () => {
  const root = join(temp("av-skills-"), "skills");
  const { lines, log } = collect();
  expect(removeRetiredSkillDirs(root, RETIRED_SKILL_DIRS, log)).toEqual([]);
  expect(lines).toEqual([]);
  expect(existsSync(root)).toBe(false);
});

test("Hermes bundled skills, a resident's own skill and every shipped Edge skill survive", () => {
  const root = temp("av-skills-");
  const kept = ["apple", "devops", "email", "github", "my-notes", ...EDGE_SKILL_NAMES];
  for (const name of kept) skill(root, name);
  skill(root, "geo-esmeralda");
  writeFileSync(join(root, ".bundled_manifest"), "apple\ndevops\n");

  removeRetiredSkillDirs(root, RETIRED_SKILL_DIRS, () => {});

  for (const name of kept) {
    expect(readFileSync(join(root, name, "references", "notes.md"), "utf8")).toBe("kept\n");
  }
  expect(existsSync(join(root, ".bundled_manifest"))).toBe(true);
  expect(existsSync(join(root, "geo-esmeralda"))).toBe(false);
});

test("a name still shipped in EDGE_SKILL_NAMES is never removed, even if passed in", () => {
  const root = temp("av-skills-");
  skill(root, "edge-esmeralda");
  const { lines, log } = collect();

  expect(removeRetiredSkillDirs(root, ["edge-esmeralda"], log)).toEqual([]);
  expect(existsSync(join(root, "edge-esmeralda", "SKILL.md"))).toBe(true);
  expect(lines).toEqual([]);
});

test("a name with a path separator or .. is refused and nothing outside the root is touched", () => {
  const base = temp("av-home-");
  const root = join(base, "skills");
  mkdirSync(root);
  skill(base, "outside");
  skill(root, "inner");
  mkdirSync(join(root, "inner", "geo"), { recursive: true });
  const { lines, log } = collect();

  const bad = ["../outside", "..", ".", "", "inner/geo", "inner\\geo", `${base}/outside`, "/etc"];
  expect(removeRetiredSkillDirs(root, bad, log)).toEqual([]);

  expect(existsSync(join(base, "outside", "SKILL.md"))).toBe(true);
  expect(existsSync(join(root, "inner", "geo"))).toBe(true);
  expect(existsSync(root)).toBe(true);
  expect(lines).toHaveLength(bad.length);
  for (const line of lines) expect(line).toStartWith("  warning: refused retired skill name ");
});

test("a retired name that is a symlink is unlinked; what it points at stays", () => {
  const base = temp("av-home-");
  const root = join(base, "skills");
  mkdirSync(root);
  const elsewhere = skill(base, "elsewhere");
  symlinkSync(elsewhere, join(root, "geo-esmeralda"));
  // A dangling link is removed too.
  const root2 = join(base, "skills2");
  mkdirSync(root2);
  symlinkSync(join(base, "gone"), join(root2, "geo-esmeralda"));

  expect(removeRetiredSkillDirs(root, RETIRED_SKILL_DIRS, () => {})).toEqual(["geo-esmeralda"]);
  expect(removeRetiredSkillDirs(root2, RETIRED_SKILL_DIRS, () => {})).toEqual(["geo-esmeralda"]);

  expect(existsSync(join(root, "geo-esmeralda"))).toBe(false);
  expect(readFileSync(join(elsewhere, "references", "notes.md"), "utf8")).toBe("kept\n");
});

test("install.ts over a home holding skills/geo-esmeralda ends without it and keeps a Hermes skill", () => {
  const home = temp("av-retired-home-");
  const fakeHermes = join(home, "fake-hermes");
  writeFileSync(fakeHermes, "#!/bin/sh\nexit 127\n");
  chmodSync(fakeHermes, 0o755);
  skill(join(home, "skills"), "geo-esmeralda");
  skill(join(home, "skills"), "apple");

  const run = Bun.spawnSync({
    cmd: ["bun", join(REPO_ROOT, "install", "install.ts"), "--no-restart", "--skip-crons", "--skip-index"],
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: fakeHermes },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(run.exitCode).toBe(0);
  const stdout = run.stdout.toString();
  expect(stdout).toContain(`→ removed retired skill geo-esmeralda from ${join(home, "skills")}`);
  expect(existsSync(join(home, "skills", "geo-esmeralda"))).toBe(false);
  expect(existsSync(join(home, "skills", "apple", "SKILL.md"))).toBe(true);
  expect(existsSync(join(home, "skills", "edge-india", "SKILL.md"))).toBe(true);
});
