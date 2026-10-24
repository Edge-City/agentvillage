/**
 * The EdgeOS verbs script (skills/edgeos/scripts/edgeos.ts, EDGEOS-BLOCK step B): one request per verb, the
 * same request the v2.1.9 curl recipe made, the key read from the environment or $HERMES_HOME/.env and never
 * printed, the EdgeOS host and /api/v1 base enforced, and the exit codes the skill maps. fetch is injected;
 * nothing leaves the machine. Every key here is the placeholder `example-not-a-key`.
 *
 *   bun test skills/edgeos/scripts/tests/edgeos.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_SESSIONS, occurrenceInstant, occurrenceNote, parseArgs, request, run, validInstant, type Args } from "../edgeos";

const KEY = "example-not-a-key";
const POPUP = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const EVENT = "5f0c7a3e-1b2d-4c3e-8f9a-0b1c2d3e4f5a";
const VENUE = "11111111-2222-4333-8444-555555555555";
const BASE = "https://api.edgeos.world/api/v1";
const SKILL = join(import.meta.dir, "..", "..", "SKILL.md");

function home(lines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeos-verbs-"));
  writeFileSync(join(dir, ".env"), lines.join("\n") + "\n");
  return dir;
}

const ENV = () => ({ HERMES_HOME: home(), EDGEOS_API_KEY: KEY, AV_POPUP_ID: POPUP });

interface Call {
  url: string;
  init: RequestInit;
}

function fakeFetch(body: unknown = { results: [], paging: { offset: 0, limit: 0, total: 0 } }, status = 200,
  headers: Record<string, string> = {}) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status, headers: { "content-type": "application/json", ...headers },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function words(command: string): string[] {
  // The skill's commands use only plain words and double-quoted words.
  return [...command.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

/** Every EdgeOS-script run in the skill, by its bold heading, placeholders filled. */
function skillRuns(): Map<string, string[]> {
  const text = readFileSync(SKILL, "utf8")
    .replaceAll("{event_id}", EVENT)
    .replaceAll("{occurrence_iso}", "2026-10-20T10:00:00Z")
    .replaceAll("{current_iso_timestamp}", "2026-10-11T00:00:00Z")
    .replaceAll("{start_iso}", "2026-10-11T00:00:00Z")
    .replaceAll("{end_iso}", "2026-10-12T00:00:00Z");
  const out = new Map<string, string[]>();
  for (const m of text.matchAll(/```sh\n(.*?)```/gs)) {
    const command = m[1].trim();
    if (!command.startsWith("bun skills/edgeos/scripts/edgeos.ts ")) continue;
    const headings = [...text.slice(0, m.index).matchAll(/\*\*(.+?)\*\*/g)];
    const heading = headings[headings.length - 1][1].replace(/\s*\(.*\)/, "").replace(/:$/, "").trim();
    out.set(heading, words(command).slice(2));
  }
  return out;
}

/**
 * The URL and body each v2.1.9 curl recipe sent (popup = AV_POPUP_ID), by heading. The verbs must send the same
 * request; query order is not compared, only the parameters (plugins/av-events/tests/test_edgeos_skill_recipes.py
 * pins the same headings to the same operations on the observer's side).
 */
