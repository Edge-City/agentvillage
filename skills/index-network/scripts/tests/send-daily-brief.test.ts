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

    const confirmCalls: string[][] = [];
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
      confirmDeliveries: async (ids) => {
        confirmCalls.push(ids);
        return { confirmed: ids, failed: [] };
      },
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent result");
    expect(result.taskId).toBe("t_digest");
    expect(result.opportunityIds).toEqual(["opp-1"]);
    // Ledger confirmation is owned by the script and keyed off the markers
    // surviving in the (possibly human-edited) body — not the staged ids.
    expect(confirmCalls).toEqual([["opp-1"]]);
    expect(result.confirmedOpportunityIds).toEqual(["opp-1"]);
    expect(result.confirmFailed).toEqual([]);
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
      prepared: { date: "2026-06-10", taskId: "t_digest" },
      questionDelivery: { "q-old": "2026-06-01", "q-recent": "2026-06-09" },
      signalElicitation: { lastAskedDate: "2026-06-09" },
    }));
    const body = [
      "\u{1F31E} Good morning",
      "**Announcements**",
      "- Town hall at 5pm.",
      "<!-- digest-question:id=q-0001 -->**One for you:** What are you building?",
    ].join("\n");

    const confirmCalls: string[][] = [];
    const result = await sendDailyBrief({
      date: "2026-06-10",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
      confirmDeliveries: async (ids) => {
        confirmCalls.push(ids);
        return { confirmed: ids, failed: [] };
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
    // No opportunity markers in the body → nothing to confirm.
    expect(confirmCalls).toEqual([[]]);
  });

  test("a failing ledger confirm is diagnostics-only — the brief still ships", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-04", taskId: "t_digest" },
    }));
    const body = "<!-- digest-opportunity:id=opp-1 -->[Maya](https://index.network/u/11111111-1111-1111-1111-111111111111) — relevant";

    const result = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
      confirmDeliveries: async (ids) => ({
        confirmed: [],
        failed: ids.map((opportunityId) => ({ opportunityId, reason: "mcp unreachable" })),
      }),
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent result");
    expect(result.finalBrief).toContain("Maya");
    expect(result.confirmedOpportunityIds).toEqual([]);
    expect(result.confirmFailed).toEqual([{ opportunityId: "opp-1", reason: "mcp unreachable" }]);
    // Delivery state was still recorded locally despite the ledger failure.
    expect(JSON.parse(await Bun.file("state.json").text()).deliveredToday).toEqual({ date: "2026-06-04", ids: ["opp-1"] });
  });

  test("a throwing confirmer never breaks the send", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-04", taskId: "t_digest" },
    }));
    const body = "<!-- digest-opportunity:id=opp-1 -->Maya — relevant";

    const result = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
      confirmDeliveries: async () => {
        throw new Error("confirmer exploded");
      },
    });

    expect("silent" in result).toBe(false);
    if ("silent" in result) throw new Error("unexpected silent result");
    expect(result.finalBrief).toContain("Maya");
    expect(result.confirmedOpportunityIds).toEqual([]);
    expect(result.confirmFailed).toEqual([{ opportunityId: "opp-1", reason: "confirmer exploded" }]);
  });

  test("silent results never invoke the confirmer", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({ prepared: { date: "2026-06-03", taskId: "t_old" } }));

    const result = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      hermes: () => {
        throw new Error("hermes should not be called");
      },
      confirmDeliveries: async () => {
        throw new Error("confirmer should not be called");
      },
    });

    expect(result).toEqual({ silent: true, reason: "no-staged-task" });
  });
});
