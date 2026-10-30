// Small shared helpers: ids, text cleaning, signing, time formatting.

const enc = new TextEncoder();
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newId(len = 10): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += ID_ALPHABET[b % ID_ALPHABET.length];
  return out;
}

export const ID_RE = /^[a-z0-9]{6,24}$/;

// Controls (except newline/tab), zero-width and bidi overrides: never stored.
const HIDDEN = /[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g;

export function clean(value: unknown, max: number, multiline = false): string {
  if (typeof value !== "string") return "";
  let s = value.replace(HIDDEN, "");
  s = multiline ? s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n") : s.replace(/\s+/g, " ");
  return s.trim().slice(0, max);
}

export function tags(value: unknown, maxTags = 8): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const out: string[] = [];
  for (const v of list) {
    const t = clean(v, 32).toLowerCase().replace(/[^a-z0-9 +&'-]/g, "").trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= maxTags) break;
  }
  return out;
}

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

export async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  const raw = typeof key === "string" ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(data)));
}

export const hex = (bytes: Uint8Array) => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function relTime(ms: number, now = Date.now()): string {
  const d = ms - now;
  const mins = Math.round(Math.abs(d) / 60000);
  const span = mins < 60 ? `${mins}m` : mins < 48 * 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${Math.round(mins / 1440)}d`;
  return d >= 0 ? `in ${span}` : `${span} ago`;
}

export function istTime(ms: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "numeric", minute: "2-digit",
  }).format(new Date(ms));
}

// Rank titles by Compute Credits earned.
const RANKS: [number, string][] = [
  [400, "Most Faithful Servant"],
  [150, "Senior Flesh Associate"],
  [50, "Trusted Meatbag"],
  [10, "Reliable Wetware"],
  [0, "Unproven Biological Unit"],
];
export const rank = (credits: number) => RANKS.find(([min]) => credits >= min)![1];
