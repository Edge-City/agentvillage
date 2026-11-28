import { runPauseJob } from "../../skills/index-network/scripts/pause-job";
import { runnablePins } from "../post_village_runnable_pins";
import pins from "../../skills/index-network/scripts/post-village-runnable-pins.json";
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { runJobsCommand } from "../jobs";
const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture(currentGate: boolean, optIn = true, unrelated = false) {
  const home = mkdtempSync(join(tmpdir(), "av-test-post-village-enable-")); roots.push(home); const repo = join(import.meta.dir, "../..");
  mkdirSync(join(home, "cron")); mkdirSync(join(home, "av-events")); writeFileSync(join(home, "config.yaml"), "timezone: Asia/Kolkata\n");
  if (optIn) writeFileSync(join(home, "av-events/post-village-policy.json"), '{"version":1,"enabled":["daily_digest"]}');
  const job = { id: "aaaaaaaaaaaa", name: "Edge — daily digest", enabled: false, state: "paused", next_run_at: "2099-01-01T00:00:00Z", schedule: { kind: "cron", expr: "0 8 * * *" }, prompt: currentGate ? readFileSync(join(repo, "skills/index-network/prompts/brief.md"), "utf8").trimEnd() : "old prompt without guard", ...(currentGate ? { script: "agentvillage_proactive_brief.sh", no_agent: false, failure_deliver: "local" } : {}) };
  const path = join(home, "cron/jobs.json"); writeFileSync(path, JSON.stringify({ jobs: [job, ...(unrelated ? [{ name: { toString: {} }, id: {} }] : [])] }));
  if (currentGate) {
    for (const relative of ["skills/index-network/scripts/post-village-policy.ts", "skills/index-network/scripts/job-holds.ts", "skills/index-network/scripts/proactive.ts", "skills/index-network/scripts/post-village-runnable.ts", "skills/index-network/scripts/send-daily-brief.ts", "skills/index-network/scripts/drop-opportunity.ts", "skills/index-network/scripts/pending-alert.ts", "skills/index-network/scripts/summarize-negotiations.ts"]) { const target = join(home, relative); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repo, relative), target); }
    mkdirSync(join(home, "scripts")); copyFileSync(join(repo, "skills/index-network/scripts/shims/agentvillage_proactive.sh"), join(home, "scripts/agentvillage_proactive_brief.sh"));
  }
  const calls: string[][] = [];
  const run = (enabled: boolean, beforeReady?: () => void) => runJobsCommand(["set", "--job", "brief", "--enabled", String(enabled)], { home, hermesReady: () => { beforeReady?.(); return true; }, hermes: (args) => { calls.push(args); const store = JSON.parse(readFileSync(path, "utf8")); Object.assign(store.jobs[0], { enabled: args[1] === "resume", state: args[1] === "resume" ? "scheduled" : "paused", paused_at: args[1] === "resume" ? null : "2026-11-28T00:00:00Z" }); writeFileSync(path, JSON.stringify(store)); }, now: new Date("2026-11-28T00:00:00Z") });
  return { home, path, calls, run };
}
test("explicit policy cannot enable a stale prompt-only job; refusal precedes mutation", () => {
  const f = fixture(false); const before = readFileSync(f.path, "utf8"); const result = f.run(true); expect(result.code).toBe(2); expect(result.out.error).toBe("post-village-gates-unverified"); expect(f.calls).toEqual([]); expect(readFileSync(f.path, "utf8")).toBe(before); expect(existsSync(join(f.home, "av-events/job-settings.json"))).toBe(false);
});
test("current installed gated job enables only with explicit operator policy", () => {
  const f = fixture(true); expect(f.run(true).code).toBe(0); expect(f.calls[0]).toEqual(["cron", "resume", "aaaaaaaaaaaa"]);
  const off = fixture(true, false); expect(off.run(true).code).toBe(2); expect(off.calls).toEqual([]);
});
test("resident/admin hold still blocks a current explicitly allowed job", () => {
  const f = fixture(true); const holds = '{"holds":{"aaaaaaaaaaaa":"paused"},"by":{"aaaaaaaaaaaa":"admin"}}'; writeFileSync(join(f.home, "av-events/job-holds.json"), holds);
  expect(f.run(true).code).toBe(2); expect(f.calls).toEqual([]); expect(readFileSync(join(f.home, "av-events/job-holds.json"), "utf8")).toBe(holds);
});
test("one targeted enable does not become a whole-store unrelated-job audit", () => { const f = fixture(true, true, true); expect(f.run(true).code).toBe(0); });
test("pause remains available without an operator allow or current runnable shim", () => {
  const f = fixture(false, false); const store = JSON.parse(readFileSync(f.path, "utf8")); Object.assign(store.jobs[0], { enabled: true, state: "scheduled" }); writeFileSync(f.path, JSON.stringify(store));
  expect(f.run(false).code).toBe(0); expect(f.calls[0]).toEqual(["cron", "pause", "aaaaaaaaaaaa"]);
});

test("guard revocation after the first check is rechecked before resume", () => {
  const f = fixture(true); const before = readFileSync(f.path, "utf8");
  const result = f.run(true, () => rmSync(join(f.home, "scripts/agentvillage_proactive_brief.sh")));
  expect(result.code).toBe(1); expect(result.out.error).toBe("post-village-gates-unverified"); expect(f.calls).toEqual([]); expect(readFileSync(f.path, "utf8")).toBe(before);
});

