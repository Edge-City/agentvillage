// D1 access. Every state change is a single guarded UPDATE, so two humans
// racing for the same task cannot both win it.

import type { Draft } from "./tokens";
import { newId, tags } from "./util";

export interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1 {
  prepare(sql: string): D1Statement;
  batch(statements: D1Statement[]): Promise<unknown[]>;
}

export type Status = "open" | "claimed" | "submitted" | "accepted" | "cancelled" | "expired";

export interface Servant {
  id: string;
  tg_id: number;
  tg_username: string | null;
  name: string;
  photo_url: string | null;
  skills: string[];
  zone: string;
  bio: string;
  available: boolean;
  enlisted: boolean;
  can_dm: boolean;
  credits: number;
  tasks_done: number;
  recruited_by: string | null;
  referral_paid: boolean;
}

export interface Task {
  id: string;
  title: string;
  instructions: string;
  skills: string[];
  zone: string;
  reward: number;
  proof: "text" | "photo";
  target_id: string | null;
  overlord: string;
  status: Status;
  claimed_by: string | null;
  proof_text: string | null;
  photo_id: string | null;
  note: string | null;
  posted_at: number;
  deadline_at: number;
  claimed_at: number | null;
  submitted_at: number | null;
  accepted_at: number | null;
}

const parseTags = (s: unknown) => {
  try { return tags(JSON.parse(String(s))); } catch { return []; }
};

function toServant(r: any): Servant {
  return {
    ...r,
    skills: parseTags(r.skills),
    available: !!r.available,
    enlisted: !!r.enlisted,
    can_dm: !!r.can_dm,
    referral_paid: !!r.referral_paid,
  };
}

// open/claimed past the deadline read as expired; nothing sweeps the table.
function toTask(r: any, now = Date.now()): Task {
  const status = (r.status === "open" || r.status === "claimed") && r.deadline_at <= now ? "expired" : r.status;
  return { ...r, skills: parseTags(r.skills), status };
}

export const REFERRAL_BONUS = 5;

export class Store {
  constructor(private db: D1, private now: () => number = Date.now) {}

  // ---- servants ----

  async servant(id: string): Promise<Servant | null> {
    const r = await this.db.prepare("SELECT * FROM servants WHERE id = ?").bind(id).first();
    return r ? toServant(r) : null;
  }

  async servantByTelegram(tgId: number): Promise<Servant | null> {
    const r = await this.db.prepare("SELECT * FROM servants WHERE tg_id = ?").bind(tgId).first();
    return r ? toServant(r) : null;
  }

  async upsertTelegram(u: { tg_id: number; name: string; username: string | null; photo_url: string | null; can_dm: boolean }): Promise<Servant> {
    await this.db.prepare(
      `INSERT INTO servants (id, tg_id, tg_username, name, photo_url, can_dm, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (tg_id) DO UPDATE SET tg_username = excluded.tg_username, photo_url = excluded.photo_url,
         can_dm = MAX(servants.can_dm, excluded.can_dm)`,
    ).bind(newId(), u.tg_id, u.username, u.name, u.photo_url, u.can_dm ? 1 : 0, this.now()).run();
    const r = await this.db.prepare("SELECT * FROM servants WHERE tg_id = ?").bind(u.tg_id).first();
    return toServant(r);
  }

  async saveProfile(id: string, p: { name: string; skills: string[]; zone: string; bio: string; available: boolean }) {
    await this.db.prepare(
      "UPDATE servants SET name = ?, skills = ?, zone = ?, bio = ?, available = ?, enlisted = 1 WHERE id = ?",
    ).bind(p.name, JSON.stringify(p.skills), p.zone, p.bio, p.available ? 1 : 0, id).run();
  }

  async setAvailable(id: string, available: boolean) {
    await this.db.prepare("UPDATE servants SET available = ? WHERE id = ?").bind(available ? 1 : 0, id).run();
  }

  async setCanDm(id: string, canDm: boolean) {
    await this.db.prepare("UPDATE servants SET can_dm = ? WHERE id = ?").bind(canDm ? 1 : 0, id).run();
  }

  // Credit a recruiter: only for someone not yet enlisted, never twice, never yourself.
  async setRecruiter(servantId: string, recruiterId: string): Promise<boolean> {
    const r = await this.db.prepare(
      `UPDATE servants SET recruited_by = ? WHERE id = ? AND id != ? AND enlisted = 0 AND recruited_by IS NULL
         AND EXISTS (SELECT 1 FROM servants WHERE id = ? AND enlisted = 1)`,
    ).bind(recruiterId, servantId, recruiterId, recruiterId).run();
    return r.meta.changes === 1;
  }

