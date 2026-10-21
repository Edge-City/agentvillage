/**
 * Reference implementation: the Agent Village app server's half of the Edge City Volunteers mini-app
 * (mini-apps/eci-volunteers/README.md is the contract). Edge City's app and control-plane repos are
 * private to the ECV side, so this shows, in code, what that contract asks for. It is reference code for
 * Edge City's app server, not run on any box, and nothing in this repo imports it.
 *
 * One call of `handle()` is one `village` operation from a box:
 *   1. the operation must be one of the manifest's eleven, and its arguments must pass that operation's
 *      `input` schema and `maxRequestBytes` (the box checked them too; the server never trusts the box);
 *   2. confirm only: the confirm rule (a code ECV proposed, for this owner, in an EARLIER turn, unexpired);
 *   3. MCP over streamable HTTP (initialize, notifications/initialized, tools/call) with the one app token
 *      and the owner's Telegram id (and username, when known), inside the operation's timeout and
 *      response budget;
 *   4. ECV's refusals and JSON-RPC errors become the generic codes the box knows; a result becomes
 *      {text, structured, isError}.
 * The answer is `{status, body}`: what the app route sends back to the box. Refusals are
 * `{code}` only, never upstream wording (the box shows its own text for each code).
 *
 * No dependencies: global fetch (injected), node:crypto, and the manifest JSON.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_PATH = join(import.meta.dir, "..", "..", "..", "mini-apps", "eci-volunteers", "manifest.json");
export const PROTOCOL_VERSION = "2025-06-18";
// 15 minutes: longer than ECV's own 10-minute code, so ECV (not this store) is what expires a fresh code.
export const CONFIRM_TTL_MS = 15 * 60 * 1000;
const PROPOSE = "eci-volunteers.propose";
const CONFIRM = "eci-volunteers.confirm";
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
// A refusal body ECV sends before MCP is tiny ({code, detail}); never read more of one than this.
const REFUSAL_BYTES = 4096;

/** The codes the box knows for these operations (plugins/village-bridge/_ecv.py ECV_ERRORS), with their HTTP status. */
export const CODES = {
  invalid_arguments: 422,
  conflict: 409,
  not_connected: 403,
  not_found: 404,
  not_authorized: 403,
  unavailable: 503,
  rate_limited: 429,
  connection_or_request_refused: 502,
  response_too_large: 502,
} as const;
export type Code = keyof typeof CODES;
// ECV's own pre-MCP codes passed through to the box as they are. 401 and 503 are handled before this.
const PASSED_THROUGH = new Set<string>(["not_connected", "not_found", "not_authorized", "rate_limited", "invalid_arguments", "unavailable"]);

export type ToolResult = { text: string; structured: unknown; isError: boolean };
export type Answer = { status: 200; body: ToolResult } | { status: number; body: { code: Code } };
export type Request = {
  ownerTelegramId: string | number;
  ownerTelegramUsername?: string | null;
  operation: string;
  arguments?: unknown;
  turnId?: string;
};
export type ConfirmRecord = { owner: string; turnId: string; expiresAt: number };
/** The confirm-rule store: a shared key-value store with expiry (the app's own, e.g. its database or Redis). */
export interface Store {
  get(key: string): ConfirmRecord | undefined | Promise<ConfirmRecord | undefined>;
  set(key: string, value: ConfirmRecord, ttlMs: number): void | Promise<void>;
  delete(key: string): void | Promise<void>;
}
type Operation = { name: string; class: string; target: { tool: string }; input: Schema; maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number };
type Schema = Record<string, any>;

/** An in-memory Store for tests and a single process; expiry is read from the injected clock. */
export function memoryStore(now: () => number = Date.now): Store & { size(): number } {
  const rows = new Map<string, { value: ConfirmRecord; until: number }>();
  return {
    get(key) {
      const row = rows.get(key);
      if (!row) return undefined;
      if (row.until <= now()) { rows.delete(key); return undefined; }
      return row.value;
    },
    set(key, value, ttlMs) { rows.set(key, { value, until: now() + ttlMs }); },
    delete(key) { rows.delete(key); },
    size() { return rows.size; },
  };
}

