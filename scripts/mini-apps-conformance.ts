#!/usr/bin/env bun
/**
 * Mini-apps v2 conformance v0 + v1 (MINIAPPS-PLATFORM-v2-design.md section 5.3, section 8 Phase 0 item 5).
 * The developer runs it on their manifest; CI runs it AGAIN on the PR itself and reads the conformance.json
 * that its own run wrote. A conformance.json is self-attested (anyone can hand-write one): never trust a
 * committed or uploaded copy; regenerate it.
 *
 *   bun run conformance -- mini-apps/<id>/manifest.json [--fixtures <dir>] [--out <path>] [--base <git ref>]
 *                          [--service <https base url of YOUR OWN sandbox>]
 *
 * v0 runs section 5.3 items 1, 4 (template, static part) and 5. v1 adds items 2-3 (service reachability and
 * budgets) and live error bodies, run ONLY with --service against the developer's own sandbox endpoint:
 * without --service they are not_run. They are ADVISORY (v1 does not gate yet): each note starts
 * "advisory (v1): ", and pass, fail or not_run, they never change `passed` or the exit code. The rest of item
 * 4 (the fake cp: wrong draftId, changed hash, no grant, idempotency) needs a card: always not_run.
 *
 * Item 1  manifest.validator_pin  the ONE shared validator (scripts/mini-apps-manifests.cjs, P0-1) and the
 *                                 schema file hash to mini-apps/manifests.pins.json; a mismatch REFUSES
 *                                 (exit 2, no conformance.json). The bytes hashed are the bytes run.
 *         manifest.schema         strict JSON (no duplicate keys), then validateManifest(); id = its directory
 *         skills.sha256           every skills[].sha256 is sha256 of the file's bytes
 *         version.bump            with --base: the semver bump covers the diff class (major for a widened op,
 *                                 budget, auth/service, data, events or summary; an input-schema edit of
 *                                 annotations only is a patch); a downgrade (1.0.0 -> 1.0.0-rc.1 too) fails;
 *                                 a base blob that is not in the local object store (a blob-less partial
 *                                 clone) REFUSES; without --base: not_run
 * Item 4  approval.prepare_pair   static: every needs-card op names a prepare-class op of this manifest
 *         approval.summary_render not_run "renderer_absent": no section 3.2 renderer exists in Node or Python
 *                                 yet (Phase 1 item 6); v0 never renders a card itself
 * Item 2  service.reachability    (--service) mcp: initialize answers 2025-06-18 and tools/list holds every
 *                                 target.tool with a compatible inputSchema; https-json: each read op's
 *                                 path answers 2xx or a documented 4xx; oauth/app-token: refused without a token
 * Item 3  service.budgets         (--service) each read op answers its <op>/<name>.request.json within
 *                                 timeoutMs and maxResponseBytes, shaped like <name>.json, strict, no secret
 *         service.error_bodies    (--service) each <op>/error*.request.json is answered with exactly
 *                                 {code, detail} and the closed code of its error fixture
 * Item 5  hygiene.fixtures        the fixture layout below is closed
 *         hygiene.secrets         no key or string matches a secret pattern (the note never echoes it)
 *         hygiene.duplicate_keys  every fixture is strict JSON with no duplicate key at any depth
 *         hygiene.error_bodies    every error fixture is exactly {code, detail} with code from a closed set
 *                                 (mcp: or a well-formed MCP error answer, see below)
 *
 * Fixtures (--fixtures <dir>; default mini-apps/<id>/fixtures/ when present; none: item 5 is not_run):
 *   <dir>/<operation name>/<name>.json   one response body the service returns for that op
 *   <dir>/<operation name>/<name>.request.json   (read ops only; v1) the arguments --service sends, paired
 *                                         with <name>.json, the answer it expects; at most maxRequestBytes
 *   a file whose name starts with "error" is an error body; every other file is a success body. A
 *   .request.json file is neither: it is strict JSON, secret-scanned, and a JSON object of arguments.
 * No symlinks, no other files, no nested directories, no file over the op's maxResponseBytes.
 * For an mcp service a success fixture is the tools/call `result` object (what the app server returns); an
 * error fixture is the {code, detail} an isError result carries (structuredContent, or its one text item),
 * or the MCP error answer itself (protocol 2025-06-18): an isError result with a content array, or a
 * JSON-RPC error {code: integer, message: string}, bare or in its JSON-RPC response (jsonrpc "2.0", an id,
 * exactly one of result/error). An mcp fixture that is plainly such an answer (isError true, or a JSON-RPC
 * error response) is an error fixture whatever its name. A malformed envelope fails; a {code, ...} that an
 * isError result carries still needs exactly {code, detail} with a closed code. Live (--service), an error
 * call conforms with a well-formed isError result or JSON-RPC error of its fixture's kind and code.
 *
 * --service network rules (serviceTarget, pinAddress, exchange): the URL passes the shared validator's
 * endpointRefusal (https, a public DNS name, no IP, port, userinfo, query or internal suffix) and is not an
 * Agent Village host; the name is resolved ONCE and refused (exit 2, before any connection) when ANY address
 * is private, loopback, link-local, metadata or special-purpose; every connection goes to that one checked
 * address (TLS verified for the name), so a rebinding resolver is never asked again; no redirect is ever
 * followed; every exchange has the op's timeoutMs and maxResponseBytes (session calls: the defaults);
 * every request carries only a fixed header list, never a credential, cookie or token. No prepare, write or
 * needs-card target is ever called.
 *
 * conformance.json (--out): {manifest, sha256, results: [{check, pass, note}], passed}. `manifest` is the
 * repo-relative path; `sha256` is over the manifest file's exact bytes. A not_run check has pass null.
 * `passed` is true only when every check that ran passed, and item 1 (pin, schema, skills) and item 5 ran;
 * the advisory v1 service.* rows are reported but never counted.
 * Output: the summary always goes to stdout. A file is written ONLY with --out, and never by default:
 * --out may not be the manifest, or anywhere inside the manifest's repo or the tool's root (compared by
 * dev+ino, and case-folded on a case-insensitive filesystem), so CI writes it to a temp dir, e.g.
 * --out "$RUNNER_TEMP/conformance.json". Every argument is checked before any file is touched: an
 * argument refusal (exit 2) changes nothing. A file already at --out must be this manifest's own
 * conformance.json (anything else is refused and left alone); it is removed before the run, and the new
 * report is written to a temp file renamed into place only on exit 0 or 1. On any other exit 2, only a
 * file that parses as this manifest's conformance.json is removed. So read the exit code, never the file.
 * Exit codes: 0 passed, 1 failed, 2 refused (bad arguments, a validator pin mismatch, a base blob that is
 * not local, an unsafe --out, a --service URL or address refused, an internal error).
 * Without --service: no network, no credentials; it reads local files and, for --base only, the local git
 * object store. With --service: only the one checked address of that one host, and still no credentials.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { lstatSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

export type Result = { check: string; pass: boolean | null; note: string };
export type Report = { manifest: string; sha256: string; results: Result[]; passed: boolean };
export class Refusal extends Error {
  constructor(public reason: string) { super(reason); }
}

/**
 * Every check, in output order. REQUIRED must have run (pass not null) for `passed`. The v1 service.* rows
 * are ADVISORY (owner ruling on ov#438: v1 does not gate yet): they report pass, fail or not_run, each note
 * marked "advisory (v1): ", and none of them, run or not, passed or failed, ever changes `passed`.
 */
export const CHECKS = [
  "manifest.validator_pin", "manifest.schema", "skills.sha256", "version.bump",
  "service.reachability", "service.budgets", "service.error_bodies",
  "approval.prepare_pair", "approval.summary_render", "approval.fake_cp",
  "hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies",
] as const;
export const REQUIRED = new Set<string>([
  "manifest.validator_pin", "manifest.schema", "skills.sha256",
  "hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies",
]);
/** The v1 service rows: reported, never gating (passedOf skips them). */
export const ADVISORY = new Set<string>(["service.reachability", "service.budgets", "service.error_bodies"]);
export const ADVISORY_MARK = "advisory (v1): ";
const pass = (check: string, note: string): Result => ({ check, pass: true, note });
const fail = (check: string, note: string): Result => ({ check, pass: false, note });
const notRun = (check: string, note: string): Result => ({ check, pass: null, note });

/**
 * passed: every check that ran passed, and every REQUIRED check ran. not_run (null) is never a pass. An
 * ADVISORY row (v1 service.*) is reported but skipped here: a failed one leaves `passed` as the rest say.
 */
export function passedOf(results: Result[]): boolean {
  if (!results.length) return false;
  if (![...REQUIRED].every(check => results.some(r => r.check === check && r.pass === true))) return false;
  return results.every(r => ADVISORY.has(r.check) || r.pass === true || (r.pass === null && !REQUIRED.has(r.check)));
}

const HEX64 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 1 << 20;
const MAX_FIXTURE_FILES = 2000;
const MAX_NOTE_ITEMS = 12;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

// ---- The shared validator, loaded from the exact bytes its pin names -------------------------------
export type Validator = {
  MANIFEST_VERSION: number;
  validateManifest: (value: unknown, opts?: object) => { ok: boolean; errors?: { path: string; reason: string }[] };
  operationBudgets: (op: object) => { maxRequestBytes: number; maxResponseBytes: number; timeoutMs: number; framing: string };
  /** P0-1's one endpoint rule (exported by the pinned module); --service needs it. */
  endpointRefusal?: (value: unknown) => string | null;
};
function regularFile(path: string, reason: string): Buffer {
  let st;
  try { st = lstatSync(path); } catch { throw new Refusal(`${reason}_missing`); }
  if (!st.isFile()) throw new Refusal(`${reason}_not_a_regular_file`);
  return readFileSync(path);
}
/**
 * P0-1's validator (never a second one). The module's and the schema file's sha256 must equal
 * mini-apps/manifests.pins.json, else Refusal (fail closed). The module is compiled from the very bytes
 * that were hashed (no require cache, no second read); it has no dependencies and no I/O by design.
 */
export function loadValidator(toolRoot: string): { validator: Validator; moduleSha: string } {
  const pinsBytes = regularFile(join(toolRoot, "mini-apps", "manifests.pins.json"), "pins");
  let pins: any;
  try { pins = JSON.parse(pinsBytes.toString("utf8")); } catch { throw new Refusal("pins_unparseable"); }
  const want = isObject(pins) ? pins.sha256 : null;
  if (!isObject(want) || !HEX64.test(String(want.module)) || !HEX64.test(String(want.schema))) throw new Refusal("pins_malformed");
  const source = regularFile(join(toolRoot, "scripts", "mini-apps-manifests.cjs"), "validator");
  const schema = regularFile(join(toolRoot, "mini-apps", "manifest.v2.schema.json"), "schema");
  const moduleSha = sha256(source);
  if (moduleSha !== want.module) throw new Refusal("validator_sha_mismatch");
  if (sha256(schema) !== want.schema) throw new Refusal("schema_sha_mismatch");
  const mod: { exports: any } = { exports: {} };
  try {
    new Function("module", "exports", source.toString("utf8"))(mod, mod.exports);
  } catch { throw new Refusal("validator_unloadable"); }
  const v = mod.exports;
  if (!v || v.MANIFEST_VERSION !== 2 || typeof v.validateManifest !== "function" || typeof v.operationBudgets !== "function") {
    throw new Refusal("validator_unexpected_exports");
  }
  return { validator: v as Validator, moduleSha };
}

// ---- Strict JSON: a raw-text scan, because JSON.parse keeps the last of two equal keys --------------
export type Pointer = string[];
export type StrictJson =
  | { ok: true; value: unknown; duplicates: { at: Pointer; key: string }[] }
  | { ok: false; error: string };
const MAX_DEPTH = 256;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const SIMPLE_ESCAPES: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
class JsonError extends Error {}
/**
 * RFC 8259 JSON, strictly: only space/tab/LF/CR between tokens (a BOM is refused), no raw control
 * character in a string, only the eight simple escapes and \uXXXX. Keys are compared after decoding, so
 * "a" and "a" are the same key, as they are to JSON.parse and to Python's json. Every object
 * (nested, or inside an array) is its own scope. The value is then JSON.parse's.
 */
export function strictJson(text: string): StrictJson {
  const duplicates: { at: Pointer; key: string }[] = [];
  let i = 0;
  const n = text.length;
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) i++;
      else break;
    }
  };
  const str = (): string => {
    i++; // the opening quote
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) throw new JsonError("unterminated_string");
      const c = text.charCodeAt(i);
      if (c === 0x22) { out += text.slice(start, i); i++; return out; }
      if (c < 0x20) throw new JsonError("control_character_in_string");
      if (c === 0x5c) {
        out += text.slice(start, i);
        const e = text[i + 1];
        if (e !== undefined && own(SIMPLE_ESCAPES, e)) { out += SIMPLE_ESCAPES[e]; i += 2; }
        else if (e === "u" && HEX4.test(text.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(text.slice(i + 2, i + 6), 16)); i += 6; }
        else throw new JsonError("bad_escape");
        start = i;
        continue;
      }
      i++;
    }
  };
  const value = (at: Pointer, depth: number): void => {
    if (depth > MAX_DEPTH) throw new JsonError("too_deep");
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const keys = new Set<string>();
      ws();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        ws();
        if (text[i] !== '"') throw new JsonError("expected_key");
        const key = str();
        if (keys.has(key)) duplicates.push({ at, key });
        keys.add(key);
        ws();
        if (text[i] !== ":") throw new JsonError("expected_colon");
        i++;
        value([...at, key], depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        throw new JsonError("expected_comma_or_brace");
      }
    }
    if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") { i++; return; }
      for (let index = 0; ; index++) {
        value([...at, String(index)], depth + 1);
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        throw new JsonError("expected_comma_or_bracket");
      }
    }
    if (c === '"') { str(); return; }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) { i += word.length; return; }
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(text);
    if (!m || m[0] === "" ) throw new JsonError("unexpected_token");
    i += m[0].length;
  };
  try {
    value([], 0);
    ws();
    if (i !== n) throw new JsonError("trailing_data");
  } catch (e) {
    if (e instanceof JsonError) return { ok: false, error: e.message };
    throw e;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { ok: false, error: "json_parse_disagrees" }; }
  return { ok: true, value: parsed, duplicates };
}
/** UTF-8 bytes to text, refusing invalid UTF-8 and keeping a BOM so strictJson refuses it. */
function utf8(bytes: Uint8Array): string | null {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return null; }
}

