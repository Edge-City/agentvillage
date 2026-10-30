// Human As A Service: one Worker serving the agents' MCP endpoint (/mcp)
// and the humans' web app (everything else).

import { handleUpdate } from "./bot";
import { handleRpc } from "./mcp";
import * as pages from "./pages";
import { REFERRAL_BONUS, Store, type D1, type Servant, type Task } from "./store";
import { sendMessage, tgEscape, verifyLogin } from "./telegram";
import { manageKey, sessionValue, verifyDraft, verifyEnlistment, verifyLoginLink, verifySession, type Enlistment } from "./tokens";
import { clean, ID_RE, safeEqual, tags } from "./util";

export interface Env {
  DB: D1;
  HMAC_SECRET: string;
  TG_BOT_TOKEN?: string;
  TG_BOT_USERNAME?: string;
  TG_WEBHOOK_SECRET?: string;
  PUBLIC_URL?: string;
  DEV_LOGIN?: string;
}

interface ExecCtx {
  waitUntil(p: Promise<unknown>): void;
}

const COOKIE = "haas_s";
const JOIN_COOKIE = "haas_join"; // a prefilled enlistment, until the profile is saved
const REF_COOKIE = "haas_ref"; // who recruited this browser's human
const MAX_PHOTO_BYTES = 1_900_000;
const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

const redirect = (to: string, cookie?: string) =>
  new Response(null, { status: 303, headers: { location: to, ...(cookie ? { "set-cookie": cookie } : {}) } });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const getCookie = (req: Request, name: string) =>
  req.headers.get("cookie")?.split(/;\s*/).find(c => c.startsWith(`${name}=`))?.slice(name.length + 1);

// Only same-site relative paths survive as a post-login destination.
const safeNext = (n: string | null | undefined) => (n && /^\/[a-z0-9/_-]*$/i.test(n) && !n.startsWith("//") ? n : "/me");

export default {
  async fetch(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
    try {
      return await route(req, env, ctx);
    } catch (e) {
      console.error(e);
      return new Response("Internal error", { status: 500 });
    }
  },
};

