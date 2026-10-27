// The reference app-server half of Edge Library (app-server.ts), against a fake fetch: no network.
//   bun test docs/reference/library/app-server.test.ts
import { expect, test } from "bun:test";
import { CODES, createLibraryBridge, loadManifest, matches } from "./app-server";

const BASE = "https://library.positivesumexperiments.com/api/mcp";
const NODE = "3f2b8c1e-5d4a-4b6f-9e2d-1a2b3c4d5e6f";
const SRC = "7c9d0e1f-2a3b-4c5d-8e6f-0a1b2c3d4e5f";
const OWNER = 123456789;

type Call = { url: string; headers: Record<string, string>; body: any };
/** A fake Edge Library: answers initialize and the notification, then `tool(name, args)` for tools/call. */
function fakeLibrary(tool: (name: string, args: any, call: Call) => Response | object, opts: { init?: () => Response } = {}) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const headers = Object.fromEntries(Object.entries(init.headers as Record<string, string>));
    const body = JSON.parse(String(init.body));
    const call = { url, headers, body };
    calls.push(call);
    if (body.method === "initialize") return opts.init ? opts.init() : Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "edge-library", version: "1.0.0" } } });
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    const answer = tool(body.params.name, body.params.arguments, call);
    return answer instanceof Response ? answer : Response.json({ jsonrpc: "2.0", id: body.id, result: answer });
  }) as unknown as typeof fetch;
  return { fetch, calls };
}
/** What Edge Library's MCP server returns: text (its own, or the JSON of the data) and the data as structuredContent. */
const libraryResult = (data: object, text?: string) => ({ content: [{ type: "text", text: text ?? JSON.stringify(data) }], structuredContent: data });
function bridge(fetch: typeof globalThis.fetch) {
  const logs: string[] = [];
  const b = createLibraryBridge({ token: "test-token", fetch, log: event => logs.push(event) });
  return { ...b, logs };
}
const op = (over: object = {}) => ({ op: "node.create", type: "project", title: "Water filter", confidence: 0.8, rationale: "The transcript describes it", ...over });

test("the bridge serves exactly the manifest's eleven operations, each to its Edge Library tool", () => {
  const { fetch } = fakeLibrary(() => libraryResult({}));
  const manifest = loadManifest();
  expect(bridge(fetch).operations).toEqual(manifest.operations.map((o: { name: string }) => o.name));
  expect(manifest.operations.map((o: { name: string; target: { tool: string } }) => [o.name.replace(".", "_"), o.target.tool]).every(([a, b]: string[]) => a === b)).toBe(true);
  expect(bridge(fetch).operations.length).toBe(11);
});

test("a read: MCP initialize, initialized, tools/call with the token and the owner's id; JSON-only text is not sent twice", async () => {
  const hits = { queryId: NODE, hits: [{ kind: "node", id: NODE, path: "tools/wisprflow", title: "Wispr Flow", type: "tool", score: 1, matched: ["title"], snippet: "Wispr" }] };
  const { fetch, calls } = fakeLibrary((name, args) => {
    expect([name, args]).toEqual(["library_search", { q: "dictation", limit: 5 }]);
    return libraryResult(hits);
  });
  const b = bridge(fetch);
  const answer = await b.handle({ ownerTelegramId: OWNER, operation: "library.search", arguments: { q: "dictation", limit: 5 } });
  expect(answer).toEqual({ status: 200, body: { text: "", structured: hits, isError: false } });
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

test("Edge Library's own text (initialize's guide) is kept beside the data", async () => {
  const { fetch } = fakeLibrary(() => libraryResult({ you: { kind: "agent" }, catalog: { entityTypes: [] } }, "# Edge Library: how it works"));
  expect((await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "library.initialize" })).body)
    .toEqual({ text: "# Edge Library: how it works", structured: { you: { kind: "agent" }, catalog: { entityTypes: [] } }, isError: false });
});

