/**
 * CLAIMS L18050 / L18092: the Railway status watcher
 * (.github/railway-status/railway-status-notify.ts, run by
 * .github/workflows/railway-status-notify.yml outside Railway). Pure: no
 * network (fetch is injected), no files (state is in memory). Outside the
 * overlay's test globs on purpose; run it standalone:
 *
 *   bun test ./.github/railway-status/railway-status-notify.test.ts
 *
 * The fixture is status.railway.com/api/status as served at
 * 2026-10-21T08:04Z (public data; the per-day uptime `entries` dropped, the
 * script never reads them): thirty incidents, one active,
 * QH8L8B3E "Builds are temporarily paused", INVESTIGATING on four Builds
 * components at PARTIAL_OUTAGE.
 *
 * Pinned: the feed parse (newest update's status wins, a status-less note
 * does not move it, resolvedAt forces RESOLVED, one incident per id, a feed
 * with any incident missing a required field refused, either list missing or
 * not an array refused);
 * the diff (first run records everything and posts only unresolved; a new
 * incident posts; a status change posts once and only once; a resolved
 * transition; an incident that vanishes from the feed is kept, so a short
 * feed never replays old ones; a stale already-resolved newcomer is silent;
 * old entries pruned); the message; and the run (dry run sends and writes
 * nothing and needs no token; a fetch failure exits 1, sends nothing and
 * leaves the state untouched; a Telegram failure keeps the sent ones and
 * retries the rest; only a 400 with a known content description (too long,
 * not UTF-8, empty, unparseable entities) is logged, recorded and skipped so
 * later alerts still go, and every other refusal (bodyless 400, unknown
 * description, migrated supergroup, missing rights, CHAT_RESTRICTED, chat or
 * topic not found, 401/403/404/409/429, 5xx, unreachable) stops and retries;
 * no parse mode, link previews off; text cut on whole code points; logs and
 * thrown errors never hold the token, chat id, thread id or Telegram's
 * response body; feed values that could be workflow commands (`::`,
 * newlines) never reach a log or dry-run line start; missing variables exit
 * 2 by name, never value). And the workflow file's public-repo invariants:
 * triggers, permissions, no `${{` in a run line, secrets only in the notify
 * step's env, main-only send and save, the fork guard.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEED_URL,
  FeedError,
  SendError,
  cut,
  logRef,
  logStatus,
  sendTelegram,
  diffState,
  formatComponents,
  formatMessage,
  parseFeed,
  parseIncident,
  parseState,
  runRailwayStatus,
  serializeState,
  telegramFromEnv,
  type Fetch,
  type Incident,
  type State,
} from "./railway-status-notify.ts";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "api-status-2026-10-21.json"), "utf8"));
const NOW = new Date("2026-10-21T08:05:00Z");
const TOKEN = "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const CHAT = "-1001234567890";
const ENV = { ALERTS_TELEGRAM_BOT_TOKEN: TOKEN, ALERTS_TELEGRAM_CHAT_ID: CHAT };

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function rawIncident(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "inc-1",
    slug: "ABCD1234",
    title: "Deploys failing",
    status: "INVESTIGATING",
    createdAt: "2026-10-21T07:00:00+00:00",
    resolvedAt: null,
    components: [{ id: "c1", name: "Deploys", groupName: "US West", impact: "MAJOR_OUTAGE" }],
    updates: [{ id: "u1", status: "INVESTIGATING", message: "Looking into it", createdAt: "2026-10-21T07:00:00+00:00" }],
    ...over,
  };
}

function incident(over: Record<string, unknown> = {}): Incident {
  const i = parseIncident(rawIncident(over));
  if (i === null) throw new Error("fixture incident did not parse");
  return i;
}

function feedOf(...incidents: Record<string, unknown>[]): unknown {
  return { generatedAt: "2026-10-21T08:00:00Z", activeIncidents: incidents.filter((i) => i.resolvedAt === null), recentIncidents: incidents, maintenances: [], entries: [] };
}

type Call = { url: string; body: Record<string, unknown> | null };

/**
 * A fetch serving `feed` (or failing) and recording Telegram posts; `telegram`
 * decides each post's status (and, for a 400, Telegram's description) from
 * its index and text.
 */
function fakeFetch(
  feed: unknown | Error | number,
  telegram: (n: number, text: string) => number | [number, string | null] = () => 200,
): { fetch: Fetch; calls: Call[]; posts: () => Call[] } {
  const calls: Call[] = [];
  let posts = 0;
  const f: Fetch = async (url, init) => {
    calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    if (url === FEED_URL) {
      if (feed instanceof Error) throw feed;
      if (typeof feed === "number") return new Response("nope", { status: feed });
      return new Response(JSON.stringify(feed), { status: 200, headers: { "content-type": "application/json" } });
    }
    const body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    const r = telegram(posts++, String(body.text ?? ""));
    const [status, description] = Array.isArray(r) ? r : [r, "Bad Request"];
    // `null`: a reply with no body at all.
    if (description === null) return new Response(null, { status });
    return new Response(JSON.stringify(status === 200 ? { ok: true } : { ok: false, error_code: status, description, parameters: { migrate_to_chat_id: -100999 } }), { status });
  };
  return { fetch: f, calls, posts: () => calls.filter((c) => c.url !== FEED_URL) };
}

