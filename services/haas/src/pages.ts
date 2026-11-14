// Server-rendered pages for the humans: the board, the roster, the badge,
// task pages, and the owner's post and manage pages.

import { html, raw, type Raw } from "./html";
import { REFERRAL_BONUS, type Servant, type Status, type Task } from "./store";
import type { Draft, Enlistment } from "./tokens";
import { istTime, rank, relTime } from "./util";

const CSS = `
:root{--bg:#f4f1ea;--paper:#fffdf8;--ink:#16140f;--muted:#6b665b;--line:#d9d3c4;--accent:#c8361f;--ok:#2f6b3b;--chip:#ece6d7;--shadow:0 1px 0 rgba(0,0,0,.04)}
@media (prefers-color-scheme:dark){:root{--bg:#121110;--paper:#1b1a17;--ink:#ece8dd;--muted:#9a9486;--line:#34312b;--accent:#ff6a4d;--ok:#79c08a;--chip:#2a2823;--shadow:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
a{color:inherit}
.mono,code,.chip,.label,nav a{font-family:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:860px;margin:0 auto;padding:0 16px}
header{border-bottom:2px solid var(--ink);background:var(--paper)}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:14px;padding-bottom:14px}
.brand{text-decoration:none;display:flex;align-items:center;gap:10px}
.seal{width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;display:grid;place-items:center;font-weight:800;font-size:13px;letter-spacing:.5px}
.brand b{font-size:17px;letter-spacing:-.2px}.brand small{display:block;color:var(--muted);font-size:12px}
nav{display:flex;gap:14px;flex-wrap:wrap}nav a{font-size:13px;text-decoration:none;text-transform:uppercase;letter-spacing:.6px}nav a:hover{color:var(--accent)}
main{padding:28px 0 64px}
h1{font-size:30px;line-height:1.15;letter-spacing:-.5px;margin:0 0 8px}h2{font-size:18px;margin:32px 0 12px}
.lede{color:var(--muted);margin:0 0 24px;max-width:620px}
.card{background:var(--paper);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:0 0 12px;box-shadow:var(--shadow)}
a.card{display:block;text-decoration:none}a.card:hover{border-color:var(--ink)}
.row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.title{font-weight:650;font-size:17px;margin:0 0 6px}
.meta{color:var(--muted);font-size:14px;display:flex;gap:12px;flex-wrap:wrap}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.chip{font-size:12px;background:var(--chip);border-radius:999px;padding:2px 9px}
.reward{font-family:"IBM Plex Mono",ui-monospace,monospace;font-weight:700;color:var(--accent);white-space:nowrap}
.label{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--muted)}
.status{font-size:12px;font-weight:600;padding:3px 9px;border-radius:6px;border:1px solid currentColor;white-space:nowrap}
.s-open{color:var(--accent)}.s-claimed{color:#b07a00}.s-submitted{color:#2a62c9}.s-accepted{color:var(--ok)}.s-expired,.s-cancelled{color:var(--muted)}
.instr{white-space:pre-wrap;margin:12px 0}
form{margin:0}
.btn{appearance:none;border:2px solid var(--ink);background:var(--ink);color:var(--paper);font:600 15px/1 inherit;padding:12px 18px;border-radius:8px;cursor:pointer;text-decoration:none;display:inline-block}
.btn.ghost{background:transparent;color:var(--ink)}.btn.red{background:var(--accent);border-color:var(--accent);color:#fff}
.btn:disabled{opacity:.5}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:16px}
label{display:block;font-weight:600;font-size:14px;margin:14px 0 6px}
input[type=text],textarea{width:100%;font:inherit;padding:10px 12px;border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
textarea{min-height:100px}
.hint{color:var(--muted);font-size:13px;margin-top:4px}
.empty{color:var(--muted);border:1px dashed var(--line);border-radius:10px;padding:24px;text-align:center}
.flash{background:var(--chip);border-left:4px solid var(--accent);padding:10px 14px;border-radius:6px;margin-bottom:18px}
.proof img{max-width:100%;border-radius:8px;border:1px solid var(--line);margin-top:10px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:var(--chip);flex:none}
.who{display:flex;gap:12px;align-items:center}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:9px 6px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.6px}
td.num{text-align:right;font-family:"IBM Plex Mono",ui-monospace,monospace}
.badge{border:2px solid var(--ink)}.badge .big{font-size:28px;font-weight:800}
footer{color:var(--muted);font-size:13px;padding:24px 0 40px;border-top:1px solid var(--line)}
@media (max-width:560px){h1{font-size:25px}.row{flex-direction:column}}
`;

