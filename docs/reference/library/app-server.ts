/**
 * Reference implementation: the Agent Village app server's half of the Edge Library mini-app
 * (mini-apps/library/README.md is the contract). Edge City's app and control-plane repos are private, so this
 * shows, in code, what that contract asks for. It is reference code for Edge City's app server, not run on any
 * box, and nothing in this repo imports it. Its shape follows docs/reference/eci-volunteers/ (the same app-token
 * link), without the confirm rule: Edge Library's writes are single calls the owner asked for.
 *
 * One call of `handle()` is one `village` operation from a box:
 *   1. the operation must be one of the manifest's eleven, and its arguments must pass that operation's `input`
 *      schema and `maxRequestBytes` (the box checked them too; the server never trusts the box);
 *   2. MCP over streamable HTTP (initialize, notifications/initialized, tools/call) with the one app token and
 *      the owner's Telegram id (and username, when known), inside the operation's timeout and response budget;
 *   3. Edge Library's refusals before MCP (401, 403) and JSON-RPC errors become the generic codes the box knows; a
 *      tool's own refusal (isError, structuredContent {code, detail}) is an operational code for the box when it
 *      is rate_limited, not_connected or unavailable, and otherwise data the agent can act on (invalid_arguments,
 *      not_found, not_authorized, conflict, with Edge Library's detail); a result becomes {text, structured, isError},
 *      with `text` left empty when it is only the JSON of `structured`.
 * The answer is `{status, body}`: what the app route sends back to the box. Refusals are `{code}` only, never
 * upstream wording (the box shows its own text for each code).
 *
 * No dependencies: global fetch (injected) and the manifest JSON.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_PATH = join(import.meta.dir, "..", "..", "..", "mini-apps", "library", "manifest.json");
export const PROTOCOL_VERSION = "2025-06-18";
// A refusal body Edge Library sends before MCP is tiny ({code, detail}); never read more of one than this.
const REFUSAL_BYTES = 4096;

/** The codes the box knows for these operations (plugins/village-bridge/_library.py LIBRARY_ERRORS), with their HTTP status. */
export const CODES = {
  invalid_arguments: 422,
  not_connected: 403,
  not_authorized: 403,
  unavailable: 503,
  rate_limited: 429,
  connection_or_request_refused: 502,
  response_too_large: 502,
} as const;
export type Code = keyof typeof CODES;
// Edge Library's own pre-MCP codes passed through to the box as they are. 401 and 503 are handled before this; today
// Edge Library sends only 403 not_authorized here (the Agent Village agent revoked: the whole link is off).
const PASSED_THROUGH = new Set<string>(["not_authorized", "rate_limited", "invalid_arguments", "unavailable"]);
// A tool refusal with one of these codes is about the link, not the arguments: the box shows its own text.
const OPERATIONAL = new Set<string>(["rate_limited", "not_connected", "unavailable"]);
// Edge Library's limits on the identity headers (services/mcp/agent-village.ts): a value outside them is a 401.
const TELEGRAM_ID = /^[1-9][0-9]{0,15}$/;
const USERNAME = /^[A-Za-z0-9_]{4,32}$/;

export type ToolResult = { text: string; structured: unknown; isError: boolean };
export type Answer = { status: 200; body: ToolResult } | { status: number; body: { code: Code } };
export type Request = {
  ownerTelegramId: string | number;
  ownerTelegramUsername?: string | null;
  operation: string;
  arguments?: unknown;
};
type Operation = { name: string; class: string; target: { tool: string }; input: Schema; maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number };
type Schema = Record<string, any>;