/** An in-memory state file and captured output. */
function harness(initial: string | null = null) {
  const files = new Map<string, string>();
  if (initial !== null) files.set("state.json", initial);
  const printed: string[] = [];
  const logs: string[] = [];
  const outputs: string[] = [];
  let writes = 0;
  return {
    files,
    printed,
    logs,
    outputs,
    writes: () => writes,
    opts: (fetch: Fetch) => ({
      fetch,
      now: () => NOW,
      print: (l: string) => printed.push(l),
      log: (l: string) => logs.push(l),
      readFile: (p: string) => files.get(p) ?? null,
      writeFile: (p: string, t: string) => {
        writes++;
        files.set(p, t);
      },
      appendOutput: (l: string) => outputs.push(l),
    }),
  };
}

function stateOf(entries: Record<string, { status: string; updatedAt: string }>): State {
  return { version: 1, incidents: entries };
}

describe("feed", () => {
  test("the live fixture: thirty incidents, QH8L8B3E the one unresolved", () => {
    const { incidents, skipped } = parseFeed(FIXTURE);
    expect(skipped).toBe(0);
    expect(incidents.length).toBe(30);
    const open = incidents.filter((i) => i.status !== "RESOLVED");
    expect(open.map((i) => i.slug)).toEqual(["QH8L8B3E"]);
    const q = open[0]!;
    expect(q.title).toBe("Builds are temporarily paused");
    expect(q.status).toBe("INVESTIGATING");
    expect(q.components.length).toBe(4);
    expect(q.components.every((c) => c.name === "Builds" && c.impact === "PARTIAL_OUTAGE")).toBe(true);
    // Oldest first.
    expect(incidents[0]!.slug).toBe("IJ0R4Q80");
    expect(incidents.at(-1)!.slug).toBe("QH8L8B3E");
  });

  test("status is the newest update's, by time not array order", () => {
    const i = incident({
      status: "INVESTIGATING",
      updates: [
        { status: "INVESTIGATING", message: "first", createdAt: "2026-10-21T07:00:00Z" },
        { status: "MONITORING", message: "third", createdAt: "2026-10-21T07:40:00Z" },
        { status: "IDENTIFIED", message: "second", createdAt: "2026-10-21T07:20:00Z" },
      ],
    });
    expect(i.status).toBe("MONITORING");
    expect(i.latestMessage).toBe("third");
    expect(i.updatedAt).toBe("2026-10-21T07:40:00Z");
  });

  test("resolvedAt forces RESOLVED and counts as an update time", () => {
    const i = incident({ resolvedAt: "2026-10-21T08:00:00Z" });
    expect(i.status).toBe("RESOLVED");
    expect(i.updatedAt).toBe("2026-10-21T08:00:00Z");
    expect(incident({ status: "RESOLVED", resolvedAt: null }).status).toBe("RESOLVED");
  });

  test("a newest update without a status keeps the newest status there is, not the lagging top-level one", () => {
    const i = incident({
      status: "INVESTIGATING",
      updates: [
        { status: "IDENTIFIED", message: "Found it", createdAt: "2026-10-21T07:20:00Z" },
        { status: null, message: "A note", createdAt: "2026-10-21T07:30:00Z" },
        { message: "Another note", createdAt: "2026-10-21T07:40:00Z" },
      ],
    });
    expect(i.status).toBe("IDENTIFIED");
    expect(i.latestMessage).toBe("Another note");
    expect(i.updatedAt).toBe("2026-10-21T07:40:00Z");
  });

  test("no updates: the top-level status", () => {
    expect(incident({ status: "IDENTIFIED", updates: [] }).status).toBe("IDENTIFIED");
  });

  test("an incident in both lists is one incident", () => {
    const a = rawIncident();
    const { incidents, skipped } = parseFeed({ activeIncidents: [a], recentIncidents: [a] });
    expect(incidents.length).toBe(1);
    expect(skipped).toBe(0);
  });

  test("any incident missing a required field refuses the whole feed", () => {
    const shape = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return e instanceof FeedError ? e.code : "other";
      }
      return "parsed";
    };
    const a = rawIncident();
    expect(shape(() => parseFeed({ activeIncidents: [a], recentIncidents: [a, { id: "x" }] }))).toBe("feed_shape_incident");
    expect(shape(() => parseFeed({ activeIncidents: [], recentIncidents: [a, null] }))).toBe("feed_shape_incident");
    for (const field of ["id", "title", "status", "createdAt"]) {
      const { [field]: _gone, ...rest } = rawIncident();
      expect(shape(() => parseFeed({ activeIncidents: [], recentIncidents: [a, rest] }))).toBe("feed_shape_incident");
    }
  });

  test("a feed without both incident lists as arrays is refused", () => {
    const a = rawIncident();
    expect(() => parseFeed({ entries: [] })).toThrow(FeedError);
    expect(() => parseFeed({ recentIncidents: [a] })).toThrow(FeedError);
    expect(() => parseFeed({ activeIncidents: [a] })).toThrow(FeedError);
    expect(() => parseFeed({ activeIncidents: a, recentIncidents: [a] })).toThrow(FeedError);
    expect(() => parseFeed({ activeIncidents: [], recentIncidents: a })).toThrow(FeedError);
    expect(() => parseFeed(null)).toThrow(FeedError);
    expect(() => parseFeed("<html>")).toThrow(FeedError);
  });

  test("a slug that is not a slug links the status page, not a built path", () => {
    const i = incident({ slug: "../../evil" });
    expect(i.slug).toBeNull();
    expect(formatMessage({ kind: "new", incident: i })).toEndWith("\nhttps://status.railway.com");
  });
});

