/**
 * J2 per-job settings: the grammars and the reader (job-settings.ts). The
 * trigger's use of them is in proactive-settings.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TZ,
  DEFAULT_WINDOWS,
  MAX_SETTINGS_BYTES,
  SETTINGS_JOB_KEYS,
  deliveryFor,
  formatWindow,
  inWindow,
  isTeamTenant,
  isValidTimeZone,
  jobSettingsPath,
  minuteOfDay,
  parseStrictCron,
  parseWindow,
  readJobSettings,
  scheduleMeetsWindow,
  writeJobSettings,
} from "../job-settings";
import { BRIEF_WINDOW } from "../proactive";

let home: string;
const savedTeam = process.env.AV_TEAM_TENANT;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-job-settings-"));
  delete process.env.AV_TEAM_TENANT;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (savedTeam === undefined) delete process.env.AV_TEAM_TENANT;
  else process.env.AV_TEAM_TENANT = savedTeam;
});

function writeSettings(value: unknown): void {
  mkdirSync(join(home, "av-events"), { recursive: true });
  writeFileSync(jobSettingsPath(home), typeof value === "string" ? value : JSON.stringify(value));
}

describe("the window grammar: HH:MM-HH:MM, start inclusive, end exclusive", () => {
  test("valid windows, including one across midnight", () => {
    expect(parseWindow("05:00-11:00")).toEqual({ start: 300, end: 660 });
    expect(parseWindow("22:30-01:15")).toEqual({ start: 1350, end: 75 });
    expect(parseWindow("00:00-23:59")).toEqual({ start: 0, end: 1439 });
    expect(formatWindow({ start: 1350, end: 75 })).toBe("22:30-01:15");
  });

  test("anything else is refused, never read as a wider window", () => {
    for (const bad of ["5:00-11:00", "05:00-24:00", "05:00-", "-11:00", "05:00", "", " 05:00-11:00", "05:00-11:00 ", "05:00 - 11:00",
      "05:00–11:00", "05:60-11:00", "25:00-11:00", "05:00-11:00-12:00", "11:00-11:00", "0500-1100", "05.00-11.00", null, 5, {}, ["05:00-11:00"]]) {
      expect({ bad, window: parseWindow(bad) }).toEqual({ bad, window: null });
    }
  });

  test("the boundaries; across midnight the window runs from start to end through 00:00", () => {
    const day = parseWindow("05:00-11:00")!;
    expect([inWindow(299, day), inWindow(300, day), inWindow(659, day), inWindow(660, day)]).toEqual([false, true, true, false]);
    const night = parseWindow("22:00-02:00")!;
    expect([inWindow(1319, night), inWindow(1320, night), inWindow(1439, night), inWindow(0, night), inWindow(119, night), inWindow(120, night), inWindow(720, night)])
      .toEqual([false, true, true, true, true, false, false]);
  });

  test("the brief's default is rc13's window, and only the brief and its template have one", () => {
    expect(DEFAULT_WINDOWS.brief).toEqual(BRIEF_WINDOW);
    expect(DEFAULT_WINDOWS["tpl-brief"]).toEqual(BRIEF_WINDOW);
    expect(Object.keys(DEFAULT_WINDOWS).sort()).toEqual(["brief", "tpl-brief"]);
    expect(DEFAULT_TZ).toBe("Asia/Kolkata");
  });
});

describe("the zone grammar: an IANA name the runtime knows, spelt as it spells it", () => {
  test("accepted", () => {
    for (const zone of ["Asia/Kolkata", "Asia/Calcutta", "UTC", "America/New_York", "Europe/Kyiv", "America/Argentina/Buenos_Aires", "Pacific/Auckland"]) {
      expect({ zone, ok: isValidTimeZone(zone) }).toEqual({ zone, ok: true });
    }
  });

  test("refused: offsets, POSIX and backward-link names, case variants, unknown zones, non-strings", () => {
    for (const zone of ["asia/kolkata", "ASIA/KOLKATA", "Etc/UTC", "Etc/GMT+5", "US/Eastern", "EST5EDT", "GMT", "utc", "+05:30", "+0530", "Z", "Mars/Olympus",
      "Asia/Nowhere", "", " Asia/Kolkata", "Asia/Kolkata ", "Asia/../Kolkata", `Asia/${"x".repeat(70)}`, null, 5, {}]) {
      expect({ zone, ok: isValidTimeZone(zone) }).toEqual({ zone, ok: false });
    }
  });
});

describe("the schedule grammar: a strict five-field cron", () => {
  test("accepted, and passed on with single spaces", () => {
    expect(parseStrictCron("0 8 * * *")).toEqual({ expr: "0 8 * * *", minutes: [0], hours: [8] });
    expect(parseStrictCron(" 5,35  7 * * 1-5 ")).toEqual({ expr: "5,35 7 * * 1-5", minutes: [5, 35], hours: [7] });
    expect(parseStrictCron("*/20 6-8 * * *")!.minutes).toEqual([0, 20, 40]);
    expect(parseStrictCron("10-50/20 9 1 10 0")!.minutes).toEqual([10, 30, 50]);
    expect(parseStrictCron("15/30 9 * * *")!.minutes).toEqual([15, 45]);
  });

  test("refused: wrong field count, names, degenerate or reversed ranges, out of range, steps, shell text", () => {
    for (const bad of ["0 8 * *", "0 8 * * * *", "0 8 * * MON", "0 8 * JAN *", "@daily", "0 8-8 * * *", "0 9-8 * * *", "60 8 * * *", "0 24 * * *",
      "0 8 0 * *", "0 8 32 * *", "0 8 * 13 *", "0 8 * * 7", "*/0 8 * * *", "*/61 8 * * *", "0 8 ? * *", "0 8 L * *", "0 8 * * 1#2",
      "0 8 * * *; rm -rf /", "0 8 * * *\n0 9 * * *", "0\t8 * * *", "0 8 * * $(id)", "-1 8 * * *", "0 8 * * ,", "0 ,8 * * *", "0 8 * * 1-",
      "1,,2 8 * * *", "100 8 * * *", "0 8 * * *".padEnd(120, " ") + "x", "", null, 8]) {
      expect({ bad, cron: parseStrictCron(bad) }).toEqual({ bad, cron: null });
    }
  });
});

