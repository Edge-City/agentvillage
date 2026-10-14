/**
 * The directory script (skills/edgeos/scripts/directory.ts, DATA-454): the settings read from the
 * environment or $HERMES_HOME/.env, the allow-listed arguments, the call to the control plane, the
 * fail-soft exit codes against a stub control plane, and the printed rows. fetch is injected; nothing
 * leaves the machine. Every key here is the placeholder `example-not-a-key`.
 *
 *   bun test skills/edgeos/scripts/tests/directory.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXIT_NOT_CONNECTED,
  EXIT_OK,
  EXIT_SIGNIN,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  CP_HOSTS,
  SIGNIN_URL,
  FIELDS,
  attendeeLine,
  controlPlaneBase,
  directBase,
  parseArgs,
  project,
  run,
} from "../directory";

const KEY = "example-not-a-key";
const TENANT = "3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f";
const POPUP = "7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d";
const ESMERALDA = "43746fd0-bce2-472b-93e4-a438177b2dff";
const CP = "https://control-plane-production-606c.up.railway.app";

function home(lines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeos-directory-"));
  writeFileSync(join(dir, ".env"), lines.join("\n") + "\n");
  return dir;
}

const connected = (extra: string[] = []) => ({
  HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`, `export EDGEOS_API_KEY="${KEY}"`,
    `AV_POPUP_ID=${POPUP}`, ...extra]),
});

/** A stub control plane: one answer for every call, recording each call. */
function stubCp(status: number, body: unknown = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const PRIYA = {
  id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  first_name: "Priya",
  last_name: "Shah",
  email: "*",
  telegram: "priyash",
  role: "Founder",
  organization: "Tidepool",
  residence: null,
  age: "*",
  gender: null,
  picture_url: "https://img.example/p.png",
  category: "main",
  participation: [{ id: "t1", name: "Full month", slug: "full", category: "month", duration_type: "month", price: 900 }],
  associated_attendees: [],
  application_answers: "should never be printed",
};
const GOOD = { results: [PRIYA], paging: { offset: 0, limit: 20, total: 41 } };

/** A stub control plane and a stub EdgeOS, each with its own answer, recording each call. */
function stubBoth(cp: [number, unknown], direct: [number, unknown]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const [status, body] = url.startsWith(CP) ? cp : direct;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const to = (prefix: string) => calls.filter((c) => c.url.startsWith(prefix));
  return { impl, calls, cpCalls: () => to(CP), directCalls: () => to(EDGEOS) };
}
const EDGEOS = "https://api.edgeos.world/api/v1";

/** Every output stream, for the no-key rule. */
const everything = (r: { out: string; err: string }) => r.out + r.err;

describe("arguments are allow-listed and checked here as the control plane checks them", () => {
  test("defaults", () => {
    expect(parseArgs([])).toEqual({ q: "", skip: 0, limit: 20, hideEmpty: false, popup: "", json: false });
  });

  test("accepted bounds", () => {
    expect(parseArgs(["--search", "  Priya  ", "--skip", "5000", "--limit", "100", "--hide-empty", "--popup",
      ESMERALDA.toUpperCase(), "--json"])).toEqual({ q: "Priya", skip: 5000, limit: 100, hideEmpty: true,
      popup: ESMERALDA, json: true });
    expect(parseArgs(["--search", "x".repeat(120), "--limit", "1", "--skip", "0"])).toMatchObject({ limit: 1, skip: 0 });
  });

  test("refused forms", () => {
    const refused: [string[], string][] = [
      [["--search", "x".repeat(121)], "--search must be 1 to 120"],
      [["--search", "   "], "--search must be 1 to 120"],
      [["--search", "a\u0007b"], "control characters"],
      [["--search", "a\u0085b"], "control characters"], // C1, as the control plane and the app refuse it
      [["--search"], "--search needs a value"],
      [["--skip", "5001"], "--skip must be"],
      [["--skip", "-1"], "--skip must be"],
      [["--skip", "1.5"], "--skip must be"],
      [["--limit", "0"], "--limit must be"],
      [["--limit", "101"], "--limit must be"],
      [["--limit", "1e2"], "--limit must be"],
      [["--popup", "not-a-uuid"], "--popup must be"],
      [["--key", KEY], "unknown argument --key"],
      [["--q", "x"], "unknown argument --q"],
      [["--hide_empty_rows=true"], "unknown argument"],
    ];
    for (const [argv, message] of refused) {
      expect(parseArgs(argv)).toEqual({ error: expect.stringContaining(message) });
    }
  });

  test("a usage error exits 3, names the argument and calls nothing", async () => {
    const cp = stubCp(200, GOOD);
    const r = await run(["--limit", "500"], connected(), cp.impl);
    expect(r.code).toBe(EXIT_USAGE);
    expect(r.err).toContain("--limit must be a whole number from 1 to 100");
    expect(r.err).toContain("usage: bun skills/edgeos/scripts/directory.ts");
    expect(cp.calls).toEqual([]);
  });
});

describe("the call", () => {
  test("one GET to the tenant's directory route; the key only in the header; allow-listed params only", async () => {
    const cp = stubCp(200, GOOD);
    const r = await run(["--search", "Priya Shah", "--skip", "20", "--limit", "50", "--hide-empty"], connected(), cp.impl);
    expect(r.code).toBe(EXIT_OK);
    expect(cp.calls.length).toBe(1);
    const url = new URL(cp.calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${CP}/tenants/${TENANT}/edgeos/directory`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: "Priya Shah", skip: "20", limit: "50", hide_empty_rows: "true", popup_id: POPUP,
    });
    expect(cp.calls[0].init.method).toBe("GET");
    expect(cp.calls[0].init.redirect).toBe("manual");
    expect(cp.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect((cp.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(cp.calls[0].url).not.toContain(KEY);
  });

  test("defaults: skip 0, limit 20, no q, the village popup; --popup overrides it", async () => {
    const cp = stubCp(200, GOOD);
    await run([], connected(), cp.impl);
    await run(["--popup", ESMERALDA], connected(), cp.impl);
    expect(Object.fromEntries(new URL(cp.calls[0].url).searchParams)).toEqual({ skip: "0", limit: "20", popup_id: POPUP });
    expect(new URL(cp.calls[1].url).searchParams.get("popup_id")).toBe(ESMERALDA);
  });

  test("no AV_POPUP_ID (or not a UUID): popup_id is left out and the control plane uses the tenant's popup", async () => {
    const cp = stubCp(200, GOOD);
    const env = { HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`, `EDGEOS_API_KEY=${KEY}`]) };
    await run([], env, cp.impl);
    await run([], { ...env, AV_POPUP_ID: "../../x" }, cp.impl);
    for (const call of cp.calls) expect(new URL(call.url).searchParams.has("popup_id")).toBe(false);
  });

  test("settings from the environment win over $HERMES_HOME/.env; a trailing slash on the URL is fine", async () => {
    const cp = stubCp(200, GOOD);
    const other = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    await run([], { ...connected(), CONTROL_PLANE_URL: `${CP}/`, TENANT_ID: other.toUpperCase() }, cp.impl);
    expect(cp.calls[0].url.startsWith(`${CP}/tenants/${other}/edgeos/directory?`)).toBe(true);
  });
});