// ---- Secret patterns (section 6.1's list; the validator's own scan, which covers manifests, is not exported)
/**
 * Over every key and string of a fixture after decoding (so an escaped secret is still found). Kept
 * aligned with FORBIDDEN_TEXT in scripts/mini-apps-manifests.cjs, plus the response-side shapes: bearer
 * values, the bridge's own avb_ token, AWS secret assignments, Stripe/Google/npm keys, URL userinfo with a
 * password, Basic credentials. `password:` only in a shape prose does not take (password_colon), since
 * response prose says "Password: reset it ...". An assignment pattern runs on to the end of its value, so redact()
 * removes the value too, not only the key. Every pattern is linear: no `\b` (or other zero-width start)
 * in front of an unbounded run that can then fail, which is quadratic on "eyJ-eyJ-..." (the JWT shape
 * uses a lookbehind instead; P0-1's pinned validator still has the `\b` form, a P0-1 fix).
 */
export const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["sk_key", /\bsk-[A-Za-z0-9_-]{16,}/],
  ["stripe_key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["github_token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9_]{20,}/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["jwt", /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./],
  ["pem_private_key", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/],
  ["aws_access_key_id", /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/],
  ["aws_secret_assignment", /aws_?secret_?access_?key["']?\s*[=:]\s*(?:"[^"\n]*"?|'[^'\n]*'?|\S*)/i],
  ["password_assignment", /\b(?:pass(?:word|wd)|passphrase)\s*=\s*(?:"[^"\n]*"?|'[^'\n]*'?|\S*)/i],
  // The colon form (review-b fold-2 N-c), without the prose false positives "Password: reset it here" and
  // 'Password: "set it later"': a quoted key ("password": ...), or after a bare key a bare value of 6-64
  // non-space characters holding a digit or a symbol. Every
  // run is bounded, so it stays linear on "password:password:...".
  ["password_colon", /\b(?:pass(?:word|wd)|passphrase)(?:["']\s*:\s*(?:"[^"\n]{1,256}"?|'[^'\n]{1,256}'?|[^\s"',;]{1,64})|\s*:\s*(?=[^\s"',;]{0,63}[0-9!@#$%^&*+=?~_])[^\s"',;]{6,64})/i],
  ["bearer_value", /\bbearer\s+[A-Za-z0-9._~+/-]{20,}/i],
  ["av_bridge_token", /\bavb_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}/],
  ["npm_token", /\bnpm_[A-Za-z0-9]{36}/],
  // A quoted value runs to its closing quote, spaces included (api_key="abcd efgh ijkl").
  ["token_assignment", /\b(?:api[_-]?key|api[_-]?token|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|secret[_-]?key|session[_-]?id)["']?\s*[=:]\s*(?:"[^"\n]{12,}"?|'[^'\n]{12,}'?|[A-Za-z0-9._~+/-]{12,})/i],
  // scheme://user:password@, the user possibly empty (redis://:pw@host); a URL without a password, or
  // host:port, does not match.
  ["url_userinfo", /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@:]*:[^\s/?#@]+@/],
  // A Basic credential after an Authorization header name ("Basic subscription" alone is prose; a value
  // held by an "Authorization" key is caught by AUTH_HEADER_KEYS below).
  ["basic_auth", /authorization["']?\s*[=:]\s*["']?basic\s+[A-Za-z0-9+/]{8,}={0,2}/i],
];
/** A key that names a credential, holding a non-empty string, is a secret whatever the value looks like. */
const SECRET_KEY_NAMES = new Set(["password", "passwd", "secret", "clientsecret", "apikey", "accesstoken", "refreshtoken",
  "idtoken", "authtoken", "bearertoken", "sessiontoken", "privatekey", "awssecretaccesskey",
  "secretkey", "xapikey", "token", "apisecret", "setcookie", "cookie", "apitoken", "passphrase", "sessionid"]);
/** An Authorization header held as a key: its value is a credential when it names an auth scheme. */
const AUTH_HEADER_KEYS = new Set(["authorization", "proxyauthorization"]);
const AUTH_SCHEME_VALUE = /^\s*(?:basic|bearer|digest|negotiate|token|apikey)\s+\S{8,}/i;
export function secretPattern(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return name;
  return null;
}
const normalKey = (key: string) => key.toLowerCase().replace(/[-_]/g, "");
const secretKeyName = (key: string) => SECRET_KEY_NAMES.has(normalKey(key));
/** Findings as [pointer, pattern]; a pointer never carries a secret-shaped segment (see show()). */
export function secretFindings(value: unknown, at: Pointer = [], out: [Pointer, string][] = []): [Pointer, string][] {
  if (typeof value === "string") {
    const hit = secretPattern(value);
    if (hit) out.push([at, hit]);
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => secretFindings(item, [...at, String(index)], out));
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      const hit = secretPattern(key);
      if (hit) out.push([[...at, key], `${hit}, in a key`]);
      const v = value[key];
      if (secretKeyName(key) && typeof v === "string" && v.trim() !== "") out.push([[...at, key], "secret_key_name"]);
      else if (AUTH_HEADER_KEYS.has(normalKey(key)) && typeof v === "string" && AUTH_SCHEME_VALUE.test(v)) out.push([[...at, key], "authorization_header"]);
      secretFindings(v, [...at, key], out);
    }
  }
  return out;
}
/** A JSON pointer for a note: secret-shaped or long segments are never printed as they are. */
export function show(at: Pointer): string {
  if (!at.length) return "/";
  return at.map(seg => {
    if (secretPattern(seg)) return "/<redacted>";
    const safe = seg.replace(/~/g, "~0").replace(/\//g, "~1").replace(/[^\x20-\x7e]/g, "?");
    return "/" + (safe.length > 64 ? safe.slice(0, 61) + "..." : safe);
  }).join("");
}
const MAX_NOTE_CHARS = 4000;
/** C0 and C1 controls, DEL, and the two Unicode line separators (U+2028, U+2029). */
const NOTE_CONTROL = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, "g");
/**
 * The last net over every note, whatever produced it: no secret-shaped run, no control or line-break
 * character (a file name or manifest string cannot forge a summary line), and a bounded length.
 */
export function redact(note: string): string {
  let out = note;
  for (const [, pattern] of SECRET_PATTERNS) out = out.replace(new RegExp(pattern.source, pattern.flags + "g"), "<redacted>");
  out = out.replace(NOTE_CONTROL, "?");
  return out.length > MAX_NOTE_CHARS ? out.slice(0, MAX_NOTE_CHARS - 3) + "..." : out;
}
/** A fixture's <op>/<name> for a note: each segment as show() prints it (secret-shaped ones redacted). */
const fixtureLabel = (...segments: string[]) => show(segments).slice(1);
const listNote = (items: string[]) => items.length <= MAX_NOTE_ITEMS ? items.join("; ")
  : `${items.slice(0, MAX_NOTE_ITEMS).join("; ")}; and ${items.length - MAX_NOTE_ITEMS} more`;

// ---- Error codes: the closed set ----------------------------------------------------------------------
/**
 * The codes the village-bridge plugin (plugins/village-bridge/__init__.py) maps from an app or service
 * error body today, each owned by its app: transport()'s Gold Stars and For Kicks codes, ZZZ_ERRORS and
 * SLOPFOLIO_ERRORS. An app that owns codes here may use only its own. Every other app (a new one, and
 * Dizko, which owns none) uses GENERIC_ERROR_CODES, a documented list that is a CHOICE FOR THE LEAD: the
 * design's generic rule (section 2.2, `^[a-z][a-z0-9_]{0,63}$` with the app server's fixed instruction)
 * has no per-app code list in the manifest yet (Phase 1).
 */
export const BRIDGE_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  star_daily_limit: "gold-stars", star_already_sent: "gold-stars", star_self: "gold-stars",
  star_preview_expired: "gold-stars", star_preview_conflict: "gold-stars", star_confirmation_required: "gold-stars",
  star_cancelled: "gold-stars", star_approval_required: "gold-stars",
  forkicks_approval_required: "forkicks", forkicks_confirm_in_progress: "forkicks",
  DRAFT_NOT_EDITABLE: "slopfolio", DRAFT_NOT_FOUND: "slopfolio", CAPABILITY_NOT_GRANTED: "slopfolio", RATE_LIMITED: "slopfolio",
  zzz_not_connected: "zzzbot", zzz_reconnect_required: "zzzbot", zzz_rate_limited: "zzzbot",
  zzz_write_not_authorized: "zzzbot", zzz_not_found: "zzzbot", zzz_invalid: "zzzbot",
  zzz_not_own_post: "zzzbot", zzz_post_changed: "zzzbot",
  connection_or_request_refused: "zzzbot", response_too_large: "zzzbot",
  // Kismet's box-side step refusals (lead L29897: stage then send, shown dates only), _kismet.py / KISMET_STEP_ERRORS.
  kismet_preview_expired: "kismet", kismet_preview_unavailable: "kismet", kismet_confirmation_required: "kismet",
  date_not_found: "kismet",
});
/** For Kicks' one parameterised code (transport(): a 409 on forkicks.order.confirm). */
const FORKICKS_PICKUP_ONLY = /^pickup_only:[A-Za-z0-9_-]{1,128}$/;
export const GENERIC_ERROR_CODES: readonly string[] = Object.freeze([
  "invalid_arguments", "not_found", "not_connected", "reconnect_required", "not_authorized",
  "rate_limited", "conflict", "expired", "in_progress", "unavailable",
]);
export function allowedErrorCode(appId: string, code: string): boolean {
  const owned = Object.keys(BRIDGE_ERROR_CODES).filter(c => BRIDGE_ERROR_CODES[c] === appId);
  if (!owned.length) return GENERIC_ERROR_CODES.includes(code);
  return owned.includes(code) || (appId === "forkicks" && FORKICKS_PICKUP_ONLY.test(code));
}
const MAX_DETAIL = 1000;

// ---- Version bump class (item 1) ---------------------------------------------------------------------
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z.-]+))?$/;
export type Bump = "downgrade" | "none" | "prerelease" | "patch" | "minor" | "major" | "invalid";
export function bumpOf(from: string, to: string): Bump {
  const a = SEMVER.exec(String(from)), b = SEMVER.exec(String(to));
  if (!a || !b) return "invalid";
  for (const [index, name] of [[1, "major"], [2, "minor"], [3, "patch"]] as const) {
    const x = Number(a[index]), y = Number(b[index]);
    if (y > x) return name;
    if (y < x) return "downgrade";
  }
  // Equal triples: semver precedence of the prerelease (1.0.0-rc.1 < 1.0.0, rc.2 < rc.10, 1 < alpha).
  const order = prereleaseOrder(a[4], b[4]);
  return order === 0 ? "none" : order > 0 ? "prerelease" : "downgrade";
}
/** Semver section 11: > 0 when `to` is the higher prerelease, < 0 when lower, 0 when of equal precedence. */
function prereleaseOrder(from: string | undefined, to: string | undefined): number {
  if (from === to) return 0;
  if (from === undefined) return -1; // 1.0.0 -> 1.0.0-x goes down
  if (to === undefined) return 1;    // 1.0.0-x -> 1.0.0 goes up
  const x = from.split("."), y = to.split(".");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const p = x[i], q = y[i];
    if (p === q) continue;
    const pn = /^[0-9]+$/.test(p), qn = /^[0-9]+$/.test(q);
    if (pn && qn) {
      const d = BigInt(q) - BigInt(p);
      if (d !== 0n) return d > 0n ? 1 : -1;
      continue;
    }
    if (pn !== qn) return pn ? 1 : -1; // a numeric identifier is lower than an alphanumeric one
    return q > p ? 1 : -1;             // ASCII order
  }
  return y.length - x.length;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "undefined";
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
/**
 * An input schema without its annotation keywords (description, title, examples, $comment), removed only
 * where a keyword stands: in a schema object, and in the subschemas of the keywords below. A property
 * NAMED "description" (a key of `properties`) is kept, and so is anything under a keyword not listed, so
 * an edit there still counts as a change.
 */
const ANNOTATIONS = new Set(["description", "title", "examples", "$comment"]);
const SCHEMA_MAP = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_ONE = new Set(["additionalProperties", "items", "additionalItems", "contains", "propertyNames", "not", "if", "then",
  "else", "unevaluatedItems", "unevaluatedProperties"]);
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
export function withoutAnnotations(schema: unknown): unknown {
  if (!isObject(schema)) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (SCHEMA_MAP.has(key) && isObject(v)) out[key] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, withoutAnnotations(sub)]));
    else if (SCHEMA_ONE.has(key)) out[key] = Array.isArray(v) ? v.map(withoutAnnotations) : withoutAnnotations(v);
    else if (SCHEMA_LIST.has(key) && Array.isArray(v)) out[key] = v.map(withoutAnnotations);
    else out[key] = v;
  }
  return out;
}
/**
 * A reference can point INTO an annotation (`{$ref: "#/examples/0"}`, `#/$defs/x/description`), and then an
 * "annotation" edit changes what is enforced. So the annotation-only patch holds only when neither input
 * has a reference, or when every reference (any depth, any position) is exactly `#/$defs/<name>` to a def
 * at the input's root that both inputs hold and that is unchanged beyond annotations, and neither input has
 * an `$id` (which moves what `#` names). Anything else is major.
 */
const REF_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const LOCAL_DEF_REF = /^#\/\$defs\/[A-Za-z0-9_-]+$/;
function refsOf(value: unknown, out: { refs: unknown[]; ids: boolean } = { refs: [], ids: false }) {
  if (Array.isArray(value)) for (const item of value) refsOf(item, out);
  else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (REF_KEYS.has(key)) out.refs.push(v);
      if (key === "$id") out.ids = true;
      refsOf(v, out);
    }
  }
  return out;
}
export function annotationOnlyEdit(from: unknown, to: unknown): boolean {
  if (!same(withoutAnnotations(from), withoutAnnotations(to))) return false;
  const a = refsOf(from), b = refsOf(to);
  if (!a.refs.length && !b.refs.length) return true;
  if (a.ids || b.ids) return false;
  const defs = (schema: unknown) => isObject(schema) && isObject(schema.$defs) ? schema.$defs : null;
  const x = defs(from), y = defs(to);
  return [...a.refs, ...b.refs].every(ref => {
    if (typeof ref !== "string" || !LOCAL_DEF_REF.test(ref)) return false;
    const name = ref.slice("#/$defs/".length);
    return !!x && !!y && own(x, name) && own(y, name) && same(withoutAnnotations(x[name]), withoutAnnotations(y[name]));
  });
}
const CEILING_RANK: Record<string, number> = { private: 0, village: 1, public: 2 };
type Level = "patch" | "major" | "refuse";
/**
 * What a change from `from` to `to` (two valid v2 manifests) needs. Major (design section 1.1): an op
 * added, or widened (class, target, input, a budget raised, framing, returns widened, any approval
 * change: the summary template), any service change (auth, kind, baseUrl), data added or widened,
 * events added or changed, legacy or owner changed. v0 cannot prove an input schema tighter, so any
 * input change is major, except an edit of annotations only (description, title, examples, $comment:
 * withoutAnnotations()) with no reference that could point into one (annotationOnlyEdit()), which is a patch. Everything else that changed (copy, permissions, skills,
 * visibility, an op removed, a budget lowered) needs at least a patch. A changed id is refused.
 */
