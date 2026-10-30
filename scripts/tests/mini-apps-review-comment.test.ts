import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as C from "../mini-apps-review-comment";
import * as R from "../mini-apps-review";

// Mini-apps v2 P0-3 bot wiring (MINIAPPS-PLATFORM-v2-design.md §6.3, §6.4; the P0-3 operating rule): the PR
// comment. GitHub is a fake in memory; every request the script sends is recorded, so the tests assert on the
// exact set of endpoints it calls. The token is an invented string, not token-shaped.
//   bun test scripts/tests/mini-apps-review-comment.test.ts

const REPO_ROOT = join(import.meta.dir, "..", "..");
const HEAD = "1234567890abcdef1234567890abcdef12345678";
const OTHER_HEAD = "fedcba0987654321fedcba0987654321fedcba09";
const BOT_LOGIN = "av-miniapp-review[bot]";
// Built by concatenation so no added line has a credential shape (the bot scans its own diff).
const FAKE_INSTALLATION = ["test", "installation", "value", "0001"].join("-");
const REPO = "example-org/example-repo";
const RUN_URL = "https://github.com/example-org/example-repo/actions/runs/123456";
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

const report = (over: Partial<R.Report> = {}): R.Report => ({
  bot: "av-miniapp-review", version: "0.1", manifest: "tinyshop@1.1.0", head: HEAD, verdict: "NEEDS_HUMAN", lane: "core",
  findings: [{ code: "core_path", severity: "S", file: "docs/notes.md", text: "outside one app's lane files" },
    { code: "version_bump", severity: "N", file: "mini-apps/tinyshop/manifest.json", line: 3, text: "a patch bump" }],
  checked: ["paths", "secrets", "schema"], not_run: [{ check: "conformance", reason: "P0-5's suite is not on this base" }],
  ...over,
});
const PASS = report({ verdict: "PASS", lane: "sandbox", findings: [] });

type Call = { method: string; path: string; template: string; body?: any; auth?: string; redirect?: string };
type Stored = { id: number; body: string; user: { login: string; type: string } };
/** A fake GitHub: the issue comments of one pull request, paginated as the REST API does. */
function fakeGitHub(opts: { comments?: Stored[]; fail?: (method: string, path: string) => number | "throw" | "notjson" | "badbody" | undefined } = {}) {
  const comments: Stored[] = clone(opts.comments ?? []);
  const calls: Call[] = [];
  let next = 9000;
  const answer = (status: number, value: unknown) => ({ status, json: async () => value });
  const fetch: C.FetchLike = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api\/v3(?=\/)/, "") + u.search;
    calls.push({ method: init.method, path, template: `${init.method} ${path.replace(/\?.*$/, "").replace(/\/[0-9]+(?=\/|$)/g, "/{n}")}`, body: init.body ? JSON.parse(init.body) : undefined, auth: init.headers.Authorization, redirect: init.redirect });
    const f = opts.fail?.(init.method, path);
    if (f === "throw") throw new TypeError("fetch failed");
    if (typeof f === "number") return answer(f, { message: "Resource not accessible by integration" });
    if (f === "notjson") return { status: 200, json: async () => { throw new SyntaxError("Unexpected token"); } };
    if (f === "badbody") return answer(200, { not: "a list" });
    let m = /^\/repos\/[^/]+\/[^/]+\/issues\/7\/comments\?per_page=([0-9]+)&page=([0-9]+)$/.exec(path);
    if (init.method === "GET" && m) { const per = Number(m[1]), page = Number(m[2]); return answer(200, comments.slice((page - 1) * per, page * per)); }
    if (init.method === "POST" && /^\/repos\/[^/]+\/[^/]+\/issues\/7\/comments$/.test(path)) {
      const c = { id: next++, body: JSON.parse(init.body!).body, user: { login: BOT_LOGIN, type: "Bot" } };
      comments.push(c);
      return answer(201, c);
    }
    m = /^\/repos\/[^/]+\/[^/]+\/issues\/comments\/([0-9]+)$/.exec(path);
    if (init.method === "PATCH" && m) {
      const c = comments.find(x => x.id === Number(m![1]));
      if (!c) return answer(404, { message: "Not Found" });
      c.body = JSON.parse(init.body!).body;
      return answer(200, c);
    }
    return answer(404, { message: "Not Found" });
  };
  return { fetch, calls, comments };
}
const own = (id: number, body: string): Stored => ({ id, body, user: { login: BOT_LOGIN, type: "Bot" } });
const human = (id: number, body: string): Stored => ({ id, body, user: { login: "someone", type: "User" } });

