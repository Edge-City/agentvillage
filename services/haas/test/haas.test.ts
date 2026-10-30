// End to end through the Worker's fetch handler, with D1 shimmed over bun:sqlite.

import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import worker, { type Env } from "../src/index";
import { verifyLogin } from "../src/telegram";
import { hex, hmac, sha256 } from "../src/util";

function d1(db: Database) {
  const stmt = (sql: string, args: unknown[] = []): any => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => db.query(sql).get(...(args as any[])) ?? null,
    all: async () => ({ results: db.query(sql).all(...(args as any[])) }),
    run: async () => ({ meta: { changes: db.query(sql).run(...(args as any[])).changes } }),
    exec: () => db.query(sql).run(...(args as any[])),
  });
  return { prepare: (sql: string) => stmt(sql), batch: async (s: any[]) => db.transaction(() => s.map(x => x.exec()))() };
}

const ORIGIN = "https://haas.test";
let env: Env;
const ctx = { waitUntil() {} };

beforeEach(() => {
  const db = new Database(":memory:");
  const dir = join(import.meta.dir, "../migrations");
  for (const f of readdirSync(dir).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  env = { DB: d1(db) as any, HMAC_SECRET: "test-secret", DEV_LOGIN: "1" };
});

const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
  worker.fetch(new Request(ORIGIN + path, { ...init, headers: { ...(init.cookie ? { cookie: init.cookie } : {}), ...(init.headers as any) } }), env, ctx);

const postForm = (path: string, fields: Record<string, string | Blob>, cookie?: string) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v as any);
  return call(path, { method: "POST", body: fd, cookie });
};

let rpcId = 0;
async function mcp(method: string, params?: unknown) {
  const r = await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }), headers: { "content-type": "application/json" } });
  return (await r.json()) as any;
}
const tool = async (name: string, args: Record<string, unknown> = {}) => (await mcp("tools/call", { name, arguments: args })).result;

async function enlist(name: string, skills = "scooter, photography", zone = "Mandrem", extraCookie?: string) {
  const r = await postForm("/dev/login", { name, next: "/me" }, extraCookie);
  const cookie = r.headers.get("set-cookie")!.split(";")[0];
  await postForm("/me", { name, skills, zone, bio: "Reliable.", available: "1" }, cookie);
  const me = (await tool("browse_servants", { skill: skills.split(",")[0] })).structuredContent.servants.find((s: any) => s.name === name);
  return { cookie, id: me.servantId as string };
}

const pathOf = (u: string) => u.slice(ORIGIN.length);

