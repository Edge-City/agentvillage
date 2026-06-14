import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DAILY_LOOP_RENDER_CONFIG,
  DAILY_LOOP_WINDOWS,
  composeDailyLoopCandidate,
  evaluateDailyLoopPolicy,
  normalizeDailyLoopState,
  resolveWindowArg,
  scheduledWindowForHostHour,
  sendDailyLoop,
  stageDailyLoop,
} from "../daily-loop";

const originalCwd = process.cwd();

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "daily-loop-"));
  process.chdir(dir);
  return dir;
}

async function writeState(value: unknown): Promise<void> {
  mkdirSync("memory", { recursive: true });
  await Bun.write("memory/daily-loop-state.json", JSON.stringify(value));
}

afterEach(() => {
  const cwd = process.cwd();
  process.chdir(originalCwd);
  if (cwd !== originalCwd && cwd.includes("daily-loop-")) rmSync(cwd, { recursive: true, force: true });
});

describe("daily-loop config", () => {
  test("declares internal evaluation windows and launch-blocking render config", () => {
    expect(DAILY_LOOP_WINDOWS.map((w) => [w.window, w.prepareHour, w.sendHour])).toEqual([
      ["1500", 14, 15],
      ["1800", 17, 18],
      ["2100", 20, 21],
    ]);
    expect(DAILY_LOOP_RENDER_CONFIG.status).toBe("placeholder");
    expect(DAILY_LOOP_RENDER_CONFIG.launchBlockedOn).toContain("product/tone refinement");
    expect(DAILY_LOOP_RENDER_CONFIG.approvalMarker).toBe("APPROVED_DAILY_LOOP_SEND");
  });

  test("maps host-local scheduled hours to windows and never falls back off schedule", () => {
    expect(scheduledWindowForHostHour("prepare", 14)).toBe("1500");
    expect(scheduledWindowForHostHour("prepare", 17)).toBe("1800");
    expect(scheduledWindowForHostHour("prepare", 20)).toBe("2100");
    expect(scheduledWindowForHostHour("send", 15)).toBe("1500");
    expect(scheduledWindowForHostHour("send", 18)).toBe("1800");
    expect(scheduledWindowForHostHour("send", 21)).toBe("2100");
    expect(scheduledWindowForHostHour("send", 16)).toBeUndefined();
  });

  test("explicit --window wins, invalid window is silent-safe, and off-schedule hours do not fallback", () => {
    expect(resolveWindowArg(["--window", "1800"], "prepare", new Date(2026, 5, 13, 2))).toBe("1800");
    expect(resolveWindowArg(["--window", "bogus"], "prepare", new Date(2026, 5, 13, 14))).toBeUndefined();
    expect(resolveWindowArg([], "prepare", new Date(2026, 5, 13, 14))).toBe("1500");
    expect(resolveWindowArg([], "prepare", new Date(2026, 5, 13, 12))).toBeUndefined();
  });
});