export function requiredBump(from: any, to: any, budgets: Validator["operationBudgets"]): { level: Level | "none"; reasons: string[] } {
  const reasons: [Level, string][] = [];
  const add = (level: Level, text: string) => reasons.push([level, text]);
  const keys = [...new Set([...Object.keys(from), ...Object.keys(to)])].filter(k => k !== "version").sort();
  for (const key of keys) {
    if (same(from[key], to[key])) continue;
    if (key === "id") add("refuse", "id changed (ids are immutable)");
    else if (key === "operations") operationChanges(from.operations || [], to.operations || [], add, budgets);
    else if (key === "service") {
      for (const sub of [...new Set([...Object.keys(from.service || {}), ...Object.keys(to.service || {})])].sort()) {
        if (!same(from.service?.[sub], to.service?.[sub])) add("major", `service.${sub} changed`);
      }
    } else if (key === "data") dataChanges(from.data, to.data, add);
    else if (key === "events") {
      const a = from.events || {}, b = to.events || {};
      for (const name of Object.keys(b)) if (!own(a, name) || !same(a[name], b[name])) add("major", `event ${name} added or changed`);
      for (const name of Object.keys(a)) if (!own(b, name)) add("patch", `event ${name} removed`);
    } else if (key === "legacy" || key === "owner" || key === "manifest") add("major", `${key} changed`);
    else add("patch", `${key} changed`);
  }
  const level = reasons.some(([l]) => l === "refuse") ? "refuse" : reasons.some(([l]) => l === "major") ? "major" : reasons.length ? "patch" : "none";
  const order = { refuse: 0, major: 1, patch: 2 };
  return { level, reasons: reasons.sort((x, y) => order[x[0]] - order[y[0]]).map(([l, t]) => `${l}: ${t}`) };
}
function operationChanges(from: any[], to: any[], add: (l: Level, t: string) => void, budgets: Validator["operationBudgets"]) {
  const a = new Map(from.map(op => [op.name, op])), b = new Map(to.map(op => [op.name, op]));
  for (const [name, op] of b) {
    const old = a.get(name);
    if (!old) { add("major", `operation ${name} added`); continue; }
    if (old.class !== op.class) add("major", `${name} class ${old.class} -> ${op.class}`);
    if (!same(old.target, op.target)) add("major", `${name} target changed`);
    if (!same(old.input, op.input)) {
      if (annotationOnlyEdit(old.input, op.input)) add("patch", `${name} input annotations changed`);
      else add("major", `${name} input changed`);
    }
    const x = budgets(old), y = budgets(op);
    for (const field of ["maxRequestBytes", "maxResponseBytes", "timeoutMs"] as const) {
      if (y[field] > x[field]) add("major", `${name} ${field} raised ${x[field]} -> ${y[field]}`);
      else if (y[field] < x[field]) add("patch", `${name} ${field} lowered`);
    }
    if (x.framing !== y.framing) add("major", `${name} framing ${x.framing} -> ${y.framing}`);
    if (!same(old.returns, op.returns)) {
      const r = old.returns, s = op.returns;
      if (!r || !s || r.draftIdPath !== s.draftIdPath || r.previewPath !== s.previewPath) add("major", `${name} returns changed`);
      for (const field of ["previewMaxBytes", "previewTtlSeconds"]) {
        if (r && s && s[field] > r[field]) add("major", `${name} returns.${field} raised`);
        else if (r && s && s[field] < r[field]) add("patch", `${name} returns.${field} lowered`);
      }
    }
    if (!same(old.approval, op.approval)) add("major", `${name} approval changed (prepare, summary template or summaryMaxBytes)`);
  }
  for (const name of a.keys()) if (!b.has(name)) add("patch", `operation ${name} removed`);
  const common = (list: any[], other: Map<string, any>) => list.map(op => op.name).filter(n => other.has(n));
  if (!same(common(from, b), common(to, a))) add("patch", "operations reordered");
}
function dataChanges(from: any, to: any, add: (l: Level, t: string) => void) {
  const a = from?.context, b = to?.context;
  if (!a && b) add("major", "data.context added");
  else if (a && !b) add("patch", "data.context removed");
  else if (a && b) {
    if (b.maxEntries > a.maxEntries) add("major", `data.context.maxEntries raised ${a.maxEntries} -> ${b.maxEntries}`);
    else if (b.maxEntries < a.maxEntries) add("patch", "data.context.maxEntries lowered");
    const x = CEILING_RANK[a.ceiling || "private"], y = CEILING_RANK[b.ceiling || "private"];
    if (y > x) add("major", `data.context.ceiling widened ${a.ceiling || "private"} -> ${b.ceiling}`);
    else if (y < x) add("patch", "data.context.ceiling narrowed");
  }
  const rest = (d: any) => isObject(d) ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "context")) : {};
  if (!same(rest(from), rest(to))) add("major", "data changed beyond data.context");
}
export function bumpVerdict(required: { level: Level | "none"; reasons: string[] }, from: string, to: string): Result {
  const actual = bumpOf(from, to);
  const why = required.reasons.length ? ` (${listNote(required.reasons)})` : "";
  const got = `${from} -> ${to} is ${actual}`;
  if (required.level === "refuse") return fail("version.bump", `refused${why}`);
  if (actual === "invalid" || actual === "downgrade") return fail("version.bump", `${got}${why}`);
  if (required.level === "major" && actual !== "major") return fail("version.bump", `needs a major bump, ${got}${why}`);
  if (required.level === "patch" && actual === "none") return fail("version.bump", `the manifest changed but the version did not${why}`);
  return pass("version.bump", required.level === "none" ? `no change since the base; ${got}` : `needs ${required.level}, ${got}${why}`);
}

// ---- git, local only (--base) -----------------------------------------------------------------------
const BASE_REF = /^[A-Za-z0-9_][A-Za-z0-9._/@{}~^+-]{0,254}$/;
function git(cwd: string, args: string[]): { status: number | null; stdout: Buffer } {
  const r = spawnSync("git", args, {
    cwd, maxBuffer: 16 << 20,
    // Local reads only: never prompt, never fetch a missing object of a partial clone, take no lock.
    // A path is a literal path, never a glob pathspec.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" },
  });
  return { status: r.status, stdout: r.stdout ?? Buffer.alloc(0) };
}
type Base = { ref: string; commit: string; blob: Buffer | null };
/** The argument half of --base: the ref's syntax, a git checkout holding the manifest, a commit it names. */
function baseCommit(root: string, manifestAbs: string, ref: string): { rel: string; sha: string } {
  if (!BASE_REF.test(ref) || ref.includes("..")) throw new Refusal("bad_base_ref");
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) throw new Refusal("base_needs_a_git_checkout");
  const rel = relative(realpathSync(top.stdout.toString("utf8").trim()), realpathSync(manifestAbs)).split(sep).join("/");
  if (rel.startsWith("../") || rel === "..") throw new Refusal("manifest_outside_the_git_checkout");
  const commit = git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  if (commit.status !== 0) throw new Refusal("base_ref_unknown");
  return { rel, sha: commit.stdout.toString("utf8").trim() };
}
function resolveBase(root: string, manifestAbs: string, ref: string): Base {
  const { rel, sha } = baseCommit(root, manifestAbs, ref);
  // The base tree decides "absent" (a new app): `cat-file -e <sha>:<path>` cannot tell an absent path
  // from a present blob that is not local (a --filter=blob:none clone with lazy fetch off), and that
  // must never pass as a new manifest. An unreadable tree (a --filter=tree:0 clone) refuses too.
  const listed = git(root, ["ls-tree", "-z", "--full-tree", sha, "--", rel]);
  if (listed.status !== 0) throw new Refusal("base_tree_unreadable");
  const entry = listed.stdout.toString("utf8");
  if (entry === "") return { ref, commit: sha, blob: null };
  const m = /^(100644|100755|120000|040000|160000) (blob|tree|commit) ([0-9a-f]{40}|[0-9a-f]{64})\t([^\0]*)\0$/.exec(entry);
  if (!m || m[4] !== rel) throw new Refusal("base_tree_unreadable");
  if (m[2] !== "blob" || m[1] === "120000") throw new Refusal("base_manifest_not_a_regular_file");
  const oid = m[3];
  if (git(root, ["cat-file", "-e", oid]).status !== 0) throw new Refusal("base_blob_missing");
  const blob = git(root, ["cat-file", "blob", oid]);
  if (blob.status !== 0) throw new Refusal("base_blob_missing");
  return { ref, commit: sha, blob: blob.stdout };
}

// ---- The run -------------------------------------------------------------------------------------------
export type Options = { manifest: string; fixtures?: string; base?: string; out?: string; service?: string };
type Located = { abs: string; root: string; dirId: string; rel: string };
function locate(manifestArg: string, cwd: string): Located {
  const abs = resolve(cwd, manifestArg);
  const appDir = dirname(abs), miniApps = dirname(appDir);
  if (basename(abs) !== "manifest.json" || basename(miniApps) !== "mini-apps") throw new Refusal("manifest_path_must_be_mini-apps/<id>/manifest.json");
  let st;
  try { st = lstatSync(abs); } catch { throw new Refusal("manifest_missing"); }
  if (!st.isFile()) throw new Refusal("manifest_not_a_regular_file");
  const dirId = basename(appDir);
  return { abs, root: dirname(miniApps), dirId, rel: `mini-apps/${dirId}/manifest.json` };
}
function directory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}

type Prepared = { at: Located; bytes: Buffer; results: Result[]; manifest: any; valid: boolean; files: Fixture[]; validator: Validator };
/** Without --service: the three v1 rows, not run. */
const SERVICE_NOT_RUN: Result[] = [
  notRun("service.reachability", "not run by default (conformance v1): pass --service <the https base URL of your own sandbox> " +
    "to check initialize/tools/list (mcp), each read op's path (https-json) or the token refusal and oauth discovery"),
  notRun("service.budgets", "not run by default (conformance v1): with --service, each read op answers its <op>/<name>.request.json " +
    "within timeoutMs and maxResponseBytes, shaped like <name>.json"),
  notRun("service.error_bodies", "not run by default (conformance v1): with --service, each <op>/error*.request.json is answered " +
    "with exactly {code, detail} and its fixture's closed code"),
];
const FAKE_CP_NOTE = "Phase 1: wrong draftId, changed hash and no grant refused by a fake cp; two confirms of one draftId make one target call";
/**
 * Runs every check (v0, and the v1 rows as not_run). Throws Refusal for bad arguments or a validator pin
 * mismatch (exit 2). --service needs runConformanceAsync (it uses the network).
 */
export function runConformance(opts: Options, env: { cwd?: string; toolRoot?: string } = {}): Report {
  if (opts.service !== undefined) throw new Refusal("service_needs_runConformanceAsync");
  return finalize(prepareRun(opts, env));
}
/** Every check; with --service, the v1 service checks against that one sandbox endpoint (serviceChecks). */
export async function runConformanceAsync(opts: Options, env: { cwd?: string; toolRoot?: string; service?: ServiceDeps } = {}): Promise<Report> {
  const p = prepareRun(opts, env);
  if (opts.service !== undefined) {
    let rows: Result[];
    try {
      rows = await serviceChecks({ url: opts.service, manifest: p.manifest, valid: p.valid, files: p.files, validator: p.validator, deps: env.service });
    } catch (e) {
      // A refused URL or address stays a refusal (exit 2). Anything else a sandbox provokes is an advisory
      // FAIL with a fixed note (review-b S1 on ov#438): it never costs the run its required verdict or its report.
      if (e instanceof Refusal) throw e;
      const name = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
      rows = [...ADVISORY].map(check => fail(check, `internal error ${name} in the service checks; the other rows stand`));
    }
    p.results = p.results.map(r => rows.find(x => x.check === r.check) ?? r);
  }
  return finalize(p);
}
function finalize(p: Prepared): Report {
  for (const r of p.results) r.note = (ADVISORY.has(r.check) ? ADVISORY_MARK : "") + redact(r.note);
  return { manifest: p.at.rel, sha256: sha256(p.bytes), results: p.results, passed: passedOf(p.results) };
}
function prepareRun(opts: Options, { cwd = process.cwd(), toolRoot = resolve(import.meta.dir, "..") }: { cwd?: string; toolRoot?: string }): Prepared {
  const { validator } = loadValidator(toolRoot);
  if (opts.service !== undefined) serviceTarget(opts.service, validator);
  const at = locate(opts.manifest, cwd);
  const base = opts.base !== undefined ? resolveBase(at.root, at.abs, opts.base) : null;
  let fixtures: string | null = null;
  let fixturesNote = "";
  if (opts.fixtures !== undefined) {
    fixtures = resolve(cwd, opts.fixtures);
    if (!directory(fixtures)) throw new Refusal("fixtures_not_a_directory");
  } else {
    const fallback = join(dirname(at.abs), "fixtures");
    if (exists(fallback)) fixtures = fallback;
    else fixturesNote = `no fixtures: pass --fixtures <dir> (${at.rel.replace(/manifest\.json$/, "fixtures/")} is absent)`;
  }

  const bytes = readFileSync(at.abs);
  const results: Result[] = [pass("manifest.validator_pin", "scripts/mini-apps-manifests.cjs and mini-apps/manifest.v2.schema.json match mini-apps/manifests.pins.json")];
  // Item 1: the manifest itself.
  let manifest: any = null;
  let valid = false;
  const text = bytes.length <= MAX_MANIFEST_BYTES ? utf8(bytes) : null;
  const strict = text === null ? null : strictJson(text);
  if (bytes.length > MAX_MANIFEST_BYTES) results.push(fail("manifest.schema", `over ${MAX_MANIFEST_BYTES} bytes`));
  else if (text === null) results.push(fail("manifest.schema", "not UTF-8"));
  else if (!strict!.ok) results.push(fail("manifest.schema", `not strict JSON: ${(strict as { error: string }).error}`));
  else {
    manifest = strict!.value;
    const problems: string[] = (strict as { duplicates: { at: Pointer; key: string }[] }).duplicates.map(d => `duplicate key ${show([...d.at, d.key])}`);
    const checked = validator.validateManifest(manifest);
    if (!checked.ok) problems.push(...(checked.errors || []).map(e => `${e.path} ${e.reason}`));
    if (isObject(manifest) && manifest.id !== at.dirId) problems.push(`/id is not its directory name (mini-apps/${at.dirId}/)`);
    valid = problems.length === 0;
    results.push(valid
      ? pass("manifest.schema", "a valid v2 manifest by the shared validator (input schemas are compiled by the cp's ajv at load, not here)")
      : fail("manifest.schema", listNote(problems)));
  }
  results.push(skillHashes(manifest, at.root));
  results.push(versionBump(base, manifest, valid, validator));
  // Items 2-3 (v1): not run here; runConformanceAsync replaces them when --service is given.
  results.push(...SERVICE_NOT_RUN.map(r => ({ ...r })));
  results.push(preparePairs(manifest));
  results.push(summaryRender(manifest));
  // The fake-cp half of item 4 needs a card: never against a live service (serviceChecks says why).
  results.push(notRun("approval.fake_cp", opts.service === undefined ? FAKE_CP_NOTE : `${FAKE_CP_NOTE}. ${NO_CARD_NOTE}`));
  // Item 5.
  const h = hygiene(fixtures, fixturesNote, manifest, validator);
  results.push(...h.results);
  return { at, bytes, results, manifest, valid, files: h.files, validator };
}