const LEGACY: Record<string, { method: string; url: string; body: unknown }> = {
  "List upcoming events": { method: "GET", url: `${BASE}/events/portal/events?popup_id=${POPUP}&event_status=published&start_after=2026-10-11T00:00:00Z&start_before=2026-10-12T00:00:00Z`, body: null },
  "List events in a date range": { method: "GET", url: `${BASE}/events/portal/events?popup_id=${POPUP}&event_status=published&start_after=2026-10-11T00:00:00Z&start_before=2026-10-12T00:00:00Z`, body: null },
  "Search events by title": { method: "GET", url: `${BASE}/events/portal/events?popup_id=${POPUP}&event_status=published&search=KEYWORD&start_after=2026-10-11T00:00:00Z`, body: null },
  "Filter by tag, kind, venue, or track": { method: "GET", url: `${BASE}/events/portal/events?popup_id=${POPUP}&event_status=published&tags=AI&tags=Privacy&start_after=2026-10-11T00:00:00Z&start_before=2026-10-12T00:00:00Z`, body: null },
  "Only events you've RSVPed to": { method: "GET", url: `${BASE}/events/portal/events?popup_id=${POPUP}&event_status=published&rsvped_only=true&start_after=2026-10-11T00:00:00Z`, body: null },
  "Fetch a single event": { method: "GET", url: `${BASE}/events/portal/events/${EVENT}`, body: null },
  "RSVP to a one-off event": { method: "POST", url: `${BASE}/event-participants/portal/register/${EVENT}`, body: {} },
  "RSVP to one occurrence of a recurring event": { method: "POST", url: `${BASE}/event-participants/portal/register/${EVENT}`, body: { occurrence_start: "2026-10-20T10:00:00Z" } },
  "Cancel a previous RSVP": { method: "POST", url: `${BASE}/event-participants/portal/cancel-registration/${EVENT}`, body: {} },
  "List who is going to one event": { method: "GET", url: `${BASE}/event-participants/portal/participants?event_id=${EVENT}&skip=0&limit=100`, body: null },
  "List active venues for a popup": { method: "GET", url: `${BASE}/event-venues/portal/venues?popup_id=${POPUP}&limit=100`, body: null },
};

function sameRequest(url: string, expected: string) {
  const a = new URL(url);
  const b = new URL(expected);
  expect(`${a.origin}${a.pathname}`).toBe(`${b.origin}${b.pathname}`);
  const sorted = (u: URL) => [...u.searchParams.entries()].sort(([x, xv], [y, yv]) => (x + xv).localeCompare(y + yv));
  // The verbs page the venues list explicitly (skip=0), which the curl left to EdgeOS's default.
  const expectedParams = sorted(b);
  const params = sorted(a).filter(([k, v]) => !(k === "skip" && v === "0" && !b.searchParams.has("skip")));
  expect(params).toEqual(expectedParams);
}

