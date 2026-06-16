import { test, expect } from "bun:test";

import { buildMemoryWorkspaceSetupArgs, memoryWorkspaceSetupScript } from "../memory_workspace";
import { EDGE_SKILL_NAMES } from "../paths";

test("memory workspace setup lives under the copied AgentVillage script tree", () => {
  expect([...EDGE_SKILL_NAMES]).not.toContain("hermes-agent-memory-workspace");
  expect(memoryWorkspaceSetupScript("/opt/data")).toBe(
    "/opt/data/skills/index-network/scripts/memory-workspace/setup_workspace.py",
  );
});

test("memory workspace setup args are safe for normal install", () => {
  const home = "/opt/data";
  const args = buildMemoryWorkspaceSetupArgs(home, false);

  expect(args[0]).toBe(memoryWorkspaceSetupScript(home));
  expect(args).toContain("--root");
  expect(args).toContain(home);
  expect(args).toContain("--install-enzyme-config");
  expect(args).toContain("--write-enzyme-env");
  expect(args).toContain("--install-cron");
  expect(args).toContain("--hermes-bin");

  expect(args).not.toContain("--install-enzyme-cli");
  expect(args).not.toContain("--run-enzyme");
  expect(args).not.toContain("init");
  expect(args).not.toContain("refresh");
});

test("memory workspace setup respects --skip-crons", () => {
  const args = buildMemoryWorkspaceSetupArgs("/opt/data", true);

  expect(args).toContain("--install-enzyme-config");
  expect(args).toContain("--write-enzyme-env");
  expect(args).not.toContain("--install-cron");
  expect(args).not.toContain("--hermes-bin");
});
