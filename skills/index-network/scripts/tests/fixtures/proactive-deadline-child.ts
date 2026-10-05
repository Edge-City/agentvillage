/**
 * The hard-deadline test's child process (proactive-settings.test.ts): runs
 * the trigger's real `main()` as a preview of `<action>` on `<home>`, with a
 * 300 ms deadline and a content path that never returns, so only main's
 * deadline path can end it. When the content path is entered it writes the
 * preview state copies that exist then to `<home>/entered.json`, so the test
 * knows there was a copy to remove. Not a test file itself.
 *
 *   bun proactive-deadline-child.ts <action> <home>
 */
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { main } from "../../proactive";

const [action, home] = process.argv.slice(2);
const never = async (): Promise<never> => {
  const copies = readdirSync(join(home, "av-events", "proactive")).filter((name) => name.startsWith("preview-"));
  writeFileSync(join(home, "entered.json"), JSON.stringify(copies));
  return new Promise<never>(() => {});
};

await main([action, "--preview"], {
  deadlineMs: 300,
  options: { home, buildContext: never, drop: never, evening: never, followUp: never, accepted: never, approvals: () => 0 },
});
