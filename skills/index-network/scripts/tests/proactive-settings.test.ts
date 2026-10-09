/**
 * J2 per-job settings in the trigger (proactive.ts): rc13 parity with no
 * settings, each job's window and zone, fallbacks that never widen, the
 * template actions, the team-only preview, and the shim's new names.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { BriefOpportunity, DailyBriefContext } from "../build-daily-brief-context";
import { PREVIEW_MAX_AGE_MS, deliveryFor, jobSettingsPath, minuteOfDay, readJobSettings } from "../job-settings";
import { stagePath } from "../outcome-ask";
import { type ProactiveOptions, RUNS_KEY, deliveryGate, hardStopCleanup, runProactive, windowDecision } from "../proactive";
import { pendingAlert } from "../pending-alert";
import { lockPathFor } from "../state-lock";
import { inBriefWindow, rc13WindowDecision, villageMinuteOfDay } from "./fixtures/rc13-decision";

const DEADLINE_CHILD = join(import.meta.dir, "fixtures", "proactive-deadline-child.ts");

const DATE = "2026-10-12";
/** 08:00 IST. */
const MORNING = new Date("2026-10-12T02:30:00Z");
/** 15:00 IST. */
const AFTERNOON = new Date("2026-10-12T09:30:00Z");

let home: string;
const ENV_KEYS = ["AV_TEAM_TENANT", "AV_PORTAL_URL", "AV_CONNECTIONS_URL", "AV_EVENTS_TOKEN", "AV_EVENTS_ENABLED", "AV_HOOKS_DISABLED"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-proactive-settings-"));
  mkdirSync(join(home, "memory"), { recursive: true });
  for (const key of ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function card(name: string, id: string): BriefOpportunity {
  return { name, opportunityId: id, userUrl: `https://index.network/u/${id}`, opportunityUrl: `https://index.network/o/${id}`, feedCategory: "connection" };
}

function context(): DailyBriefContext {
  return {
    date: DATE, displayDate: "Monday, October 12", timezone: "Asia/Kolkata", announcements: [], rsvpEvents: [], highlightedEvents: [], interestEvents: [],
    opportunities: [], connectionOpportunities: [card("Maya Rao", "op1")], communityOpportunities: [], connectionsStillWaiting: 0, moreWaitingThanListed: false,
    eligibleMatchCount: 1, userModel: { phrases: [], interestTags: [] }, weather: null, questions: [],
    diagnostics: { announcementsSource: "control-plane", calendarSource: "edgeos", rsvpSource: "edgeos", opportunitySource: "mcp", weatherSource: "open-meteo", dreamingFresh: true, warnings: [], interestTags: [] },
  } as unknown as DailyBriefContext;
}

function options(over: Partial<ProactiveOptions> = {}): ProactiveOptions {
  return {
    home,
    now: () => MORNING,
    lock: { waitMs: 50, pollMs: 5 },
    buildContext: async () => context(),
    approvals: () => 0,
    drop: async () => ({ opportunity: card("Arjun", "op2") }),
    evening: async () => ({ name: "Lena", userUrl: "https://index.network/u/l", opportunityUrl: "https://index.network/o/l" }),
    followUp: async () => ({ signals: [], needsAttention: [{ name: "Maya Rao", userUrl: "https://index.network/u/m", opportunityUrl: "https://index.network/o/m" }], waiting: [], newlyResolved: [] }),
    ...over,
  } as ProactiveOptions;
}

function settings(jobs: unknown): void {
  mkdirSync(join(home, "av-events"), { recursive: true });
  writeFileSync(jobSettingsPath(home), typeof jobs === "string" ? jobs : JSON.stringify({ v: 1, jobs }));
}

function stateFile(): string {
  return join(home, "memory", "heartbeat-state.json");
}

function state(): Record<string, any> {
  return existsSync(stateFile()) ? JSON.parse(readFileSync(stateFile(), "utf8")) : {};
}

function last(lines: string[]): unknown {
  return JSON.parse(lines[lines.length - 1]);
}

function runLog(): Array<Record<string, any>> {
  const path = join(home, "av-events", "proactive", "triggers.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

describe("no settings file: rc13, unchanged", () => {
  test("the brief's gate opens on exactly rc13's minutes, every minute of a day; no other job has a window", () => {
    const absent = readJobSettings(home);
    for (let minute = 0; minute < 24 * 60; minute++) {
      const at = new Date(Date.UTC(2026, 9, 11, 18, 30) + minute * 60_000); // from 00:00 IST
      expect({ minute, open: deliveryGate(deliveryFor("brief", absent), at) === null }).toEqual({ minute, open: inBriefWindow(at) });
      for (const key of ["drop-midday", "drop-evening", "negotiation", "evening"] as const) {
        if (deliveryGate(deliveryFor(key, absent), at) !== null) throw new Error(`${key} gated at minute ${minute}`);
      }
    }
  });

  test("every 30 seconds over 48 hours, every job's live decision path decides exactly as rc13's, frozen from 9ff10b9 (fixtures/rc13-decision.ts)", () => {
    const start = Date.UTC(2026, 9, 4, 0, 0, 0);
    let checked = 0;
    let gated = 0;
    for (let t = start; t < start + 2 * 86_400_000; t += 30_000) {
      const now = new Date(t);
      for (const key of ["brief", "drop-midday", "drop-evening", "negotiation", "evening"] as const) {
        // The trigger's own first decision (runAgentAction calls windowDecision), reading the (absent) settings file itself.
        const live = windowDecision(key, home, now).gated;
        const rc13 = rc13WindowDecision(key, now);
        if ((live?.reason ?? null) !== rc13 || (live && "settings" in live)) throw new Error(`${key} differs at ${now.toISOString()}`);
        if (rc13) gated++;
        checked++;
      }
      // rc13's village clock and the live one read the same minute.
      if (villageMinuteOfDay(now) !== minuteOfDay(now, "Asia/Kolkata")) throw new Error(`village clock differs at ${now.toISOString()}`);
    }
    expect(checked).toBe(5 * 2 * 2880);
    // The brief is gated 18 hours a day, over two days.
    expect(gated).toBe(2 * 18 * 120);
    expect(existsSync(jobSettingsPath(home))).toBe(false);
  });

  test("the same wake lines, state and log line as rc13: no settings field anywhere", async () => {
    const brief = await runProactive("brief", options());
    expect(brief.woke).toBe(true);
    expect(brief.settings).toBeUndefined();
    const outside = await runProactive("brief", options({ now: () => AFTERNOON }));
    expect(outside.lines).toEqual([JSON.stringify({ wakeAgent: false, reason: "outside-window" })]);
    expect(Object.keys(outside).sort()).toEqual(["exitCode", "lines", "reason", "woke"]);
    const drop = await runProactive("drop-midday", options({ now: () => AFTERNOON }));
    expect(drop.woke).toBe(true);
    expect(state()[RUNS_KEY]).toEqual({ brief: DATE, "drop-midday": DATE });
    for (const line of runLog()) expect(Object.keys(line).sort()).toEqual(["action", "decision", "reason", "source", "ts", "v"]);
  });
});

describe("each job's window and zone", () => {
  test("a drop with a window is silent outside it, before anything is picked or written, and wakes inside it", async () => {
    settings({ "drop-midday": { window: "12:00-13:00" } });
    let picked = 0;
    const drop = async () => (picked++, { opportunity: card("Arjun", "op2") });
    const outside = await runProactive("drop-midday", options({ now: () => AFTERNOON, drop }));
    expect(last(outside.lines)).toEqual({ wakeAgent: false, reason: "outside-window" });
    expect(picked).toBe(0);
    expect(existsSync(stateFile())).toBe(false);
    const inside = await runProactive("drop-midday", options({ now: () => new Date("2026-10-12T06:45:00Z"), drop })); // 12:15 IST
    expect(inside.woke).toBe(true);
    expect(runLog().map((line) => [line.reason, line.settings])).toEqual([["outside-window", "custom"], ["woke", "custom"]]);
  });

  test("the brief moved to the afternoon: silent at 08:00, delivered at 15:00", async () => {
    settings({ brief: { window: "14:00-16:00" } });
    expect(last((await runProactive("brief", options())).lines)).toEqual({ wakeAgent: false, reason: "outside-window" });
    expect((await runProactive("brief", options({ now: () => AFTERNOON }))).woke).toBe(true);
  });

  test("a window across midnight", async () => {
    settings({ negotiation: { window: "22:00-02:00" } });
    const at = (utc: string) => runProactive("negotiation", options({ now: () => new Date(utc) }));
    expect(last((await at("2026-10-12T16:29:00Z")).lines)).toEqual({ wakeAgent: false, reason: "outside-window" }); // 21:59 IST
    expect((await at("2026-10-12T20:29:00Z")).woke).toBe(true); // 01:59 IST on the 13th
    rmSync(stateFile());
    expect(last((await at("2026-10-12T20:30:00Z")).lines)).toEqual({ wakeAgent: false, reason: "outside-window" }); // 02:00
  });

  test("a resident's own zone, across their DST change", async () => {
    settings({ "drop-evening": { window: "07:00-09:00", tz: "America/New_York" } });
    const at = (utc: string) => runProactive("drop-evening", options({ now: () => new Date(utc) }));
    expect((await at("2026-10-12T11:30:00Z")).woke).toBe(true); // 07:30 EDT
    expect(last((await at("2026-11-02T11:30:00Z")).lines)).toEqual({ wakeAgent: false, reason: "outside-window" }); // 06:30 EST
    expect((await at("2026-11-02T12:30:00Z")).woke).toBe(true); // 07:30 EST
  });

  test("a bad zone never shifts the window by hours: the brief keeps 05:00-11:00 IST and logs why", async () => {
    settings({ brief: { window: "14:00-16:00", tz: "Mars/Olympus" } });
    expect(last((await runProactive("brief", options({ now: () => AFTERNOON }))).lines)).toEqual({ wakeAgent: false, reason: "outside-window" });
    expect((await runProactive("brief", options())).woke).toBe(true);
    expect(runLog().map((line) => line.settings)).toEqual(["invalid:tz", "invalid:tz"]);
  });

  test("a malformed window on a job with no default is held silent, never run all day", async () => {
    settings({ "drop-midday": { window: "12:00-" } });
    let picked = 0;
    const result = await runProactive("drop-midday", options({ drop: async () => (picked++, { opportunity: card("Arjun", "op2") }) }));
    expect(last(result.lines)).toEqual({ wakeAgent: false, reason: "settings-invalid" });
    expect(picked).toBe(0);
    expect(runLog().at(-1)).toMatchObject({ action: "drop-midday", reason: "settings-invalid", settings: "invalid:window" });
  });

  test("a corrupt file: the brief on its default, every job without a default held", async () => {
    settings("{not json");
    expect((await runProactive("brief", options())).woke).toBe(true);
    for (const action of ["drop-midday", "drop-evening", "negotiation", "evening"] as const) {
      const result = await runProactive(action, options({ now: () => AFTERNOON }));
      expect({ action, line: last(result.lines) }).toEqual({ action, line: { wakeAgent: false, reason: "settings-invalid" } });
    }
    expect(new Set(runLog().map((line) => line.settings))).toEqual(new Set(["invalid:file-not-json"]));
  });

  test("a settings change during the day never brings a second send: the day mark is unchanged", async () => {
    expect((await runProactive("brief", options())).woke).toBe(true);
    settings({ brief: { window: "14:00-16:00", tz: "UTC" } });
    // 14:30 UTC is 20:00 IST, still the 12th in the village.
    const again = await runProactive("brief", options({ now: () => new Date("2026-10-12T14:30:00Z") }));
    expect(last(again.lines)).toEqual({ wakeAgent: false, reason: "done-today" });
    settings({ brief: { window: "14:00-16:00" } });
    expect(last((await runProactive("brief", options({ now: () => AFTERNOON }))).lines)).toEqual({ wakeAgent: false, reason: "done-today" });
    expect(state()[RUNS_KEY]).toEqual({ brief: DATE });
  });
});

describe("the template actions", () => {
  test("each runs its base job's content path with its own day mark and its own settings", async () => {
    expect((await runProactive("brief", options())).woke).toBe(true);
    const tpl = await runProactive("tpl-brief", options());
    expect(tpl.woke).toBe(true);
    expect(JSON.parse(tpl.lines.slice(0, -1).join("\n")).job).toBe("morning-brief");
    expect(last((await runProactive("tpl-brief", options())).lines)).toEqual({ wakeAgent: false, reason: "done-today" });
    rmSync(stateFile());
    // The brief template inherits the brief's default window.
    expect(last((await runProactive("tpl-brief", options({ now: () => AFTERNOON }))).lines)).toEqual({ wakeAgent: false, reason: "outside-window" });
    settings({ "tpl-brief": { window: "14:00-16:00" } });
    expect((await runProactive("tpl-brief", options({ now: () => AFTERNOON }))).woke).toBe(true);
    const digest = await runProactive("tpl-digest-preview", options({ now: () => AFTERNOON }));
    expect(JSON.parse(digest.lines.slice(0, -1).join("\n")).job).toBe("opportunity-drop");
    expect(state()[RUNS_KEY]).toEqual({ "tpl-brief": DATE, "tpl-digest-preview": DATE });
  });

  test("the evening template never stages the outcome ask and leaves a real run's stage alone", async () => {
    process.env.AV_EVENTS_TOKEN = "test-token";
    mkdirSync(join(home, "av-events", "proactive"), { recursive: true });
    writeFileSync(stagePath(home), '{"v":1,"from":"the real evening job"}');
    let listed = 0;
    const result = await runProactive("tpl-evening-ask", options({ now: () => AFTERNOON, accepted: async () => (listed++, []) }));
    expect(result.woke).toBe(true);
    expect(result.detail).toBe("outcome-ask-template-job");
    expect(listed).toBe(0);
    expect(readFileSync(stagePath(home), "utf8")).toBe('{"v":1,"from":"the real evening job"}');
    expect(state()[RUNS_KEY]).toEqual({ "tpl-evening-ask": DATE });
    // The installer's evening job still clears a stale stage, as on rc13.
    await runProactive("evening", options({ now: () => AFTERNOON, accepted: async () => [] }));
    expect(existsSync(stagePath(home))).toBe(false);
  });
});

describe("the preview: team tenants only, nothing written that the real run reads", () => {
  test("refused without AV_TEAM_TENANT=1: silent, logged as a preview, nothing built or written", async () => {
    for (const value of [undefined, "0", "true", "yes"]) {
      if (value === undefined) delete process.env.AV_TEAM_TENANT;
      else process.env.AV_TEAM_TENANT = value;
      let built = 0;
      const result = await runProactive("brief", options({ preview: true, buildContext: async () => (built++, context()) }));
      expect({ value, line: last(result.lines), built }).toEqual({ value, line: { wakeAgent: false, reason: "preview-refused" }, built: 0 });
    }
    expect(existsSync(stateFile())).toBe(false);
    expect(runLog().every((line) => line.preview === true && line.reason === "preview-refused")).toBe(true);
  });

  test("a team tenant's preview ignores the window and the day mark and leaves the state byte for byte", async () => {
    process.env.AV_TEAM_TENANT = "1";
    expect((await runProactive("brief", options())).woke).toBe(true);
    const before = readFileSync(stateFile(), "utf8");
    // Outside the window, and the day already done.
    const preview = await runProactive("brief", options({ now: () => AFTERNOON, preview: true }));
    expect(preview.woke).toBe(true);
    expect(JSON.parse(preview.lines.slice(0, -1).join("\n")).job).toBe("morning-brief");
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
    expect(runLog().at(-1)).toMatchObject({ action: "brief", decision: "woke", reason: "woke", preview: true });
  });

  test("a preview before the real run consumes nothing: the real run still delivers that day", async () => {
    process.env.AV_TEAM_TENANT = "1";
    for (const action of ["brief", "drop-midday", "drop-evening", "negotiation", "evening", "tpl-brief", "tpl-digest-preview", "tpl-evening-ask"] as const) {
      expect({ action, woke: (await runProactive(action, options({ preview: true }))).woke }).toEqual({ action, woke: true });
    }
    expect(existsSync(stateFile())).toBe(false);
    expect((await runProactive("brief", options())).woke).toBe(true);
    expect((await runProactive("drop-midday", options())).woke).toBe(true);
    expect(state()[RUNS_KEY]).toEqual({ brief: DATE, "drop-midday": DATE });
  });

  test("the content path writes only a private copy of the state, deleted afterwards", async () => {
    process.env.AV_TEAM_TENANT = "1";
    writeFileSync(stateFile(), JSON.stringify({ deliveredToday: { date: DATE, ids: ["op0"] } }));
    const before = readFileSync(stateFile(), "utf8");
    let seen = "";
    let copy: Record<string, unknown> = {};
    const drop = async ({ stateFile: path }: { stateFile?: string }) => {
      seen = path!;
      copy = JSON.parse(readFileSync(path!, "utf8"));
      // As the real pick script does: reserve the pick in the state it was given.
      writeFileSync(path!, JSON.stringify({ deliveredToday: { date: DATE, ids: ["op0", "op2"] } }));
      return { opportunity: card("Arjun", "op2") };
    };
    const result = await runProactive("drop-midday", options({ preview: true, drop: drop as ProactiveOptions["drop"] }));
    expect(result.woke).toBe(true);
    expect(seen).not.toBe(stateFile());
    expect(seen.startsWith(join(home, "av-events", "proactive", "preview-"))).toBe(true);
    expect(copy).toEqual({ deliveredToday: { date: DATE, ids: ["op0"] } });
    expect(existsSync(seen)).toBe(false);
    expect(readdirSync(join(home, "av-events", "proactive")).filter((name) => name.startsWith("preview-"))).toEqual([]);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
  });

  test("it never takes the state lock: a held lock neither delays nor silences it, and is left in place", async () => {
    process.env.AV_TEAM_TENANT = "1";
    const lock = lockPathFor(stateFile());
    writeFileSync(lock, JSON.stringify({ token: "held-by-a-real-run", pid: 1, at: Date.now() }));
    const result = await runProactive("negotiation", options({ preview: true, lock: { waitMs: 1, pollMs: 1 } }));
    expect(result.woke).toBe(true);
    expect(JSON.parse(readFileSync(lock, "utf8")).token).toBe("held-by-a-real-run");
    // The real run, by contrast, waits on it.
    expect(last((await runProactive("negotiation", options({ lock: { waitMs: 1, pollMs: 1 } }))).lines)).toEqual({ wakeAgent: false, reason: "state-locked" });
  });

  test("an evening preview leaves a real run's outcome-ask stage byte for byte (only the real evening job clears it)", async () => {
    process.env.AV_TEAM_TENANT = "1";
    process.env.AV_EVENTS_TOKEN = "test-token";
    mkdirSync(join(home, "av-events", "proactive"), { recursive: true });
    const stage = '{"v":1,"opportunityId":"0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d","from":"the real evening job, its model still writing"}\n';
    writeFileSync(stagePath(home), stage);
    for (const accepted of [async () => [], async () => [{ ...card("Arjun Mehta", "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d"), status: "accepted" }]]) {
      const result = await runProactive("evening", options({ now: () => AFTERNOON, preview: true, accepted: accepted as ProactiveOptions["accepted"] }));
      expect(result.preview).toBe(true);
      expect(readFileSync(stagePath(home), "utf8")).toBe(stage);
    }
  });

  test("the evening preview with an outcome ask due stages nothing and records no attempt", async () => {
    process.env.AV_TEAM_TENANT = "1";
    process.env.AV_EVENTS_TOKEN = "test-token";
    const OPP = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
    writeFileSync(stateFile(), JSON.stringify({ negotiationSummary: { reportedCompletedIds: [OPP], announcedOn: { [OPP]: "2026-10-09" } } }));
    const before = readFileSync(stateFile(), "utf8");
    const accepted = async () => [{ ...card("Arjun Mehta", OPP), status: "accepted" }];
    const result = await runProactive("evening", options({ now: () => AFTERNOON, preview: true, accepted }));
    expect(JSON.parse(result.lines.slice(0, -1).join("\n")).outcomeQuestion).toBe("Did you and Arjun Mehta meet? Reply met, not useful, or missed.");
    expect(existsSync(stagePath(home))).toBe(false);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
  });

  test("the hard deadline removes the preview's state copy (its finally never runs on that exit)", async () => {
    process.env.AV_TEAM_TENANT = "1";
    let release: () => void = () => {};
    let entered: () => void = () => {};
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const drop = async () => {
      entered();
      await new Promise<void>((resolve) => { release = resolve; });
      return { opportunity: card("Arjun", "op2") };
    };
    const running = runProactive("drop-midday", options({ preview: true, drop: drop as ProactiveOptions["drop"] }));
    await inside;
    const copies = () => readdirSync(join(home, "av-events", "proactive")).filter((name) => name.startsWith("preview-"));
    expect(copies()).toHaveLength(1);
    hardStopCleanup();
    expect(copies()).toEqual([]);
    release();
    await running;
    expect(copies()).toEqual([]);
  });

  test("main's hard deadline, run in a child process: the trigger-timeout line, and the preview's state copy is gone", async () => {
    const proc = Bun.spawn([process.execPath, DEADLINE_CHILD, "drop-midday", home], {
      env: { ...process.env, AV_TEAM_TENANT: "1", HERMES_HOME: home },
      stdout: "pipe",
      stderr: "ignore",
    });
    const code = await proc.exited;
    const out = (await new Response(proc.stdout).text()).trim();
    // The content path was entered with a copy in place, and only the deadline ended the run.
    expect(JSON.parse(readFileSync(join(home, "entered.json"), "utf8"))).toHaveLength(1);
    expect({ code, out }).toEqual({ code: 0, out: JSON.stringify({ wakeAgent: false, reason: "trigger-timeout" }) });
    expect(readdirSync(join(home, "av-events", "proactive")).filter((name) => name.startsWith("preview-"))).toEqual([]);
    expect(runLog().at(-1)).toMatchObject({ action: "drop-midday", reason: "trigger-timeout", preview: true });
  });

  test("a preview first prunes state copies a killed preview left more than an hour ago", async () => {
    process.env.AV_TEAM_TENANT = "1";
    const dir = join(home, "av-events", "proactive");
    mkdirSync(join(dir, "preview-Killed"), { recursive: true });
    mkdirSync(join(dir, "preview-Recent"), { recursive: true });
    const old = new Date(Date.now() - PREVIEW_MAX_AGE_MS - 60_000);
    utimesSync(join(dir, "preview-Killed"), old, old);
    expect((await runProactive("negotiation", options({ preview: true }))).woke).toBe(true);
    expect(readdirSync(dir).filter((name) => name.startsWith("preview-")).sort()).toEqual(["preview-Recent"]);
  });

  test("the prefetch has no preview", async () => {
    process.env.AV_TEAM_TENANT = "1";
    const result = await runProactive("prefetch", options({ preview: true }));
    expect(result).toMatchObject({ exitCode: 0, woke: false, reason: "preview-not-agent-job" });
  });
});

describe("the shim: template and preview names", () => {
  const SHIM = join(import.meta.dir, "..", "shims", "agentvillage_proactive.sh");

  function runAs(action: string): { code: number | null; args: string; last: unknown } {
    const bin = join(home, "fakebin");
    mkdirSync(bin, { recursive: true });
    const argsFile = join(home, "bun-args");
    rmSync(argsFile, { force: true });
    writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash\necho "$@" > "${argsFile}"\necho '{"wakeAgent": true}'\nexit 0\n`);
    chmodSync(join(bin, "bun"), 0o755);
    mkdirSync(join(home, "scripts"), { recursive: true });
    mkdirSync(join(home, "skills", "index-network", "scripts"), { recursive: true });
    writeFileSync(join(home, "skills", "index-network", "scripts", "proactive.ts"), "");
    const script = join(home, "scripts", `agentvillage_proactive_${action}.sh`);
    copyFileSync(SHIM, script);
    const done = Bun.spawnSync(["bash", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, cwd: tmpdir() });
    const lines = done.stdout.toString().trim().split("\n");
    return { code: done.exitCode, args: existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim() : "", last: JSON.parse(lines[lines.length - 1]) };
  }

  test("a template name runs its own action; a preview name runs the action with --preview", () => {
    expect(runAs("tpl-digest-preview").args).toBe("skills/index-network/scripts/proactive.ts tpl-digest-preview");
    expect(runAs("preview-brief").args).toBe("skills/index-network/scripts/proactive.ts brief --preview");
    expect(runAs("preview-tpl-evening-ask").args).toBe("skills/index-network/scripts/proactive.ts tpl-evening-ask --preview");
  });

  test("no preview of the prefetch, and no other name", () => {
    for (const name of ["preview-prefetch", "tpl-other", "preview-", "preview-preview-brief", "tpl-brief --preview"]) {
      expect({ name, ...runAs(name) }).toEqual({ name, code: 0, args: "", last: { wakeAgent: false, reason: "unknown-action" } });
    }
  });
});

describe("DATA-430: the hourly pending alert (`pending`)", () => {
  const PENDING_ID = (n: number) => `ffffffff-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const pendingCard = (n: number, name: string): BriefOpportunity => ({
    name,
    status: "pending",
    opportunityId: PENDING_ID(n),
    userUrl: `https://index.network/u/u${n}`,
    acceptUrl: `https://index.network/o/${PENDING_ID(n)}?action=accept&viewer=v${n}&sig=s${n}`,
  });
  /** The real pick over a fixed list: the trigger's own path, no network. */
  const realPick = (cards: () => BriefOpportunity[], calls?: Array<{ stateFile?: string; now?: Date }>): ProactiveOptions["pending"] =>
    (async (opts: { stateFile?: string; now?: Date }) => {
      calls?.push(opts);
      return pendingAlert({ ...opts, apiKey: "fake-key", mcpUrl: "https://index-mcp.fake.test/mcp", listOpportunities: async () => ({ cards: cards(), unidentified: 0, listing: { complete: true, pendingIds: new Set(cards().map((c) => c.opportunityId!)) } }) });
    }) as ProactiveOptions["pending"];

  test("no settings file: its gate opens on exactly 08:00 to 22:00 IST, every minute of a day", () => {
    const absent = readJobSettings(home);
    expect(deliveryFor("pending", absent)).toEqual({ window: { start: 480, end: 1320 }, tz: "Asia/Kolkata" });
    for (let minute = 0; minute < 24 * 60; minute++) {
      const at = new Date(Date.UTC(2026, 9, 11, 18, 30) + minute * 60_000); // from 00:00 IST
      const open = deliveryGate(deliveryFor("pending", absent), at) === null;
      if (open !== (minute >= 8 * 60 && minute < 22 * 60)) throw new Error(`pending gate wrong at minute ${minute}`);
    }
  });

  test("outside its window: silent `outside-window`, before anything is read or written", async () => {
    let picked = 0;
    const pending = (async () => (picked++, { silent: true, reason: "nothing-new" })) as ProactiveOptions["pending"];
    for (const utc of ["2026-10-12T02:29:00Z", "2026-10-12T16:30:00Z", "2026-10-12T20:00:00Z"]) { // 07:59, 22:00, 01:30 IST
      const result = await runProactive("pending", options({ now: () => new Date(utc), pending }));
      expect({ utc, line: last(result.lines) }).toEqual({ utc, line: { wakeAgent: false, reason: "outside-window" } });
    }
    expect(picked).toBe(0);
    expect(existsSync(stateFile())).toBe(false);
  });

  test("a card that turned pending overnight is alerted at the first run inside the window, not before", async () => {
    let cards = [pendingCard(1, "Asha")];
    const pending = realPick(() => cards);
    // Seeded on the evening before (21:20 IST).
    expect(last((await runProactive("pending", options({ now: () => new Date("2026-10-11T15:50:00Z"), pending }))).lines)).toEqual({ wakeAgent: false, reason: "seeded" });
    cards = [pendingCard(1, "Asha"), pendingCard(2, "Bilal")];
    // 23:20 and 07:20 IST: quiet hours; nothing written for the new card.
    for (const utc of ["2026-10-11T17:50:00Z", "2026-10-12T01:50:00Z"]) {
      expect(last((await runProactive("pending", options({ now: () => new Date(utc), pending }))).lines)).toEqual({ wakeAgent: false, reason: "outside-window" });
    }
    expect(Object.keys(state().pendingAlerts)).toEqual([PENDING_ID(1)]);
    // 08:20 IST: alerted.
    const at = new Date("2026-10-12T02:50:00Z");
    const woke = await runProactive("pending", options({ now: () => at, pending }));
    expect(woke.woke).toBe(true);
    const view = JSON.parse(woke.lines.slice(0, -1).join("\n"));
    expect(view).toEqual({
      agentName: "Edge",
      job: "pending-opportunity",
      cards: [{
        name: "Bilal",
        profileUrl: "https://agents.edgecity.live/rolodex?person=u2",
        appUrl: `https://agents.edgecity.live/intents?opportunity=${PENDING_ID(2)}#opportunity-${PENDING_ID(2)}`,
        acceptUrl: `https://index.network/o/${PENDING_ID(2)}?action=accept&viewer=v2&sig=s2&surface=telegram`,
        opportunityId: PENDING_ID(2),
        firstSeen: at.toISOString(),
        respondBy: null,
      }],
    });
    expect(state().pendingAlerts[PENDING_ID(2)]).toEqual({ firstSeen: at.toISOString(), lastSeen: at.toISOString(), alertedAt: at.toISOString() });
  });

  test("the once-a-day mark never gates it: a second new card the same day wakes again; no day mark is written, and a stale one is ignored", async () => {
    let cards = [pendingCard(1, "Asha")];
    const calls: Array<{ stateFile?: string; now?: Date }> = [];
    const pending = realPick(() => cards, calls);
    writeFileSync(stateFile(), JSON.stringify({ [RUNS_KEY]: { pending: DATE, brief: DATE } }));
    expect(last((await runProactive("pending", options({ pending }))).lines)).toEqual({ wakeAgent: false, reason: "seeded" });
    cards = [pendingCard(1, "Asha"), pendingCard(2, "Bilal")];
    expect((await runProactive("pending", options({ now: () => new Date("2026-10-12T03:50:00Z"), pending }))).woke).toBe(true); // 09:20 IST
    // A repeat poll sends nothing.
    expect(last((await runProactive("pending", options({ now: () => new Date("2026-10-12T04:50:00Z"), pending }))).lines)).toEqual({ wakeAgent: false, reason: "nothing-new" });
    cards = [pendingCard(1, "Asha"), pendingCard(2, "Bilal"), pendingCard(3, "Chen")];
    expect((await runProactive("pending", options({ now: () => AFTERNOON, pending }))).woke).toBe(true);
    // The day marks are as they were: the pending alert neither reads nor writes one.
    expect(state()[RUNS_KEY]).toEqual({ pending: DATE, brief: DATE });
    expect(calls.map((call) => call.stateFile)).toEqual(Array(4).fill(stateFile()));
    expect(runLog().map((line) => line.reason)).toEqual(["seeded", "woke", "nothing-new", "woke"]);
  });

  test("its own window from the settings file, like any job (J2)", async () => {
    settings({ pending: { window: "09:00-18:00" } });
    const pending = (async () => ({ silent: true, reason: "nothing-new" })) as ProactiveOptions["pending"];
    expect(last((await runProactive("pending", options({ pending }))).lines)).toEqual({ wakeAgent: false, reason: "outside-window" }); // 08:00 IST
    expect(last((await runProactive("pending", options({ now: () => AFTERNOON, pending }))).lines)).toEqual({ wakeAgent: false, reason: "nothing-new" });
    // A malformed entry falls back to its default window, never to all day.
    settings({ pending: { window: "9-18" } });
    expect(last((await runProactive("pending", options({ now: () => new Date("2026-10-12T17:00:00Z"), pending }))).lines)).toEqual({ wakeAgent: false, reason: "outside-window" }); // 22:30 IST
    expect(runLog().at(-1)).toMatchObject({ action: "pending", settings: "invalid:window" });
  });

  test("a corrupt state file follows the trigger's healing rule: renamed aside, the run starts from empty and seeds silently", async () => {
    writeFileSync(stateFile(), "{not json");
    const result = await runProactive("pending", options({ pending: realPick(() => [pendingCard(1, "Asha")]) }));
    expect(last(result.lines)).toEqual({ wakeAgent: false, reason: "seeded" });
    expect(result.note).toBe("state-renamed-aside");
    expect(readdirSync(join(home, "memory")).filter((name) => name.includes(".corrupt-"))).toHaveLength(1);
    expect(Object.keys(state().pendingAlerts)).toEqual([PENDING_ID(1)]);
  });

  test("a failed Index read inside the pick: silent `index-unavailable`, nothing written", async () => {
    const before = JSON.stringify({ pendingAlerts: {} });
    writeFileSync(stateFile(), before);
    const pending = (async (opts: { stateFile?: string; now?: Date }) =>
      pendingAlert({ ...opts, apiKey: "fake-key", mcpUrl: "https://index-mcp.fake.test/mcp", listOpportunities: async () => { throw new Error("mcp-unparsed"); } })) as ProactiveOptions["pending"];
    expect(last((await runProactive("pending", options({ pending }))).lines)).toEqual({ wakeAgent: false, reason: "index-unavailable" });
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
  });

  test("a preview of it (team tenants) writes nothing the real run reads", async () => {
    process.env.AV_TEAM_TENANT = "1";
    const before = JSON.stringify({ pendingAlerts: {} });
    writeFileSync(stateFile(), before);
    const result = await runProactive("pending", options({ preview: true, now: () => new Date("2026-10-12T20:00:00Z"), pending: realPick(() => [pendingCard(1, "Asha")]) }));
    expect(result.woke).toBe(true);
    expect(readFileSync(stateFile(), "utf8")).toBe(before);
  });

  test("the shim runs it, and its preview", () => {
    const SHIM = join(import.meta.dir, "..", "shims", "agentvillage_proactive.sh");
    const run = (action: string) => {
      const bin = join(home, "fakebin");
      mkdirSync(bin, { recursive: true });
      const argsFile = join(home, "bun-args");
      rmSync(argsFile, { force: true });
      writeFileSync(join(bin, "bun"), `#!/usr/bin/env bash\necho "$@" > "${argsFile}"\necho '{"wakeAgent": true}'\nexit 0\n`);
      chmodSync(join(bin, "bun"), 0o755);
      mkdirSync(join(home, "scripts"), { recursive: true });
      mkdirSync(join(home, "skills", "index-network", "scripts"), { recursive: true });
      writeFileSync(join(home, "skills", "index-network", "scripts", "proactive.ts"), "");
      const script = join(home, "scripts", `agentvillage_proactive_${action}.sh`);
      copyFileSync(SHIM, script);
      Bun.spawnSync(["bash", script], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, cwd: tmpdir() });
      return existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim() : "";
    };
    expect(run("pending")).toBe("skills/index-network/scripts/proactive.ts pending");
    expect(run("preview-pending")).toBe("skills/index-network/scripts/proactive.ts pending --preview");
  });
});
