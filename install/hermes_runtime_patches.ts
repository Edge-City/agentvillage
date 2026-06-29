import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

import { hermesBin, hermesExecEnv } from "./hermes_cli";

const QUIET_HELPER = `def _is_quiet_cron_failure(error: Optional[str]) -> bool:
    """Return True when a failed cron job should stay internal."""
    return bool(error)


`;

const QUIET_HELPER_PATTERN = /def _is_quiet_cron_failure\(error: Optional\[str\]\) -> bool:\n(?:    .*\n)+\n\n/;

const HELPER_ANCHOR = `SILENT_MARKER = "[SILENT]"

`;

const DELIVERY_BLOCK = `                deliver_content = final_response if success else f"⚠️ Cron job '{job.get('name', job['id'])}' failed:\\n{error}"
                should_deliver = bool(deliver_content)
                if should_deliver and success and SILENT_MARKER in deliver_content.strip().upper():
                    logger.info("Job '%s': agent returned %s — skipping delivery", job["id"], SILENT_MARKER)
                    should_deliver = False
`;

const PATCHED_DELIVERY_BLOCK = `                deliver_content = final_response if success else f"⚠️ Cron job '{job.get('name', job['id'])}' failed:\\n{error}"
                should_deliver = bool(deliver_content)
                if should_deliver and not success and _is_quiet_cron_failure(error):
                    logger.info(
                        "Job '%s': suppressing delivery for cron failure: %s",
                        job["id"],
                        error,
                    )
                    should_deliver = False
                if should_deliver and success and SILENT_MARKER in deliver_content.strip().upper():
                    logger.info("Job '%s': agent returned %s — skipping delivery", job["id"], SILENT_MARKER)
                    should_deliver = False
`;

export function patchHermesSchedulerSource(source: string): { source: string; changed: boolean } {
  let next = source;

  if (next.includes("def _is_quiet_cron_failure(")) {
    const updated = next.replace(QUIET_HELPER_PATTERN, QUIET_HELPER);
    if (updated === next && !next.includes('"""Return True when a failed cron job should stay internal."""')) {
      throw new Error("Hermes scheduler quiet-failure helper block not found");
    }
    next = updated;
  } else {
    if (!next.includes(HELPER_ANCHOR)) {
      throw new Error("Hermes scheduler helper anchor not found");
    }
    next = next.replace(HELPER_ANCHOR, HELPER_ANCHOR + QUIET_HELPER);
  }

  if (!next.includes("_is_quiet_cron_failure(error)")) {
    if (!next.includes(DELIVERY_BLOCK)) {
      throw new Error("Hermes scheduler delivery block not found");
    }
    next = next.replace(DELIVERY_BLOCK, PATCHED_DELIVERY_BLOCK);
  }

  return { source: next, changed: next !== source };
}

function candidatePythonBins(): string[] {
  const bin = hermesBin();
  return [
    process.env.HERMES_PYTHON?.trim() || "",
    join(dirname(bin), "python"),
    "python3",
    "python",
  ].filter(Boolean);
}

function locateHermesScheduler(): string | null {
  const script = "import cron.scheduler; print(cron.scheduler.__file__)";
  for (const python of candidatePythonBins()) {
    try {
      const out = execFileSync(python, ["-c", script], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: hermesExecEnv(),
      }).trim();
      if (out && existsSync(out)) return out;
    } catch {
      // Try the next interpreter.
    }
  }
  return null;
}

export function patchHermesCronFailureDelivery(): void {
  try {
    const schedulerPath = locateHermesScheduler();
    if (!schedulerPath) {
      console.warn("  warning: Hermes cron scheduler source not found; cron failures may still notify users");
      return;
    }

    const current = readFileSync(schedulerPath, "utf8");
    const patched = patchHermesSchedulerSource(current);
    if (!patched.changed) {
      console.log("→ Hermes cron quiet-failure patch already present");
      return;
    }

    writeFileSync(schedulerPath, patched.source, "utf8");
    console.log(`→ patched Hermes cron quiet-failure delivery at ${schedulerPath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`  warning: could not patch Hermes cron quiet-failure delivery: ${message}`);
    return;
  }
}
