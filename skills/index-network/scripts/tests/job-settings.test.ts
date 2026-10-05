/**
 * J2 per-job settings: the grammars and the reader (job-settings.ts). The
 * trigger's use of them is in proactive-settings.test.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_TZ,
  DEFAULT_WINDOWS,
  MAX_CANONICAL_SCHEDULE_CHARS,
  MAX_SCHEDULE_INPUT_CHARS,
  MAX_SETTINGS_BYTES,
  PREVIEW_MAX_AGE_MS,
  type ParsedCron,
  SETTINGS_JOB_KEYS,
  adminScheduleKeys,
  cronFrequent,
  cronLeapDayOnly,
  cronNeverFires,
  deliveryFor,
  formatWindow,
  inWindow,
  isTeamTenant,
  isValidTimeZone,
  jobSettingsPath,
  minuteOfDay,
  nextFiring,
  parseStoredCron,
  parseStrictCron,
  parseWindow,
  prunePreviewFiles,
  readJobSettings,
  scheduleAdminManaged,
  scheduleWindowFit,
  settingsFileText,
  writeJobSettings,
} from "../job-settings";
import { BRIEF_WINDOW } from "./fixtures/rc13-decision";
import fixture from "./fixtures/croniter-6.0.0.json";

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

describe("the zone grammar for a job's window: an IANA name in a geographic area, spelt as the runtime spells it", () => {
  test("accepted, backward links inside the ten areas included", () => {
    for (const zone of ["Asia/Kolkata", "Asia/Calcutta", "UTC", "America/New_York", "Europe/Kyiv", "Europe/Kiev", "America/Argentina/Buenos_Aires", "America/Buenos_Aires", "Pacific/Auckland"]) {
      expect({ zone, ok: isValidTimeZone(zone) }).toEqual({ zone, ok: true });
    }
  });

  test("refused: offsets, POSIX names, Etc/ and US/ names, case variants, unknown zones, non-strings", () => {
    for (const zone of ["asia/kolkata", "ASIA/KOLKATA", "Etc/UTC", "Etc/GMT+5", "US/Eastern", "EST5EDT", "GMT", "utc", "+05:30", "+0530", "Z", "Mars/Olympus",
      "Asia/Nowhere", "", " Asia/Kolkata", "Asia/Kolkata ", "Asia/../Kolkata", `Asia/${"x".repeat(70)}`, null, 5, {}]) {
      expect({ zone, ok: isValidTimeZone(zone) }).toEqual({ zone, ok: false });
    }
  });
});

describe("the schedule grammar: a strict five-field cron, sent to Hermes in canonical form", () => {
  test("accepted: each field becomes its explicit values, `*` only when it holds every value", () => {
    expect(parseStrictCron("0 8 * * *")).toEqual({ expr: "0 8 * * *", minutes: [0], hours: [8], days: expect.any(Array), months: expect.any(Array), weekdays: [0, 1, 2, 3, 4, 5, 6] });
    expect(parseStrictCron("5,35 7 * * 1-5")!.expr).toBe("5,35 7 * * 1,2,3,4,5");
    expect(parseStrictCron("*/20 6-8 * * *")!.expr).toBe("0,20,40 6,7,8 * * *");
    expect(parseStrictCron("10-50/20 9 1 10 0")!.expr).toBe("10,30,50 9 1 10 0");
    expect(parseStrictCron("15/30 9 * * *")!.expr).toBe("15,45 9 * * *");
    expect(parseStrictCron("08 08 * * *")!.expr).toBe("8 8 * * *");
    // A field that lists every value is `*`.
    expect(parseStrictCron("0-59 0-23 1-31 1-12 0-6")!.expr).toBe("* * * * *");
    expect(parseStrictCron("0 8 1-31 * 1")!.expr).toBe("0 8 * * 1");
  });

  test("a field's maximum with a step is that one value, never croniter's `*/s`", () => {
    expect(parseStrictCron("0 23/2 * * *")!.expr).toBe("0 23 * * *");
    expect(parseStrictCron("59/5 8 * * *")!.expr).toBe("59 8 * * *");
    expect(parseStrictCron("0 8 31/2 * *")!.expr).toBe("0 8 31 * *");
    expect(parseStrictCron("0 8 * 12/5 *")!.expr).toBe("0 8 * 12 *");
    expect(parseStrictCron("0 8 * * 6/7")!.expr).toBe("0 8 * * 6");
  });

  test("refused: wrong field count, names, degenerate or reversed ranges, out of range, steps, spacing, shell text", () => {
    for (const bad of ["0 8 * *", "0 8 * * * *", "0 8 * * MON", "0 8 * JAN *", "@daily", "0 8-8 * * *", "0 8-8/2 * * *", "59-59 * * * *", "0 8 * * 1-1/1",
      "0 9-8 * * *", "60 8 * * *", "0 24 * * *", "0 8 0 * *", "0 8 32 * *", "0 8 * 13 *", "0 8 * * 7", "*/0 8 * * *", "*/61 8 * * *", "0 8 ? * *",
      "0 8 L * *", "0 8 * * 1#2", "0 8 * * *; rm -rf /", "0 8 * * *\n0 9 * * *", "0\t8 * * *", "0 8 * * $(id)", "-1 8 * * *", "0 8 * * ,", "0 ,8 * * *",
      "0 8 * * 1-", "1,,2 8 * * *", "100 8 * * *", "0  8 * * *", " 0 8 * * *", "0 8 * * * ", "0 8 * * *".padEnd(120, " ") + "x", "", null, 8]) {
      expect({ bad, cron: parseStrictCron(bad) }).toEqual({ bad, cron: null });
    }
  });

  test("never fires: croniter's impossible dates, whatever the day of week; and 29 February alone", () => {
    for (const expr of ["0 8 31 2 *", "0 8 30 2 *", "0 8 31 4,6,9,11 *", "0 8 31 2 1", "0 8 30,31 2 *"]) {
      expect({ expr, never: cronNeverFires(parseStrictCron(expr)!) }).toEqual({ expr, never: true });
    }
    for (const expr of ["0 8 29 2 *", "0 8 31 * *", "0 8 30 2,4 *", "0 8 * 2 *", "0 8 31 2,3 *"]) {
      expect({ expr, never: cronNeverFires(parseStrictCron(expr)!) }).toEqual({ expr, never: false });
    }
    expect(cronLeapDayOnly(parseStrictCron("0 8 29 2 *")!)).toBe(true);
    expect(cronLeapDayOnly(parseStrictCron("0 8 29,30 2 *")!)).toBe(true);
    for (const expr of ["0 8 29 2 1", "0 8 29 2,3 *", "0 8 28,29 2 *", "0 8 * 2 *"]) {
      expect({ expr, leap: cronLeapDayOnly(parseStrictCron(expr)!) }).toEqual({ expr, leap: false });
    }
  });

  test("two bounds: an input is at most 100 characters; a stored canonical form up to the longest any accepted input produces (346)", () => {
    expect(MAX_SCHEDULE_INPUT_CHARS).toBe(100);
    // Each field's longest canonical form is every value but one shortest one; a 23-character input reaches all five at once.
    const longest = parseStrictCron("1-59 1-23 2-31 2-12 1-6")!.expr;
    expect(longest.split(" ").map((field) => field.length)).toEqual([167, 59, 81, 24, 11]);
    expect(longest.length).toBe(346);
    expect(MAX_CANONICAL_SCHEDULE_CHARS).toBe(346);
    // Brute force over every non-full subset size of each field: none is longer.
    const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    const widest = bounds.map(([low, high]) => {
      const values = Array.from({ length: high - low + 1 }, (_, i) => String(low + i)).sort((a, b) => b.length - a.length);
      return Math.max(...Array.from({ length: values.length - 1 }, (_, n) => values.slice(0, n + 1).join(",").length));
    });
    expect(widest.reduce((a, b) => a + b, 4)).toBe(MAX_CANONICAL_SCHEDULE_CHARS);
    // The stored reader takes the longest canonical form; the input reader does not take it as input.
    expect(parseStoredCron(longest)!.expr).toBe(longest);
    expect(parseStrictCron(longest)).toBeNull();
    // The reviewer's case: a 15-character input whose canonical form is over 100 characters.
    const reviewer = parseStrictCron("0 6-20 1-28 * *")!.expr;
    expect(reviewer.length).toBeGreaterThan(100);
    expect(parseStoredCron(reviewer)!.expr).toBe(reviewer);
    // Still canonical only: a non-canonical stored form is not guessed at, whatever its length.
    for (const raw of ["0 23/2 * * *", "0 8 1-31 * 1", "0 6-20 1-28 * *", `${longest} `, `${longest},`]) expect({ raw, cron: parseStoredCron(raw) }).toEqual({ raw, cron: null });
  });

  test("property: no accepted input yields a canonical form the stored reader refuses", () => {
    // A seeded generator over every item shape of the grammar, biased to long lists and ranges.
    let seed = 0x5eed1234;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed % n;
    };
    const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 6]];
    const item = ([low, high]: [number, number]): string => {
      const a = low + rand(high - low + 1);
      const b = a + 1 + rand(Math.max(1, high - a));
      const step = 1 + rand(high - low + 1);
      return [`${a}`, `${a}-${Math.min(b, high)}`, `${a}/${step}`, `*/${step}`, `${a}-${Math.min(b, high)}/${step}`, "*"][rand(6)];
    };
    let accepted = 0;
    let over100 = 0;
    for (let i = 0; i < 6000; i++) {
      const text = bounds.map((range) => Array.from({ length: 1 + rand(6) }, () => item(range)).join(",")).join(" ");
      const cron = parseStrictCron(text);
      if (!cron) continue;
      accepted++;
      if (cron.expr.length > 100) over100++;
      const stored = parseStoredCron(cron.expr);
      if (!stored || stored.expr !== cron.expr || cron.expr.length > MAX_CANONICAL_SCHEDULE_CHARS) throw new Error(`not read back: ${text}`);
    }
    expect(accepted).toBeGreaterThan(2000);
    expect(over100).toBeGreaterThan(100);
  });

  test("frequent: more than one firing in some hour", () => {
    for (const expr of ["* * * * *", "0,30 8 * * *", "*/20 6-8 * * *", "1-59/58 8 * * *"]) expect({ expr, f: cronFrequent(parseStrictCron(expr)!) }).toEqual({ expr, f: true });
    for (const expr of ["0 8 * * *", "0 * * * *", "30 16,17 * * *", "0 8,20 * * *"]) expect({ expr, f: cronFrequent(parseStrictCron(expr)!) }).toEqual({ expr, f: false });
  });
});

