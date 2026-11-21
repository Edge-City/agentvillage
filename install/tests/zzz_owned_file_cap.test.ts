// v2.2.0 item 5 (lead L35228, "runner cap raise FIRST"): the installer owns a ZZZ file only up to OWNED_FILE_MAX_BYTES
// (128 KiB, was 65,536). These run the box command from a copy of the overlay whose autonomy runner is padded to a given
// size and whose AUTONOMY_SHIPPED carries that runner's digest, as a release that grows the runner ships it.
import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { REVIEWED_MINI_APPS, reconcileMiniApps } from "../install_miniapps";
import { AUTONOMY_GATE, AUTONOMY_JOB_NAME, AUTONOMY_JOB_SCRIPT } from "../zzz_autonomy_job";
import { OWNED_FILE_MAX_BYTES } from "../zzz_managed_job";

const repo = resolve(import.meta.dir, "../..");
const RUNNER = "skills/zzzbot/scripts/zzz_autonomy_runner.py";
const SHIPPED_RUNNER = readFileSync(join(repo, RUNNER));
const token = "avb_" + "a".repeat(43);
const zzzbot = REVIEWED_MINI_APPS.find(app => app.id === "zzzbot")!;
const pair = REVIEWED_MINI_APPS.find(app => app.id === "zzz-bridge")!;
const MANAGED = "skills/zzzbot/scripts/zzz_managed_runner.py";
const autonomy = REVIEWED_MINI_APPS.find(app => app.id === AUTONOMY_GATE)!;
const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// realpath: the installer refuses any symlinked parent of HERMES_HOME (macOS /var and /tmp are links).
const scratch = (prefix: string) => { const root = realpathSync(mkdtempSync(join(tmpdir(), prefix))); roots.push(root); return root; };
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** `bytes` (default: the shipped autonomy runner), padded with one trailing comment line to exactly `size` bytes. */
function runnerOf(size: number, bytes = SHIPPED_RUNNER): Buffer {
  const pad = size - bytes.length;
  if (pad < 2) throw new Error("pad");
  return Buffer.concat([bytes, Buffer.from(`#${"x".repeat(pad - 2)}\n`)]);
}

/** A copy of the overlay (package.json, install, skills; no node_modules, no .git) to run the box command from. */
function release(): { src: string; ship: (runner: Buffer) => void; shipManaged: (runner: Buffer) => void } {
  const src = join(scratch("zzz-owned-cap-src-"), "edge-src");
  const skip = new Set(["node_modules", ".git", ".test-deps"]);
  for (const part of ["package.json", "install", "skills"]) cpSync(join(repo, part), join(src, part), { recursive: true, filter: path => !skip.has(basename(path)) });
  const job = join(src, "install/zzz_autonomy_job.ts");
  // Ship `runner`: the bytes the copy stages, and their digest appended to AUTONOMY_SHIPPED (every older one kept).
  const ship = (runner: Buffer) => {
    writeFileSync(join(src, RUNNER), runner);
    const text = readFileSync(job, "utf8");
    const anchor = '  ],\n  "prompts/autonomy.md":';
    if (!text.includes(anchor)) throw new Error("anchor");
    writeFileSync(job, text.replace(anchor, `    "${digest(runner)}",\n${anchor}`));
  };
  // Ship a managed (pair) runner the same way: its bytes, and their digest appended to ZZZ_SHIPPED_SHA256.runner.
  const managed = join(src, "install/zzz_managed_job.ts");
  const shipManaged = (runner: Buffer) => {
    writeFileSync(join(src, MANAGED), runner);
    const text = readFileSync(managed, "utf8");
    const anchor = '"],\n  prompt:';
    if (text.split(anchor).length !== 2) throw new Error("anchor");
    writeFileSync(managed, text.replace(anchor, `", "${digest(runner)}"],\n  prompt:`));
  };
  return { src, ship, shipManaged };
}

