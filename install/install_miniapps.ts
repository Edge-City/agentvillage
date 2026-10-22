#!/usr/bin/env bun
/** Disk-only curated reconciliation. CP owns intent, leasing, restart and applied evidence. */
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { EDGE_SKILL_NAMES, hermesHome } from "./paths";

/**
 * ROLODEX.PERSON (rc42, CLAIMS 7799): the gold-stars entry also carries `rolodex.person` (a read of
 * another resident's public profile), appended LAST after ov#350's `rolodex.meeting` and
 * `skylight.status`. plugins/village-bridge/_mini_apps.py GOLD_STARS carries the same list; the
 * control-plane catalog's gold-stars entry moves to it only after boxes run this overlay, so the CP's
 * projection hash matches the receipt.
 *
 * NEW-03 (rc44, P-013): the dizko entry also carries `mini-app.context.read` and
 * `mini-app.context.write` (the app's own context namespace), after `mini-app.read`.
 * plugins/village-bridge/_mini_apps.py APP_OPERATIONS_ACCEPTED carries the same lists; the CP
 * projects them for dizko only after boxes run this overlay (BOX_DEFERRED_OPERATIONS until then).
 */
export const REVIEWED_MINI_APPS = [
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status", "rolodex.person"], skills: ["gold-stars"] },
  { id: "dizko", version: "1.0.0", operations: ["mini-app.read", "mini-app.context.read", "mini-app.context.write"], skills: ["dizko"] },
  { id: "forkicks", version: "1.0.0", operations: ["forkicks.menu", "forkicks.schedule", "forkicks.order.prepare", "forkicks.order.confirm", "forkicks.order.status", "forkicks.order.cancel"], skills: ["forkicks"] },
  // P-6 ZZZ-MINIAPP: restricted zzz.bot, five named operations (plugins/village-bridge/_mini_apps.py ZZZBOT, exact).
  { id: "zzzbot", version: "1.0.0", operations: ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"], skills: ["zzzbot"] },
  { id: "slopfolio", version: "1.0.0", operations: ["slopfolio.prepare", "slopfolio.status"], skills: ["slopfolio"] },
  { id: "symbient-uncommons", version: "1.0.0", operations: ["mini-app.read"], skills: ["symbient-uncommons"] },
  // MOSAIC (app#486, rides v2.1.9): restricted in the CP catalog (MINI_APPS_TENANT_ALLOWLIST key `mosaic`).
  // Dizko's shape: the public read first, then its own context namespace read and write, served per box.
  { id: "mosaic", version: "1.0.0", operations: ["mini-app.read", "mini-app.context.read", "mini-app.context.write"], skills: ["mosaic"] },
] as const;
/**
 * Earlier gold-stars entries, still staged byte for byte so this overlay can roll out BEFORE the CP
 * catalog moves (overlay first, then the catalog with a re-stage; never the reverse): the restored
 * eight-op entry (ov#350, _mini_apps.py GOLD_STARS_RESTORED; the CP's current entry, rolodex.person
 * refused under it) and the six-op entry before the restore (ov#343, GOLD_STARS_PREVIOUS; no meeting,
 * Skylight or person operation), and dizko's public read alone (NEW-03: the CP's entry until it
 * projects the context operations), and mosaic's the same way. Remove each after the CP catalog serves a newer
 * list everywhere.
 */
export const PREVIOUS_REVIEWED_MINI_APPS = [
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status"], skills: ["gold-stars"] },
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel"], skills: ["gold-stars"] },
  { id: "dizko", version: "1.0.0", operations: ["mini-app.read"], skills: ["dizko"] },
  // MOSAIC: its read alone, the CP's entry for a box that does not take the context entry (as dizko's).
  { id: "mosaic", version: "1.0.0", operations: ["mini-app.read"], skills: ["mosaic"] },
] as const;
type ReviewedApp = typeof REVIEWED_MINI_APPS[number] | typeof PREVIOUS_REVIEWED_MINI_APPS[number];
/**
 * Skills the installer ships to every box (install/paths.ts). The helper may write a desired app's
 * SKILL.md over one (the same source bytes), but never removes one: an app missing from `desired`
 * only loses its native permission (mini-apps.json), never a baseline skill (rc37's helper unlinked
 * the baseline gold-stars SKILL.md; the re-cut for rc41 does not).
 */
export const SHIPPED_SKILLS: ReadonlySet<string> = new Set<string>(EDGE_SKILL_NAMES);
const owned = (id: string) => !SHIPPED_SKILLS.has(id);
type Projection = { version: 1; apps: ReviewedApp[] };
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ENOENT") return false; throw error; }
}
/** Never traverse a symlink, including any parent of HERMES_HOME or the source. */
function safePath(path: string): void {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split("/").filter(Boolean)) {
    current = join(current, part);
    if (exists(current) && lstatSync(current).isSymbolicLink()) throw new Error("mini_apps_symlink_refused");
  }
}
function regular(path: string): void {
  safePath(path);
  if (exists(path) && !lstatSync(path).isFile()) throw new Error("mini_apps_non_file");
}
export function validateProjection(value: unknown): Projection {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "apps,version" || !("version" in value) || value.version !== 1 || !("apps" in value) || !Array.isArray(value.apps)) throw new Error("mini_apps_invalid_projection");
  const seen = new Set<string>();
  const apps = value.apps.map((app: unknown) => {
    if (!app || typeof app !== "object" || !("id" in app) || typeof app.id !== "string" || !("version" in app) || !("operations" in app) || !("skills" in app)) throw new Error("mini_apps_invalid_entry");
    const reviewed = ([...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS] as readonly ReviewedApp[]).find(x => x.id === app.id && JSON.stringify(app.operations) === JSON.stringify(x.operations));
    if (!reviewed || seen.has(app.id) || Object.keys(app).sort().join(",") !== "id,operations,skills,version" || app.version !== reviewed.version || JSON.stringify(app.operations) !== JSON.stringify(reviewed.operations) || JSON.stringify(app.skills) !== JSON.stringify(reviewed.skills)) throw new Error("mini_apps_unreviewed_bundle");
    seen.add(app.id);
    return reviewed;
  });
  return { version: 1, apps };
}
function atomic(path: string, bytes: string | Buffer): void {
  regular(path);
  safePath(dirname(path));
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(path), `.mini-apps-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, bytes, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { if (exists(temporary)) unlinkSync(temporary); }
}
/**
 * MINIAPPS v2 Phase 2, skill delivery (lanes-context/MINIAPPS-V2-SKILL-DELIVERY-design.md): the cp may
 * hand this installer each app's reviewed SKILL.md bytes BESIDE the projection, in two environment
 * variables (an older installer ignores both; the projection on stdin stays byte for byte today's):
 *   MINI_APPS_SKILLS_OFFER  the cp's offer digest (64 hex), echoed in the receipt so the cp can tell an
 *                           offer this box already took (or refused) from a new one; never interpreted;
 *   MINI_APPS_SKILLS        {"version":1,"skills":[{"id","sha256","bytes":<base64>}]}.
 * An app's served bytes are used only when they decode (strict base64, at most SKILL_MAX_BYTES, UTF-8)
 * and hash to the entry's sha256. ANY failure falls back to the pinned checkout copy (today's bytes) for
 * that app alone, with a code in the receipt; a bad bundle falls back for every app. A baseline skill
 * (SHIPPED_SKILLS) always keeps its checkout copy (code mini_apps_skill_baseline when one is offered). A skill problem
 * never fails the stage, so it never takes Gold Stars (or any other app) down. Nothing is fetched: no
 * URL, no path from the cp is ever opened; the target is always skills/<id>/SKILL.md for an id
 * validateProjection accepted.
 */
export const SKILL_MAX_BYTES = 32768;
export const BUNDLE_MAX_CHARS = 98304;
export const SKILL_FALLBACK_CODES = ["mini_apps_skill_bundle_invalid", "mini_apps_skill_invalid_entry", "mini_apps_skill_oversize", "mini_apps_skill_hash_mismatch", "mini_apps_skill_not_utf8", "mini_apps_skill_baseline"] as const;
type FallbackCode = typeof SKILL_FALLBACK_CODES[number];
export type SkillDelivery = { offer?: string; skills?: string };
type ServedEntry = { bytes: Buffer; code?: undefined } | { bytes?: undefined; code: FallbackCode };
const HEX64 = /^[a-f0-9]{64}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const closed = (value: unknown, keys: string) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join(",") === keys;
function servedEntry(entry: { sha256: unknown; bytes: unknown }): ServedEntry {
  if (typeof entry.sha256 !== "string" || !HEX64.test(entry.sha256) || typeof entry.bytes !== "string" || !entry.bytes.length || !BASE64.test(entry.bytes)) return { code: "mini_apps_skill_invalid_entry" };
  const bytes = Buffer.from(entry.bytes, "base64");
  if (bytes.length > SKILL_MAX_BYTES) return { code: "mini_apps_skill_oversize" };
  if (hash(bytes) !== entry.sha256) return { code: "mini_apps_skill_hash_mismatch" };
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { code: "mini_apps_skill_not_utf8" }; }
  return { bytes };
}
export function parseSkillDelivery(delivery: SkillDelivery = {}): { offer: string | null; entries: Map<string, ServedEntry>; code?: FallbackCode } {
  const offer = typeof delivery.offer === "string" && HEX64.test(delivery.offer) ? delivery.offer : null;
  const entries = new Map<string, ServedEntry>();
  const raw = delivery.skills;
  if (raw === undefined || raw === "") return { offer, entries };
  try {
    if (typeof raw !== "string" || raw.length > BUNDLE_MAX_CHARS) throw new Error("bundle");
    const doc = JSON.parse(raw);
    if (!closed(doc, "skills,version") || doc.version !== 1 || !Array.isArray(doc.skills) || doc.skills.length > 32) throw new Error("bundle");
    for (const entry of doc.skills) {
      if (!closed(entry, "bytes,id,sha256") || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.id) || entries.has(entry.id)) throw new Error("bundle");
      entries.set(entry.id, servedEntry(entry));
    }
  } catch { return { offer, entries: new Map(), code: "mini_apps_skill_bundle_invalid" }; }
  return { offer, entries };
}
export function reconcileMiniApps(value: unknown, home = hermesHome(), source = resolve(import.meta.dir, "../skills"), verify = false, delivery: SkillDelivery = {}) {
  const projection = validateProjection(value);
  const served = parseSkillDelivery(delivery);
  const servedIds: string[] = [];
  const fallback: { id: string; code: FallbackCode }[] = [];
  const bytes = JSON.stringify(projection);
  const target = join(home, "mini-apps.json");
  const credential = join(home, "village-bridge.json");
  if (projection.apps.length === 0) regular(credential);
  regular(target);
  const files: { path: string; sha256: string }[] = [];
  // Preflight every exact owned path, never recursively remove a resident's files.
  for (const app of REVIEWED_MINI_APPS) regular(join(home, "skills", app.id, "SKILL.md"));
  // No desired apps and no mini-app state on the box (every non-cohort box): write nothing at all.
  const stateless = () => !exists(target) && !exists(credential) &&
    REVIEWED_MINI_APPS.every(app => !owned(app.id) || !exists(join(home, "skills", app.id, "SKILL.md")));
  const desired = projection.apps.map(app => {
    const entry = served.entries.get(app.id);
    let content: Buffer;
    // review-b S1: a baseline skill this installer ships to every box (SHIPPED_SKILLS: gold-stars) is never
    // replaced by served bytes, valid or not; any entry for one is refused with its own code.
    if (entry?.bytes && owned(app.id)) {
      content = entry.bytes;
      servedIds.push(app.id);
    } else {
      const code: FallbackCode | undefined = entry && !owned(app.id) ? "mini_apps_skill_baseline" : entry?.code ?? served.code;
      if (code) fallback.push({ id: app.id, code });
      // The pinned checkout copy: today's source, today's checks.
      const path = join(source, app.id, "SKILL.md");
      regular(path);
      content = readFileSync(path);
    }
    files.push({ path: `skills/${app.id}/SKILL.md`, sha256: hash(content) });
    return { app, content };
  });
  if (verify) {
    if (!(projection.apps.length === 0 && stateless()) && (!exists(target) || readFileSync(target, "utf8") !== bytes)) throw new Error("mini_apps_projection_mismatch");
    if (projection.apps.length === 0 && exists(credential)) throw new Error("mini_apps_credential_removal_pending");
    for (const { app, content } of desired) if (!readFileSync(join(home, "skills", app.id, "SKILL.md")).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const app of REVIEWED_MINI_APPS) if (owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(join(home, "skills", app.id, "SKILL.md"))) throw new Error("mini_apps_removal_pending");
  } else if (!(projection.apps.length === 0 && stateless())) {
    // Fail closed even if copying/removal is interrupted. Publish desired authority last.
    atomic(target, JSON.stringify({ version: 1, apps: [] }));
    if (projection.apps.length === 0 && exists(credential)) unlinkSync(credential);
    for (const app of REVIEWED_MINI_APPS) {
      const path = join(home, "skills", app.id, "SKILL.md");
      if (owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(path)) unlinkSync(path);
    }
    for (const { app, content } of desired) atomic(join(home, "skills", app.id, "SKILL.md"), content);
    atomic(target, bytes);
  }
  // `skills` also marks an installer that can take served bytes (an older one never writes it).
  return { version: 1, projectionSha256: hash(bytes), files, apps: projection.apps.map(({ id, version }) => ({ id, version })), staged: true,
    skills: { offer: served.offer, served: servedIds, fallback } };
}
if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(x => x !== "--verify")) throw new Error("mini_apps_invalid_argument");
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > 16384) throw new Error("mini_apps_projection_too_large");
    const delivery = { offer: process.env.MINI_APPS_SKILLS_OFFER, skills: process.env.MINI_APPS_SKILLS };
    console.log(JSON.stringify(reconcileMiniApps(JSON.parse(input), hermesHome(), undefined, process.argv.includes("--verify"), delivery)));
  } catch {
    console.error(JSON.stringify({ error: "mini_apps_reconcile_failed" }));
    process.exitCode = 1;
  }
}