function skillHashes(manifest: any, root: string): Result {
  if (!isObject(manifest)) return notRun("skills.sha256", "the manifest is not readable JSON");
  const skills = manifest.skills;
  if (!Array.isArray(skills) || !skills.length) return fail("skills.sha256", "no skills[] to check");
  const problems: string[] = [], ok: string[] = [];
  skills.forEach((skill: any, index: number) => {
    const path = skill?.path;
    if (typeof path !== "string" || !/^skills\/[a-z][a-z0-9-]{0,63}\/SKILL\.md$/.test(path) || typeof skill.sha256 !== "string") {
      problems.push(`skills[${index}] has no checkable path and sha256`);
      return;
    }
    const abs = join(root, ...path.split("/"));
    let st;
    try { st = lstatSync(abs); } catch { problems.push(`${path} missing`); return; }
    if (!st.isFile()) { problems.push(`${path} is not a regular file`); return; }
    try {
      const real = realpathSync(abs);
      if (relative(realpathSync(root), real).split(sep)[0] === "..") { problems.push(`${path} resolves outside the repo`); return; }
    } catch { problems.push(`${path} unresolvable`); return; }
    const actual = sha256(readFileSync(abs));
    if (actual !== skill.sha256) problems.push(`${path} sha256 is ${actual}, the manifest says ${show([skill.sha256]).slice(1)}`);
    else ok.push(path);
  });
  return problems.length ? fail("skills.sha256", listNote(problems)) : pass("skills.sha256", `matches: ${ok.join(", ")}`);
}

function versionBump(base: Base | null, manifest: any, valid: boolean, validator: Validator): Result {
  if (!base) return notRun("version.bump", "no --base: the bump class needs a base ref to diff against");
  if (!valid) return notRun("version.bump", "the manifest is not a valid v2 manifest");
  if (!base.blob) return pass("version.bump", `a new manifest: none at ${base.ref} (${base.commit.slice(0, 12)})`);
  const text = utf8(base.blob);
  const strict = text === null ? null : strictJson(text);
  const old = strict?.ok ? strict.value : null;
  if (!isObject(old) || old.manifest !== 2) return notRun("version.bump", `the manifest at ${base.ref} is not v2: a v1 -> v2 conversion has no bump class`);
  if (!validator.validateManifest(old).ok) return notRun("version.bump", `the manifest at ${base.ref} is not a valid v2 manifest`);
  return bumpVerdict(requiredBump(old, manifest, validator.operationBudgets), old.version, manifest.version);
}

function opsOf(manifest: any): any[] {
  return isObject(manifest) && Array.isArray(manifest.operations) ? manifest.operations.filter(isObject) : [];
}
function preparePairs(manifest: any): Result {
  if (!isObject(manifest)) return notRun("approval.prepare_pair", "the manifest is not readable JSON");
  const ops = opsOf(manifest);
  const cards = ops.filter(op => op.class === "needs-card");
  if (!cards.length) return pass("approval.prepare_pair", "no needs-card operation");
  const problems: string[] = [];
  for (const op of cards) {
    const name = op.approval?.prepare;
    const prepare = ops.find(o => o.name === name);
    if (typeof name !== "string") problems.push(`${op.name}: no approval.prepare`);
    else if (!prepare) problems.push(`${op.name}: approval.prepare ${name} is not an operation of this manifest`);
    else if (prepare.class !== "prepare") problems.push(`${op.name}: approval.prepare ${name} is class ${prepare.class}, not prepare`);
  }
  return problems.length ? fail("approval.prepare_pair", listNote(problems))
    : pass("approval.prepare_pair", cards.map(op => `${op.name} <- ${op.approval.prepare}`).join("; "));
}
function summaryRender(manifest: any): Result {
  const cards = opsOf(manifest).filter(op => op.class === "needs-card");
  const which = cards.length
    ? `; needs-card ops: ${cards.map(op => `${op.name} (${Array.isArray(op.approval?.summary) ? "has" : "no"} summary template)`).join(", ")}`
    : "; no needs-card op";
  return notRun("approval.summary_render",
    "renderer_absent: no section 3.2 summary-template renderer exists in this repo in Node or Python yet " +
    "(P0-1: the For Kicks card cannot be expressed in the section 3.2 grammar; Phase 1 item 6). v0 does not render" + which);
}

/**
 * One fixture file. `request` (a <name>.request.json, v1) is the arguments --service sends; `pair` is the
 * response fixture's file name it is answered by. `value` is the strict-JSON value when the file parses.
 */