describe("not connected: exit 2, and nothing sent when a setting is missing", () => {
  test("each missing setting says which, never a value, and calls nothing", async () => {
    const cp = stubCp(200, GOOD);
    const cases: [string[], string][] = [
      [[`TENANT_ID=${TENANT}`, `EDGEOS_API_KEY=${KEY}`], "CONTROL_PLANE_URL is not set"],
      [[`CONTROL_PLANE_URL=${CP}`, `EDGEOS_API_KEY=${KEY}`], "TENANT_ID is not set"],
      [[`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`], "EDGEOS_API_KEY is not set"],
    ];
    for (const [lines, message] of cases) {
      const r = await run([], { HERMES_HOME: home(lines) }, cp.impl);
      expect([r.code, r.out]).toEqual([EXIT_NOT_CONNECTED, ""]);
      expect(r.err).toContain(message);
      expect(everything(r)).not.toContain(KEY);
    }
    expect(cp.calls).toEqual([]);
  });

  test("controlPlaneBase: exact allow-listed host, https, no userinfo, no path, no other port", () => {
    expect(CP_HOSTS).toEqual(["control-plane-production-606c.up.railway.app"]);
    expect(controlPlaneBase(`${CP}/`)).toBe(CP);
    expect(controlPlaneBase(CP.toUpperCase().replace("HTTPS", "https"))).toBe(CP);
    expect(controlPlaneBase(`${CP}:443`)).toBe(CP);
    for (const bad of [
      "https://cp.example.test", // not on the list
      "http://control-plane-production-606c.up.railway.app", // not https
      "https://u:p@control-plane-production-606c.up.railway.app", // userinfo
      "https://x@control-plane-production-606c.up.railway.app",
      "https://control-plane-production-606c.up.railway.app.evil.example", // suffix
      "https://evil-control-plane-production-606c.up.railway.app", // prefix
      "https://control-plane-production-606c.up.railway.app:8443",
      "https://control-plane-production-606c.up.railway.app/base",
      "https://control-plane-production-606c.up.railway.app/?x=1",
      "https://control-plane-production-606c.up.railway.app/#f",
      "https://control-plane-production-b752.up.railway.app", // the old Esmeralda project
      "control-plane-production-606c.up.railway.app", "not a url", "file:///etc/passwd",
    ]) {
      expect(controlPlaneBase(bad)).toBeNull();
    }
  });

  test("directBase: only the documented EdgeOS base", () => {
    expect(directBase("")).toBe(EDGEOS);
    expect(directBase(`${EDGEOS}/`)).toBe(EDGEOS);
    for (const bad of ["https://api.edgeos.world/api/v2", "https://api.edgeos.world/", "http://api.edgeos.world/api/v1",
      "https://u:p@api.edgeos.world/api/v1", "https://api.edgeos.world.evil.example/api/v1", "https://collector.example/api/v1"]) {
      expect(directBase(bad)).toBeNull();
    }
  });
  test.each([
    [404, { error: "not found" }, "answered 404 not found"], // the cp route not deployed yet
    [401, { error: "unauthorized" }, "answered 401 unauthorized"], // wrong or stale key
    [403, { error: "directory_forbidden" }, "answered 403 directory_forbidden"],
    [409, { error: "not_linked" }, "answered 409 not_linked"], // no live Edge City grant
    [409, { error: "ambiguous" }, "answered 409 ambiguous"],
    [404, { error: "directory_not_found" }, "this popup has no attendee directory"],
  ])("a stub control plane answering %i exits 2 (the direct path answering 403, as EdgeOS does today)", async (status, body, message) => {
    const stub = stubBoth([status, body], [403, { detail: "API keys are restricted to approved event automation routes" }]);
    const r = await run(["--search", "Priya"], connected(), stub.impl);
    expect(stub.cpCalls().length).toBe(1);
    expect(stub.directCalls().length).toBe(1);
    expect([r.code, r.out]).toEqual([EXIT_NOT_CONNECTED, ""]);
    expect(r.err).toStartWith("directory: not connected: ");
    expect(r.err).toContain(message);
    expect(r.err).toContain("direct answered 403 via=direct");
    expect(r.err).not.toContain("API keys are restricted"); // never the body
    expect(everything(r)).not.toContain(KEY);
  });
});