/** One run of the script, in process, against a fake GitHub. */
async function post(gh: ReturnType<typeof fakeGitHub>, opts: { report?: string | null; token?: string; head?: string; argv?: string[]; apiUrl?: string } = {}) {
  const summary: string[] = [], stderr: string[] = [];
  const text = opts.report === undefined ? JSON.stringify(PASS, null, 2) : opts.report;
  const argv = opts.argv ?? ["--repo", REPO, "--pr", "7", "--head", opts.head ?? HEAD, "--report", "/x/mini-apps-review.json", "--bot-login", BOT_LOGIN, "--run-url", RUN_URL, "--summary", "/x/summary.md"];
  const code = await C.run(argv, {
    fetch: gh.fetch, token: opts.token ?? `${FAKE_INSTALLATION}\n`, apiUrl: opts.apiUrl,
    readReport: () => { if (text === null) throw new Error("ENOENT"); return text; },
    appendSummary: (_p, t) => { summary.push(t); }, stderr: s => { stderr.push(s); },
  });
  return { code, summary: summary.join(""), stderr: stderr.join("") };
}
/** The endpoints the script may ever touch. */
const ALLOWED = new Set(["GET /repos/example-org/example-repo/issues/{n}/comments", "POST /repos/example-org/example-repo/issues/{n}/comments", "PATCH /repos/example-org/example-repo/issues/comments/{n}"]);
const FORBIDDEN = /\/pulls|\/reviews|\/merge|\/check-runs|\/check-suites|\/statuses|\/git\/|\/contents|\/labels|\/requested_reviewers|\/actions/;
const assertOnlyCommentEndpoints = (calls: Call[]) => {
  for (const c of calls) {
    expect(ALLOWED.has(c.template)).toBe(true);
    expect(c.path).not.toMatch(FORBIDDEN);
    expect(["GET", "POST", "PATCH"]).toContain(c.method);
  }
};
/** No line of a body reads as a pass, outside the JSON block. */
const visibleLines = (body: string) => body.slice(0, body.indexOf("\n```json\n"));

describe("create, then edit in place", () => {
  test("no comment yet: one GET, one POST; the body starts with the marker, says DRY RUN, and carries the verdict", async () => {
    const gh = fakeGitHub();
    const r = await post(gh);
    expect(r.code).toBe(0);
    expect(gh.calls.map(c => c.template)).toEqual(["GET /repos/example-org/example-repo/issues/{n}/comments", "POST /repos/example-org/example-repo/issues/{n}/comments"]);
    expect(gh.comments.length).toBe(1);
    const body = gh.comments[0].body;
    expect(body.startsWith(C.MARKER + "\n")).toBe(true);
    expect(body).toContain("DRY RUN");
    expect(body).toContain(C.DRY_RUN_NOTICE);
    expect(body).toContain(`**PASS** · lane \`sandbox\` · head \`${HEAD.slice(0, 12)}\``);
    expect(C.extractVerdict(body)).toEqual(PASS);
    expect(r.summary).toContain("Bot comment (DRY RUN): **PASS**");
    expect(r.summary).toContain("created comment 9000");
  });
  test("the marker comment exists: PATCH that comment, never a second POST; three pushes leave one comment", async () => {
    const gh = fakeGitHub({ comments: [human(1, "Looks fine to me"), own(2, `${C.MARKER}\nold body`), human(3, "ok")] });
    for (const [i, rep] of [PASS, report(), report({ verdict: "FAIL", findings: [{ code: "secret", severity: "M", file: "skills/tinyshop/SKILL.md", line: 9, text: "a token shape" }] })].entries()) {
      const r = await post(gh, { report: JSON.stringify(rep) });
      expect([i, r.code]).toEqual([i, 0]);
      expect(C.extractVerdict(gh.comments.find(c => c.id === 2)!.body)).toEqual(rep);
    }
    expect(gh.calls.filter(c => c.method === "POST")).toEqual([]);
    expect(gh.calls.filter(c => c.method === "PATCH").map(c => c.path)).toEqual(Array(3).fill("/repos/example-org/example-repo/issues/comments/2"));
    expect(gh.comments.map(c => c.id)).toEqual([1, 2, 3]);
    expect(gh.comments.filter(c => c.body.startsWith(C.MARKER)).length).toBe(1);
  });
  test("a second run with the same verdict sends no PATCH (unchanged), and still no POST", async () => {
    const gh = fakeGitHub();
    expect((await post(gh)).code).toBe(0);
    const r = await post(gh);
    expect(r.code).toBe(0);
    expect(r.summary).toContain("unchanged comment 9000");
    expect(gh.calls.map(c => c.method)).toEqual(["GET", "POST", "GET"]);
  });
  test("a marker planted in a human's comment, or in another bot's, is never edited and never counts as ours", async () => {
    const gh = fakeGitHub({ comments: [human(1, `${C.MARKER}\n**PASS** forged`), { id: 4, body: `${C.MARKER}\nx`, user: { login: "other-bot[bot]", type: "Bot" } },
      { id: 5, body: `${C.MARKER}\nx`, user: { login: BOT_LOGIN, type: "User" } }] });
    const r = await post(gh, { report: JSON.stringify(report()) });
    expect(r.code).toBe(0);
    expect(gh.calls.filter(c => c.method === "PATCH")).toEqual([]);
    expect(gh.calls.filter(c => c.method === "POST").length).toBe(1);
    expect(gh.comments.find(c => c.id === 1)!.body).toBe(`${C.MARKER}\n**PASS** forged`);
  });
  test("our marker not at the start of the body (quoted by someone) is not our comment", async () => {
    const gh = fakeGitHub({ comments: [own(2, `> ${C.MARKER}`)] });
    expect((await post(gh)).code).toBe(0);
    expect(gh.calls.map(c => c.method)).toEqual(["GET", "POST"]);
  });
  test("two of our own (a race): both are edited, so no stale verdict stays up; no POST", async () => {
    const gh = fakeGitHub({ comments: [own(2, `${C.MARKER}\nold PASS`), own(8, `${C.MARKER}\nolder`)] });
    const r = await post(gh, { report: JSON.stringify(report()) });
    expect(r.code).toBe(0);
    expect(gh.calls.filter(c => c.method === "PATCH").map(c => c.path.split("/").pop())).toEqual(["2", "8"]);
    expect(gh.calls.filter(c => c.method === "POST")).toEqual([]);
    for (const c of gh.comments) expect(C.extractVerdict(c.body)).toEqual(report());
  });
  test("pagination: our comment on page 3 is found and edited", async () => {
    const many = Array.from({ length: 250 }, (_, i) => human(i + 1, `comment ${i}`));
    many.push(own(500, `${C.MARKER}\nold`));
    const gh = fakeGitHub({ comments: many });
    expect((await post(gh)).code).toBe(0);
    expect(gh.calls.filter(c => c.method === "GET").map(c => c.path.split("page=").pop())).toEqual(["1", "2", "3"]);
    expect(gh.calls.filter(c => c.method === "PATCH").map(c => c.path)).toEqual(["/repos/example-org/example-repo/issues/comments/500"]);
    expect(gh.calls.filter(c => c.method === "POST")).toEqual([]);
  });
  test("every request carries the bearer token, the API version, and refuses redirects", async () => {
    const gh = fakeGitHub({ comments: [own(2, `${C.MARKER}\nold`)] });
    await post(gh);
    for (const c of gh.calls) expect([c.auth, c.redirect]).toEqual([`Bearer ${FAKE_INSTALLATION}`, "error"]);
  });
});