export type Fixture = { label: string; op: string; name: string; error: boolean; request: boolean; pair?: string; bytes: Buffer; value?: unknown };
const REQUEST_SUFFIX = ".request.json";
/** Why an error body (a fixture's, or a live answer's) is not exactly {code, detail} with a closed code. */
export function errorBodyProblems(label: string, body: unknown, appId: string): string[] {
  const out: string[] = [];
  if (!isObject(body)) return [`${label}: an error body is a {code, detail} object`];
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "code,detail") out.push(`${label}: keys are ${show(keys).slice(1).split("/").join(", ") || "none"}, not exactly code, detail`);
  if (typeof body.code !== "string" || !allowedErrorCode(appId, body.code)) {
    const owner = typeof body.code === "string" ? BRIDGE_ERROR_CODES[body.code] : undefined;
    out.push(`${label}: code ${typeof body.code === "string" ? show([body.code]).slice(1) : "(not a string)"} is not in the closed set for ${appId || "this app"}${owner && owner !== appId ? ` (it is ${owner}'s)` : ""}`);
  }
  if (own(body, "detail") && (typeof body.detail !== "string" || body.detail.trim() === "" || [...body.detail].length > MAX_DETAIL)) {
    out.push(`${label}: detail is a non-empty string of at most ${MAX_DETAIL} characters`);
  }
  return out;
}

// ---- MCP error answers (protocol 2025-06-18) ---------------------------------------------------------
/**
 * An MCP server answers a tools/call it refuses in one of two conforming ways: a TOOL error, a result with
 * isError: true and a content array; or a PROTOCOL error, a JSON-RPC error {code: integer, message: string,
 * data?}. For an mcp app either one is an error fixture (bare, or in its JSON-RPC response) and a live
 * answer to an error call. A tool error that carries a {code, detail} (structuredContent, or its one JSON
 * text item) still needs exactly {code, detail} with a closed code; one that carries plain text is opaque.
 */
export type McpError = { kind: "tool"; carried: unknown } | { kind: "protocol"; code: number };
const RPC_KEYS = ["jsonrpc", "id", "result", "error"];
/** Why a JSON-RPC response envelope is malformed: jsonrpc "2.0", an id, exactly one of result/error. */
export function rpcEnvelopeProblems(packet: Record<string, any>): string[] {
  const out: string[] = [];
  if (packet.jsonrpc !== "2.0") out.push("jsonrpc is not \"2.0\"");
  if (!own(packet, "id") || packet.id === null) out.push("no id");
  else if (!Number.isInteger(packet.id) && typeof packet.id !== "string") out.push("id is not an integer or a string");
  const hasResult = own(packet, "result"), hasError = own(packet, "error");
  if (hasResult && hasError) out.push("both result and error");
  else if (!hasResult && !hasError) out.push("neither result nor error");
  else if (hasError) {
    if (!isObject(packet.error)) out.push("error is not an object");
    else {
      if (!Number.isInteger(packet.error.code)) out.push("error.code is not an integer");
      if (typeof packet.error.message !== "string") out.push("error.message is not a string");
    }
  } else if (!isObject(packet.result)) out.push("result is not an object");
  return out;
}
/** Why a tools/call result is not a well-formed tool error: isError true, a content array of typed items. */
export function toolErrorProblems(result: Record<string, any>): string[] {
  const out: string[] = [];
  if (result.isError !== true) out.push("isError is not true");
  if (!Array.isArray(result.content)) out.push("isError without a content array");
  else {
    // Every item is checked (review-b S1 on ov#474); only the notes are capped.
    const items: string[] = [];
    result.content.forEach((item: unknown, i: number) => {
      if (!isObject(item) || typeof item.type !== "string") items.push(`content/${i} has no string type`);
      else if (item.type === "text" && typeof item.text !== "string") items.push(`content/${i} is text without a string text`);
    });
    out.push(...items.slice(0, MAX_NOTE_ITEMS));
    if (items.length > MAX_NOTE_ITEMS) out.push(`and ${items.length - MAX_NOTE_ITEMS} more content item problem(s)`);
  }
  if (own(result, "structuredContent") && !isObject(result.structuredContent)) out.push("structuredContent is not an object");
  return out;
}
/** A fixture or answer that is plainly an MCP error answer: isError true, or a JSON-RPC error/isError response. */
function mcpErrorSignal(body: unknown): boolean {
  return isObject(body) && (body.isError === true
    || (own(body, "jsonrpc") && (own(body, "error") || (isObject(body.result) && body.result.isError === true))));
}
/**
 * An mcp error fixture read as an MCP error answer. null: not an envelope (no JSON-RPC key, no isError or
 * content key), so it is a {code, detail} body. problems: a malformed envelope.
 */
export function mcpErrorOf(body: unknown): { error: McpError } | { problems: string[] } | null {
  if (!isObject(body)) return null;
  let result: Record<string, any> = body;
  if (RPC_KEYS.some(k => own(body, k))) {
    const bad = rpcEnvelopeProblems(body);
    if (bad.length) return { problems: bad };
    if (own(body, "error")) return { error: { kind: "protocol", code: body.error.code } };
    result = body.result;
  } else if (!own(body, "isError") && !own(body, "content")) return null;
  const bad = toolErrorProblems(result);
  return bad.length ? { problems: bad } : { error: { kind: "tool", carried: mcpErrorBody(result) } };
}
/** A carried value that claims a code ({code, ...}): it is held to errorBodyProblems. */
const claimsCode = (carried: unknown): carried is Record<string, any> => isObject(carried) && own(carried, "code");
/** Why an mcp error fixture is not a {code, detail} body or a well-formed MCP error answer. */
function mcpErrorFixtureProblems(label: string, body: unknown, appId: string): string[] {
  const e = mcpErrorOf(body);
  if (e === null) return errorBodyProblems(label, body, appId);
  if ("problems" in e) return e.problems.map(p => `${label}: ${p}`);
  return e.error.kind === "tool" && claimsCode(e.error.carried) ? errorBodyProblems(`${label} (carried)`, e.error.carried, appId) : [];
}
function hygiene(dir: string | null, absentNote: string, manifest: any, validator: Validator): { results: Result[]; files: Fixture[] } {
  const names = ["hygiene.fixtures", "hygiene.secrets", "hygiene.duplicate_keys", "hygiene.error_bodies"];
  if (!dir) return { results: names.map(check => notRun(check, absentNote)), files: [] };
  const ops = new Map(opsOf(manifest).filter(op => typeof op.name === "string").map(op => [op.name as string, op]));
  const layout: string[] = [];
  const files: Fixture[] = [];
  if (!directory(dir)) layout.push("the fixture path is not a directory (a symlink is refused)");
  else {
    for (const entry of readdirSync(dir).sort()) {
      const st = lstatSync(join(dir, entry));
      const shown = fixtureLabel(entry);
      if (st.isSymbolicLink()) { layout.push(`${shown}: symlink`); continue; }
      if (!st.isDirectory()) { layout.push(`${shown}: a fixture sits in an <operation>/ directory`); continue; }
      const op = ops.get(entry);
      if (!op) { layout.push(`${shown}/: not an operation of this manifest`); continue; }
      const budgets = validator.operationBudgets(op);
      const inDir = readdirSync(join(dir, entry)).sort();
      for (const name of inDir) {
        const label = fixtureLabel(entry, name);
        const fst = lstatSync(join(dir, entry, name));
        const request = name.endsWith(REQUEST_SUFFIX);
        const pair = request ? name.slice(0, -REQUEST_SUFFIX.length) + ".json" : undefined;
        if (fst.isSymbolicLink()) layout.push(`${label}: symlink`);
        else if (!fst.isFile()) layout.push(`${label}: not a regular file`);
        else if (!name.endsWith(".json")) layout.push(`${label}: not a .json file`);
        else if (request && op.class !== "read") layout.push(`${label}: a request is sent only for a read operation (${shown} is ${show([String(op.class)]).slice(1)})`);
        else if (request && (pair!.endsWith(REQUEST_SUFFIX) || !inDir.includes(pair!))) layout.push(`${label}: a request needs its response fixture ${fixtureLabel(pair!)} beside it`);
        else if (request && fst.size > budgets.maxRequestBytes) layout.push(`${label}: ${fst.size} bytes is over ${shown}'s maxRequestBytes ${budgets.maxRequestBytes} (the bridge refuses it)`);
        else if (!request && fst.size > budgets.maxResponseBytes) layout.push(`${label}: ${fst.size} bytes is over ${shown}'s maxResponseBytes ${budgets.maxResponseBytes} (the reader refuses it)`);
        else if (files.length >= MAX_FIXTURE_FILES) { layout.push(`more than ${MAX_FIXTURE_FILES} fixture files`); break; }
        else files.push({ label, op: entry, name, error: !request && name.startsWith("error"), request, pair, bytes: readFileSync(join(dir, entry, name)) });
      }
    }
  }
  const responses = files.filter(f => !f.request);
  if (!responses.length) {
    const first = layout.length ? fail("hygiene.fixtures", listNote(layout)) : notRun("hygiene.fixtures", "the fixture directory holds no fixture file");
    return { results: [first, ...names.slice(1).map(check => notRun(check, "no fixture file to read"))], files: [] };
  }

  const secrets: string[] = [], strictness: string[] = [], bodies: string[] = [];
  const appId = isObject(manifest) && typeof manifest.id === "string" ? manifest.id : "";
  const mcp = isObject(manifest) && isObject(manifest.service) && manifest.service.kind === "mcp";
  let errorCount = 0;
  for (const f of files) {
    const text = utf8(f.bytes);
    const parsed = text === null ? null : strictJson(text);
    if (text === null) strictness.push(`${f.label}: not UTF-8`);
    else if (!parsed!.ok) strictness.push(`${f.label}: not strict JSON (${(parsed as { error: string }).error})`);
    else for (const d of (parsed as { duplicates: { at: Pointer; key: string }[] }).duplicates) strictness.push(`${f.label}: duplicate key ${show([...d.at, d.key])}`);
    if (parsed?.ok) {
      for (const [where, pattern] of secretFindings(parsed.value)) secrets.push(`${f.label} ${show(where)} (${pattern})`);
    } else {
      // An unparseable file is still scanned, as raw text.
      const hit = secretPattern(text ?? f.bytes.toString("latin1"));
      if (hit) secrets.push(`${f.label} raw text (${hit})`);
    }
    if (!parsed?.ok) continue;
    if (!parsed.duplicates.length) f.value = parsed.value;
    const body = parsed.value;
    // An mcp fixture that is plainly an MCP error answer is an error fixture whatever its name.
    if (mcp && !f.request && !f.error && mcpErrorSignal(body)) f.error = true;
    if (f.request) {
      if (!isObject(body)) layout.push(`${f.label}: a request is a JSON object of the op's arguments`);
    } else if (f.error) {
      errorCount++;
      bodies.push(...(mcp ? mcpErrorFixtureProblems(f.label, body, appId) : errorBodyProblems(f.label, body, appId)));
    } else if (isObject(body) && own(body, "error")) {
      bodies.push(`${f.label}: a success fixture carries "error"; an error body belongs in an error*.json fixture as {code, detail}`);
    }
  }
  const requests = files.length - responses.length;
  const out: Result[] = [layout.length ? fail("hygiene.fixtures", listNote(layout))
    : pass("hygiene.fixtures", `${responses.length} fixture file(s), ${errorCount} error bod(ies)${requests ? `, ${requests} request(s)` : ""}`)];
  out.push(secrets.length ? fail("hygiene.secrets", listNote(secrets)) : pass("hygiene.secrets", `no secret pattern in ${files.length} fixture file(s)`));
  out.push(strictness.length ? fail("hygiene.duplicate_keys", listNote(strictness)) : pass("hygiene.duplicate_keys", `${files.length} fixture file(s) strict JSON, no duplicate key`));
  if (bodies.length) out.push(fail("hygiene.error_bodies", listNote(bodies)));
  else if (!errorCount) out.push(notRun("hygiene.error_bodies", "no error fixture: add <operation>/error*.json with the service's {code, detail} body"));
  else out.push(pass("hygiene.error_bodies", `${errorCount} error bod(ies) are {code, detail} with a closed code${mcp ? ", or a well-formed MCP error answer (isError result or JSON-RPC error)" : ""}`));
  return { results: out, files };
}

// ---- v1: the service checks (section 5.3 items 2-3), ONLY with --service, against YOUR OWN sandbox ------
/**
 * Network safety, in the order a run applies it (each rule cites the design or the brief):
 *   1. serviceTarget: the --service URL passes P0-1's endpointRefusal (https, a lower-case public DNS name,
 *      no IP literal, port, userinfo, query, fragment, internal suffix or non-canonical form), and its host
 *      is not an Agent Village host (OUR_HOSTS). Refused: exit 2 before any file or socket is touched.
 *   2. pinAddress: the name is resolved ONCE. If ANY answer is private, loopback, link-local, metadata or
 *      special-purpose (addressRefusal: the validator's own ranges, then METADATA and SPECIAL), the run
 *      refuses before a single connection. Every exchange then dials that one checked address and never
 *      resolves again, so a rebinding resolver gets no second answer (design section 1.3's runtime re-check).
 *   3. exchange: one TLS connection per request to the pinned address, the certificate verified for the
 *      name (SNI); the default dial also refuses a socket whose remote address is not the pinned one. No
 *      proxy, no redirect is ever followed (a 3xx is reported), no compressed body, headers at most 16 KiB.
 *   4. Budgets from the manifest: a read op's call has its timeoutMs (the whole exchange, connect included)
 *      and maxResponseBytes (the decoded body, cut off at the first byte over); the session calls
 *      (initialize, notifications/initialized, tools/list, oauth discovery) have the defaults (25000 ms,
 *      262144 bytes). At most MAX_SERVICE_REQUESTS requests per run.
 *   5. No credentials: a request carries only SENT_HEADERS (built here, never from the environment or the
 *      manifest), so never Authorization, Cookie or a token; a Set-Cookie is never stored. Only read ops are
 *      called: a write, prepare or needs-card target is never called (it would change state, or pay/send).
 */
export type Resolved = { address: string; family: number };
export type Dial = (to: { address: string; family: number; host: string; port: number }) => Duplex;
/** Test seams (in-process only, never a CLI flag): the resolver and the dialer. */
export type ServiceDeps = { resolve?: (host: string) => Promise<Resolved[]>; dial?: Dial; deadlineMs?: number };
/**
 * Agent Village's own hosts (each with its subdomains): --service is a developer's sandbox, never ours (the
 * lane brief; review-b N1 on ov#438): the app and portal, EdgeOS, the cp (current and the old Esmeralda
 * one) and the app's Railway domain.
 */
export const OUR_HOSTS: readonly string[] = Object.freeze(["edgecity.live", "edgeos.world",
  "control-plane-production-606c.up.railway.app", "control-plane-production-b752.up.railway.app", "agentvillage-app-production.up.railway.app"]);
export const MAX_SERVICE_REQUESTS = 64;
/** The whole run's service checks end by this (review-b N3: 64 requests x 60 s would be 64 min). */
export const SERVICE_DEADLINE_MS = 10 * 60_000;
const DEADLINE_FAILURE = "the whole-run deadline passed";
const MAX_HEAD_BYTES = 16384;
const PROTOCOL = "2025-06-18";
const SENT_HEADERS = new Set(["host", "user-agent", "accept", "accept-encoding", "connection", "content-type", "content-length",
  "mcp-protocol-version", "mcp-session-id"]);
export const NO_CARD_NOTE = "Not checkable without a card: the wrong-draftId, changed-hash and no-grant refusals and the one-call " +
  "idempotency belong to the cp and the app server, not to the service, and --service never calls a prepare (it stages a " +
  "draft) or a needs-card target (it pays, sends or publishes with no card)";

export type ServiceTarget = { url: string; host: string; basePath: string };
/** Rule 1: the --service URL, or Refusal (an argument refusal: exit 2, nothing touched). */
export function serviceTarget(url: string, validator: Validator): ServiceTarget {
  if (typeof validator.endpointRefusal !== "function") throw new Refusal("validator_has_no_endpointRefusal");
  const refused = validator.endpointRefusal(url);
  if (refused) throw new Refusal(`service_url_${refused}`);
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (OUR_HOSTS.some(ours => host === ours || host.endsWith(`.${ours}`))) throw new Refusal("service_is_an_agent_village_host");
  return { url, host, basePath: parsed.pathname };
}

/** Cloud metadata addresses, named so the refusal says "metadata" (each is inside a refused range too). */
const METADATA = new BlockList();
for (const a of ["169.254.169.254", "169.254.170.2", "169.254.170.23", "100.100.100.200", "192.0.0.192"]) METADATA.addAddress(a, "ipv4");
for (const a of ["fd00:ec2::254", "fd00:ec2::23", "fd20:ce::254"]) METADATA.addAddress(a, "ipv6");
/** Special-purpose blocks beyond the validator's list: documentation, 6to4 and Teredo (they carry an IPv4), site-local. */
const SPECIAL = new BlockList();
for (const [a, n] of [["192.0.2.0", 24], ["198.51.100.0", 24], ["203.0.113.0", 24], ["192.88.99.0", 24]] as const) SPECIAL.addSubnet(a, n, "ipv4");
for (const [a, n] of [["2001:db8::", 32], ["2002::", 16], ["2001::", 32], ["fec0::", 10], ["100::", 64], ["64:ff9b:1::", 48], ["3fff::", 20]] as const) SPECIAL.addSubnet(a, n, "ipv6");
/** Rule 2: why a resolved address may not be connected to, or null. */
export function addressRefusal(address: string, validator: Validator): string | null {
  const family = isIP(address);
  if (!family || address.includes("%")) return "address_unparseable_or_scoped";
  const type = family === 4 ? "ipv4" : "ipv6";
  if (METADATA.check(address, type)) return "address_metadata";
  const verdict = validator.endpointRefusal!(family === 4 ? `https://${address}/` : `https://[${address}]/`);
  if (verdict === "internal_host") return "address_internal";
  if (verdict !== "ip_literal") return "address_unparseable_or_scoped";
  if (SPECIAL.check(address, type)) return "address_special_purpose";
  return null;
}
const defaultResolve = async (host: string): Promise<Resolved[]> => {
  const answers = await lookup(host, { all: true, verbatim: true });
  return answers.map(a => ({ address: a.address, family: a.family }));
};
/** Rule 2: one resolution, every answer checked; Refusal when any is refused, a failure when none resolves. */
async function pinAddress(host: string, validator: Validator, resolver: (host: string) => Promise<Resolved[]>): Promise<Resolved | { failure: string }> {
  let answers: Resolved[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    answers = await Promise.race([resolver(host), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("dns_timeout")), 10_000); })]);
  } catch { return { failure: "does not resolve" }; } finally { clearTimeout(timer); }
  if (!Array.isArray(answers) || !answers.length) return { failure: "does not resolve" };
  for (const a of answers) {
    const refused = addressRefusal(typeof a?.address === "string" ? a.address : "", validator);
    if (refused) throw new Refusal(`service_${refused}`);
  }
  return { address: answers[0].address, family: answers[0].family };
}
const sameAddress = (a: string, b: string) => {
  const norm = (x: string) => isIP(x) === 6 ? new URL(`https://[${x}]/`).hostname : x.replace(/^::ffff:/i, "");
  try { return norm(a) === norm(b); } catch { return false; }
};
/** Rule 3: TLS to the pinned address, verified for the name; a socket at any other address is destroyed. */
export const tlsDial: Dial = to => {
  const socket = tlsConnect({ host: to.address, port: to.port, servername: to.host, ALPNProtocols: ["http/1.1"], rejectUnauthorized: true });
  socket.once("secureConnect", () => {
    if (!sameAddress(String(socket.remoteAddress ?? ""), to.address)) socket.destroy(Object.assign(new Error("address"), { code: "ADDRESS_MISMATCH" }));
  });
  return socket;
};

type Wire = { host: string; basePath: string; address: string; family: number; dial: Dial; requests: number; dials: number; deadline: number; late: boolean };
type Answer = { status: number; headers: Map<string, string>; body: Buffer; packet?: unknown; ms: number };
type Failed = { failure: string; ms: number };
type Caps = { timeoutMs: number; maxBytes: number; rpcId?: number; headOnly?: boolean };
const failed = (x: Answer | Failed): x is Failed => "failure" in x;

