import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageDailyBrief } from "../stage-daily-brief";

const TODAY = "2026-06-15";

const tmpDirs: string[] = [];

function makeStateFile(state: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "stage-idem-"));
  tmpDirs.push(dir);
  const path = join(dir, "heartbeat-state.json");
  Bun.write(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Records every Hermes invocation and replies to `kanban show` with a card in
 * the given status. Any `create`/`block` call is a guard failure — a re-run of
 * prepare must never reach them when a protected card already exists.
 */
function fakeHermes(status: string, body = "EXISTING BODY") {
  const calls: string[][] = [];
  const runner = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "kanban" && args[1] === "show") {
      return JSON.stringify({ task: { id: "t_existing", status, body } });
    }
    return "{}";
  };
  return { calls, runner };
}

describe("stageDailyBrief idempotency guard", () => {
  for (const status of ["blocked", "ready", "todo", "done"]) {
    test(`leaves an existing ${status} card untouched on regenerate`, async () => {
      const stateFile = makeStateFile({
        prepared: { date: TODAY, taskId: "t_existing", opportunityIds: ["opp-1"], questionIds: ["q-1"] },
      });
      const { calls, runner } = fakeHermes(status);

      const result = await stageDailyBrief({ date: TODAY, stateFile, hermes: runner });

      expect(result.skipped).toBe(true);
      expect(result.reason).toBe(`already-staged:${status}`);
      expect(result.taskId).toBe("t_existing");
      expect(result.opportunityIds).toEqual(["opp-1"]);
      expect(result.questionIds).toEqual(["q-1"]);
      // The guard must NOT recreate or re-block the card.
      expect(calls.some((c) => c[1] === "create")).toBe(false);
      expect(calls.some((c) => c[1] === "block")).toBe(false);
      // Only a read (show) is allowed.
      expect(calls.every((c) => c[1] === "show")).toBe(true);
    });
  }
});
