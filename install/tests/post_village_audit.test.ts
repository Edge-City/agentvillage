import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { auditPostVillageJobs } from "../post_village_audit";
const roots: string[] = [];
function home() { const path = mkdtempSync(join(tmpdir(), "av-test-policy-audit-")); roots.push(path); return path; }
function store(h: string, jobs: unknown[]) { mkdirSync(join(h, "cron"), { recursive: true }); writeFileSync(join(h, "cron/jobs.json"), JSON.stringify({ jobs })); }
const job = { id: "aaaaaaaaaaaa", name: "Edge — daily digest", enabled: true, state: "scheduled" };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
test("genuinely absent store is verified without writing anything", () => { const h = home(); const before = Bun.spawnSync(["ls", "-A", h]).stdout.toString(); expect(auditPostVillageJobs(h).status).toBe("verified"); expect(Bun.spawnSync(["ls", "-A", h]).stdout.toString()).toBe(before); });
test("active OFF known job is unverified; exact paused representations pass", () => {
  const h = home(); store(h, [job]); expect(auditPostVillageJobs(h)).toMatchObject({ status: "unverified", reasons: ["off-job-not-paused"] });
  for (const paused of [{ ...job, enabled: false }, { ...job, state: "paused" }]) { store(h, [paused]); expect(auditPostVillageJobs(h)).toMatchObject({ status: "verified", pausedKeys: ["daily_digest"] }); }
});
test("arbitrary truthy pause fields never prove OFF", () => {
  const h = home(); for (const paused_at of [true, 1, {}, [], "not-a-time", "2026-02-30T00:00:00Z", "2026-01-01T24:00:00Z"]) { store(h, [{ ...job, paused_at }]); expect(auditPostVillageJobs(h).status).toBe("unverified"); }
});
test("one active OFF duplicate fails even when another copy is paused", () => { const h = home(); store(h, [{ ...job, enabled: false }, { ...job, id: "bbbbbbbbbbbb" }]); expect(auditPostVillageJobs(h).status).toBe("unverified"); });
test("invalid, linked and malformed stores are unverified rather than absent", () => {
  const h = home(); store(h, []); writeFileSync(join(h, "cron/jobs.json"), "{"); expect(auditPostVillageJobs(h).status).toBe("unverified");
  rmSync(join(h, "cron/jobs.json")); symlinkSync(join(h, "missing"), join(h, "cron/jobs.json")); expect(auditPostVillageJobs(h).status).toBe("unverified");
  rmSync(join(h, "cron/jobs.json")); store(h, [null]); expect(auditPostVillageJobs(h).status).toBe("unverified");
});
test("ordinary unrelated jobs do not broaden the covered list", () => { const h = home(); store(h, [{ ...job, name: "Owner unrelated reminder" }]); expect(auditPostVillageJobs(h).status).toBe("verified"); });
test("root audit precedes restart and success and remains outside all skip branches", () => {
  const source = readFileSync(join(import.meta.dir, "../install.ts"), "utf8"); const audit = source.indexOf("const postVillageAudit = auditPostVillageJobs"); const restart = source.indexOf("    restartGateway();", audit); const banner = source.indexOf('console.log("✓ installed")', audit);
  expect(audit).toBeGreaterThan(source.indexOf('process.argv.includes("--skip-index")')); expect(restart).toBeGreaterThan(audit); expect(banner).toBeGreaterThan(restart);
  const block = source.slice(audit, restart); expect(block).toContain('postVillageAudit.status === "unverified"'); expect(block).toContain("process.exitCode = 1;"); expect(block).toContain("return;");
});

