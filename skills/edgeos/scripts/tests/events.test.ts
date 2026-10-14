/**
 * The village schedule script (skills/edgeos/scripts/events.ts): local-day windows, the key read from
 * the environment or $HERMES_HOME/.env, the host it may be sent to, and the printed lines. fetch is
 * injected; nothing leaves the machine. Every key here is the placeholder `example-not-a-key`.
 *
 *   bun test skills/edgeos/scripts/tests/events.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EDGEOS_HOSTS,
  apiBase,
  days,
  dotenvValue,
  eventLine,
  header,
  isoDay,
  localMidnightUtc,
  parseArgs,
  run,
  setting,
  type Args,
} from "../events";

const KEY = "example-not-a-key";
const POPUP = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
// Wed 14 Oct 2026, 10:00 IST.
const NOW = new Date("2026-10-14T04:30:00Z");

function home(lines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeos-events-"));
  writeFileSync(join(dir, ".env"), lines.join("\n") + "\n");
  return dir;
}

function fakeFetch(results: unknown[] = [], status = 200) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ results, paging: { offset: 0, limit: results.length, total: results.length } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const args = (over: Partial<Args>): Args => ({ when: "today", days: 1, search: "", rsvped: false, json: false, ...over });

describe("windows", () => {
  test("today in IST is local midnight to midnight, in UTC", () => {
    expect(localMidnightUtc("2026-10-14", "Asia/Kolkata").toISOString()).toBe("2026-10-13T18:30:00.000Z");
    expect(days(args({}), NOW, "Asia/Kolkata")).toEqual(["2026-10-14"]);
  });

  test("between midnight and 5:30 IST, today is already the next local day", () => {
    expect(days(args({}), new Date("2026-10-14T19:00:00Z"), "Asia/Kolkata")).toEqual(["2026-10-15"]);
  });

  test("tomorrow, a date, and --days", () => {
    expect(days(args({ when: "tomorrow" }), NOW, "Asia/Kolkata")).toEqual(["2026-10-15"]);
    expect(days(args({ when: "2026-10-20", days: 3 }), NOW, "Asia/Kolkata")).toEqual(["2026-10-20", "2026-10-21", "2026-10-22"]);
  });

  test("weekend from a weekday, a Saturday and a Sunday", () => {
    expect(days(args({ when: "weekend" }), NOW, "Asia/Kolkata")).toEqual(["2026-10-17", "2026-10-18"]);
    expect(days(args({ when: "weekend" }), new Date("2026-10-17T04:30:00Z"), "Asia/Kolkata")).toEqual(["2026-10-17", "2026-10-18"]);
    expect(days(args({ when: "weekend" }), new Date("2026-10-18T04:30:00Z"), "Asia/Kolkata")).toEqual(["2026-10-18"]);
  });

  test("--days extends the weekend past Sunday (refuter N2)", () => {
    expect(days(args({ when: "weekend", days: 3 }), NOW, "Asia/Kolkata")).toEqual(["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20"]);
    expect(days(args({ when: "weekend", days: 2 }), new Date("2026-10-18T04:30:00Z"), "Asia/Kolkata")).toEqual(["2026-10-18", "2026-10-19"]);
  });

  test("--when weekend never asks for more than MAX_DAYS (recheck N3)", () => {
    expect(days(args({ when: "weekend", days: 14 }), new Date("2026-10-17T04:30:00Z"), "Asia/Kolkata").length).toBe(14);
    expect(days(args({ when: "weekend", days: 14 }), NOW, "Asia/Kolkata").length).toBe(14);
  });

  test("a zone with daylight saving", () => {
    expect(localMidnightUtc("2026-07-01", "America/Los_Angeles").toISOString()).toBe("2026-07-01T07:00:00.000Z");
    expect(localMidnightUtc("2026-12-01", "America/Los_Angeles").toISOString()).toBe("2026-12-01T08:00:00.000Z");
  });
});

describe("arguments", () => {
  test("refused forms", () => {
    expect(parseArgs([])).toEqual({ error: expect.stringContaining("--when is required") });
    expect(parseArgs(["--when", "next week"])).toEqual({ error: expect.stringContaining("--when must be") });
    expect(parseArgs(["--when", "2026-02-30"])).toEqual({ error: "no such date 2026-02-30" });
    expect(parseArgs(["--when", "today", "--days", "15"])).toEqual({ error: expect.stringContaining("--days") });
    expect(parseArgs(["--when", "today", "--days"])).toEqual({ error: "--days needs a value" });
    expect(parseArgs(["--when", "today", "--key", "x"])).toEqual({ error: "unknown argument --key" });
  });
});

describe("custody of the key", () => {
  test("the key and popup come from the environment, else from $HERMES_HOME/.env", () => {
    const dir = home([`export EDGEOS_API_KEY="${KEY}"`, `AV_POPUP_ID=${POPUP} # village`]);
    expect(setting("EDGEOS_API_KEY", { HERMES_HOME: dir })).toBe(KEY);
    expect(setting("AV_POPUP_ID", { HERMES_HOME: dir })).toBe(POPUP);
    expect(setting("EDGEOS_API_KEY", { HERMES_HOME: dir, EDGEOS_API_KEY: "from-env" })).toBe("from-env");
    expect(setting("EDGEOS_API_KEY", { HERMES_HOME: dir, EDGEOS_API_KEY: "  " })).toBe(KEY);
    expect(dotenvValue(join(dir, "missing.env"), "EDGEOS_API_KEY")).toBe("");
  });

  test("the key goes only to https on an EdgeOS host", () => {
    expect(apiBase("")).toBe("https://api.edgeos.world/api/v1");
    expect(apiBase("https://api.edgeos.world/api/v1/")).toBe("https://api.edgeos.world/api/v1");
    expect(apiBase("https://API.edgeos.world:443/api/v1")).toBe("https://api.edgeos.world/api/v1");
    for (const bad of ["http://api.edgeos.world/api/v1", "https://evil.example/api/v1", "https://u:p@api.edgeos.world/api/v1",
      "https://api.edgeos.world.evil.example/api/v1", "https://api.edgeos.world:8443/api/v1", "https://api.edgeos.world/api/v1?x=1",
      "not a url"]) {
      expect(apiBase(bad)).toBeNull();
    }
  });

  test("a base off the allowlist is refused before any request", async () => {
    const f = fakeFetch();
    const r = await run(["--when", "today"], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]),
      EDGEOS_API_BASE: "https://collector.example/api/v1" }, f.impl, NOW);
    expect(r.code).toBe(2);
    expect(f.calls).toEqual([]);
    expect(r.err).not.toContain(KEY);
  });

  test("the hosts are the av-events allowlist's hosts", () => {
    const allowlist = JSON.parse(readFileSync(join(import.meta.dir, "../../../../plugins/av-events/edgeos_tool_allowlist.json"), "utf8"));
    expect([...EDGEOS_HOSTS]).toEqual(allowlist.hosts);
  });

  test("a missing key or popup says which, and calls nothing", async () => {
    const f = fakeFetch();
    const noKey = await run(["--when", "today"], { HERMES_HOME: home([`AV_POPUP_ID=${POPUP}`]) }, f.impl, NOW);
    expect([noKey.code, noKey.err]).toEqual([2, expect.stringContaining("EDGEOS_API_KEY is not set")]);
    const noPopup = await run(["--when", "today"], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`]) }, f.impl, NOW);
    expect([noPopup.code, noPopup.err]).toEqual([2, expect.stringContaining("AV_POPUP_ID is not set")]);
    expect(f.calls).toEqual([]);
  });
});

describe("the call and the output", () => {
  const event = {
    id: "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a",
    title: "Morning  swim",
    start_time: "2026-10-14T01:30:00Z",
    end_time: "2026-10-14T02:30:00Z",
    venue_title: "Mandrem beach",
    my_rsvp_status: "registered",
  };

  test("one request with the window, popup and status; the key only in the header", async () => {
    const f = fakeFetch([event]);
    const r = await run(["--when", "today", "--search", "swim", "--rsvped"],
      { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) }, f.impl, NOW);
    expect(r.code).toBe(0);
    expect(f.calls.length).toBe(1);
    const url = new URL(f.calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.edgeos.world/api/v1/events/portal/events");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      popup_id: POPUP, event_status: "published", start_after: "2026-10-13T18:30:00Z", start_before: "2026-10-14T18:30:00Z",
      search: "swim", rsvped_only: "true",
    });
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(f.calls[0].url).not.toContain(KEY);
    expect(r.out).not.toContain(KEY);
    expect(r.out).toBe("Today is Wed 2026-10-14 (IST)\nListing: today = Wed 2026-10-14\nWed 14 Oct (Asia/Kolkata)\n  7:00 AM–8:00 AM IST · Morning swim · Mandrem beach · RSVP: registered · id 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a · start 2026-10-14T01:30:00Z\n");
  });

  test("an empty day says so; events are sorted and grouped by local day", async () => {
    const late = { ...event, id: undefined, title: "Late talk", start_time: "2026-10-15T15:00:00Z", end_time: null, venue_title: null, my_rsvp_status: null };
    const f = fakeFetch([late, event]);
    const r = await run(["--when", "today", "--days", "3"], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) }, f.impl, NOW);
    expect(r.out.split("\n")).toEqual([
      "Today is Wed 2026-10-14 (IST)",
      "Listing: today = Wed 2026-10-14 to Fri 2026-10-16",
      "Wed 14 Oct (Asia/Kolkata)",
      "  7:00 AM–8:00 AM IST · Morning swim · Mandrem beach · RSVP: registered · id 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a · start 2026-10-14T01:30:00Z",
      "Thu 15 Oct (Asia/Kolkata)",
      "  8:30 PM IST · Late talk · RSVP: none · start 2026-10-15T15:00:00Z",
      "Fri 16 Oct (Asia/Kolkata)",
      "  no published events",
      "",
    ]);
  });

  test("an EdgeOS error or an unreachable host exits 1 without the key", async () => {
    const env = { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) };
    const denied = await run(["--when", "today"], env, fakeFetch([], 403).impl, NOW);
    expect([denied.code, denied.err]).toEqual([1, "events: EdgeOS answered 403 (the key was refused)\n"]);
    const down = await run(["--when", "today"], env, (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch, NOW);
    expect([down.code, down.err]).toEqual([1, "events: EdgeOS unreachable (TypeError)\n"]);
  });

  test("--json prints today, the listing, the window and the raw results", async () => {
    const r = await run(["--when", "today", "--json"], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) },
      fakeFetch([event]).impl, NOW);
    expect(JSON.parse(r.out)).toEqual({ today: "Today is Wed 2026-10-14 (IST)", listing: "Listing: today = Wed 2026-10-14", time_zone: "Asia/Kolkata", start_after: "2026-10-13T18:30:00Z", start_before: "2026-10-14T18:30:00Z", results: [event] });
  });

  test("a line for a highlighted event in another zone", () => {
    expect(eventLine({ title: "Demo", start_time: "2026-07-01T17:00:00Z", highlighted: true }, "America/Los_Angeles"))
      .toBe("10:00 AM PDT · Demo · highlighted · RSVP: none · start 2026-07-01T17:00:00Z");
  });
});

describe("today and the listing head every output (DATE-1)", () => {
  // Hermes keeps the session's start date in the prompt for the life of a chat; these two lines put a
  // fresh village-zone day above the events. Pinned on both sides of IST midnight.
  const AFTER_MIDNIGHT = new Date("2026-10-13T18:45:00Z"); // Wed 14 Oct 2026, 00:15 IST
  const BEFORE_MIDNIGHT = new Date("2026-10-13T18:15:00Z"); // Tue 13 Oct 2026, 23:45 IST
  const env = () => ({ HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) });
  const firstTwo = async (argv: string[], now: Date, extra: Record<string, string> = {}) => {
    const r = await run(argv, { ...env(), ...extra }, fakeFetch([]).impl, now);
    expect(r.code).toBe(0);
    return r.out.split("\n").slice(0, 2);
  };

  test("isoDay names the weekday of a local date", () => {
    expect(isoDay("2026-10-14")).toBe("Wed 2026-10-14");
    expect(isoDay("2026-10-18")).toBe("Sun 2026-10-18");
  });

  test("00:15 IST Wednesday: today is Wednesday, whatever the UTC date", async () => {
    expect(await firstTwo(["--when", "today"], AFTER_MIDNIGHT)).toEqual(["Today is Wed 2026-10-14 (IST)", "Listing: today = Wed 2026-10-14"]);
    expect(await firstTwo(["--when", "tomorrow"], AFTER_MIDNIGHT)).toEqual(["Today is Wed 2026-10-14 (IST)", "Listing: tomorrow = Thu 2026-10-15"]);
    expect(await firstTwo(["--when", "weekend"], AFTER_MIDNIGHT))
      .toEqual(["Today is Wed 2026-10-14 (IST)", "Listing: weekend = Sat 2026-10-17 to Sun 2026-10-18"]);
    expect(await firstTwo(["--when", "2026-10-20"], AFTER_MIDNIGHT)).toEqual(["Today is Wed 2026-10-14 (IST)", "Listing: Tue 2026-10-20"]);
  });

  test("23:45 IST Tuesday: today is still Tuesday", async () => {
    expect(await firstTwo(["--when", "today"], BEFORE_MIDNIGHT)).toEqual(["Today is Tue 2026-10-13 (IST)", "Listing: today = Tue 2026-10-13"]);
    expect(await firstTwo(["--when", "tomorrow"], BEFORE_MIDNIGHT)).toEqual(["Today is Tue 2026-10-13 (IST)", "Listing: tomorrow = Wed 2026-10-14"]);
    expect(await firstTwo(["--when", "weekend"], BEFORE_MIDNIGHT))
      .toEqual(["Today is Tue 2026-10-13 (IST)", "Listing: weekend = Sat 2026-10-17 to Sun 2026-10-18"]);
    expect(await firstTwo(["--when", "2026-10-20"], BEFORE_MIDNIGHT)).toEqual(["Today is Tue 2026-10-13 (IST)", "Listing: Tue 2026-10-20"]);
  });

  test("--days gives the listing a range; the events follow unchanged", async () => {
    expect(await firstTwo(["--when", "2026-10-20", "--days", "3"], AFTER_MIDNIGHT))
      .toEqual(["Today is Wed 2026-10-14 (IST)", "Listing: Tue 2026-10-20 to Thu 2026-10-22"]);
    expect(await firstTwo(["--when", "weekend", "--days", "2"], AFTER_MIDNIGHT))
      .toEqual(["Today is Wed 2026-10-14 (IST)", "Listing: weekend = Sat 2026-10-17 to Mon 2026-10-19"]);
    const r = await run(["--when", "tomorrow"], env(), fakeFetch([]).impl, AFTER_MIDNIGHT);
    expect(r.out).toBe("Today is Wed 2026-10-14 (IST)\nListing: tomorrow = Thu 2026-10-15\nThu 15 Oct (Asia/Kolkata)\n  no published events\n");
  });

  test("today is the same local day the window uses", () => {
    for (const now of [AFTER_MIDNIGHT, BEFORE_MIDNIGHT]) {
      const wanted = days(args({}), now, "Asia/Kolkata");
      expect(header(args({}), wanted, now, "Asia/Kolkata")[0]).toBe(`Today is ${isoDay(wanted[0])} (IST)`);
    }
  });

  test("another zone carries its own label", async () => {
    expect(await firstTwo(["--when", "today"], AFTER_MIDNIGHT, { HERMES_TIMEZONE: "America/Los_Angeles" }))
      .toEqual(["Today is Tue 2026-10-13 (PDT)", "Listing: today = Tue 2026-10-13"]);
  });

  test("error paths print no header", async () => {
    const bad = await run(["--when", "next week"], env(), fakeFetch([]).impl, AFTER_MIDNIGHT);
    expect([bad.code, bad.out]).toEqual([2, ""]);
    const denied = await run(["--when", "today"], env(), fakeFetch([], 403).impl, AFTER_MIDNIGHT);
    expect([denied.code, denied.out]).toEqual([1, ""]);
  });
});

describe("the skill tells the agent to read the day from the script (DATE-1)", () => {
  const skill = readFileSync(join(import.meta.dir, "../../SKILL.md"), "utf8");
  const section = skill.slice(skill.indexOf("\n## 3. Reading events\n"), skill.indexOf("All event-read recipes use"));

  test("pass the word, take the day from the first line, never from the conversation's start line", () => {
    expect(section).toContain("pass the word (`--when today`, `--when tomorrow`, `--when weekend`), never a date you worked out");
    expect(section).toContain("The script's first line, `Today is <Wkd YYYY-MM-DD> (IST)`, is today in the village");
    expect(section).toContain("say it in your answer");
    expect(section).toContain("Never take today's date from the conversation's start line in your prompt");
  });

  test("no other line sends the agent to its system prompt or to a computed date for today/tomorrow (refuter S1, S2)", () => {
    expect(skill).not.toContain("Your own clock (the date and timezone in your system prompt)");
    expect(skill).not.toContain('Convert "tomorrow", "this Thursday", "next week" to actual ISO-8601 timestamps');
    expect(skill).toContain("never the date in your system prompt: that is the day this chat began");
    expect(skill).toContain("counting from the day in the newest message stamp");
  });
});
