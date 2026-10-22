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

/** Index's refusal code for a line it wants clearer (SEED-REVISION): the one non-2xx create the welcome keeps for the resident. */
export const INTENT_NEEDS_REVISION = "intent_needs_revision";

/**
 * SEED-REVISION: Index said no to a create because of the line itself.
 * `feedback` is Index's model-written text about the line, raw (the caller
 * cleans it before it goes anywhere), or null when the answer has none;
 * `keys` the top-level key names of Index's answer (identifier-shaped ones
 * only, at most 20), never a value, so the first real body's shape can be
 * read without its text.
 */
export type IntentRefusal = { refused: true; code: typeof INTENT_NEEDS_REVISION; feedback: string | null; keys: string[] };

/** Index's refusal body is model-adjacent text; more than this of `feedback` is never kept. */
const REFUSAL_FEEDBACK_MAX = 4_000;
const REFUSAL_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const REFUSAL_KEYS_MAX = 20;

/**
 * The refusal a create answer's text holds, or null. Index's MCP
 * `create_intent` sends (services/api mcp.tools.ts `mcpError`, read from its
 * source) `{"success":false,"code":"intent_needs_revision","error":...,
 * "feedback":...,"proposedPayload":...,"recovery":...}`, the whole text, or
 * after a markdown lead line (toolJsonObject); its REST create (a91c3ff) never
 * answers that code, and createIntentDirect reads a non-2xx body with it the
 * same way. Only that code, and only an object whose `success` is not true,
 * is a refusal; anything else, a body that does not parse included, is null.
 * Pure.
 */
export function intentRefusal(text: string): IntentRefusal | null {
  let root: Record<string, unknown> | null = null;
  try {
    root = asRecord(JSON.parse(text.trim()));
  } catch {
    root = toolJsonObject(text)?.root ?? null;
  }
  if (!root || root.code !== INTENT_NEEDS_REVISION || root.success === true) return null;
  const feedback = typeof root.feedback === "string" && root.feedback.trim() ? root.feedback.slice(0, REFUSAL_FEEDBACK_MAX) : null;
  const keys = Object.keys(root).filter((key) => REFUSAL_KEY.test(key)).slice(0, REFUSAL_KEYS_MAX);
  return { refused: true, code: INTENT_NEEDS_REVISION, feedback, keys };
}

/** The text of a result's first `type: "text"` content item, or null. */
function firstText(result: Record<string, unknown>): string | null {
  if (!Array.isArray(result.content)) return null;
  for (const item of result.content) {
    const row = asRecord(item);
    if (row?.type === "text" && typeof row.text === "string") return row.text;
  }
  return null;
}

/**
 * Call one Index tool and return the text of its first `type: "text"` content
 * item. A result flagged `isError` throws `mcp-tool-error`; a result without
 * a text item throws `mcp-bad-response`.
 */
