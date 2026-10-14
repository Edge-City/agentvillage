#!/usr/bin/env bun
/**
 * The person's own Edge City profile, read through the Agent Village control plane (DATA-454b).
 *
 *   bun skills/edgeos/scripts/profile.ts [--json]
 *
 * The box's own copy of the person's EdgeOS session token stops working 15 minutes after the agent is
 * made (EdgeOS v1.47), so the profile goes the directory's way (directory.ts): box -> control plane ->
 * Agent Village app -> EdgeOS `GET /humans/me`, read with the person's own Edge City sign-in, which the
 * app refreshes itself. This script calls `GET $CONTROL_PLANE_URL/tenants/$TENANT_ID/edgeos/profile`
 * with `Authorization: Bearer $EDGEOS_API_KEY` (the attendee key the box already holds; the control
 * plane checks it against the tenant's own) and no parameters. It only reads: an edit is made by the
 * person themselves, never by this script.
 *
 * Fallback (Carter's DATA-454 ruling, as the directory): only when the control plane is not connected
 * (a cp setting missing, or it answered 401, 403, 404 or 409) does the script try EdgeOS's own
 * `GET $EDGEOS_API_BASE/humans/me` with `Authorization: Bearer $EDGEOS_API_KEY`, and only to the
 * EdgeOS host (`directBase()`). EdgeOS answers an API key 403 there today; if it ever grants API keys
 * `portal:profile:read`, the same script works with no overlay change. A 429, 5xx, timeout or network
 * error from the control plane is exit 1 at once, with no second call. There is no third path: the
 * box's session token is never read. Both paths print the same eight fields; stderr ends with
 * `via=cp`, `via=direct` (or `via=none` when nothing was called).
 *
 * `CONTROL_PLANE_URL`, `TENANT_ID`, `EDGEOS_API_KEY` and `EDGEOS_API_BASE` come from the environment,
 * else from `$HERMES_HOME/.env` (`setting()` from events.ts). The key never appears in the command,
 * the output or an error, and travels only in the Authorization header, over https to an exact host
 * on a hard-coded list (`CP_HOSTS` and the EdgeOS base, directory.ts), with redirects not followed.
 * The answer is projected to PROFILE_FIELDS, so a field added upstream cannot widen the output.
 *
 * Exit codes (the skill's fail-soft, §8):
 *   0 printed;
 *   2 not connected: the key missing, or the control plane not connected (a setting missing, or 401,
 *     403, 404 for the route not deployed yet or an agent not made through the app, 409) and the
 *     direct path not connected either;
 *   1 can't reach it right now: 429, 5xx, a timeout, a network error or an unreadable answer from the
 *     path that answered last;
 *   3 a usage error;
 *   4 the person's Edge City sign-in in the Agent Village app has lapsed (the control plane answered
 *     `403 not_connected`) and the direct path did not answer either: ask them to sign in to the app
 *     once (SIGNIN_URL in directory.ts), then try again.
 */
import { DEFAULT_BASE, setting } from "./events";
import {
  type Attempt,
  CP_HOSTS,
  type Env,
  EXIT_NOT_CONNECTED,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_USAGE,
  type Options,
  type Result,
  TIMEOUT_MS,
  UUID,
  type Via,
  attempt,
  controlPlaneBase,
  directBase,
  signinLapsed,
} from "./directory";

/** The profile fields, in order (§8, without EdgeOS's internal `id` and `tenant_id`); anything else is dropped. */
export const PROFILE_FIELDS = [
  "first_name", "last_name", "email", "telegram", "gender", "age", "residence", "picture_url",
] as const;

export type Profile = Record<(typeof PROFILE_FIELDS)[number], string | number | boolean | null>;

const USAGE = "usage: bun skills/edgeos/scripts/profile.ts [--json]\n";

/** `--json` or nothing. */
export function parseArgs(argv: string[]): { json: boolean } | { error: string } {
  let json = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else return { error: `unknown argument ${arg}` };
  }
  return { json };
}

const scalar = (v: unknown) =>
  typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) ? v : null;

/** One object cut to PROFILE_FIELDS, each a string, number, boolean or null; null when it is not one object. */
export function projectProfile(body: unknown): Profile | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const source = body as Record<string, unknown>;
  const out = {} as Profile;
  for (const key of PROFILE_FIELDS) out[key] = Object.hasOwn(source, key) ? scalar(source[key]) : null;
  return out;
}