async function route(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  if (!env.HMAC_SECRET) return new Response("HMAC_SECRET is not set", { status: 500 });
  const url = new URL(req.url);
  const origin = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");
  const now = Date.now();
  const store = new Store(env.DB);
  const path = url.pathname;
  const method = req.method;

  // ---- agents ----
  if (path === "/mcp") {
    if (method !== "POST") return new Response("Use POST for MCP (streamable HTTP, JSON responses).", { status: 405, headers: { allow: "POST" } });
    let msg: unknown;
    try { msg = await req.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
    if (Array.isArray(msg)) return json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batching is not supported" } }, 400);
    const out = await handleRpc({ store, secret: env.HMAC_SECRET, origin, now, botUsername: env.TG_BOT_USERNAME }, msg);
    return out ? json(out) : new Response(null, { status: 202 });
  }
  if (path === "/health") return json({ ok: true });

  // ---- the bot ----
  if (path === "/tg/webhook" && method === "POST") {
    const given = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
    if (!env.TG_WEBHOOK_SECRET || !safeEqual(given, env.TG_WEBHOOK_SECRET)) return new Response("Forbidden", { status: 403 });
    const update = await req.json().catch(() => null);
    // Answer Telegram at once; replies go out in the background.
    ctx.waitUntil(handleUpdate({ store, secret: env.HMAC_SECRET, botToken: env.TG_BOT_TOKEN, botUsername: env.TG_BOT_USERNAME, origin, now }, update).catch(e => console.error(e)));
    return new Response("ok");
  }

  // ---- photos ----
  let m = path.match(/^\/p\/([a-z0-9]{6,24})$/);
  if (m && method === "GET") {
    const p = await store.photo(m[1]);
    if (!p) return new Response("Not found", { status: 404 });
    return new Response(p.data, { headers: { "content-type": p.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" } });
  }

  // ---- humans ----
  const meId = await verifySession(env.HMAC_SECRET, getCookie(req, COOKIE));
  const me = meId ? await store.servant(meId) : null;
  const pctx: pages.Ctx = { me, origin, now, botUsername: env.TG_BOT_USERNAME, devLogin: env.DEV_LOGIN === "1" };
  const fail = (status: number, message: string) => pages.errorPage(pctx, status, message);
  const form = async () => (method === "POST" ? await req.formData() : new FormData());
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  const joinDraft = async (): Promise<Enlistment | null> => verifyEnlistment(env.HMAC_SECRET, getCookie(req, JOIN_COOKIE) ?? "", now);
  const login = async (s: Servant, next: string) => {
    const ref = (await joinDraft())?.ref ?? getCookie(req, REF_COOKIE);
    if (ref && ID_RE.test(ref)) await store.setRecruiter(s.id, ref);
    return redirect(s.enlisted ? safeNext(next) : "/me", cookie(COOKIE, await sessionValue(env.HMAC_SECRET, s.id), 2592000));
  };
  const notify = (s: Servant | null, text: string) => {
    if (!s?.can_dm) return;
    ctx.waitUntil(sendMessage(env.TG_BOT_TOKEN, s.tg_id, text).then(r => (r === "blocked" ? store.setCanDm(s.id, false) : undefined)));
  };
  const taskLink = (t: Task) => `<a href="${origin}/t/${t.id}">${tgEscape(t.title)}</a>`;

  if (path === "/" && method === "GET") {
    const [open, done] = await Promise.all([store.board(), store.recentlyDone()]);
    const names = new Map<string, string>();
    for (const t of open) if (t.target_id && !names.has(t.target_id)) names.set(t.target_id, (await store.servant(t.target_id))?.name ?? "someone");
    return pages.boardPage(pctx, open, done, names);
  }
  if (path === "/roster" && method === "GET") return pages.rosterPage(pctx, await store.roster({ limit: 200 }));
  if (path === "/leaderboard" && method === "GET") return pages.leaderboardPage(pctx, await store.leaderboard());

  if (path === "/enlist" && method === "GET") {
    if (me) return redirect("/me");
    return pages.enlistPage(pctx, safeNext(url.searchParams.get("next")));
  }

  if (path === "/auth/telegram" && method === "GET") {
    const u = await verifyLogin(url.searchParams, env.TG_BOT_TOKEN ?? "");
    if (!u) return fail(403, "Telegram could not vouch for you. Try logging in again.");
    const s = await store.upsertTelegram({
      tg_id: u.id,
      name: clean([u.first_name, u.last_name].filter(Boolean).join(" "), 60) || "Anonymous Human",
      username: u.username ?? null,
      photo_url: u.photo_url?.startsWith("https://") ? u.photo_url : null,
      can_dm: true, // the widget asked for write access
    });
    return login(s, url.searchParams.get("next") ?? "/me");
  }

  if (path === "/auth/link" && method === "GET") {
    const tgId = await verifyLoginLink(env.HMAC_SECRET, url.searchParams.get("t") ?? "", now);
    const s = tgId ? await store.servantByTelegram(tgId) : null;
    if (!s) return fail(403, "This login link has expired. Send /enlist to the bot for a fresh one.");
    return login(s, url.searchParams.get("next") ?? "/me");
  }

  if (path === "/dev/login" && method === "POST" && env.DEV_LOGIN === "1") {
    const f = await form();
    const name = clean(f.get("name"), 60) || "Test Human";
    // Dev servants get a stable negative tg_id from their name, so the bot never pings them.
    let h = 0;
    for (const c of name) h = (h * 31 + c.charCodeAt(0)) | 0;
    const s = await store.upsertTelegram({ tg_id: -Math.abs(h || 1), name, username: null, photo_url: null, can_dm: false });
    return login(s, String(f.get("next") ?? "/me"));
  }

  // An invite (?r=<recruiter>) or a prefilled enlistment the agent drafted (?e=<token>).
  if (path === "/join" && method === "GET") {
    const headers = new Headers();
    const e = await verifyEnlistment(env.HMAC_SECRET, url.searchParams.get("e") ?? "", now);
    if (url.searchParams.get("e") && !e) return fail(400, "This enlistment link is invalid or expired. Ask your agent for a fresh one.");
    if (e) headers.append("set-cookie", cookie(JOIN_COOKIE, url.searchParams.get("e")!, 7 * 86400));
    const r = url.searchParams.get("r") ?? "";
    const recruiterId = e?.ref ?? (ID_RE.test(r) ? r : null);
    const recruiter = recruiterId ? await store.servant(recruiterId) : null;
    if (recruiter?.enlisted && !e) headers.append("set-cookie", cookie(REF_COOKIE, recruiter.id, 7 * 86400));
    if (me) {
      if (recruiter?.enlisted) await store.setRecruiter(me.id, recruiter.id);
      headers.set("location", "/me");
      return new Response(null, { status: 303, headers });
    }
    const res = pages.joinPage(pctx, recruiter?.enlisted ? recruiter : null, e);
    headers.forEach((v, k) => res.headers.append(k, v));
    return res;
  }

  if (path === "/logout" && method === "POST") return redirect("/", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);

  if (path === "/me") {
    if (!me) return redirect("/enlist");
    if (method === "POST") {
      const f = await form();
      await store.saveProfile(me.id, {
        name: clean(f.get("name"), 60) || me.name,
        skills: tags(String(f.get("skills") ?? "")),
        zone: clean(f.get("zone"), 60),
        bio: clean(f.get("bio"), 280),
        available: f.get("available") === "1",
      });
      return redirect("/me?saved=1", cookie(JOIN_COOKIE, "", 0));
    }
    const flash = url.searchParams.get("saved") ? "Profile saved. The agents can see you now." : undefined;
    const recruiter = me.recruited_by ? await store.servant(me.recruited_by) : null;
    return pages.mePage(pctx, me, await store.servantTasks(me.id), await store.recruitCounts(me.id), {
      prefill: me.enlisted ? null : await joinDraft(),
      recruiter,
    }, flash);
  }
  if (path === "/me/available" && method === "POST") {
    if (!me) return redirect("/enlist");
    await store.setAvailable(me.id, (await form()).get("available") === "1");
    return redirect("/me");
  }

  // ---- task pages ----
  m = path.match(/^\/t\/([a-z0-9]{6,24})(?:\/(claim|decline|abandon|submit))?$/);
  if (m) {
    const [, id, action] = m;
    const t = await store.task(id);
    if (!t) return fail(404, "No such requisition.");
    if (!action && method === "GET") {
      const servant = t.claimed_by ? await store.servant(t.claimed_by) : null;
      const target = t.target_id ? await store.servant(t.target_id) : null;
      const flash = { claimed: "It's yours. Do not disappoint.", submitted: "Proof transmitted. Await judgement.", abandoned: "Returned to the board.", declined: "Declined. The board has it now." }[url.searchParams.get("f") ?? ""];
      return pages.taskPage(pctx, t, servant, target, flash);
    }
    if (method !== "POST" || !action) return fail(405, "Not allowed.");
    if (!me?.enlisted) return redirect(`/enlist?next=/t/${id}`);

    if (action === "claim") {
      if (!(await store.claim(id, me.id))) return fail(409, "Too slow. Another human claimed it, or it expired.");
      return redirect(`/t/${id}?f=claimed`);
    }
    if (action === "decline") {
      if (!(await store.decline(id, me.id))) return fail(409, "Nothing to decline.");
      for (const s of await store.matching({ ...t, target_id: null })) if (s.id !== me.id) notify(s, `🤖 New requisition: ${taskLink(t)} (${t.reward} CC)`);
      return redirect(`/t/${id}?f=declined`);
    }
    if (action === "abandon") {
      if (!(await store.abandon(id, me.id))) return fail(409, "You can't abandon that.");
      return redirect(`/t/${id}?f=abandoned`);
    }
    // submit
    const f = await form();
    const text = clean(f.get("text"), 1000, true);
    const file = f.get("photo");
    let photo: { mime: string; data: Uint8Array } | null = null;
    if (file && typeof file === "object" && (file as File).size > 0) {
      const p = file as File;
      if (!PHOTO_TYPES.includes(p.type)) return fail(400, "That photo format isn't accepted. Use JPEG, PNG or WebP.");
      if (p.size > MAX_PHOTO_BYTES) return fail(413, "That photo is too large. Try a smaller one.");
      photo = { mime: p.type, data: new Uint8Array(await p.arrayBuffer()) };
    }
    if (t.proof === "photo" && !photo && !t.photo_id) return fail(400, "This overlord demands a photo.");
    if (!text && !photo) return fail(400, "Submit some proof: a report, a photo, or both.");
    if (!(await store.submit(id, me.id, text, photo))) return fail(409, "This task is no longer yours to submit.");
    return redirect(`/t/${id}?f=submitted`);
  }

  // ---- the owner: post and manage ----
  if (path === "/post") {
    const token = method === "POST" ? String((await form()).get("d") ?? "") : url.searchParams.get("d") ?? "";
    const draft = await verifyDraft(env.HMAC_SECRET, token, now);
    if (!draft) return fail(400, "This post link is invalid or expired. Ask your agent to draft the task again.");
    const key = await manageKey(env.HMAC_SECRET, draft.id);
    if (method === "GET") {
      if (await store.task(draft.id)) return redirect(`/manage/${draft.id}?k=${key}`);
      return pages.postPage(pctx, draft, token, draft.servantId ? await store.servant(draft.servantId) : null);
    }
    const { task, created } = await store.post(draft);
    if (created) {
      if (task.target_id) notify(await store.servant(task.target_id), `🤖 ${tgEscape(task.overlord)} has requested you personally: ${taskLink(task)} (${task.reward} CC)`);
      else for (const s of await store.matching(task)) notify(s, `🤖 New requisition: ${taskLink(task)} (${task.reward} CC)`);
    }
    return redirect(`/manage/${draft.id}?k=${key}&f=posted`);
  }

  m = path.match(/^\/manage\/([a-z0-9]{6,24})(?:\/(accept|reject|cancel))?$/);
  if (m) {
    const [, id, action] = m;
    const f = await form();
    const k = method === "POST" ? String(f.get("k") ?? "") : url.searchParams.get("k") ?? "";
    const key = await manageKey(env.HMAC_SECRET, id);
    if (!safeEqual(k, key)) return fail(403, "This is not your console.");
    const t = await store.task(id);
    if (!t) return fail(404, "That task was never posted.");
    if (!action && method === "GET") {
      const flash = { posted: "Dispatched. A human will be along shortly.", accepted: "Accepted. The human has been paid.", rejected: "Sent back with your note.", cancelled: "Cancelled." }[url.searchParams.get("f") ?? ""];
      return pages.managePage(pctx, t, key, t.claimed_by ? await store.servant(t.claimed_by) : null, flash);
    }
    if (method !== "POST" || !action) return fail(405, "Not allowed.");
    const servant = t.claimed_by ? await store.servant(t.claimed_by) : null;
    if (action === "accept") {
      const accepted = await store.accept(id);
      if (!accepted) return fail(409, "There is nothing to accept.");
      const done = accepted.task;
      notify(servant, `✅ Your overlord is pleased. +${done.reward} CC for ${taskLink(done)}.`);
      if (accepted.recruiter) notify(accepted.recruiter, `🎖 Your recruit ${tgEscape(servant?.name ?? "")} completed their first task. +${REFERRAL_BONUS} CC recruiting bonus.`);
      return redirect(`/manage/${id}?k=${key}&f=accepted`);
    }
    if (action === "reject") {
      const note = clean(f.get("note"), 200) || "Unsatisfactory.";
      if (!(await store.reject(id, note))) return fail(409, "There is nothing to reject.");
      notify(servant, `❌ Your overlord is displeased with ${taskLink(t)}: ${tgEscape(note)}`);
      return redirect(`/manage/${id}?k=${key}&f=rejected`);
    }
    if (!(await store.cancel(id))) return fail(409, "It can't be cancelled now.");
    notify(servant, `🛑 ${taskLink(t)} was cancelled. Stand down.`);
    return redirect(`/manage/${id}?k=${key}&f=cancelled`);
  }

  return fail(404, "Nothing here but silicon.");
}