describe("diff", () => {
  test("first run (no state): everything recorded, only unresolved posted", () => {
    const { incidents } = parseFeed(FIXTURE);
    const d = diffState(null, incidents, NOW);
    expect(d.changes.map((c) => [c.kind, c.incident.slug])).toEqual([["new", "QH8L8B3E"]]);
    expect(d.silent).toBe(29);
    expect(Object.keys(d.next.incidents).length).toBe(30);
  });

  test("first run with nothing open posts nothing", () => {
    const d = diffState(null, [incident({ resolvedAt: "2026-10-01T00:00:00Z" })], NOW);
    expect(d.changes).toEqual([]);
    expect(d.silent).toBe(1);
  });

  test("an empty but present state is not a first run: a new incident posts", () => {
    const d = diffState(stateOf({}), [incident()], NOW);
    expect(d.changes.map((c) => c.kind)).toEqual(["new"]);
  });

  test("unchanged: nothing; a new update with the same status: nothing posted, updatedAt moves", () => {
    const i = incident();
    const s = diffState(null, [i], NOW).next;
    expect(diffState(s, [i], NOW).changes).toEqual([]);
    const later = incident({
      updates: [
        { status: "INVESTIGATING", message: "Looking into it", createdAt: "2026-10-21T07:00:00Z" },
        { status: "INVESTIGATING", message: "Still looking", createdAt: "2026-10-21T07:30:00Z" },
      ],
    });
    const d = diffState(s, [later], NOW);
    expect(d.changes).toEqual([]);
    expect(d.next.incidents["inc-1"]!.updatedAt).toBe("2026-10-21T07:30:00Z");
  });

  test("a status change posts once, with where it came from", () => {
    const s = stateOf({ "inc-1": { status: "INVESTIGATING", updatedAt: "2026-10-21T07:00:00+00:00" } });
    const identified = incident({ updates: [{ status: "IDENTIFIED", message: "Found it", createdAt: "2026-10-21T07:30:00Z" }] });
    const d = diffState(s, [identified], NOW);
    expect(d.changes.length).toBe(1);
    expect(d.changes[0]).toMatchObject({ kind: "status", from: "INVESTIGATING" });
    expect(d.changes[0]!.incident.status).toBe("IDENTIFIED");
    expect(diffState(d.next, [identified], NOW).changes).toEqual([]);
  });

  test("the resolved transition", () => {
    const s = stateOf({ "inc-1": { status: "MONITORING", updatedAt: "2026-10-21T07:30:00Z" } });
    const resolved = incident({ resolvedAt: "2026-10-21T08:00:00Z", updates: [{ status: "RESOLVED", message: "Fixed", createdAt: "2026-10-21T08:00:00Z" }] });
    const d = diffState(s, [resolved], NOW);
    expect(d.changes.length).toBe(1);
    expect(formatMessage(d.changes[0]!).split("\n")[0]).toBe("Railway incident RESOLVED (was monitoring)");
    expect(d.next.incidents["inc-1"]!.status).toBe("RESOLVED");
  });

  test("a new incident that is already resolved posts when recent, is silent when stale", () => {
    const s = stateOf({});
    const recent = incident({ resolvedAt: "2026-10-21T07:10:00Z" });
    expect(diffState(s, [recent], NOW).changes.map((c) => c.kind)).toEqual(["new"]);
    const stale = incident({ id: "inc-old", createdAt: "2026-10-01T07:00:00Z", resolvedAt: "2026-10-01T07:10:00Z", updates: [] });
    const d = diffState(s, [stale], NOW);
    expect(d.changes).toEqual([]);
    expect(d.silent).toBe(1);
    expect(d.next.incidents["inc-old"]).toBeDefined();
  });

  test("an incident missing from the feed is kept, so a short feed never replays old ones", () => {
    const { incidents } = parseFeed(FIXTURE);
    const full = diffState(null, incidents, NOW).next;
    const short = diffState(full, [], NOW);
    expect(Object.keys(short.next.incidents).length).toBe(30);
    expect(diffState(short.next, incidents, NOW).changes).toEqual([]);
  });

  test("entries older than ninety days are pruned", () => {
    const s = stateOf({
      old: { status: "RESOLVED", updatedAt: "2026-06-01T00:00:00Z" },
      kept: { status: "RESOLVED", updatedAt: "2026-10-01T00:00:00Z" },
    });
    expect(Object.keys(diffState(s, [], NOW).next.incidents)).toEqual(["kept"]);
  });
});