test("the username header is sent only when given (without @), and a session id is carried when Edge Library returns one", async () => {
  const { fetch, calls } = fakeLibrary(() => libraryResult({ ok: true }), {
    init: () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } }), { headers: { "content-type": "application/json", "mcp-session-id": "s-1" } }),
  });
  const b = bridge(fetch);
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: "@Asha_K", operation: "library.schema" });
  expect(calls.map(c => c.headers["X-Agent-Village-Telegram-Username"])).toEqual(["Asha_K", "Asha_K", "Asha_K"]);
  expect(calls.map(c => c.headers["Mcp-Session-Id"])).toEqual([undefined, "s-1", "s-1"]);
  calls.length = 0;
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: null, operation: "library.schema" });
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: "bad name!", operation: "library.schema" });
  await b.handle({ ownerTelegramId: OWNER, ownerTelegramUsername: "abc", operation: "library.schema" });
  expect(calls.every(c => !("X-Agent-Village-Telegram-Username" in c.headers))).toBe(true);
  expect(b.logs).toContain("username_malformed_not_sent");
});

test("the writes forward their arguments unchanged; a tool's refusal comes back as isError data", async () => {
  const written = { seq: 41, created: [{ index: 0, ref: "filter", kind: "node", id: NODE }], proposals: [] };
  let refused = false;
  const { fetch, calls } = fakeLibrary(name => refused
    ? { content: [{ type: "text", text: "INVALID: Agents must give a confidence and a rationale." }], isError: true }
    : name === "library_write" ? libraryResult(written) : libraryResult({ source: { id: SRC }, created: true, jobId: NODE }));
  const b = bridge(fetch);
  const write = { message: "Add the water filter", ops: [op({ ref: "filter", how: "quoted", evidence: [{ sourceId: SRC, start: 10, end: 90 }] })] };
  expect(await b.handle({ ownerTelegramId: OWNER, operation: "library.write", arguments: write })).toEqual({ status: 200, body: { text: "", structured: written, isError: false } });
  const source = { title: "Thursday transcript", text: "Line one\nLine two", kind: "meeting-transcript" };
  expect((await b.handle({ ownerTelegramId: OWNER, operation: "library.submit_source", arguments: source })).status).toBe(200);
  refused = true;
  expect(await b.handle({ ownerTelegramId: OWNER, operation: "library.propose", arguments: { kind: "merge", payload: { keep: { id: NODE }, remove: { path: "tools/wispr" } }, rationale: "Same tool", confidence: 0.9 } }))
    .toEqual({ status: 200, body: { text: "INVALID: Agents must give a confidence and a rationale.", structured: null, isError: true } });
  expect(calls.filter(c => c.body.method === "tools/call").map(c => c.body.params.name)).toEqual(["library_write", "library_submit_source", "library_propose"]);
  expect(calls.filter(c => c.body.method === "tools/call")[0]!.body.params.arguments).toEqual(write);
});

test("Edge Library's refusals before MCP map to the generic codes; 401 is a config error shown as unavailable", async () => {
  const cases: [Response, string][] = [
    // Edge Library's own bodies (docs/MINIAPP.md; scripts/tests/fixtures/library): an unknown token, a missing id, the
    // link revoked.
    [Response.json({ error: "unauthorized", error_description: "Connect Edge Library", code: "not_authorized", detail: "Unknown Agent Village token." }, { status: 401 }), "unavailable"],
    [Response.json({ code: "not_authorized", detail: "Send X-Agent-Village-Telegram-User-Id: the resident's numeric Telegram user id." }, { status: 401 }), "unavailable"],
    [Response.json({ code: "not_authorized", detail: "Agent Village access to Edge Library is off." }, { status: 403 }), "not_authorized"],
    [Response.json({ code: "not_found", detail: "no person" }, { status: 404 }), "connection_or_request_refused"],
    [Response.json({ code: "rate_limited", detail: "slow down" }, { status: 429 }), "rate_limited"],
    [Response.json({ code: "invalid_arguments", detail: "telegram id" }, { status: 400 }), "invalid_arguments"],
    [Response.json({ code: "unavailable", detail: "link off" }, { status: 503 }), "unavailable"],
    [Response.json({ code: "something_else" }, { status: 403 }), "connection_or_request_refused"],
    [new Response("<html>", { status: 500 }), "connection_or_request_refused"],
  ];
  for (const [response, code] of cases) {
    const { fetch } = fakeLibrary(() => libraryResult({}), { init: () => response });
    const b = bridge(fetch);
    const answer = await b.handle({ ownerTelegramId: OWNER, operation: "library.search", arguments: { q: "filter" } });
    expect([response.status, answer]).toEqual([response.status, { status: CODES[code as keyof typeof CODES], body: { code } }]);
    // No upstream wording reaches the box.
    expect(JSON.stringify(answer)).not.toContain("detail");
    expect(b.logs.includes("config_error_token_refused")).toBe(response.status === 401);
  }
});

