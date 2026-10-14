/**
 * The profile script (skills/edgeos/scripts/profile.ts, DATA-454b): the settings read from the
 * environment or $HERMES_HOME/.env, the call to the control plane, the direct EdgeOS fallback, the
 * fail-soft exit codes (exit 4 for a lapsed sign-in) against stub servers, the eight-field projection
 * and the printed lines. fetch is injected; nothing leaves the machine. Every key here is the
 * placeholder `example-not-a-key`.
 *
 *   bun test skills/edgeos/scripts/tests/profile.test.ts
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXIT_NOT_CONNECTED, EXIT_OK, EXIT_SIGNIN, EXIT_UNAVAILABLE, EXIT_USAGE, SIGNIN_URL } from "../directory";
import { PROFILE_FIELDS, parseArgs, profileLines, projectProfile, run } from "../profile";

const KEY = "example-not-a-key";
const SESSION = "example-not-a-session-token";
const TENANT = "3f2e1d0c-9b8a-4c7d-8e6f-5a4b3c2d1e0f";
const CP = "https://control-plane-production-606c.up.railway.app";
const EDGEOS = "https://api.edgeos.world/api/v1";

function home(lines: string[] = []): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeos-profile-"));
  writeFileSync(join(dir, ".env"), lines.join("\n") + "\n");
  return dir;
}

const connected = (extra: string[] = []) => ({
  HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`, `export EDGEOS_API_KEY="${KEY}"`, ...extra]),
});

const ME = {
  first_name: "Priya",
  last_name: "Shah",
  email: "priya@example.com",
  telegram: "priyash",
  gender: null,
  age: 34,
  residence: "Goa",
  picture_url: "https://img.example/p.png",
};
/** What EdgeOS's /humans/me answers today: more than the eight fields. */
const RAW = {
  id: "0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
  tenant_id: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  ...ME,
  enriched_profile: { bio: "private bio" },
  application_answers: "should never be printed",
};
const LAPSED = { error: "not_connected" };
const RESTRICTED = { detail: "API keys are restricted to approved event automation routes" };

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

const everything = (r: { out: string; err: string }) => r.out + r.err;
const header = (init: RequestInit) => (init.headers as Record<string, string>).Authorization;

describe("arguments", () => {
  test("--json or nothing; anything else is a usage error (exit 3) and calls nothing", async () => {
    expect(parseArgs([])).toEqual({ json: false });
    expect(parseArgs(["--json"])).toEqual({ json: true });
    for (const argv of [["--edit"], ["--first-name", "x"], ["--token", SESSION], ["me"]]) {
      const stub = stubBoth([200, RAW], [200, RAW]);
      const r = await run(argv, connected(), stub.impl);
      expect([r.code, r.out]).toEqual([EXIT_USAGE, ""]);
      expect(r.err).toContain("usage: bun skills/edgeos/scripts/profile.ts [--json]");
      expect(stub.calls).toEqual([]);
    }
  });
});

describe("the control plane first", () => {
  test("one GET to the tenant's profile route, the key only in the header, no query; exit 0 via=cp", async () => {
    const stub = stubBoth([200, ME], [200, RAW]);
    const r = await run([], connected(), stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=cp\n"]);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe(`${CP}/tenants/${TENANT}/edgeos/profile`);
    expect(stub.calls[0].init.method).toBe("GET");
    expect(stub.calls[0].init.redirect).toBe("manual");
    expect(stub.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect(header(stub.calls[0].init)).toBe(`Bearer ${KEY}`);
    expect(stub.directCalls()).toEqual([]);
  });

  test("lines: the name, then each filled-in field; null and empty fields are left out", async () => {
    const r = await run([], connected(), stubBoth([200, ME], [500, {}]).impl);
    expect(r.out).toBe(
      "name: Priya Shah\nemail: priya@example.com\ntelegram: priyash\nage: 34\nresidence: Goa\npicture: https://img.example/p.png\n",
    );
    expect(profileLines(projectProfile({})!)).toBe("name: (none)\n");
  });

  test("--json prints the eight fields only, in order", async () => {
    const r = await run(["--json"], connected(), stubBoth([200, RAW], [500, {}]).impl);
    expect(r.code).toBe(EXIT_OK);
    const profile = JSON.parse(r.out);
    expect(Object.keys(profile)).toEqual([...PROFILE_FIELDS]);
    expect(profile).toEqual(ME);
    for (const gone of ["0b1c2d3e", "1c2d3e4f", "enriched", "private bio", "application_answers"]) expect(r.out).not.toContain(gone);
  });

  test("projection: a non-scalar where a value belongs is null; anything but one object is not a profile", () => {
    expect(PROFILE_FIELDS).toEqual(["first_name", "last_name", "email", "telegram", "gender", "age", "residence", "picture_url"]);
    expect(projectProfile({ first_name: { x: "leak" }, age: [1], email: Infinity, telegram: false })).toEqual({
      first_name: null, last_name: null, email: null, telegram: false, gender: null, age: null, residence: null, picture_url: null,
    });
    for (const body of [null, [], [ME], "me", 5]) expect(projectProfile(body)).toBeNull();
  });

  test("a 200 that is not one object exits 1", async () => {
    for (const body of ["<html>proxy</html>", [ME], null]) {
      const r = await run([], connected(), stubBoth([200, body], [200, RAW]).impl);
      expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, "profile: can't reach the profile right now: cp the answer was not a profile via=cp\n"]);
    }
  });
});