/** An HTTP/1.1 response read incrementally under the caps (rule 3-4); push() returns an outcome when done. */
class ResponseReader {
  private buf = Buffer.alloc(0);
  private mode: "head" | "length" | "chunked" | "close" = "head";
  private chunk: "size" | "data" | "crlf" | "trailer" = "size";
  private remaining = 0;
  private parts: Buffer[] = [];
  private size = 0;
  private sse = false;
  private text = "";
  private decoder = new TextDecoder();
  status = 0;
  headers = new Map<string, string>();
  constructor(private caps: Caps) {}
  private out(extra: { packet?: unknown } = {}) {
    return { status: this.status, headers: this.headers, body: Buffer.concat(this.parts), ...extra };
  }
  push(data: Buffer): { failure: string } | Omit<Answer, "ms"> | null {
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    if (this.mode === "head") {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return this.buf.length > MAX_HEAD_BYTES ? { failure: `response headers over ${MAX_HEAD_BYTES} bytes` } : null;
      if (end > MAX_HEAD_BYTES) return { failure: `response headers over ${MAX_HEAD_BYTES} bytes` };
      const lines = this.buf.subarray(0, end).toString("latin1").split("\r\n");
      this.buf = this.buf.subarray(end + 4);
      const m = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/.exec(lines[0]);
      if (!m) return { failure: "not an HTTP/1.1 answer" };
      this.status = Number(m[1]);
      for (const line of lines.slice(1)) {
        const colon = line.indexOf(":");
        if (colon <= 0) return { failure: "a malformed response header" };
        const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
        const prior = this.headers.get(name);
        if (prior === undefined) this.headers.set(name, value);
        else if (["content-length", "transfer-encoding", "content-type", "location"].includes(name)) {
          if (prior !== value) return { failure: `two different ${name} headers` };
        } else this.headers.set(name, `${prior}, ${value}`);
      }
      if (this.status < 200) return { failure: `an informational ${this.status} answer (not supported)` };
      const encoding = (this.headers.get("content-encoding") ?? "identity").toLowerCase();
      if (encoding !== "identity") return { failure: `a compressed body (content-encoding ${show([encoding]).slice(1)}); the suite asks for identity` };
      // A redirect is reported, never followed, and its body is never read; so is a head-only answer.
      if (this.caps.headOnly || (this.status >= 300 && this.status < 400) || this.status === 204) return this.out();
      const te = this.headers.get("transfer-encoding"), cl = this.headers.get("content-length");
      if (te !== undefined) {
        if (te.toLowerCase() !== "chunked") return { failure: `transfer-encoding ${show([te]).slice(1)} (only chunked)` };
        this.mode = "chunked";
      } else if (cl !== undefined) {
        if (!/^[0-9]{1,15}$/.test(cl)) return { failure: "a malformed content-length" };
        this.remaining = Number(cl);
        if (this.remaining > this.caps.maxBytes) return { failure: `content-length ${this.remaining} is over maxResponseBytes ${this.caps.maxBytes}` };
        this.mode = "length";
      } else this.mode = "close";
      this.sse = this.caps.rpcId !== undefined && /^text\/event-stream\b/i.test(this.headers.get("content-type") ?? "");
      if (this.mode === "length" && this.remaining === 0) return this.complete();
    }
    return this.drain();
  }
  private drain(): { failure: string } | Omit<Answer, "ms"> | null {
    for (;;) {
      if (this.mode === "close") {
        const r = this.buf.length ? this.data(this.buf) : null;
        this.buf = Buffer.alloc(0);
        return r;
      }
      if (this.mode === "length") {
        const take = Math.min(this.remaining, this.buf.length);
        const r = take ? this.data(this.buf.subarray(0, take)) : null;
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (r) return r;
        return this.remaining === 0 ? this.complete() : null;
      }
      if (this.chunk === "size" || this.chunk === "trailer") {
        const eol = this.buf.indexOf("\r\n");
        if (eol < 0) return this.buf.length > 1024 ? { failure: "a malformed chunked body" } : null;
        const line = this.buf.subarray(0, eol).toString("latin1");
        this.buf = this.buf.subarray(eol + 2);
        if (this.chunk === "trailer") { if (line === "") return this.complete(); continue; }
        const m = /^([0-9a-fA-F]{1,8})(?:[ \t]*;[^\r\n]*)?$/.exec(line);
        if (!m) return { failure: "a malformed chunked body" };
        this.remaining = parseInt(m[1], 16);
        this.chunk = this.remaining === 0 ? "trailer" : "data";
        continue;
      }
      if (this.chunk === "data") {
        const take = Math.min(this.remaining, this.buf.length);
        if (!take) return null;
        const r = this.data(this.buf.subarray(0, take));
        this.buf = this.buf.subarray(take);
        this.remaining -= take;
        if (r) return r;
        if (this.remaining) return null;
        this.chunk = "crlf";
        continue;
      }
      if (this.buf.length < 2) return null;
      if (this.buf[0] !== 13 || this.buf[1] !== 10) return { failure: "a malformed chunked body" };
      this.buf = this.buf.subarray(2);
      this.chunk = "size";
    }
  }
  /** The decoded body, counted against maxBytes; an event stream answers as soon as its response arrives. */
  private data(part: Buffer): { failure: string } | Omit<Answer, "ms"> | null {
    this.size += part.length;
    if (this.size > this.caps.maxBytes) return { failure: `the body is over maxResponseBytes ${this.caps.maxBytes}` };
    this.parts.push(Buffer.from(part));
    if (!this.sse) return null;
    this.text += this.decoder.decode(part, { stream: true });
    let boundary: RegExpExecArray | null;
    while ((boundary = /\r?\n\r?\n/.exec(this.text))) {
      const event = this.text.slice(0, boundary.index);
      this.text = this.text.slice(boundary.index + boundary[0].length);
      const data = event.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      if (!data) continue;
      const parsed = strictJson(data);
      if (!parsed.ok) return { failure: "an event that is not strict JSON" };
      if (parsed.duplicates.length) return { failure: "an event with a duplicate JSON key" };
      if (isObject(parsed.value) && parsed.value.id === this.caps.rpcId) return this.out({ packet: parsed.value });
    }
    return null;
  }
  private complete(): { failure: string } | Omit<Answer, "ms"> {
    if (this.sse) return { failure: `the event stream ended without the response to request ${this.caps.rpcId}` };
    return this.out();
  }
  /** The peer closed the connection. */
  end(): { failure: string } | Omit<Answer, "ms"> {
    if (this.mode === "head") return { failure: "the connection closed before an answer" };
    if (this.mode === "close") return this.complete();
    return { failure: "the connection closed in the middle of the body" };
  }
}

/** Rules 3-5: one request on a fresh connection to the pinned address; never follows anything. */
function exchange(w: Wire, method: string, path: string, extra: [string, string][], body: Buffer | null, caps: Caps): Promise<Answer | Failed> {
  const started = Date.now();
  const left = w.deadline - started;
  if (left <= 0) { w.late = true; return Promise.resolve({ failure: DEADLINE_FAILURE, ms: 0 }); }
  if (++w.requests > MAX_SERVICE_REQUESTS) return Promise.resolve({ failure: `over the suite's ${MAX_SERVICE_REQUESTS}-request cap`, ms: 0 });
  const headers: [string, string][] = [["Host", w.host], ["User-Agent", "agent-village-conformance/1"], ["Accept-Encoding", "identity"],
    ["Connection", "close"], ...extra];
  if (body) headers.push(["Content-Type", "application/json"], ["Content-Length", String(body.length)]);
  for (const [name, value] of headers) {
    // Built here only; this guard keeps it so (no credential header can ever be added by a later edit).
    if (!SENT_HEADERS.has(name.toLowerCase()) || /[^\x20-\x7e]/.test(value)) throw new Error("conformance_header_not_allowed");
  }
  if (!/^\/[\x21-\x7e]*$/.test(path)) throw new Error("conformance_bad_path");
  const head = Buffer.from(`${method} ${path} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`, "latin1");
  return new Promise(resolveAnswer => {
    let socket: Duplex | undefined;
    let settled = false;
    const reader = new ResponseReader(caps);
    const settle = (r: { failure: string } | Omit<Answer, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.destroy(); } catch { /* closing only */ }
      resolveAnswer({ ...r, ms: Date.now() - started } as Answer | Failed);
    };
    const cut = left < caps.timeoutMs;
    const timer = setTimeout(() => {
      if (cut) w.late = true;
      settle({ failure: cut ? DEADLINE_FAILURE : `no complete answer within ${caps.timeoutMs} ms` });
    }, Math.min(caps.timeoutMs, left));
    try {
      w.dials++;
      socket = w.dial({ address: w.address, family: w.family, host: w.host, port: 443 });
    } catch { settle({ failure: "could not connect" }); return; }
    socket.on("data", (chunk: Buffer) => { const r = reader.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); if (r) settle(r); });
    socket.on("end", () => settle(reader.end()));
    socket.on("close", () => settle(reader.end()));
    socket.on("error", (e: any) => settle({ failure: `could not connect or read (${said(typeof e?.code === "string" ? e.code : "error")})` }));
    socket.write(body ? Buffer.concat([head, body]) : head);
  });
}
const redirectNote = (w: Wire, a: Answer) => {
  let where = "no location";
  try { where = new URL(a.headers.get("location") ?? "", `https://${w.host}/`).hostname === w.host ? "the same host" : "another host"; } catch { /* unparseable */ }
  return `a ${a.status} redirect to ${where}, never followed`;
};
const isRedirect = (a: Answer) => a.status >= 300 && a.status < 400;
/** The answer's body as strict JSON (a duplicate key, or not JSON, is a problem). */
function bodyJson(a: Answer): { value: unknown } | { problem: string } {
  const text = utf8(a.body);
  if (text === null) return { problem: "the body is not UTF-8" };
  const parsed = strictJson(text);
  if (!parsed.ok) return { problem: `the body is not strict JSON (${parsed.error})` };
  if (parsed.duplicates.length) return { problem: `the body has a duplicate key ${show([...parsed.duplicates[0].at, parsed.duplicates[0].key])}` };
  return { value: parsed.value };
}

// ---- MCP over Streamable HTTP (protocol 2025-06-18, the app server's callReviewedMcp sequence) -------------
type Session = { headers: [string, string][]; nextId: number };
const MCP_ACCEPT: [string, string] = ["Accept", "application/json, text/event-stream"];
type RpcResult = { result: any; ms: number; headers: Map<string, string> };
type RpcProblem = { problem: string; ms: number; answer?: Answer };
/** A protocol error a tools/call answered (only with errors: true): a well-formed JSON-RPC error. */
type RpcError = { rpcError: { code: number; message: string }; packet: Record<string, any>; ms: number };
async function rpc(w: Wire, s: Session, method: string, params: unknown, caps: Omit<Caps, "rpcId">): Promise<RpcResult | RpcProblem>;
async function rpc(w: Wire, s: Session, method: string, params: unknown, caps: Omit<Caps, "rpcId">, errors: true): Promise<RpcResult | RpcError | RpcProblem>;
async function rpc(w: Wire, s: Session, method: string, params: unknown, caps: Omit<Caps, "rpcId">, errors = false): Promise<RpcResult | RpcError | RpcProblem> {
  const id = s.nextId++;
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
  const a = await exchange(w, "POST", w.basePath, [MCP_ACCEPT, ...s.headers], body, { ...caps, rpcId: id });
  if (failed(a)) return { problem: a.failure, ms: a.ms };
  if (isRedirect(a)) return { problem: redirectNote(w, a), ms: a.ms, answer: a };
  if (a.status < 200 || a.status > 299) return { problem: `HTTP ${a.status}`, ms: a.ms, answer: a };
  let packet = a.packet;
  if (packet === undefined) {
    const j = bodyJson(a);
    if ("problem" in j) return { problem: j.problem, ms: a.ms };
    packet = j.value;
  }
  if (!isObject(packet) || packet.jsonrpc !== "2.0" || packet.id !== id) return { problem: "not the JSON-RPC response to this request", ms: a.ms };
  if (!errors) {
    if (own(packet, "error") || !isObject(packet.result)) return { problem: "a JSON-RPC error, not a result", ms: a.ms };
    return { result: packet.result, ms: a.ms, headers: a.headers };
  }
  // A tools/call: a JSON-RPC error is a conforming protocol error when it is well-formed (the caller judges it).
  const bad = rpcEnvelopeProblems(packet);
  if (bad.length) return { problem: `a malformed JSON-RPC response (${bad.join("; ")})`, ms: a.ms };
  if (own(packet, "error")) return { rpcError: packet.error, packet, ms: a.ms };
  return { result: packet.result, ms: a.ms, headers: a.headers };
}
async function mcpOpen(w: Wire, caps: Omit<Caps, "rpcId">): Promise<{ session: Session } | { problem: string; answer?: Answer }> {
  const s: Session = { headers: [], nextId: 1 };
  const init = await rpc(w, s, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agent-village-conformance", version: "1" } }, caps);
  if ("problem" in init) return { problem: `initialize: ${init.problem}`, answer: init.answer };
  if (init.result.protocolVersion !== PROTOCOL) return { problem: `initialize answers protocol ${said(init.result.protocolVersion)}, not ${PROTOCOL}` };
  s.headers.push(["MCP-Protocol-Version", PROTOCOL]);
  // The server-issued session id is echoed (the protocol's only state); it is not a credential of ours.
  const sessionId = init.headers.get("mcp-session-id");
  if (sessionId !== undefined && !/^[\x21-\x7e]{1,256}$/.test(sessionId)) return { problem: "initialize: a malformed Mcp-Session-Id" };
  if (sessionId !== undefined) s.headers.push(["Mcp-Session-Id", sessionId]);
  const note = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
  const n = await exchange(w, "POST", w.basePath, [MCP_ACCEPT, ...s.headers], note, { ...caps, headOnly: true });
  if (failed(n)) return { problem: `notifications/initialized: ${n.failure}` };
  if (isRedirect(n)) return { problem: `notifications/initialized: ${redirectNote(w, n)}` };
  if (n.status < 200 || n.status > 299) return { problem: `notifications/initialized: HTTP ${n.status}` };
  return { session: s };
}
/** The input-schema rule of item 2 that a static compare can prove: the manifest is never looser than the tool. */
export function inputCompatibility(manifestInput: unknown, toolSchema: unknown): string[] {
  const out: string[] = [];
  if (!isObject(toolSchema)) return ["the tool advertises no inputSchema object"];
  const m = isObject(manifestInput) ? manifestInput : {};
  const mProps = isObject(m.properties) ? m.properties : {};
  const tProps = isObject(toolSchema.properties) ? toolSchema.properties : null;
  const mRequired = new Set(Array.isArray(m.required) ? m.required : []);
  for (const name of Array.isArray(toolSchema.required) ? toolSchema.required : []) {
    if (!mRequired.has(name)) out.push(`the tool requires ${said(name)}, the manifest does not`);
  }
  for (const name of Object.keys(mProps)) {
    if (!tProps || !own(tProps, name)) {
      if (toolSchema.additionalProperties === false) out.push(`the manifest allows ${show([name]).slice(1)}, the tool does not`);
      continue;
    }
    const types = (t: unknown) => new Set((Array.isArray(t) ? t : [t]).map(describeValue));
    const a = mProps[name]?.type, b = tProps[name]?.type;
    if (a === undefined || b === undefined) continue;
    const tool = types(b);
    if (![...types(a)].every(x => tool.has(x) || (x === "integer" && tool.has("number")))) out.push(`${show([name]).slice(1)} is ${quoted(a)} here, ${quoted(b)} in the tool`);
  }
  return out;
}
/** For an mcp op: the {code, detail} an isError result carries (structuredContent, or its one text item). */
function mcpErrorBody(result: any): unknown {
  if (isObject(result.structuredContent)) return result.structuredContent;
  const texts = Array.isArray(result.content) ? result.content.filter((c: any) => isObject(c) && c.type === "text" && typeof c.text === "string") : [];
  if (texts.length !== 1) return undefined;
  const parsed = strictJson(texts[0].text);
  return parsed.ok && !parsed.duplicates.length ? parsed.value : undefined;
}

/**
 * A server-supplied (or any untrusted) value for a note, without String() or a template on it: an object
 * with a non-callable toString/valueOf ({"toString":1}) makes those throw (review-b S1 on ov#438). A
 * string is itself; anything else is its bounded JSON, or its JSON type when that cannot be produced.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value);
    if (typeof text === "string") return text.length > 120 ? `${text.slice(0, 117)}...` : text;
  } catch { /* fall through to the type */ }
  return value === undefined ? "undefined" : jsonType(value);
}
/** describeValue() through show(): one printable segment for a note. */
const said = (value: unknown) => show([describeValue(value)]).slice(1);
/** Like said(), but a string keeps its JSON quotes (a schema `type` reads "string", not string). */
const quoted = (value: unknown) => show([typeof value === "string" ? JSON.stringify(value) : describeValue(value)]).slice(1);
// ---- Fixture shape --------------------------------------------------------------------------------------
const jsonType = (v: unknown) => v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
/**
 * "Fixture-shaped": the live answer has the fixture's JSON type at every place the fixture names; an object
 * may carry more keys than the fixture, a fixture null matches anything, and every element of a live array
 * (the first 50) is shaped like the fixture array's first element.
 */
