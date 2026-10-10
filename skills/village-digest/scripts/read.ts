#!/usr/bin/env bun

const TRUSTED_ORIGIN = "https://agents.edgecity.live";
const ENDPOINT = "/api/v1/village/digest";
export const TIMEOUT_MS = 5_000;
export const MAX_BODY_BYTES = 128 * 1024;
export const MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const TELEGRAM = /^https:\/\/t\.me\/c\/3534940973\/(?:[1-9][0-9]*\/)?[1-9][0-9]*$/;

export type Highlight = {
  title: string; summary: string; topicId: string | null; topicTitle: string | null;
  messageIds: string[]; sourceUrl: string;
};
export type Digest = {
  headline: string; createdAt: string; windowStart: string; windowEnd: string;
  highlights: Highlight[];
};
export type Result =
  | { status: "ok"; retrievedAt: string; digest: Digest; filter?: { topic: string; matched: number } }
  | { status: "unavailable"; retrievedAt: string; digest: null }
  | { status: "error"; error: string };

type Env = Record<string, string | undefined>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keysAre = (v: Record<string, unknown>, keys: string[]) => {
  const actual = Object.keys(v).sort();
  return actual.length === keys.length && actual.every((key, i) => key === [...keys].sort()[i]);
};
const text = (v: unknown, min: number, max: number): v is string => typeof v === "string" && v.length >= min && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const instant = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v) && Number.isFinite(Date.parse(v));
const id = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,19}$/.test(v);

export function configuredOrigin(env: Env): string | null {
  const raw = env.VILLAGE_DIGEST_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.origin !== TRUSTED_ORIGIN || url.username || url.password || url.search || url.hash || !/^\/?$/.test(url.pathname)) return null;
    return TRUSTED_ORIGIN;
  } catch { return null; }
}

function parseHighlight(v: unknown): Highlight | null {
  if (!record(v) || !keysAre(v, ["messageIds", "sourceUrl", "summary", "title", "topicId", "topicTitle"])) return null;
  if (!text(v.title, 1, 80) || !text(v.summary, 1, 420)) return null;
  if (v.topicId !== null && !id(v.topicId)) return null;
  if (v.topicTitle !== null && !text(v.topicTitle, 1, 512)) return null;
  if (!Array.isArray(v.messageIds) || v.messageIds.length < 1 || v.messageIds.length > 8 || !v.messageIds.every(id)) return null;
  if (typeof v.sourceUrl !== "string" || !TELEGRAM.test(v.sourceUrl)) return null;
  const path = new URL(v.sourceUrl).pathname.split("/").filter(Boolean);
  if (path.at(-1) !== v.messageIds[0]) return null;
  if (v.topicId === null ? path.length !== 3 : (path.length !== 4 || path.at(-2) !== v.topicId)) return null;
  return v as Highlight;
}

export function parseResponse(raw: unknown, now = Date.now()): Digest | null | undefined {
  if (!record(raw) || !keysAre(raw, ["digest"])) return undefined;
  if (raw.digest === null) return null;
  const d = raw.digest;
  if (!record(d) || !keysAre(d, ["createdAt", "headline", "highlights", "windowEnd", "windowStart"])) return undefined;
  if (!text(d.headline, 1, 160) || !instant(d.createdAt) || !instant(d.windowStart) || !instant(d.windowEnd)) return undefined;
  const created = Date.parse(d.createdAt), start = Date.parse(d.windowStart), end = Date.parse(d.windowEnd);
  if (created > now + 60_000 || created <= now - MAX_AGE_MS || start >= end || end - start > MAX_WINDOW_MS || end > now + 60_000) return undefined;
  if (!Array.isArray(d.highlights) || d.highlights.length < 1 || d.highlights.length > 8) return undefined;
  const highlights = d.highlights.map(parseHighlight);
  if (highlights.some((h) => h === null)) return undefined;
  return { headline: d.headline, createdAt: d.createdAt, windowStart: d.windowStart, windowEnd: d.windowEnd, highlights: highlights as Highlight[] };
}

async function boundedText(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error("response_too_large");
  if (!response.body) return "";
  const reader = response.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("response_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const all = new Uint8Array(size); let at = 0;
  for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(all);
}

export async function readDigest(env: Env = process.env, fetcher: typeof fetch = fetch, now = Date.now(), topic?: string): Promise<Result> {
  const origin = configuredOrigin(env), secret = env.VILLAGE_DIGEST_READ_SECRET?.trim();
  if (!origin || !secret) return { status: "error", error: "not_configured" };
  if (!SECRET.test(secret)) return { status: "error", error: "invalid_read_secret" };
  let response: Response;
  try {
    response = await fetcher(origin + ENDPOINT, { method: "GET", redirect: "manual", cache: "no-store", headers: { Authorization: `Bearer ${secret}`, Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    return { status: "error", error: timeout ? "timeout" : "unreachable" };
  }
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); return { status: "error", error: "redirect_refused" }; }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel().catch(() => {}); return { status: "error", error: "auth_refused" }; }
  if (response.status === 404) { await response.body?.cancel().catch(() => {}); return { status: "error", error: "service_off" }; }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return { status: "error", error: "service_error" }; }
  let raw: unknown;
  try { raw = JSON.parse(await boundedText(response)); } catch (error) { return { status: "error", error: error instanceof Error && error.message === "response_too_large" ? "response_too_large" : "invalid_response" }; }
  const parsed = parseResponse(raw, now), retrievedAt = new Date(now).toISOString();
  if (parsed === undefined) return { status: "error", error: "invalid_response" };
  if (parsed === null) return { status: "unavailable", retrievedAt, digest: null };
  const wanted = topic?.trim().toLocaleLowerCase("en-US");
  if (!wanted) return { status: "ok", retrievedAt, digest: parsed };
  const highlights = parsed.highlights.filter((h) => [h.topicId, h.topicTitle, h.title, h.summary].some((v) => v?.toLocaleLowerCase("en-US").includes(wanted)));
  return { status: "ok", retrievedAt, digest: { ...parsed, highlights }, filter: { topic: topic!.trim(), matched: highlights.length } };
}

function topicArg(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  if (args.length === 2 && args[0] === "--topic" && args[1]?.trim()) return args[1];
  throw new Error("usage: read.ts [--topic <words>]");
}

if (import.meta.main) {
  try {
    const result = await readDigest(process.env, fetch, Date.now(), topicArg(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (result.status === "error") process.exitCode = 1;
  } catch { console.error(JSON.stringify({ status: "error", error: "invalid_arguments" })); process.exitCode = 2; }
}