describe("exit 4: the sign-in to the app has lapsed", () => {
  test("cp 403 not_connected + direct 403 (EdgeOS today): exit 4, the sign-in-once line, never a body", async () => {
    const stub = stubBoth([403, LAPSED], [403, RESTRICTED]);
    const r = await run([], connected(), stub.impl);
    expect(stub.cpCalls().length).toBe(1);
    expect(stub.directCalls().length).toBe(1);
    expect([r.code, r.out]).toEqual([EXIT_SIGNIN, ""]);
    expect(EXIT_SIGNIN).toBe(4);
    expect(r.err).toBe(
      `profile: sign-in lapsed: ask the person to sign in to the Agent Village app once at ${SIGNIN_URL}, ` +
        "then try again (cp 403 not_connected; direct answered 403) via=direct\n",
    );
    expect(SIGNIN_URL).toBe("https://agents.edgecity.live/signin");
    expect(r.err).not.toContain("API keys are restricted");
  });

  test("cp 403 not_connected with no direct call possible: exit 4 via=cp", async () => {
    const stub = stubBoth([403, LAPSED], [200, RAW]);
    const r = await run([], { ...connected(), EDGEOS_API_BASE: "https://collector.example/api/v1" }, stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_SIGNIN,
      `profile: sign-in lapsed: ask the person to sign in to the Agent Village app once at ${SIGNIN_URL}, then try again (cp 403 not_connected) via=cp\n`]);
    expect(stub.directCalls()).toEqual([]);
  });

  test.each([[500, EXIT_SIGNIN], [429, EXIT_SIGNIN], [404, EXIT_SIGNIN], [401, EXIT_SIGNIN]])(
    "cp 403 not_connected + direct %i: still exit 4 (the cp's reason is the one to act on)", async (status, code) => {
      const r = await run([], connected(), stubBoth([403, LAPSED], [status, {}]).impl);
      expect(r.code).toBe(code);
      expect(r.err).toEndWith(" via=direct\n");
    });

  test("cp 403 not_connected + direct 200: exit 0 via=direct", async () => {
    const r = await run([], connected(), stubBoth([403, LAPSED], [200, RAW]).impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=direct\n"]);
    expect(r.out).toBe(profileLines(ME));
  });

  test("only a cp 403 with the code not_connected is exit 4; any other 401/403/404/409 is exit 2", async () => {
    for (const [status, body] of [[403, { error: "profile_forbidden" }], [403, {}], [401, { error: "unauthorized" }],
      [404, { error: "not_linked" }], [404, { error: "not found" }], [404, LAPSED], [409, {}]] as [number, unknown][]) {
      const r = await run([], connected(), stubBoth([status, body], [403, RESTRICTED]).impl);
      expect([r.code, r.out], `${status} ${JSON.stringify(body)}`).toEqual([EXIT_NOT_CONNECTED, ""]);
      expect(r.err).toStartWith("profile: not connected: cp answered ");
      expect(r.err).toEndWith("direct answered 403 via=direct\n");
    }
  });

  test("a 403 not_connected from EdgeOS itself (direct only) is exit 2, not 4", async () => {
    const r = await run([], connected(), stubBoth([404, {}], [403, LAPSED]).impl);
    expect(r.code).toBe(EXIT_NOT_CONNECTED);
  });
});