export function loadManifest(path = MANIFEST_PATH): Schema {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The JSON Schema subset the manifest's input schemas use (Edge Library's zod schemas through z.toJSONSchema):
 * object/array/string/integer/number/boolean/null, const, enum, pattern, lengths, bounds, items, properties,
 * required, additionalProperties (false or a schema), propertyNames, anyOf and oneOf. A keyword it does not know
 * is refused, so a later manifest edit that uses one fails closed here instead of being silently ignored.
 */
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "propertyNames", "enum", "const", "pattern",
  "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems", "items", "anyOf", "oneOf"]);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export function matches(schema: Schema, value: unknown): boolean {
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`library_schema_keyword:${key}`);
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case undefined: break;
    case "object": if (!isObject(value)) return false; break;
    case "array": if (!Array.isArray(value)) return false; break;
    case "string": if (typeof value !== "string") return false; break;
    case "boolean": if (typeof value !== "boolean") return false; break;
    case "null": if (value !== null) return false; break;
    case "integer": if (!Number.isInteger(value)) return false; break;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) return false; break;
    default: throw new Error(`library_schema_type:${schema.type}`);
  }
  if (typeof value === "string") {
    const length = [...value].length; // code points, as JSON Schema counts them
    if (schema.minLength !== undefined && length < schema.minLength) return false;
    if (schema.maxLength !== undefined && length > schema.maxLength) return false;
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every(item => matches(schema.items, item))) return false;
  }
  if (isObject(value)) {
    if ((schema.required || []).some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const key of Object.keys(value)) {
      if (schema.propertyNames && !matches(schema.propertyNames, key)) return false;
      if (schema.properties && Object.hasOwn(schema.properties, key)) { if (!matches(schema.properties[key], value[key])) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (isObject(schema.additionalProperties) && !matches(schema.additionalProperties, value[key])) return false;
    }
  }
  if (schema.anyOf && !schema.anyOf.some((branch: Schema) => matches(branch, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((branch: Schema) => matches(branch, value)).length !== 1) return false;
  return true;
}

class Refusal extends Error {
  constructor(readonly code: Code) { super(code); }
}
const refuse = (code: Code): Answer => ({ status: CODES[code], body: { code } });

/** Reads at most `limit` bytes of a body; a longer body is cancelled and refused, never parsed in part. */
async function readCapped(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new Refusal("response_too_large"); }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * The JSON-RPC response to request `id` in a streamable-HTTP answer: a JSON body, or a text/event-stream whose
 * events carry messages in `data:` lines. The server may send notifications before the response, so the first
 * message with this id is taken, not simply the first message.
 */
function rpcMessage(contentType: string, body: string, id: number): any {
  if (!contentType.toLowerCase().startsWith("text/event-stream")) return JSON.parse(body);
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
    if (!data) continue;
    const message = JSON.parse(data);
    if (message && message.id === id) return message;
  }
  throw new Refusal("connection_or_request_refused");
}

export function createLibraryBridge(options: {
  token: string;
  fetch: typeof fetch;
  baseUrl?: string;
  manifest?: Schema;
  /** Operational events only (never the token, arguments or Edge Library's answers). */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}) {
  const manifest = options.manifest ?? loadManifest();
  const baseUrl = options.baseUrl ?? manifest.service.baseUrl;
  const log = options.log ?? ((event, detail) => console.error(`library: ${event}`, detail ?? {}));
  const operations = new Map<string, Operation>(manifest.operations.map((op: Operation) => [op.name, op]));
  if (!options.token) throw new Error("MINI_APP_LIBRARY_TOKEN is not set");

  async function handle(request: Request): Promise<Answer> {
    try {
      return await run(request);
    } catch (error) {
      if (error instanceof Refusal) return refuse(error.code);
      // A timeout (AbortError), a network failure or an unparseable answer: the box tells the agent not to claim
      // a write landed and to read before writing again.
      log("call_failed", { operation: request.operation, reason: error instanceof Error ? error.name : "unknown" });
      return refuse("connection_or_request_refused");
    }
  }

  async function run(request: Request): Promise<Answer> {
    const op = operations.get(request.operation);
    const args = request.arguments ?? {};
    const owner = String(request.ownerTelegramId ?? "");
    // The owner comes from the paired Telegram account (pairing verified it), never from the box.
    if (!TELEGRAM_ID.test(owner) || !Number.isSafeInteger(Number(owner))) throw new Error("owner telegram id missing");
    if (!op || !matches(op.input, args)) return refuse("invalid_arguments");
    if (Buffer.byteLength(JSON.stringify(args)) > op.maxRequestBytes) return refuse("invalid_arguments");
    return { status: 200, body: await callTool(op, owner, request.ownerTelegramUsername, args) };
  }

  async function callTool(op: Operation, owner: string, username: string | null | undefined, args: unknown): Promise<ToolResult> {
    const abort = new AbortController();
    // One budget for the whole operation (all three requests), as the manifest's timeoutMs means it.
    const timer = setTimeout(() => abort.abort(), op.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${options.token}`,
        "X-Agent-Village-Telegram-User-Id": owner,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      };
      // The username, when Agent Village knows it, refreshes Edge Library's record (pairing is the source of truth: a
      // different username is accepted, never refused). A malformed one is left out: Edge Library answers it 401.
      const name = typeof username === "string" ? username.replace(/^@/, "") : "";
      if (USERNAME.test(name)) headers["X-Agent-Village-Telegram-Username"] = name;
      else if (name) log("username_malformed_not_sent");

      const post = async (message: object): Promise<Response> => {
        const response = await options.fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(message), signal: abort.signal, redirect: "error" });
        if (!response.ok) await refusalOf(response);
        return response;
      };

      const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize",
        params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agent-village", version: manifest.version } } });
      const initMessage = rpcMessage(init.headers.get("content-type") ?? "", await readCapped(init, op.maxResponseBytes), 1);
      if (initMessage.error || !initMessage.result) throw new Refusal("connection_or_request_refused");
      // Edge Library is stateless (one server per request) and returns no session today; carry one if it ever does.
      const session = init.headers.get("mcp-session-id");
      if (session) headers["Mcp-Session-Id"] = session;
      headers["MCP-Protocol-Version"] = initMessage.result.protocolVersion ?? PROTOCOL_VERSION;

      const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      await notified.body?.cancel().catch(() => {});

      const called = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: op.target.tool, arguments: args } });
      const message = rpcMessage(called.headers.get("content-type") ?? "", await readCapped(called, op.maxResponseBytes), 2);
      if (message.error) throw new Refusal(message.error.code === -32602 ? "invalid_arguments" : "connection_or_request_refused");
      const result = message.result;
      if (!result || typeof result !== "object") throw new Refusal("connection_or_request_refused");
      const structured = result.structuredContent ?? null;
      const refusal = result.isError === true && isObject(structured) ? structured.code : undefined;
      if (typeof refusal === "string" && OPERATIONAL.has(refusal)) throw new Refusal(refusal as Code);
      let text = (Array.isArray(result.content) ? result.content : [])
        .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n\n");
      // Edge Library writes most results only as JSON: its text is then JSON.stringify(structuredContent). Sent
      // once, as `structured`, so a large answer is not carried twice inside the box's byte limit.
      if (structured !== null && text === JSON.stringify(structured)) text = "";
      return { text, structured, isError: result.isError === true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Edge Library's refusals before MCP, as the generic codes. Throws; never returns. */
  async function refusalOf(response: Response): Promise<never> {
    if (response.status === 401) {
      // A wrong or missing token is Agent Village's configuration, not the resident's: the box says
      // "unavailable", never the resident text for not_authorized.
      log("config_error_token_refused", { status: 401 });
      throw new Refusal("unavailable");
    }
    if (response.status === 503) throw new Refusal("unavailable");
    let code: unknown;
    try {
      code = JSON.parse(await readCapped(response, REFUSAL_BYTES))?.code;
    } catch {
      code = undefined;
    }
    if (response.status >= 400 && response.status < 500 && typeof code === "string" && PASSED_THROUGH.has(code)) throw new Refusal(code as Code);
    throw new Refusal("connection_or_request_refused");
  }

  return { handle, operations: [...operations.keys()] };
}
