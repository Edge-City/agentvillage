// The reference app-server half of Edge City Volunteers (app-server.ts), against a fake fetch: no network.
//   bun test docs/reference/eci-volunteers/app-server.test.ts
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CODES, CONFIRM_TTL_MS, createEciVolunteersBridge, loadManifest, matches, memoryStore } from "./app-server";

const BASE = "https://edge-city-volunteers.vercel.app/api/mcp";
const SLOT = "3f2b8c1e-5d4a-4b6f-9e2d-1a2b3c4d5e6f";
const TURN1 = "6c1f8a0e-1d2b-5c3d-8e4f-0a1b2c3d4e5f";
const TURN2 = "7d2a9b1f-2e3c-5d4e-9f5a-1b2c3d4e5f60";
const CODE = "v1." + "A".repeat(40);
const OWNER = 123456789;

type Call = { url: string; headers: Record<string, string>; body: any };
/** A fake ECV: answers initialize and the notification, then `tool(name, args)` for tools/call. */
function fakeEcv(tool: (name: string, args: any, call: Call) => Response | object, opts: { init?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
    const body = JSON.parse(String(init.body));
    const call = { url, headers, body };
    calls.push(call);
    if (body.method === "initialize") return opts.init ? opts.init() : Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "ecv", version: "0.45.0" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const answer = tool(body.params.name, body.params.arguments, call);
    return answer instanceof Response ? answer : Response.json({ jsonrpc: "2.0", id: body.id, result: answer });
  }) as unknown as typeof fetch;
  return { fetch, calls };
}
const textResult = (text: string, structured?: object, isError = false) =>
  ({ content: [{ type: "text", text }], ...(structured ? { structuredContent: structured } : {}), isError });
function bridge(fetch: typeof globalThis.fetch, clock = { t: 1_000_000 }) {
  const logs: string[] = [];
  const store = memoryStore(() => clock.t);
  const b = createEciVolunteersBridge({ token: "test-token", fetch, store, now: () => clock.t, log: event => logs.push(event) });
  return { ...b, store, logs, clock };
}

test("the bridge serves exactly the manifest's eleven operations", () => {
  const { fetch } = fakeEcv(() => textResult(""));
  expect(bridge(fetch).operations).toEqual(loadManifest().operations.map((op: { name: string }) => op.name));
  expect(bridge(fetch).operations.length).toBe(11);
});

test("a read: MCP initialize, initialized, tools/call with the token and the owner's id; the result shape", async () => {
  const { fetch, calls } = fakeEcv((name, args) => {
    expect([name, args]).toEqual(["eciv_my_shifts", { limit: 5 }]);
    return { content: [{ type: "text", text: "Now: Tue 20 Oct, 15:40 IST" }, { type: "image", data: "x" }, { type: "text", text: "| Wed | 09:00 | Kitchen |" }], structuredContent: { upcoming: [] } };
  });
  const b = bridge(fetch);
  const answer = await b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.my_shifts", arguments: { limit: 5 } });
  expect(answer).toEqual({ status: 200, body: { text: "Now: Tue 20 Oct, 15:40 IST\n\n| Wed | 09:00 | Kitchen |", structured: { upcoming: [] }, isError: false } });
  expect(calls.map(c => c.body.method)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  expect(calls[0]!.body.params).toEqual({ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-village", version: "1.0.0" } });
  for (const c of calls) {
    expect(c.url).toBe(BASE);
    expect(c.headers.Authorization).toBe("Bearer test-token");
    expect(c.headers["X-Agent-Village-Telegram-User-Id"]).toBe(String(OWNER));
    expect(c.headers.Accept).toBe("application/json, text/event-stream");
    expect(c.headers["Content-Type"]).toBe("application/json");
    expect(c.headers).not.toHaveProperty("X-Agent-Village-Telegram-Username");
    expect(c.headers).not.toHaveProperty("Mcp-Session-Id");
  }
});

test("the username header is sent only when given (without @), and a session id is carried when ECV returns one", async () => {
  const { fetch, calls } = fakeEcv(() => textResult("ok"), {
    init: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { headers: { "content-type": "application/json", "mcp-session-id": "s-1" } }),
  });
  const b = bridge(fetch);
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: "@Asha_K", operation: "eci-volunteers.initialize" });
  expect(calls.map(c => c.headers["X-Agent-Village-Telegram-Username"])).toEqual(["Asha_K", "Asha_K", "Asha_K"]);
  expect(calls.map(c => c.headers["Mcp-Session-Id"])).toEqual([undefined, "s-1", "s-1"]);
  calls.length = 0;
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: null, operation: "eci-volunteers.initialize" });
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: "bad name!", operation: "eci-volunteers.initialize" });
  expect(calls.every(c => !("X-Agent-Village-Telegram-Username" in c.headers))).toBe(true);
  expect(b.logs).toContain("username_malformed_not_sent");
});