describe("not connected: exit 2", () => {
  test("cp 404 (route not deployed) + direct 403: exit 2, both answers named, never a body", async () => {
    const stub = stubBoth([404, { error: "not found" }], [403, RESTRICTED]);
    const r = await run([], connected(), stub.impl);
    expect([r.code, r.out]).toEqual([EXIT_NOT_CONNECTED, ""]);
    expect(r.err).toBe("profile: not connected: cp answered 404 not found; direct answered 403 via=direct\n");
  });

  test("each missing setting says which, never a value", async () => {
    const stub = stubBoth([200, ME], [403, RESTRICTED]);
    const cases: [string[], string][] = [
      [[`TENANT_ID=${TENANT}`, `EDGEOS_API_KEY=${KEY}`], "CONTROL_PLANE_URL is not set"],
      [[`CONTROL_PLANE_URL=${CP}`, `EDGEOS_API_KEY=${KEY}`], "TENANT_ID is not set"],
      [[`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`], "EDGEOS_API_KEY is not set"],
    ];
    for (const [lines, message] of cases) {
      const r = await run([], { HERMES_HOME: home(lines) }, stub.impl);
      expect([r.code, r.out]).toEqual([EXIT_NOT_CONNECTED, ""]);
      expect(r.err).toContain(message);
      expect(everything(r)).not.toContain(KEY);
    }
    expect(stub.cpCalls()).toEqual([]);
  });

  test("no key: no call at all", async () => {
    const stub = stubBoth([200, ME], [200, RAW]);
    const r = await run([], { HERMES_HOME: home([`CONTROL_PLANE_URL=${CP}`, `TENANT_ID=${TENANT}`]) }, stub.impl);
    expect(r.code).toBe(EXIT_NOT_CONNECTED);
    expect(stub.calls).toEqual([]);
  });
});

describe("can't reach it right now: exit 1", () => {
  test.each([429, 500, 502, 503, 504])("cp %i: exit 1, no direct call", async (status) => {
    const stub = stubBoth([status, { error: "profile_unavailable" }], [200, RAW]);
    const r = await run([], connected(), stub.impl);
    expect(stub.calls.length).toBe(1);
    expect([r.code, r.out]).toEqual([EXIT_UNAVAILABLE, ""]);
    expect(r.err).toStartWith(`profile: can't reach the profile right now: cp ${status === 429 ? "busy (" : "answered "}${status}`);
    expect(r.err).toEndWith(" via=cp\n");
  });

  test("a network error or a timeout: exit 1, no direct call", async () => {
    const calls: string[] = [];
    const down = (async (url: string) => {
      calls.push(url);
      throw new TypeError(`fetch failed for Bearer ${KEY}`);
    }) as unknown as typeof fetch;
    const r = await run([], connected(), down);
    expect([r.code, r.err]).toEqual([EXIT_UNAVAILABLE, "profile: can't reach the profile right now: cp network error (TypeError) via=cp\n"]);
    expect(calls.length).toBe(1);
    const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(init.signal!.reason));
    })) as unknown as typeof fetch;
    const t = await run([], connected(), hang, { timeoutMs: 50 });
    expect([t.code, t.err]).toEqual([EXIT_UNAVAILABLE, "profile: can't reach the profile right now: cp timed out via=cp\n"]);
  });

  test("a 302 is not followed: exit 1, one fetch", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const redirecting = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(null, { status: 302, headers: { location: "https://evil.example/steal" } });
    }) as unknown as typeof fetch;
    const r = await run([], connected(), redirecting);
    expect(r.code).toBe(EXIT_UNAVAILABLE);
    expect(r.err).toContain("302 (a redirect, not followed)");
    expect(calls.length).toBe(1);
    expect(calls[0].init.redirect).toBe("manual");
  });
});