test("a tool's refusal: link codes (rate_limited, unavailable) go to the box as codes; the rest stay data with Edge Library's detail", async () => {
  // Edge Library's own isError results (recorded in scripts/tests/fixtures/library).
  const refusal = (code: string, detail: string, library: string) => ({ content: [{ type: "text", text: `${library}: ${detail}` }], structuredContent: { code, detail }, isError: true });
  const cases: [object, unknown][] = [
    [refusal("rate_limited", "Too many calls: at most 60 a minute for each resident. Try again in a minute.", "RATE_LIMITED"), { status: 429, body: { code: "rate_limited" } }],
    [refusal("unavailable", "Something went wrong. Try again.", "INTERNAL"), { status: 503, body: { code: "unavailable" } }],
    [refusal("not_found", "No such node.", "NOT_FOUND"), { status: 200, body: { text: "NOT_FOUND: No such node.", structured: { code: "not_found", detail: "No such node." }, isError: true } }],
    [refusal("invalid_arguments", "op 0 (node.archive): agents must give a confidence between 0 and 1.", "INVALID"),
      { status: 200, body: { text: "INVALID: op 0 (node.archive): agents must give a confidence between 0 and 1.", structured: { code: "invalid_arguments", detail: "op 0 (node.archive): agents must give a confidence between 0 and 1." }, isError: true } }],
    [refusal("conflict", "The node changed since you read it.", "STALE_VERSION"), { status: 200, body: { text: "STALE_VERSION: The node changed since you read it.", structured: { code: "conflict", detail: "The node changed since you read it." }, isError: true } }],
  ];
  for (const [result, want] of cases) {
    const { fetch } = fakeLibrary(() => result);
    expect(await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "library.get", arguments: { path: "no/such/node" } })).toEqual(want as any);
  }
});

test("the owner's Telegram id must be one Edge Library accepts (1-16 digits, a safe integer); nothing is sent otherwise", async () => {
  const { fetch, calls } = fakeLibrary(() => libraryResult({}));
  for (const id of ["0", "12345678901234567", "9007199254740993", "abc", ""])
    expect((await bridge(fetch).handle({ ownerTelegramId: id, operation: "library.schema" })).body).toEqual({ code: "connection_or_request_refused" });
  expect(calls).toEqual([]);
});

test("a refusal on the tools/call itself (not only initialize) is mapped the same way", async () => {
  const { fetch } = fakeLibrary(() => Response.json({ code: "rate_limited", detail: "x" }, { status: 429 }));
  expect((await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "library.get", arguments: { path: "tools/wisprflow" } })).body).toEqual({ code: "rate_limited" });
});

test("JSON-RPC -32602 is invalid_arguments; any other JSON-RPC error is connection_or_request_refused", async () => {
  for (const [code, want] of [[-32602, "invalid_arguments"], [-32603, "connection_or_request_refused"]] as const) {
    const { fetch } = fakeLibrary((_n, _a, call) => Response.json({ jsonrpc: "2.0", id: call.body.id, error: { code, message: "upstream text" } }));
    expect((await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "library.history", arguments: { seq: 3 } })).body).toEqual({ code: want });
  }
});

