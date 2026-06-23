import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "..", "skills", "edge-esmeralda", "scripts", "memory_signal_gate.py");
let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-signal-gate-"));
  dirs.push(dir);
  return dir;
}

function runGate(dir: string): { code: number; stdout: string; json: Record<string, unknown> } {
  const proc = Bun.spawnSync(["python3", scriptPath, "--json-only"], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = proc.stdout.toString();
  const lines = stdout.trim().split("\n").filter(Boolean);
  return {
    code: proc.exitCode ?? 0,
    stdout,
    json: JSON.parse(lines.at(-1) || "{}") as Record<string, unknown>,
  };
}

function readState(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "memory", "heartbeat-state.json"), "utf8")) as Record<string, unknown>;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

test("unchanged MEMORY.md suppresses agent wake and preserves unrelated state", () => {
  const dir = makeDir();
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "MEMORY.md"), "# Long-term memory\n\n- User builds agent infrastructure.\n");

  const first = runGate(dir);
  expect(first.code).toBe(0);
  expect(first.json.wakeAgent).toBe(true);
  const hash = first.json.memoryHash;
  expect(typeof hash).toBe("string");

  const stateBefore = {
    prepared: { taskId: "t_1" },
    memorySignals: { lastMemoryHash: hash, lastRunDate: "2026-06-20", captured: ["premise:x"] },
  };
  writeFileSync(join(dir, "memory", "heartbeat-state.json"), JSON.stringify(stateBefore, null, 2));

  const second = runGate(dir);
  expect(second.code).toBe(0);
  expect(second.json).toMatchObject({ wakeAgent: false, reason: "unchanged_memory", memoryHash: hash });

  const state = readState(dir);
  expect(state.prepared).toEqual({ taskId: "t_1" });
  expect(state.memorySignals).toMatchObject({
    lastMemoryHash: hash,
    lastGateReason: "unchanged_memory",
    captured: ["premise:x"],
  });
});

test("existing prompt-led tenants initialize hash quietly on rollout", () => {
  const dir = makeDir();
  mkdirSync(join(dir, "memory"));
  writeFileSync(join(dir, "MEMORY.md"), "# Long-term memory\n\n- User is interested in discovery.\n");
  writeFileSync(
    join(dir, "memory", "heartbeat-state.json"),
    JSON.stringify({ memorySignals: { lastRunDate: "2026-06-21", captured: ["intent:discovery"] } }),
  );

  const result = runGate(dir);
  expect(result.code).toBe(0);
  expect(result.json.wakeAgent).toBe(false);
  expect(result.json.reason).toBe("initialized_existing_state");

  const state = readState(dir);
  expect((state.memorySignals as Record<string, unknown>).lastMemoryHash).toBe(result.json.memoryHash);
});

test("new or changed substantive memory wakes the agent", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "MEMORY.md"), "# Long-term memory\n\n- User wants feedback on the morning brief.\n");

  const result = runGate(dir);
  expect(result.code).toBe(0);
  expect(result.json).toMatchObject({ wakeAgent: true, reason: "first_memory_sync" });
  expect(typeof result.json.memoryHash).toBe("string");
});

test("missing or empty memory suppresses wake and records quiet state", () => {
  const missingDir = makeDir();
  const missing = runGate(missingDir);
  expect(missing.json).toMatchObject({ wakeAgent: false, reason: "missing_memory" });
  expect((readState(missingDir).memorySignals as Record<string, unknown>).lastGateReason).toBe("missing_memory");

  const emptyDir = makeDir();
  writeFileSync(join(emptyDir, "MEMORY.md"), "# Long-term memory\n\n");
  const empty = runGate(emptyDir);
  expect(empty.json).toMatchObject({ wakeAgent: false, reason: "empty_memory" });
  expect((readState(emptyDir).memorySignals as Record<string, unknown>).lastGateReason).toBe("empty_memory");
});