// Exercise the real root flow with all reconciliation skips: no CLI stand-in can mutate jobs.
function rootInstall(h: string, automaticRestart = false) {
  const fake = join(h, "fake-hermes");
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$HERMES_HOME/cli-calls"\n' + (automaticRestart ? 'if [ "$1" = "--version" ]; then exit 0; fi\n' : "") + 'exit 127\n', { mode: 0o755 });
  writeFileSync(join(h, "config.yaml"), "platforms:\n  telegram: {}\n");
  const env = { PATH: process.env.PATH!, HOME: h, HERMES_HOME: h, HERMES_BIN: fake, AV_APPROVAL_ENABLED: "0", AV_RECALL_ENABLED: "0", AV_DISPLAY_DEFAULTS: "0", AV_MORALMOD_ARM: "off" };
  return Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, "../install.ts"), "--skip-index", "--skip-crons", "--preserve-context", ...(automaticRestart ? [] : ["--no-restart"])], cwd: join(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe", timeout: 20000 });
}
test("actual all-skip/no-restart install verifies absent jobs and preserves context", () => {
  const h = home(); writeFileSync(join(h, "AGENTS.md"), "synthetic preserved context");
  const run = rootInstall(h); expect(run.exitCode).toBe(0); expect(run.stdout.toString()).toContain('post_village_policy={"status":"verified"'); expect(readFileSync(join(h, "AGENTS.md"), "utf8")).toBe("synthetic preserved context");
});
test("actual all-skip install with active OFF job fails before restart/success and never pauses it", () => {
  const h = home(); store(h, [job]); const raw = readFileSync(join(h, "cron/jobs.json"), "utf8"); const run = rootInstall(h);
  expect(run.exitCode).toBe(1); expect(run.stdout.toString()).not.toContain("✓ installed"); expect(run.stdout.toString()).toContain('post_village_policy={"status":"unverified"'); expect(readFileSync(join(h, "cron/jobs.json"), "utf8")).toBe(raw);
  expect((existsSync(join(h, "cli-calls")) ? readFileSync(join(h, "cli-calls"), "utf8") : "")).not.toMatch(/cron (pause|remove|resume)|gateway restart/);
});

test("explicitly allowed paused old job is verified without requiring new shim; runnable old job is unverified", () => {
  const h = home(); mkdirSync(join(h, "av-events")); const raw = '{"version":1,"enabled":["daily_digest"]}'; writeFileSync(join(h, "av-events/post-village-policy.json"), raw);
  store(h, [{ ...job, enabled: false }]); expect(auditPostVillageJobs(h)).toMatchObject({ status: "verified", pausedKeys: ["daily_digest"] });
  store(h, [job]); expect(auditPostVillageJobs(h)).toMatchObject({ status: "unverified", reasons: ["operator-allowed-existing-gates-unverified"] });
  expect(readFileSync(join(h, "av-events/post-village-policy.json"), "utf8")).toBe(raw);
});

test("active OFF job blocks actual automatic-restart path even when fake Hermes is available", () => {
  const h = home(); store(h, [job]); const raw = readFileSync(join(h, "cron/jobs.json"), "utf8");
  const run = rootInstall(h, true); expect(run.exitCode).toBe(1); expect(run.stdout.toString()).toContain("off-job-not-paused"); expect(run.stdout.toString()).not.toContain("✓ installed");
  expect(readFileSync(join(h, "cli-calls"), "utf8")).not.toMatch(/gateway restart|gateway stop|gateway start/); expect(readFileSync(join(h, "cron/jobs.json"), "utf8")).toBe(raw);
});

test("correctly installed runnable operator-allowed job verifies without changing state or policy", () => {
  const h = home(); const repo = join(import.meta.dir, "../.."); mkdirSync(join(h, "av-events"));
  const raw = '{"version":1,"enabled":["daily_digest"]}'; writeFileSync(join(h, "av-events/post-village-policy.json"), raw);
  for (const path of ["skills/index-network/scripts/post-village-policy.ts", "skills/index-network/scripts/job-holds.ts", "skills/index-network/scripts/proactive.ts", "skills/index-network/scripts/post-village-runnable.ts", "skills/index-network/scripts/send-daily-brief.ts", "skills/index-network/scripts/drop-opportunity.ts", "skills/index-network/scripts/pending-alert.ts", "skills/index-network/scripts/summarize-negotiations.ts"]) {
    const target = join(h, path); mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(repo, path), target);
  }
  mkdirSync(join(h, "scripts")); copyFileSync(join(repo, "skills/index-network/scripts/shims/agentvillage_proactive.sh"), join(h, "scripts/agentvillage_proactive_brief.sh"));
  store(h, [{ ...job, prompt: readFileSync(join(repo, "skills/index-network/prompts/brief.md"), "utf8").trimEnd(), script: "agentvillage_proactive_brief.sh", no_agent: false, failure_deliver: "local" }]);
  const before = readFileSync(join(h, "cron/jobs.json"), "utf8"); const audit = auditPostVillageJobs(h);
  expect(audit).toMatchObject({ status: "verified", operatorAllowedKeys: ["daily_digest"] }); expect(audit.pausedKeys).not.toContain("daily_digest");
  expect(readFileSync(join(h, "cron/jobs.json"), "utf8")).toBe(before); expect(readFileSync(join(h, "av-events/post-village-policy.json"), "utf8")).toBe(raw);
});
test("audit cutoff is deterministic before, at and after India end", () => {
  const h = home(); store(h, [job]); expect(auditPostVillageJobs(h, new Date("2026-11-01T18:29:59.999Z")).status).toBe("verified");
  for (const now of ["2026-11-01T18:30:00.000Z", "2026-11-01T18:30:00.001Z"]) expect(auditPostVillageJobs(h, new Date(now)).status).toBe("unverified");
});