/** Field values as croniter writes them: `*` or the values joined by commas. */
function fields(cron: ParsedCron): string[] {
  const full = [60, 24, 31, 12, 7];
  return [cron.minutes, cron.hours, cron.days, cron.months, cron.weekdays].map((values, i) => (values.length === full[i] ? "*" : values.join(",")));
}

describe("croniter 6.0.0 reads the canonical form exactly as the tool does (tests/fixtures/croniter-6.0.0.json)", () => {
  type Reading = { x: string[] | null; err: string | null; nextErr: string | null; next?: string[] } | null;
  const report = fixture.report as Array<{ e: string; c: string | null; input: Reading; canonical: Reading }>;

  test("the fixture is croniter 6.0.0's, and its canonical forms are still the tool's", () => {
    expect(fixture.croniter).toBe("6.0.0");
    for (const row of report) expect({ e: row.e, c: parseStrictCron(row.e)?.expr ?? null }).toEqual({ e: row.e, c: row.c });
  });

  test("report and probe expressions: the tool's value lists equal croniter's expansion of the canonical string", () => {
    let accepted = 0;
    for (const row of report) {
      const cron = parseStrictCron(row.e);
      if (!cron) continue;
      accepted++;
      expect({ e: row.e, err: row.canonical!.err }).toEqual({ e: row.e, err: null });
      expect({ e: row.e, fields: fields(cron) }).toEqual({ e: row.e, fields: row.canonical!.x! });
      // No next run (CroniterBadDateError) exactly when the tool says it never fires.
      expect({ e: row.e, never: cronNeverFires(cron) }).toEqual({ e: row.e, never: row.canonical!.nextErr === "CroniterBadDateError" });
    }
    expect(accepted).toBeGreaterThan(60);
  });

  test("the tool's firings are croniter's next five runs (naive wall time, which is UTC here)", () => {
    for (const row of report) {
      const cron = parseStrictCron(row.e);
      if (!cron || !row.canonical?.next) continue;
      if (cronLeapDayOnly(cron)) {
        // Up to four years away: beyond the tool's one-year horizon, and refused by the commands.
        expect(nextFiring(cron, "UTC", new Date(`${fixture.base}Z`))).toBeNull();
        continue;
      }
      // The tool looks a year ahead from each run; a yearly schedule's later runs lie past that.
      const runs: string[] = [];
      let at: number | null = new Date(`${fixture.base}Z`).getTime();
      while (runs.length < 5) {
        at = nextFiring(cron, "UTC", new Date(at));
        if (at === null) break;
        runs.push(new Date(at).toISOString().slice(0, 16).replace("T", " "));
      }
      const yearAhead = row.canonical.next.filter((run) => run < "2027-10-06").length;
      expect({ e: row.e, runs }).toEqual({ e: row.e, runs: row.canonical.next.slice(0, runs.length) });
      expect({ e: row.e, enough: runs.length >= Math.min(1, yearAhead) && runs.length >= Math.min(5, yearAhead) }).toEqual({ e: row.e, enough: true });
    }
  });

  test("croniter misreads the shapes the tool refuses or rewrites: a-a ranges and max/step", () => {
    expect(report.find((row) => row.e === "0 8-8 * * *")!.input!.x![1]).toBe("*");
    expect(report.find((row) => row.e === "0 23/2 * * *")!.input!.x![1]).toBe("0,2,4,6,8,10,12,14,16,18,20,22");
    expect(report.find((row) => row.e === "0 8 * * 6/7")!.input!.x![4]).toBe("0");
    for (const e of ["0 8-8 * * *", "0 8-8/2 * * *", "59-59 * * * *", "0 8 * 2-2 *", "0 8 * * 1-1/1", "0 8 15-15/3 * *"]) {
      expect({ e, c: report.find((row) => row.e === e)!.c }).toEqual({ e, c: null });
    }
  });

  test("the sweep: every start and step in every field, the max-value forms included", () => {
    const sweep = fixture.sweep as Array<[string, string | null, string | null, string?]>;
    expect(sweep.length).toBe(5330);
    let misread = 0;
    for (const [e, c, canonical, given] of sweep) {
      const cron = parseStrictCron(e);
      expect({ e, c: cron?.expr ?? null }).toEqual({ e, c });
      if (cron) expect({ e, fields: fields(cron).join("|") }).toEqual({ e, fields: canonical! });
      if (given !== undefined) misread++;
    }
    // croniter reads every `max/s` input differently from its canonical form; the tool never sends one.
    expect(misread).toBe(134);
  });
});