function shown(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value).replace(/\s+/g, " ").trim() || null;
}

/** One line per filled-in field; the name first. */
export function profileLines(profile: Profile): string {
  const name = [shown(profile.first_name), shown(profile.last_name)].filter(Boolean).join(" ");
  const lines = [`name: ${name || "(none)"}`];
  for (const key of ["email", "telegram", "gender", "age", "residence"] as const) {
    const v = shown(profile[key]);
    if (v !== null) lines.push(`${key}: ${v}`);
  }
  const picture = shown(profile.picture_url);
  if (picture) lines.push(`picture: ${picture}`);
  return `${lines.join("\n")}\n`;
}

function finish(a: Attempt<Profile>, via: Via, json: boolean, before = ""): Result {
  const tail = ` via=${via}\n`;
  const prior = before ? `${before}; ` : "";
  if (a.kind === "ok") {
    return { code: EXIT_OK, out: json ? `${JSON.stringify(a.value)}\n` : profileLines(a.value), err: `via=${via}\n` };
  }
  if (a.kind === "not_connected" || a.kind === "signin") {
    return { code: EXIT_NOT_CONNECTED, out: "", err: `profile: not connected: ${prior}${via} ${a.why}${tail}` };
  }
  if (a.kind === "usage") return { code: EXIT_USAGE, out: "", err: `profile: ${prior}${via} ${a.why}${tail}${USAGE}` };
  return { code: EXIT_UNAVAILABLE, out: "", err: `profile: can't reach the profile right now: ${prior}${via} ${a.why}${tail}` };
}

const notConnected = (why: string): Result => ({ code: EXIT_NOT_CONNECTED, out: "", err: `profile: not connected: ${why}\n` });

/**
 * The control plane first; EdgeOS's own /humans/me with the API key only when the control plane is not
 * connected. A control plane `403 not_connected` (the sign-in lapsed) still tries the direct path;
 * unless that works, the answer is exit 4, not 2.
 */
export async function run(argv: string[], env: Env = process.env, fetchImpl: typeof fetch = fetch,
  options: Options = {}): Promise<Result> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) return { code: EXIT_USAGE, out: "", err: `profile: ${parsed.error}\n${USAGE}` };
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;

  const key = setting("EDGEOS_API_KEY", env);
  if (!key) return notConnected("EDGEOS_API_KEY is not set");

  const rawBase = setting("CONTROL_PLANE_URL", env);
  const tenant = setting("TENANT_ID", env);
  let cpWhy = "";
  let cpCalled = false;
  let lapsed = false;
  if (!rawBase) cpWhy = "CONTROL_PLANE_URL is not set";
  else if (!tenant) cpWhy = "TENANT_ID is not set";
  else if (!controlPlaneBase(rawBase)) cpWhy = `CONTROL_PLANE_URL is not https on ${CP_HOSTS.join(", ")}; the key is not sent there`;
  else if (!UUID.test(tenant)) cpWhy = "TENANT_ID is not a tenant id (a UUID)";

  if (!cpWhy) {
    const url = `${controlPlaneBase(rawBase)}/tenants/${tenant.toLowerCase()}/edgeos/profile`;
    const cp = await attempt(url, key, fetchImpl, timeoutMs, projectProfile, "a profile");
    cpCalled = true;
    if (cp.kind === "signin") lapsed = true;
    else if (cp.kind !== "not_connected") return finish(cp, "cp", parsed.json);
    cpWhy = `cp ${cp.why}`;
  }

  // The direct path: EdgeOS's own /humans/me, the key sent only over https to the EdgeOS host.
  const edgeos = directBase(setting("EDGEOS_API_BASE", env));
  if (!edgeos) {
    if (lapsed) return signinLapsed("profile", cpWhy, "cp");
    return notConnected(`${cpWhy}; EDGEOS_API_BASE is not ${DEFAULT_BASE}, so no direct call via=${cpCalled ? "cp" : "none"}`);
  }
  const direct = await attempt(`${edgeos}/humans/me`, key, fetchImpl, timeoutMs, projectProfile, "a profile");
  if (lapsed && direct.kind !== "ok") return signinLapsed("profile", `${cpWhy}; direct ${direct.why}`, "direct");
  return finish(direct, "direct", parsed.json, cpWhy);
}

if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.out) process.stdout.write(result.out);
  if (result.err) process.stderr.write(result.err);
  process.exit(result.code);
}
