// Signed tokens. Nothing an agent drafts is stored until its owner taps the
// post link, so the draft itself travels in the link, HMAC-signed.

import { b64url, hmac, safeEqual, unb64url } from "./util";

export interface Draft {
  v: 1;
  id: string;
  title: string;
  instructions: string;
  skills: string[];
  zone: string;
  deadlineMinutes: number;
  reward: number;
  proof: "text" | "photo";
  servantId: string | null;
  overlord: string;
  iat: number;
}

export const DRAFT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const sign = async (secret: string, purpose: string, body: string) =>
  b64url(await hmac(secret, `${purpose}:${body}`));

export async function signDraft(secret: string, draft: Draft): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(draft)));
  return `${body}.${await sign(secret, "draft", body)}`;
}

export async function verifyDraft(secret: string, token: string, now = Date.now()): Promise<Draft | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, await sign(secret, "draft", body))) return null;
  try {
    const draft = JSON.parse(new TextDecoder().decode(unb64url(body))) as Draft;
    if (draft.v !== 1 || now - draft.iat > DRAFT_TTL_MS) return null;
    return draft;
  } catch {
    return null;
  }
}

// A prefilled enlistment the agent drafts for its owner, plus who recruited them.
export interface Enlistment {
  v: 1;
  name: string;
  skills: string[];
  zone: string;
  bio: string;
  ref: string | null;
  iat: number;
}

export const ENLIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export async function signEnlistment(secret: string, e: Enlistment): Promise<string> {
  const body = b64url(new TextEncoder().encode(JSON.stringify(e)));
  return `${body}.${await sign(secret, "enlist", body)}`;
}

export async function verifyEnlistment(secret: string, token: string, now = Date.now()): Promise<Enlistment | null> {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, await sign(secret, "enlist", body))) return null;
  try {
    const e = JSON.parse(new TextDecoder().decode(unb64url(body))) as Enlistment;
    return e.v === 1 && now - e.iat <= ENLIST_TTL_MS ? e : null;
  } catch {
    return null;
  }
}

// The manage key is derived, not stored: the agent can hand its owner the
// manage link at draft time, before the task exists.
export async function manageKey(secret: string, taskId: string): Promise<string> {
  return (await sign(secret, "manage", taskId)).slice(0, 32);
}

// A one-tap login link the bot sends: proof the tapper is this Telegram user.
export const LOGIN_LINK_TTL_MS = 15 * 60 * 1000;

export async function signLoginLink(secret: string, tgId: number, now = Date.now()): Promise<string> {
  const body = `${tgId}.${now + LOGIN_LINK_TTL_MS}`;
  return `${body}.${await sign(secret, "login", body)}`;
}

export async function verifyLoginLink(secret: string, token: string, now = Date.now()): Promise<number | null> {
  const [id, exp, sig, extra] = token.split(".");
  if (!id || !exp || !sig || extra !== undefined) return null;
  if (!safeEqual(sig, await sign(secret, "login", `${id}.${exp}`))) return null;
  const tgId = Number(id);
  return Number(exp) > now && Number.isSafeInteger(tgId) && tgId > 0 ? tgId : null;
}

export async function sessionValue(secret: string, servantId: string): Promise<string> {
  return `${servantId}.${await sign(secret, "session", servantId)}`;
}

export async function verifySession(secret: string, value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const [id, sig] = value.split(".");
  if (!id || !sig) return null;
  return safeEqual(sig, await sign(secret, "session", id)) ? id : null;
}
