/** Explicit per-job post-event opt-in. This is operator configuration, not an OS security boundary. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { readHolds } from "./job-holds";
import { readJobsStore } from "./message-labels";

export const INDIA_END_MS = Date.parse("2026-11-01T18:30:00Z");
export const POST_VILLAGE_KEYS = ["daily_digest", "opportunity_midday", "opportunity_evening", "negotiation_summary", "pending_alert", "zzz_pairs", "zzz_event_autonomy", "zzz_owner_repeating", "welcome_seed"] as const;
export type PostVillageKey = (typeof POST_VILLAGE_KEYS)[number];
export type PostVillagePolicy = { version: 1; enabled: PostVillageKey[] };
export const postVillagePolicyPath = (home: string) => join(home, "av-events", "post-village-policy.json");
export const isPostVillageKey = (key: unknown): key is PostVillageKey => typeof key === "string" && (POST_VILLAGE_KEYS as readonly string[]).includes(key);

/** JSON.parse alone silently accepts duplicate object keys. Refuse them, including escaped spellings. */
export function parsePostVillagePolicy(raw: string): PostVillagePolicy {
  if (Buffer.byteLength(raw) > 4096) throw new Error("policy-invalid");
  const value: unknown = JSON.parse(raw);
  const tokens = raw.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) ?? [];
  const objects: Set<string>[] = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === "{") objects.push(new Set());
    else if (tokens[i] === "}") objects.pop();
    else if (tokens[i]!.startsWith('"') && tokens[i + 1] === ":") {
      const key = JSON.parse(tokens[i]!);
      const keys = objects.at(-1)!;
      if (keys.has(key)) throw new Error("policy-invalid");
      keys.add(key);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("policy-invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 2 || record.version !== 1 || !Array.isArray(record.enabled)
      || !record.enabled.every(isPostVillageKey) || new Set(record.enabled).size !== record.enabled.length) throw new Error("policy-invalid");
  return { version: 1, enabled: [...record.enabled] };
}

export function readPostVillagePolicy(home: string): { status: "ok"; policy: PostVillagePolicy } | { status: "missing" | "invalid" } {
  let fd: number | undefined;
  try {
    if (lstatSync(join(home, "av-events")).isSymbolicLink()) return { status: "invalid" };
    fd = openSync(postVillagePolicyPath(home), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const meta = fstatSync(fd);
    if (!meta.isFile() || meta.size > 4096) return { status: "invalid" };
    const bytes = Buffer.alloc(4097);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count));
    return { status: "ok", policy: parsePostVillagePolicy(raw) };
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function postVillageAllowed(home: string, key: PostVillageKey, now: Date = new Date()): boolean {
  if (!isPostVillageKey(key) || !Number.isFinite(now.getTime())) return false;
  if (now.getTime() < INDIA_END_MS) return true;
  const read = readPostVillagePolicy(home);
  return read.status === "ok" && read.policy.enabled.includes(key);
}

export const POST_VILLAGE_JOB_NAMES: Partial<Record<PostVillageKey, readonly string[]>> = {
  daily_digest: ["Edge — daily digest", "Edge — digest prepare", "Edge — template: brief", "Edge — template: digest-preview"],
  opportunity_midday: ["Edge — opportunity drop (midday)"], opportunity_evening: ["Edge — opportunity drop (evening)"],
  negotiation_summary: ["Edge — negotiation summary"], pending_alert: ["Edge — pending opportunity"],
  zzz_pairs: ["Edge — zzz pairs"], zzz_event_autonomy: ["Edge — zzz event autonomy"],
};
export function postVillageKeyForAction(action: string): PostVillageKey | null {
  return ({ prefetch: "daily_digest", brief: "daily_digest", "tpl-brief": "daily_digest", "tpl-digest-preview": "daily_digest", "drop-midday": "opportunity_midday", "drop-evening": "opportunity_evening", negotiation: "negotiation_summary", pending: "pending_alert" } as Record<string, PostVillageKey>)[action] ?? null;
}
export function postVillageKeyForJob(name: string): PostVillageKey | null {
  return POST_VILLAGE_KEYS.find((key) => POST_VILLAGE_JOB_NAMES[key]?.includes(name)) ?? null;
}

/** A policy allow never overrides resident/admin holds. Direct calls use the same recognized job IDs. */
export function postVillageRuntimeAllowed(home: string, key: PostVillageKey, now: Date = new Date()): boolean {
  if (!postVillageAllowed(home, key, now)) return false;
  const holds = readHolds(home);
  if (holds.status !== "ok") return false;
  const store = readJobsStore(home);
  if ("unreadable" in store) return false;
  const names = POST_VILLAGE_JOB_NAMES[key] ?? [];
  return !store.jobs.some((job) => job && typeof job === "object" && !Array.isArray(job)
    && typeof (job as Record<string, unknown>).name === "string"
    && names.includes((job as Record<string, unknown>).name as string)
    && typeof (job as Record<string, unknown>).id === "string"
    && holds.holds.get((job as Record<string, unknown>).id as string)?.state === "paused");
}
