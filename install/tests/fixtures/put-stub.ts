/**
 * A local stub bucket for the nap tests: a Bun server on 127.0.0.1 that accepts presigned-style PUTs and
 * GETs by URL. Each URL carries `X-Amz-Expires`, `X-Amz-Date` and an HMAC `X-Amz-Signature` over the method,
 * the object key and the expiry, checked as a presigned URL is: a bad or expired signature is 403. A DELETE
 * is always 403, as the bucket policy refuses the writer key one (design 13 S7). Objects live in memory.
 * Behaviour hooks let a test fail, hang or count requests. No network beyond loopback.
 */
import { createHmac, randomBytes } from "node:crypto";

export type StubRequest = { method: string; key: string };
export type Stub = {
  base: string;
  objects: Map<string, Buffer>;
  requests: StubRequest[];
  /** Return a status to answer instead of storing (e.g. 401, 403, 503), or "hang" to never answer. */
  onPut: (key: string, attempt: number) => number | "hang" | undefined;
  onGet: (key: string) => number | undefined;
  /** Mint a presigned URL for `key` (TTL seconds; negative is already expired). */
  url(method: "PUT" | "GET" | "DELETE", key: string, ttlS?: number): string;
  stop(): void;
};

export function startStub(bucket = "nap-test"): Stub {
  const secret = randomBytes(32);
  const sign = (method: string, key: string, expires: number) =>
    createHmac("sha256", secret).update(`${method}\n${key}\n${expires}`).digest("hex");
  const attempts = new Map<string, number>();
  const hung: (() => void)[] = [];
  const stub: Stub = {
    base: "",
    objects: new Map(),
    requests: [],
    onPut: () => undefined,
    onGet: () => undefined,
    url(method, key, ttlS = 3600) {
      const expires = Math.floor(Date.now() / 1000) + ttlS;
      const q = new URLSearchParams({
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Date": String(expires),
        "X-Amz-Expires": String(ttlS),
        "X-Amz-Signature": sign(method, key, expires),
      });
      return `${stub.base}/${bucket}/${key.split("/").map(encodeURIComponent).join("/")}?${q}`;
    },
    stop() {
      for (const release of hung) release();
      server.stop(true);
    },
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const u = new URL(req.url);
      const prefix = `/${bucket}/`;
      if (!u.pathname.startsWith(prefix)) return new Response("no bucket", { status: 404 });
      const key = decodeURIComponent(u.pathname.slice(prefix.length));
      const expires = Number(u.searchParams.get("X-Amz-Date"));
      const sig = u.searchParams.get("X-Amz-Signature") ?? "";
      stub.requests.push({ method: req.method, key });
      if (req.method === "DELETE") return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      if (sig !== sign(req.method, key, expires) || !(expires > Date.now() / 1000)) {
        return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
      }
      if (req.method === "PUT") {
        const n = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, n);
        const body = Buffer.from(await req.arrayBuffer());
        const act = stub.onPut(key, n);
        if (act === "hang") return new Promise<Response>((res) => hung.push(() => res(new Response("gone", { status: 503 }))));
        if (act !== undefined) return new Response("stub", { status: act });
        stub.objects.set(key, body);
        return new Response(null, { status: 200 });
      }
      if (req.method === "GET") {
        const act = stub.onGet(key);
        if (act !== undefined) return new Response("stub", { status: act });
        const obj = stub.objects.get(key);
        return obj ? new Response(obj, { status: 200 }) : new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
      }
      return new Response("method", { status: 405 });
    },
  });
  stub.base = `http://127.0.0.1:${server.port}`;
  return stub;
}