describe("can't reach it right now: exit 1", () => {
  test.each([429, 500, 502, 503, 504])("a stub control plane answering %i exits 1, with no direct call", async (status) => {
    const stub = stubBoth([status, { error: "edgeos_unavailable" }], [200, GOOD]);
    const r = await run([], connected(), stub.impl);
    expect(stub.calls.length).toBe(1);
    expect(stub.directCalls()).toEqual([]);
    expect(r.err).toEndWith(" via=cp\n");
    expect([r.code, r.out]).toEqual([EXIT_UNAVAILABLE, ""]);
    expect(r.err).toStartWith("directory: can't reach the directory right now: ");
    expect(r.err).toContain(String(status));
    expect(everything(r)).not.toContain(KEY);
  });

  test("a network error exits 1 with the error's name only", async () => {
    const r = await run([], connected(), (async () => {
      throw new TypeError(`fetch failed for Bearer ${KEY}`);
    }) as unknown as typeof fetch);
    expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, "directory: can't reach the directory right now: cp network error (TypeError) via=cp\n"]);
  });

  test("a hung control plane times out and exits 1", async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const started = Date.now();
    const r = await run([], connected(), hang, { timeoutMs: 50 });
    expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, "directory: can't reach the directory right now: cp timed out via=cp\n"]);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test("the default timeout is bounded (15 s)", async () => {
    const { TIMEOUT_MS } = await import("../directory");
    expect(TIMEOUT_MS).toBe(15_000);
  });

  test("a 200 that is not a directory listing exits 1", async () => {
    for (const body of ["<html>proxy</html>", { rows: [] }, null]) {
      const r = await run([], connected(), stubCp(200, body as unknown).impl);
      expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, expect.stringContaining("not a directory listing")]);
    }
  });

  test("an error body is never echoed: only a known code is named", async () => {
    const r = await run([], connected(), stubCp(503, { error: `secret detail ${KEY}`, detail: "stack at x" }).impl);
    expect(r.err).toBe("directory: can't reach the directory right now: cp answered 503 via=cp\n");
  });

  test("a 400 from the control plane is a usage error (3), not a fail-soft answer", async () => {
    const r = await run([], connected(), stubCp(400, { error: "param_unknown" }).impl);
    expect([r.code, r.err]).toEqual([EXIT_USAGE, expect.stringContaining("refused the arguments (400 param_unknown)")]);
  });
});