describe("every recipe in the skill sends what its v2.1.9 curl sent", () => {
  const runs = skillRuns();

  test("the skill has the eleven recipes, one script run each", () => {
    expect([...runs.keys()].sort()).toEqual(Object.keys(LEGACY).sort());
  });

  for (const [heading, legacy] of Object.entries(LEGACY)) {
    test(heading, async () => {
      const argv = runs.get(heading)!;
      const f = fakeFetch(legacy.method === "POST" ? { id: "9e9e9e9e-1111-4222-8333-444444444444", event_id: EVENT, status: "registered" } : {});
      const r = await run(argv, ENV(), f.impl);
      expect(r.code).toBe(0);
      // A bare rsvp first reads the event (EDGEOS-OCCURRENCE: a recurring one is never booked without a session).
      const bareRsvp = argv[0] === "rsvp" && !argv.includes("--occurrence");
      expect(f.calls.length).toBe(bareRsvp ? 2 : 1);
      if (bareRsvp) {
        expect([f.calls[0].init.method, f.calls[0].url]).toEqual(["GET", `${BASE}/events/portal/events/${EVENT}`]);
      }
      const { url, init } = f.calls[f.calls.length - 1];
      expect(init.method).toBe(legacy.method);
      sameRequest(url, legacy.url);
      expect(init.body === undefined ? null : JSON.parse(init.body as string)).toEqual(legacy.body);
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${KEY}`);
      if (legacy.method === "POST") expect(headers["Content-Type"]).toBe("application/json");
      expect(init.redirect).toBe("error");
      expect(r.out).not.toContain(KEY);
      expect(r.err).not.toContain(KEY);
    });
  }
});

describe("verbs and arguments", () => {
  const ok = (argv: string[]) => {
    const parsed = parseArgs(argv);
    if ("error" in parsed) throw new Error(parsed.error);
    return parsed as Args;
  };
  const bad = (argv: string[]) => expect("error" in parseArgs(argv)).toBe(true);

  test("the request table", () => {
    // An offset is sent as the same instant in UTC, EdgeOS's own start_time form (EDGEOS-OCCURRENCE).
    const occ = "2026-10-20T15:30:00+05:30";
    const utc = "2026-10-20T10:00:00Z";
    expect(request(ok(["event", EVENT, "--occurrence", occ])).query.toString()).toBe(`occurrence_start=${encodeURIComponent(utc)}`);
    expect(request(ok(["cancel", EVENT, "--occurrence", occ])).body).toEqual({ occurrence_start: utc });
    const p = request(ok(["participants", EVENT.toUpperCase(), "--occurrence", occ, "--skip", "100", "--limit", "50"]));
    expect([p.method, p.path, p.query.get("event_id"), p.query.get("skip"), p.query.get("limit")]).toEqual(
      ["GET", "/event-participants/portal/participants", EVENT, "100", "50"]);
    const l = request(ok(["list", "--after", "2026-10-11T00:00:00Z", "--venue", VENUE, "--venue", VENUE, "--track", VENUE, "--kind", "talk"]), POPUP);
    expect(l.query.getAll("venue_ids")).toEqual([VENUE, VENUE]);
    expect([l.query.get("track_ids"), l.query.get("kind"), l.query.get("popup_id")]).toEqual([VENUE, "talk", POPUP]);
    const v = request(ok(["venues", "--popup", POPUP.toUpperCase()]), "other");
    expect([v.query.get("popup_id"), v.popup]).toEqual([POPUP, false]);
  });

  test("refused shapes", () => {
    for (const argv of [
      [], ["delete", EVENT], ["rsvp"], ["rsvp", "nope"], ["rsvp", "--occurrence", "2026-10-20T10:00:00Z"],
      ["rsvp", EVENT, "--occurrence"], ["rsvp", EVENT, "--occurrence", "2026-10-20T10:00:00"],
      ["rsvp", EVENT, "--occurrence", "2026-02-30T10:00:00Z"], ["rsvp", EVENT, "--occurrence", "2026-10-20T24:00:00Z"],
      ["rsvp", EVENT, "--occurrence=2026-10-20T10:00:00Z"], ["rsvp", EVENT, "--skip", "0"], ["event", EVENT, "extra"],
      ["rsvp", EVENT, "--occurrence", "2026-10-20T10:00:00Z", "--occurrence", "2026-10-21T10:00:00Z"],
      ["list"], ["list", "--before", "2026-10-12T00:00:00Z"], ["list", "--after", "2026-10-12T00:00:00Z", "--before", "2026-10-11T00:00:00Z"],
      ["list", "--after", "2026-10-11T00:00:00Z", "--search", " "], ["list", "--after", "2026-10-11T00:00:00Z", "--venue", "x"],
      ["venues", "--limit", "0"], ["venues", "--limit", "1001"], ["venues", "--skip", "-1"], ["venues", "--popup", "x"],
      ["participants", EVENT, "--limit", "1e3"],
      // Security review 2: only ASCII digits (the av-events observer refuses the others too).
      ["venues", "--limit", "\u0661\u0662"], ["venues", "--skip", "\uff11\uff12"],
      ["rsvp", EVENT, "--occurrence", "2026-10-2\u0660T10:00:00Z"],
      // EDGEOS-OCCURRENCE: a portal ?occ= value is decoded once, and must then be one of the forms above.
      ["rsvp", EVENT, "--occurrence", "2026-10-20T10%3A00%3A00"], ["rsvp", EVENT, "--occurrence", "2026-10-20T10%ZZ00Z"],
      ["rsvp", EVENT, "--occurrence", "2026-10-20T10%253A00%253A00Z"], ["rsvp", EVENT, "--occurrence", "2026-10-20T10:00:00 05:30"],
      ["rsvp", EVENT, "--occurrence", "?occ=2026-10-20T10%3A00%3A00Z"],
    ]) bad(argv);
    expect(validInstant("2026-10-20T10:00Z")).toBe(true);
    expect(validInstant("2026-10-20T10:00:00.123+05:30")).toBe(true);
    expect(validInstant("2026-10-20T10:00:00+25:00")).toBe(false);
  });
});

describe("the key, the base and the exit codes", () => {
  const argv = ["event", EVENT];

  test("the key comes from $HERMES_HOME/.env when the environment has none, and is never printed", async () => {
    const f = fakeFetch({ id: EVENT, my_rsvp_status: null });
    const r = await run(argv, { HERMES_HOME: home([`EDGEOS_API_KEY="${KEY}"`]) }, f.impl);
    expect(r.code).toBe(0);
    expect((f.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(r.out)).toEqual({ id: EVENT, my_rsvp_status: null });
    expect(r.out + r.err).not.toContain(KEY);
  });

  test("exit 2 when the key or (for a list) the popup is not set; nothing is sent", async () => {
    const f = fakeFetch();
    const noKey = await run(argv, { HERMES_HOME: home() }, f.impl);
    expect([noKey.code, noKey.err]).toEqual([2, expect.stringContaining("EDGEOS_API_KEY is not set")]);
    const noPopup = await run(["venues"], { HERMES_HOME: home(), EDGEOS_API_KEY: KEY }, f.impl);
    expect([noPopup.code, noPopup.err]).toEqual([2, expect.stringContaining("AV_POPUP_ID is not set")]);
    // A single event needs no popup.
    expect((await run(argv, { HERMES_HOME: home(), EDGEOS_API_KEY: KEY }, fakeFetch({ id: EVENT }).impl)).code).toBe(0);
    expect(f.calls.length).toBe(0);
  });

  test("exit 2 for any base but https on an EdgeOS host under /api/v1; nothing is sent", async () => {
    const f = fakeFetch();
    for (const base of [
      "https://evil.example/api/v1", "http://api.edgeos.world/api/v1", "https://api.edgeos.world/api/v2",
      "https://api.edgeos.world", "https://user@api.edgeos.world/api/v1", "https://api.edgeos.world:8443/api/v1",
      "https://api.edgeos.world.evil.example/api/v1", "not a url",
    ]) {
      const r = await run(argv, { ...ENV(), EDGEOS_API_BASE: base }, f.impl);
      expect([base, r.code]).toEqual([base, 2]);
      expect(r.err).not.toContain(KEY);
    }
    expect(f.calls.length).toBe(0);
    const ok = fakeFetch({ id: EVENT });
    expect((await run(argv, { ...ENV(), EDGEOS_API_BASE: `${BASE}/` }, ok.impl)).code).toBe(0);
    expect(ok.calls[0].url).toBe(`${BASE}/events/portal/events/${EVENT}`);
  });

  test("exit 3 for a usage error, with the usage; nothing is sent", async () => {
    const f = fakeFetch();
    const r = await run(["rsvp", "not-a-uuid"], ENV(), f.impl);
    expect(r.code).toBe(3);
    expect(r.err).toContain("usage: bun skills/edgeos/scripts/edgeos.ts");
    expect(f.calls.length).toBe(0);
  });

  test("exit 1 with the status and EdgeOS's short reason on an error answer", async () => {
    const notFound = await run(["cancel", EVENT], ENV(), fakeFetch({ detail: "No active registration found" }, 404).impl);
    expect([notFound.code, notFound.out]).toEqual([1, ""]);
    expect(notFound.err).toBe("edgeos: EdgeOS answered 404: No active registration found\n");
    const refused = await run(argv, ENV(), fakeFetch({ detail: [{ msg: "x" }] }, 401).impl);
    expect(refused.err).toBe("edgeos: EdgeOS answered 401 (the key was refused)\n");
    const limited = await run(argv, ENV(), fakeFetch("slow down", 429, { "retry-after": "30" }).impl);
    expect(limited.err).toBe("edgeos: EdgeOS answered 429 (retry after 30 s)\n");
    const long = await run(argv, ENV(), fakeFetch({ detail: `a\nb ${"x".repeat(500)}` }, 422).impl);
    expect(long.err.length).toBeLessThan(260);
    expect(long.err).not.toContain("\nb");
  });

  test("exit 1 when EdgeOS is unreachable or answers something that is not JSON", async () => {
    const thrown = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await run(argv, ENV(), thrown);
    expect([r.code, r.err]).toEqual([1, "edgeos: EdgeOS unreachable (TypeError)\n"]);
    const html = await run(argv, ENV(), fakeFetch("<html>gateway</html>").impl);
    expect(html.code).toBe(1);
  });

  test("the answer is printed as one JSON line, exactly what EdgeOS sent", async () => {
    const record = { id: "9e9e9e9e-1111-4222-8333-444444444444", event_id: EVENT, status: "registered", occurrence_start: null };
    const r = await run(["rsvp", EVENT], ENV(), fakeFetch(record).impl);
    expect(r.out).toBe(`${JSON.stringify(record)}\n`);
  });
});

describe("recurring events name their occurrence (EDGEOS-OCCURRENCE)", () => {
  const SERIES = { id: EVENT, popup_id: POPUP, title: "x", start_time: "2026-10-14T03:00:00Z", rrule: "FREQ=DAILY;COUNT=20",
    recurrence_master_id: null, occurrence_id: null, my_rsvp_status: null, attendee_count: 0 };
  const ONE_OFF = { ...SERIES, rrule: null };
  const RECORD = { id: "9e9e9e9e-1111-4222-8333-444444444444", event_id: EVENT, status: "registered", occurrence_start: null };
  const NOW = Date.parse("2026-10-21T00:00:00Z");
  const DETACHED = "22222222-3333-4444-8555-666666666666";
  const OTHER = "33333333-4444-4555-8666-777777777777";

  /** fetch by route: the single read answers `event`, the list `list`, an RSVP the participant record. */
  function routed(event: unknown, list: unknown = { results: [], paging: {} }) {
    const calls: Call[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const path = new URL(url).pathname;
      const body = init.method === "POST" ? { ...RECORD, ...(init.body ? JSON.parse(init.body as string) : {}) }
        : path.endsWith("/events/portal/events") ? list : event;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  test("--occurrence takes EdgeOS's start_time unchanged, an offset as the same UTC instant, and a portal ?occ= value", () => {
    // EdgeOS's own form (and so the schedule line's `start <ISO>`) is sent byte for byte.
    for (const same of ["2026-10-21T02:30:00Z", "2026-10-21T02:30Z", "2026-10-21T02:30:00.123456Z"]) {
      expect(occurrenceInstant(same)).toBe(same);
    }
    expect(occurrenceInstant("2026-10-21T08:00:00+05:30")).toBe("2026-10-21T02:30:00Z");
    expect(occurrenceInstant("2026-10-21T02:30:00+00:00")).toBe("2026-10-21T02:30:00Z");
    expect(occurrenceInstant("2026-10-21T08:00+05:30")).toBe("2026-10-21T02:30:00Z");
    expect(occurrenceInstant("2026-10-21T08:00:00.5+05:30")).toBe("2026-10-21T02:30:00.5Z");
    expect(occurrenceInstant("2026-10-21T01:00:00+05:30")).toBe("2026-10-20T19:30:00Z"); // across midnight
    // The portal's link is `?occ=${encodeURIComponent(start_time)}` (portal-link.ts).
    expect(occurrenceInstant(encodeURIComponent("2026-10-21T02:30:00Z"))).toBe("2026-10-21T02:30:00Z");
    expect(occurrenceInstant("2026-10-21T02%3A30%3A00Z")).toBe("2026-10-21T02:30:00Z");
    expect(occurrenceInstant("2026-10-21T08%3A00%3A00%2B05%3A30")).toBe("2026-10-21T02:30:00Z");
    for (const refused of ["2026-10-21T02:30:00", "2026-10-21", "2026-10-21T02%3A30%3A00", "%E0%A4%A", "2026-10-21T02:30:00 05:30"]) {
      expect([refused, occurrenceInstant(refused)]).toEqual([refused, null]);
    }
    const parsed = parseArgs(["rsvp", EVENT, "--occurrence", "2026-10-21T08%3A00%3A00%2B05%3A30"]) as Args;
    expect(request(parsed).body).toEqual({ occurrence_start: "2026-10-21T02:30:00Z" });
  });

  test("a recurring event read without --occurrence says it is the FIRST occurrence; stdout stays EdgeOS's JSON", async () => {
    const f = routed(SERIES);
    const r = await run(["event", EVENT], ENV(), f.impl);
    expect(r.code).toBe(0);
    expect(r.out).toBe(`${JSON.stringify(SERIES)}\n`);
    expect(r.err).toBe("recurring event: this is the FIRST occurrence (start 2026-10-14T03:00:00Z); pass --occurrence <ISO> for another session\n");
    expect(f.calls.length).toBe(1);
  });

  test("a recurring event read with --occurrence names that occurrence (as sent)", async () => {
    const f = routed(SERIES);
    const r = await run(["event", EVENT, "--occurrence", "2026-10-21T08:00:00+05:30"], ENV(), f.impl);
    expect(r.code).toBe(0);
    expect(r.err).toBe("occurrence 2026-10-21T02:30:00Z\n");
    expect(new URL(f.calls[0].url).searchParams.get("occurrence_start")).toBe("2026-10-21T02:30:00Z");
  });

  test("a one-off event read, or a detached session (no rrule), gets no note", async () => {
    for (const event of [ONE_OFF, { ...ONE_OFF, recurrence_master_id: OTHER }, { ...ONE_OFF, rrule: "  " }]) {
      const r = await run(["event", EVENT], ENV(), routed(event).impl);
      expect([r.code, r.err]).toEqual([0, ""]);
    }
    expect(occurrenceNote({ ...SERIES, start_time: "next tuesday" }, "")).toContain("(start unknown)");
  });

  test("a bare rsvp on a recurring event books nothing: it lists the next sessions and exits 5", async () => {
    const at = (h: number) => new Date(NOW + h * 3_600_000).toISOString().replace(".000Z", "Z");
    const rows = [
      ...Array.from({ length: MAX_SESSIONS + 3 }, (_, i) => ({ id: EVENT, occurrence_id: `${EVENT}_x${i}`, start_time: at(24 * (MAX_SESSIONS + 3 - i)) })),
      { id: DETACHED, recurrence_master_id: EVENT, start_time: at(2) },
      { id: OTHER, start_time: at(1) }, { id: EVENT, start_time: "not a time" },
    ];
    const f = routed(SERIES, { results: rows, paging: {} });
    const r = await run(["rsvp", EVENT], ENV(), f.impl, NOW);
    expect([r.code, r.out]).toEqual([5, ""]);
    expect(f.calls.every((c) => c.init.method === "GET")).toBe(true);
    expect(f.calls.length).toBe(2);
    const list = new URL(f.calls[1].url);
    expect(list.pathname).toBe("/api/v1/events/portal/events");
    expect([list.searchParams.get("popup_id"), list.searchParams.get("start_after"), list.searchParams.get("start_before")])
      .toEqual([POPUP, "2026-10-21T00:00:00.000Z", "2026-11-04T00:00:00.000Z"]);
    const lines = r.err.trimEnd().split("\n");
    expect(lines[0]).toStartWith("edgeos: a recurring event: nothing was booked.");
    expect(lines[0]).toContain("--occurrence <its start>");
    const sessions = lines.filter((l) => l.startsWith("start "));
    expect(sessions.length).toBe(MAX_SESSIONS);
    expect(sessions[0]).toBe(`start ${at(2)} (its own event ${DETACHED}: rsvp it without --occurrence)`);
    expect(sessions[1]).toBe(`start ${at(24)}`);
    expect(r.err).not.toContain(OTHER);
    expect(r.err).not.toContain("not a time");
    expect(r.err).not.toContain(KEY);
  });

  test("a bare rsvp on a recurring event whose sessions cannot be listed still books nothing", async () => {
    const empty = await run(["rsvp", EVENT], ENV(), routed(SERIES).impl, NOW);
    expect([empty.code, empty.err]).toEqual([5, expect.stringContaining("No session starts in the next 14 days")]);
    const noPopup = routed({ ...SERIES, popup_id: null });
    const r = await run(["rsvp", EVENT], { HERMES_HOME: home(), EDGEOS_API_KEY: KEY }, noPopup.impl, NOW);
    expect([r.code, r.err]).toEqual([5, expect.stringContaining("could not be listed")]);
    expect(noPopup.calls.length).toBe(1);
  });

  test("a bare rsvp on a one-off event (or a detached session) reads it, then books it as before", async () => {
    for (const event of [ONE_OFF, { ...ONE_OFF, recurrence_master_id: OTHER }]) {
      const f = routed(event);
      const r = await run(["rsvp", EVENT], ENV(), f.impl, NOW);
      expect([r.code, r.err]).toEqual([0, ""]);
      expect(f.calls.map((c) => c.init.method)).toEqual(["GET", "POST"]);
      expect(f.calls[1].url).toBe(`${BASE}/event-participants/portal/register/${EVENT}`);
      expect(JSON.parse(f.calls[1].init.body as string)).toEqual({});
      expect(JSON.parse(r.out).status).toBe("registered");
    }
  });

  test("an rsvp with --occurrence is one POST naming it, no read first", async () => {
    const f = routed(SERIES);
    const r = await run(["rsvp", EVENT, "--occurrence", "2026-10-21T02%3A30%3A00Z"], ENV(), f.impl, NOW);
    expect(r.code).toBe(0);
    expect(f.calls.map((c) => c.init.method)).toEqual(["POST"]);
    expect(JSON.parse(f.calls[0].init.body as string)).toEqual({ occurrence_start: "2026-10-21T02:30:00Z" });
  });

  test("a bare rsvp whose read fails exits 1 with EdgeOS's reason and books nothing", async () => {
    const f = fakeFetch({ detail: "Event not found" }, 404);
    const r = await run(["rsvp", EVENT], ENV(), f.impl, NOW);
    expect([r.code, r.err]).toEqual([1, "edgeos: EdgeOS answered 404: Event not found\n"]);
    expect(f.calls.length).toBe(1);
  });

  test("EdgeOS's occurrence refusals reach the agent as one line naming the status and the reason", async () => {
    for (const detail of [
      "occurrence_start does not match a scheduled occurrence",
      "occurrence_start is not allowed for non-recurring events",
      "occurrence_start is required for recurring events",
    ]) {
      const r = await run(["rsvp", EVENT, "--occurrence", "2026-10-21T02:30:00Z"], ENV(), fakeFetch({ detail }, 400).impl);
      expect([r.code, r.out, r.err]).toEqual([1, "", `edgeos: EdgeOS answered 400: ${detail}\n`]);
    }
  });
});

describe("the --occurrence parity table (EDGEOS-OCCURRENCE; the av-events observer runs the same file)", () => {
  // plugins/av-events/tests/test_edgeos_occurrence_parity.py reads this table through the observer's own
  // parser (`script_occurrence`, `http_call`): the two sides must name the same occurrence for every input.
  const table = JSON.parse(readFileSync(join(import.meta.dir, "occurrence-parity.json"), "utf8")) as {
    cases: { name: string; input: string; sends: string | null }[];
  };

  test("the table covers the Z, offset, encoded, doubly-encoded and refused forms", () => {
    const sends = table.cases.map((c) => c.sends);
    expect(table.cases.length).toBeGreaterThan(30);
    expect(sends).toContain(null);
    expect(table.cases.some((c) => c.input.includes("%25") && c.sends === null)).toBe(true);
    expect(table.cases.some((c) => c.input.includes("%2B05%3A30") && c.sends !== null)).toBe(true);
  });

  for (const c of table.cases) {
    test(c.name, () => {
      expect(occurrenceInstant(c.input)).toBe(c.sends);
      const parsed = parseArgs(["event", EVENT, "--occurrence", c.input]);
      if (c.sends === null) {
        expect("error" in parsed).toBe(true);
      } else {
        expect(request(parsed as Args).query.get("occurrence_start")).toBe(c.sends);
        expect(request(parseArgs(["rsvp", EVENT, "--occurrence", c.input]) as Args).body).toEqual({ occurrence_start: c.sends });
      }
    });
  }
});