describe("state file", () => {
  test("round trip, sorted, versioned", () => {
    const s = stateOf({ b: { status: "RESOLVED", updatedAt: "2026-10-01T00:00:00Z" }, a: { status: "INVESTIGATING", updatedAt: "2026-10-02T00:00:00Z" } });
    const text = serializeState(s);
    expect(Object.keys(JSON.parse(text).incidents)).toEqual(["a", "b"]);
    expect(parseState(text)).toEqual(stateOf({ a: s.incidents.a!, b: s.incidents.b! }));
  });

  test("absent, unparseable or another version is a first run", () => {
    expect(parseState(null)).toBeNull();
    expect(parseState("{not json")).toBeNull();
    expect(parseState(JSON.stringify({ version: 2, incidents: {} }))).toBeNull();
    expect(parseState(JSON.stringify({ version: 1, incidents: [] }))).toBeNull();
  });
});

describe("message", () => {
  test("the live incident, as it would be posted now", () => {
    const q = parseFeed(FIXTURE).incidents.find((i) => i.slug === "QH8L8B3E")!;
    expect(formatMessage({ kind: "new", incident: q })).toBe(
      [
        "Railway incident NEW: investigating",
        "Builds are temporarily paused",
        "Components: Builds: US West (California, USA), EU West (Amsterdam, Netherlands), Southeast Asia (Singapore), US East (Virginia, USA) [partial outage]",
        "Latest update: We are currently investigating this issue",
        "Started 2026-10-21 07:24 UTC, updated 2026-10-21 07:24 UTC",
        "https://status.railway.com/incident/QH8L8B3E",
      ].join("\n"),
    );
  });

  test("a status change names both statuses", () => {
    const i = incident({ updates: [{ status: "IDENTIFIED", message: "Found it", createdAt: "2026-10-21T07:30:00Z" }] });
    expect(formatMessage({ kind: "status", incident: i, from: "INVESTIGATING" }).split("\n")[0]).toBe("Railway incident identified (was investigating)");
  });

  test("components grouped by name and impact; none listed", () => {
    expect(
      formatComponents([
        { name: "Builds", group: "US West", impact: "MAJOR_OUTAGE" },
        { name: "Builds", group: "EU West", impact: "MAJOR_OUTAGE" },
        { name: "Dashboard", group: null, impact: "DEGRADED_PERFORMANCE" },
      ]),
    ).toBe("Builds: US West, EU West [major outage]; Dashboard [degraded performance]");
    expect(formatComponents([])).toBe("none listed");
  });

  test("the title is one line", () => {
    const text = formatMessage({ kind: "new", incident: incident({ title: "Builds\npaused\r\n  in EU" }) });
    expect(text.split("\n")[1]).toBe("Builds paused in EU");
    expect(text.split("\n").length).toBe(6);
  });

  test("cuts never split a surrogate pair (title, update)", () => {
    const fire = "\u{1F525}";
    expect(cut(`${"x".repeat(296)}${fire}${"y".repeat(10)}`, 300)).toBe(`${"x".repeat(296)}${fire}...`);
    const lone = (t: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(t);
    for (let pad = 290; pad <= 300; pad++) {
      const t = formatMessage({ kind: "new", incident: incident({ title: `${"x".repeat(pad)}${fire.repeat(20)}` }) });
      expect(lone(t)).toBe(false);
      expect(lone(JSON.stringify(t))).toBe(false);
    }
    for (let pad = 490; pad <= 500; pad++) {
      const t = formatMessage({ kind: "new", incident: incident({ updates: [{ status: "INVESTIGATING", message: `${"x".repeat(pad)}${fire.repeat(20)}`, createdAt: "2026-10-21T07:00:00Z" }] }) });
      expect(lone(t)).toBe(false);
    }
  });

  test("a long update is cut to one line", () => {
    const long = "x ".repeat(2000);
    const text = formatMessage({ kind: "new", incident: incident({ updates: [{ status: "INVESTIGATING", message: `a\n\nb ${long}`, createdAt: "2026-10-21T07:00:00Z" }] }) });
    const line = text.split("\n").find((l) => l.startsWith("Latest update: "))!;
    expect(line.length).toBeLessThanOrEqual("Latest update: ".length + 500);
    expect(line).toEndWith("...");
    expect(text.length).toBeLessThanOrEqual(3800);
  });
});

describe("telegram config", () => {
  test("names missing or malformed variables, never values", () => {
    expect(telegramFromEnv({})).toEqual({ ok: false, invalid: ["ALERTS_TELEGRAM_BOT_TOKEN", "ALERTS_TELEGRAM_CHAT_ID"] });
    expect(telegramFromEnv({ ...ENV, ALERTS_TELEGRAM_THREAD_ID: "abc" })).toEqual({ ok: false, invalid: ["ALERTS_TELEGRAM_THREAD_ID"] });
    expect(telegramFromEnv({ ...ENV, ALERTS_TELEGRAM_THREAD_ID: "42" })).toEqual({ ok: true, config: { token: TOKEN, chatId: CHAT, threadId: 42 } });
  });
});

describe("run", () => {
  test("dry run: prints, sends nothing, writes nothing, needs no token", async () => {
    const h = harness();
    const f = fakeFetch(FIXTURE);
    const code = await runRailwayStatus(["--state", "state.json", "--dry-run"], {}, h.opts(f.fetch));
    expect(code).toBe(0);
    expect(f.posts()).toEqual([]);
    expect(h.writes()).toBe(0);
    expect(h.printed.join("\n")).toContain("Builds are temporarily paused");
    expect(h.outputs).toEqual(["changed=false", "sent=0"]);
  });

  test("first real run: posts the open incident once, seeds the rest; the second run posts nothing", async () => {
    const h = harness();
    const f = fakeFetch(FIXTURE);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(0);
    expect(f.posts().length).toBe(1);
    const post = f.posts()[0]!;
    expect(post.url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(post.body).toEqual({ chat_id: CHAT, text: post.body!.text, link_preview_options: { is_disabled: true } });
    expect(post.body!.parse_mode).toBeUndefined();
    expect(post.body!.message_thread_id).toBeUndefined();
    expect(String(post.body!.text)).toStartWith("Railway incident NEW: investigating\nBuilds are temporarily paused");
    expect(Object.keys(JSON.parse(h.files.get("state.json")!).incidents).length).toBe(30);
    expect(h.outputs).toEqual(["changed=true", "sent=1"]);

    const f2 = fakeFetch(FIXTURE);
    h.outputs.length = 0;
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f2.fetch))).toBe(0);
    expect(f2.posts()).toEqual([]);
    expect(h.writes()).toBe(1);
    expect(h.outputs).toEqual(["changed=false", "sent=0"]);
  });

  test("the topic, when set, is sent as message_thread_id", async () => {
    const h = harness();
    const f = fakeFetch(FIXTURE);
    await runRailwayStatus(["--state", "state.json"], { ...ENV, ALERTS_TELEGRAM_THREAD_ID: "7" }, h.opts(f.fetch));
    expect(f.posts()[0]!.body!.message_thread_id).toBe(7);
  });

  test("the live incident moving to identified posts one message", async () => {
    const h = harness();
    await runRailwayStatus(["--state", "state.json"], ENV, h.opts(fakeFetch(FIXTURE).fetch));
    const moved = clone(FIXTURE);
    for (const list of [moved.activeIncidents, moved.recentIncidents]) {
      const q = list.find((i: { slug: string }) => i.slug === "QH8L8B3E");
      q.updates.unshift({ id: "u2", status: "IDENTIFIED", message: "We have identified the issue", createdAt: "2026-10-21T08:10:00+00:00" });
    }
    const f = fakeFetch(moved);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(0);
    expect(f.posts().length).toBe(1);
    expect(String(f.posts()[0]!.body!.text).split("\n")[0]).toBe("Railway incident identified (was investigating)");
  });

  for (const [name, feed] of [
    ["unreachable", new Error("ECONNREFUSED")],
    ["a 502", 502],
    ["not the expected shape", { entries: [] }],
    ["one incident with a renamed field", { ...FIXTURE, recentIncidents: FIXTURE.recentIncidents.map((i: Record<string, unknown>, n: number) => (n === 3 ? (({ title, ...rest }) => ({ ...rest, name: title }))(i) : i)) }],
    ["every incident with a renamed field", { ...FIXTURE, activeIncidents: [], recentIncidents: FIXTURE.recentIncidents.map(({ status, ...rest }: Record<string, unknown>) => ({ ...rest, state: status })) }],
  ] as const) {
    test(`a feed that is ${name}: exit 1, nothing sent, state untouched`, async () => {
      const before = serializeState(stateOf({ "inc-1": { status: "INVESTIGATING", updatedAt: "2026-10-21T07:00:00Z" } }));
      const h = harness(before);
      const f = fakeFetch(feed);
      expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(1);
      expect(f.posts()).toEqual([]);
      expect(h.writes()).toBe(0);
      expect(h.files.get("state.json")).toBe(before);
      expect(h.outputs).toEqual(["changed=false", "sent=0"]);
      expect(h.logs.join("\n")).toContain("railway_status.feed_failed code=feed_");
    });
  }

  test("a Telegram failure: the sent are recorded, the rest retried next run, exit 1, no token in logs", async () => {
    const h = harness(serializeState(stateOf({})));
    const feed = feedOf(
      rawIncident({ id: "a", slug: "AAAA1111", createdAt: "2026-10-21T07:00:00Z" }),
      rawIncident({ id: "b", slug: "BBBB2222", createdAt: "2026-10-21T07:05:00Z" }),
      rawIncident({ id: "c", slug: "CCCC3333", createdAt: "2026-10-21T07:10:00Z" }),
    );
    const f = fakeFetch(feed, (n) => (n === 1 ? 500 : 200));
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(1);
    expect(f.posts().length).toBe(2);
    expect(Object.keys(JSON.parse(h.files.get("state.json")!).incidents)).toEqual(["a"]);
    expect(h.outputs).toEqual(["changed=true", "sent=1"]);
    expect(h.logs.join("\n")).toContain("code=telegram_http_500");
    expect(h.logs.join("\n")).not.toContain(TOKEN);
    expect(h.logs.join("\n")).not.toContain(CHAT);

    const f2 = fakeFetch(feed);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f2.fetch))).toBe(0);
    expect(f2.posts().map((p) => String(p.body!.text).split("\n").at(-1))).toEqual([
      "https://status.railway.com/incident/BBBB2222",
      "https://status.railway.com/incident/CCCC3333",
    ]);
  });

  test("a failed status change keeps the old status, so it is sent next run", async () => {
    const h = harness(serializeState(stateOf({ a: { status: "INVESTIGATING", updatedAt: "2026-10-21T07:00:00Z" } })));
    const feed = feedOf(rawIncident({ id: "a", resolvedAt: "2026-10-21T08:00:00Z" }));
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(fakeFetch(feed, () => 403).fetch))).toBe(1);
    expect(JSON.parse(h.files.get("state.json")!).incidents.a.status).toBe("INVESTIGATING");
    const f = fakeFetch(feed);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(0);
    expect(String(f.posts()[0]!.body!.text).split("\n")[0]).toBe("Railway incident RESOLVED (was investigating)");
  });

  test("a message Telegram refuses for good (400) is logged, recorded and skipped; later alerts still go; next run sends nothing again", async () => {
    const h = harness(serializeState(stateOf({})));
    const fire = "\u{1F525}";
    const feed = feedOf(
      rawIncident({ id: "a", slug: "AAAA1111", title: `poison ${fire}`, createdAt: "2026-10-21T07:00:00Z" }),
      rawIncident({ id: "b", slug: "BBBB2222", createdAt: "2026-10-21T07:05:00Z" }),
    );
    const poison = (_n: number, text: string): number | [number, string | null] => (text.includes(fire) ? [400, "Bad Request: strings must be encoded in UTF-8"] : 200);
    const f = fakeFetch(feed, poison);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(1);
    expect(f.posts().length).toBe(2);
    expect(Object.keys(JSON.parse(h.files.get("state.json")!).incidents)).toEqual(["a", "b"]);
    expect(h.logs.join("\n")).toContain("railway_status.send_refused code=telegram_http_400_content incident=AAAA1111");
    expect(h.logs.join("\n")).not.toContain("UTF-8");
    expect(h.outputs).toEqual(["changed=true", "sent=1"]);

    // Probe J's shape: three runs, the poisoned one never blocks.
    const f2 = fakeFetch(feed, poison);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f2.fetch))).toBe(0);
    expect(f2.posts()).toEqual([]);
    const later = feedOf(
      rawIncident({ id: "a", slug: "AAAA1111", title: `poison ${fire}`, createdAt: "2026-10-21T07:00:00Z", resolvedAt: "2026-10-21T08:00:00Z" }),
      rawIncident({ id: "b", slug: "BBBB2222", createdAt: "2026-10-21T07:05:00Z" }),
      rawIncident({ id: "c", slug: "CCCC3333", createdAt: "2026-10-21T07:50:00Z" }),
    );
    const f3 = fakeFetch(later, poison);
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f3.fetch))).toBe(1);
    expect(f3.posts().map((p) => String(p.body!.text).split("\n").at(-1))).toEqual([
      "https://status.railway.com/incident/AAAA1111",
      "https://status.railway.com/incident/CCCC3333",
    ]);
    expect(JSON.parse(h.files.get("state.json")!).incidents.c.status).toBe("INVESTIGATING");
  });

  // Probe L's shape: only these content errors are skipped...
  const skipped = [
    "Bad Request: message is too long",
    "Bad Request: strings must be encoded in UTF-8",
    "Bad Request: message text is empty",
    "Bad Request: text must be non-empty",
    "Bad Request: can't parse entities: Can't find end of the entity starting at byte offset 12",
  ];
  for (const description of skipped) {
    test(`Telegram 400 "${description.slice(13, 45)}": that message skipped and recorded, the next one sent`, async () => {
      const h = harness(serializeState(stateOf({})));
      const feed = feedOf(rawIncident({ id: "a", slug: "AAAA1111" }), rawIncident({ id: "b", slug: "BBBB2222", createdAt: "2026-10-21T07:05:00Z" }));
      const f = fakeFetch(feed, (n) => (n === 0 ? [400, description] : 200));
      expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(1);
      expect(f.posts().length).toBe(2);
      expect(Object.keys(JSON.parse(h.files.get("state.json")!).incidents)).toEqual(["a", "b"]);
      expect(h.logs.join("\n")).toContain("railway_status.send_refused code=telegram_http_400_content incident=AAAA1111");
      expect(h.logs.join("\n")).not.toContain(description);
    });
  }

  // ...and everything else stays on retry.
  const retried: [string, number | [number, string | null]][] = [
    ["401", 401],
    ["403", 403],
    ["404", 404],
    ["409", [409, "Conflict: terminated by other getUpdates request"]],
    ["429", [429, "Too Many Requests: retry after 30"]],
    ["502", 502],
    ["a bodyless 400", [400, null]],
    ["a 400 with an unknown description", [400, "Bad Request: something Telegram adds next year"]],
    ["a 400 for a migrated supergroup", [400, "Bad Request: group chat was upgraded to a supergroup chat"]],
    ["a 400 for missing admin rights", [400, "Bad Request: need administrator rights in the channel chat"]],
    ["a 400 CHAT_RESTRICTED", [400, "Bad Request: CHAT_RESTRICTED"]],
    ["a 400 about the chat", [400, "Bad Request: chat not found"]],
    ["a 400 about the topic", [400, "Bad Request: message thread not found"]],
  ];
  for (const [name, reply] of retried) {
    test(`Telegram ${name}: stop and retry next run, nothing skipped`, async () => {
      const h = harness(serializeState(stateOf({})));
      const feed = feedOf(rawIncident({ id: "a", slug: "AAAA1111" }), rawIncident({ id: "b", slug: "BBBB2222", createdAt: "2026-10-21T07:05:00Z" }));
      const f = fakeFetch(feed, () => reply);
      expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch))).toBe(1);
      expect(f.posts().length).toBe(1);
      expect(h.logs.join("\n")).toContain("railway_status.send_failed");
      expect(h.logs.join("\n")).not.toContain("send_refused");
      expect(JSON.parse(h.files.get("state.json") ?? '{"incidents":{}}').incidents).toEqual({});
      const f2 = fakeFetch(feed);
      expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f2.fetch))).toBe(0);
      expect(f2.posts().length).toBe(2);
    });
  }

  test("failure logs carry codes only: no token, chat id, thread id or Telegram response body", async () => {
    const h = harness(serializeState(stateOf({})));
    const env = { ...ENV, ALERTS_TELEGRAM_THREAD_ID: "424242" };
    const f = fakeFetch(feedOf(rawIncident()), () => [400, "Bad Request: need administrator rights in the channel chat"]);
    expect(await runRailwayStatus(["--state", "state.json"], env, h.opts(f.fetch))).toBe(1);
    const logs = h.logs.join("\n");
    expect(logs).toContain("railway_status.send_failed code=telegram_http_400 incident=ABCD1234");
    for (const secret of [TOKEN, CHAT, "424242", "administrator", "migrate_to_chat_id", "-100999", "Deploys failing", "Looking into it"]) {
      expect(logs).not.toContain(secret);
    }
  });

  test("an unreachable Telegram: the thrown error and the logs carry a code, never the token or chat id", async () => {
    const leaky: Fetch = async (url) => {
      throw new Error(`connect ECONNREFUSED ${url}`);
    };
    let thrown: unknown = null;
    try {
      await sendTelegram(leaky, { token: TOKEN, chatId: CHAT }, "hi");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SendError);
    expect((thrown as SendError).message).toBe("telegram_unreachable");
    expect((thrown as SendError).permanent).toBe(false);
    expect(String((thrown as Error).stack ?? "")).not.toContain(TOKEN);
    expect(JSON.stringify(thrown)).not.toContain(TOKEN);

    const h = harness(serializeState(stateOf({})));
    const feed = feedOf(rawIncident());
    const f: Fetch = async (url, init) => (url === FEED_URL ? new Response(JSON.stringify(feed), { status: 200 }) : leaky(url, init));
    expect(await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f))).toBe(1);
    expect(h.logs.join("\n")).toContain("code=telegram_unreachable");
    expect(h.logs.join("\n")).not.toContain(TOKEN);
    expect(h.logs.join("\n")).not.toContain(CHAT);
  });

  test("missing Telegram variables: exit 2 by name, the feed is not fetched", async () => {
    const h = harness();
    const f = fakeFetch(FIXTURE);
    expect(await runRailwayStatus(["--state", "state.json"], { ALERTS_TELEGRAM_CHAT_ID: CHAT }, h.opts(f.fetch))).toBe(2);
    expect(f.calls).toEqual([]);
    expect(h.logs).toEqual(["railway_status.config_invalid variables=ALERTS_TELEGRAM_BOT_TOKEN"]);
  });

  test("bad arguments exit 1", async () => {
    const h = harness();
    const f = fakeFetch(FIXTURE);
    expect(await runRailwayStatus(["--dry-run"], {}, h.opts(f.fetch))).toBe(1);
    expect(await runRailwayStatus(["--state", "state.json", "--bogus"], {}, h.opts(f.fetch))).toBe(1);
    expect(f.calls).toEqual([]);
  });
});

