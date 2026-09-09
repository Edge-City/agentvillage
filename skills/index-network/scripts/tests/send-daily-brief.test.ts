import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendDailyBrief } from "../send-daily-brief";

const originalCwd = process.cwd();
const originalHermesHome = process.env.HERMES_HOME;
const tmpDirs: string[] = [];

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "send-daily-brief-"));
  tmpDirs.push(dir);
  process.chdir(dir);
  process.env.HERMES_HOME = dir;
  return dir;
}

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "send-daily-brief-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  process.chdir(originalCwd);
  if (originalHermesHome === undefined) {
    delete process.env.HERMES_HOME;
  } else {
    process.env.HERMES_HOME = originalHermesHome;
  }
  while (tmpDirs.length) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
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
      prepared: { date: "2026-06-04", taskId: "t_digest", opportunityIds: ["opp-1"] },
      deliveredToday: { date: "2026-06-04", ids: ["opp-old"] },
    }));
    const calls: string[][] = [];
    const body = [
      "🌞 Good morning",
      "[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111) — relevant overlap, [say hi](https://protocol.index.network/c/abc123)",
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

  test("records question delivery dates, prunes stale entries, and preserves sibling state keys", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-10", taskId: "t_digest", questionIds: ["q-0001"] },
      questionDelivery: { "q-old": "2026-06-01", "q-recent": "2026-06-09" },
      signalElicitation: { lastAskedDate: "2026-06-09" },
    }));
    const body = [
      "\u{1F31E} Good morning",
      "**Announcements**",
      "- Town hall at 5pm.",
      "**One for you:** What are you building?",
    ].join("\n");
    const result = await sendDailyBrief({
      date: "2026-06-10",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent result");
    expect(result.questionIds).toEqual(["q-0001"]);
    expect(result.finalBrief).not.toContain("digest-question");
    expect(result.finalBrief).toContain("**One for you:** What are you building?");

    const state = JSON.parse(await Bun.file("state.json").text());
    // q-old (9 days ago, past the 3-day cooldown) pruned; q-recent kept; q-0001 recorded today.
    expect(state.questionDelivery).toEqual({ "q-recent": "2026-06-09", "q-0001": "2026-06-10" });
    expect(state.signalElicitation).toEqual({ lastAskedDate: "2026-06-09" });
  });

  test("resolves default state and outgoing files under HERMES_HOME, not cwd", async () => {
    const hermesHome = makeTmp();
    const accidentalCwd = tempWorkspace();
    mkdirSync(join(hermesHome, "memory"), { recursive: true });
    await Bun.write(join(hermesHome, "memory", "heartbeat-state.json"), JSON.stringify({
      prepared: { date: "2026-06-04", taskId: "t_digest", questionIds: ["q-1"] },
    }));
    process.env.HERMES_HOME = hermesHome;

    const body = "**One for you:** What are you building?";
    const result = await sendDailyBrief({
      date: "2026-06-04",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
    });

    expect("silent" in result).toBe(false);
    expect(await Bun.file(join(hermesHome, "memory", "digest-outgoing.md")).text()).toBe(body);
    expect(JSON.parse(await Bun.file(join(hermesHome, "memory", "heartbeat-state.json")).text()).questionDelivery).toEqual({ "q-1": "2026-06-04" });
    expect(existsSync(join(accidentalCwd, "memory", "digest-outgoing.md"))).toBe(false);
  });
});