test("propose, then confirm in a later turn: the change is made; a retry of that confirm still reaches ECV", async () => {
  const { fetch, calls } = fakeEcv(name => name === "eciv_propose" ? textResult("Open your Wed shift for cover", { code: CODE, summary: "Open your Wed shift" }) : textResult("Done", { ok: true }));
  const b = bridge(fetch);
  const propose = await b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.propose", arguments: { action: "ask_cover", params: { slot_id: SLOT } }, turnId: TURN1 });
  expect(propose.status).toBe(200);
  // Only the hash of the code is stored, with who and when.
  expect(b.store.get(createHash("sha256").update(CODE).digest("hex"))).toEqual({ owner: String(OWNER), turnId: TURN1, expiresAt: 1_000_000 + CONFIRM_TTL_MS });
  const confirm = { ownerTelegramId: OWNER, operation: "eci-volunteers.confirm", arguments: { code: CODE }, turnId: TURN2 };
  expect(await b.handle(confirm)).toEqual({ status: 200, body: { text: "Done", structured: { ok: true }, isError: false } });
  // Kept until expiry (ECV's confirm is idempotent), so a retry learns the real outcome.
  expect((await b.handle(confirm)).status).toBe(200);
  expect(calls.filter(c => c.body.method === "tools/call").map(c => c.body.params)).toEqual([
    { name: "eciv_propose", arguments: { action: "ask_cover", params: { slot_id: SLOT } } },
    { name: "eciv_confirm", arguments: { code: CODE } },
    { name: "eciv_confirm", arguments: { code: CODE } },
  ]);
});

test("confirm is refused with conflict (before any fetch) in the propose's turn, for another owner, after expiry, or for an unknown code", async () => {
  const { fetch, calls } = fakeEcv(() => textResult("proposed", { code: CODE }));
  const b = bridge(fetch);
  await b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.propose", arguments: { action: "set_extra_hours", params: { on: true } }, turnId: TURN1 });
  const before = calls.length;
  const confirm = (over: object) => b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.confirm", arguments: { code: CODE }, turnId: TURN2, ...over });
  expect(await confirm({ turnId: TURN1 })).toEqual({ status: 409, body: { code: "conflict" } });
  expect(await confirm({ ownerTelegramId: 987654321 })).toEqual({ status: 409, body: { code: "conflict" } });
  expect(await confirm({ arguments: { code: "v1." + "B".repeat(40) } })).toEqual({ status: 409, body: { code: "conflict" } });
  b.clock.t += CONFIRM_TTL_MS;
  expect(await confirm({})).toEqual({ status: 409, body: { code: "conflict" } });
  expect(calls.length).toBe(before);
});