export function loadManifest(path = MANIFEST_PATH): Schema {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The JSON Schema subset the manifest's input schemas use. scripts/mini-apps-manifests.cjs checkSchema
 * interprets a similar subset but has no `oneOf` (propose's params are one branch per action), so this
 * is its own small interpreter. A keyword it does not know is refused, so a later manifest edit that
 * uses one fails closed here instead of being silently ignored.
 */
const KNOWN = new Set(["type", "properties", "required", "additionalProperties", "enum", "const", "pattern", "minLength",
  "maxLength", "minimum", "maximum", "minItems", "maxItems", "items", "maxProperties", "oneOf"]);
export function matches(schema: Schema, value: unknown): boolean {
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`eci_volunteers_schema_keyword:${key}`);
  const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case undefined: break;
    case "object": if (!isObject(value)) return false; break;
    case "array": if (!Array.isArray(value)) return false; break;
    case "string": if (typeof value !== "string") return false; break;
    case "boolean": if (typeof value !== "boolean") return false; break;
    case "integer": if (!Number.isInteger(value)) return false; break;
    default: throw new Error(`eci_volunteers_schema_type:${schema.type}`);
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
    const keys = Object.keys(value);
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) return false;
    if ((schema.required || []).some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const key of keys) {
      if (schema.properties && Object.hasOwn(schema.properties, key)) { if (!matches(schema.properties[key], value[key])) return false; }
      else if (schema.additionalProperties === false) return false;
    }
  }
  if (schema.oneOf && schema.oneOf.filter((branch: Schema) => matches(branch, value)).length !== 1) return false;
  return true;
}

class Refusal extends Error {
  constructor(readonly code: Code) { super(code); }
}
const refuse = (code: Code): Answer => ({ status: CODES[code], body: { code } });
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

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
 * The JSON-RPC response to request `id` in a streamable-HTTP answer: a JSON body, or a text/event-stream
 * whose events carry messages in `data:` lines. The server may send notifications before the response,
 * so the first message with this id is taken, not simply the first message.
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