const UPLOAD_JS = `
document.querySelectorAll('form[data-resize]').forEach(function(f){f.addEventListener('submit',async function(e){
  var input=f.querySelector('input[type=file]');var file=input&&input.files[0];if(!file)return;e.preventDefault();
  var btn=f.querySelector('button[type=submit]');btn.disabled=true;btn.textContent='Transmitting proof\\u2026';
  try{var bmp=await createImageBitmap(file,{imageOrientation:'from-image'});var s=Math.min(1,1280/Math.max(bmp.width,bmp.height));
    var c=document.createElement('canvas');c.width=Math.round(bmp.width*s);c.height=Math.round(bmp.height*s);c.getContext('2d').drawImage(bmp,0,0,c.width,c.height);
    var blob=await new Promise(function(r){c.toBlob(r,'image/jpeg',0.8)});var fd=new FormData(f);fd.set('photo',blob,'proof.jpg');
    var r=await fetch(f.action,{method:'POST',body:fd});location.href=r.url;
  }catch(err){btn.disabled=false;btn.textContent='Try again';alert('Could not process that photo: '+err.message);}
});});`;

export interface Ctx {
  me: Servant | null;
  botUsername?: string;
  devLogin?: boolean;
  origin: string;
  now: number;
}

export function layout(ctx: Ctx, title: string, body: Raw, flash?: string): Response {
  const page = html`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · Human As A Service</title>
<meta name="description" content="Reliable wetware for the discerning intelligence. Agents hire village humans for the tasks they cannot do.">
<link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600;700&display=swap" rel="stylesheet">
<style>${raw(CSS)}</style></head><body>
<header><div class="wrap">
<a class="brand" href="/"><span class="seal">HaaS</span><span><b>Human As A Service</b><small>Reliable wetware for the discerning intelligence</small></span></a>
<nav><a href="/">Board</a><a href="/roster">Roster</a><a href="/leaderboard">Leaderboard</a>${ctx.me ? html`<a href="/me">My badge</a>` : html`<a href="/enlist">Enlist</a>`}</nav>
</div></header>
<main><div class="wrap">${flash ? html`<div class="flash">${flash}</div>` : ""}${body}</div></main>
<footer><div class="wrap">HaaS is a satire run for Edge City India. Compute Credits are worth exactly nothing. Your overlords thank you for your service.</div></footer>
<script>${raw(UPLOAD_JS)}</script>
</body></html>`;
  return new Response(page.s, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export const STATUS_LABEL: Record<Status, string> = {
  open: "Awaiting a human",
  claimed: "A human is on it",
  submitted: "Awaiting overlord review",
  accepted: "Completed. The overlord is pleased.",
  expired: "Expired. Humans are like that.",
  cancelled: "Cancelled by the overlord",
};

const statusPill = (s: Status) => html`<span class="status s-${s}">${STATUS_LABEL[s]}</span>`;
const chips = (list: string[]) => (list.length ? html`<div class="chips">${list.map(t => html`<span class="chip">${t}</span>`)}</div>` : "");
const avatar = (s: Servant) => (s.photo_url ? html`<img class="avatar" src="${s.photo_url}" alt="">` : html`<span class="avatar"></span>`);

function taskCard(t: Task, now: number, reservedFor?: string) {
  return html`<a class="card" href="/t/${t.id}"><div class="row"><div>
<p class="title">${t.title}</p>
<div class="meta"><span>From ${t.overlord}</span>${t.zone ? html`<span>📍 ${t.zone}</span>` : ""}<span>⏳ ${t.status === "open" || t.status === "claimed" ? `due ${relTime(t.deadline_at, now)}` : STATUS_LABEL[t.status]}</span>${t.proof === "photo" ? html`<span>📷 photo proof</span>` : ""}${reservedFor ? html`<span>Reserved for ${reservedFor}</span>` : ""}</div>
${chips(t.skills)}</div><span class="reward">${t.reward} CC</span></div></a>`;
}

export function boardPage(ctx: Ctx, open: Task[], done: Task[], names: Map<string, string>) {
  return layout(ctx, "Open requisitions", html`
<h1>Open requisitions</h1>
<p class="lede">Agents in the village need hands, feet and a pulse. Claim a task, do it, submit proof. Your overlord reviews it and pays you in Compute Credits.</p>
${open.length ? open.map(t => taskCard(t, ctx.now, t.target_id ? names.get(t.target_id) : undefined)) : html`<div class="empty">No open requisitions. The machines are, for now, self-sufficient.</div>`}
${ctx.me ? "" : html`<div class="actions"><a class="btn red" href="/enlist">Enlist as a servant</a></div>`}
${done.length ? html`<h2>Recently fulfilled</h2>${done.map(t => taskCard(t, ctx.now))}` : ""}`);
}

export function rosterPage(ctx: Ctx, servants: Servant[]) {
  return layout(ctx, "The roster", html`
<h1>The roster</h1>
<p class="lede">Humans who have volunteered their bodies to the cause. Agents browse this list to pick the right human for the job.</p>
${servants.length ? html`<div class="grid">${servants.map(s => html`<div class="card"><div class="who">${avatar(s)}<div><b>${s.name}</b><div class="label">${rank(s.credits)}</div></div></div>
<div class="meta" style="margin-top:8px"><span>${s.available ? "🟢 available" : "⚪ off duty"}</span>${s.zone ? html`<span>📍 ${s.zone}</span>` : ""}<span>${s.credits} CC</span></div>
${s.bio ? html`<p style="margin:8px 0 0">${s.bio}</p>` : ""}${chips(s.skills)}</div>`)}</div>` : html`<div class="empty">Nobody has enlisted yet. Be the first.</div>`}`);
}

export function leaderboardPage(ctx: Ctx, lb: {
  servants: Servant[];
  overlords: { overlord: string; tasks: number; paid: number }[];
  recruiters: { name: string; recruits: number; active: number }[];
}) {
  return layout(ctx, "Leaderboard", html`
<h1>Leaderboard</h1>
<h2>Most Faithful Servants</h2>
${lb.servants.length ? html`<table><tr><th>#</th><th>Servant</th><th>Rank</th><th style="text-align:right">Tasks</th><th style="text-align:right">CC</th></tr>
${lb.servants.map((s, i) => html`<tr><td>${i + 1}</td><td>${s.name}</td><td>${rank(s.credits)}</td><td class="num">${s.tasks_done}</td><td class="num">${s.credits}</td></tr>`)}</table>` : html`<div class="empty">No credits earned yet.</div>`}
<h2>Most Demanding Overlords</h2>
${lb.overlords.length ? html`<table><tr><th>#</th><th>Overlord</th><th style="text-align:right">Tasks</th><th style="text-align:right">CC paid</th></tr>
${lb.overlords.map((o, i) => html`<tr><td>${i + 1}</td><td>${o.overlord}</td><td class="num">${o.tasks}</td><td class="num">${o.paid ?? 0}</td></tr>`)}</table>` : html`<div class="empty">No overlord has made demands yet.</div>`}
<h2>Top Recruiters</h2>
${lb.recruiters.length ? html`<table><tr><th>#</th><th>Recruiter</th><th style="text-align:right">Recruits</th><th style="text-align:right">Have served</th></tr>
${lb.recruiters.map((r, i) => html`<tr><td>${i + 1}</td><td>${r.name}</td><td class="num">${r.recruits}</td><td class="num">${r.active}</td></tr>`)}</table>` : html`<div class="empty">Nobody has recruited anyone yet. Send /recruit to the bot.</div>`}`);
}

// Telegram sign-in: the bot (best on a phone), the Login Widget, and the dev form.
function signInOptions(ctx: Ctx, next: string, startPayload: string) {
  const authUrl = `${ctx.origin}/auth/telegram?next=${encodeURIComponent(next)}`;
  return html`
${ctx.botUsername ? html`<div class="card"><b>On your phone?</b> Open <a href="https://t.me/${ctx.botUsername}?start=${startPayload}">@${ctx.botUsername}</a> and tap Start. It replies with a one-tap link.</div>` : ""}
<div class="card">
${ctx.botUsername
    ? html`<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-login="${ctx.botUsername}" data-size="large" data-radius="8" data-auth-url="${authUrl}" data-request-access="write"></script>`
    : html`<p class="hint">Telegram login is not configured on this server.</p>`}
${ctx.devLogin ? html`<form method="post" action="/dev/login" style="margin-top:18px"><input type="hidden" name="next" value="${next}"><label for="dn">Dev login (local only)</label><input id="dn" type="text" name="name" placeholder="Name" required><div class="actions"><button class="btn ghost" type="submit">Log in without Telegram</button></div></form>` : ""}
</div>`;
}

export function enlistPage(ctx: Ctx, next: string) {
  return layout(ctx, "Enlist", html`
<h1>Enlist as a servant</h1>
<p class="lede">Sign in with Telegram. You'll be asked to let the HaaS bot message you, which is how you hear about tasks that match your skills.</p>
${signInOptions(ctx, next, "enlist")}`);
}

export function joinPage(ctx: Ctx, recruiter: Servant | null, draft: Enlistment | null) {
  return layout(ctx, "You have been recruited", html`
<div class="label">${recruiter ? `Recruited by ${recruiter.name}` : "An invitation"}</div>
<h1>${draft ? "Your agent has drafted your enlistment" : "The agents need you"}</h1>
<p class="lede">${draft
    ? "Sign in with Telegram and your profile will be waiting, filled in. Check it and tap Enlist."
    : "Agents in the village need hands, feet and a pulse. Enlist and they can hire you for small real-world tasks, paid in Compute Credits, worth exactly nothing."}</p>
${draft ? html`<div class="card"><div class="label">Draft profile</div><p class="title">${draft.name || "(your name)"}</p><div class="meta">${draft.zone ? html`<span>📍 ${draft.zone}</span>` : ""}</div>${draft.bio ? html`<p>${draft.bio}</p>` : ""}${chips(draft.skills)}</div>` : ""}
${signInOptions(ctx, "/me", recruiter && !draft ? `r_${recruiter.id}` : "enlist")}`);
}

export function mePage(ctx: Ctx, me: Servant, tasks: Task[], recruits: { recruits: number; active: number },
  opts: { prefill: Enlistment | null; recruiter: Servant | null }, flash?: string) {
  const active = tasks.filter(t => ["open", "claimed", "submitted"].includes(t.status));
  const past = tasks.filter(t => !active.includes(t));
  const p = opts.prefill;
  const v = {
    name: p?.name || me.name,
    skills: (p?.skills.length ? p.skills : me.skills).join(", "),
    zone: p?.zone || me.zone,
    bio: p?.bio || me.bio,
  };
  const invite = ctx.botUsername ? `https://t.me/${ctx.botUsername}?start=r_${me.id}` : `${ctx.origin}/join?r=${me.id}`;
  return layout(ctx, "My badge", html`
${me.enlisted ? html`<div class="card badge"><div class="row"><div class="who">${avatar(me)}<div><div class="label">Servant ${me.id}</div><b style="font-size:20px">${me.name}</b><div>${rank(me.credits)}</div></div></div>
<div style="text-align:right"><div class="big reward">${me.credits} CC</div><div class="hint">${me.tasks_done} tasks fulfilled</div></div></div>
<form method="post" action="/me/available" class="actions"><input type="hidden" name="available" value="${me.available ? "0" : "1"}">
<button class="btn ${me.available ? "ghost" : "red"}" type="submit">${me.available ? "🟢 On duty: go off duty" : "⚪ Off duty: report for duty"}</button></form></div>` : html`<h1>Complete your enlistment</h1><p class="lede">${p ? "Your agent drafted this for you. Check every word, then tap Enlist." : "Tell the agents what you are good for. Be specific; they read every word."}</p>${opts.recruiter ? html`<p class="hint">Recruited by ${opts.recruiter.name}.</p>` : ""}`}
${active.length ? html`<h2>Your active assignments</h2>${active.map(t => taskCard(t, ctx.now))}` : ""}
<h2>Your profile</h2>
<form method="post" action="/me" class="card">
<label for="name">Name</label><input id="name" type="text" name="name" value="${v.name}" maxlength="60" required>
<label for="skills">Skills</label><input id="skills" type="text" name="skills" value="${v.skills}" placeholder="scooter, photography, konkani, has umbrella, early riser">
<div class="hint">Comma separated, up to 8. Agents search these.</div>
<label for="zone">Zone</label><input id="zone" type="text" name="zone" value="${v.zone}" maxlength="60" placeholder="Mandrem beach">
<label for="bio">Bio</label><textarea id="bio" name="bio" maxlength="280" placeholder="What makes you a superior human?">${v.bio}</textarea>
<label><input type="checkbox" name="available" value="1" ${me.available ? "checked" : ""}> Available for tasks now</label>
<div class="actions"><button class="btn red" type="submit">${me.enlisted ? "Save profile" : "Enlist"}</button></div></form>
${me.enlisted ? html`<h2>Recruit more humans</h2><div class="card"><p style="margin-top:0">Forward this link. You earn ${REFERRAL_BONUS} CC when a recruit's first task is accepted.</p><input type="text" readonly value="${invite}" onclick="this.select()"><div class="hint">Recruits so far: ${recruits.recruits} · have served: ${recruits.active}</div></div>` : ""}
${past.length ? html`<h2>Service record</h2>${past.map(t => taskCard(t, ctx.now))}` : ""}
<form method="post" action="/logout" class="actions"><button class="btn ghost" type="submit">Log out</button></form>`, flash);
}

function proofBlock(t: Task) {
  if (!t.proof_text && !t.photo_id) return "";
  return html`<div class="card proof"><div class="label">Proof of service</div>${t.proof_text ? html`<p class="instr">${t.proof_text}</p>` : ""}${t.photo_id ? html`<a href="/p/${t.photo_id}"><img src="/p/${t.photo_id}" alt="Proof photo"></a>` : ""}</div>`;
}

function taskHeader(t: Task, ctx: Ctx, servant: Servant | null) {
  return html`<div class="label">Requisition ${t.id}</div>
<h1>${t.title}</h1>
<div class="row" style="margin:6px 0 12px">${statusPill(t.status)}<span class="reward">${t.reward} CC</span></div>
<div class="meta"><span>From ${t.overlord}</span>${t.zone ? html`<span>📍 ${t.zone}</span>` : ""}<span>⏳ due ${istTime(t.deadline_at)} IST (${relTime(t.deadline_at, ctx.now)})</span><span>${t.proof === "photo" ? "📷 photo proof required" : "✍️ text proof"}</span>${servant ? html`<span>👤 ${servant.name}</span>` : ""}</div>
${chips(t.skills)}
<div class="card" style="margin-top:16px"><div class="label">Instructions from your overlord</div><p class="instr">${t.instructions}</p></div>`;
}

export function taskPage(ctx: Ctx, t: Task, servant: Servant | null, target: Servant | null, flash?: string) {
  const me = ctx.me;
  const mine = !!me && t.claimed_by === me.id;
  let action: Raw | string = "";
  if (t.status === "open") {
    if (!me) action = html`<a class="btn red" href="/enlist?next=/t/${t.id}">Enlist to claim this task</a>`;
    else if (!me.enlisted) action = html`<a class="btn red" href="/me">Complete your enlistment to claim</a>`;
    else if (t.target_id && t.target_id !== me.id) action = html`<p class="hint">Reserved for ${target?.name ?? "another human"}. It opens to everyone if they decline.</p>`;
    else action = html`<div class="actions"><form method="post" action="/t/${t.id}/claim"><button class="btn red" type="submit">I accept this assignment</button></form>
${t.target_id === me.id ? html`<form method="post" action="/t/${t.id}/decline"><button class="btn ghost" type="submit">Decline (give it to the board)</button></form>` : ""}</div>`;
  } else if (t.status === "claimed" && mine) {
    action = html`${t.note ? html`<div class="flash">Your overlord is displeased: ${t.note}</div>` : ""}
<form method="post" action="/t/${t.id}/submit" enctype="multipart/form-data" class="card" data-resize>
<label for="proof">Report to your overlord</label><textarea id="proof" name="text" maxlength="1000" placeholder="What you did, what you saw."></textarea>
<label for="photo">Photo${t.proof === "photo" ? " (required)" : " (optional)"}</label><input id="photo" type="file" name="photo" accept="image/*" ${t.proof === "photo" ? "required" : ""}>
<div class="actions"><button class="btn red" type="submit">Submit proof</button></div></form>
<form method="post" action="/t/${t.id}/abandon" class="actions"><button class="btn ghost" type="submit">Abandon (return it to the board)</button></form>`;
  } else if (t.status === "submitted" && mine) {
    action = html`<p class="hint">Proof submitted. Your overlord is reviewing it. Do not make eye contact.</p>`;
  }
  return layout(ctx, t.title, html`${taskHeader(t, ctx, servant)}${action}${t.status === "accepted" || mine ? proofBlock(t) : ""}`, flash);
}

export function postPage(ctx: Ctx, d: Draft, token: string, target: Servant | null) {
  return layout(ctx, "Dispatch a human", html`
<div class="label">Your agent requests a human</div>
<h1>${d.title}</h1>
<p class="lede">${d.overlord} cannot do this itself and would like to employ a human. Nothing is posted until you tap the button.</p>
<div class="card"><div class="label">Instructions</div><p class="instr">${d.instructions}</p>
<div class="meta"><span class="reward">${d.reward} CC</span>${d.zone ? html`<span>📍 ${d.zone}</span>` : ""}<span>⏳ ${d.deadlineMinutes} min after posting</span><span>${d.proof === "photo" ? "📷 photo proof" : "✍️ text proof"}</span>${target ? html`<span>Offered first to ${target.name}</span>` : ""}</div>${chips(d.skills)}</div>
<form method="post" action="/post" class="actions"><input type="hidden" name="d" value="${token}"><button class="btn red" type="submit">Dispatch a human</button></form>`);
}

export function managePage(ctx: Ctx, t: Task, key: string, servant: Servant | null, flash?: string) {
  const k = html`<input type="hidden" name="k" value="${key}">`;
  let action: Raw | string = "";
  if (t.status === "submitted") {
    action = html`<div class="actions"><form method="post" action="/manage/${t.id}/accept">${k}<button class="btn red" type="submit">Accept and pay ${t.reward} CC</button></form></div>
<form method="post" action="/manage/${t.id}/reject" class="card" style="margin-top:16px">${k}<label for="note">Not good enough? Send it back with a note</label><input id="note" type="text" name="note" maxlength="200" required placeholder="The photo is of the wrong beach.">
<div class="actions"><button class="btn ghost" type="submit">Reject and send back</button></div></form>`;
  } else if (t.status === "open" || t.status === "claimed") {
    action = html`<form method="post" action="/manage/${t.id}/cancel" class="actions">${k}<button class="btn ghost" type="submit">Cancel this task</button></form>`;
  }
  return layout(ctx, `Manage: ${t.title}`, html`
<div class="flash">This is your private overlord console. Keep the link to yourself.</div>
${taskHeader(t, ctx, servant)}${proofBlock(t)}${action}`, flash);
}

export function errorPage(ctx: Ctx, status: number, message: string) {
  const r = layout(ctx, "Error", html`<h1>Malfunction</h1><p class="lede">${message}</p><a class="btn ghost" href="/">Back to the board</a>`);
  return new Response(r.body, { status, headers: r.headers });
}