test("a propose ECV blocks (isError, or no code) stores nothing", async () => {
  let answer: object = textResult("REFUSED (locked): the draw ran", { code: CODE }, true);
  const { fetch } = fakeEcv(() => answer);
  const b = bridge(fetch);
  const propose = () => b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.propose", arguments: { action: "set_extra_hours", params: { on: true } }, turnId: TURN1 });
  expect((await propose()).body).toMatchObject({ isError: true });
  answer = textResult("blocked", { code: null });
  await propose();
  expect(b.store.size()).toBe(0);
});

test("ECV's refusals before MCP map to the generic codes; 401 is a config error shown as unavailable", async () => {
  const cases: [Response, string][] = [
    [Response.json({ code: "not_authorized", detail: "bad token" }, { status: 401 }), "unavailable"],
    [Response.json({ code: "not_connected", detail: "unknown telegram user" }, { status: 403 }), "not_connected"],
    [Response.json({ code: "not_found", detail: "no volunteer" }, { status: 404 }), "not_found"],
    [Response.json({ code: "not_authorized", detail: "withdrawn" }, { status: 403 }), "not_authorized"],
    [Response.json({ code: "unavailable", detail: "MCP is off" }, { status: 503 }), "unavailable"],
    [Response.json({ code: "something_else" }, { status: 403 }), "connection_or_request_refused"],
    [new Response("<html>", { status: 500 }), "connection_or_request_refused"],
  ];
  for (const [response, code] of cases) {
    const { fetch } = fakeEcv(() => textResult("never"), { init: () => response });
    const b = bridge(fetch);
    const answer = await b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.my_hours" });
    expect([response.status, answer]).toEqual([response.status, { status: CODES[code as keyof typeof CODES], body: { code } }]);
    // No upstream wording reaches the box.
    expect(JSON.stringify(answer)).not.toContain("detail");
    expect(b.logs.includes("config_error_token_refused")).toBe(response.status === 401);
  }
});