export function createEciVolunteersBridge(options: {
  token: string;
  fetch: typeof fetch;
  store: Store;
  baseUrl?: string;
  now?: () => number;
  manifest?: Schema;
  /** Operational events only (never the token, arguments or ECV's answers). */
  log?: (event: string, detail?: Record<string, unknown>) => void;
}) {
  const manifest = options.manifest ?? loadManifest();
  const baseUrl = options.baseUrl ?? manifest.service.baseUrl;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((event, detail) => console.error(`eci-volunteers: ${event}`, detail ?? {}));
  const operations = new Map<string, Operation>(manifest.operations.map((op: Operation) => [op.name, op]));
  if (!options.token) throw new Error("MINI_APP_ECI_VOLUNTEERS_TOKEN is not set");

  async function handle(request: Request): Promise<Answer> {
    try {
      return await run(request);
    } catch (error) {
      if (error instanceof Refusal) return refuse(error.code);
      // A timeout (AbortError), a network failure or an unparseable answer: the box tells the agent not to
      // claim a change and to read before proposing again.
      log("call_failed", { operation: request.operation, reason: error instanceof Error ? error.name : "unknown" });
      return refuse("connection_or_request_refused");
    }
  }

  async function run(request: Request): Promise<Answer> {
    const op = operations.get(request.operation);
    const args = request.arguments ?? {};
    const owner = String(request.ownerTelegramId ?? "");
    // The owner comes from the paired Telegram account (pairing verified it), never from the box.
    if (!/^[1-9][0-9]{0,19}$/.test(owner)) throw new Error("owner telegram id missing");
    if (!op || !matches(op.input, args)) return refuse("invalid_arguments");
    if (Buffer.byteLength(JSON.stringify(args)) > op.maxRequestBytes) return refuse("invalid_arguments");
    const twoStep = op.name === PROPOSE || op.name === CONFIRM;
    // turnId is the box's trusted UUIDv5 of session and message; propose and confirm always carry it.
    if (twoStep && !(typeof request.turnId === "string" && UUID.test(request.turnId))) return refuse("invalid_arguments");

    let key: string | undefined;
    if (op.name === CONFIRM) {
      // The confirm rule: ECV's yes must come in a later owner message than the propose that showed it.
      key = sha256((args as { code: string }).code);
      const record = await options.store.get(key);
      if (!record || record.owner !== owner || record.expiresAt <= now() || record.turnId === request.turnId) return refuse("conflict");
    }

    const result = await callTool(op, owner, request.ownerTelegramUsername, args);

    if (op.name === PROPOSE && !result.isError) {
      const code = (result.structured as { code?: unknown } | null)?.code;
      // Only a hash and who/when: never the code itself, shift text or any of ECV's answer.
      if (typeof code === "string") {
        await options.store.set(sha256(code), { owner, turnId: request.turnId!, expiresAt: now() + CONFIRM_TTL_MS }, CONFIRM_TTL_MS);
      }
    }
    // After a confirm the record is KEPT until it expires, not deleted. ECV's confirm is idempotent (the
    // same code again returns the first result and makes no second change), so keeping it costs nothing,
    // and it lets a retry after an uncertain answer (a timeout, a dropped connection) learn what actually
    // happened instead of getting `conflict`, which would tell the agent to ask the owner again.
    return { status: 200, body: result };
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
      // The username, when Agent Village knows it, lets ECV refuse a stale id-to-volunteer record (a
      // Telegram username can be given up and taken by someone else). A malformed one is left out
      // rather than sent; Telegram usernames are letters, digits and underscores.
      const name = typeof username === "string" ? username.replace(/^@/, "") : "";
      if (/^[A-Za-z0-9_]{1,32}$/.test(name)) headers["X-Agent-Village-Telegram-Username"] = name;
      else if (name) log("username_malformed_not_sent");

      const post = async (message: object): Promise<Response> => {
        const response = await options.fetch(baseUrl, { method: "POST", headers, body: JSON.stringify(message), signal: abort.signal, redirect: "error" });
        if (!response.ok) await refusalOf(response);
        return response;
      };
      const rpc = async (id: number, method: string, params: object): Promise<any> => {
        const response = await post({ jsonrpc: "2.0", id, method, params });
        const message = rpcMessage(response.headers.get("content-type") ?? "", await readCapped(response, op.maxResponseBytes), id);
        if (message.error) throw new Refusal(message.error.code === -32602 ? "invalid_arguments" : "connection_or_request_refused");
        if (!message.result || typeof message.result !== "object") throw new Refusal("connection_or_request_refused");
        return message.result;
      };

      const init = await options.fetch(baseUrl, {
        method: "POST", headers, signal: abort.signal, redirect: "error",
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize",
          params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agent-village", version: manifest.version } } }),
      });
      if (!init.ok) await refusalOf(init);
      const initMessage = rpcMessage(init.headers.get("content-type") ?? "", await readCapped(init, op.maxResponseBytes), 1);
      if (initMessage.error || !initMessage.result) throw new Refusal("connection_or_request_refused");
      // ECV is stateless and may not return a session; carry one if it does.
      const session = init.headers.get("mcp-session-id");
      if (session) headers["Mcp-Session-Id"] = session;
      headers["MCP-Protocol-Version"] = initMessage.result.protocolVersion ?? PROTOCOL_VERSION;

      const notified = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      await notified.body?.cancel().catch(() => {});

      const result = await rpc(2, "tools/call", { name: op.target.tool, arguments: args });
      const text = (Array.isArray(result.content) ? result.content : [])
        .filter((part: any) => part && part.type === "text" && typeof part.text === "string")
        .map((part: any) => part.text)
        .join("\n\n");
      return { text, structured: result.structuredContent ?? null, isError: result.isError === true };
    } finally {
      clearTimeout(timer);
    }
  }

  /** ECV's refusals before MCP, as the generic codes. Throws; never returns. */
  async function refusalOf(response: Response): Promise<never> {
    if (response.status === 401) {
      // A wrong or missing token is Agent Village's configuration, not the volunteer's: the box says
      // "unavailable", never the volunteer text for not_authorized.
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