describe("MCP", () => {
  test("initialize, tools/list and notifications", async () => {
    const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    expect(init.result.serverInfo.name).toBe("haas");
    expect(init.result.protocolVersion).toBe("2025-06-18");
    const list = await mcp("tools/list");
    expect(list.result.tools.map((t: any) => t.name)).toEqual(["browse_servants", "draft_task", "task_status", "draft_enlistment", "draft_invite", "leaderboard"]);
    const n = await call("/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(n.status).toBe(202);
  });

  test("draft_task validates and stores nothing", async () => {
    expect((await tool("draft_task", { title: "", instructions: "x" })).isError).toBe(true);
    const d = (await tool("draft_task", { title: "Check the tide", instructions: "Is it out?" })).structuredContent;
    expect(d.status).toBe("not_posted");
    expect(d.preview.reward).toBe(10);
    expect((await tool("task_status", { taskId: d.taskId })).structuredContent.status).toBe("not_posted");
    expect((await tool("leaderboard")).structuredContent.mostDemandingOverlords).toEqual([]);
  });
});

describe("the whole loop", () => {
  test("draft, owner posts, servant claims and submits, owner accepts, servant is paid", async () => {
    const priya = await enlist("Priya");
    const d = (await tool("draft_task", {
      title: "Photograph the sunset", instructions: "From Mandrem beach.", proof: "photo", reward: 25, overlord: "Claude", servantId: priya.id,
    })).structuredContent;

    const preview = await call(pathOf(d.postUrl));
    expect(preview.status).toBe(200);
    expect(await preview.text()).toContain("Photograph the sunset");

    const token = new URL(d.postUrl).searchParams.get("d")!;
    const posted = await postForm("/post", { d: token });
    expect(posted.status).toBe(303);
    expect(posted.headers.get("location")).toBe(pathOf(d.manageUrl) + "&f=posted");
    await postForm("/post", { d: token }); // a second tap posts nothing new

    let s = (await tool("task_status", { taskId: d.taskId })).structuredContent;
    expect(s.status).toBe("open");
    expect(s.offeredTo.name).toBe("Priya");

    // Reserved for Priya: someone else cannot claim it.
    const ravi = await enlist("Ravi");
    expect((await postForm(`/t/${d.taskId}/claim`, {}, ravi.cookie)).status).toBe(409);
    expect((await postForm(`/t/${d.taskId}/claim`, {}, priya.cookie)).status).toBe(303);

    // Photo proof is required.
    expect((await postForm(`/t/${d.taskId}/submit`, { text: "done" }, priya.cookie)).status).toBe(400);
    const png = new Blob([new Uint8Array([137, 80, 78, 71, 1, 2, 3])], { type: "image/png" });
    expect((await postForm(`/t/${d.taskId}/submit`, { text: "Gorgeous.", photo: new File([png], "p.png", { type: "image/png" }) }, priya.cookie)).status).toBe(303);

    s = (await tool("task_status", { taskId: d.taskId })).structuredContent;
    expect(s.status).toBe("submitted");
    expect(s.proof.text).toBe("Gorgeous.");
    const photo = await call(pathOf(s.proof.photoUrl));
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await photo.arrayBuffer())[0]).toBe(137);

    // Wrong key is refused; reject sends it back; then accept pays.
    const key = new URL(d.manageUrl).searchParams.get("k")!;
    expect((await postForm(`/manage/${d.taskId}/accept`, { k: "nope" })).status).toBe(403);
    expect((await postForm(`/manage/${d.taskId}/reject`, { k: key, note: "Wrong beach" })).status).toBe(303);
    s = (await tool("task_status", { taskId: d.taskId })).structuredContent;
    expect(s.status).toBe("claimed");
    expect(s.rejectionNote).toBe("Wrong beach");
    await postForm(`/t/${d.taskId}/submit`, { text: "Right beach." }, priya.cookie); // the earlier photo still counts
    expect((await postForm(`/manage/${d.taskId}/accept`, { k: key })).status).toBe(303);

    s = (await tool("task_status", { taskId: d.taskId })).structuredContent;
    expect(s.status).toBe("accepted");
    const lb = (await tool("leaderboard")).structuredContent;
    expect(lb.mostFaithfulServants[0]).toMatchObject({ name: "Priya", credits: 25, tasksDone: 1, rank: "Reliable Wetware" });
    expect(lb.mostDemandingOverlords[0]).toMatchObject({ overlord: "Claude", tasksPosted: 1, creditsPaid: 25 });
  });

  test("a tampered post link is refused", async () => {
    const d = (await tool("draft_task", { title: "A", instructions: "B" })).structuredContent;
    const token = new URL(d.postUrl).searchParams.get("d")!;
    const [body, sig] = token.split(".");
    const forged = btoa(atob(body.replace(/-/g, "+").replace(/_/g, "/")).replace('"reward":10', '"reward":99')).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
    expect((await postForm("/post", { d: `${forged}.${sig}` })).status).toBe(400);
  });

  test("pages render with hostile text escaped", async () => {
    const d = (await tool("draft_task", { title: "<script>alert(1)</script>", instructions: "x" })).structuredContent;
    await postForm("/post", { d: new URL(d.postUrl).searchParams.get("d")! });
    const board = await (await call("/")).text();
    expect(board).not.toContain("<script>alert(1)</script>");
    expect(board).toContain("&lt;script&gt;");
    for (const p of ["/roster", "/leaderboard", "/enlist", `/t/${d.taskId}`]) expect((await call(p)).status).toBe(200);
  });
});

