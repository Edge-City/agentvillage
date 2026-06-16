import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { hermesBin, hermesExecEnv } from "./hermes_cli";

export function memoryWorkspaceSetupScript(home: string): string {
  return join(home, "skills", "index-network", "scripts", "memory-workspace", "setup_workspace.py");
}

export function buildMemoryWorkspaceSetupArgs(home: string, skipCrons: boolean): string[] {
  const args = [
    memoryWorkspaceSetupScript(home),
    "--root",
    home,
    "--install-enzyme-config",
    "--write-enzyme-env",
  ];
  if (!skipCrons) {
    args.push("--install-cron", "--hermes-bin", hermesBin());
  }
  return args;
}

export function setupHermesMemoryWorkspace(home: string, skipCrons: boolean): void {
  const script = memoryWorkspaceSetupScript(home);
  if (!existsSync(script)) {
    console.warn("  warning: Hermes memory workspace setup script is missing");
    return;
  }

  console.log("→ setting up Hermes memory workspace");
  try {
    execFileSync(process.env.PYTHON ?? "python3", buildMemoryWorkspaceSetupArgs(home, skipCrons), {
      stdio: "inherit",
      cwd: home,
      env: hermesExecEnv(),
    });
  } catch {
    console.warn(
      "  warning: could not complete Hermes memory workspace setup — run setup_workspace.py from HERMES_HOME",
    );
  }
}
