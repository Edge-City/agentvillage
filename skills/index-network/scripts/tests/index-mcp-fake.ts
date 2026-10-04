/**
 * A fake Index MCP endpoint that holds a client to the contract in
 * fixtures/index-mcp-2026-07-28.json the way Index does: it refuses an
 * `initialize` with -32022, a missing or different protocol-version header
 * with -32022, a missing or different `Mcp-Method` / `Mcp-Name` with -32020,
 * and a missing envelope key with -32602. A regression to the old protocol
 * therefore fails loudly instead of reading an empty list.
 *
 * It also behaves like fetch where the client relies on it: an aborted
 * signal rejects with an AbortError, a 3xx answer throws under
 * `redirect: "error"` and is otherwise "followed" to a host that answers
 * successfully (so a client that follows redirects is caught), and a
 * `{ hang: true }` reply never answers until the signal aborts (`hangBody`:
 * the headers arrive, the body never finishes until the signal aborts).
 *
 * It never touches the network: a request to any URL other than its own
 * throws.
 */

import fixture from "./fixtures/index-mcp-2026-07-28.json";

export const FIXTURE = fixture;
export const PROTOCOL = fixture.protocolVersion;
export const INDEX_TOOLS: string[] = fixture.tools;
/** `.test` is reserved (RFC 2606) and never resolves. */
export const FAKE_MCP_URL = "https://index-mcp.fake.test/mcp";
export const FAKE_API_KEY = "fake-index-key-not-real";

export type ToolReply =
  | string
  | { result: Record<string, unknown> }
  | { response: Response }
  | { hang: true }
  | { hangBody: true };
/** `id` is the request's JSON-RPC id, for handlers that build their own response. */
export type ToolHandler = (args: Record<string, unknown>, request: { id: unknown }) => ToolReply | Promise<ToolReply>;

export interface FakeCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
  method?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  /** HTTP status the fake answered with (0 when it threw or hung). */
  status: number;
  /** Set when the client let a 3xx answer be followed. */
  followedRedirect?: boolean;
}

const SERVER_META = fixture.responses.listIntents.result._meta;

