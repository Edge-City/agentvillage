/**
 * The welcome's seed creates directly on Index (lead's ruling, 13 Oct 2026
 * 06:03Z, after Seref: "if you're hitting /prepare you'll get rewritten. you
 * can just post directly to /intents"): one `POST <origin>/api/intents` per
 * line with `{description, sourceType: "agentvillage"}` and NO
 * `preparationReceipt`, so Index stores the resident's line as written and
 * skips admission (Index source a91c3ff, intent.service.ts create). No
 * `/api/intents/prepare`, no MCP `create_intent`. A non-2xx answer whose body
 * is Index's `intent_needs_revision` refusal still goes to ov#302's
 * ask-the-resident fallback (REFUSED_SEEDS); any other non-2xx, a timeout or
 * an unreachable Index is a failed line, never REFUSED_SEEDS. `--reseed`
 * takes the same path; `--reseed --dry-run` creates nothing and asks Index
 * nothing but the list.
 *
 *   bun test skills/index-network/scripts/tests/welcome-direct-seed.test.ts
 *
 * The request and answer shapes are fixtures/index-create-direct.json: from
 * Index's source, not observed live (a create is a production write).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as mcp from "../index-mcp";
import * as welcomeModule from "../welcome";
import { RESEED_FLAG, DRY_RUN_FLAG, SELECTED_HEADING, WELCOME_SEED_FILE, WELCOME_STATE_FILE, main, welcomeRun } from "../welcome";
import createFixture from "./fixtures/index-create-direct.json";
import golden from "./fixtures/welcome-texts.json";
import originFixture from "./fixtures/index-origin-plugin.json";
import { CREATE_CALL, type CreateReply, FAKE_API_KEY, FAKE_MCP_URL, type ToolReply, createdReply, indexMcpFake } from "./index-mcp-fake";

const CREATE_URL = "https://index-mcp.fake.test/api/intents";
const PREPARE_URL = "https://index-mcp.fake.test/api/intents/prepare";
/** The three lines welcome-texts.json's seeded texts were made from (welcome-seed.test.ts KEPT). */
const LINES = ["Looking for people building agent memory", "Hiring a founding engineer who loves Rust", "Want advice on raising a seed round in India"];
const idFor = (n: number) => `dddddddd-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const R = createFixture.responses;
const NEEDS_REVISION = createFixture.notInSource.needsRevision;

type DirectCreate =
  | { ok: true; id: string | null }
  | { ok: false; status: number; refusal: { refused: true; code: string; feedback: string | null; keys: string[] } | null; timedOut?: boolean; badUrl?: true };
/** `createIntentDirect` read off the module at call time, so a missing export fails each test, not the file. */
function createIntentDirect(target: mcp.IndexMcpTarget, description: string): Promise<DirectCreate> {
  const fn = (mcp as Record<string, unknown>).createIntentDirect;
  expect(typeof fn).toBe("function");
  return (fn as (t: mcp.IndexMcpTarget, d: string) => Promise<DirectCreate>)(target, description);
}

let home: string;
const saved: Record<string, string | undefined> = {};
const VARS = ["INDEX_API_KEY", "INDEX_MCP_URL", "INDEX_API_URL", "HERMES_HOME", "AV_WELCOME_SEED_MODE", "AV_SEED_TRAILER_V2", "AV_CONNECTIONS_URL"];
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-welcome-direct-"));
  for (const key of VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const key of VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function writeLines(lines: string[]): void {
  writeFileSync(
    join(home, "USER.md"),
    ["# Participant profile", "", "## Context supplied by the participant", "### Notes", "Some context.", "", SELECTED_HEADING, ...lines.map((l) => `- [meet] ${l}`), "", "## Follow-up preferences", ""].join("\n"),
  );
  writeFileSync(join(home, "av-profile.json"), JSON.stringify({ version: 1, nickname: "Mira", about_me: "", interests: [], preferences: {} }));
}

/**
 * A fake Index: list_intents over `rows`, the REST create (each line created
 * active, unless `create` answers otherwise for the nth create), pause_intent.
 * `urls`: every URL the client asked for, in order, the refused ones too.
 */
function fakeIndex(create?: (n: number, description: string, id: string) => CreateReply | undefined, initial: Array<{ id: string; summary: string; status: string }> = []) {
  const rows = initial.map((r) => ({ ...r }));
  const fake = indexMcpFake({
    tools: {
      list_intents: () => `Your signals:\n\n${JSON.stringify({ success: true, intents: rows, pagination: { limit: 20, offset: 0, count: rows.length } })}`,
      pause_intent: (args): ToolReply => {
        const row = rows.find((r) => r.id === args.intentId);
        if (!row) return { result: { content: [{ type: "text", text: "No such intent." }], isError: true } };
        row.status = "paused";
        return `Paused.\n\n${JSON.stringify({ success: true, data: { intentId: row.id, status: "paused", changed: true } })}`;
      },
    },
    create: (body, n) => {
      const description = String(body.description);
      const id = idFor(0x100 + n);
      const replaced = create?.(n, description, id);
      if (replaced !== undefined) return replaced;
      rows.push({ id, summary: description, status: "active" });
      return createdReply(id);
    },
  });
  const urls: string[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    return fake.fetch(url, init);
  }) as typeof globalThis.fetch;
  return { fake, fetch, urls, rows };
}

async function run(index: ReturnType<typeof fakeIndex>, argv: string[] = ["--draft"], timeoutMs = 200) {
  process.env.INDEX_API_KEY = FAKE_API_KEY;
  process.env.INDEX_MCP_URL = FAKE_MCP_URL;
  const out = await welcomeRun(["--home", home, ...argv], { fetch: index.fetch, timeoutMs });
  const calls = index.fake.calls.filter((c) => c.method === "tools/call" || c.method === "rest");
  return { ...out, calls, names: calls.map((c) => c.name), creates: calls.filter((c) => c.name === CREATE_CALL) };
}
async function trailer(index: ReturnType<typeof fakeIndex>, argv: string[] = ["--draft"]) {
  process.env.INDEX_API_KEY = FAKE_API_KEY;
  process.env.INDEX_MCP_URL = FAKE_MCP_URL;
  const out: string[] = [];
  const err: string[] = [];
  await main(["--home", home, ...argv], { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, (a) => welcomeRun(a, { fetch: index.fetch, timeoutMs: 200 }));
  return { stdout: out.join(""), stderr: err.join("") };
}
const marker = () => JSON.parse(readFileSync(join(home, WELCOME_SEED_FILE), "utf8"));

// ── createIntentDirect: the one request ──────────────────────────────────────

describe("createIntentDirect: one POST /api/intents, the overlay's REST shape", () => {
  const target = (fetch: typeof globalThis.fetch, timeoutMs = 200): mcp.IndexMcpTarget => ({ apiKey: FAKE_API_KEY, mcpUrl: FAKE_MCP_URL, fetch, timeoutMs });

  test("URL, method, header NAMES, body keys: description verbatim, sourceType agentvillage, no preparationReceipt; 2xx is the intent id", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Response.json(R.created.body, { status: 200 });
    }) as typeof globalThis.fetch;
    const line = "Wants to meet people working on climate tools  (Goa) 🌱 ";
    const out = await createIntentDirect(target(fetch), line);
    expect(out).toEqual({ ok: true, id: R.created.body.intentId });
    expect(seen).toHaveLength(1);
    const { url, init } = seen[0]!;
    expect(url).toBe(CREATE_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const names = [...new Headers(init.headers).keys()].sort();
    expect(names).toEqual(["accept", "content-type", "x-api-key"]);
    expect(new Headers(init.headers).get("x-api-key")).toBe(FAKE_API_KEY);
    const body = JSON.parse(String(init.body));
    expect(Object.keys(body).sort()).toEqual(["description", "sourceType"]);
    expect(body).toEqual({ description: line, sourceType: "agentvillage" });
    expect("preparationReceipt" in body).toBe(false);
    for (const key of Object.keys(body)) expect([...createFixture.request.body.required, ...createFixture.request.body.optional]).toContain(key);
  });

  test("$INDEX_API_URL (an origin, or <origin>/api) names the origin, as for the av-events plugin", async () => {
    for (const configured of ["https://api.example.test", "https://api.example.test/", "https://api.example.test/api"]) {
      process.env.INDEX_API_URL = configured;
      const seen: string[] = [];
      const fetch = (async (url: string | URL | Request) => {
        seen.push(String(url));
        return Response.json(R.created.body, { status: 201 });
      }) as typeof globalThis.fetch;
      expect(await createIntentDirect(target(fetch), "a line")).toMatchObject({ ok: true });
      expect(seen).toEqual(["https://api.example.test/api/intents"]);
    }
  });

  test("every non-2xx answer in Index's source is a plain failure with its status, never a refusal", async () => {
    for (const answer of [R.validation, R.unauthorized, R.membership, R.rejected, R.preparationFailed, R.serverError]) {
      const fetch = (async () => Response.json(answer.body, { status: answer.status })) as unknown as typeof globalThis.fetch;
      expect(await createIntentDirect(target(fetch), "a line")).toEqual({ ok: false, status: answer.status, refusal: null });
    }
    for (const status of [404, 429, 502]) {
      const fetch = (async () => new Response("<html>nope</html>", { status })) as unknown as typeof globalThis.fetch;
      expect(await createIntentDirect(target(fetch), "a line")).toEqual({ ok: false, status, refusal: null });
    }
  });

  test("a non-2xx whose body is Index's intent_needs_revision refusal: the refusal (code, feedback, key names), as intentRefusal reads it", async () => {
    const fetch = (async () => Response.json(NEEDS_REVISION.body, { status: NEEDS_REVISION.status })) as unknown as typeof globalThis.fetch;
    const out = await createIntentDirect(target(fetch), "Here to meet founders");
    expect(out).toEqual({
      ok: false,
      status: 422,
      refusal: { refused: true, code: "intent_needs_revision", feedback: NEEDS_REVISION.body.feedback, keys: Object.keys(NEEDS_REVISION.body) },
    });
  });

  test("a timeout, a transport failure and a redirect are status 0 (timedOut for the timeout); a redirect is never followed", async () => {
    const hang = (async (_url: unknown, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")), { once: true });
      })) as unknown as typeof globalThis.fetch;
    expect(await createIntentDirect(target(hang, 30), "a line")).toEqual({ ok: false, status: 0, refusal: null, timedOut: true });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    expect(await createIntentDirect(target(down), "a line")).toEqual({ ok: false, status: 0, refusal: null, timedOut: false });
    const index = fakeIndex(() => ({ response: new Response(null, { status: 307, headers: { location: "https://elsewhere.test/" } }) }));
    expect(await createIntentDirect(target(index.fetch), "a line")).toEqual({ ok: false, status: 0, refusal: null, timedOut: false });
    expect(index.fake.calls[0]?.followedRedirect).toBeUndefined();
  });

  test("a 2xx whose id is missing or not one Index issues, or whose body does not parse: created, id null", async () => {
    for (const res of [
      () => Response.json({ networkIds: [] }, { status: 200 }),
      () => Response.json({ intentId: "../../etc" }, { status: 200 }),
      () => new Response("not json", { status: 200 }),
      () => new Response(null, { status: 204 }),
    ]) {
      const fetch = (async () => res()) as unknown as typeof globalThis.fetch;
      expect(await createIntentDirect(target(fetch), "a line")).toEqual({ ok: true, id: null });
    }
  });
});

// ── The welcome's seed ───────────────────────────────────────────────────────

describe("the welcome's seed: direct creates, no prepare, no MCP create_intent", () => {
  test("three lines: list, three REST creates with the line verbatim, list; no /prepare; the seeded welcome and the trailer byte-identical", async () => {
    writeLines(LINES);
    process.env.AV_SEED_TRAILER_V2 = "1";
    const index = fakeIndex();
    const { text, branch, names, creates } = await run(index);
    expect(names).toEqual(["list_intents", CREATE_CALL, CREATE_CALL, CREATE_CALL, "list_intents"]);
    expect(creates.map((c) => c.arguments)).toEqual(LINES.map((description) => ({ description, sourceType: "agentvillage" })));
    expect(creates.every((c) => c.url === CREATE_URL && c.status === 200)).toBe(true);
    expect(index.urls).not.toContain(PREPARE_URL);
    expect(index.fake.calls.some((c) => c.name === "create_intent")).toBe(false);
    expect(text).toBe(golden.seededThree);
    expect(branch).toEqual({ fallback: "none", intents_listed: 3, intents_seeded: 3, seed_failed: 0 });
    expect(marker()).toMatchObject({ selected: 3, created: 3, failed: 0, done: true });
    expect(marker().refused).toBeUndefined();

    // The created case's trailer, byte for byte as before (no seed_codes: a created line leaves no code).
    rmSync(join(home, WELCOME_SEED_FILE));
    const again = fakeIndex();
    const { stdout, stderr } = await trailer(again);
    expect(stdout).toBe(`${golden.seededThree}\n`);
    expect(stderr).toBe('{"welcome":1,"fallback":"none","intents_listed":3,"intents_seeded":3,"seed_failed":0}\n');
  });

  test("a refusal non-2xx (intent_needs_revision): REFUSED_SEEDS entry with the resident's line, exactly as ov#302; the next run asks once", async () => {
    writeLines(LINES);
    process.env.AV_SEED_TRAILER_V2 = "1";
    const index = fakeIndex((n) => (n === 2 ? { status: NEEDS_REVISION.status, body: NEEDS_REVISION.body } : undefined));
    const { stderr } = await trailer(index);
    expect(JSON.parse(stderr)).toEqual({ welcome: 1, fallback: "none", intents_listed: 2, intents_seeded: 2, seed_failed: 1, seed_codes: ["intent_needs_revision"] });
    const m = marker();
    expect(m).toMatchObject({ created: 2, failed: 1, done: true });
    expect(m.refused).toHaveLength(1);
    expect(m.refused[0]).toMatchObject({ line: LINES[1], code: "intent_needs_revision", feedback: NEEDS_REVISION.body.feedback, keys: Object.keys(NEEDS_REVISION.body) });
    expect(m.refused[0].recovery).toBeUndefined();
    expect(m.refused[0].category).toBeUndefined();

    writeFileSync(join(home, WELCOME_STATE_FILE), JSON.stringify({ welcomeSent: true, sentAt: "2026-10-13T06:00:00.000Z" }));
    const first = await welcomeRun(["--home", home], { fetch: index.fetch });
    expect(first.text).toBe(`WELCOME_ALREADY_SENT\nREFUSED_SEEDS ${JSON.stringify([{ line: LINES[1], kind: null, question: null }])}`);
    expect((await welcomeRun(["--home", home], { fetch: index.fetch })).text).toBe("WELCOME_ALREADY_SENT");
  });

  test("a plain non-2xx (each of Index's), never REFUSED_SEEDS: failed, code create-http-<status>", async () => {
    for (const answer of [R.validation, R.unauthorized, R.rejected, R.preparationFailed, R.serverError]) {
      rmSync(join(home, WELCOME_SEED_FILE), { force: true });
      writeLines(LINES.slice(0, 1));
      process.env.AV_SEED_TRAILER_V2 = "1";
      const index = fakeIndex(() => ({ status: answer.status, body: answer.body }));
      const { stderr } = await trailer(index);
      expect({ status: answer.status, trailer: JSON.parse(stderr) }).toEqual({
        status: answer.status,
        trailer: { welcome: 1, fallback: "context", intents_listed: 0, intents_seeded: 0, seed_failed: 1, seed_codes: [`create-http-${answer.status}`] },
      });
      expect(marker()).toMatchObject({ created: 0, failed: 1, done: true });
      expect(marker().refused).toBeUndefined();
    }
  });

  test("a timeout and an unreachable Index: failed (create-timeout, create-unreachable), never REFUSED_SEEDS", async () => {
    writeLines(LINES.slice(0, 2));
    process.env.AV_SEED_TRAILER_V2 = "1";
    const index = fakeIndex((n) => (n === 1 ? { hang: true } : { response: new Response(null, { status: 302, headers: { location: "https://x.test/" } }) }));
    const { stderr } = await trailer(index);
    expect(JSON.parse(stderr)).toEqual({ welcome: 1, fallback: "context", intents_listed: 0, intents_seeded: 0, seed_failed: 2, seed_codes: ["create-timeout", "create-unreachable"] });
    expect(marker()).toMatchObject({ created: 0, failed: 2 });
    expect(marker().refused).toBeUndefined();
  });

  test("paused mode: each create, then pause_intent with the id Index's create answer names", async () => {
    writeLines(LINES);
    process.env.AV_WELCOME_SEED_MODE = "paused";
    const index = fakeIndex();
    const { text, names, calls } = await run(index);
    expect([...names].sort()).toEqual([CREATE_CALL, CREATE_CALL, CREATE_CALL, "list_intents", "list_intents", "pause_intent", "pause_intent", "pause_intent"].sort());
    expect(calls.filter((c) => c.name === "pause_intent").map((c) => c.arguments?.intentId).sort()).toEqual([0x101, 0x102, 0x103].map(idFor));
    expect(text).toBe(golden.seededPausedThree);
  });
});

// ── --reseed and --reseed --dry-run ──────────────────────────────────────────

describe("--reseed: the same direct path; --dry-run lists only and reports would_create", () => {
  test("--reseed: list, REST creates for the lines not listed, its own marker; no /prepare", async () => {
    writeLines(LINES);
    const index = fakeIndex(undefined, [{ id: idFor(1), summary: LINES[0], status: "paused" }]);
    const { stderr } = await trailer(index, [RESEED_FLAG]);
    expect(JSON.parse(stderr)).toMatchObject({ intents_seeded: 2, seed_failed: 0 });
    const creates = index.fake.calls.filter((c) => c.name === CREATE_CALL);
    expect(creates.map((c) => c.arguments)).toEqual(LINES.slice(1).map((description) => ({ description, sourceType: "agentvillage" })));
    expect(index.urls).not.toContain(PREPARE_URL);
    const files = readdirSync(join(home, "memory")).filter((f) => f.startsWith("welcome-reseed-") && f.endsWith(".json"));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, "memory", files[0]!), "utf8"))).toMatchObject({ selected: 3, created: 2, failed: 0, codes: [] });
  });

  test("--reseed --dry-run: one list and nothing else (no create, no prepare, no write); would_create per line", async () => {
    writeLines(LINES);
    const index = fakeIndex();
    const { stdout, stderr } = await trailer(index, [RESEED_FLAG, DRY_RUN_FLAG]);
    expect(stdout).toBe("");
    expect(index.urls).toEqual([FAKE_MCP_URL]);
    expect(index.fake.calls.map((c) => c.name)).toEqual(["list_intents"]);
    expect(JSON.parse(stderr)).toEqual({ welcome: 1, fallback: "questions", intents_listed: 0, intents_seeded: 0, seed_failed: 0, seed_codes: ["would_create", "would_create", "would_create"] });
    expect(existsSync(join(home, "memory"))).toBe(false);
    expect((welcomeModule as Record<string, unknown>).WOULD_CREATE).toBe("would_create");
  });

  test("--reseed: a refusal non-2xx is merged into the seed marker's refused list (gap G1); a plain one is not", async () => {
    writeLines(LINES.slice(0, 2));
    mkdirSync(join(home, "memory"), { recursive: true });
    const index = fakeIndex((n) => (n === 1 ? { status: NEEDS_REVISION.status, body: NEEDS_REVISION.body } : { status: 500, body: R.serverError.body }));
    const { stderr } = await trailer(index, [RESEED_FLAG]);
    expect(JSON.parse(stderr)).toMatchObject({ intents_seeded: 0, seed_failed: 2, seed_codes: ["intent_needs_revision", "create-http-500"] });
    expect(marker().refused.map((r: { line: string }) => r.line)).toEqual([LINES[0]]);
  });
});

// ── Fix round 2 (refute 57644408: S1, S2, N1) ────────────────────────────────

describe("S1: a 2xx that names no intent id is not created on its own word; the second list decides", () => {
  const html = () => ({ response: new Response("<html>ok</html>", { status: 200, headers: { "content-type": "text/html" } }) });

  test("probe A5: 200 text/html, nothing stored, the second list empty: a failed line (create-no-id), marker created 0, never 'this intent is active'; --reseed may send it again", async () => {
    writeLines(LINES.slice(0, 1));
    process.env.AV_SEED_TRAILER_V2 = "1";
    const index = fakeIndex(() => html());
    const { stdout, stderr } = await trailer(index);
    expect(JSON.parse(stderr)).toEqual({ welcome: 1, fallback: "context", intents_listed: 0, intents_seeded: 0, seed_failed: 1, seed_codes: ["create-no-id"] });
    expect(marker()).toMatchObject({ created: 0, failed: 1, done: true });
    expect(marker().refused).toBeUndefined();
    expect(stdout).not.toContain("this intent is active");
    expect(stdout).not.toContain(`- ${LINES[0]}`);
    expect(index.rows).toHaveLength(0);

    const err: string[] = [];
    await main(["--home", home, RESEED_FLAG], { stdout: () => {}, stderr: (s) => err.push(s) }, (a) => welcomeRun(a, { fetch: index.fetch, timeoutMs: 200 }));
    expect(JSON.parse(err.join(""))).toMatchObject({ intents_seeded: 0, seed_failed: 1, seed_codes: ["create-no-id"] });
    expect(index.fake.calls.filter((c) => c.name === CREATE_CALL).map((c) => c.arguments?.description)).toEqual([LINES[0], LINES[0]]);
  });

  test("a 200 with no id whose line the second list shows active: seeded, as a create that timed out but landed", async () => {
    writeLines(LINES.slice(0, 1));
    process.env.AV_SEED_TRAILER_V2 = "1";
    const index = fakeIndex((_n, description, id) => {
      index.rows.push({ id, summary: description, status: "active" });
      return { status: 200, body: {} };
    });
    const { stdout, stderr } = await trailer(index);
    expect(JSON.parse(stderr)).toEqual({ welcome: 1, fallback: "none", intents_listed: 1, intents_seeded: 1, seed_failed: 0, seed_codes: ["create-no-id"] });
    expect(marker()).toMatchObject({ created: 1, failed: 0, done: true });
    expect(stdout).toContain(`- ${LINES[0]}`);
  });

  test("a 200 with no id and the second list failing: failed, never counted on the create's word", async () => {
    writeLines(LINES.slice(0, 1));
    process.env.AV_SEED_TRAILER_V2 = "1";
    let lists = 0;
    const base = fakeIndex(() => html());
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url) === FAKE_MCP_URL && String(init?.body ?? "").includes('"list_intents"') && ++lists === 2) return new Response("down", { status: 503 });
      return base.fetch(url, init);
    }) as typeof globalThis.fetch;
    const { stderr } = await trailer({ ...base, fetch });
    expect(JSON.parse(stderr)).toMatchObject({ intents_seeded: 0, seed_failed: 1, seed_codes: ["create-no-id"] });
    expect(marker()).toMatchObject({ created: 0, failed: 1 });
  });
});

describe("S2: the create's origin passes the av-events plugin's _origin rule, or no request is made", () => {
  const indexCreateUrl = (mcpUrl: string): string | null => {
    const fn = (mcp as Record<string, unknown>).indexCreateUrl;
    expect(typeof fn).toBe("function");
    return (fn as (u: string) => string | null)(mcpUrl);
  };
  const counting = () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), key: new Headers(init?.headers).get("x-api-key") });
      return Response.json(R.created.body, { status: 200 });
    }) as typeof globalThis.fetch;
    return { seen, fetch };
  };
  /** Shapes the plugin's `_origin(url, ("", "/", "/api", "/api/"))` refuses (plugins/av-events/_record_intention.py :535-566). */
  const REJECTED_API_URLS = [
    "http://evil.example", // plain http off loopback: the key in plaintext
    "http://10.0.0.1/api",
    "https://user:pw@evil.example", // userinfo
    "https://@evil.example",
    "https://protocol.index.network?x=", // ? anywhere
    "https://protocol.index.network/api?x",
    "https://protocol.index.network#frag", // # anywhere
    "https://protocol.index.network/mcp", // a path beyond an optional /api
    "https://protocol.index.network/api/intents",
    "https://protocol.index.network//api",
    "protocol.index.network", // no scheme, no host
    "ftp://protocol.index.network",
    "https://",
    "https:///api",
    "https://evil example.test", // a space or control character inside
    "https://evil.example\t/api",
    "https://evil_host.example", // a host outside [A-Za-z0-9.-]
    "https://évil.example",
    "https://evil.example:99999", // a port that does not parse
    "https://evil.example:8o",
    "https://[::1", // a bracket that does not close
    "https://[not-v6]",
  ];

  test("indexOrigin agrees with the plugin's _origin on every vector of fixtures/index-origin-plugin.json (zone ids: stricter)", () => {
    const fn = (mcp as Record<string, unknown>).indexOrigin;
    expect(typeof fn).toBe("function");
    const indexOrigin = fn as (url: string, paths: readonly string[]) => string | null;
    const stricter = new Set(originFixture.stricter.urls);
    for (const { url, api, mcp: viaMcp } of originFixture.cases) {
      const want = stricter.has(url) ? { url, api: null, mcp: null } : { url, api, mcp: viaMcp };
      expect({ url, api: indexOrigin(url, ["", "/", "/api", "/api/"]), mcp: indexOrigin(url, ["/mcp", "/mcp/"]) }).toEqual(want);
    }
    expect(originFixture.cases.filter((c) => c.api !== null).length).toBeGreaterThan(20);
    expect(originFixture.cases.filter((c) => c.api === null).length).toBeGreaterThan(40);
  });

  test("each rejected $INDEX_API_URL shape: create-bad-url status 0, and the key never leaves (no request)", async () => {
    for (const configured of REJECTED_API_URLS) {
      process.env.INDEX_API_URL = configured;
      expect({ configured, url: indexCreateUrl(FAKE_MCP_URL) }).toEqual({ configured, url: null });
      const { seen, fetch } = counting();
      expect({ configured, out: await createIntentDirect({ apiKey: FAKE_API_KEY, mcpUrl: FAKE_MCP_URL, fetch, timeoutMs: 200 }, "a line") }).toEqual({
        configured,
        out: { ok: false, status: 0, refusal: null, badUrl: true },
      });
      expect({ configured, seen }).toEqual({ configured, seen: [] });
    }
  });

  test("accepted shapes, as the plugin accepts them: https, or http to a loopback host; an origin or <origin>/api; surrounding whitespace stripped", async () => {
    const cases: Array<[string, string]> = [
      ["https://api.example.test", "https://api.example.test/api/intents"],
      ["https://api.example.test/", "https://api.example.test/api/intents"],
      ["https://api.example.test/api", "https://api.example.test/api/intents"],
      ["https://api.example.test/api/", "https://api.example.test/api/intents"],
      ["https://api.example.test:8443/api", "https://api.example.test:8443/api/intents"],
      ["HTTPS://api.example.test", "https://api.example.test/api/intents"],
      ["  https://api.example.test/api\n", "https://api.example.test/api/intents"],
      ["http://localhost:8080", "http://localhost:8080/api/intents"],
      ["http://127.0.0.1:9/api", "http://127.0.0.1:9/api/intents"],
      ["http://[::1]:9", "http://[::1]:9/api/intents"],
    ];
    for (const [configured, url] of cases) {
      process.env.INDEX_API_URL = configured;
      expect({ configured, url: indexCreateUrl(FAKE_MCP_URL) }).toEqual({ configured, url });
    }
    process.env.INDEX_API_URL = "https://api.example.test/api";
    const { seen, fetch } = counting();
    expect(await createIntentDirect({ apiKey: FAKE_API_KEY, mcpUrl: FAKE_MCP_URL, fetch, timeoutMs: 200 }, "a line")).toEqual({ ok: true, id: R.created.body.intentId });
    expect(seen).toEqual([{ url: "https://api.example.test/api/intents", key: FAKE_API_KEY }]);
  });

  test("no $INDEX_API_URL (or a blank one): the MCP URL's origin, only when the MCP URL itself passes the rule with a /mcp path", async () => {
    process.env.INDEX_API_URL = "   ";
    expect(indexCreateUrl(FAKE_MCP_URL)).toBe(CREATE_URL);
    delete process.env.INDEX_API_URL;
    expect(indexCreateUrl("https://protocol.index.network/mcp")).toBe("https://protocol.index.network/api/intents");
    expect(indexCreateUrl("https://index-mcp.fake.test/mcp/")).toBe(CREATE_URL);
    expect(indexCreateUrl("http://127.0.0.1:4100/mcp")).toBe("http://127.0.0.1:4100/api/intents");
    for (const mcpUrl of ["http://evil.example/mcp", "https://evil.example/anything", "https://evil.example/mcp?x", "https://u:p@evil.example/mcp", "https://evil.example/mcp#f"]) {
      expect({ mcpUrl, url: indexCreateUrl(mcpUrl) }).toEqual({ mcpUrl, url: null });
      const { seen, fetch } = counting();
      expect(await createIntentDirect({ apiKey: FAKE_API_KEY, mcpUrl, fetch, timeoutMs: 200 }, "a line")).toEqual({ ok: false, status: 0, refusal: null, badUrl: true });
      expect(seen).toEqual([]);
    }
  });

  test("the welcome with a rejected $INDEX_API_URL: the lists go to the MCP URL, no create is sent anywhere, each line failed as create-bad-url", async () => {
    writeLines(LINES);
    process.env.AV_SEED_TRAILER_V2 = "1";
    process.env.INDEX_API_URL = "http://evil.example";
    const index = fakeIndex();
    const { stderr } = await trailer(index);
    expect(index.urls).toEqual([FAKE_MCP_URL, FAKE_MCP_URL]);
    expect(index.fake.calls.map((c) => c.name)).toEqual(["list_intents", "list_intents"]);
    expect(JSON.parse(stderr)).toEqual({
      welcome: 1,
      fallback: "context",
      intents_listed: 0,
      intents_seeded: 0,
      seed_failed: 3,
      seed_codes: ["create-bad-url", "create-bad-url", "create-bad-url"],
    });
    expect(marker()).toMatchObject({ created: 0, failed: 3, done: true });
    expect(marker().refused).toBeUndefined();
  });
});

describe("N1: --reseed never sends a line the seed marker kept cut", () => {
  const seedMarkerWith = (lines: string[]) => {
    mkdirSync(join(home, "memory"), { recursive: true });
    const refused = lines.map((line) => ({ line, feedback: null, code: "intent_needs_revision", at: "2026-10-12T00:00:00.000Z", keys: [] }));
    writeFileSync(join(home, WELCOME_SEED_FILE), `${JSON.stringify({ seededAt: "2026-10-12T00:00:00.000Z", selected: lines.length, created: 0, failed: lines.length, done: true, refused })}\n`);
  };
  const reseedFiles = () => (existsSync(join(home, "memory")) ? readdirSync(join(home, "memory")).filter((f) => f.startsWith("welcome-reseed-") && f.endsWith(".json")) : []);

  test("probe V4: the only refused line is cut (295 code points kept as 200 ending in …): nothing is sent, reseed-cut-line, said in the run record", async () => {
    const long = "Looking for collaborators " + "on open climate data tooling ".repeat(9) + "and more";
    const kept = welcomeModule.refusedLine(long)!;
    expect(kept.endsWith("…")).toBe(true);
    writeLines([]);
    seedMarkerWith([kept]);
    const index = fakeIndex();
    const { stderr } = await trailer(index, [RESEED_FLAG]);
    expect(index.fake.calls.filter((c) => c.name === CREATE_CALL)).toEqual([]);
    expect(JSON.parse(stderr).seed_codes).toContain("reseed-cut-line");
    expect(JSON.parse(stderr)).toMatchObject({ intents_seeded: 0, seed_failed: 0 });
    const files = reseedFiles();
    expect(files).toHaveLength(1);
    const record = JSON.parse(readFileSync(join(home, "memory", files[0]!), "utf8"));
    expect(record).toMatchObject({ created: 0, failed: 0, cutSkipped: 1 });
    expect(record.codes).toEqual(["reseed-cut-line"]);
    // Nothing was sent, so the run-once guard is not spent.
    expect(welcomeModule.reseedRan(home)).toBe(false);
  });

  test("a cut line and a whole one: only the whole one is sent, verbatim; the cut one is named in the trailer and the run record", async () => {
    const whole = "Want advice on raising a seed round";
    const cut = welcomeModule.refusedLine("Hiring a founding engineer " + "who loves Rust and distributed systems ".repeat(8))!;
    writeLines([]);
    seedMarkerWith([cut, whole]);
    const index = fakeIndex();
    const { stderr } = await trailer(index, [RESEED_FLAG]);
    expect(index.fake.calls.filter((c) => c.name === CREATE_CALL).map((c) => c.arguments?.description)).toEqual([whole]);
    expect(JSON.parse(stderr)).toMatchObject({ intents_seeded: 1, seed_failed: 0, seed_codes: ["reseed-cut-line"] });
    const files = reseedFiles();
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, "memory", files[0]!), "utf8"))).toMatchObject({ created: 1, failed: 0, cutSkipped: 1, codes: ["reseed-cut-line"] });
  });

  test("a stored line longer than REFUSED_LINE_MAX is never sent either; --dry-run names the cut line and writes nothing", async () => {
    const over = "x".repeat(welcomeModule.REFUSED_LINE_MAX + 5);
    writeLines([]);
    seedMarkerWith([over]);
    const index = fakeIndex();
    const { stderr } = await trailer(index, [RESEED_FLAG, DRY_RUN_FLAG]);
    expect(index.fake.calls).toEqual([]);
    expect(JSON.parse(stderr).seed_codes).toContain("reseed-cut-line");
    expect(reseedFiles()).toEqual([]);
    const real = await trailer(index, [RESEED_FLAG]);
    expect(index.fake.calls.filter((c) => c.name === CREATE_CALL)).toEqual([]);
    expect(JSON.parse(real.stderr).seed_codes).toContain("reseed-cut-line");
  });
});