describe("whether a schedule ever lands in its window", () => {
  const FROM = new Date("2026-10-05T00:00:00Z");

  test("the village default: 08:xx IST lands in 05:00-11:00 IST; 15:00 never does", () => {
    expect(scheduleMeetsWindow(parseStrictCron("7 8 * * *")!, DEFAULT_WINDOWS.brief!, "Asia/Kolkata", "Asia/Kolkata", FROM)).toBe(true);
    expect(scheduleMeetsWindow(parseStrictCron("0 15 * * *")!, DEFAULT_WINDOWS.brief!, "Asia/Kolkata", "Asia/Kolkata", FROM)).toBe(false);
  });

  test("a resident in New York: the schedule is in village time, the window in theirs, across their DST change", () => {
    const window = parseWindow("07:00-09:00")!;
    // 17:30 IST is 08:00 EDT and 07:00 EST: in the window all year.
    expect(scheduleMeetsWindow(parseStrictCron("30 17 * * *")!, window, "America/New_York", "Asia/Kolkata", FROM)).toBe(true);
    // 19:30 IST is 10:00 EDT, 09:00 EST (end exclusive): never.
    expect(scheduleMeetsWindow(parseStrictCron("30 19 * * *")!, window, "America/New_York", "Asia/Kolkata", FROM)).toBe(false);
    // 16:30 IST is 07:00 EDT but 06:00 EST: lands until 1 November only.
    expect(scheduleMeetsWindow(parseStrictCron("30 16 * * *")!, window, "America/New_York", "Asia/Kolkata", new Date("2026-11-02T00:00:00Z"))).toBe(false);
    expect(scheduleMeetsWindow(parseStrictCron("30 16 * * *")!, window, "America/New_York", "Asia/Kolkata", FROM)).toBe(true);
  });

  test("minuteOfDay follows the wall clock of the zone, DST included", () => {
    expect(minuteOfDay(new Date("2026-10-12T02:30:00Z"), "Asia/Kolkata")).toBe(8 * 60);
    expect(minuteOfDay(new Date("2026-10-12T11:30:00Z"), "America/New_York")).toBe(7 * 60 + 30); // EDT
    expect(minuteOfDay(new Date("2026-11-02T11:30:00Z"), "America/New_York")).toBe(6 * 60 + 30); // EST
  });
});