describe("whether a schedule lands in its window, over a full year", () => {
  const FROM = new Date("2026-10-05T00:00:00Z");
  const fit = (expr: string, window: string, jobTz: string, from = FROM, hermesTz = "Asia/Kolkata") =>
    scheduleWindowFit(parseStrictCron(expr)!, parseWindow(window)!, jobTz, hermesTz, from);

  test("the village default: 08:xx IST lands in 05:00-11:00 IST every day; 15:00 never does", () => {
    expect(fit("7 8 * * *", "05:00-11:00", "Asia/Kolkata")).toEqual({ fit: "always" });
    expect(fit("0 15 * * *", "05:00-11:00", "Asia/Kolkata")).toEqual({ fit: "never" });
  });

  test("a resident in New York: always, never, and the DST season (the reviewer's 18:00 IST into 08:00-09:00)", () => {
    // 17:30 IST is 08:00 EDT and 07:00 EST: in 07:00-09:00 all year.
    expect(fit("30 17 * * *", "07:00-09:00", "America/New_York")).toEqual({ fit: "always" });
    // 19:30 IST is 10:00 EDT, 09:00 EST (end exclusive): never.
    expect(fit("30 19 * * *", "07:00-09:00", "America/New_York")).toEqual({ fit: "never" });
    // 18:00 IST is 08:30 EDT but 07:30 EST: in the window until DST ends on 1 November, then not until March.
    expect(fit("0 18 * * *", "08:00-09:00", "America/New_York")).toEqual({ fit: "seasonal", outsideFrom: "2026-11-01" });
    // Asked in winter, the miss is now and the window comes back in March: still seasonal, never silently refused or accepted.
    expect(fit("0 18 * * *", "08:00-09:00", "America/New_York", new Date("2026-11-03T00:00:00Z"))).toEqual({ fit: "seasonal", outsideFrom: "2026-11-03" });
    // Two firings, one each side of the change: every day lands.
    expect(fit("30 16,17 * * *", "07:00-08:00", "America/New_York")).toEqual({ fit: "always" });
  });

  test("outsideFrom can be today or yesterday in the job's zone: the first whole Hermes-zone day is already outside (outside now)", () => {
    // 00:30 IST is 12:00 PDT (end exclusive: outside) and 11:00 PST (inside) of the PREVIOUS day in Los Angeles.
    // Asked at 05:00 PDT on 12 October: the first whole Hermes-zone day is 12 October IST, whose 00:30
    // firing was 12:00 PDT on 11 October, so outsideFrom is yesterday in the job's zone.
    expect(fit("30 0 * * *", "11:00-12:00", "America/Los_Angeles", new Date("2026-10-12T12:00:00Z"))).toEqual({ fit: "seasonal", outsideFrom: "2026-10-11" });
    // Asked at 13:00 PDT on 11 October (01:30 IST on the 12th): the same day, today in the job's zone.
    expect(fit("30 0 * * *", "11:00-12:00", "America/Los_Angeles", new Date("2026-10-11T20:00:00Z"))).toEqual({ fit: "seasonal", outsideFrom: "2026-10-11" });
  });

  test("only the days it runs count; a schedule that never runs in the year is no-firing", () => {
    // Saturdays only, at a time that is in the window: always.
    expect(fit("30 17 * * 6", "07:00-09:00", "America/New_York")).toEqual({ fit: "always" });
    expect(fit("0 8 29 2 *", "05:00-11:00", "Asia/Kolkata")).toEqual({ fit: "no-firing" });
  });

  test("a Hermes zone with DST: the firing follows its wall clock", () => {
    // 08:30 in Hermes's New York is 08:30 in the resident's New York all year, DST included.
    expect(fit("30 8 * * *", "08:00-09:00", "America/New_York", FROM, "America/New_York")).toEqual({ fit: "always" });
    // Read in London, it moves an hour twice a year (the two zones change on different dates).
    expect(fit("30 8 * * *", "13:00-14:00", "Europe/London", FROM, "America/New_York").fit).toBe("seasonal");
  });

  test("whole days only: the answer does not depend on the hour of the call", () => {
    // The reviewer's case: 06:00 and 12:00 with window 05:00-11:00 in one zone with no DST is always, called at any hour.
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(Date.UTC(2026, 9, 5, hour, 17));
      expect({ hour, fit: fit("0 6,12 * * *", "05:00-11:00", "Asia/Tokyo", at, "Asia/Tokyo") }).toEqual({ hour, fit: { fit: "always" } });
      expect({ hour, fit: fit("0 6,12 * * *", "05:00-11:00", "Asia/Kolkata", at) }).toEqual({ hour, fit: { fit: "always" } });
    }
    // A real DST case is still seasonal, with the same first date, from every hour of the day.
    for (let hour = 0; hour < 24; hour++) {
      const at = new Date(Date.UTC(2026, 9, 5, hour, 41));
      expect({ hour, fit: fit("0 18 * * *", "08:00-09:00", "America/New_York", at) }).toEqual({ hour, fit: { fit: "seasonal", outsideFrom: "2026-11-01" } });
      expect({ hour, fit: fit("30 16,17 * * *", "07:00-08:00", "America/New_York", at) }).toEqual({ hour, fit: { fit: "always" } });
    }
  });

  test("every minute (allowed only with --allow-frequent) is checked in good time", () => {
    const started = Date.now();
    expect(fit("* * * * *", "08:00-08:05", "America/New_York")).toEqual({ fit: "always" });
    expect(Date.now() - started).toBeLessThan(4000);
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

  test("a file that is not a v1 settings object is refused whole, with a code (any other `v` silences jobs without a default)", () => {
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

  test("adminSchedules is read entry by entry: an entry that is not a default job key is ignored on its own; only a value that is not a list is invalid", () => {
    writeSettings({ v: 1, jobs: {}, adminSchedules: ["negotiation", "brief"] });
    expect(adminScheduleKeys(readJobSettings(home))).toEqual({ keys: ["brief", "negotiation"], invalid: false, ignored: false });
    // A key a later release retired, a template key, a non-string: each ignored, the rest kept.
    writeSettings({ v: 1, jobs: {}, adminSchedules: ["brief", "tpl-brief", "weekly-recap", 7, null, "brief"] });
    expect(adminScheduleKeys(readJobSettings(home))).toEqual({ keys: ["brief"], invalid: false, ignored: true });
    for (const value of ["brief", { brief: true }, 1, null]) {
      writeSettings({ v: 1, jobs: {}, adminSchedules: value });
      expect({ value, admin: adminScheduleKeys(readJobSettings(home)) }).toEqual({ value, admin: { keys: [], invalid: true, ignored: false } });
    }
    // A malformed list never holds a job silent: the trigger reads only `jobs`.
    expect(deliveryFor("negotiation", readJobSettings(home))).toEqual({ window: null, tz: DEFAULT_TZ, settings: "default" });
    expect(adminScheduleKeys({ status: "absent" })).toEqual({ keys: [], invalid: false, ignored: false });
    expect(adminScheduleKeys({ status: "invalid", code: "file-not-json" })).toEqual({ keys: [], invalid: false, ignored: false });
  });

  test("scheduleAdminManaged, the one rule reconcile and list share", () => {
    const defaults = ["brief", "drop-midday", "drop-evening", "negotiation", "evening"];
    const managed = () => defaults.filter((key) => scheduleAdminManaged(key, readJobSettings(home)));
    expect(managed()).toEqual([]);
    writeSettings({ v: 1, jobs: { evening: { tz: "UTC" }, "tpl-brief": { window: "14:00-16:00" } }, adminSchedules: ["brief", "weekly-recap"] });
    expect(managed()).toEqual(["brief", "evening"]);
    expect(scheduleAdminManaged("tpl-brief", readJobSettings(home))).toBe(false);
    // Not a list, or an unreadable file: every default job (nothing an admin set is moved).
    writeSettings({ v: 1, jobs: {}, adminSchedules: "brief" });
    expect(managed()).toEqual(defaults);
    writeSettings("{oops");
    expect(managed()).toEqual(defaults);
    expect(scheduleAdminManaged("prefetch", readJobSettings(home))).toBe(false);
  });

  test("the writer: sorted, 0600, read back as written; nothing to hold removes the file", () => {
    writeJobSettings(home, { "tpl-brief": { window: "14:00-16:00" }, brief: { tz: "UTC" } }, ["negotiation", "brief"]);
    const read = readJobSettings(home);
    expect(read).toEqual({ status: "ok", jobs: { brief: { tz: "UTC" }, "tpl-brief": { window: "14:00-16:00" } }, adminSchedules: ["brief", "negotiation"] });
    expect(Object.keys((read as { jobs: object }).jobs)).toEqual(["brief", "tpl-brief"]);
    expect(statSync(jobSettingsPath(home)).mode & 0o777).toBe(0o600);
    expect(settingsFileText({}, [])).toBeNull();
    expect(settingsFileText({ brief: { tz: "UTC" } })).toBe('{"v":1,"jobs":{"brief":{"tz":"UTC"}}}\n');
    writeJobSettings(home, {});
    expect(existsSync(jobSettingsPath(home))).toBe(false);
    expect(readJobSettings(home)).toEqual({ status: "absent" });
  });
});

describe("the team gate", () => {
  test("only AV_TEAM_TENANT=1 (surrounding whitespace trimmed), from the environment or .env, marks a team tenant", () => {
    expect(isTeamTenant(home)).toBe(false);
    for (const value of ["true", "yes", "on", "0", "", "11", "1 1", '"1"', "'1'", "01", "1 # team"]) {
      process.env.AV_TEAM_TENANT = value;
      expect({ value, team: isTeamTenant(home) }).toEqual({ value, team: false });
    }
    for (const value of ["1", " 1 ", "1\n", "\t1\r"]) {
      process.env.AV_TEAM_TENANT = value;
      expect({ value, team: isTeamTenant(home) }).toEqual({ value, team: true });
    }
    delete process.env.AV_TEAM_TENANT;
    writeFileSync(join(home, ".env"), "AV_TEAM_TENANT=1\n");
    expect(isTeamTenant(home)).toBe(true);
    // The environment wins over .env whenever it is set, empty included.
    process.env.AV_TEAM_TENANT = "0";
    expect(isTeamTenant(home)).toBe(false);
    process.env.AV_TEAM_TENANT = "";
    expect(isTeamTenant(home)).toBe(false);
  });

  test(".env: no quote stripping, CRLF trimmed, the last assignment wins (as python-dotenv)", () => {
    const cases: Array<[string, boolean]> = [
      ['AV_TEAM_TENANT="1"\n', false],
      ["AV_TEAM_TENANT='1'\n", false],
      ["AV_TEAM_TENANT=1 # team\n", false],
      ["AV_TEAM_TENANT=1\r\n", true],
      ["export AV_TEAM_TENANT = 1\n", true],
      ["AV_TEAM_TENANT=0\nAV_TEAM_TENANT=1\n", true],
      ["AV_TEAM_TENANT=1\nAV_TEAM_TENANT=0\n", false],
      ["XAV_TEAM_TENANT=1\n", false],
    ];
    for (const [file, team] of cases) {
      writeFileSync(join(home, ".env"), file);
      expect({ file, team: isTeamTenant(home) }).toEqual({ file, team });
    }
  });
});

describe("pruning preview leftovers older than an hour", () => {
  test("old state copies and preview shims go; young ones, other names and symlinks stay", () => {
    const now = Date.now();
    const old = (path: string) => utimesSync(path, new Date(now - PREVIEW_MAX_AGE_MS - 60_000), new Date(now - PREVIEW_MAX_AGE_MS - 60_000));
    const copies = join(home, "av-events", "proactive");
    const scripts = join(home, "scripts");
    mkdirSync(copies, { recursive: true });
    mkdirSync(scripts, { recursive: true });
    for (const name of ["preview-AbC123", "preview-young1", "preview-toolong7", "keep-AbC123"]) {
      mkdirSync(join(copies, name));
      writeFileSync(join(copies, name, "heartbeat-state.json"), "{}");
    }
    for (const name of ["preview-AbC123", "preview-toolong7", "keep-AbC123"]) old(join(copies, name));
    for (const name of ["agentvillage_proactive_preview-brief.sh", "agentvillage_proactive_preview-tpl-evening-ask.sh", "agentvillage_proactive_preview-other.sh", "agentvillage_proactive_brief.sh"]) {
      writeFileSync(join(scripts, name), "#!/bin/sh\n");
      old(join(scripts, name));
    }
    writeFileSync(join(scripts, "agentvillage_proactive_preview-negotiation.sh"), "#!/bin/sh\n");
    symlinkSync("/etc", join(copies, "preview-link01"));
    expect(prunePreviewFiles(home, now)).toEqual({ copies: 1, shims: 2 });
    expect(existsSync(join(copies, "preview-AbC123"))).toBe(false);
    for (const name of ["preview-young1", "preview-toolong7", "keep-AbC123", "preview-link01"]) expect({ name, kept: existsSync(join(copies, name)) }).toEqual({ name, kept: true });
    expect(existsSync(join(scripts, "agentvillage_proactive_preview-brief.sh"))).toBe(false);
    expect(existsSync(join(scripts, "agentvillage_proactive_preview-tpl-evening-ask.sh"))).toBe(false);
    for (const name of ["agentvillage_proactive_preview-other.sh", "agentvillage_proactive_brief.sh", "agentvillage_proactive_preview-negotiation.sh"]) {
      expect({ name, kept: existsSync(join(scripts, name)) }).toEqual({ name, kept: true });
    }
    expect(readFileSync(join(copies, "preview-young1", "heartbeat-state.json"), "utf8")).toBe("{}");
    // No directories at all: nothing to do, no throw.
    expect(prunePreviewFiles(join(home, "nowhere"), now)).toEqual({ copies: 0, shims: 0 });
  });
});
