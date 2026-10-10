import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "..", "skills", "index-network", "scripts", "memory_signal_gate.py");
let dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "memory-signal-gate-"));
  dirs.push(dir);
  return dir;
}

/**
 * The gate reads Hermes's memory tool file, `$HERMES_HOME/memories/MEMORY.md`, and keeps its state
 * in `$HERMES_HOME/memory/heartbeat-state.json`. Run from the repo it takes HERMES_HOME from the
 * environment; the working directory is somewhere else on purpose, so a relative read would miss.
 */
function runGate(dir: string, script = scriptPath, env: Record<string, string> = { HERMES_HOME: dir }): { code: number; stdout: string; json: Record<string, unknown> } {
  const { HERMES_HOME: _drop, ...rest } = process.env;
  const proc = Bun.spawnSync(["python3", script, "--json-only"], {
    cwd: tmpdir(),
    env: { ...rest, ...env },
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

function writeMemory(dir: string, text: string): void {
  mkdirSync(join(dir, "memories"), { recursive: true });
  writeFileSync(join(dir, "memories", "MEMORY.md"), text);
}

const SEP = "\n\u00a7\n";
const CONTEXT_TAGS = "[Context tags, kept in the Agent Village app]\nKept by the Agent Village app from what the person shared.\nHere to:\n- Find a cofounder for a seed library (setup)";
const SETUP_PROFILE = "[Edge City profile, written at setup]\nMeera, Bengaluru. Looking for investors.";

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
  writeMemory(dir, "# Long-term memory\n\n- User builds agent infrastructure.\n");

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
  writeMemory(dir, "# Long-term memory\n\n- User is interested in discovery.\n");
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
  writeMemory(dir, "# Long-term memory\n\n- User wants feedback on the morning brief.\n");

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
  writeMemory(emptyDir, "# Long-term memory\n\n");
  const empty = runGate(emptyDir);
  expect(empty.json).toMatchObject({ wakeAgent: false, reason: "empty_memory" });
  expect((readState(emptyDir).memorySignals as Record<string, unknown>).lastGateReason).toBe("empty_memory");
});

test("the gate reads memories/MEMORY.md under HERMES_HOME, never a MEMORY.md beside it", () => {
  const dir = makeDir();
  writeFileSync(join(dir, "MEMORY.md"), "# Long-term memory\n\n- The top-level file is not the memory tool's.\n");
  expect(runGate(dir).json).toMatchObject({ wakeAgent: false, reason: "missing_memory" });

  writeMemory(dir, "# Long-term memory\n\n- User wants a hardware cofounder.\n");
  const woke = runGate(dir);
  expect(woke.json).toMatchObject({ wakeAgent: true, reason: "first_memory_sync", memoryFile: join(dir, "memories", "MEMORY.md") });
  expect(woke.json.stateFile).toBe(join(dir, "memory", "heartbeat-state.json"));
});

test("installed under $HERMES_HOME/scripts, the gate finds its home from where it sits", () => {
  const dir = makeDir();
  mkdirSync(join(dir, "scripts"));
  const installed = join(dir, "scripts", "agentvillage_memory_signal_gate.py");
  copyFileSync(scriptPath, installed);
  writeMemory(dir, "# Long-term memory\n\n- User wants a hardware cofounder.\n");
  // No HERMES_HOME (or a different one, as under a shared gateway): the file's own place wins.
  const result = runGate(dir, installed, { HERMES_HOME: join(dir, "elsewhere") });
  expect(result.json).toMatchObject({ wakeAgent: true, memoryFile: join(dir, "memories", "MEMORY.md"), stateFile: join(dir, "memory", "heartbeat-state.json") });
});

test("profile entries (Context tags, setup profile) never wake the pass", () => {
  const only = makeDir();
  writeMemory(only, `${CONTEXT_TAGS}${SEP}${SETUP_PROFILE}`);
  expect(runGate(only).json).toMatchObject({ wakeAgent: false, reason: "empty_memory" });

  const mixed = makeDir();
  const agentNote = "User wants a hardware cofounder.";
  writeMemory(mixed, `${CONTEXT_TAGS}${SEP}${agentNote}`);
  const first = runGate(mixed);
  expect(first.json).toMatchObject({ wakeAgent: true, reason: "first_memory_sync" });
  mkdirSync(join(mixed, "memory"));
  writeFileSync(
    join(mixed, "memory", "heartbeat-state.json"),
    JSON.stringify({ memorySignals: { lastMemoryHash: first.json.memoryHash, lastRunDate: "2026-10-12" } }),
  );
  // The app rewrote its entry and the control plane added the setup profile: the agent's own memory is the same.
  writeMemory(mixed, `${CONTEXT_TAGS}\n- Curious about soil science (you)${SEP}${agentNote}${SEP}${SETUP_PROFILE}`);
  expect(runGate(mixed).json).toMatchObject({ wakeAgent: false, reason: "unchanged_memory", memoryHash: first.json.memoryHash });
  // The agent's own entry changed: that wakes it.
  writeMemory(mixed, `${CONTEXT_TAGS}${SEP}${agentNote}${SEP}User is raising a seed round.`);
  expect(runGate(mixed).json).toMatchObject({ wakeAgent: true, reason: "memory_changed" });
});

test("OV-278 S3: the wake payload names memories/USER.md, where the Removed by you list lives, and never copies its text", () => {
  const dir = makeDir();
  mkdirSync(join(dir, "memories"), { recursive: true });
  writeFileSync(join(dir, "memories", "USER.md"), "[Context tags, kept in the Agent Village app]\nRemoved by you:\n- REMOVED-HOUSING-POLICY (setup)");
  writeMemory(dir, "User is looking for housing policy collaborators.");
  const woke = runGate(dir);
  expect(woke.json).toMatchObject({ wakeAgent: true, userFile: join(dir, "memories", "USER.md") });
  expect(woke.stdout).not.toContain("REMOVED-HOUSING-POLICY");
  // The prompt drops any candidate that matches a removal, silently.
  const prompt = readFileSync(join(import.meta.dir, "..", "..", "skills", "index-network", "prompts", "memory-signals.md"), "utf8");
  expect(prompt).toContain("Never propose anything that matches an item under `Removed by you:` in the Context tags entry");
  expect(prompt).toContain("the preflight's `userFile`");
  expect(prompt).toContain("drop it silently");
});