describe("public logs: feed values cannot become workflow commands", () => {
  const probes = ["::warning title=x::injected", "\n::ERROR::INJECTED2", "ok\r\n::add-mask::x", "a b", "x".repeat(65)];

  test("logRef and logStatus pass plain values and refuse everything else", () => {
    expect(logRef({ slug: "QH8L8B3E", id: "9bc9a3c0-fe6b-4b95-bd09-9dc1179da308" })).toBe("QH8L8B3E");
    expect(logRef({ slug: null, id: "9bc9a3c0-fe6b-4b95-bd09-9dc1179da308" })).toBe("9bc9a3c0-fe6b-4b95-bd09-9dc1179da308");
    expect(logStatus("INVESTIGATING")).toBe("INVESTIGATING");
    expect(logStatus("PARTIAL_OUTAGE")).toBe("PARTIAL_OUTAGE");
    for (const p of probes) {
      expect(logRef({ slug: null, id: p })).toBe("invalid");
      expect(logStatus(p)).toBe("invalid");
    }
  });

  /** No line of `out` starts (after leading whitespace) with `::`, and the probe text is absent. */
  function clean(out: string[]) {
    const lines = out.join("\n").split(/\r\n|\r|\n/);
    for (const l of lines) expect(l.trimStart().startsWith("::")).toBe(false);
    const all = out.join("\n");
    expect(all).not.toContain("INJECTED2");
    expect(all).not.toContain("injected");
  }

  for (const probe of ["::warning title=x::injected", "\n::ERROR::INJECTED2"]) {
    const feed = () =>
      feedOf(
        rawIncident({ id: probe, slug: probe, status: probe, updates: [{ status: probe, message: probe, createdAt: "2026-10-21T07:00:00Z" }], title: probe }),
      );

    test(`sent, refused and failed log lines with ${JSON.stringify(probe)} in id, slug, status and title`, async () => {
      for (const reply of [200, [400, "Bad Request: message is too long"], 502] as const) {
        const h = harness(serializeState(stateOf({})));
        const f = fakeFetch(feed(), () => (Array.isArray(reply) ? ([reply[0], reply[1]] as [number, string]) : (reply as number)));
        await runRailwayStatus(["--state", "state.json"], ENV, h.opts(f.fetch));
        expect(h.logs.some((l) => l.includes("incident=invalid"))).toBe(true);
        clean(h.logs);
      }
    });

    test(`a dry run with ${JSON.stringify(probe)} prints every message line behind "| "`, async () => {
      const h = harness();
      await runRailwayStatus(["--state", "state.json", "--dry-run"], {}, h.opts(fakeFetch(feed()).fetch));
      expect(h.printed[0]).toBe("--- would send (new, invalid) ---");
      for (const l of h.printed.slice(1)) expect(l.startsWith("| ")).toBe(true);
      for (const l of h.printed.join("\n").split(/\r\n|\r|\n/)) expect(l.trimStart().startsWith("::")).toBe(false);
      clean(h.logs);
    });
  }
});