test("a text/event-stream answer is read from its data: lines, skipping notifications before the response", async () => {
  const { fetch } = fakeLibrary((_n, _a, call) => new Response(
    `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n` +
    `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: call.body.id, result: libraryResult({ commits: [] }) })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }));
  expect(await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "library.changes_since", arguments: { seq: 0 } }))
    .toEqual({ status: 200, body: { text: "", structured: { commits: [] }, isError: false } });
});

test("an answer over 262,144 bytes is response_too_large, never parsed in part", async () => {
  const { fetch } = fakeLibrary(() => libraryResult({ text: "x".repeat(262144) }));
  expect(await bridge(fetch).handle({ ownerTelegramId: OWNER, operation: "library.source", arguments: { id: SRC } })).toEqual({ status: 502, body: { code: "response_too_large" } });
});

test("a call that outlives the 25 s budget is aborted: connection_or_request_refused", async () => {
  const manifest = loadManifest();
  for (const o of manifest.operations) o.timeoutMs = 20;
  const fetch = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
    init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })) as unknown as typeof globalThis.fetch;
  const b = createLibraryBridge({ token: "t", fetch, manifest, log: () => {} });
  expect((await b.handle({ ownerTelegramId: OWNER, operation: "library.initialize" })).body).toEqual({ code: "connection_or_request_refused" });
  expect(loadManifest().operations.every((o: { timeoutMs: number }) => o.timeoutMs === 25000)).toBe(true);
});

test("invalid operations and arguments are refused before any fetch", async () => {
  const { fetch, calls } = fakeLibrary(() => libraryResult({}));
  const b = bridge(fetch);
  const bad: [string, unknown][] = [
    ["library.jobs_claim", {}], ["library.queries", {}], ["library_search", { q: "a" }], ["library.initialize", { x: 1 }],
    ["library.search", {}], ["library.search", { q: "" }], ["library.search", { q: "x".repeat(501) }], ["library.search", { q: "a", limit: 0 }],
    ["library.search", { q: "a", kinds: ["person"] }], ["library.search", { q: "a", limit: 1.5 }],
    ["library.get", { id: "not-a-uuid" }], ["library.get", { path: "a", historyLimit: 101 }],
    ["library.source", {}], ["library.source", { id: SRC, length: 50001 }],
    ["library.changes_since", {}], ["library.proposals", { status: "open" }],
    ["library.submit_source", { title: "t" }], ["library.submit_source", { title: "t", text: "x", private: true }],
    ["library.write", { message: "m", ops: [] }], ["library.write", { message: "m", ops: [op({ op: "node.delete" })] }],
    ["library.write", { message: "m", ops: [op({ confidence: 2 })] }], ["library.write", { message: "m", ops: [op({ extra: 1 })] }],
    ["library.write", { message: "m", ops: [op({ parent: { id: NODE, path: "a" } })] }],
    ["library.write", { message: "m", ops: [{ op: "edge.create", type: "t", from: { id: NODE }, to: { id: NODE } }] }],
    ["library.propose", { kind: "node", payload: {} }], ["library.propose", { kind: "person", payload: {}, rationale: "r" }],
    ["library.propose", { kind: "node", payload: {}, rationale: "r", sourceId: "x" }],
    ["library.search", "q"],
  ];
  for (const [operation, args] of bad)
    expect([operation, await b.handle({ ownerTelegramId: OWNER, operation, arguments: args })]).toEqual([operation, { status: 422, body: { code: "invalid_arguments" } }]);
  // Schema-valid but over the operation's maxRequestBytes (262,144 for a source).
  expect((await b.handle({ ownerTelegramId: OWNER, operation: "library.submit_source", arguments: { title: "t", text: "é".repeat(131072) } })).body).toEqual({ code: "invalid_arguments" });
  expect(calls).toEqual([]);
});

test("the schema interpreter refuses a keyword it does not know, and accepts each graph op's exact shape", () => {
  expect(() => matches({ type: "object", allOf: [] }, {})).toThrow("library_schema_keyword:allOf");
  const write = loadManifest().operations.find((o: { name: string }) => o.name === "library.write").input;
  const ops = [
    op({ ref: "a", slug: "a", parent: null, description: "d", properties: { status: "built", n: 3 }, terms: [{ term: "x", kind: "alias", confidence: 0.4 }], how: "inferred", evidence: [{ sourceId: SRC, start: 0, end: 5 }] }),
    { op: "node.update", node: { path: "tools/wisprflow" }, summary: "s", parent: { ref: "a" }, confidence: 1, rationale: "r" },
    { op: "node.archive", node: { id: NODE }, confidence: 0.5, rationale: "r" },
    { op: "node.terms.add", node: { ref: "a" }, terms: [{ term: "Wispr", kind: "alias" }] },
    { op: "node.terms.remove", node: { id: NODE }, terms: ["Whisper"] },
    { op: "edge.create", type: "works_on", from: { ref: "a" }, to: { path: "projects/filter" }, how: "said_by" },
    { op: "edge.archive", edge: { id: NODE } },
  ];
  for (const o of ops) expect([o.op, matches(write, { message: "m", ops: [o] })]).toEqual([o.op, true]);
  // The manifest is Edge Library's schema: confidence and rationale are optional there (the box and Edge Library's
  // recorder require them of agents), and how "confirmed" is a valid value.
  expect(matches(write, { message: "m", ops: [{ op: "node.archive", node: { id: NODE }, how: "confirmed" }] })).toBe(true);
  expect(matches(write, { message: "m", ops: [{ op: "edge.archive", edge: { path: "a" } }] })).toBe(false);
});
