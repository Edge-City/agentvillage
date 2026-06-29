import { expect, test } from "bun:test";

import { patchHermesSchedulerSource } from "../hermes_runtime_patches";

const schedulerFixture = `from typing import Optional

logger = None

# Sentinel: when a cron agent has nothing new to report, it can start its
# response with this marker to suppress delivery.  Output is still saved
# locally for audit.
SILENT_MARKER = "[SILENT]"

def tick():
    def _process_job(job: dict) -> bool:
        success = False
        final_response = ""
        error = "RuntimeError: Error code: 403 - key limit exceeded"
                deliver_content = final_response if success else f"⚠️ Cron job '{job.get('name', job['id'])}' failed:\\n{error}"
                should_deliver = bool(deliver_content)
                if should_deliver and success and SILENT_MARKER in deliver_content.strip().upper():
                    logger.info("Job '%s': agent returned %s — skipping delivery", job["id"], SILENT_MARKER)
                    should_deliver = False
        return should_deliver
`;

test("patchHermesSchedulerSource suppresses quiet OpenRouter budget failures", () => {
  const { source, changed } = patchHermesSchedulerSource(schedulerFixture);

  expect(changed).toBe(true);
  expect(source).toContain("def _is_quiet_cron_failure(error: Optional[str]) -> bool:");
  expect(source).toContain("key limit exceeded");
  expect(source).toContain("if should_deliver and not success and _is_quiet_cron_failure(error):");
});

test("patchHermesSchedulerSource is idempotent", () => {
  const once = patchHermesSchedulerSource(schedulerFixture);
  const twice = patchHermesSchedulerSource(once.source);

  expect(once.changed).toBe(true);
  expect(twice.changed).toBe(false);
  expect(twice.source.match(/def _is_quiet_cron_failure/g)?.length).toBe(1);
  expect(twice.source.match(/_is_quiet_cron_failure\(error\)/g)?.length).toBe(1);
});