export async function callIndexTool(target: IndexMcpTarget, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await indexMcpRequest(target, "tools/call", { name, arguments: args });
  if (result.isError === true) throw new IndexMcpError("mcp-tool-error");
  const text = firstText(result);
  if (text === null) throw new IndexMcpError("mcp-bad-response");
  return text;
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
 * The JSON object a list tool puts after its markdown lead, and whether what
 * follows it could hold another JSON value (`trailing`: any `{` or `[` after
 * the object). Plain prose after the object is not `trailing`: since Index
 * ec439c4b (18 Oct 2026) the owner's FIRST tool call carries Index's
 * onboarding paragraph after the object (mcp.tools.ts `withOnboarding`), and
 * that paragraph has no brace or bracket. Null when there is no candidate, or
 * when the one candidate does not parse as an object; a later object is never
 * read in its place.
 */
export function toolJsonObject(text: string): { root: Record<string, unknown>; trailing: boolean } | null {
  for (const match of text.matchAll(OBJECT_START)) {
    const start = (match.index ?? 0) + match[0].length - 1;
    if (!OPENS_OBJECT.test(text.slice(start, start + 200))) continue;
    const end = objectEnd(text, start);
    if (end < 0) return null;
    try {
      const root = asRecord(JSON.parse(text.slice(start, end + 1)));
      return root ? { root, trailing: /[{[]/.test(text.slice(end + 1)) } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The array under `key` in a list tool's JSON object. Index always sends the
 * object, with an empty array when there is nothing, so an object with
 * `success: false` throws `mcp-tool-error`, and a text with no object, a
 * possible second JSON value after the object (toolJsonObject `trailing`), or
 * an object without that array, throws `mcp-unparsed`. Prose after the object
 * (Index's first-call onboarding paragraph) is ignored. Never an empty list on
 * failure.
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

// ── The welcome's seed: one direct create on Index's REST API ───────────────

/**
 * `sourceType` on every intent the overlay creates (the av-events plugin's
 * SOURCE_TYPE). For this source type and no `preparationReceipt`, Index
 * stores the description as written and skips admission (Index source
 * a91c3ff, services/api intent.service.ts `create`).
 */
export const AGENTVILLAGE_SOURCE_TYPE = "agentvillage";

/** One of Index's recovery questions, raw (the REFUSED_SEEDS reader's type; no shipped roll wrote one into a seed marker). */
export type RecoveryQuestion = { kind: "single" | "multi" | "text"; question: string; options: string[] };

/** An intent id Index issues: a UUID, or the hex short id (the av-events plugin's INTENT_PATH_ID). */
const INTENT_ID = /^(?:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}|[0-9a-fA-F]{4,32})$/;

/** Plain http is allowed to these hosts only (the av-events plugin's LOOPBACK_HOSTS). */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
/** `$INDEX_API_URL` may name the origin, or `<origin>/api` (the plugin's _API_URL_PATHS); no other path. */
const API_URL_PATHS = ["", "/", "/api", "/api/"];
/** The MCP URL's own path, when the create's origin is taken from it (the plugin's `_origin_from_mcp_url`). */
const MCP_URL_PATHS = ["/mcp", "/mcp/"];
/** A host the plugin's `_host_ok` takes, when not a bracketed IPv6 literal. */
const HOSTNAME = /^[A-Za-z0-9.-]+$/;
/** What Python's `str.strip()` strips (the plugin reads `env(API_URL_ENV).strip()`). */
const PY_STRIP = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

/** Whether `host` is an IPv6 literal (the plugin's `ipaddress.IPv6Address`; a zone id is refused here). */
function ipv6(host: string): boolean {
  if (!/^[0-9A-Fa-f:.]+$/.test(host) || !host.includes(":")) return false;
  try {
    new URL(`http://[${host}]/`);
    return true;
  } catch {
    return false;
  }
}

/**
 * `scheme://netloc` of `url` when it is an Index origin the key may be sent
 * to, else null: the av-events plugin's `_origin` (_record_intention.py
 * :535-561, refutation A1), ported rule for rule, over a port of the parts
 * of Python's `urlsplit` it reads: no `?` or `#` anywhere in the raw string;
 * no control character or space; then (as urlsplit) a scheme, `//`, the
 * netloc up to the first `/`, `?` or `#`, and the path; no userinfo (an `@`
 * in the netloc); the host after the last `@` either a bracketed IPv6
 * literal (zone ids refused: stricter than the plugin) or of `[A-Za-z0-9.-]`
 * only; a port, if any, of ASCII digits 0-65535; a path in `paths`; https,
 * or plain http to a loopback host only. The origin is rebuilt from the
 * scheme (lower-cased) and the netloc alone, so nothing else in the string
 * reaches a request. Pure.
 */
export function indexOrigin(url: string, paths: readonly string[]): string | null {
  if (url.includes("?") || url.includes("#")) return null;
  for (const ch of url) {
    const code = ch.codePointAt(0)!;
    if (code <= 0x20 || code === 0x7f) return null;
  }
  // urlsplit: leading C0 controls and spaces stripped, tab and newlines removed (a no-op after the check above).
  const raw = url.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  const split = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/s.exec(raw);
  if (!split) return null;
  const scheme = split[1]!.toLowerCase();
  const netloc = split[2]!;
  const path = split[3]!;
  if (netloc.includes("[") !== netloc.includes("]")) return null;
  // urlsplit's _hostinfo: the host and port after the last `@`.
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  let hostname: string;
  let port: string;
  const bracket = hostinfo.indexOf("[");
  if (bracket >= 0) {
    const inside = hostinfo.slice(bracket + 1);
    const close = inside.indexOf("]");
    hostname = close >= 0 ? inside.slice(0, close) : inside;
    const after = close >= 0 ? inside.slice(close + 1) : "";
    port = after.includes(":") ? after.slice(after.indexOf(":") + 1) : "";
  } else {
    const colon = hostinfo.indexOf(":");
    hostname = colon >= 0 ? hostinfo.slice(0, colon) : hostinfo;
    port = colon >= 0 ? hostinfo.slice(colon + 1) : "";
  }
  if (port !== "" && (!/^[0-9]+$/.test(port) || Number(port) > 65535)) return null;
  if (!hostname || netloc.includes("@")) return null;
  // _host_ok
  if (hostinfo.startsWith("[") ? !ipv6(hostname) : !HOSTNAME.test(hostname)) return null;
  if (!paths.includes(path)) return null;
  if (scheme === "https" || (scheme === "http" && LOOPBACK_HOSTS.has(hostname.toLowerCase()))) return `${scheme}://${netloc}`;
  return null;
}

/**
 * Index's REST create URL, `<origin>/api/intents`, or null when no origin
 * passes indexOrigin (then no create is sent and the key goes nowhere new).
 * The origin: `$INDEX_API_URL` (stripped as the plugin strips it) when it is
 * not blank, an origin or `<origin>/api`, never falling back when it is set
 * but refused; else the MCP URL's, when that URL is `<origin>/mcp` (the
 * plugin's api_origin and CREATE_PATH). Unlike the plugin's
 * `_origin_from_mcp_url`, plain http to a loopback MCP URL is kept: the MCP
 * calls already go there with the same key.
 */
export function indexCreateUrl(mcpUrl: string): string | null {
  const configured = (process.env.INDEX_API_URL ?? "").replace(PY_STRIP, "");
  const origin = configured ? indexOrigin(configured, API_URL_PATHS) : indexOrigin(mcpUrl, MCP_URL_PATHS);
  return origin === null ? null : `${origin}/api/intents`;
}

/**
 * One direct create's outcome: a 2xx answer (Index's id when the answer
 * names one it could have issued, else null: then whatever answered may not
 * be Index and may have stored nothing, so the caller counts that line only
 * when Index lists it), or not, with the HTTP status (0: no answer: a
 * transport failure, a refused redirect, `timedOut`, or `badUrl`: no origin
 * passed indexOrigin, so nothing was sent) and, only when the body is
 * Index's `intent_needs_revision` refusal (intentRefusal), that refusal.
 */
export type DirectCreate =
  | { ok: true; id: string | null }
  | { ok: false; status: number; refusal: IntentRefusal | null; timedOut?: boolean; badUrl?: true };

/**
 * One `POST <origin>/api/intents` with `{description, sourceType:
 * "agentvillage"}` and nothing else: no `preparationReceipt` (Index then
 * stores the line as written and runs no admission), no `networkIds` (shared
 * in every network the resident is in). `description` is sent exactly as
 * given. Same key as every Index call, `x-api-key`; JSON only; one request,
 * no retry, the target's timeout, no redirect. The shape is the av-events
 * plugin's production create (`_record_intention.py` publish_intent) and
 * Index's controller (intent.controller.ts `create`, a91c3ff). Never throws:
 * any HTTP answer is a status, a transport failure or timeout is status 0;
 * a URL indexCreateUrl refuses is status 0 with `badUrl`, and no request.
 */
export async function createIntentDirect(target: IndexMcpTarget, description: string): Promise<DirectCreate> {
  const url = indexCreateUrl(target.mcpUrl);
  if (url === null) return { ok: false, status: 0, refusal: null, badUrl: true };
  const send = target.fetch ?? globalThis.fetch;
  let res: Response;
  try {
    res = await send(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": target.apiKey },
      body: JSON.stringify({ description, sourceType: AGENTVILLAGE_SOURCE_TYPE }),
      redirect: "error",
      signal: AbortSignal.timeout(target.timeoutMs ?? INDEX_MCP_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, status: 0, refusal: null, timedOut: isAbort(err) };
  }
  if (res.status >= 200 && res.status < 300) {
    // A 2xx: the id when the answer names one Index could have issued; without one, the caller asks Index's list.
    let id: string | null = null;
    try {
      const intentId = asRecord(await res.json())?.intentId;
      id = typeof intentId === "string" && INTENT_ID.test(intentId) ? intentId : null;
    } catch {
      // No body, or not JSON: id unknown.
    }
    return { ok: true, id };
  }
  let text = "";
  try {
    text = await res.text();
  } catch {
    // The status alone is the answer.
  }
  return { ok: false, status: res.status, refusal: text ? intentRefusal(text) : null };
}