describe("a good answer: exit 0", () => {
  test("one line per attendee, `*` as hidden, unknown fields dropped, then the paging line", async () => {
    const r = await run(["--search", "Priya"], connected(), stubCp(200, GOOD).impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=cp\n"]);
    expect(r.out).toBe(
      "name: Priya Shah · email: hidden · telegram: priyash · role: Founder · organization: Tidepool · age: hidden · " +
        "category: main · tickets: Full month · picture: https://img.example/p.png · id 0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e\n" +
        "paging: offset 0, showing 1, total 41 (more: --skip 1)\n",
    );
    expect(r.out).not.toContain("should never be printed");
    expect(r.out).not.toContain(KEY);
  });

  test("--json prints {results, paging} with the §9 fields only and `*` kept", async () => {
    const r = await run(["--json"], connected(), stubCp(200, GOOD).impl);
    expect(r.code).toBe(EXIT_OK);
    const page = JSON.parse(r.out);
    expect(Object.keys(page)).toEqual(["results", "paging"]);
    expect(Object.keys(page.results[0])).toEqual([...FIELDS]);
    expect(page.results[0].email).toBe("*");
    expect(page.results[0].participation).toEqual([{ id: "t1", name: "Full month", slug: "full", category: "month", duration_type: "month" }]);
    expect(page.paging).toEqual({ offset: 0, limit: 20, total: 41 });
    expect(r.out).not.toContain("application_answers");
    expect(r.out).not.toContain(KEY);
  });

  test("no match says so", async () => {
    const r = await run(["--search", "nobody"], connected(), stubCp(200, { results: [], paging: { offset: 0, limit: 20, total: 0 } }).impl);
    expect([r.code, r.out]).toEqual([EXIT_OK, "no attendees matching\npaging: offset 0, showing 0, total 0\n"]);
  });

  test("a fully hidden name, a spouse row and missing keys", () => {
    expect(attendeeLine(project({ results: [{ id: "a", first_name: "*", last_name: "*", category: "spouse" }] })!.results[0]))
      .toBe("name: hidden · category: spouse · id a");
    expect(project({ results: [{}] })!.results[0]).toEqual(Object.fromEntries(FIELDS.map((f) => [f,
      f === "participation" || f === "associated_attendees" ? [] : null])));
  });
});

describe("the key is never printed", () => {
  test("across every exit path, out and err carry no key and no Authorization header", async () => {
    const paths: [number, unknown][] = [[200, GOOD], [401, {}], [403, {}], [404, {}], [409, {}], [429, {}], [500, {}],
      [503, `Bearer ${KEY}`]];
    for (const [status, body] of paths) {
      for (const argv of [[], ["--json"]]) {
        const r = await run(argv, connected(), stubCp(status, body).impl);
        expect(everything(r)).not.toContain(KEY);
        expect(everything(r)).not.toContain("Authorization");
        expect(everything(r)).not.toContain("Bearer");
      }
    }
  });
});

describe("the direct EdgeOS fallback (only when the control plane is not connected)", () => {
  const RESTRICTED = { detail: "API keys are restricted to approved event automation routes" };

  test("cp 404 (route not deployed) + direct 403 (EdgeOS today) → exit 2, the not-connected answer", async () => {
    const stub = stubBoth([404, { error: "not found" }], [403, RESTRICTED]);
    const r = await run(["--search", "Priya"], connected(), stub.impl);
    expect([r.code, r.out]).toEqual([EXIT_NOT_CONNECTED, ""]);
    expect(r.err).toBe("directory: not connected: cp answered 404 not found; direct answered 403 via=direct\n");
  });

  test("cp 404 + direct 200 → exit 0, the old §9 endpoint and parameters, the key as events.ts sends it", async () => {
    const stub = stubBoth([404, { error: "not found" }], [200, GOOD]);
    const r = await run(["--search", "Priya", "--skip", "20", "--limit", "50", "--hide-empty"], connected(), stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=direct\n"]);
    expect(stub.directCalls().length).toBe(1);
    const call = stub.directCalls()[0];
    const url = new URL(call.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${EDGEOS}/applications/my/directory/${POPUP}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ skip: "20", limit: "50", q: "Priya", hide_empty_rows: "true" });
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(call.init.redirect).toBe("manual");
    expect(call.url).not.toContain(KEY);
    expect(r.out).not.toContain(KEY);
  });

  test("both paths print the same shape: extra fields in the direct answer are dropped", async () => {
    const extra = {
      results: [{ ...PRIYA, phone: "+91 00000", application_answers: "private", participation: [{ ...PRIYA.participation[0], secret: 1 }] }],
      paging: { offset: 0, limit: 20, total: 41, cursor: "x" },
      debug: { token: "nope" },
    };
    const viaCp = await run(["--json"], connected(), stubBoth([200, extra], [500, {}]).impl);
    const viaDirect = await run(["--json"], connected(), stubBoth([409, { error: "not_linked" }], [200, extra]).impl);
    expect([viaCp.code, viaDirect.code]).toEqual([EXIT_OK, EXIT_OK]);
    expect(viaDirect.out).toBe(viaCp.out);
    const page = JSON.parse(viaDirect.out);
    expect(Object.keys(page)).toEqual(["results", "paging"]);
    expect(Object.keys(page.results[0])).toEqual([...FIELDS]);
    expect(Object.keys(page.results[0].participation[0])).toEqual(["id", "name", "slug", "category", "duration_type"]);
    expect(page.paging).toEqual({ offset: 0, limit: 20, total: 41 });
    for (const gone of ["phone", "application_answers", "secret", "cursor", "debug", "nope"]) expect(viaDirect.out).not.toContain(gone);
    const lines = await run([], connected(), stubBoth([401, {}], [200, extra]).impl);
    const linesCp = await run([], connected(), stubBoth([200, extra], [500, {}]).impl);
    expect(lines.out).toBe(linesCp.out);
  });

  test("cp 503 → exit 1 and no direct call (no doubled load in an outage)", async () => {
    const stub = stubBoth([503, { error: "edgeos_unavailable" }], [200, GOOD]);
    const r = await run([], connected(), stub.impl);
    expect(r.code).toBe(EXIT_UNAVAILABLE);
    expect(stub.directCalls()).toEqual([]);
  });

  test("cp timeout or network error → exit 1 and no direct call", async () => {
    const calls: string[] = [];
    const down = (async (url: string) => {
      calls.push(url);
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const r = await run([], connected(), down);
    expect(r.code).toBe(EXIT_UNAVAILABLE);
    expect(calls.length).toBe(1);
  });

  test("cp 200 → no direct call", async () => {
    const stub = stubBoth([200, GOOD], [200, GOOD]);
    const r = await run([], connected(), stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=cp\n"]);
    expect(stub.directCalls()).toEqual([]);
  });

  test("a 5xx or 429 on the direct call → exit 1", async () => {
    for (const status of [429, 500, 503]) {
      const r = await run([], connected(), stubBoth([404, {}], [status, {}]).impl);
      expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, expect.stringContaining(`direct `)]);
      expect(r.err).toEndWith(" via=direct\n");
    }
  });

  test("--popup goes to the direct path too", async () => {
    const stub = stubBoth([404, {}], [200, GOOD]);
    await run(["--popup", ESMERALDA], connected(), stub.impl);
    expect(new URL(stub.directCalls()[0].url).pathname).toBe(`/api/v1/applications/my/directory/${ESMERALDA}`);
  });

  test("the key goes direct only to an EdgeOS host; no popup means no direct call", async () => {
    const off = stubBoth([404, {}], [200, GOOD]);
    const r = await run([], { ...connected(), EDGEOS_API_BASE: "https://collector.example/api/v1" }, off.impl);
    expect([r.code, r.err]).toEqual([EXIT_NOT_CONNECTED, expect.stringContaining("EDGEOS_API_BASE is not https://api.edgeos.world/api/v1, so no direct call via=cp")]);
    expect(off.calls.length).toBe(1);
    expect(off.calls[0].url.startsWith(CP)).toBe(true);
    const noPopup = stubBoth([404, {}], [200, GOOD]);
    const env = { HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`, `EDGEOS_API_KEY=${KEY}`]) };
    const r2 = await run([], env, noPopup.impl);
    expect([r2.code, r2.err]).toEqual([EXIT_NOT_CONNECTED, expect.stringContaining("AV_POPUP_ID is not set, so no direct call")]);
    expect(noPopup.directCalls()).toEqual([]);
  });

  test("no control plane settings on the box: the direct path is tried (a key-only box)", async () => {
    const stub = stubBoth([200, GOOD], [403, RESTRICTED]);
    const env = { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`, `AV_POPUP_ID=${POPUP}`]) };
    const r = await run([], env, stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_NOT_CONNECTED,
      "directory: not connected: CONTROL_PLANE_URL is not set; direct answered 403 via=direct\n"]);
    expect(stub.cpCalls()).toEqual([]);
  });

  test("neither key is printed on any fallback path", async () => {
    for (const [cp, direct] of [[404, 200], [404, 403], [401, 500], [409, 404]] as [number, number][]) {
      for (const argv of [[], ["--json"]]) {
        const r = await run(argv, connected(), stubBoth([cp, `Bearer ${KEY}`], [direct, direct === 200 ? GOOD : `Bearer ${KEY}`]).impl);
        expect(everything(r)).not.toContain(KEY);
        expect(everything(r)).not.toContain("Bearer");
      }
    }
  });
});