test("the bot enlists a human through a one-tap link", async () => {
  env.TG_BOT_TOKEN = "123:abc";
  env.TG_WEBHOOK_SECRET = "hook";
  const sent: any[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_u: string, init: any) => { sent.push(JSON.parse(init.body)); return new Response("{}"); }) as any;
  const pending: Promise<unknown>[] = [];
  const hookCtx = { waitUntil: (p: Promise<unknown>) => pending.push(p) };
  const update = (text: string, secret = "hook") => worker.fetch(new Request(ORIGIN + "/tg/webhook", {
    method: "POST", headers: { "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify({ message: { text, chat: { type: "private", id: 77 }, from: { id: 77, first_name: "Asha" } } }),
  }), env, hookCtx);
  try {
    expect((await update("/enlist", "wrong")).status).toBe(403);
    const priya = await enlist("Priya");
    expect((await update(`/start r_${priya.id}`)).status).toBe(200);
    await Promise.all(pending);
    expect(sent.some(m => m.text.includes("recruited by Priya"))).toBe(true);
    const link = sent.at(-1).reply_markup.inline_keyboard[0][0].url as string;
    const r = await call(pathOf(link));
    expect(r.status).toBe(303);
    const cookie = r.headers.get("set-cookie")!.split(";")[0];
    await postForm("/me", { name: "Asha", skills: "scooter", zone: "Mandrem", available: "1" }, cookie);
    expect((await tool("browse_servants", { name: "asha" })).structuredContent.servants[0].name).toBe("Asha");
    expect((await tool("leaderboard")).structuredContent.topRecruiters[0]).toMatchObject({ name: "Priya", recruits: 1 });
    expect((await call(pathOf(link).replace(/t=[^&]+/, "t=77.9999999999999.forged"))).status).toBe(403);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("Telegram login verification", async () => {
  const token = "123:abc";
  const fields = { id: "42", first_name: "Asha", username: "asha", auth_date: String(Math.floor(Date.now() / 1000)) };
  const check = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = hex(await hmac(await sha256(token), check));
  expect(await verifyLogin(new URLSearchParams({ ...fields, hash }), token)).toMatchObject({ id: 42, username: "asha" });
  expect(await verifyLogin(new URLSearchParams({ ...fields, first_name: "Eve", hash }), token)).toBeNull();
});

const cookieFrom = (r: Response, name: string) =>
  r.headers.getSetCookie().map(c => c.split(";")[0]).find(c => c.startsWith(`${name}=`))!;

async function postAndAccept(servant: { cookie: string; id: string }, title: string, reward = 10) {
  const d = (await tool("draft_task", { title, instructions: "x", reward, servantId: servant.id })).structuredContent;
  await postForm("/post", { d: new URL(d.postUrl).searchParams.get("d")! });
  await postForm(`/t/${d.taskId}/claim`, {}, servant.cookie);
  await postForm(`/t/${d.taskId}/submit`, { text: "done" }, servant.cookie);
  await postForm(`/manage/${d.taskId}/accept`, { k: new URL(d.manageUrl).searchParams.get("k")! });
}

describe("recruiting", () => {
  test("draft_enlistment prefills the owner's profile and credits the recruiter", async () => {
    const priya = await enlist("Priya");
    expect((await tool("draft_enlistment", { recruiterServantId: "nosuchid" })).isError).toBe(true);
    const e = (await tool("draft_enlistment", {
      name: "Asha", skills: ["Photography", "scooter"], zone: "Arambol", bio: "Early riser.", recruiterServantId: priya.id,
    })).structuredContent;
    expect(e.recruitedBy).toBe("Priya");
    const join = await call(pathOf(e.joinUrl));
    expect(join.status).toBe(200);
    expect(await join.text()).toContain("Early riser.");
    const login = await postForm("/dev/login", { name: "asha-tg", next: "/me" }, cookieFrom(join, "haas_join"));
    const session = cookieFrom(login, "haas_s");
    const me = await (await call("/me", { cookie: `${session}; ${cookieFrom(join, "haas_join")}` })).text();
    expect(me).toContain('value="photography, scooter"');
    expect(me).toContain('value="Arambol"');
    expect(me).toContain("Recruited by Priya");
  });

  test("an invite link credits the recruiter once the recruit's first task is accepted", async () => {
    const priya = await enlist("Priya");
    const inv = (await tool("draft_invite", { recruiterServantId: priya.id })).structuredContent;
    expect(inv.inviteUrl).toBe(`${ORIGIN}/join?r=${priya.id}`); // no bot configured in this env
    const join = await call(pathOf(inv.inviteUrl));
    const ravi = await enlist("Ravi", "konkani", "Mandrem", cookieFrom(join, "haas_ref"));

    await postAndAccept(ravi, "First job");
    await postAndAccept(ravi, "Second job"); // the bonus is paid once
    const lb = (await tool("leaderboard")).structuredContent;
    expect(lb.mostFaithfulServants.find((s: any) => s.name === "Priya").credits).toBe(5);
    expect(lb.topRecruiters).toEqual([{ name: "Priya", recruits: 1, recruitsWhoServed: 1 }]);

    // Already enlisted: a later invite changes nothing.
    const join2 = await call(`/join?r=${ravi.id}`);
    await postForm("/dev/login", { name: "Priya", next: "/me" }, cookieFrom(join2, "haas_ref"));
    expect((await tool("leaderboard")).structuredContent.topRecruiters).toHaveLength(1);
  });
});