/** A box with a fake Hermes (as zzz_autonomy_job.test.ts) and the bridge credential, staging from `src`. */
function box(src: string) {
  const home = join(scratch("zzz-owned-cap-home-"), ".hermes");
  const python = join(home, "venv/bin/python"), hermes = join(home, "bin/hermes");
  mkdirSync(join(home, "venv/bin"), { recursive: true }); mkdirSync(join(home, "bin")); mkdirSync(join(home, "hermes_cli"));
  writeFileSync(join(home, "hermes_cli/main.py"), "# bound fake\n");
  writeFileSync(hermes, `#!/usr/bin/env bash\nunset PYTHONPATH\nunset PYTHONHOME\nexec "${python}" "${join(home, "hermes_cli/main.py")}" "$@"\n`);
  writeFileSync(python, `#!/usr/bin/env bash\nif [ "$1" = "-c" ]; then\n shift 2\n exec "${process.execPath}" "${join(import.meta.dir, "fake_hermes_job_python.ts")}" "$@"\nfi\nshift\nexec "${process.execPath}" "${join(import.meta.dir, "fake_hermes.ts")}" "$@"\n`);
  chmodSync(hermes, 0o755); chmodSync(python, 0o755);
  writeFileSync(join(home, "village-bridge.json"), JSON.stringify({ origin: "https://agents.edgecity.live", token, expiresAt: "2099-01-01T00:00:00Z" }));
  const stage = (apps: readonly unknown[], args: string[] = []) => spawnSync(process.execPath,
    ["--no-env-file", "--no-install", "install/install_miniapps.ts", ...args], { cwd: src, input: JSON.stringify({ version: 1, apps }),
      env: { ...process.env, HERMES_HOME: home, HERMES_BIN: hermes }, encoding: "utf8", timeout: 30000 });
  const jobs = () => existsSync(join(home, "cron/jobs.json"))
    ? (JSON.parse(readFileSync(join(home, "cron/jobs.json"), "utf8")).jobs as Array<Record<string, unknown>>).map(job => job.name) : [];
  const shim = join(home, "scripts", AUTONOMY_JOB_SCRIPT), copy = join(home, RUNNER);
  const gated = () => existsSync(join(home, "mini-apps.json")) &&
    (JSON.parse(readFileSync(join(home, "mini-apps.json"), "utf8")).apps as Array<{ id: string }>).some(app => app.id === AUTONOMY_GATE);
  return { home, stage, jobs, shim, copy, gated };
}

test("the owned-file cap is 128 KiB and the shipped runner fits it", () => {
  expect(OWNED_FILE_MAX_BYTES).toBe(131072);
  expect(SHIPPED_RUNNER.length).toBeLessThanOrEqual(OWNED_FILE_MAX_BYTES);
});

test("a 100 KiB runner and one of exactly 131,072 bytes stage, verify, upgrade from the shipped bytes and tear down as the installer's own", () => {
  const { src, ship } = release();
  for (const size of [100 * 1024, OWNED_FILE_MAX_BYTES]) {
    const runner = runnerOf(size);
    expect(runner.length).toBe(size);
    ship(runner);
    // A box on the current release first (its runner bytes are already in AUTONOMY_SHIPPED), then the grown one.
    const b = box(src);
    writeFileSync(join(src, RUNNER), SHIPPED_RUNNER);
    expect(b.stage([zzzbot, autonomy]).status).toBe(0);
    expect(readFileSync(b.shim).equals(SHIPPED_RUNNER)).toBe(true);
    writeFileSync(join(src, RUNNER), runner);
    const up = b.stage([zzzbot, autonomy]);
    expect(`${size}: ${up.status} ${up.stderr}`).toBe(`${size}: 0 `);
    expect(readFileSync(b.shim).equals(runner)).toBe(true);
    expect(readFileSync(b.copy).equals(runner)).toBe(true);
    expect(JSON.parse(up.stdout).files).toContainEqual({ path: RUNNER, sha256: digest(runner) });
    expect(b.jobs()).toEqual([AUTONOMY_JOB_NAME]);
    expect(b.stage([zzzbot, autonomy], ["--verify"]).status).toBe(0);
    // Ours at this size: teardown removes the job, the shim and the copy.
    expect(b.stage([zzzbot]).status).toBe(0);
    expect([b.jobs(), existsSync(b.shim), existsSync(b.copy)]).toEqual([[], false, false]);
    expect(b.stage([zzzbot], ["--verify"]).status).toBe(0);
  }
}, 60000);