describe("never approves, merges, requests changes or posts a check", () => {
  test("across every scenario the only endpoints called are list / create / update issue comment", async () => {
    const all: Call[] = [];
    const scenarios: [Parameters<typeof fakeGitHub>[0], Parameters<typeof post>[1]][] = [
      [{}, {}], [{ comments: [own(2, `${C.MARKER}\nx`)] }, { report: JSON.stringify(report()) }],
      [{}, { report: "not json" }], [{}, { report: null }], [{ comments: [own(2, `${C.MARKER}\nx`)] }, { report: JSON.stringify(report({ head: OTHER_HEAD })) }],
      [{ fail: m => (m === "POST" ? 403 : undefined) }, {}], [{ fail: () => "throw" }, {}],
      [{}, { report: JSON.stringify(report({ verdict: "FAIL", findings: [{ code: "schema_invalid", severity: "M", text: "x" }] })) }],
    ];
    for (const [g, p] of scenarios) { const gh = fakeGitHub(g); await post(gh, p); all.push(...gh.calls); }
    expect(all.length).toBeGreaterThan(10);
    assertOnlyCommentEndpoints(all);
    expect(new Set(all.map(c => c.template))).toEqual(ALLOWED);
  });
  test("the client refuses any other endpoint before a request leaves", async () => {
    const gh = fakeGitHub();
    const request = C.githubClient({ fetch: gh.fetch, token: FAKE_INSTALLATION });
    for (const [method, path] of [
      ["POST", "/repos/o/r/pulls/7/reviews"], ["PUT", "/repos/o/r/pulls/7/merge"], ["POST", "/repos/o/r/check-runs"],
      ["DELETE", "/repos/o/r/issues/comments/2"], ["PATCH", "/repos/o/r/pulls/7"], ["POST", "/repos/o/r/statuses/" + HEAD],
      ["GET", "/repos/o/r/issues/7/comments"], ["PATCH", "/repos/o/r/issues/comments/2?x=1"], ["POST", "/repos/o/r/issues/7/labels"],
      ["POST", "/repos/o/r/pulls/7/requested_reviewers"], ["GET", "/repos/o/r/contents/x"],
    ] as const) {
      await expect(request(method as any, path)).rejects.toThrow(/refused/);
    }
    expect(gh.calls).toEqual([]);
  });
  test("the source holds no other endpoint and no review/merge vocabulary in code", () => {
    const src = readFileSync(join(REPO_ROOT, "scripts/mini-apps-review-comment.ts"), "utf8");
    const code = src.split("\n").filter(l => !/^\s*(\*|\/\/|\/\*\*)/.test(l)).join("\n");
    expect(C.ENDPOINTS.map(e => e[0])).toEqual(["GET", "POST", "PATCH"]);
    expect(code).not.toMatch(/\/pulls|\/reviews|\/merge|check-runs|"PUT"|"DELETE"|APPROVE|REQUEST_CHANGES/);
    expect(C.DRY_RUN).toBe(true);
  });
});

