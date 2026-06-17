import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { hermesBin, hermesExecEnv } from "./hermes_cli";

const DEFAULT_ENZYME_REFRESH_CRON = "30 2 * * *";

export function memoryWorkspaceSetupScript(home: string): string {
  return join(home, "skills", "memory-workspace", "scripts", "setup_workspace.py");
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

function readFlagFrom(argv: string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === name) {
      const next = argv[i + 1];
      return next === undefined || next.startsWith("--") ? undefined : next;
    }
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  return fields.length === 5 && fields.every((f) => /^[\d*,/-]+$/.test(f));
}

export function shouldInstallEnzymeRefreshCron(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return argv.includes("--install-enzyme-refresh-cron")
    || readFlagFrom(argv, "--enzyme-refresh-cron") !== undefined
    || isTruthy(env.AGENTVILLAGE_ENZYME_REFRESH_CRON)
    || Boolean(env.ENZYME_REFRESH_CRON?.trim());
}

export function resolveEnzymeRefreshCron(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const fromFlag = readFlagFrom(argv, "--enzyme-refresh-cron")?.trim();
  const override = fromFlag || env.ENZYME_REFRESH_CRON?.trim();
  if (!override) return DEFAULT_ENZYME_REFRESH_CRON;
  if (!isValidCron(override)) {
    console.warn(
      `  warning: ignoring invalid Enzyme refresh cron override "${override}" — using default "${DEFAULT_ENZYME_REFRESH_CRON}"`,
    );
    return DEFAULT_ENZYME_REFRESH_CRON;
  }
  return override;
}

export function buildMemoryWorkspaceSetupArgs(
  home: string,
  skipCrons: boolean,
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const args = [
    memoryWorkspaceSetupScript(home),
    "--root",
    home,
    "--install-enzyme-config",
    "--write-enzyme-env",
  ];
  if (!skipCrons) {
    args.push("--install-cron", "--hermes-bin", hermesBin());
    if (shouldInstallEnzymeRefreshCron(argv, env)) {
      args.push(
        "--install-enzyme-refresh-cron",
        "--enzyme-refresh-cron",
        resolveEnzymeRefreshCron(argv, env),
      );
    }
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
