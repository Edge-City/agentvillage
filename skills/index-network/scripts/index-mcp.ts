/**
 * The one Index MCP client the resident-facing scripts share.
 *
 * Index's MCP endpoint speaks exactly one protocol revision,
 * INDEX_MCP_PROTOCOL_VERSION, and that revision is stateless: there is no
 * handshake request and no session id. Every request instead carries
 *
 *   - the HTTP headers `MCP-Protocol-Version`, `Mcp-Method` (the JSON-RPC
 *     method) and, on `tools/call`, `Mcp-Name` (the tool name), which the
 *     server cross-checks against the body;
 *   - a per-request envelope in `params._meta` (protocol version and client
 *     capabilities, plus optional client info).
 *
 * The pinned request and response shapes live in
 * tests/fixtures/index-mcp-2026-07-28.json, and tests/index-mcp-fake.ts
 * refuses anything else the way Index does.
 *
 * Every request has a 20 s timeout and refuses redirects; both, like any
 * transport failure, are `mcp-unreachable`.
 *
 * Every failure throws an IndexMcpError whose message is a short code (for
 * example `mcp-http-400:-32022`). Codes never carry the API key, a response
 * body, or a resident's text, so callers can put them straight into their
 * warnings.
 */

export const INDEX_MCP_PROTOCOL_VERSION = "2026-07-28";

export const DEFAULT_INDEX_MCP_URL = "https://protocol.index.network/mcp";

const CLIENT_INFO = { name: "agentvillage-index-scripts", version: "1.0.0" };

/** How long one request (headers and body) may take. */
export const INDEX_MCP_TIMEOUT_MS = 20_000;

/** `$INDEX_MCP_URL` when set and non-empty, else production. */
export function indexMcpUrl(): string {
  return process.env.INDEX_MCP_URL?.trim() || DEFAULT_INDEX_MCP_URL;
}

export class IndexMcpError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "IndexMcpError";
    this.code = code;
  }
}

export interface IndexMcpTarget {
  apiKey: string;
  mcpUrl: string;
  /** Injected transport for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Tests only; defaults to INDEX_MCP_TIMEOUT_MS. */
  timeoutMs?: number;
}

type JsonRpcMessage = {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
};

let nextRequestId = 1;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "TimeoutError";
}

function rpcCodeSuffix(error: unknown): string {
  const code = asRecord(error)?.code;
  return typeof code === "number" && Number.isInteger(code) ? `:${code}` : "";
}

/**
 * Read the one JSON-RPC response out of a `text/event-stream` body. Events
 * are separated by a blank line; an event's `data:` lines (with or without a
 * space after the colon) join with newlines. Notifications are skipped.
 */
function responseFromEventStream(text: string, requestId: number): JsonRpcMessage | null {
  let found: JsonRpcMessage | null = null;
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => (line.startsWith("data: ") ? line.slice(6) : line.slice(5)))
      .join("\n");
    if (!data.trim()) continue;
    try {
      const message = asRecord(JSON.parse(data)) as JsonRpcMessage | null;
      if (!message || !("result" in message || "error" in message)) continue;
      if (message.id === requestId) return message;
      found = message;
    } catch {
      // a comment or a non-JSON line
    }
  }
  return found;
}

/**
 * Send one JSON-RPC request to Index's MCP endpoint and return its `result`.
 * Throws IndexMcpError on a transport failure, a non-200 status, a JSON-RPC
 * error, a malformed response, or a `resultType` other than `complete`.
 */