test("JSON-RPC -32602 is invalid_arguments; any other JSON-RPC error is connection_or_request_refused", async () => {
  for (const [code, want] of [[-32602, "invalid_arguments"], [-32603, "connection_or_request_refused"]] as const) {
    const { fetch } = fakeEcv((_n, _a, call) => Response.json({ jsonrpc: "2.0", id: call.body.id, error: { code, message: "upstream text" } }));
    expect((await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.guide", arguments: { topic: "cover" } })).body).toEqual({ code: want });
  }
});

test("a text/event-stream answer is read from its data: lines, skipping notifications before the response", async () => {
  const { fetch } = fakeEcv((_n, _a, call) => new Response(
    `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: call.body.id, result: textResult("from sse", { a: 1 }) })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }));
  expect(await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.plan_view", arguments: { days: 3 } }))
    .toEqual({ status: 200, body: { text: "from sse", structured: { a: 1 }, isError: false } });
});

test("an answer over 262,144 bytes is response_too_large, never parsed in part", async () => {
  const { fetch } = fakeEcv((_n, _a, call) => Response.json({ jsonrpc: "2.0", id: call.body.id, result: textResult("x".repeat(262144)) }));
  expect(await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.open_shifts" })).toEqual({ status: 502, body: { code: "response_too_large" } });
});

test("a call that outlives the 25 s budget is aborted: connection_or_request_refused", async () => {
  const manifest = loadManifest();
  for (const op of manifest.operations) op.timeoutMs = 20;
  const fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })) as unknown as typeof globalThis.fetch;
  const b = createEciVolunteersBridge({ token: "t", fetch, store: memoryStore(), manifest, log: () => {} });
  expect((await b.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.initialize" })).body).toEqual({ code: "connection_or_request_refused" });
  expect(loadManifest().operations.every((op: { timeoutMs: number }) => op.timeoutMs === 25000)).toBe(true);
});

test("invalid operations and arguments are refused before any fetch", async () => {
  const { fetch, calls } = fakeEcv(() => textResult("never"));
  const b = bridge(fetch);
  const bad: [string, unknown, string?][] = [
    ["eci-volunteers.log_note", {}], ["eciv_my_shifts", {}], ["eci-volunteers.initialize", { x: 1 }],
    ["eci-volunteers.my_shifts", { limit: 21 }], ["eci-volunteers.my_shifts", { limit: true }], ["eci-volunteers.my_shifts", { before: "x".repeat(501) }],
    ["eci-volunteers.guide", { topic: "cover", topics: ["cover"] }], ["eci-volunteers.guide", { topic: "draw" }],
    ["eci-volunteers.get_shift", {}], ["eci-volunteers.get_shift", { slot_id: "not-a-uuid" }], ["eci-volunteers.my_hours", { week: "21 Oct" }],
    ["eci-volunteers.propose", { action: "add_to_shift", params: { slot_id: SLOT } }, TURN1],
    ["eci-volunteers.propose", { action: "ask_cover", params: { slot_id: SLOT, volunteer_id: SLOT } }, TURN1],
    ["eci-volunteers.propose", { action: "ask_cover", params: { slot_id: SLOT }, then: [] }, TURN1],
    ["eci-volunteers.propose", { action: "ask_cover", params: { slot_id: SLOT }, then: Array(3).fill({ action: "set_extra_hours", params: { on: true } }) }, TURN1],
    ["eci-volunteers.propose", { action: "plan_days", params: { days: [{ date: "2026-10-22", rank: [], free_hours: [{ start: "9am", end: "13:00" }] }] } }, TURN1],
    ["eci-volunteers.propose", { action: "ask_cover", params: { slot_id: SLOT } }],
    ["eci-volunteers.propose", { action: "ask_cover", params: { slot_id: SLOT } }, "forged"],
    ["eci-volunteers.confirm", { code: "short" }, TURN2], ["eci-volunteers.confirm", { code: "v1." + "é".repeat(40) }, TURN2],
    ["eci-volunteers.confirm", { code: CODE }],
    ["eci-volunteers.my_requests", "limit"],
  ];
  for (const [operation, args, turnId] of bad)
    expect([operation, await b.handle({ ownerTelegramId: OWNER, operation, arguments: args, turnId })]).toEqual([operation, { status: 422, body: { code: "invalid_arguments" } }]);
  expect(calls).toEqual([]);
  // Schema-valid but over the operation's maxRequestBytes (lowered here: no valid read reaches 4096).
  const manifest = loadManifest();
  manifest.operations.find((op: { name: string }) => op.name === "eci-volunteers.my_shifts").maxRequestBytes = 100;
  const small = createEciVolunteersBridge({ token: "t", fetch, store: memoryStore(), manifest, log: () => {} });
  expect((await small.handle({ ownerTelegramId: OWNER, operation: "eci-volunteers.my_shifts", arguments: { before: "é".repeat(100) } })).body).toEqual({ code: "invalid_arguments" });
  expect(calls).toEqual([]);
});

test("the schema interpreter refuses a keyword it does not know, and accepts each propose action's exact params", () => {
  expect(() => matches({ type: "object", anyOf: [] }, {})).toThrow("eci_volunteers_schema_keyword:anyOf");
  const propose = loadManifest().operations.find((op: { name: string }) => op.name === "eci-volunteers.propose").input;
  for (const body of [
    { action: "claim_shift", params: { request_id: SLOT } },
    { action: "set_rest_day", params: { date: "2026-10-23", rest: false } },
    { action: "plan_days", params: { days: [{ date: "2026-10-22", rank: [SLOT], free_hours: [{ start: "09:00", end: "13:00" }] }] } },
    { action: "move_shift", params: { slot_id: SLOT, to_slot_id: SLOT }, then: [{ action: "cancel_cover_request", params: { request_id: SLOT } }] },
  ]) expect([body.action, matches(propose, body)]).toEqual([body.action, true]);
  expect(matches(propose, { action: "claim_shift", params: { slot_id: SLOT } })).toBe(false);
});
