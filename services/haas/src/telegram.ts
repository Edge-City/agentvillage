// Telegram Login Widget verification and bot pings to servants.
// https://core.telegram.org/widgets/login#checking-authorization

import { hex, hmac, safeEqual, sha256 } from "./util";

export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
}

const LOGIN_MAX_AGE_S = 24 * 60 * 60;

export async function verifyLogin(params: URLSearchParams, botToken: string, nowS = Date.now() / 1000): Promise<TelegramUser | null> {
  const hash = params.get("hash");
  if (!hash || !botToken) return null;
  const fields = [...params.entries()]
    .filter(([k]) => ["id", "first_name", "last_name", "username", "photo_url", "auth_date"].includes(k))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const expected = hex(await hmac(await sha256(botToken), fields));
  if (!safeEqual(hash, expected)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowS - authDate > LOGIN_MAX_AGE_S) return null;
  const id = Number(params.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return {
    id,
    first_name: params.get("first_name") ?? "",
    last_name: params.get("last_name") ?? undefined,
    username: params.get("username") ?? undefined,
    photo_url: params.get("photo_url") ?? undefined,
  };
}

export const tgEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export type Button = { text: string; url: string };

// "ok", "blocked" (the servant stopped the bot: stop pinging) or "failed".
export async function sendMessage(botToken: string | undefined, chatId: number, text: string, buttons: Button[] = []): Promise<"ok" | "blocked" | "failed"> {
  if (!botToken || chatId <= 0) return "failed";
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true,
        ...(buttons.length ? { reply_markup: { inline_keyboard: buttons.map(b => [b]) } } : {}),
      }),
    });
    return r.ok ? "ok" : r.status === 403 ? "blocked" : "failed";
  } catch {
    return "failed";
  }
}
