/**
 * rc43 (ov#357 review flags on install/config.ts): the real install entry point, run as the control
 * plane runs it (--no-restart), against a temp HERMES_HOME and a stub `hermes`. A run whose
 * `code_execution.mode: strict` cannot be written or verified exits non-zero and prints no gate
 * receipt, so the control plane never reads the box as ready; a clean run ends with the receipt.
 * The receipt is forced by gate_receipt_preload.ts (the approval step is install_approval.test.ts's).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

const NONCE = "0123456789abcdef0123456789abcdef";
const REPO = join(import.meta.dir, "..", "..");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "codeexec-install-"));
  const bin = join(home, "hermes");
  writeFileSync(bin, '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "stub 0.0.0"; fi\nexit 0\n');
  chmodSync(bin, 0o755);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function runInstall(extraEnv: Record<string, string> = {}): { code: number; stdout: string; stderr: string } {
  const env: Record<string, string | undefined> = {
    ...process.env, HOME: home, HERMES_HOME: home, HERMES_BIN: join(home, "hermes"), AV_GATE_NONCE: NONCE, ...extraEnv,
  };
  for (const key of ["AV_APPROVAL_ENABLED", "AV_RECALL_ENABLED", "HERMES_TIMEZONE", "AV_APPROVAL_HERMES_PYTHON"]) {
    if (!(key in extraEnv)) delete env[key];
  }
  const done = Bun.spawnSync(
    ["bun", "--preload", join(import.meta.dir, "gate_receipt_preload.ts"), join(REPO, "install", "install.ts"),
      "--index-api-key", "ix_codeexec_seed", "--no-restart", "--skip-index"],
    { cwd: REPO, env, stdout: "pipe", stderr: "pipe" },
  );
  return { code: done.exitCode ?? -1, stdout: done.stdout.toString(), stderr: done.stderr.toString() };
}

const receiptLines = (stdout: string) => stdout.split("\n").filter((l) => l.includes('"av_gate"'));
const lastLine = (stdout: string) => stdout.trimEnd().split("\n").at(-1);

test("a clean run sets strict, exits 0 and ends with the gate receipt (the preload's control case)", () => {
  writeFileSync(join(home, "config.yaml"), "model:\n  default: m\ncode_execution:\n  mode: project\n");
  const run = runInstall();
  expect({ code: run.code, stderr: run.code === 0 ? "" : run.stderr }).toEqual({ code: 0, stderr: "" });
  expect(YAML.parse(readFileSync(join(home, "config.yaml"), "utf8")).code_execution).toEqual({ mode: "strict" });
  expect(JSON.parse(lastLine(run.stdout)!)).toEqual({
    av_gate: { nonce: NONCE, entries: 35, sha256: "551d13e3861b9fb80e4f2af33d5d5ef04d0faf22a78a43b05bc663dc6ab72cbc" },
  });
  expect(run.stdout).not.toContain("code_execution_failed");
}, 120_000);

test("a strict write that cannot be made (merge key under code_execution) exits non-zero and prints no receipt", () => {
  const text = "base: &b\n  mode: project\ncode_execution:\n  <<: *b\n";
  writeFileSync(join(home, "config.yaml"), text);
  const run = runInstall();
  expect(run.code).not.toBe(0);
  expect(run.stdout.split("\n")).toContain("agentvillage-install: code_execution_failed=merge-key-under-code_execution");
  expect(run.stderr).toContain("error: code_execution.mode is not strict (merge-key-under-code_execution)");
  expect(receiptLines(run.stdout)).toEqual([]);
}, 120_000);

test("a strict write Hermes's own reader does not confirm (unverified) exits non-zero and prints no receipt", () => {
  writeFileSync(join(home, "config.yaml"), "model:\n  default: m\n");
  const fake = join(home, "fake-hermes-python");
  writeFileSync(fake, "#!/bin/sh\necho project\n");
  chmodSync(fake, 0o755);
  const run = runInstall({ AV_APPROVAL_HERMES_PYTHON: fake });
  expect(run.code).not.toBe(0);
  expect(run.stdout.split("\n")).toContain("agentvillage-install: code_execution_failed=not-strict-for-hermes");
  expect(receiptLines(run.stdout)).toEqual([]);
}, 120_000);