describe("reading the settings file", () => {
  test("no file: every job on rc13's defaults, and nothing to log", () => {
    const read = readJobSettings(home);
    expect(read).toEqual({ status: "absent" });
    for (const key of SETTINGS_JOB_KEYS) {
      expect(deliveryFor(key, read)).toEqual({ window: DEFAULT_WINDOWS[key] ?? null, tz: DEFAULT_TZ });
    }
  });

  test("a valid entry is used; a job without one says `default`; unknown keys and jobs are ignored", () => {
    writeSettings({ v: 1, extra: true, jobs: { brief: { window: "06:30-09:00", tz: "America/New_York", note: "x" }, "drop-midday": { tz: "UTC" }, other: { window: "bad" } } });
    const read = readJobSettings(home);
    expect(deliveryFor("brief", read)).toEqual({ window: { start: 390, end: 540 }, tz: "America/New_York", settings: "custom" });
    expect(deliveryFor("drop-midday", read)).toEqual({ window: null, tz: "UTC", settings: "custom" });
    expect(deliveryFor("evening", read)).toEqual({ window: null, tz: DEFAULT_TZ, settings: "default" });
    expect(readJobSettings(home)).toMatchObject({ status: "ok" });
  });

  test("an invalid entry never widens: the brief keeps its default window, a job without one is held", () => {
    const cases: Array<[unknown, string]> = [
      [{ window: "05:00-24:00" }, "window"],
      [{ window: "" }, "window"],
      [{ window: null }, "window"],
      [{ window: "18:00-20:00", tz: "Etc/UTC" }, "tz"],
      [{ window: "18:00-20:00", tz: "asia/kolkata" }, "tz"],
      ["18:00-20:00", "entry"],
      [null, "entry"],
      [["18:00-20:00"], "entry"],
    ];
    for (const [entry, code] of cases) {
      writeSettings({ v: 1, jobs: { brief: entry, "drop-evening": entry } });
      const read = readJobSettings(home);
      expect(deliveryFor("brief", read)).toEqual({ window: DEFAULT_WINDOWS.brief, tz: DEFAULT_TZ, settings: `invalid:${code}` });
      expect(deliveryFor("drop-evening", read)).toEqual({ window: null, tz: DEFAULT_TZ, settings: `invalid:${code}`, hold: true });
    }
  });

  test("a file that is not a v1 settings object is refused whole, with a code", () => {
    const cases: Array<[unknown, string]> = [
      ["{not json", "file-not-json"],
      ["[]", "file-not-object"],
      ["null", "file-not-object"],
      [{ jobs: {} }, "file-version"],
      [{ v: 2, jobs: {} }, "file-version"],
      [{ v: "1", jobs: {} }, "file-version"],
      [{ v: 1, jobs: [] }, "file-jobs"],
      [{ v: 1, jobs: "x" }, "file-jobs"],
      [`{"v":1,"jobs":{},"pad":"${"x".repeat(MAX_SETTINGS_BYTES)}"}`, "file-too-large"],
    ];
    for (const [content, code] of cases) {
      writeSettings(content);
      const read = readJobSettings(home);
      expect({ content: String(content).slice(0, 30), read }).toEqual({ content: String(content).slice(0, 30), read: { status: "invalid", code } });
      expect(deliveryFor("brief", read)).toEqual({ window: DEFAULT_WINDOWS.brief, tz: DEFAULT_TZ, settings: `invalid:${code}` });
      expect(deliveryFor("negotiation", read).hold).toBe(true);
    }
    rmSync(jobSettingsPath(home));
    mkdirSync(jobSettingsPath(home));
    expect(readJobSettings(home)).toEqual({ status: "invalid", code: "file-not-file" });
  });

  test("{v: 1} with no jobs is a valid empty file", () => {
    writeSettings({ v: 1 });
    expect(deliveryFor("brief", readJobSettings(home))).toEqual({ window: DEFAULT_WINDOWS.brief, tz: DEFAULT_TZ, settings: "default" });
  });

  test("the writer: sorted, 0600, read back as written", () => {
    writeJobSettings(home, { "tpl-brief": { window: "14:00-16:00" }, brief: { tz: "UTC" } });
    const read = readJobSettings(home);
    expect(read).toEqual({ status: "ok", jobs: { brief: { tz: "UTC" }, "tpl-brief": { window: "14:00-16:00" } } });
    expect(Object.keys((read as { jobs: object }).jobs)).toEqual(["brief", "tpl-brief"]);
  });
});

describe("the team gate", () => {
  test("only AV_TEAM_TENANT=1, from the environment or .env, marks a team tenant", () => {
    expect(isTeamTenant(home)).toBe(false);
    for (const value of ["true", "yes", "on", "0", "", "11", "1 1"]) {
      process.env.AV_TEAM_TENANT = value;
      expect({ value, team: isTeamTenant(home) }).toEqual({ value, team: false });
    }
    process.env.AV_TEAM_TENANT = "1";
    expect(isTeamTenant(home)).toBe(true);
    delete process.env.AV_TEAM_TENANT;
    writeFileSync(join(home, ".env"), "AV_TEAM_TENANT=1\n");
    expect(isTeamTenant(home)).toBe(true);
    // The environment wins over .env, as for every other variable here.
    process.env.AV_TEAM_TENANT = "0";
    expect(isTeamTenant(home)).toBe(false);
  });
});