export function shapeProblems(fixture: unknown, live: unknown, at: Pointer = [], out: string[] = [], depth = 0): string[] {
  if (out.length >= MAX_NOTE_ITEMS || fixture === null || depth > 32) return out;
  const a = jsonType(fixture), b = jsonType(live);
  if (a !== b) { out.push(`${show(at)} is ${b}, the fixture has ${a}`); return out; }
  if (a === "object") {
    for (const key of Object.keys(fixture as object)) {
      if (!own(live as object, key)) out.push(`${show([...at, key])} is missing`);
      else shapeProblems((fixture as any)[key], (live as any)[key], [...at, key], out, depth + 1);
    }
  } else if (a === "array" && (fixture as unknown[]).length) {
    (live as unknown[]).slice(0, 50).forEach((item, i) => shapeProblems((fixture as unknown[])[0], item, [...at, String(i)], out, depth + 1));
  }
  return out;
}

// ---- The checks -----------------------------------------------------------------------------------------
type Call = { op: any; label: string; args: Record<string, unknown>; expected: unknown; error: boolean };
/** Read ops and the calls their fixtures pair (<name>.request.json -> <name>.json), plus the ops not callable. */
function plan(manifest: any, files: Fixture[]): { calls: Call[]; unchecked: string[]; reads: any[] } {
  const reads = opsOf(manifest).filter(op => op.class === "read");
  const calls: Call[] = [], unchecked: string[] = [];
  for (const op of reads) {
    const mine = files.filter(f => f.op === op.name && f.request);
    const kind = manifest.service.kind;
    const method = kind === "https-json" ? op.target?.method : "POST";
    if (kind === "https-json" && method !== "GET" && method !== "POST") { unchecked.push(`${op.name}: a read op with method ${said(method)} is never called (it could change state)`); continue; }
    if (!mine.length) { unchecked.push(`${op.name}: no <name>.request.json`); continue; }
    for (const f of mine) {
      const response = files.find(x => x.op === op.name && x.name === f.pair);
      if (!isObject(f.value) || !response || response.value === undefined) { unchecked.push(`${f.label}: the request or its response fixture is not readable strict JSON`); continue; }
      if (kind === "https-json" && method === "GET" && Object.keys(f.value).length) {
        unchecked.push(`${f.label}: a GET op takes no arguments yet (the design has no query convention); give {}`);
        continue;
      }
      calls.push({ op, label: f.label, args: f.value as Record<string, unknown>, expected: response.value, error: response.error });
    }
  }
  return { calls, unchecked, reads };
}
type Outcome = { budget: string[]; error: string[]; ok: boolean };
/** One read op call: its answer within the op's caps, then shaped like its fixture (or its error body). */
async function call(w: Wire, c: Call, kind: string, session: Session | null, appId: string, validator: Validator): Promise<Outcome> {
  const caps = { timeoutMs: validator.operationBudgets(c.op).timeoutMs, maxBytes: validator.operationBudgets(c.op).maxResponseBytes };
  const budget: string[] = [], error: string[] = [];
  const problems = c.error ? error : budget;
  let value: unknown;
  if (kind === "mcp") {
    const r = await rpc(w, session!, "tools/call", { name: c.op.target.tool, arguments: c.args }, caps, true);
    if ("problem" in r) { (r.problem.startsWith("no complete answer") || r.problem.includes("maxResponseBytes") ? budget : problems).push(`${c.label}: ${r.problem}`); return { budget, error, ok: false }; }
    if (c.error) {
      error.push(...mcpErrorAnswerProblems(c, r, appId));
      return { budget, error, ok: !error.length };
    }
    if ("rpcError" in r) { budget.push(`${c.label}: a JSON-RPC error, not a result`); return { budget, error, ok: false }; }
    if (r.result.isError === true) { budget.push(`${c.label}: answered isError where the fixture is a success`); return { budget, error, ok: false }; }
    value = r.result;
  } else {
    const method = c.op.target.method;
    const path = (w.basePath.endsWith("/") ? w.basePath.slice(0, -1) : w.basePath) + c.op.target.path;
    const body = method === "POST" ? Buffer.from(JSON.stringify(c.args)) : null;
    const a = await exchange(w, method, path, [["Accept", "application/json"]], body, caps);
    if (failed(a)) { (a.failure.startsWith("could not") ? problems : budget).push(`${c.label}: ${a.failure}`); return { budget, error, ok: false }; }
    if (isRedirect(a)) { problems.push(`${c.label}: ${redirectNote(w, a)}`); return { budget, error, ok: false }; }
    if (c.error ? !(a.status >= 400 && a.status <= 499) : !(a.status >= 200 && a.status <= 299)) {
      problems.push(`${c.label}: HTTP ${a.status}, the fixture is ${c.error ? "an error body (a documented 4xx)" : "a success (2xx)"}`);
      return { budget, error, ok: false };
    }
    const j = bodyJson(a);
    if ("problem" in j) { problems.push(`${c.label}: ${j.problem}`); return { budget, error, ok: false }; }
    value = j.value;
  }
  const secrets = secretFindings(value);
  if (secrets.length) problems.push(`${c.label}: the answer holds a secret pattern at ${show(secrets[0][0])} (${secrets[0][1]})`);
  if (c.error) {
    error.push(...errorBodyProblems(`${c.label} (live)`, value, appId));
    const want = isObject(c.expected) ? c.expected.code : undefined;
    if (isObject(value) && value.code !== want) error.push(`${c.label}: code ${said(value.code)}, the fixture says ${said(want)}`);
  } else {
    for (const p of shapeProblems(c.expected, value)) budget.push(`${c.label}: ${p}`);
  }
  return { budget, error, ok: !budget.length && !error.length };
}

/**
 * An mcp error call's live answer against its fixture. Conforming: a well-formed isError result or JSON-RPC
 * error of the fixture's kind. A fixture code (its {code, detail}, or the one its isError result carries)
 * needs the same closed code carried live; a JSON-RPC fixture needs the same integer code; an opaque
 * (plain-text) isError fixture needs any well-formed isError result. A carried {code, ...} is always held to
 * errorBodyProblems. A malformed fixture (hygiene fails it) holds the answer only to being well-formed.
 */
function mcpErrorAnswerProblems(c: Call, r: RpcResult | RpcError, appId: string): string[] {
  const out: string[] = [];
  const fx = mcpErrorOf(c.expected);
  const want: { code: unknown } | { rpc: number } | { tool: true } | null = fx === null ? { code: isObject(c.expected) ? c.expected.code : undefined }
    : "problems" in fx ? null
    : fx.error.kind === "protocol" ? { rpc: fx.error.code }
    : claimsCode(fx.error.carried) ? { code: fx.error.carried.code } : { tool: true };
  const answer = "rpcError" in r ? r.packet.error : r.result;
  const secrets = secretFindings(answer);
  if (secrets.length) out.push(`${c.label}: the answer holds a secret pattern at ${show(secrets[0][0])} (${secrets[0][1]})`);
  if ("rpcError" in r) {
    const code = r.rpcError.code;
    if (want && "rpc" in want) { if (want.rpc !== code) out.push(`${c.label}: JSON-RPC error ${code}, the fixture says ${want.rpc}`); }
    else if (want && "code" in want) out.push(`${c.label}: a JSON-RPC error ${code}, the fixture says code ${said(want.code)}`);
    else if (want) out.push(`${c.label}: a JSON-RPC error ${code}, the fixture is an isError result`);
    return out;
  }
  if (r.result.isError !== true) return [`${c.label}: answered a result, not isError or a JSON-RPC error, where the fixture is an error body`];
  const bad = toolErrorProblems(r.result);
  if (bad.length) return [...out, `${c.label}: a malformed isError result (${bad.join("; ")})`];
  if (want && "rpc" in want) out.push(`${c.label}: an isError result, the fixture is JSON-RPC error ${want.rpc}`);
  const carried = mcpErrorBody(r.result);
  if (claimsCode(carried)) {
    out.push(...errorBodyProblems(`${c.label} (live)`, carried, appId));
    if (want && "code" in want && carried.code !== want.code) out.push(`${c.label}: code ${said(carried.code)}, the fixture says ${said(want.code)}`);
  } else if (want && "code" in want) out.push(`${c.label}: the isError result carries no {code, detail} (structuredContent or one JSON text item)`);
  return out;
}

/**
 * The v1 rows (service.reachability, service.budgets, service.error_bodies) against the --service endpoint.
 * Throws Refusal for a refused URL or address (rules 1-2), before any connection.
 */
export async function serviceChecks(input: { url: string; manifest: any; valid: boolean; files: Fixture[]; validator: Validator; deps?: ServiceDeps }): Promise<Result[]> {
  const held: { w?: Wire } = {};
  const rows = await serviceRows(input, held);
  if (!held.w?.late) return rows;
  // Past the whole-run deadline (review-b N3): a row whose failure the deadline did not cause stays a FAIL;
  // every other row is "not run (deadline)", since it was not checked to the end.
  const ms = input.deps?.deadlineMs ?? SERVICE_DEADLINE_MS;
  return rows.map(r => r.pass === false && !r.note.includes(DEADLINE_FAILURE) ? r
    : notRun(r.check, `not run (deadline): the service checks stop after ${ms} ms in all, and this one was not finished`));
}
async function serviceRows(input: { url: string; manifest: any; valid: boolean; files: Fixture[]; validator: Validator; deps?: ServiceDeps }, held: { w?: Wire }): Promise<Result[]> {
  const started = Date.now();
  const R = "service.reachability", B = "service.budgets", E = "service.error_bodies";
  const { manifest, validator } = input;
  const target = serviceTarget(input.url, validator);
  const all = (note: string) => [notRun(R, note), notRun(B, note), notRun(E, note)];
  if (!input.valid) return all("the manifest is not a valid v2 manifest: no service is called");
  const kind = manifest.service.kind;
  if (kind !== "mcp" && kind !== "https-json") return all(`service.kind ${said(kind)}: first-party handlers in the app, no service to call`);
  const pinned = await pinAddress(target.host, validator, input.deps?.resolve ?? defaultResolve);
  if ("failure" in pinned) return [fail(R, `${target.host} ${pinned.failure}`), notRun(B, "the service did not resolve"), notRun(E, "the service did not resolve")];
  const w: Wire = { host: target.host, basePath: target.basePath, address: pinned.address, family: pinned.family, dial: input.deps?.dial ?? tlsDial,
    requests: 0, dials: 0, deadline: started + (input.deps?.deadlineMs ?? SERVICE_DEADLINE_MS), late: false };
  held.w = w;
  const defaults = validator.operationBudgets({});
  const sessionCaps = { timeoutMs: defaults.timeoutMs, maxBytes: defaults.maxResponseBytes };
  const mode = manifest.service.auth?.mode ?? "none";
  const appId = manifest.id;
  const { calls, unchecked, reads } = plan(manifest, input.files);
  const at = `${target.host} (${pinned.address})`;

  if (mode !== "none") {
    // Rule 5: never a credential, so only the refusal without one is checkable.
    const probe = kind === "mcp" ? null : calls.find(c => !c.error) ?? calls[0];
    let a: Answer | Failed;
    if (kind === "mcp") {
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "agent-village-conformance", version: "1" } } }));
      a = await exchange(w, "POST", w.basePath, [MCP_ACCEPT], body, { ...sessionCaps, headOnly: true });
    } else if (probe) {
      const path = (w.basePath.endsWith("/") ? w.basePath.slice(0, -1) : w.basePath) + probe.op.target.path;
      a = await exchange(w, probe.op.target.method, path, [["Accept", "application/json"]], probe.op.target.method === "POST" ? Buffer.from(JSON.stringify(probe.args)) : null, { ...sessionCaps, headOnly: true });
    } else {
      return [notRun(R, `auth ${mode}: no read op request to probe the token refusal with (${listNote(unchecked)})`), ...all(`auth ${mode}: a call needs a credential, and conformance never sends one`).slice(1)];
    }
    const refusals = mode === "oauth" ? [401] : [401, 403];
    const problems: string[] = [], notes: string[] = [];
    if (failed(a)) problems.push(`without a token: ${a.failure}`);
    else if (isRedirect(a)) problems.push(`without a token: ${redirectNote(w, a)}`);
    else if (!refusals.includes(a.status)) problems.push(`without a token it answers HTTP ${a.status}, not ${refusals.join(" or ")} (auth ${mode})`);
    else notes.push(`refuses a call without a token (HTTP ${a.status})`);
    if (mode === "oauth") {
      const discovery = String(manifest.service.auth?.oauth?.discovery ?? "");
      let url: URL | null = null;
      try { url = new URL(discovery); } catch { /* the validator refuses it first */ }
      if (url && url.hostname === target.host) {
        const d = await exchange(w, "GET", url.pathname, [["Accept", "application/json"]], null, sessionCaps);
        if (failed(d)) problems.push(`oauth discovery: ${d.failure}`);
        else if (isRedirect(d)) problems.push(`oauth discovery: ${redirectNote(w, d)}`);
        else if (d.status !== 200) problems.push(`oauth discovery answers HTTP ${d.status}, not 200`);
        else { const j = bodyJson(d); if ("problem" in j || !isObject((j as any).value)) problems.push(`oauth discovery: ${"problem" in j ? j.problem : "not a JSON object"}`); else notes.push("oauth discovery answers 200 with a JSON object"); }
      } else notes.push(`oauth discovery is on ${url ? show([url.hostname]).slice(1) : "no host"}, not the --service host: not fetched (only the --service host is ever contacted)`);
    }
    const credential = `auth ${mode}: a read needs a credential, and conformance never sends one`;
    return [problems.length ? fail(R, `${at}: ${listNote([...problems, ...notes])}`) : pass(R, `${at}: ${notes.join("; ")}`), notRun(B, credential), notRun(E, credential)];
  }

  const reach: string[] = [], reachNotes: string[] = [];
  let session: Session | null = null;
  if (kind === "mcp") {
    const open = await mcpOpen(w, sessionCaps);
    if ("problem" in open) {
      const why = `the MCP session did not start (${open.problem})`;
      return [fail(R, `${at}: ${open.problem}`), notRun(B, why), notRun(E, why)];
    }
    session = open.session;
    const tools = new Map<string, unknown>();
    let cursor: unknown = undefined;
    for (let page = 0; page < 8; page++) {
      const r = await rpc(w, session, "tools/list", cursor === undefined ? {} : { cursor }, sessionCaps);
      if ("problem" in r) { reach.push(`tools/list: ${r.problem}`); break; }
      for (const t of Array.isArray(r.result.tools) ? r.result.tools : []) if (isObject(t) && typeof t.name === "string") tools.set(t.name, t.inputSchema);
      cursor = r.result.nextCursor;
      if (typeof cursor !== "string" || !cursor) break;
      if (page === 7) reach.push("tools/list: more than 8 pages");
    }
    if (!reach.length) {
      for (const op of opsOf(manifest)) {
        const tool = op.target?.tool;
        if (typeof tool !== "string") continue;
        if (!tools.has(tool)) { reach.push(`${op.name}: tool ${show([tool]).slice(1)} is not in tools/list`); continue; }
        for (const p of inputCompatibility(op.input, tools.get(tool))) reach.push(`${op.name}: ${p}`);
      }
      reachNotes.push(`initialize answers ${PROTOCOL}; tools/list holds every target.tool (${tools.size} tool(s)); inputSchema compared by property names, required and type`);
    }
  }
  const budget: string[] = [], errors: string[] = [];
  let okCalls = 0, errorCalls = 0;
  for (const c of calls) {
    if (c.error) errorCalls++;
    const o = await call(w, c, kind, session, appId, validator);
    budget.push(...o.budget);
    errors.push(...o.error);
    if (o.ok) okCalls++;
    if (kind === "https-json" && !o.ok && o.budget.concat(o.error).some(p => /could not connect|redirect|HTTP 5|HTTP [0-9]{3}, the fixture is a success/.test(p))) reach.push(`${c.op.name} did not answer 2xx or a documented 4xx`);
  }
  if (kind === "https-json") {
    if (!calls.length) return [notRun(R, `https-json: no read op request to call (${listNote(unchecked)})`), notRun(B, listNote(unchecked)), notRun(E, "no read op request")];
    const answered = new Set(calls.map(c => c.op.name));
    reachNotes.push(`${answered.size} read op path(s) answered 2xx or a documented 4xx; write, prepare and needs-card paths are never called`);
  }
  const reachRow = reach.length ? fail(R, `${at}: ${listNote([...new Set(reach)])}`) : pass(R, `${at}: ${reachNotes.join("; ")}`);
  const successCalls = calls.filter(c => !c.error).length;
  let budgetRow: Result;
  if (budget.length) budgetRow = fail(B, listNote(budget));
  else if (!reads.length) budgetRow = pass(B, "no read operation to call");
  else if (unchecked.length) budgetRow = notRun(B, `not every read op could be called: ${listNote(unchecked)}`);
  else if (!successCalls) budgetRow = notRun(B, "no success request (<name>.request.json paired with a success fixture)");
  else budgetRow = pass(B, `${successCalls} read call(s) answered within timeoutMs and maxResponseBytes, fixture-shaped, strict JSON, no secret pattern`);
  const errorRow = errors.length ? fail(E, listNote(errors))
    : !errorCalls ? notRun(E, "no error request: add <op>/error-<name>.request.json beside its error-<name>.json")
    : pass(E, kind === "mcp"
      ? `${errorCalls} error call(s) answered like their fixture: exactly {code, detail} with its closed code, or a well-formed isError result or JSON-RPC error`
      : `${errorCalls} error call(s) answered exactly {code, detail} with the fixture's closed code`);
  return [reachRow, budgetRow, errorRow];
}

