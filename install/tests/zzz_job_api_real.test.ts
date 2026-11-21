/** Run the actual embedded JOB_API against the pinned Hermes cron.jobs, not the TS fake. */
import { afterEach, expect, test } from "bun:test";
import { spawnSync, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JOB_API, ZZZ_JOB_NAME, ZZZ_JOB_SCHEDULE, ZZZ_JOB_SCRIPT, ZZZ_JOB_TOOLSETS } from "../zzz_managed_job";

const PIN = "f97608f178d1ffeca59860195ab7da295f7c8e5f"; // Hermes v2026.9.24
const ref = process.env.AV_HERMES_JOBAPI_TEST_DIR ?? "/Users/carter/dev/hermes-agent-ref-v2026.9.24";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function home(): string {
  const root = mkdtempSync(join(tmpdir(), "zzz-real-jobapi-"));
  roots.push(root);
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", ZZZ_JOB_SCRIPT), "# installed runner placeholder\n");
  return root;
}

function python(homeDir: string, code: string, input?: unknown) {
  const env = { ...process.env, HERMES_HOME: homeDir, HOME: homeDir, PYTHONPATH: ref };
  delete env.PYTHONHOME;
  const result = spawnSync("python", ["-c", code], {
    env, input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 60_000,
  });
  return result;
}

function jobs(homeDir: string): Record<string, any>[] {
  return (JSON.parse(readFileSync(join(homeDir, "cron", "jobs.json"), "utf8")) as { jobs: Record<string, any>[] }).jobs;
}

function install(homeDir: string, id?: string) {
  return python(homeDir, JOB_API, { action: "install", name: ZZZ_JOB_NAME,
    prompt: "Managed private-pair participation", script: ZZZ_JOB_SCRIPT,
    schedule: ZZZ_JOB_SCHEDULE, toolsets: [...ZZZ_JOB_TOOLSETS], home: homeDir,
    ...(id ? { id } : {}) });
}

function create(homeDir: string, options: Record<string, unknown>): string {
  const result = python(homeDir, `import json\nfrom cron.jobs import create_job\nprint(create_job(**json.load(__import__('sys').stdin))['id'])`, options);
  expect(result.status).toBe(0);
  return result.stdout.trim();
}

function expectManaged(job: Record<string, any>): void {
  expect(job).toMatchObject({ name: ZZZ_JOB_NAME, script: ZZZ_JOB_SCRIPT, no_agent: true,
    enabled: true, enabled_toolsets: [...ZZZ_JOB_TOOLSETS], deliver: "local", failure_deliver: "local" });
  expect(job.schedule).toMatchObject({ kind: "cron", expr: ZZZ_JOB_SCHEDULE });
  expect(job.repeat.times).toBeNull();
  expect(job.workdir).toBeNull();
  expect(job.skills).toEqual([]);
  expect(job.skill).toBeNull();
  expect(job.context_from).toBeNull();
  expect(job.monitor_script).toBeNull();
  expect(job.monitor_url).toBeNull();
  expect(job.prompt).toBe("Managed private-pair participation");
}

test.skipIf(!existsSync(join(ref, "cron", "jobs.py")) && !process.env.AV_HERMES_JOBAPI_TEST_DIR)(
  "embedded ZZZ JOB_API rotates unsafe Hermes jobs and preserves unrelated jobs", () => {
    expect(existsSync(join(ref, "cron", "jobs.py"))).toBe(true);
    expect(execFileSync("git", ["-C", ref, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()).toBe(PIN);

    const fresh = home();
    const resident = create(fresh, { prompt: "mine", schedule: "0 9 * * *", name: "My reminder" });
    expect(install(fresh).status).toBe(0);
    const first = jobs(fresh).find((job) => job.name === ZZZ_JOB_NAME)!;
    expectManaged(first);
    expect(jobs(fresh).some((job) => job.id === resident)).toBe(true);
    expect(install(fresh, first.id).status).toBe(0);
    expect(jobs(fresh).find((job) => job.name === ZZZ_JOB_NAME)?.id).toBe(first.id);

    // Each record is runnable by Hermes but rejected by the managed runner. Reusing
    // its ID would keep a live unsafe cron snapshot; the old ID must disappear.
    for (const override of [
      { deliver: "telegram:1" },
      { schedule: "* * * * *" },
      { skills: ["zzzbot"] },
      { no_agent: false },
    ]) {
      const box = home();
      const old = create(box, { prompt: "old", schedule: ZZZ_JOB_SCHEDULE,
        name: ZZZ_JOB_NAME, script: ZZZ_JOB_SCRIPT, no_agent: true,
        enabled_toolsets: [...ZZZ_JOB_TOOLSETS], deliver: "local", failure_deliver: "local", ...override });
      expect(install(box, old).status).toBe(0);
      const managed = jobs(box).filter((job) => job.name === ZZZ_JOB_NAME);
      expect(managed).toHaveLength(1);
      expect(managed[0].id).not.toBe(old);
      expect(jobs(box).some((job) => job.id === old)).toBe(false);
      expectManaged(managed[0]);
    }

    const wrong = python(fresh, JOB_API, { action: "remove", id: resident, name: ZZZ_JOB_NAME });
    expect(wrong.status).not.toBe(0);
    expect(jobs(fresh).some((job) => job.id === resident)).toBe(true);
    expect(python(fresh, JOB_API, { action: "remove", id: first.id, name: ZZZ_JOB_NAME }).status).toBe(0);
    expect(jobs(fresh).map((job) => job.id)).toEqual([resident]);
  }, 120_000);
