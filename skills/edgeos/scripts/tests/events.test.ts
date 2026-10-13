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
    expect(r.out).toBe("Wed 14 Oct (Asia/Kolkata)\n  7:00 AM–8:00 AM IST · Morning swim · Mandrem beach · RSVP: registered · id 5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a · start 2026-10-14T01:30:00Z\n");
  });

  test("an empty day says so; events are sorted and grouped by local day", async () => {
    const late = { ...event, id: undefined, title: "Late talk", start_time: "2026-10-15T15:00:00Z", end_time: null, venue_title: null, my_rsvp_status: null };
    const f = fakeFetch([late, event]);
    const r = await run(["--when", "today", "--days", "3"], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) }, f.impl, NOW);
    expect(r.out.split("\n")).toEqual([
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

  test("--json prints the window and the raw results", async () => {
    const r = await run(["--when", "today", "--json"], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) },
      fakeFetch([event]).impl, NOW);
    expect(JSON.parse(r.out)).toEqual({ time_zone: "Asia/Kolkata", start_after: "2026-10-13T18:30:00Z", start_before: "2026-10-14T18:30:00Z", results: [event] });
  });

  test("a line for a highlighted event in another zone", () => {
    expect(eventLine({ title: "Demo", start_time: "2026-07-01T17:00:00Z", highlighted: true }, "America/Los_Angeles"))
      .toBe("10:00 AM PDT · Demo · highlighted · RSVP: none · start 2026-07-01T17:00:00Z");
  });
});