describe("the direct EdgeOS fallback", () => {
  test("cp 404 + direct 200: EdgeOS's own /humans/me with the API key; the same eight fields as via the cp", async () => {
    const stub = stubBoth([404, { error: "not found" }], [200, RAW]);
    const r = await run(["--json"], connected(), stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_OK, "via=direct\n"]);
    expect(stub.directCalls().length).toBe(1);
    const call = stub.directCalls()[0];
    expect(call.url).toBe(`${EDGEOS}/humans/me`);
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("manual");
    expect(header(call.init)).toBe(`Bearer ${KEY}`);
    const viaCp = await run(["--json"], connected(), stubBoth([200, RAW], [500, {}]).impl);
    expect(r.out).toBe(viaCp.out);
  });

  test("a key-only box (no control plane settings) tries the direct path", async () => {
    const stub = stubBoth([200, ME], [403, RESTRICTED]);
    const r = await run([], { HERMES_HOME: home([`EDGEOS_API_KEY=${KEY}`]) }, stub.impl);
    expect([r.code, r.err]).toEqual([EXIT_NOT_CONNECTED, "profile: not connected: CONTROL_PLANE_URL is not set; direct answered 403 via=direct\n"]);
    expect(stub.cpCalls()).toEqual([]);
  });

  test("the key goes direct only to the EdgeOS base", async () => {
    for (const bad of ["https://collector.example/api/v1", "http://api.edgeos.world/api/v1", "https://api.edgeos.world/api/v2"]) {
      const stub = stubBoth([404, {}], [200, RAW]);
      const r = await run([], { ...connected(), EDGEOS_API_BASE: bad }, stub.impl);
      expect([r.code, r.err]).toEqual([EXIT_NOT_CONNECTED,
        "profile: not connected: cp answered 404; EDGEOS_API_BASE is not https://api.edgeos.world/api/v1, so no direct call via=cp\n"]);
      expect(stub.calls.every((c) => c.url.startsWith(CP))).toBe(true);
    }
  });
});

describe("security", () => {
  test.each([
    ["a disallowed host", { CONTROL_PLANE_URL: "https://evil.example" }],
    ["a look-alike suffix", { CONTROL_PLANE_URL: "https://control-plane-production-606c.up.railway.app.evil.example" }],
    ["http", { CONTROL_PLANE_URL: "http://control-plane-production-606c.up.railway.app" }],
    ["userinfo", { CONTROL_PLANE_URL: "https://user:pass@control-plane-production-606c.up.railway.app" }],
    ["a non-UUID TENANT_ID", { TENANT_ID: "../../admin" }],
  ])("%s: the control plane is never called; only the EdgeOS host is", async (_name, over) => {
    const stub = stubBoth([200, ME], [403, RESTRICTED]);
    const r = await run([], { ...connected(), ...over }, stub.impl);
    expect(r.code).toBe(EXIT_NOT_CONNECTED);
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0].url).toBe(`${EDGEOS}/humans/me`);
  });

  test("the session token is never read or sent, even when it is set (the bearer path is gone)", async () => {
    const stub = stubBoth([404, {}], [401, {}]);
    const env = { ...connected([`EDGEOS_BEARER_TOKEN=${SESSION}`]), EDGEOS_BEARER_TOKEN: SESSION };
    const r = await run([], env, stub.impl);
    expect(r.code).toBe(EXIT_NOT_CONNECTED);
    for (const call of stub.calls) {
      expect(header(call.init)).toBe(`Bearer ${KEY}`);
      expect(JSON.stringify(call)).not.toContain(SESSION);
    }
    expect(everything(r)).not.toContain(SESSION);
    const source = readFileSync(join(import.meta.dir, "..", "profile.ts"), "utf8");
    expect(source).not.toContain("BEARER_TOKEN");
    expect(source).not.toMatch(/method:\s*"(PATCH|POST|PUT|DELETE)"/);
  });

  test("no key, no session token and no Authorization header on any exit path", async () => {
    const paths: [[number, unknown], [number, unknown]][] = [
      [[200, RAW], [500, {}]], [[403, LAPSED], [403, `Bearer ${KEY}`]], [[404, {}], [200, RAW]], [[401, {}], [500, {}]],
      [[503, `Bearer ${KEY}`], [200, RAW]], [[409, {}], [404, {}]],
    ];
    for (const [cp, direct] of paths) {
      for (const argv of [[], ["--json"]]) {
        const r = await run(argv, connected(), stubBoth(cp, direct).impl);
        expect(everything(r)).not.toContain(KEY);
        expect(everything(r)).not.toContain("Authorization");
        expect(everything(r)).not.toContain("Bearer");
      }
    }
  });
});