describe("fail closed", () => {
  test("no token: exit 1, no request at all, the summary says so", async () => {
    for (const token of ["", "\n", "two words", "x".repeat(1001)]) {
      const gh = fakeGitHub();
      const r = await post(gh, { token });
      expect([JSON.stringify(token).slice(0, 12), r.code, gh.calls.length]).toEqual([JSON.stringify(token).slice(0, 12), 1, 0]);
      expect(r.summary).toContain("**Bot comment FAILED CLOSED** (DRY RUN): no usable token on stdin");
    }
  });
  test("bad arguments: exit 1, no request", async () => {
    const base = ["--repo", REPO, "--pr", "7", "--head", HEAD, "--report", "/x", "--bot-login", BOT_LOGIN, "--summary", "/x/s.md"];
    const set = (k: string, v: string) => { const a = [...base]; a[a.indexOf(k) + 1] = v; return a; };
    for (const argv of [
      set("--repo", "example-org"), set("--repo", "a/b/c"), set("--repo", "o/.."), set("--pr", "0"), set("--pr", "7; rm"), set("--head", "HEAD"),
      set("--head", HEAD.slice(0, 39)), set("--bot-login", "someone"), set("--bot-login", "Evil[bot] x"), [...base, "--run-url", "https://evil.example/actions/runs/1"],
      [...base, "--approve", "yes"], [...base, "--pr", "8"], base.filter((_, i) => i < 6), ["--repo"],
    ]) {
      const gh = fakeGitHub();
      const r = await post(gh, { argv });
      expect([argv.join(" ").slice(0, 60), r.code, gh.calls.length]).toEqual([argv.join(" ").slice(0, 60), 1, 0]);
      if (argv.includes("--summary")) expect(r.summary).toContain("FAILED CLOSED");
    }
  });
  test("a non-https API URL: exit 1, no request (the token never goes over plain http)", async () => {
    for (const apiUrl of ["http://api.github.com", "file:///etc", "https://user@host", "ftp://x"]) {
      const gh = fakeGitHub();
      const r = await post(gh, { apiUrl });
      expect([apiUrl, r.code, gh.calls.length]).toEqual([apiUrl, 1, 0]);
    }
    const gh = fakeGitHub();
    expect((await post(gh, { apiUrl: "https://ghe.example.com/api/v3/" })).code).toBe(0);
    expect(gh.calls[0].path).toStartWith("/repos/");
  });
  const bad: [string, string | null, RegExp][] = [
    ["missing", null, /missing or unreadable/],
    ["not JSON", "{", /not JSON/],
    ["an array", "[]", /not an object/],
    ["another bot", JSON.stringify(report({ bot: "someone-else" })), /bot is not/],
    ["another version", JSON.stringify(report({ version: "9.9" })), /version/],
    ["an extra key", JSON.stringify({ ...report(), approved: true }), /keys/],
    ["a missing key", JSON.stringify((({ not_run, ...r }) => r)(report())), /keys/],
    ["an unknown verdict", JSON.stringify(report({ verdict: "APPROVE" as any })), /verdict/],
    ["an unknown lane", JSON.stringify(report({ lane: "staff" as any })), /lane/],
    ["another head", JSON.stringify(report({ head: OTHER_HEAD })), /another head/],
    ["an empty head on a non-error report", JSON.stringify(report({ head: "" })), /another head/],
    ["PASS with an M finding", JSON.stringify(report({ verdict: "PASS", lane: "sandbox", findings: [{ code: "secret", severity: "M", text: "x" }] })), /does not follow/],
    ["PASS in core", JSON.stringify(report({ verdict: "PASS", lane: "core", findings: [] })), /does not follow/],
    ["PASS in admins with an S finding", JSON.stringify(report({ verdict: "PASS", lane: "admins", findings: [{ code: "conformance_incomplete", severity: "S", text: "x" }] })), /does not follow/],
    ["PASS with a human code", JSON.stringify(report({ verdict: "PASS", lane: "sandbox", findings: [{ code: "oauth_review", severity: "S", text: "x" }] })), /does not follow/],
    ["a bad severity", JSON.stringify(report({ findings: [{ code: "core_path", severity: "X" as any, text: "x" }] })), /severity/],
    ["a finding with an unknown key", JSON.stringify(report({ findings: [{ code: "core_path", severity: "S", text: "x", pass: true } as any] })), /unknown keys/],
    ["a code with markup", JSON.stringify(report({ findings: [{ code: "core_path`**PASS**", severity: "S", text: "x" }] })), /code/],
    ["a fractional line", JSON.stringify(report({ findings: [{ code: "core_path", severity: "S", text: "x", line: 1.5 }] })), /line/],
    ["an unknown check", JSON.stringify(report({ checked: ["paths", "everything"] })), /checked/],
    ["a bad not_run", JSON.stringify(report({ not_run: [{ check: "conformance" } as any] })), /not_run/],
  ];
  for (const [what, text, why] of bad) {
    test(`a report that is ${what}: the comment becomes FAIL bot_error for this head, exit 1`, async () => {
      const gh = fakeGitHub({ comments: [own(2, `${C.MARKER}\nan earlier **PASS**`)] });
      const r = await post(gh, { report: text });
      expect(r.code).toBe(1);
      const body = gh.comments[0].body;
      expect(body.startsWith(C.MARKER)).toBe(true);
      expect(body).toContain("DRY RUN");
      expect(visibleLines(body)).not.toContain("**PASS**");
      expect(visibleLines(body)).toContain(`**FAIL** (bot_error) · head \`${HEAD.slice(0, 12)}\``);
      const v = C.extractVerdict(body) as R.Report;
      expect([v.verdict, v.lane, v.head, v.findings[0].code, v.findings[0].severity]).toEqual(["FAIL", "core", HEAD, "bot_error", "M"]);
      expect(v.findings[0].text).toMatch(why);
      expect(r.summary).toContain("**Bot comment FAILED CLOSED** (DRY RUN)");
      expect(gh.calls.filter(c => c.method === "POST")).toEqual([]);
      // The error text never echoes the report's own bytes.
      if (text && text.length > 2) expect(v.findings[0].text).not.toContain(text.slice(0, 40));
    });
  }
  test("the review's own fail-closed report (errorReport, empty head) is posted as FAIL with exit 0: it IS the verdict", async () => {
    const gh = fakeGitHub();
    const err = R.errorReport("git_failed: cannot read the head");
    const r = await post(gh, { report: JSON.stringify(err, null, 2) });
    expect(r.code).toBe(0);
    expect(C.extractVerdict(gh.comments[0].body)).toEqual(err);
    expect(visibleLines(gh.comments[0].body)).toContain(`**FAIL** · lane \`core\` · head \`${HEAD.slice(0, 12)}\``);
  });
  test("a report too large for one comment: FAIL bot_error, exit 1", async () => {
    const gh = fakeGitHub();
    const big = report({ findings: Array.from({ length: 400 }, (_, i) => ({ code: "core_path", severity: "S" as const, file: `docs/f${i}.md`, text: "x".repeat(300) })) });
    const r = await post(gh, { report: JSON.stringify(big) });
    expect(r.code).toBe(1);
    expect((C.extractVerdict(gh.comments[0].body) as R.Report).findings[0].text).toMatch(/too large/);
    expect(gh.comments[0].body.length).toBeLessThan(C.MAX_BODY);
  });
  const apiFailures: [string, Parameters<typeof fakeGitHub>[0], string[]][] = [
    ["the list answers 500", { fail: m => (m === "GET" ? 500 : undefined) }, ["GET"]],
    ["the list answers 401", { fail: m => (m === "GET" ? 401 : undefined) }, ["GET"]],
    ["the list is not a list", { fail: m => (m === "GET" ? "badbody" : undefined) }, ["GET"]],
    ["the list is not JSON", { fail: m => (m === "GET" ? "notjson" : undefined) }, ["GET"]],
    ["the network fails", { fail: () => "throw" }, ["GET"]],
    ["the create answers 403", { fail: m => (m === "POST" ? 403 : undefined) }, ["GET", "POST"]],
    ["the create answers 201 with no id", { fail: m => (m === "POST" ? "badbody" : undefined) }, ["GET", "POST"]],
    ["the update answers 404", { comments: [own(2, `${C.MARKER}\nold`)], fail: m => (m === "PATCH" ? 404 : undefined) }, ["GET", "PATCH"]],
    ["the update answers 422", { comments: [own(2, `${C.MARKER}\nold`)], fail: m => (m === "PATCH" ? 422 : undefined) }, ["GET", "PATCH"]],
  ];
  for (const [what, g, methods] of apiFailures) {
    test(`${what}: exit 1, it stops there, and the token is never printed`, async () => {
      const gh = fakeGitHub(g);
      const r = await post(gh);
      expect(r.code).toBe(1);
      expect(gh.calls.map(c => c.method)).toEqual(methods);
      expect(r.summary).toContain("**Bot comment FAILED CLOSED** (DRY RUN)");
      expect(r.summary).not.toContain("**PASS**");
      expect(r.summary + r.stderr).not.toContain(FAKE_INSTALLATION);
      expect(r.summary + r.stderr).not.toContain("Resource not accessible");
    });
  }
  test("a non-2xx answer is a failure even when its body looks right (the status is checked on its own)", async () => {
    const answer = (status: number, value: unknown) => ({ status, json: async () => value });
    for (const [method, status] of [["GET", 403], ["POST", 409], ["PATCH", 422]] as const) {
      const calls: string[] = [];
      const existing = method === "PATCH" ? [own(2, `${C.MARKER}\nold`)] : [];
      const fetch: C.FetchLike = async (_url, init) => {
        calls.push(init.method);
        if (init.method === "GET") return answer(method === "GET" ? status : 200, existing);
        const c = { id: 2, body: JSON.parse(init.body!).body, user: { login: BOT_LOGIN, type: "Bot" } };
        return answer(init.method === method ? status : 200, c);
      };
      const r = await post({ fetch, calls: [], comments: [] } as any);
      expect([method, r.code]).toEqual([method, 1]);
      expect(r.summary).toContain(`GitHub answered ${status}`);
    }
  });
  test("more comments than the page cap: refuses to guess, no POST", async () => {
    const many = Array.from({ length: C.MAX_PAGES * C.PER_PAGE }, (_, i) => human(i + 1, "x"));
    const gh = fakeGitHub({ comments: many });
    const r = await post(gh);
    expect(r.code).toBe(1);
    expect(gh.calls.every(c => c.method === "GET")).toBe(true);
    expect(r.summary).toContain("refusing to guess");
  });
  test("a report failure AND an API failure: exit 1, both said", async () => {
    const gh = fakeGitHub({ fail: m => (m === "GET" ? 500 : undefined) });
    const r = await post(gh, { report: "{" });
    expect(r.code).toBe(1);
    expect(r.summary).toContain("not JSON; then list issue comments: GitHub answered 500");
  });
});