test("a 131,073-byte runner is refused before anything is written, and a box already running it fails closed", async () => {
  const { src, ship } = release();
  const over = runnerOf(OWNED_FILE_MAX_BYTES + 1);
  // In process (no job steps): the refusal names the cap, and nothing reaches the box.
  ship(over);
  const quiet = join(scratch("zzz-owned-cap-inproc-"), ".hermes");
  mkdirSync(quiet, { recursive: true });
  expect(() => reconcileMiniApps({ version: 1, apps: [zzzbot, autonomy] }, quiet, join(src, "skills"))).toThrow("mini_apps_owned_file_oversize");
  expect(existsSync(join(quiet, "mini-apps.json")) || existsSync(join(quiet, "skills")) || existsSync(join(quiet, "scripts"))).toBe(false);
  // The box command on a fresh box: exit 1, no runner written anywhere, no job, no gate.
  const fresh = box(src);
  const refused = fresh.stage([zzzbot, autonomy]);
  expect({ status: refused.status, stdout: refused.stdout, stderr: refused.stderr.trim() })
    .toEqual({ status: 1, stdout: "", stderr: JSON.stringify({ error: "mini_apps_reconcile_failed" }) });
  expect([existsSync(fresh.shim), existsSync(fresh.copy), fresh.jobs(), fresh.gated()]).toEqual([false, false, [], false]);
  // A box running a 100 KiB runner whose next release grows it past the cap: the stage fails closed (gate withdrawn,
  // job, shim and copy of the previous bytes removed), never a half-install of the oversize bytes.
  const grown = runnerOf(100 * 1024);
  ship(grown);
  const running = box(src);
  writeFileSync(join(src, RUNNER), grown);
  expect(running.stage([zzzbot, autonomy]).status).toBe(0);
  expect([running.jobs(), running.gated(), readFileSync(running.shim).equals(grown)]).toEqual([[AUTONOMY_JOB_NAME], true, true]);
  writeFileSync(join(src, RUNNER), over);
  expect(running.stage([zzzbot, autonomy]).status).toBe(1);
  expect([running.jobs(), running.gated(), existsSync(running.shim), existsSync(running.copy)]).toEqual([[], false, false, false]);
  expect(running.stage([zzzbot, autonomy], ["--verify"]).status).toBe(1);
  // The ownership read itself (the copy's module, whose AUTONOMY_SHIPPED holds both digests): a shipped runner on disk
  // is the installer's at 100 KiB and not at 131,073 bytes, whatever its digest.
  const { autonomyMarkers } = await import(join(src, "install/zzz_autonomy_job.ts"));
  const marker = join(scratch("zzz-owned-cap-marker-"), ".hermes");
  mkdirSync(join(marker, "scripts"), { recursive: true });
  writeFileSync(join(marker, "scripts", AUTONOMY_JOB_SCRIPT), grown);
  expect(autonomyMarkers(marker)).toBe(true);
  writeFileSync(join(marker, "scripts", AUTONOMY_JOB_SCRIPT), over);
  expect(autonomyMarkers(marker)).toBe(false);
}, 60000);

test("the same cap covers the pair job's managed runner: a 100 KiB one stages, verifies and tears down as ours", () => {
  const { src, shipManaged } = release();
  const runner = runnerOf(100 * 1024, readFileSync(join(repo, MANAGED)));
  shipManaged(runner);
  const b = box(src);
  const staged = b.stage([zzzbot, pair]);
  expect(`${staged.status} ${staged.stderr}`).toBe("0 ");
  const shim = join(b.home, "scripts/zzz_managed_runner.py"), copy = join(b.home, MANAGED);
  expect([readFileSync(shim).equals(runner), readFileSync(copy).equals(runner)]).toEqual([true, true]);
  expect(b.stage([zzzbot, pair], ["--verify"]).status).toBe(0);
  // Ours at this size: teardown removes the job, the shim and the copy, and verify agrees.
  expect(b.stage([zzzbot]).status).toBe(0);
  expect([b.jobs(), existsSync(shim), existsSync(copy)]).toEqual([[], false, false]);
  expect(b.stage([zzzbot], ["--verify"]).status).toBe(0);
}, 60000);
