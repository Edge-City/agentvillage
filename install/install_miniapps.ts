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
  { id: "fourkicks", version: "1.0.0", operations: ["fourkicks.menu", "fourkicks.schedule", "fourkicks.order.prepare", "fourkicks.order.confirm", "fourkicks.order.status", "fourkicks.order.cancel"], skills: ["fourkicks"] },
] as const;
/**
 * Earlier gold-stars entries, still staged byte for byte so this overlay can roll out BEFORE the CP
 * catalog moves (overlay first, then the catalog with a re-stage; never the reverse): the restored
 * eight-op entry (ov#350, _mini_apps.py GOLD_STARS_RESTORED; the CP's current entry, rolodex.person
 * refused under it) and the six-op entry before the restore (ov#343, GOLD_STARS_PREVIOUS; no meeting,
 * Skylight or person operation), and dizko's public read alone (NEW-03: the CP's entry until it
 * projects the context operations). Remove each after the CP catalog serves a newer list everywhere.
 */
export const PREVIOUS_REVIEWED_MINI_APPS = [
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status"], skills: ["gold-stars"] },
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel"], skills: ["gold-stars"] },
  { id: "dizko", version: "1.0.0", operations: ["mini-app.read"], skills: ["dizko"] },
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
export function reconcileMiniApps(value: unknown, home = hermesHome(), source = resolve(import.meta.dir, "../skills"), verify = false) {
  const projection = validateProjection(value);
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
    const path = join(source, app.id, "SKILL.md");
    regular(path);
    const content = readFileSync(path);
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
  return { version: 1, projectionSha256: hash(bytes), files, apps: projection.apps.map(({ id, version }) => ({ id, version })), staged: true };
}
if (import.meta.main) {
  try {
    if (process.argv.slice(2).some(x => x !== "--verify")) throw new Error("mini_apps_invalid_argument");
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > 16384) throw new Error("mini_apps_projection_too_large");
    console.log(JSON.stringify(reconcileMiniApps(JSON.parse(input), hermesHome(), undefined, process.argv.includes("--verify"))));
  } catch {
    console.error(JSON.stringify({ error: "mini_apps_reconcile_failed" }));
    process.exitCode = 1;
  }
}