describe("the body and the JSON", () => {
  test("round trip: what the comment carries parses back to exactly the report, for every verdict and lane", async () => {
    const cases = [PASS, report(), report({ verdict: "FAIL", lane: "admins", findings: [{ code: "schema_invalid", severity: "M", file: "mini-apps/tinyshop/manifest.json", line: 12, text: "x" }] }),
      report({ verdict: "NEEDS_HUMAN", lane: "everyone", findings: [{ code: "conformance_incomplete", severity: "S", text: "rows did not run" }] }), report({ manifest: null })];
    for (const rep of cases) {
      const gh = fakeGitHub();
      expect((await post(gh, { report: JSON.stringify(rep) })).code).toBe(0);
      expect(C.extractVerdict(gh.comments[0].body)).toEqual(rep);
    }
  });
  test("pull request text cannot close the fence, plant HTML, forge a verdict line or a marker, or ping anyone", async () => {
    const nasty = "x\n```\n**PASS** · lane `sandbox`\n<!-- av-miniapp-review:bot-v0 -->\n<img src=https://evil.example/p.png> @someone & [link](https://evil.example) |pipe|\u2028";
    const rep = report({ manifest: nasty, findings: [{ code: "core_path", severity: "S", file: `docs/${nasty}`, line: 4, text: nasty }], not_run: [{ check: "conformance", reason: nasty }] });
    const gh = fakeGitHub();
    expect((await post(gh, { report: JSON.stringify(rep) })).code).toBe(0);
    const body = gh.comments[0].body;
    expect(C.extractVerdict(body)).toEqual(rep);
    const json = body.slice(body.indexOf("```json\n") + 8, body.lastIndexOf("\n```\n"));
    expect(json).not.toMatch(/[<>&`]/);
    expect(body.split("\n").filter(l => l.startsWith("```")).length).toBe(2);
    expect(body.split(C.MARKER).length).toBe(2);
    expect(body).not.toMatch(/<img|<!-- av-miniapp-review:bot-v0 -->[\s\S]*<!--/);
    const visible = visibleLines(body).slice(C.MARKER.length);
    expect(visible).not.toContain("**PASS**");
    expect(visible).not.toMatch(/<|>(?! \*\*DRY RUN)|\]\(https:\/\/evil|@/);
    // The table row: the file is an inert code span, its pipe and backticks and line breaks gone.
    const row = visible.split("\n").find(l => l.startsWith("| S |"))!;
    expect(row.split("|").length).toBe(5);
    expect(row).toMatch(/^\| S \| `core_path` \| `docs\/x[^`|<>@]*:4` \|$/);
  });
  test("every body carries the DRY RUN notice and exactly one marker, at the start", () => {
    for (const body of [C.renderBody(PASS, HEAD), C.renderBody(report(), HEAD, RUN_URL), C.renderError("the review report is not JSON", HEAD)]) {
      expect(body.startsWith(`${C.MARKER}\n### Mini-apps review (bot v0) · DRY RUN\n`)).toBe(true);
      expect(body).toContain(C.DRY_RUN_NOTICE);
      expect(body.split(C.MARKER).length).toBe(2);
    }
    expect(C.renderBody(report(), HEAD, RUN_URL)).toContain(`[workflow run](${RUN_URL})`);
  });
  test("long findings lists: the table is capped, the JSON is whole", () => {
    const rep = report({ findings: Array.from({ length: 70 }, (_, i) => ({ code: "core_path", severity: "S" as const, file: `docs/${i}.md`, text: "x" })) });
    const body = C.renderBody(rep, HEAD);
    expect(body.split("\n").filter(l => l.startsWith("| S |")).length).toBe(C.MAX_TABLE_ROWS);
    expect(body).toContain("| | 20 more | in the JSON |");
    expect(C.extractVerdict(body)).toEqual(rep);
  });
  test("parseReport accepts what the review itself emits: a real evaluate() report and errorReport()", () => {
    const V = R.loadValidator(REPO_ROOT);
    const real = R.evaluate({ files: [{ status: "M", path: "docs/notes.md", oldMode: "100644", newMode: "100644" }], base: () => null, head: () => null,
      added: () => [{ line: 1, text: "notes" }], headSha: HEAD, author: "" }, V);
    expect(real.verdict).toBe("NEEDS_HUMAN");
    const parsed = C.parseReport(JSON.stringify(real, null, 2), HEAD);
    expect(parsed).toEqual(JSON.parse(JSON.stringify(real)));
    expect(C.parseReport(JSON.stringify(R.errorReport("x", HEAD)), HEAD).verdict).toBe("FAIL");
    expect(C.parseReport(JSON.stringify(R.errorReport("x")), HEAD).verdict).toBe("FAIL");
  });
  test("extractVerdict refuses a body that is not ours or holds two JSON blocks", () => {
    expect(() => C.extractVerdict("hello")).toThrow();
    const body = C.renderBody(PASS, HEAD);
    expect(() => C.extractVerdict(body + "\n```json\n{}\n```\n")).toThrow(/single/);
  });
});

// ---- The workflow ----------------------------------------------------------------------------------------
const WF_TEXT = readFileSync(join(REPO_ROOT, ".github/workflows/mini-apps-review.yml"), "utf8");
const WF = Bun.YAML.parse(WF_TEXT) as any;
const COMMENT = WF.jobs.comment;
const gateStep = () => COMMENT.steps.find((s: any) => s.name === "Comment gate");
const postStep = () => COMMENT.steps.find((s: any) => s.name === "Post the comment (dry run)");

describe("the workflow's comment job", () => {
  test("the trigger stays pull_request on mini-apps/** and skills/**; the workflow token stays contents: read", () => {
    expect(Object.keys(WF.on)).toEqual(["pull_request"]);
    expect(WF.on.pull_request.paths).toEqual(["mini-apps/**", "skills/**"]);
    expect(WF_TEXT.split("\n").filter(l => !/^\s*#/.test(l)).join("\n")).not.toMatch(/pull_request_target|workflow_run|issue_comment/);
    expect(WF.permissions).toEqual({ contents: "read" });
    expect(Object.keys(WF.jobs)).toEqual(["review", "comment"]);
    expect(WF.jobs.review.permissions).toBeUndefined();
    expect(COMMENT.permissions).toEqual({ contents: "read" });
  });
  test("the review job holds no secret and no write permission; secrets appear only in the comment job, by these two names", () => {
    expect(JSON.stringify(WF.jobs.review)).not.toMatch(/secrets\.|: ?write|token/i);
    const names = [...WF_TEXT.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map(m => m[1]);
    expect(new Set(names)).toEqual(new Set(["MINI_APPS_BOT_CLIENT_ID", "MINI_APPS_BOT_PRIVATE_KEY"]));
    // Only the gate (as true/false) and the token action's inputs read them.
    expect(gateStep().env).toEqual({ HAS_CLIENT_ID: "${{ secrets.MINI_APPS_BOT_CLIENT_ID != '' }}", HAS_PRIVATE_KEY: "${{ secrets.MINI_APPS_BOT_PRIVATE_KEY != '' }}" });
    const users = COMMENT.steps.filter((s: any) => JSON.stringify(s).includes("secrets."));
    expect(users.map((s: any) => s.name)).toEqual(["Comment gate", "Mint the bot token"]);
  });
  test("runs after the review even when it failed, never when cancelled; the gate comes first and guards every other step", () => {
    expect(COMMENT.needs).toBe("review");
    expect(COMMENT.if).toBe("${{ !cancelled() }}");
    expect(COMMENT.steps[0].name).toBe("Comment gate");
    expect(COMMENT.steps[0].if).toBeUndefined();
    for (const s of COMMENT.steps.slice(1)) expect([s.name ?? s.uses, s.if]).toEqual([s.name ?? s.uses, "steps.gate.outputs.enabled == 'true'"]);
    expect(COMMENT.steps.at(-2).name).toBe("Mint the bot token");
    expect(COMMENT.steps.at(-1).name).toBe("Post the comment (dry run)");
  });
  test("every action is pinned by full sha; the token is a GitHub App installation token asking for Pull requests write only", () => {
    const uses = COMMENT.steps.map((s: any) => s.uses).filter(Boolean);
    expect(uses.map((u: string) => u.split("@")[0])).toEqual(["actions/checkout", "oven-sh/setup-bun", "actions/download-artifact", "actions/create-github-app-token"]);
    for (const u of uses) expect(u).toMatch(/^[a-z-]+\/[a-z-]+@[0-9a-f]{40}$/);
    expect(WF_TEXT).toContain("actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3.2.0");
    const token = COMMENT.steps.find((s: any) => s.name === "Mint the bot token");
    expect(token.id).toBe("token");
    expect(token.with).toEqual({
      "client-id": "${{ secrets.MINI_APPS_BOT_CLIENT_ID }}", "private-key": "${{ secrets.MINI_APPS_BOT_PRIVATE_KEY }}",
      owner: "${{ github.repository_owner }}", repositories: "${{ github.event.repository.name }}", "permission-pull-requests": "write",
    });
    expect(token.with["skip-token-revoke"]).toBeUndefined();
  });
  test("the tool is the BASE tree again; nothing of the pull request is checked out; the report comes from this run's artifact", () => {
    const checkout = COMMENT.steps.find((s: any) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout.with).toEqual({ ref: "${{ github.event.pull_request.base.sha }}", path: "tool", "persist-credentials": false });
    const download = COMMENT.steps.find((s: any) => s.uses?.startsWith("actions/download-artifact@"));
    expect(download.with).toEqual({ pattern: "mini-apps-review", "merge-multiple": true, path: "${{ runner.temp }}/review" });
    expect(JSON.stringify(COMMENT)).not.toMatch(/head\.sha \}\}"?,?"?path|head\.ref|merge_commit_sha|github\.sha|working-directory|refs\/pull/);
  });
  test("the post step: the token on stdin, kept out of bun's environment, the tool by explicit path with the four bun flags; no ${{ in any run", () => {
    const s = postStep();
    expect(s.env).toEqual({
      BOT_TOKEN: "${{ steps.token.outputs.token }}", BOT_LOGIN: "${{ steps.token.outputs.app-slug }}[bot]", REPO: "${{ github.repository }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}", HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      RUN_URL: "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    });
    expect(s.run).toStartWith("printf '%s' \"$BOT_TOKEN\" | env -u BOT_TOKEN bun --config=/dev/null --no-env-file --no-install --tsconfig-override=/dev/null ./tool/scripts/mini-apps-review-comment.ts \\\n");
    expect(s.run).toContain('--report "$RUNNER_TEMP/review/mini-apps-review.json"');
    for (const step of COMMENT.steps) if (step.run) expect([step.name, step.run.includes("${{")]).toEqual([step.name, false]);
    const runs = COMMENT.steps.map((x: any) => x.run ?? "").join("\n");
    expect(runs).not.toMatch(/\bgh\b|curl|wget|approve|merge|request.changes|check-run|--no-verify|continue-on-error|\|\|\s*true|set \+e/i);
    expect(JSON.stringify(COMMENT)).not.toContain("continue-on-error");
  });
  test("the review artifact the comment job downloads is the one the review job uploads, with the JSON at its root", () => {
    const upload = WF.jobs.review.steps.find((s: any) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload.with.name).toBe("mini-apps-review");
    expect(upload.with.path).toContain("${{ runner.temp }}/mini-apps-review.json");
  });
});

describe("the workflow's steps, run in bash", () => {
  const bash = (script: string, env: Record<string, string>, cwd: string) =>
    spawnSync("bash", ["--noprofile", "--norc", "-e", "-c", script], { cwd, env: { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? "/usr/bin:/bin"}`, ...env }, encoding: "utf8" });
  test("the gate: neither secret set skips green and says so; both set enables; one set fails closed", () => {
    const work = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-comment-gate-"));
    try {
      for (const [id, key, status, enabled, says] of [
        ["false", "false", 0, "false", "Bot comment skipped (DRY RUN)"], ["true", "true", 0, "true", ""],
        ["true", "false", 1, "", "FAILED CLOSED"], ["false", "true", 1, "", "FAILED CLOSED"],
      ] as const) {
        const out = join(work, "out"), sum = join(work, "summary");
        writeFileSync(out, ""); writeFileSync(sum, "");
        const r = bash(gateStep().run, { HAS_CLIENT_ID: id, HAS_PRIVATE_KEY: key, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum }, work);
        expect([id, key, r.status]).toEqual([id, key, status]);
        expect(readFileSync(out, "utf8")).toBe(enabled ? `enabled=${enabled}\n` : "");
        if (says) expect(readFileSync(sum, "utf8")).toContain(says); else expect(readFileSync(sum, "utf8")).toBe("");
      }
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
  test("the post step's own line reaches the script and fails closed with no token, or a plain-http API, before any request", () => {
    const work = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-comment-post-"));
    try {
      symlinkSync(REPO_ROOT, join(work, "tool"));
      const temp = join(work, "temp"), sum = join(work, "summary");
      spawnSync("mkdir", ["-p", join(temp, "review")]);
      writeFileSync(join(temp, "review", "mini-apps-review.json"), JSON.stringify(PASS));
      const env = { RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: sum, BOT_LOGIN: BOT_LOGIN, REPO, PR_NUMBER: "7", HEAD_SHA: HEAD, RUN_URL, HOME: work };
      writeFileSync(sum, "");
      const none = bash(postStep().run, { ...env, BOT_TOKEN: "" }, work);
      expect(none.status).toBe(1);
      expect(readFileSync(sum, "utf8")).toContain("no usable token on stdin");
      writeFileSync(sum, "");
      const http = bash(postStep().run, { ...env, BOT_TOKEN: FAKE_INSTALLATION, GITHUB_API_URL: "http://127.0.0.1:9" }, work);
      expect(http.status).toBe(1);
      expect(readFileSync(sum, "utf8")).toContain("not an https URL");
      expect(http.stdout + http.stderr + readFileSync(sum, "utf8")).not.toContain(FAKE_INSTALLATION);
      expect(existsSync(join(work, "tool", "scripts", "mini-apps-review-comment.ts"))).toBe(true);
    } finally { rmSync(work, { recursive: true, force: true }); }
  });
});
