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
import { type ProactiveOptions, RUNS_KEY, deliveryGate, hardStopCleanup, inBriefWindow, runProactive, villageMinuteOfDay } from "../proactive";
import { lockPathFor } from "../state-lock";

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

  test("every 30 seconds over 48 hours, every job decides exactly as on origin/main (only the brief gated, on inBriefWindow)", () => {
    const absent = readJobSettings(home);
    const start = Date.UTC(2026, 9, 4, 0, 0, 0);
    let checked = 0;
    for (let t = start; t < start + 2 * 86_400_000; t += 30_000) {
      const now = new Date(t);
      for (const key of ["brief", "drop-midday", "drop-evening", "negotiation", "evening"] as const) {
        const gate = deliveryGate(deliveryFor(key, absent), now);
        const before = key === "brief" && !inBriefWindow(now) ? "outside-window" : null;
        if ((gate?.reason ?? null) !== before || (gate && "settings" in gate)) throw new Error(`${key} differs at ${now.toISOString()}`);
        checked++;
      }
      if (villageMinuteOfDay(now) !== minuteOfDay(now, "Asia/Kolkata")) throw new Error(`village clock differs at ${now.toISOString()}`);
    }
    expect(checked).toBe(5 * 2 * 2880);
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
