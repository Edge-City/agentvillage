import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendDailyBrief } from "../send-daily-brief";

const originalCwd = process.cwd();

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "send-daily-brief-"));
  process.chdir(dir);
  return dir;
}

afterEach(() => {
  const cwd = process.cwd();
  process.chdir(originalCwd);
  if (cwd !== originalCwd && cwd.includes("send-daily-brief-")) rmSync(cwd, { recursive: true, force: true });
});

describe("sendDailyBrief", () => {
  test("returns silent when no prepared task exists for the date", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ prepared: { date: "2026-06-03", taskId: "t_old" } }));

    const result = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      hermes: () => {
        throw new Error("hermes should not be called");
      },
    });

    expect(result).toEqual({ silent: true, reason: "no-staged-task" });
  });

  test("returns silent when the staged task is still blocked", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ prepared: { date: "2026-06-04", taskId: "t_digest" } }));

    const result = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      hermes: () => JSON.stringify({ task: { id: "t_digest", status: "blocked", body: "draft" } }),
    });

    expect(result).toEqual({ silent: true, reason: "not-approved:blocked" });
  });

  test("delivers ready cards, strips metadata/unsafe links, updates state, and completes the task", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-04", taskId: "t_digest", opportunityIds: ["opp-1", "opp-removed"] },
      deliveredToday: { date: "2026-06-04", ids: ["opp-old"] },
    }));
    const calls: string[][] = [];
    const body = [
      "🌞 Good morning",
      "<!-- digest-opportunity:id=opp-1 -->[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111) — relevant overlap, [say hi](https://protocol.index.network/c/abc123)",
      "[fabricated](https://index.network/accept/123)",
    ].join("\n");

    const result = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        calls.push(args);
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent result");
    expect(result.taskId).toBe("t_digest");
    expect(result.opportunityIds).toEqual(["opp-1"]);
    expect(result.finalBrief).toContain("[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111)");
    expect(result.finalBrief).toContain("[say hi](https://protocol.index.network/c/abc123)");
    expect(result.finalBrief).toContain("fabricated");
    expect(result.finalBrief).not.toContain("digest-opportunity");
    expect(result.finalBrief).not.toContain("accept/123");
    expect(await Bun.file("outgoing.md").text()).toBe(body);
    expect(JSON.parse(await Bun.file("state.json").text()).deliveredToday).toEqual({ date: "2026-06-04", ids: ["opp-old", "opp-1"] });
    expect(calls).toEqual([
      ["kanban", "show", "t_digest", "--json"],
      ["kanban", "complete", "t_digest", "--summary", "delivered"],
    ]);
  });
});
