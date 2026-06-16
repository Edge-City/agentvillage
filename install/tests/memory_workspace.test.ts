import { test, expect } from "bun:test";

import { buildMemoryWorkspaceSetupArgs, memoryWorkspaceSetupScript } from "../memory_workspace";
import { EDGE_SKILL_NAMES } from "../paths";

test("AgentVillage bundles the Hermes memory workspace skill", () => {
  expect([...EDGE_SKILL_NAMES]).toContain("hermes-agent-memory-workspace");
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