// ---- CLI -----------------------------------------------------------------------------------------------
export const USAGE = "usage: bun run conformance -- mini-apps/<id>/manifest.json [--fixtures <dir>] [--out <path>] [--base <git ref>] " +
  "[--service https://<your sandbox host>/<path>]";
export function parseArgs(argv: string[]): Options {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--fixtures" || a === "--out" || a === "--base" || a === "--service") {
      const value = args[++i];
      if (value === undefined || value.startsWith("--") || value === "") throw new Refusal(`${a}_needs_a_value`);
      if (own(flags, a)) throw new Refusal(`${a}_given_twice`);
      flags[a] = value;
    } else if (a.startsWith("-")) throw new Refusal(`unknown_option ${a.slice(0, 40)}`);
    else positional.push(a);
  }
  if (positional.length !== 1) throw new Refusal("one_manifest_path_expected");
  return { manifest: positional[0], fixtures: flags["--fixtures"], out: flags["--out"], base: flags["--base"], service: flags["--service"] };
}
export function summary(report: Report): string {
  const label = (r: Result) => r.pass === true ? "PASS   " : r.pass === false ? "FAIL   " : "NOT RUN";
  // The path comes from a directory name: printed through show(), so a newline in it cannot forge a line.
  return [`conformance ${show(report.manifest.split("/")).slice(1)} sha256 ${show([report.sha256]).slice(1)}`,
    ...report.results.map(r => `  ${label(r)} ${r.check}: ${r.note}`),
    `passed: ${report.passed}`].join("\n");
}
/** Written to a temp file beside `path` (wx: never through a planted file or symlink), then renamed. */
function writeOut(path: string, report: Report) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  try { renameSync(tmp, path); } catch (e) { removeFile(tmp); throw e; }
}
/** Unlinks a file or symlink (never its target, never a directory); an absent path is fine. */
function removeFile(path: string) {
  try { unlinkSync(path); } catch (e: any) { if (e?.code !== "ENOENT") throw e; }
}
const inode = (path: string): string | null => {
  try { const st = statSync(path); return `${st.dev}:${st.ino}`; } catch { return null; }
};
/**
 * The git checkout holding `dir` and, for a worktree, its primary checkout (review-b fold-2 N-a): the
 * toplevel, the common git dir (its hooks too), and the checkout that common dir belongs to when it is a
 * `.git` directory. Each is one more place --out may not point into.
 */
function gitGuards(dir: string): string[] {
  const top = git(dir, ["rev-parse", "--show-toplevel"]);
  if (top.status !== 0) return [];
  const out = [top.stdout.toString("utf8").trim()].filter(Boolean);
  const common = git(dir, ["rev-parse", "--git-common-dir"]);
  const path = common.status === 0 ? common.stdout.toString("utf8").trim() : "";
  if (path) {
    const abs = resolve(dir, path);
    out.push(abs);
    if (basename(abs) === ".git") out.push(dirname(abs));
  }
  return out;
}
/**
 * The --out file, resolved, or Refusal (release ruling, CLAIMS L14545). It may not be the manifest (the
 * same dev+ino: a hard link or a symlink to it too), a directory, or anywhere inside the manifest's repo
 * (the directory holding its mini-apps/, and the git checkout around it) or the tool's own root: every
 * ancestor of its real parent is compared by dev+ino with each, and on a case-insensitive filesystem the
 * case-folded real path is compared as well (macOS: MINI-APPS/acme/x.json is under the repo).
 */
export function outPath(outArg: string, manifestArg: string, cwd: string, toolRoot: string): string {
  const out = resolve(cwd, outArg);
  let parent: string;
  try {
    if (!statSync(dirname(out)).isDirectory()) throw new Error();
    parent = realpathSync(dirname(out));
  } catch { throw new Refusal("out_directory_missing"); }
  const real = join(parent, basename(out));
  if (directory(out) || directory(real)) throw new Refusal("out_is_a_directory");
  const manifest = resolve(cwd, manifestArg);
  const manifestId = inode(manifest);
  if (manifestId !== null && (inode(out) === manifestId || inode(real) === manifestId)) throw new Refusal("out_would_overwrite_the_manifest");
  const guards = [toolRoot, ...(directory(toolRoot) ? gitGuards(toolRoot) : [])];
  if (basename(dirname(dirname(manifest))) === "mini-apps") {
    const repo = dirname(dirname(dirname(manifest)));
    guards.push(repo);
    if (directory(repo)) guards.push(...gitGuards(repo));
  }
  const unsafe = "out_inside_the_repo_or_the_tool_root";
  for (const guarded of new Set(guards)) {
    const guardedId = inode(guarded);
    if (guardedId === null) continue;
    for (let p = parent; ; p = dirname(p)) {
      if (inode(p) === guardedId) throw new Refusal(unsafe);
      if (dirname(p) === p) break;
    }
    if (caseInsensitive(guarded)) {
      const fold = (path: string) => path.normalize("NFC").toLowerCase();
      const g = fold(realpathSync(guarded)), o = fold(real);
      if (o === g || o.startsWith(g + sep)) throw new Refusal(unsafe);
    }
  }
  return out;
}
/** Whether the filesystem holding `dir` folds case: its own name upper-cased names the same directory. */
function caseInsensitive(dir: string): boolean {
  const name = basename(dir), flipped = name.toUpperCase() === name ? name.toLowerCase() : name.toUpperCase();
  if (flipped === name) return false;
  const id = inode(dir);
  return id !== null && inode(join(dirname(dir), flipped)) === id;
}
const MAX_REPORT_BYTES = 1 << 20;
/**
 * Whether `path` holds a conformance.json for THIS manifest (`rel`): a regular file (not a symlink) of
 * strict JSON shaped {manifest, sha256, results, passed} whose manifest is `rel`. Only such a file is
 * ever removed or replaced; anything else at --out is refused before the run and left as it is.
 */
export function ownReport(path: string, rel: string): boolean {
  let st;
  try { st = lstatSync(path); } catch { return false; }
  if (!st.isFile() || st.size > MAX_REPORT_BYTES) return false;
  let text: string | null;
  try { text = utf8(readFileSync(path)); } catch { return false; }
  const parsed = text === null ? null : strictJson(text);
  if (!parsed?.ok || parsed.duplicates.length) return false;
  const r = parsed.value;
  return isObject(r) && Object.keys(r).sort().join(",") === "manifest,passed,results,sha256" && r.manifest === rel
    && typeof r.sha256 === "string" && HEX64.test(r.sha256) && typeof r.passed === "boolean" && Array.isArray(r.results)
    && r.results.every((x: unknown) => isObject(x) && Object.keys(x).sort().join(",") === "check,note,pass");
}
/** A 0-byte regular file (a pre-created `mktemp` --out, review-b fold-2 N-b): replaceable, like our own report. */
function emptyFile(path: string): boolean {
  try { const st = lstatSync(path); return st.isFile() && st.size === 0; } catch { return false; }
}
type CliEnv = { cwd?: string; toolRoot?: string; print?: (s: string) => void; warn?: (s: string) => void; service?: ServiceDeps };
type OutState = { out: string | null; rel: string };
/**
 * Every argument (the options, the manifest path, --fixtures, the --base ref, the --service URL, --out),
 * checked before any file is touched, so an argument refusal changes nothing on disk. A file already at
 * --out must be this manifest's own conformance.json or empty (else that is an argument refusal too); it is
 * removed last, after every other check.
 */
function checkArguments(argv: string[], cwd: string, toolRoot: string, state: OutState): Options {
  const opts = parseArgs(argv);
  const at = locate(opts.manifest, cwd);
  if (opts.fixtures !== undefined && !directory(resolve(cwd, opts.fixtures))) throw new Refusal("fixtures_not_a_directory");
  if (opts.base !== undefined) baseCommit(at.root, at.abs, opts.base);
  if (opts.service !== undefined) {
    // The URL rule needs the pinned validator; a pin refusal is left to the run (which removes our report).
    let validator: Validator | null = null;
    try { validator = loadValidator(toolRoot).validator; } catch { /* refused again, as a run refusal */ }
    if (validator) serviceTarget(opts.service, validator);
  }
  if (opts.out !== undefined) {
    const path = outPath(opts.out, opts.manifest, cwd, toolRoot);
    if (exists(path) && !ownReport(path, at.rel) && !emptyFile(path)) throw new Refusal("out_exists_and_is_not_this_manifests_conformance_json");
    state.out = path;
    state.rel = at.rel;
    removeFile(path);
  }
  return opts;
}
function written(report: Report, state: OutState, print: (s: string) => void): number {
  const text = summary(report);
  if (state.out) writeOut(state.out, report);
  print(text);
  return report.passed ? 0 : 1;
}
function refused(e: unknown, state: OutState, warn: (s: string) => void): number {
  if (state.out && ownReport(state.out, state.rel)) { try { removeFile(state.out); } catch { /* the refusal below stands */ } }
  if (e instanceof Refusal) { warn(`conformance: refused: ${e.reason}\n${USAGE}`); return 2; }
  warn(`conformance: refused: internal error ${e instanceof Error ? e.name : "unknown"}`);
  return 2;
}
/**
 * The CLI: returns the exit code (0 passed, 1 failed, 2 refused). Arguments: checkArguments. The new
 * report is renamed into place only for exit 0 or 1. On any later refusal only a file that parses as this
 * manifest's conformance.json is removed. Synchronous, so without --service only (mainAsync runs both).
 */
export function main(argv: string[], { cwd = process.cwd(), toolRoot = resolve(import.meta.dir, ".."), print = console.log, warn = console.error }: CliEnv = {}): number {
  const state: OutState = { out: null, rel: "" };
  try {
    const opts = checkArguments(argv, cwd, toolRoot, state);
    if (opts.service !== undefined) throw new Refusal("service_needs_mainAsync");
    return written(runConformance(opts, { cwd, toolRoot }), state, print);
  } catch (e) { return refused(e, state, warn); }
}
/** The CLI entry: main, plus the v1 service checks when --service is given (the network is async). */
export async function mainAsync(argv: string[], { cwd = process.cwd(), toolRoot = resolve(import.meta.dir, ".."), print = console.log, warn = console.error, service }: CliEnv = {}): Promise<number> {
  const state: OutState = { out: null, rel: "" };
  try {
    const opts = checkArguments(argv, cwd, toolRoot, state);
    return written(await runConformanceAsync(opts, { cwd, toolRoot, service }), state, print);
  } catch (e) { return refused(e, state, warn); }
}

if (import.meta.main) process.exit(await mainAsync(process.argv.slice(2)));