function normalRootInstall(h: string, failCreate = false, failUnrelated = false) {
  // The bound Hermes interpreter is real; its CLI is a synthetic local job store, never a provider.
  const python = Bun.spawnSync(["python3", "-c", "import sys;print(sys.executable)"]).stdout.toString().trim();
  const entry = join(h, "hermes_cli/main.py"); mkdirSync(dirname(entry), { recursive: true });
  const fake = join(h, "hermes"); const cli = join(import.meta.dir, "fake_hermes.ts");
  writeFileSync(entry, `import os,sys\n${failUnrelated ? "if sys.argv[1:3]==[\"cron\",\"create\"] and \"--name\" in sys.argv and sys.argv[sys.argv.index(\"--name\")+1]==\"Edge — memory signal sync\":os.environ[\"FAKE_HERMES_FAIL\"]=\"create\"\n" : ""}os.execv(${JSON.stringify(process.execPath)},[${JSON.stringify(process.execPath)},${JSON.stringify(cli)},*sys.argv[1:]])\n`);
  writeFileSync(fake, `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${python}" "${entry}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(h, "config.yaml"), "platforms:\n  telegram: {}\n");
  const env = { PATH: process.env.PATH!, HOME: h, HERMES_HOME: h, HERMES_BIN: fake, AV_APPROVAL_ENABLED: "0", AV_RECALL_ENABLED: "0", AV_DISPLAY_DEFAULTS: "0", AV_MORALMOD_ARM: "off", ...(failCreate ? { FAKE_HERMES_FAIL: "create" } : {}) };
  return Bun.spawnSync({ cmd: [process.execPath, join(import.meta.dir, "../install.ts"), "--index-api-key", "synthetic-not-an-api-key", ...(failCreate ? [] : ["--no-restart"])], cwd: join(import.meta.dir, "../.."), env, stdout: "pipe", stderr: "pipe", timeout: 20000 });
}
test("actual supported normal install reconciles covered jobs paused before its verified receipt", () => {
  const h = home(); const run = normalRootInstall(h); expect(run.exitCode).toBe(0); expect(run.stdout.toString()).toContain('post_village_policy={"status":"verified"');
  const stored = JSON.parse(readFileSync(join(h, "cron/jobs.json"), "utf8")).jobs;
  expect(stored.find((entry: any) => entry.name === "Edge — daily digest").enabled).toBe(false);
});
test("normal covered create failure remains fatal before automatic restart even when final store is absent", () => {
  const h = home(); const run = normalRootInstall(h, true); expect(run.exitCode).toBe(1); expect(run.stdout.toString()).toContain("covered-reconciliation-failed"); expect(run.stdout.toString()).not.toContain("✓ installed");
  const calls: string[][] = readFileSync(join(h, "hermes-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(calls.some((args) => args[0] === "cron" && args[1] === "create")).toBe(true); expect(calls.some((args) => args[0] === "gateway")).toBe(false);
});

test("unrelated historical cron failure keeps the existing warning-only behavior", () => {
  const h = home(); const run = normalRootInstall(h, false, true); expect(run.exitCode).toBe(0);
  expect(run.stdout.toString()).toContain("agentvillage-install: cron_failed=1"); expect(run.stdout.toString()).toContain('post_village_policy={"status":"verified"'); expect(run.stdout.toString()).toContain("✓ installed");
});
