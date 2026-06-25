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

  test("carries a transient confirm failure into pendingDeliveryConfirms and retries it next run", async () => {
    tempWorkspace();
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-04", taskId: "t_digest" },
    }));
    const body = "<!-- digest-opportunity:id=opp-1 -->Maya — relevant";

    // Run 1: confirm fails transiently — opp-1 is parked for retry.
    const run1 = await sendDailyBrief({
      date: "2026-06-04",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
      confirmDeliveries: async (ids) => ({ confirmed: [], failed: ids.map((opportunityId) => ({ opportunityId, reason: "mcp unreachable" })) }),
    });
    expect("silent" in run1).toBe(false);
    expect(JSON.parse(await Bun.file("state.json").text()).pendingDeliveryConfirms).toEqual(["opp-1"]);

    // Run 2: a fresh digest with opp-2; the parked opp-1 is retried alongside it.
    await Bun.write("state.json", JSON.stringify({
      prepared: { date: "2026-06-05", taskId: "t_digest2" },
      pendingDeliveryConfirms: ["opp-1"],
    }));
    const body2 = "<!-- digest-opportunity:id=opp-2 -->Sam — relevant";
    const confirmCalls: string[][] = [];
    const run2 = await sendDailyBrief({
      date: "2026-06-05",
      stateFile: "state.json",
      outgoingFile: "outgoing.md",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest2", status: "ready", body: body2 } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
      confirmDeliveries: async (ids) => {
        confirmCalls.push(ids);
        return { confirmed: ids, failed: [] };
      },
    });
    expect("silent" in run2).toBe(false);
    // Both the new id and the parked one are confirmed in one batch.
    expect(confirmCalls).toEqual([["opp-2", "opp-1"]]);
    // All landed — the retry queue is cleared from state.
    expect(JSON.parse(await Bun.file("state.json").text()).pendingDeliveryConfirms).toBeUndefined();
  });

  test("a permanent confirm failure is NOT parked for retry", async () => {
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
      confirmDeliveries: async (ids) => ({ confirmed: [], failed: ids.map((opportunityId) => ({ opportunityId, reason: "opportunity_not_found: deleted" })) }),
    });

    expect("silent" in result).toBe(false);
    // Permanent failure still surfaces in diagnostics …
    expect(result.confirmFailed).toEqual([{ opportunityId: "opp-1", reason: "opportunity_not_found: deleted" }]);
    // … but is never parked for a doomed daily retry.
    expect(JSON.parse(await Bun.file("state.json").text()).pendingDeliveryConfirms).toBeUndefined();
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

  test("resolves default state and outgoing files under HERMES_HOME, not cwd", async () => {
    const hermesHome = makeTmp();
    const accidentalCwd = tempWorkspace();
    mkdirSync(join(hermesHome, "memory"), { recursive: true });
    await Bun.write(join(hermesHome, "memory", "heartbeat-state.json"), JSON.stringify({
      prepared: { date: "2026-06-04", taskId: "t_digest" },
    }));
    process.env.HERMES_HOME = hermesHome;

    const body = "<!-- digest-question:id=q-1 -->**One for you:** What are you building?";
    const result = await sendDailyBrief({
      date: "2026-06-04",
      hermes: (args) => {
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({ task: { id: "t_digest", status: "ready", body } });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
      confirmDeliveries: async (ids) => ({ confirmed: ids, failed: [] }),
    });

    expect("silent" in result).toBe(false);
    expect(await Bun.file(join(hermesHome, "memory", "digest-outgoing.md")).text()).toBe(body);
    expect(JSON.parse(await Bun.file(join(hermesHome, "memory", "heartbeat-state.json")).text()).questionDelivery).toEqual({ "q-1": "2026-06-04" });
    expect(existsSync(join(accidentalCwd, "memory", "digest-outgoing.md"))).toBe(false);
  });
});