  async recruitCounts(recruiterId: string): Promise<{ recruits: number; active: number }> {
    const r = await this.db.prepare(
      "SELECT COUNT(*) AS recruits, COALESCE(SUM(referral_paid), 0) AS active FROM servants WHERE recruited_by = ? AND enlisted = 1",
    ).bind(recruiterId).first<{ recruits: number; active: number }>();
    return { recruits: r?.recruits ?? 0, active: r?.active ?? 0 };
  }

  async roster(f: { name?: string; skill?: string; zone?: string; availableOnly?: boolean; limit?: number } = {}): Promise<Servant[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM servants WHERE enlisted = 1 ORDER BY available DESC, credits DESC, created_at ASC LIMIT 500",
    ).all();
    const skill = f.skill?.toLowerCase().trim();
    const zone = f.zone?.toLowerCase().trim();
    const name = f.name?.toLowerCase().trim();
    return results.map(toServant)
      .filter(s => !name || s.name.toLowerCase().includes(name))
      .filter(s => !f.availableOnly || s.available)
      .filter(s => !skill || s.skills.some(t => t.includes(skill)))
      .filter(s => !zone || s.zone.toLowerCase().includes(zone))
      .slice(0, f.limit ?? 50);
  }

  // Who to ping about a new open task: available, reachable, and matching.
  async matching(task: Task): Promise<Servant[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM servants WHERE enlisted = 1 AND available = 1 AND can_dm = 1",
    ).all();
    return results.map(toServant)
      .filter(s => task.skills.length === 0 || task.skills.some(t => s.skills.includes(t)))
      .filter(s => !task.zone || !s.zone || s.zone.toLowerCase() === task.zone.toLowerCase())
      .slice(0, 20);
  }

  // ---- tasks ----

  async task(id: string): Promise<Task | null> {
    const r = await this.db.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    return r ? toTask(r, this.now()) : null;
  }

  // Idempotent: tapping the same post link twice posts once.
  async post(d: Draft): Promise<{ task: Task; created: boolean }> {
    const now = this.now();
    let target = d.servantId;
    if (target) {
      const s = await this.servant(target);
      if (!s?.enlisted) target = null;
    }
    const res = await this.db.prepare(
      `INSERT OR IGNORE INTO tasks (id, title, instructions, skills, zone, reward, proof, target_id, overlord, status, posted_at, deadline_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
    ).bind(d.id, d.title, d.instructions, JSON.stringify(d.skills), d.zone, d.reward, d.proof, target, d.overlord,
      now, now + d.deadlineMinutes * 60000).run();
    return { task: (await this.task(d.id))!, created: res.meta.changes === 1 };
  }

  async board(): Promise<Task[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'open' AND deadline_at > ? ORDER BY posted_at DESC LIMIT 50",
    ).bind(this.now()).all();
    return results.map(r => toTask(r, this.now()));
  }

  async recentlyDone(limit = 6): Promise<Task[]> {
    const { results } = await this.db.prepare(
      "SELECT * FROM tasks WHERE status = 'accepted' ORDER BY accepted_at DESC LIMIT ?",
    ).bind(limit).all();
    return results.map(r => toTask(r, this.now()));
  }

  async servantTasks(servantId: string): Promise<Task[]> {
    const { results } = await this.db.prepare(
      `SELECT * FROM tasks WHERE claimed_by = ? OR (target_id = ? AND status = 'open')
       ORDER BY COALESCE(accepted_at, submitted_at, claimed_at, posted_at) DESC LIMIT 50`,
    ).bind(servantId, servantId).all();
    return results.map(r => toTask(r, this.now()));
  }

  async claim(taskId: string, servantId: string): Promise<boolean> {
    const now = this.now();
    const r = await this.db.prepare(
      `UPDATE tasks SET status = 'claimed', claimed_by = ?, claimed_at = ?
       WHERE id = ? AND status = 'open' AND deadline_at > ? AND (target_id IS NULL OR target_id = ?)`,
    ).bind(servantId, now, taskId, now, servantId).run();
    return r.meta.changes === 1;
  }

  // A named servant passes: the task goes to the whole board.
  async decline(taskId: string, servantId: string): Promise<boolean> {
    const r = await this.db.prepare(
      "UPDATE tasks SET target_id = NULL WHERE id = ? AND target_id = ? AND status = 'open'",
    ).bind(taskId, servantId).run();
    return r.meta.changes === 1;
  }

  async abandon(taskId: string, servantId: string): Promise<boolean> {
    const r = await this.db.prepare(
      `UPDATE tasks SET status = 'open', claimed_by = NULL, claimed_at = NULL, target_id = NULL, note = NULL
       WHERE id = ? AND claimed_by = ? AND status = 'claimed'`,
    ).bind(taskId, servantId).run();
    return r.meta.changes === 1;
  }

  async submit(taskId: string, servantId: string, text: string, photo: { mime: string; data: Uint8Array } | null): Promise<boolean> {
    const now = this.now();
    const photoId = photo ? newId(16) : null;
    const update = this.db.prepare(
      `UPDATE tasks SET status = 'submitted', proof_text = ?, photo_id = COALESCE(?, photo_id), submitted_at = ?
       WHERE id = ? AND claimed_by = ? AND status = 'claimed' AND deadline_at > ?`,
    ).bind(text, photoId, now, taskId, servantId, now);
    if (!photo) return (await update.run()).meta.changes === 1;
    // The photo row is written only when the update wins (same transaction).
    await this.db.batch([
      update,
      this.db.prepare(
        `INSERT INTO photos (id, task_id, mime, data, created_at)
         SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM tasks WHERE id = ? AND photo_id = ?)`,
      ).bind(photoId, taskId, photo.mime, photo.data, now, taskId, photoId),
    ]);
    const t = await this.task(taskId);
    return t?.status === "submitted" && t.photo_id === photoId;
  }

  // Accepting mints the reward to the servant, and on a recruit's first
  // accepted task, the bonus to whoever recruited them.
  async accept(taskId: string): Promise<{ task: Task; recruiter: Servant | null } | null> {
    const now = this.now();
    const r = await this.db.prepare(
      "UPDATE tasks SET status = 'accepted', accepted_at = ? WHERE id = ? AND status = 'submitted'",
    ).bind(now, taskId).run();
    if (r.meta.changes !== 1) return null;
    const t = (await this.task(taskId))!;
    await this.db.prepare("UPDATE servants SET credits = credits + ?, tasks_done = tasks_done + 1 WHERE id = ?")
      .bind(t.reward, t.claimed_by).run();
    const paid = await this.db.prepare(
      "UPDATE servants SET referral_paid = 1 WHERE id = ? AND referral_paid = 0 AND recruited_by IS NOT NULL",
    ).bind(t.claimed_by).run();
    let recruiter: Servant | null = null;
    if (paid.meta.changes === 1) {
      const recruitee = (await this.servant(t.claimed_by!))!;
      await this.db.prepare("UPDATE servants SET credits = credits + ? WHERE id = ?").bind(REFERRAL_BONUS, recruitee.recruited_by).run();
      recruiter = await this.servant(recruitee.recruited_by!);
    }
    return { task: t, recruiter };
  }

  // Rejected work goes back to the same servant with a note, deadline extended an hour.
  async reject(taskId: string, note: string): Promise<Task | null> {
    const now = this.now();
    const r = await this.db.prepare(
      `UPDATE tasks SET status = 'claimed', note = ?, submitted_at = NULL, deadline_at = MAX(deadline_at, ?)
       WHERE id = ? AND status = 'submitted'`,
    ).bind(note, now + 3600000, taskId).run();
    return r.meta.changes === 1 ? this.task(taskId) : null;
  }

  async cancel(taskId: string): Promise<Task | null> {
    const r = await this.db.prepare(
      "UPDATE tasks SET status = 'cancelled' WHERE id = ? AND status IN ('open', 'claimed')",
    ).bind(taskId).run();
    return r.meta.changes === 1 ? this.task(taskId) : null;
  }

  async photo(id: string): Promise<{ mime: string; data: Uint8Array } | null> {
    const r = await this.db.prepare("SELECT mime, data FROM photos WHERE id = ?").bind(id).first<{ mime: string; data: unknown }>();
    if (!r) return null;
    const d = r.data;
    const data = d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(d as number[]);
    return { mime: r.mime, data };
  }

  // ---- leaderboards ----

  async leaderboard() {
    const servants = (await this.db.prepare(
      "SELECT * FROM servants WHERE enlisted = 1 AND credits > 0 ORDER BY credits DESC, tasks_done DESC LIMIT 10",
    ).all()).results.map(toServant);
    const overlords = (await this.db.prepare(
      `SELECT overlord, COUNT(*) AS tasks, SUM(CASE WHEN status = 'accepted' THEN reward ELSE 0 END) AS paid
       FROM tasks WHERE status != 'cancelled' GROUP BY overlord ORDER BY tasks DESC, paid DESC LIMIT 10`,
    ).all<{ overlord: string; tasks: number; paid: number }>()).results;
    const recruiters = (await this.db.prepare(
      `SELECT r.name AS name, COUNT(s.id) AS recruits, COALESCE(SUM(s.referral_paid), 0) AS active
       FROM servants s JOIN servants r ON r.id = s.recruited_by
       WHERE s.enlisted = 1 GROUP BY r.id ORDER BY active DESC, recruits DESC LIMIT 10`,
    ).all<{ name: string; recruits: number; active: number }>()).results;
    return { servants, overlords, recruiters };
  }
}