const HANG = new Response(null, { status: 599 });
const HANG_BODY = new Response(null, { status: 598 });

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function rpcError(id: unknown, status: number, code: number, message: string, data?: unknown): Response {
  return Response.json(
    { jsonrpc: "2.0", id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } },
    { status },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Default replies: the fixture's two list tools; every other tool answers an empty text. */
const DEFAULT_TOOLS: Record<string, ToolHandler> = {
  list_intents: () => fixture.responses.listIntents.result.content[0].text,
  list_opportunities: () => fixture.responses.listOpportunities.result.content[0].text,
};

export function indexMcpFake(options: { tools?: Record<string, ToolHandler>; url?: string; apiKey?: string } = {}) {
  const url = options.url ?? FAKE_MCP_URL;
  const tools = { ...DEFAULT_TOOLS, ...(options.tools ?? {}) };
  const calls: FakeCall[] = [];

  async function answer(call: FakeCall, init: RequestInit | undefined): Promise<Response> {
    const h = call.headers;
    const body = call.body;
    const id = body?.id;
    if ((init?.method ?? "GET").toUpperCase() !== "POST") return new Response("method not allowed", { status: 405 });
    if (!body) return rpcError(null, 400, -32700, "Parse error");
    // Fake's choice (not probed): no key is a 401.
    if (!h["x-api-key"]) return new Response("unauthorized", { status: 401 });
    if (options.apiKey !== undefined && h["x-api-key"] !== options.apiKey) {
      return new Response("unauthorized", { status: 401 });
    }
    // Fake's choice (not probed): the transport headers are checked like a strict streamable-HTTP server.
    const accept = h.accept ?? "";
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      return rpcError(id, 406, -32600, "Not Acceptable");
    }
    if (!(h["content-type"] ?? "").startsWith("application/json")) {
      return rpcError(id, 415, -32600, "Unsupported Media Type");
    }

    // Fact 1: the revision is stateless and any initialize is refused.
    if (body.method === "initialize") {
      return rpcError(id, 400, -32022, "Unsupported protocol version", { supported: [PROTOCOL] });
    }
    // Fake's choice for a missing header (a different one is fact 1's refusal).
    if (h["mcp-protocol-version"] !== PROTOCOL) {
      return rpcError(id, 400, -32022, "Unsupported protocol version", { supported: [PROTOCOL] });
    }
    // Fact 2: header and body are cross-checked.
    if (h["mcp-method"] !== body.method) {
      return rpcError(id, 400, -32020, "the request headers and body disagree");
    }
    const params = asRecord(body.params) ?? {};
    if (body.method === "tools/call" && (h["mcp-name"] === undefined || h["mcp-name"] !== params.name)) {
      return rpcError(id, 400, -32020, "the request headers and body disagree");
    }
    // Fact 3: the per-request envelope.
    const meta = asRecord(params._meta) ?? {};
    const missing = Object.keys(fixture.request.envelopeRequired).filter((key) => !(key in meta));
    if (missing.length > 0) {
      return rpcError(id, 400, -32602, "Invalid params", { envelope: { missing } });
    }
    if (meta["io.modelcontextprotocol/protocolVersion"] !== PROTOCOL) {
      return rpcError(id, 400, -32022, "Unsupported protocol version", { supported: [PROTOCOL] });
    }

    if (body.method === "tools/list") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools: INDEX_TOOLS.map((name) => ({ name, description: `${name} (fixture)`, inputSchema: { type: "object" } })),
          resultType: "complete",
          _meta: SERVER_META,
        },
      });
    }
    if (body.method !== "tools/call") return rpcError(id, 200, -32601, "Method not found");

    const name = String(params.name ?? "");
    // Not probed: how an unknown tool is answered. A JSON-RPC error is the fake's choice.
    if (!INDEX_TOOLS.includes(name)) return rpcError(id, 200, -32602, "Unknown tool");
    const handler = tools[name] ?? (() => "");
    const reply = await handler(asRecord(params.arguments) ?? {}, { id });
    if (typeof reply === "string") {
      return Response.json({
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: reply }], resultType: "complete", _meta: SERVER_META },
      });
    }
    if ("hang" in reply) return HANG;
    if ("hangBody" in reply) return HANG_BODY;
    if ("response" in reply) return reply.response;
    return Response.json({ jsonrpc: "2.0", id, result: reply.result });
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = String(input instanceof Request ? input.url : input);
    if (target !== url) throw new Error(`index-mcp-fake: refusing a request to ${target}`);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = asRecord(JSON.parse(String(init?.body ?? "")));
    } catch {
      body = null;
    }
    const params = asRecord(body?.params);
    const call: FakeCall = {
      url: target,
      headers,
      body,
      method: typeof body?.method === "string" ? body.method : undefined,
      name: typeof params?.name === "string" ? params.name : undefined,
      arguments: asRecord(params?.arguments) ?? undefined,
      status: 0,
    };
    calls.push(call);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw abortError(signal);
    const response = await answer(call, init);
    if (response === HANG) {
      return await new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(abortError(signal)), { once: true });
      });
    }
    if (response === HANG_BODY) {
      call.status = 200;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
          signal?.addEventListener("abort", () => controller.error(abortError(signal)), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }
    if (response.status >= 300 && response.status < 400) {
      if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      if (init?.redirect !== "manual") {
        // What the host behind Location would say: a well-formed success.
        call.followedRedirect = true;
        call.status = 200;
        return Response.json({ jsonrpc: "2.0", id: body?.id, result: fixture.responses.listOpportunities.result });
      }
    }
    call.status = response.status;
    return response;
  }) as typeof fetch;

  return {
    url,
    fetch: fakeFetch,
    calls,
    /** Point globalThis.fetch at the fake; returns the restore function. */
    install(): () => void {
      const original = globalThis.fetch;
      globalThis.fetch = fakeFetch;
      return () => {
        globalThis.fetch = original;
      };
    },
  };
}

/** Wrap one JSON-RPC message as a `text/event-stream` body. */
export function eventStream(...messages: unknown[]): Response {
  const body = messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`).join("");
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** A `list_opportunities` text in the live shape (markdown lead, blank line, JSON). */
export function listOpportunitiesText(rows: unknown[]): string {
  const lead = ["Waiting on you:"];
  for (const row of rows) {
    const r = asRecord(row) ?? {};
    const peer = asRecord(r.peer) ?? {};
    lead.push(`- [${String(peer.name ?? "someone")}](${String(r.url ?? "")}) — ${String(r.headline ?? "")}`);
  }
  return `${lead.join("\n")}\n\n${JSON.stringify({ success: true, opportunities: rows }, null, 2)}`;
}

/**
 * A `list_opportunities` handler over `rows` that honours the request the way
 * Index does: only rows whose status is in `statuses` (default pending), at
 * most `limit` of them (default 20) in the given order, with the pagination
 * object `{limit, offset, count}` (count: every matching row).
 */
export function pagedOpportunities(rows: Array<Record<string, unknown>>): ToolHandler {
  return (args) => {
    const statuses = Array.isArray(args.statuses) ? (args.statuses as unknown[]) : ["pending"];
    const limit = typeof args.limit === "number" ? args.limit : 20;
    const matching = rows.filter((row) => statuses.includes(row.status));
    const page = matching.slice(0, limit);
    const lead = ["Waiting on you:"];
    for (const row of page) lead.push(`- [${String(asRecord(row.peer)?.name ?? "someone")}](${String(row.url ?? "")})`);
    return `${lead.join("\n")}\n\n${JSON.stringify({ success: true, opportunities: page, pagination: { limit, offset: 0, count: matching.length } }, null, 2)}`;
  };
}