export async function indexMcpRequest(
  target: IndexMcpTarget,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const id = nextRequestId++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "x-api-key": target.apiKey,
    // The resident's digest is delivered over Telegram (Hermes). Without this
    // header Index coerces the surface to "web", which stamps minted connect
    // links with preferredSurface=web and breaks the click-time t.me deep-link
    // redirect. Mirrors install_index.ts's buildIndexMcpHeaders.
    "x-index-surface": "telegram",
    "MCP-Protocol-Version": INDEX_MCP_PROTOCOL_VERSION,
    "Mcp-Method": method,
  };
  if (method === "tools/call") headers["Mcp-Name"] = String(params.name ?? "");

  const body = {
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...params,
      _meta: {
        ...(asRecord(params._meta) ?? {}),
        "io.modelcontextprotocol/protocolVersion": INDEX_MCP_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      },
    },
  };

  const send = target.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await send(target.mcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      // A redirect would carry the key to wherever Location points.
      redirect: "error",
      signal: AbortSignal.timeout(target.timeoutMs ?? INDEX_MCP_TIMEOUT_MS),
    });
  } catch {
    throw new IndexMcpError("mcp-unreachable");
  }

  if (res.status !== 200) {
    let suffix = "";
    try {
      suffix = rpcCodeSuffix(asRecord(await res.json())?.error);
    } catch {
      // not JSON; the status alone is the code
    }
    throw new IndexMcpError(`mcp-http-${res.status}${suffix}`);
  }

  let message: JsonRpcMessage | null;
  try {
    const contentType = res.headers.get("content-type") ?? "";
    message = contentType.includes("text/event-stream")
      ? responseFromEventStream(await res.text(), id)
      : (asRecord(await res.json()) as JsonRpcMessage | null);
  } catch (err) {
    throw new IndexMcpError(isAbort(err) ? "mcp-unreachable" : "mcp-bad-response");
  }
  if (!message) throw new IndexMcpError("mcp-bad-response");
  if (message.error !== undefined && message.error !== null) throw new IndexMcpError(`mcp-rpc-error${rpcCodeSuffix(message.error)}`);
  if (message.id !== id) throw new IndexMcpError("mcp-bad-response");

  const result = asRecord(message.result);
  if (!result) throw new IndexMcpError("mcp-bad-response");
  // Absent is tolerated (older servers); anything but "complete" is not a
  // finished answer this client can use.
  if (result.resultType !== undefined && result.resultType !== "complete") {
    throw new IndexMcpError("mcp-result-type");
  }
  return result;
}

/**
 * Call one Index tool and return the text of its first `type: "text"` content
 * item. A result flagged `isError` throws `mcp-tool-error`; a result without
 * a text item throws `mcp-bad-response`.
 */
export async function callIndexTool(
  target: IndexMcpTarget,
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const result = await indexMcpRequest(target, "tools/call", { name, arguments: args });
  if (result.isError === true) throw new IndexMcpError("mcp-tool-error");
  if (!Array.isArray(result.content)) throw new IndexMcpError("mcp-bad-response");
  for (const item of result.content) {
    const row = asRecord(item);
    if (row?.type === "text" && typeof row.text === "string") return row.text;
  }
  throw new IndexMcpError("mcp-bad-response");
}

/** Index of the `}` that closes the JSON object opening at `start`, or -1. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === "[") {
      depth++;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Where a list tool's JSON object may start: at the start of the text, or
 * directly after a blank line (CRLF and trailing spaces allowed), with only
 * whitespace before the `{`. Of those, a `{` that cannot open a JSON object
 * (a lead line such as "{Heads up} ...") is passed over; the first one that
 * can is the only one read.
 */
const OBJECT_START = /(?:^\s*|\n[ \t]*\r?\n[ \t]*)\{/g;
const OPENS_OBJECT = /^\{\s*(?:"|\}|$)/;

/**
 * The JSON object a list tool puts after its markdown lead, and whether
 * anything other than whitespace follows it. Null when there is no
 * candidate, or when the one candidate does not parse as an object; a later
 * object is never read in its place.
 */
export function toolJsonObject(text: string): { root: Record<string, unknown>; trailing: boolean } | null {
  for (const match of text.matchAll(OBJECT_START)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    if (!OPENS_OBJECT.test(text.slice(start, start + 200))) continue;
    const end = objectEnd(text, start);
    if (end < 0) return null;
    try {
      const root = asRecord(JSON.parse(text.slice(start, end + 1)));
      return root ? { root, trailing: text.slice(end + 1).trim() !== "" } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The array under `key` in a list tool's JSON object. Index always sends the
 * object, with an empty array when there is nothing, so an object with
 * `success: false` throws `mcp-tool-error`, and a text with no object, text
 * after the object, or an object without that array, throws `mcp-unparsed`.
 * Never an empty list on failure.
 */
export function toolJsonArray(text: string, key: string): unknown[] {
  const found = toolJsonObject(text);
  if (!found) throw new IndexMcpError("mcp-unparsed");
  if (found.root.success === false) throw new IndexMcpError("mcp-tool-error");
  if (found.trailing) throw new IndexMcpError("mcp-unparsed");
  const list = found.root[key];
  if (!Array.isArray(list)) throw new IndexMcpError("mcp-unparsed");
  return list;
}
