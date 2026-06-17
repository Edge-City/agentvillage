import { test, expect } from "bun:test";

import {
  buildMemoryWorkspaceSetupArgs,
  memoryWorkspaceSetupScript,
  resolveEnzymeRefreshCron,
  shouldInstallEnzymeRefreshCron,
} from "../memory_workspace";

test("memory workspace setup args are safe for install", () => {
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
  expect(args).not.toContain("--install-enzyme-refresh-cron");
  expect(args).not.toContain("--run-enzyme");
  expect(args).not.toContain("init");
  expect(args).not.toContain("refresh");
});

test("memory workspace setup respects --skip-crons", () => {
  const args = buildMemoryWorkspaceSetupArgs("/opt/data", true);

  expect(args).toContain("--install-enzyme-config");
  expect(args).toContain("--write-enzyme-env");
  expect(args).not.toContain("--install-cron");
  expect(args).not.toContain("--install-enzyme-refresh-cron");
  expect(args).not.toContain("--hermes-bin");
});

test("memory workspace refresh cron is explicit opt-in", () => {
  const args = buildMemoryWorkspaceSetupArgs(
    "/opt/data",
    false,
    ["bun", "install", "--install-enzyme-refresh-cron"],
    {},
  );

  expect(args).toContain("--install-cron");
  expect(args).toContain("--install-enzyme-refresh-cron");
  expect(args).toContain("--enzyme-refresh-cron");
  expect(args).toContain("30 2 * * *");
  expect(args).not.toContain("--run-enzyme");
  expect(args).not.toContain("init");
  expect(args).not.toContain("refresh");
});

test("memory workspace refresh cron schedule can be overridden by flag or env", () => {
  expect(resolveEnzymeRefreshCron(["bun", "--enzyme-refresh-cron", "0 3 * * *"], {})).toBe("0 3 * * *");
  expect(resolveEnzymeRefreshCron(["bun"], { ENZYME_REFRESH_CRON: "15 3 * * *" })).toBe("15 3 * * *");
  expect(resolveEnzymeRefreshCron(["bun", "--enzyme-refresh-cron", "garbage"], {})).toBe("30 2 * * *");
});

test("memory workspace refresh cron opt-in accepts schedule env and install env", () => {
  expect(shouldInstallEnzymeRefreshCron(["bun"], {})).toBe(false);
  expect(shouldInstallEnzymeRefreshCron(["bun", "--enzyme-refresh-cron", "0 3 * * *"], {})).toBe(true);
  expect(shouldInstallEnzymeRefreshCron(["bun"], { ENZYME_REFRESH_CRON: "0 3 * * *" })).toBe(true);
  expect(shouldInstallEnzymeRefreshCron(["bun"], { AGENTVILLAGE_ENZYME_REFRESH_CRON: "1" })).toBe(true);
});