describe("the workflow's public-repo invariants", () => {
  type Step = { name?: string; id?: string; uses?: string; run?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
  type Job = { if?: string; permissions?: unknown; steps: Step[] };
  const text = readFileSync(join(import.meta.dir, "..", "workflows", "railway-status-notify.yml"), "utf8");
  const wf = Bun.YAML.parse(text) as { on: Record<string, unknown>; permissions: unknown; jobs: Record<string, Job> };
  const jobs = Object.values(wf.jobs);
  const steps = jobs.flatMap((j) => j.steps);
  const notify = steps.filter((s) => s.id === "notify");

  test("triggers are exactly schedule (every 5 minutes) and workflow_dispatch", () => {
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    expect(wf.on.schedule).toEqual([{ cron: "*/5 * * * *" }]);
  });

  test("permissions are contents: read and nothing else, at every level", () => {
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const j of jobs) expect(j.permissions === undefined || JSON.stringify(j.permissions) === JSON.stringify({ contents: "read" })).toBe(true);
  });

  test("no run: line holds an expression", () => {
    const runs = steps.filter((s) => typeof s.run === "string");
    expect(runs.length).toBeGreaterThan(0);
    for (const s of runs) expect(s.run!).not.toContain("${{");
  });

  test("secrets appear only in the notify step's env, by their own names", () => {
    expect(notify.length).toBe(1);
    const env = notify[0]!.env!;
    const withSecrets = Object.entries(env).filter(([, v]) => String(v).includes("secrets."));
    expect(withSecrets.map(([k]) => k).sort()).toEqual(["ALERTS_TELEGRAM_BOT_TOKEN", "ALERTS_TELEGRAM_CHAT_ID", "ALERTS_TELEGRAM_THREAD_ID"]);
    for (const [k, v] of withSecrets) expect(v).toBe(`\${{ secrets.${k} }}`);
    const { env: _env, ...rest } = notify[0]!;
    const elsewhere = JSON.stringify({ ...wf, jobs: Object.fromEntries(Object.entries(wf.jobs).map(([n, j]) => [n, { ...j, steps: j.steps.map((s) => (s === notify[0] ? rest : s)) }])) });
    expect(elsewhere).not.toContain("secrets.");
    // In the raw text too (anchors, aliases): exactly the three expressions above.
    expect(text.match(/secrets\s*\.\s*[A-Za-z_]|secrets\s*\[/g)!.length).toBe(3);
  });

  test("only main sends and saves; forks never run it; every action pinned to a full SHA", () => {
    expect(notify[0]!.env!.DRY_RUN).toContain("github.ref != 'refs/heads/main'");
    const save = steps.filter((s) => s.uses?.startsWith("actions/cache/save@"));
    expect(save.length).toBe(1);
    expect(save[0]!.if).toContain("github.ref == 'refs/heads/main'");
    for (const j of jobs) expect(j.if).toBe("github.repository == 'Edge-City/agentvillage'");
    for (const s of steps.filter((x) => x.uses)) expect(s.uses!).toMatch(/@[0-9a-f]{40}$/);
  });
});
