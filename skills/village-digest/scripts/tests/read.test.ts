import { describe, expect, test } from "bun:test";
import { MAX_BODY_BYTES, configuredOrigin, parseResponse, readDigest } from "../read";

const NOW = Date.parse("2026-10-11T12:00:00.000Z");
const SECRET = "village_digest_read_0123456789_ABCDEF";
const ENV = { VILLAGE_DIGEST_BASE_URL: "https://agents.edgecity.live", VILLAGE_DIGEST_READ_SECRET: SECRET };
const digest = {
  headline: "What the village is discussing", createdAt: "2026-10-11T11:55:00.000Z",
  windowStart: "2026-10-10T12:00:00.000Z", windowEnd: "2026-10-11T11:50:00.000Z",
  highlights: [
    { title: "Personal agents", summary: "Residents compared local agent memory designs.", topicId: "42", topicTitle: "ODIN", messageIds: ["501", "502"], sourceUrl: "https://t.me/c/3534940973/42/501" },
    { title: "Shared breakfast", summary: "A breakfast conversation continued online.", topicId: null, topicTitle: null, messageIds: ["601"], sourceUrl: "https://t.me/c/3534940973/601" },
  ],
};
const response = (body: unknown, status = 200, headers: HeadersInit = {}) => new Response(JSON.stringify(body), { status, headers });

describe("configuration and request boundary", () => {
  test("only an explicit exact trusted HTTPS app origin is enabled", () => {
    expect(configuredOrigin(ENV)).toBe("https://agents.edgecity.live");
    expect(configuredOrigin({ ...ENV, VILLAGE_DIGEST_BASE_URL: "https://agents.edgecity.live/" })).toBe("https://agents.edgecity.live");
    for (const url of ["", "http://agents.edgecity.live", "https://evil.example", "https://agents.edgecity.live.evil.test", "https://u:p@agents.edgecity.live", "https://agents.edgecity.live/path", "https://agents.edgecity.live/?token=x"])
      expect(configuredOrigin({ ...ENV, VILLAGE_DIGEST_BASE_URL: url })).toBeNull();
  });
  test("off without explicit config and refuses other credential shapes", async () => {
    expect(await readDigest({})).toEqual({ status: "error", error: "not_configured" });
    expect(await readDigest({ VILLAGE_DIGEST_BASE_URL: ENV.VILLAGE_DIGEST_BASE_URL, APP_INTERNAL_SECRET: SECRET })).toEqual({ status: "error", error: "not_configured" });
    expect(await readDigest({ ...ENV, VILLAGE_DIGEST_READ_SECRET: "short" })).toEqual({ status: "error", error: "invalid_read_secret" });
  });
  test("GETs only the fixed route with the dedicated bearer, bounded signal, no redirects", async () => {
    let call: [RequestInfo | URL, RequestInit?] | undefined;
    const fetcher = (async (...args: [RequestInfo | URL, RequestInit?]) => { call = args; return response({ digest }); }) as typeof fetch;
    expect((await readDigest(ENV, fetcher, NOW)).status).toBe("ok");
    expect(String(call?.[0])).toBe("https://agents.edgecity.live/api/v1/village/digest");
    expect(call?.[1]).toMatchObject({ method: "GET", redirect: "manual", cache: "no-store" });
    expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(call?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });
  test("redirect, auth error, feature off, timeout, and other server error have bounded codes", async () => {
    const run = (r: Response | Promise<Response>) => readDigest(ENV, (async () => r) as typeof fetch, NOW);
    expect(await run(new Response(null, { status: 302, headers: { location: "https://evil.test/steal" } }))).toEqual({ status: "error", error: "redirect_refused" });
    expect(await run(response({ secret: SECRET }, 401))).toEqual({ status: "error", error: "auth_refused" });
    expect(await run(response({}, 404))).toEqual({ status: "error", error: "service_off" });
    expect(await run(response({}, 503))).toEqual({ status: "error", error: "service_error" });
    expect(await run(Promise.reject(new DOMException("timed out", "TimeoutError")))).toEqual({ status: "error", error: "timeout" });
  });
});

describe("strict response validation", () => {
  test("accepts the contract, digest:null is unavailable, and emits retrieval/window timestamps", async () => {
    const ok = await readDigest(ENV, (async () => response({ digest })) as typeof fetch, NOW);
    expect(ok).toMatchObject({ status: "ok", retrievedAt: "2026-10-11T12:00:00.000Z", digest: { windowStart: digest.windowStart, windowEnd: digest.windowEnd } });
    expect(await readDigest(ENV, (async () => response({ digest: null })) as typeof fetch, NOW)).toEqual({ status: "unavailable", retrievedAt: "2026-10-11T12:00:00.000Z", digest: null });
  });
  test("refuses malformed, extra, stale, future, oversized-window, and untrusted-link data", () => {
    expect(parseResponse({ digest }, NOW)).not.toBeUndefined();
    const invalid = [
      {}, { digest, extra: true }, { digest: { ...digest, createdAt: "2026-10-10T11:59:59.999Z" } },
      { digest: { ...digest, createdAt: "2026-10-11T12:01:01.000Z" } }, { digest: { ...digest, windowStart: "2026-10-10T11:49:59.999Z" } },
      { digest: { ...digest, highlights: [{ ...digest.highlights[0], sourceUrl: "https://evil.test/42/501" }] } },
      { digest: { ...digest, highlights: [{ ...digest.highlights[0], sourceUrl: "https://t.me/c/999/42/501" }] } },
      { digest: { ...digest, highlights: [{ ...digest.highlights[0], sourceUrl: "https://t.me/c/3534940973/99/501" }] } },
      { digest: { ...digest, highlights: [{ ...digest.highlights[0], sourceUrl: "https://t.me/c/3534940973/42/999" }] } },
      { digest: { ...digest, highlights: [] } }, { digest: { ...digest, unknown: "field" } },
    ];
    for (const value of invalid) expect(parseResponse(value, NOW)).toBeUndefined();
  });
  test("accepts observed topic titles through 512 characters and refuses 513", () => {
    const withTitle = (length: number) => ({
      digest: { ...digest, highlights: [{ ...digest.highlights[0], topicTitle: "t".repeat(length) }] },
    });
    expect(parseResponse(withTitle(161), NOW)).not.toBeUndefined();
    expect(parseResponse(withTitle(512), NOW)).not.toBeUndefined();
    expect(parseResponse(withTitle(513), NOW)).toBeUndefined();
  });
  test("bounds the body and never reflects it or the token", async () => {
    const tooLarge = new Response("x", { headers: { "content-length": String(MAX_BODY_BYTES + 1) } });
    const got = await readDigest(ENV, (async () => tooLarge) as typeof fetch, NOW);
    expect(got).toEqual({ status: "error", error: "response_too_large" });
    expect(JSON.stringify(got)).not.toContain(SECRET);
  });
  test("topic filtering selects available summary only and zero matches is not quiet", async () => {
    const fetcher = (async () => response({ digest })) as typeof fetch;
    const odin = await readDigest(ENV, fetcher, NOW, "ODIN");
    expect(odin).toMatchObject({ status: "ok", filter: { topic: "ODIN", matched: 1 }, digest: { highlights: [{ topicTitle: "ODIN" }] } });
    const none = await readDigest(ENV, fetcher, NOW, "robotics");
    expect(none).toMatchObject({ status: "ok", filter: { topic: "robotics", matched: 0 }, digest: { highlights: [] } });
  });
});
