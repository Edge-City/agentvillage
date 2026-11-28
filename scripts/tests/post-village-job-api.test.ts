import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JOB_API } from "../../install/zzz_managed_job";
import { cronCreateArgs, DIGEST_CRON_SPECS, KNOWLEDGE_SYNC_JOB, templateCronSpec } from "../../install/install_index";
import { postVillageKeyForJob } from "../../skills/index-network/scripts/post-village-policy";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const baseJob = { id: "aaaaaaaaaaaa", name: "Edge — zzz pairs", script: "zzz_managed_runner.py", no_agent: true, enabled_toolsets: ["village", "no_mcp"], enabled: true, deliver: "local", failure_deliver: "local", schedule: { kind: "cron", expr: "*/5 * * * *" }, repeat: { times: null } };
function runApi(old: unknown, mode = "ok", override: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "av-test-policy-api-")); dirs.push(dir);
  mkdirSync(join(dir, "cron")); writeFileSync(join(dir, "cron/__init__.py"), "");
  const state = join(dir, "state.json"); writeFileSync(state, JSON.stringify({ job: old, calls: [], mode }));
  writeFileSync(join(dir, "cron/jobs.py"), `import json, os\np=os.environ['AV_TEST_STORE']\ndef read():\n with open(p) as f:return json.load(f)\ndef save(s):\n with open(p,'w') as f:json.dump(s,f)\ndef get_job(id):\n return read()['job']\ndef pause_job(id):\n s=read();s['calls'].append('pause')\n if s['mode']!='pause-no-save':s['job']['enabled']=False\n save(s);return s['job']\ndef create_job(**kw):\n s=read();s['calls'].append({'create_paused':kw.get('paused')});s['job']={**kw,'id':'bbbbbbbbbbbb','enabled':not kw.get('paused')};save(s);return s['job']\ndef update_job(id,fields):\n s=read();s['calls'].append('update');s['job'].update(fields);save(s);return s['job']\ndef resume_job(id):\n s=read();s['calls'].append('resume');s['job']['enabled']=True;save(s);return s['job']\ndef remove_job(id):\n s=read();s['calls'].append('remove');s['job']=None;save(s);return True\n`);
  const request = { action: "install", ...(old ? { id: baseJob.id } : {}), name: baseJob.name, script: baseJob.script, prompt: "synthetic prompt", schedule: "*/5 * * * *", toolsets: baseJob.enabled_toolsets, post_village: true, keep_paused: true, accepted_schedules: ["*/5 * * * *"], ...override };
  const result = spawnSync("python3", ["-I", "-c", `import sys;sys.path.insert(0,${JSON.stringify(dir)});\n${JOB_API}`], { input: JSON.stringify(request), encoding: "utf8", timeout: 5000, env: { ...process.env, AV_TEST_STORE: state } });
  return { result, state: JSON.parse(readFileSync(state, "utf8")) };
}
test("every covered default/template is created atomically paused; knowledge sync is unchanged", () => {
  for (const spec of [...DIGEST_CRON_SPECS, templateCronSpec("brief", "0 9 * * *"), templateCronSpec("digest-preview", "0 9 * * *")]) {
    const args = cronCreateArgs(spec, "synthetic", "/synthetic/home");
    expect(args.includes("--paused")).toBe(postVillageKeyForJob(spec.name) !== null);
  }
  const knowledge = DIGEST_CRON_SPECS.find((s) => s.name === KNOWLEDGE_SYNC_JOB)!;
  expect(cronCreateArgs(knowledge, "synthetic", "/synthetic/home")).not.toContain("--paused");
});
test("real embedded API creates OFF job paused, never resumes it", () => {
  const { result, state } = runApi(null); expect(result.status).toBe(0); expect(state.job.enabled).toBe(false); expect(state.calls).toEqual([{ create_paused: true }]);
});
test("real embedded API pauses existing job in place, preserving id and schedule", () => {
  const { result, state } = runApi(baseJob); expect(result.status).toBe(0); expect(state.job.enabled).toBe(false); expect(state.job.id).toBe(baseJob.id); expect(state.job.schedule).toEqual(baseJob.schedule); expect(state.calls).not.toContain("remove"); expect(state.calls).not.toContain("resume");
});
test("failed pause/readback fails without remove, update or resume", () => {
  const { result, state } = runApi(baseJob, "pause-no-save"); expect(result.status).not.toBe(0); expect(result.stdout).toBe(""); expect(state.job).toEqual(baseJob); expect(state.calls).toEqual(["pause"]);
});
test("unsafe existing job is preserved paused and stage fails instead of replacing it", () => {
  const old = { ...baseJob, enabled_toolsets: ["unsafe"] }; const { result, state } = runApi(old); expect(result.status).not.toBe(0); expect(state.job).toEqual({ ...old, enabled: false }); expect(state.calls).toEqual(["pause"]);
});

test("explicit allow never resumes an unsupported custom pair schedule before verification fails", () => {
  const old = { ...baseJob, schedule: { kind: "cron", expr: "17 * * * *" } };
  const { result, state } = runApi(old, "ok", { keep_paused: false }); expect(result.status).not.toBe(0);
  expect(state.job).toEqual({ ...old, enabled: false }); expect(state.calls).toEqual(["pause"]);
});
test("a supported existing autonomy phase is preserved even when the new token selects another phase", () => {
  const old = { ...baseJob, schedule: { kind: "cron", expr: "3-59/5 * * * *" } };
  const { result, state } = runApi(old, "ok", { schedule: "1-59/5 * * * *", accepted_schedules: [0,1,2,3,4].map((phase) => `${phase}-59/5 * * * *`) });
  expect(result.status).toBe(0); expect(state.job.schedule).toEqual(old.schedule); expect(state.job.id).toBe(old.id); expect(state.job.enabled).toBe(false);
});
