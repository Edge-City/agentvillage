import { test, expect } from "bun:test";

import { buildMemoryWorkspaceSetupArgs, memoryWorkspaceSetupScript } from "../memory_workspace";

test("memory workspace setup args are safe for install", () => {
  const home = "/opt/data";
  const args = buildMemoryWorkspaceSetupArgs(home, false);

  expect(args[0]).toBe(memoryWorkspaceSetupScript(home));
  expect(args[0]).toBe("/opt/data/skills/memory-workspace/scripts/setup_workspace.py");
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
