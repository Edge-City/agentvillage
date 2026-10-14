// Pins .github/workflows/test.yml's cost controls (ov#340 refute S1): the concurrency block, the absence
// of any workflow-level path filter, and each job's "Scope (pull requests only)" step. The scope steps are
// taken out of the YAML and run in bash with a stand-in `git` that prints a chosen diff, so these tests
// check the shell CI really runs, not a copy of its lists.
//
// Why each pin matters:
// - Tag release (tag-release.yml) trusts main's own successful push run of test.yml at a commit, so a run
//   on main must never be cancelled in progress, and a push or Tag release call must never be scoped.
// - A skipped job must still report its check, so the skip lives in a step, never in `paths-ignore`.
// - Every path a suite reads must run that suite: release/RC-MANIFEST.md (tag-release.test.ts parses it),
//   skills/**/*.md and workspace/*.md (pytest rglobs them), and the root scripts/*.ts (av-approval's
//   custody scan, test_custody.py, reads install/, plugins/, skills/, scripts/ and workspace/).
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const WORKFLOW = join(import.meta.dir, "..", "..", ".github", "workflows", "test.yml");
const wf = parse(readFileSync(WORKFLOW, "utf8"));

type Step = { id?: string; name?: string; run?: string };
function scopeScript(job: string): string {
  const steps: Step[] = wf.jobs?.[job]?.steps ?? [];
  const scope = steps.filter((s) => s.id === "scope");
  expect(scope.length).toBe(1);
  expect(typeof scope[0].run).toBe("string");
  return scope[0].run as string;
}

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wf-scope-"));
  // Stand-in git: prints the file list in $FAKE_DIFF for the scope step's one diff command, fails on demand.
  const git = join(dir, "git");
  writeFileSync(
    git,
    '#!/bin/sh\n' +
      'if [ -n "$FAKE_GIT_FAIL" ]; then exit 128; fi\n' +
      'if [ "$*" = "diff --name-only --no-renames HEAD^1 HEAD" ]; then cat "$FAKE_DIFF"; exit 0; fi\n' +
      'echo "unexpected git call: $*" >&2; exit 2\n',
  );
  chmodSync(git, 0o755);
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function scope(job: string, files: string[], event = "pull_request", gitFails = false): boolean {
  n += 1;
  const diff = join(dir, `diff-${n}`);
  const out = join(dir, `out-${n}`);
  writeFileSync(diff, files.map((f) => `${f}\n`).join(""));
  writeFileSync(out, "");
  const env: Record<string, string> = {
    PATH: `${dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    EVENT: event,
    GITHUB_OUTPUT: out,
    FAKE_DIFF: diff,
  };
  if (gitFails) env.FAKE_GIT_FAIL = "1";
  const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", scopeScript(job)], { env, encoding: "utf8" });
  expect(r.status).toBe(0);
  const lines = readFileSync(out, "utf8").split("\n").filter((l) => l.startsWith("run="));
  expect(lines.length).toBe(1);
  return lines[0] === "run=true";
}

describe("test.yml concurrency", () => {
  test("pull requests and pushes group by ref; a Tag release call gets a group of its own", () => {
    expect(wf.concurrency.group).toBe(
      "${{ (github.event_name == 'pull_request' || github.event_name == 'push') && format('test-{0}', github.ref) || format('test-call-{0}', github.run_id) }}",
    );
  });

  test("only a pull request run is cancelled in progress; a main run never is (Tag release trusts it)", () => {
    expect(wf.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  });
});

describe("test.yml triggers", () => {
  test("no workflow-level path filter: both checks report on every pull request", () => {
    for (const event of ["pull_request", "push"]) {
      const on = wf.on?.[event] ?? {};
      expect(on.paths).toBeUndefined();
      expect(on["paths-ignore"]).toBeUndefined();
    }
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.on.pull_request.types).toEqual(["opened", "synchronize", "reopened", "ready_for_review"]);
  });

  test("no job is skipped by a job-level condition", () => {
    for (const job of ["bun", "pytest"]) expect(wf.jobs[job].if).toBeUndefined();
  });
});

describe("bun job scope", () => {
  const runs = [
    "release/RC-MANIFEST.md",
    "skills/edgeos/SKILL.md",
    "skills/index-network/prompts/brief.md",
    "workspace/AGENTS.md",
    "scripts/tag-release.ts",
    "scripts/tests/tag-release.test.ts",
    "install/install.ts",
    "plugins/av-events/_collector.py",
    ".github/workflows/test.yml",
    ".github/workflows/sync-skills.yml",
    "package.json",
    "bun.lock",
  ];
  const skips = [
    "docs/deployment.md",
    "README.md",
    "LICENSE",
    "pytest.ini",
    "tests/vectors/archive_read.v1.json",
    ".github/SKILLS_SYNC_SETUP.md",
    ".github/instructions/skills.instructions.md",
  ];
  for (const f of runs) test(`a pull request changing ${f} runs the bun suites`, () => expect(scope("bun", [f])).toBe(true));
  for (const f of skips) test(`a pull request changing only ${f} skips the bun suites`, () => expect(scope("bun", [f])).toBe(false));
  test("one read file among skipped ones runs the suites", () => {
    expect(scope("bun", ["docs/deployment.md", "README.md", "release/RC-MANIFEST.md"])).toBe(true);
  });
  test("every skippable file together still skips", () => expect(scope("bun", skips)).toBe(false));
});

describe("pytest job scope", () => {
  const runs = [
    "scripts/tag-release.ts",
    "scripts/sync-india-references.ts",
    "skills/edgeos/SKILL.md",
    "skills/index-network/prompts/brief.md",
    "workspace/AGENTS.md",
    "README.md",
    "tests/vectors/archive_read.v1.json",
    "install/install.ts",
    "plugins/av-events/_collector.py",
    ".github/workflows/test.yml",
  ];
  const skips = [
    "release/RC-MANIFEST.md",
    "scripts/tests/tag-release.test.ts",
    "install/tests/plugin_tools_gated.test.ts",
    "docs/deployment.md",
    "LICENSE",
    ".gitignore",
    "package.json",
    "bun.lock",
    ".github/SKILLS_SYNC_SETUP.md",
    ".github/workflows/tag-release.yml",
  ];
  for (const f of runs) test(`a pull request changing ${f} runs pytest`, () => expect(scope("pytest", [f])).toBe(true));
  for (const f of skips) test(`a pull request changing only ${f} skips pytest`, () => expect(scope("pytest", [f])).toBe(false));
  test("every skippable file together still skips", () => expect(scope("pytest", skips)).toBe(false));
});

describe("only a pull request is ever scoped", () => {
  for (const job of ["bun", "pytest"]) {
    for (const event of ["push", "workflow_dispatch", "workflow_call", "schedule"]) {
      test(`${job}: a ${event} run with a docs-only diff runs the suite`, () => {
        expect(scope(job, ["docs/deployment.md", "LICENSE"], event)).toBe(true);
      });
    }
    test(`${job}: a pull request whose diff cannot be listed runs the suite`, () => {
      expect(scope(job, ["docs/deployment.md"], "pull_request", true)).toBe(true);
    });
  }
});