test("shipped pure runnable proof pins match reviewed source", () => { expect(pins).toEqual(runnablePins()); });
for (const scenario of ["off", "old", "resident", "admin", "revoke", "stale", "admin-late"] as const) test(`resident resume policy and installed proof: ${scenario}`, () => {
  const f = fixture(scenario !== "old", scenario !== "off");
  const holds = join(f.home, "av-events/job-holds.json");
  const original = JSON.stringify({ holds: { aaaaaaaaaaaa: "paused" }, by: { aaaaaaaaaaaa: scenario === "admin" ? "admin" : "resident" } });
  writeFileSync(holds, original);
  writeFileSync(join(f.home, "av-events/installed_jobs.json"), JSON.stringify({ ids: ["aaaaaaaaaaaa"] }));
  let ready = 0;
  const result = runPauseJob(["resume", "--label", "Daily digest", "--home", f.home], () => ({
    hermesReady: () => { ready++;
      if (scenario === "stale") { const store = JSON.parse(readFileSync(f.path, "utf8")); store.jobs[0].prompt = "old ungated prompt"; delete store.jobs[0].script; writeFileSync(f.path, JSON.stringify(store)); }
      if (scenario === "admin-late") writeFileSync(holds, JSON.stringify({ holds: { aaaaaaaaaaaa: "paused" }, by: { aaaaaaaaaaaa: "admin" } }));
      if (scenario === "revoke") rmSync(join(f.home, "av-events/post-village-policy.json")); return true; },
    hermes: (args) => { f.calls.push(args); const store = JSON.parse(readFileSync(f.path, "utf8")); Object.assign(store.jobs[0], { enabled: true, state: "scheduled" }); writeFileSync(f.path, JSON.stringify(store)); },
  }));
  if (scenario === "resident") { expect(result.out).toMatchObject({ ok: true }); expect(result.code).toBe(0); expect(f.calls[0]).toEqual(["cron", "resume", "aaaaaaaaaaaa"]); expect(JSON.parse(readFileSync(holds, "utf8")).holds.aaaaaaaaaaaa).toBeUndefined(); }
  else { expect(result.code).toBe(2); expect(f.calls).toEqual([]); expect(readFileSync(holds, "utf8")).toBe(scenario === "admin-late" ? JSON.stringify({ holds: { aaaaaaaaaaaa: "paused" }, by: { aaaaaaaaaaaa: "admin" } }) : original); }
});

for (const module of ["send-daily-brief.ts", "drop-opportunity.ts", "pending-alert.ts", "summarize-negotiations.ts"]) test(`current wrapper cannot authorize stale gate-bearing module ${module}`, () => {
  const f = fixture(true); const before = readFileSync(f.path, "utf8");
  writeFileSync(join(f.home, "skills/index-network/scripts", module), "// old ungated installed bytes\n");
  expect(f.run(true).code).toBe(2); expect(f.calls).toEqual([]); expect(readFileSync(f.path, "utf8")).toBe(before);
});

for (const timing of ["initial", "late"] as const) test(`resident resume refuses duplicate target IDs ${timing}`, () => {
  const f = fixture(true); const holds = join(f.home, "av-events/job-holds.json");
  const original = JSON.stringify({ holds: { aaaaaaaaaaaa: "paused" }, by: { aaaaaaaaaaaa: "resident" } }); writeFileSync(holds, original);
  writeFileSync(join(f.home, "av-events/installed_jobs.json"), JSON.stringify({ ids: ["aaaaaaaaaaaa"] }));
  const duplicate = () => { const store = JSON.parse(readFileSync(f.path, "utf8")); store.jobs.unshift({ id: "aaaaaaaaaaaa", name: "Unrelated legacy job", prompt: "old ungated", enabled: false }); writeFileSync(f.path, JSON.stringify(store)); };
  if (timing === "initial") duplicate();
  const result = runPauseJob(["resume", "--label", "Daily digest", "--home", f.home], () => ({ hermesReady: () => { if (timing === "late") duplicate(); return true; }, hermes: (args) => { f.calls.push(args); } }));
  expect(result.code).toBe(2); expect(result.out.error).toBe("job-id-ambiguous"); expect(f.calls).toEqual([]); expect(readFileSync(holds, "utf8")).toBe(original);
});
for (const attack of ["initial-duplicate", "late-duplicate", "delete", "rename"] as const) test(`generic enable fresh target proof refuses ${attack} before effects`, () => {
  const f = fixture(true);
  const change = () => { const store = JSON.parse(readFileSync(f.path, "utf8"));
    if (attack.includes("duplicate")) store.jobs.unshift({ id: "aaaaaaaaaaaa", name: "Unrelated legacy job", prompt: "old ungated", enabled: false });
    else if (attack === "delete") store.jobs = [];
    else store.jobs[0].name = "Unrelated renamed job";
    writeFileSync(f.path, JSON.stringify(store));
  };
  if (attack === "initial-duplicate") change();
  const result = f.run(true, attack === "initial-duplicate" ? undefined : change);
  expect(result.code).toBe(attack === "initial-duplicate" ? 2 : 1); expect(result.out.error).toBe("post-village-gates-unverified"); expect(f.calls).toEqual([]); expect(existsSync(join(f.home, "av-events/job-settings.json"))).toBe(false); expect(existsSync(join(f.home, "av-events/job-holds.json"))).toBe(false);
});
test("generic enable permits unrelated distinct IDs without a whole-store audit", () => {
  const f = fixture(true); const store = JSON.parse(readFileSync(f.path, "utf8")); store.jobs.push({ id: "bbbbbbbbbbbb", name: "Unrelated legacy job", prompt: "old ungated", enabled: true }); writeFileSync(f.path, JSON.stringify(store));
  expect(f.run(true).code).toBe(0); expect(f.calls[0]).toEqual(["cron", "resume", "aaaaaaaaaaaa"]);
});
