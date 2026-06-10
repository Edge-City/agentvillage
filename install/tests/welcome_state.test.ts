import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  WELCOME_STATE_RELATIVE_PATH,
  captureWelcomeState,
  recordsWelcomeSent,
  restoreWelcomeState,
} from "../welcome_state";

const temps: string[] = [];

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentvillage-welcome-"));
  temps.push(dir);
  return dir;
}

function markerPath(home: string): string {
  return join(home, WELCOME_STATE_RELATIVE_PATH);
}

function writeMarker(home: string, content: string): void {
  const path = markerPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function fakeHermesBin(home: string): string {
  const path = join(home, "fake-hermes");
  writeFileSync(path, "#!/bin/sh\nexit 127\n");
  chmodSync(path, 0o755);
  return path;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("recordsWelcomeSent accepts only JSON with welcomeSent true", () => {
  expect(recordsWelcomeSent('{"welcomeSent":true,"sentAt":"2026-06-08T13:00:00Z"}')).toBe(true);
  expect(recordsWelcomeSent('{"welcomeSent":false}')).toBe(false);
  expect(recordsWelcomeSent("welcomeSent: true")).toBe(false);
});

test("restoreWelcomeState restores a deleted suppressing marker", () => {
  const home = tempHome();
  const content = '{"welcomeSent":true,"sentAt":"2026-06-08T13:00:00Z"}\n';
  writeMarker(home, content);

  const snapshot = captureWelcomeState(home);
  rmSync(markerPath(home), { force: true });

  expect(restoreWelcomeState(snapshot)).toBe(true);
  expect(readFileSync(markerPath(home), "utf8")).toBe(content);
});

test("restoreWelcomeState repairs a clobbered suppressing marker", () => {
  const home = tempHome();
  const content = '{"welcomeSent":true,"sentAt":"2026-06-08T13:00:00Z"}\n';
  writeMarker(home, content);

  const snapshot = captureWelcomeState(home);
  writeMarker(home, "{}");

  expect(restoreWelcomeState(snapshot)).toBe(true);
  expect(readFileSync(markerPath(home), "utf8")).toBe(content);
});

test("restoreWelcomeState does not create a marker for fresh installs", () => {
  const home = tempHome();

  expect(captureWelcomeState(home)).toBeNull();
  expect(restoreWelcomeState(null)).toBe(false);
  expect(existsSync(markerPath(home))).toBe(false);
});

test("installer preserves welcome marker on normal reinstall and removes it on wipe-user", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const installScript = join(repoRoot, "install", "install.ts");
  const home = tempHome();
  const hermesBin = fakeHermesBin(home);
  const content = '{"welcomeSent":true,"sentAt":"2026-06-08T13:00:00Z"}\n';
  writeMarker(home, content);

  const normal = Bun.spawnSync({
    cmd: ["bun", installScript, "--index-api-key", "ix_test", "--no-restart"],
    cwd: repoRoot,
    env: { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: hermesBin },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(normal.exitCode).toBe(0);
  expect(readFileSync(markerPath(home), "utf8")).toBe(content);

  const wipe = Bun.spawnSync({
    cmd: ["bun", installScript, "--index-api-key", "ix_test", "--no-restart", "--wipe-user"],
    cwd: repoRoot,
    env: { ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: hermesBin },
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(wipe.exitCode).toBe(0);
  expect(existsSync(markerPath(home))).toBe(false);
});