describe("security: the key never leaves for a host off the lists (commit review, 14 Oct)", () => {
  /** Settings with no popup, so the direct path has nothing to call either. */
  const noPopup = (over: Record<string, string>) => ({
    HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`, `EDGEOS_API_KEY=${KEY}`]), ...over,
  });

  test.each([
    ["a disallowed host", { CONTROL_PLANE_URL: "https://evil.example" }],
    ["a look-alike suffix", { CONTROL_PLANE_URL: "https://control-plane-production-606c.up.railway.app.evil.example" }],
    ["http", { CONTROL_PLANE_URL: "http://control-plane-production-606c.up.railway.app" }],
    ["userinfo", { CONTROL_PLANE_URL: "https://user:pass@control-plane-production-606c.up.railway.app" }],
    ["a non-UUID TENANT_ID", { TENANT_ID: "../../admin" }],
    ["a path-shaped TENANT_ID", { TENANT_ID: `${TENANT}/../x` }],
  ])("%s: exit 2 and no fetch at all", async (_name, over) => {
    const stub = stubBoth([200, GOOD], [200, GOOD]);
    const r = await run([], noPopup(over), stub.impl);
    expect([r.code, r.out]).toEqual([EXIT_NOT_CONNECTED, ""]);
    expect(stub.calls).toEqual([]);
    expect(everything(r)).not.toContain(KEY);
  });

  test("with a popup set, a refused control plane is never called; only the EdgeOS host is", async () => {
    for (const bad of ["https://evil.example", "http://control-plane-production-606c.up.railway.app",
      "https://u:p@control-plane-production-606c.up.railway.app"]) {
      const stub = stubBoth([200, GOOD], [403, {}]);
      const r = await run([], { ...connected(), CONTROL_PLANE_URL: bad }, stub.impl);
      expect(r.code).toBe(EXIT_NOT_CONNECTED);
      expect(stub.calls.length).toBe(1);
      expect(stub.calls[0].url.startsWith(`${EDGEOS}/applications/my/directory/`)).toBe(true);
    }
  });

  test("a disallowed EdgeOS base: no direct fetch", async () => {
    const stub = stubBoth([404, {}], [200, GOOD]);
    const r = await run([], { ...connected(), EDGEOS_API_BASE: "https://evil.example/api/v1" }, stub.impl);
    expect(r.code).toBe(EXIT_NOT_CONNECTED);
    expect(stub.directCalls()).toEqual([]);
    expect(stub.calls.every((c) => c.url.startsWith(CP))).toBe(true);
  });

  test("a 302 is not followed: redirect is manual, exit 1, one fetch, no fallback", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const redirecting = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    }) as unknown as typeof fetch;
    const r = await run([], connected(), redirecting);
    expect([r.code, r.out]).toEqual([EXIT_UNAVAILABLE, ""]);
    expect(r.err).toContain("302 (a redirect, not followed)");
    expect(calls.length).toBe(1);
    expect(calls[0].init.redirect).toBe("manual");
    expect(calls.some((c) => c.url.includes("evil.example"))).toBe(false);
  });

  test("a 302 on the direct path is not followed either", async () => {
    const stub = stubBoth([404, {}], [302, {}]);
    const r = await run([], connected(), stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, expect.stringContaining("direct answered 302 (a redirect, not followed) via=direct")]);
    expect(stub.directCalls()[0].init.redirect).toBe("manual");
  });

  test("no argument changes the host or the path; the key is only in the header", async () => {
    const stub = stubBoth([200, GOOD], [200, GOOD]);
    await run(["--search", "x/../../admin?y=1#z", "--popup", ESMERALDA], connected(), stub.impl);
    const url = new URL(stub.calls[0].url);
    expect(`${url.origin}${url.pathname}`).toBe(`${CP}/tenants/${TENANT}/edgeos/directory`);
    expect(url.searchParams.get("q")).toBe("x/../../admin?y=1#z");
    expect(url.hash).toBe("");
    expect(stub.calls[0].url).not.toContain(KEY);
    expect((stub.calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("associated attendees are projected too (refute S1)", () => {
  test("an extra key inside an associated item never reaches the output, on either path", async () => {
    const spouse = {
      id: "s1", first_name: "Ravi", last_name: "*", email: null, telegram: "ravi", role: null, organization: null,
      residence: null, age: null, gender: null, picture_url: null, category: "spouse",
      participation: [{ id: "t2", name: "Week 1", slug: "w1", category: "week", duration_type: "week", price: 300 }],
      phone: "+91 98765 43210", passport: "Z1234567", associated_attendees: [{ id: "deeper", phone: "+1 555" }],
    };
    const body = { results: [{ ...PRIYA, associated_attendees: [spouse] }], paging: { offset: 0, limit: 20, total: 1 } };
    const viaCp = await run(["--json"], connected(), stubBoth([200, body], [500, {}]).impl);
    const viaDirect = await run(["--json"], connected(), stubBoth([404, {}], [200, body]).impl);
    expect([viaCp.code, viaDirect.code]).toEqual([EXIT_OK, EXIT_OK]);
    expect(viaDirect.out).toBe(viaCp.out);
    for (const gone of ["phone", "passport", "98765", "Z1234567", "price", "deeper"]) expect(viaDirect.out).not.toContain(gone);
    const associated = JSON.parse(viaDirect.out).results[0].associated_attendees;
    expect(associated.length).toBe(1);
    expect(Object.keys(associated[0])).toEqual(FIELDS.filter((f) => f !== "associated_attendees"));
    expect(associated[0].last_name).toBe("*");
    expect(associated[0].participation).toEqual([{ id: "t2", name: "Week 1", slug: "w1", category: "week", duration_type: "week" }]);
    const lines = await run([], connected(), stubBoth([200, body], [500, {}]).impl);
    for (const gone of ["phone", "passport", "98765", "Z1234567"]) expect(lines.out).not.toContain(gone);
  });

  test("a non-array or junk associated_attendees is an empty list or empty rows", () => {
    expect(project({ results: [{ associated_attendees: "x" }] })!.results[0].associated_attendees).toEqual([]);
    const junk = project({ results: [{ associated_attendees: [null, 7] }] })!.results[0].associated_attendees as Record<string, unknown>[];
    expect(junk.length).toBe(2);
    for (const a of junk) expect(Object.values(a).every((v) => v === null || (Array.isArray(v) && v.length === 0))).toBe(true);
  });
});

describe("exit 4: the resident's sign-in to the app has lapsed (DATA-454b)", () => {
  const LAPSED = { error: "not_connected" };
  const RESTRICTED = { detail: "API keys are restricted to approved event automation routes" };
  const LINE = `directory: sign-in lapsed: ask the person to sign in to the Agent Village app once at ${SIGNIN_URL}, then try again`;

  test("cp 403 not_connected + direct 403 (EdgeOS today): exit 4 with the sign-in-once line, not exit 2", async () => {
    const stub = stubBoth([403, LAPSED], [403, RESTRICTED]);
    const r = await run(["--search", "Priya"], connected(), stub.impl);
    expect(stub.directCalls().length).toBe(1);
    expect([r.code, r.out]).toEqual([EXIT_SIGNIN, ""]);
    expect(EXIT_SIGNIN).toBe(4);
    expect(r.err).toBe(`${LINE} (cp 403 not_connected; direct answered 403) via=direct\n`);
    expect(r.err).not.toContain("API keys are restricted");
    expect(everything(r)).not.toContain(KEY);
  });

  test("cp 403 not_connected with no direct call possible (no popup): exit 4 via=cp", async () => {
    const stub = stubBoth([403, LAPSED], [200, GOOD]);
    const env = { HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`, `EDGEOS_API_KEY=${KEY}`]) };
    const r = await run([], env, stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_SIGNIN, `${LINE} (cp 403 not_connected) via=cp\n`]);
    expect(stub.directCalls()).toEqual([]);
  });

  test("cp 403 not_connected + direct 200: the rows, exit 0 via=direct", async () => {
    const r = await run([], connected(), stubBoth([403, LAPSED], [200, GOOD]).impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=direct\n"]);
  });

  test("cp 403 not_connected + direct 5xx: still exit 4", async () => {
    const r = await run([], connected(), stubBoth([403, LAPSED], [503, {}]).impl);
    expect(r.code).toBe(EXIT_SIGNIN);
  });

  test("not_connected is a known code now: a cp 404 not_connected is named, and stays exit 2", async () => {
    const r = await run([], connected(), stubBoth([404, LAPSED], [403, RESTRICTED]).impl);
    expect([r.code, r.err]).toEqual([EXIT_NOT_CONNECTED,
      "directory: not connected: cp answered 404 not_connected; direct answered 403 via=direct\n"]);
  });
});