describe("daily-loop roles and policy", () => {
  test("normalizes shared state with visible budget and record arrays for morning to write later", () => {
    const state = normalizeDailyLoopState({}, "2026-06-13");
    expect(state.visibleBudget).toEqual({ date: "2026-06-13", nonBriefLimit: 1, nonBriefSent: 0 });
    expect(state.cooldowns).toEqual({ nonBriefMinutes: 90 });
    expect(state.surfaced).toEqual([]);
    expect(state.asked).toEqual([]);
    expect(state.sent).toEqual([]);
    expect(state.skipped).toEqual([]);
  });

  test("calibration questions carry explicit role/input/question id", () => {
    const candidate = composeDailyLoopCandidate({
      date: "2026-06-13",
      window: "1500",
      context: { pendingQuestion: { id: "q-1", prompt: "What would make today useful?" } },
    });

    expect(candidate).toMatchObject({
      role: "calibrate_rest_of_day",
      inputType: "pending-question",
      questionId: "q-1",
    });
  });

  test("event follow-up can replace close-loop/tomorrow-prep in the evening", () => {
    const candidate = composeDailyLoopCandidate({
      date: "2026-06-13",
      window: "2100",
      context: {
        endedRsvpEvent: {
          title: "Dinner Salon",
          eventUrl: "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        },
        dayEventCount: 4,
      },
    });

    expect(candidate?.role).toBe("event_followup");
    expect(candidate?.replacesRoles).toEqual(["close_loop", "tomorrow_prep"]);
    expect(candidate?.body).toContain("Did you make it to [Dinner Salon]");
    expect(candidate?.body).not.toContain("I saw");
  });

  test("policy records duplicate, quiet, no-context, replacement, and budget skip reasons", () => {
    const state = normalizeDailyLoopState({
      date: "2026-06-13",
      visibleBudget: { date: "2026-06-13", nonBriefLimit: 1, nonBriefSent: 1 },
      asked: [{ at: "2026-06-13T08:00:00.000Z", role: "orient", questionId: "q-1" }],
    }, "2026-06-13");

    expect(evaluateDailyLoopPolicy({
      state,
      context: { pendingQuestion: { id: "q-1", prompt: "Same question?" } },
      candidate: { body: "Same question?", role: "calibrate_rest_of_day", inputType: "pending-question", inputLabel: "pending", questionId: "q-1" },
      window: "1500",
      nowIso: "2026-06-13T14:00:00.000Z",
    })).toEqual({ ok: false, reason: "brief-already-asked" });

    expect(evaluateDailyLoopPolicy({
      state: normalizeDailyLoopState({}, "2026-06-13"),
      context: { briefAskedQuestionIds: ["q-brief"] },
      candidate: { body: "Brief already asked this?", role: "calibrate_rest_of_day", inputType: "pending-question", inputLabel: "pending", questionId: "q-brief" },
      window: "1500",
      nowIso: "2026-06-13T14:00:00.000Z",
    })).toEqual({ ok: false, reason: "brief-already-asked" });

    expect(evaluateDailyLoopPolicy({
      state: normalizeDailyLoopState({}, "2026-06-13"),
      context: { pacePreference: "stay quiet unless I ask" },
      candidate: { body: "Ping?", role: "calibrate_rest_of_day", inputType: "thin-signal", inputLabel: "thin" },
      window: "1500",
      nowIso: "2026-06-13T14:00:00.000Z",
    })).toEqual({ ok: false, reason: "quiet-pace" });

    expect(evaluateDailyLoopPolicy({
      state: normalizeDailyLoopState({}, "2026-06-13"),
      context: {},
      candidate: null,
      window: "1800",
      nowIso: "2026-06-13T17:00:00.000Z",
    })).toEqual({ ok: false, reason: "no-new-context" });

    expect(evaluateDailyLoopPolicy({
      state,
      context: {},
      candidate: { body: "Budget?", role: "tomorrow_prep", inputType: "reflection", inputLabel: "reflection" },
      window: "2100",
      nowIso: "2026-06-13T20:00:00.000Z",
    })).toEqual({ ok: false, reason: "budget-used" });

    const replacementState = normalizeDailyLoopState({}, "2026-06-13");
    const replacement = evaluateDailyLoopPolicy({
      state: replacementState,
      context: {},
      candidate: {
        body: "Follow up?",
        role: "event_followup",
        inputType: "ended-rsvp",
        inputLabel: "event",
        replacesRoles: ["close_loop", "tomorrow_prep"],
      },
      window: "2100",
      nowIso: "2026-06-13T20:00:00.000Z",
    });
    expect(replacement.ok).toBe(true);
    expect(replacementState.skipped?.[0].reason).toBe("event-followup-replaces-evening");
  });
});

describe("daily-loop kanban flow", () => {
  test("stages one blocked Kanban card with daily-loop state/idempotency", async () => {
    tempWorkspace();
    const calls: string[][] = [];
    const result = await stageDailyLoop({
      date: "2026-06-13",
      window: "1800",
      nowIso: "2026-06-13T17:00:00.000Z",
      stateFile: "memory/daily-loop-state.json",
      context: { opportunityCount: 2, opportunityCategory: "connection" },
      hermes: (args) => {
        calls.push(args);
        if (args[0] === "kanban" && args[1] === "create") return JSON.stringify({ task: { id: "t_daily_loop" } });
        if (args[0] === "kanban" && args[1] === "block") return "blocked";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
    });

    expect(result).toEqual({ staged: true, taskId: "t_daily_loop", idempotencyKey: "daily-loop-2026-06-13-1800" });
    expect(calls[0]).toEqual([
      "kanban",
      "create",
      "Daily loop 18:00 — 2026-06-13",
      "--body",
      expect.stringContaining("If one useful person would be worth meeting this evening"),
      "--idempotency-key",
      "daily-loop-2026-06-13-1800",
      "--json",
    ]);
    expect(calls[1]).toEqual(["kanban", "block", "t_daily_loop", "review-required: daily loop 18:00 — 2026-06-13"]);

    const state = JSON.parse(await Bun.file("memory/daily-loop-state.json").text());
    expect(state.windows["1800"].taskId).toBe("t_daily_loop");
    expect(state.windows["1800"].role).toBe("calibrate_rest_of_day");
    expect(state.surfaced[0].taskId).toBe("t_daily_loop");
  });

  test("default non-brief budget is 1/day", async () => {
    tempWorkspace();
    await writeState({
      date: "2026-06-13",
      visibleBudget: { date: "2026-06-13", nonBriefLimit: 1, nonBriefSent: 1 },
      windows: {},
    });

    const capped = await stageDailyLoop({
      date: "2026-06-13",
      window: "2100",
      nowIso: "2026-06-13T20:00:00.000Z",
      stateFile: "memory/daily-loop-state.json",
      context: { activeWant: "meet protocol designers" },
      hermes: () => {
        throw new Error("hermes should not be called");
      },
    });
    expect(capped).toEqual({ staged: false, reason: "budget-used" });
  });

  test("sends only ready cards with explicit marker and updates shared state", async () => {
    tempWorkspace();
    await writeState({
      date: "2026-06-14",
      windows: {
        "1800": {
          date: "2026-06-14",
          taskId: "t_daily_loop",
          role: "calibrate_rest_of_day",
          body: "If one useful person would be worth meeting this evening, what kind of person would that be?",
          preparedAt: "2026-06-14T17:00:00.000Z",
        },
      },
    });
    const calls: string[][] = [];
    const result = await sendDailyLoop({
      date: "2026-06-14",
      window: "1800",
      nowIso: "2026-06-14T18:00:00.000Z",
      stateFile: "memory/daily-loop-state.json",
      hermes: (args) => {
        calls.push(args);
        if (args[0] === "kanban" && args[1] === "show") return JSON.stringify({
          task: {
            id: "t_daily_loop",
            status: "ready",
            body: "Approved daily-loop body\nAPPROVED_DAILY_LOOP_SEND\n<!-- daily-loop-review: internal -->\n<!-- daily-loop-source:role=calibrate_rest_of_day; input=live-opportunity; label=x -->",
          },
        });
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
    });

    expect(result).toEqual({ sent: true, taskId: "t_daily_loop", finalMessage: "Approved daily-loop body" });
    expect(calls).toEqual([
      ["kanban", "show", "t_daily_loop", "--json"],
      ["kanban", "complete", "t_daily_loop", "--summary", "delivered"],
    ]);

    const state = JSON.parse(await Bun.file("memory/daily-loop-state.json").text());
    expect(state.visibleBudget).toEqual({ date: "2026-06-14", nonBriefLimit: 1, nonBriefSent: 1, lastSentAt: "2026-06-14T18:00:00.000Z" });
    expect(state.sent[0].taskId).toBe("t_daily_loop");
    expect(state.windows["1800"].sentAt).toBe("2026-06-14T18:00:00.000Z");
  });

  test("rejects todo/missing marker and skips stale cards", async () => {
    tempWorkspace();
    await writeState({
      date: "2026-06-13",
      windows: {
        "1500": { date: "2026-06-13", taskId: "t_blocked", role: "calibrate_rest_of_day", preparedAt: "2026-06-13T14:00:00.000Z" },
        "1800": { date: "2026-06-13", taskId: "t_stale", role: "event_followup", preparedAt: "2026-06-13T17:00:00.000Z" },
      },
    });

    const todo = await sendDailyLoop({
      date: "2026-06-13",
      window: "1500",
      nowIso: "2026-06-13T15:00:00.000Z",
      stateFile: "memory/daily-loop-state.json",
      hermes: () => JSON.stringify({ task: { id: "t_blocked", status: "todo", body: "draft\nAPPROVED_DAILY_LOOP_SEND" } }),
    });
    expect(todo).toEqual({ sent: false, reason: "not-approved:todo" });

    const missingMarker = await sendDailyLoop({
      date: "2026-06-13",
      window: "1500",
      nowIso: "2026-06-13T15:00:00.000Z",
      stateFile: "memory/daily-loop-state.json",
      hermes: () => JSON.stringify({ task: { id: "t_blocked", status: "ready", body: "draft" } }),
    });
    expect(missingMarker).toEqual({ sent: false, reason: "missing-approval-marker" });

    const staleCalls: string[][] = [];
    const stale = await sendDailyLoop({
      date: "2026-06-13",
      window: "1800",
      nowIso: "2026-06-13T20:00:00.000Z",
      stateFile: "memory/daily-loop-state.json",
      hermes: (args) => {
        staleCalls.push(args);
        if (args[0] === "kanban" && args[1] === "complete") return "completed";
        throw new Error(`unexpected hermes call: ${args.join(" ")}`);
      },
    });
    expect(stale).toEqual({ sent: false, reason: "stale" });
    expect(staleCalls).toEqual([["kanban", "complete", "t_stale", "--summary", "skipped-stale"]]);
  });
});
