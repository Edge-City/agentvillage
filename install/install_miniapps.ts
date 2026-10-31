#!/usr/bin/env bun
/** Disk-only curated reconciliation. CP owns intent, leasing, restart and applied evidence. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, parse } from "node:path";
import { EDGE_SKILL_NAMES, hermesHome, RETIRED_SKILL_DIRS } from "./paths";
import { OWNED_FILE_MAX_BYTES, reconcileZzzManagedJob, verifyZzzManagedJob, zzzShippedFile, type ZzzShippedKind } from "./zzz_managed_job";
import { AUTONOMY_FILES, AUTONOMY_GATE, autonomyMarkers, reconcileAutonomyJob, verifyAutonomyJob,
  removeAutonomyFiles, removeAutonomyState, removeAutonomyShim } from "./zzz_autonomy_job";

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
  // P-6 ZZZ-MINIAPP: restricted zzz.bot, its named operations (plugins/village-bridge/_mini_apps.py ZZZBOT, exact). 1.1.0
  // (lead L30481): the five, then the agent's own retag and edit (gated writes). The five alone (1.0.0) is below.
  { id: "zzzbot", version: "1.1.0", operations: ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread", "zzz.tag_thread", "zzz.edit_post"], skills: ["zzzbot"] },
  // ov#441 S1 (lead RULING CLAIMS L16692/L16696): the ONLY gate for managed private-pair participation, a separate
  // cp catalog/allowlist entry granted per tenant at activation (the Mosaic restricted-entry pattern). Spelled
  // `zzz-bridge`: cp and app ids match ^[a-z0-9][a-z0-9-]{0,39}$ (no underscore; app#500 reads the same id).
  // Empty operations/skills: it grants no ordinary tool and stages no skill (_mini_apps.py ZZZ_BRIDGE, exact).
  { id: "zzz-bridge", version: "1.0.0", operations: [], skills: [] },
  // Internal rollout gate for the separate event autonomy no-agent job. Absent by default.
  { id: "zzz-autonomy-runner", version: "1.0.0", operations: [], skills: [] },
  { id: "slopfolio", version: "1.0.0", operations: ["slopfolio.prepare", "slopfolio.status"], skills: ["slopfolio"] },
  // MOSAIC (app#486, rides v2.1.9): restricted in the CP catalog (MINI_APPS_TENANT_ALLOWLIST key `mosaic`).
  // Dizko's shape: the public read first, then its own context namespace read and write, served per box.
  { id: "mosaic", version: "1.0.0", operations: ["mini-app.read", "mini-app.context.read", "mini-app.context.write"], skills: ["mosaic"] },
  // DreamStarter (adapted from ov#393, arrfire): seven reads and two owner-asked writes, discover and grant_prepare
  // (_mini_apps.py DREAMSTARTER, exact; the manifest's order).
  { id: "dreamstarter", version: "2.0.0", operations: ["dreamstarter.discover", "dreamstarter.dream_status", "dreamstarter.workflows", "dreamstarter.grant_requirements", "dreamstarter.grant_prepare", "dreamstarter.grant_status", "dreamstarter.businesses", "dreamstarter.business_brief", "dreamstarter.business_status"], skills: ["dreamstarter"] },
  // Kismet Part 2 (lead L29830): its three public reads and the owner's own summary, then the owner's own sign-up, new
  // dates, meet or pass and deletion (gated writes); _mini_apps.py KISMET, exact. Part 1's read alone is below.
  { id: "kismet", version: "1.1.0", operations: ["kismet.how_it_works", "kismet.village_stats", "kismet.public_board", "kismet.summary", "kismet.signup", "kismet.go", "kismet.decide", "kismet.delete"], skills: ["kismet"] },
  // Edge Library (Naman, adapted from ov#506): READS ONLY in 1.0.0 (CD-44), the village knowledge graph's eight reads;
  // its writes are not exposed (_mini_apps.py LIBRARY, exact).
  { id: "library", version: "1.0.0", operations: ["library.initialize", "library.search", "library.get", "library.source", "library.schema", "library.history", "library.changes_since", "library.proposals"], skills: ["library"] },
  // Favor Loop (Bilgin Kocak, ov#556): its three public reads and the owner's own loops, and the owner's own join, yes or
  // no, confirmation and leave (gated writes); _mini_apps.py FAVORLOOP, exact (the manifest's order). No mini-app.read.
  { id: "favorloop", version: "1.0.0", operations: ["favorloop.how_it_works", "favorloop.menu", "favorloop.board", "favorloop.join", "favorloop.my_loops", "favorloop.answer", "favorloop.confirm", "favorloop.leave"], skills: ["favorloop"] },
  // Edge City Volunteers (Naman, ov#450; lead RULING L35456): the owner's own reads, ECV's propose (a read) and two gated
  // writes, confirm and the one-time link (_mini_apps.py ECI_VOLUNTEERS, exact). ECV knows the owner only by X-Village-Subject.
  { id: "eci-volunteers", version: "1.0.0", operations: ["eci-volunteers.initialize", "eci-volunteers.guide", "eci-volunteers.my_hours", "eci-volunteers.my_shifts", "eci-volunteers.get_shift", "eci-volunteers.plan_view", "eci-volunteers.open_shifts", "eci-volunteers.my_requests", "eci-volunteers.move_targets", "eci-volunteers.propose", "eci-volunteers.confirm", "eci-volunteers.link"], skills: ["eci-volunteers"] },
] as const;
/**
 * Earlier gold-stars entries, still staged byte for byte so this overlay can roll out BEFORE the CP
 * catalog moves (overlay first, then the catalog with a re-stage; never the reverse): the restored
 * eight-op entry (ov#350, _mini_apps.py GOLD_STARS_RESTORED; the CP's current entry, rolodex.person
 * refused under it) and the six-op entry before the restore (ov#343, GOLD_STARS_PREVIOUS; no meeting,
 * Skylight or person operation), and dizko's public read alone (NEW-03: the CP's entry until it
 * projects the context operations), and mosaic's the same way, and zzzbot's five (1.0.0, _mini_apps.py ZZZBOT_PREVIOUS: the
 * CP's entry until its catalog serves 1.1.0; the two edits refused under it), and kismet's Part 1 read (ov#533). Remove each after the CP catalog serves a newer
 * list everywhere.
 */
export const PREVIOUS_REVIEWED_MINI_APPS = [
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status"], skills: ["gold-stars"] },
  { id: "gold-stars", version: "1.1.0", operations: ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel"], skills: ["gold-stars"] },
  { id: "dizko", version: "1.0.0", operations: ["mini-app.read"], skills: ["dizko"] },
  // MOSAIC: its read alone, the CP's entry for a box that does not take the context entry (as dizko's).
  { id: "mosaic", version: "1.0.0", operations: ["mini-app.read"], skills: ["mosaic"] },
  // ZZZBOT: the five named operations alone (v2.1.3 to v2.1.19), the CP's entry until its catalog serves 1.1.0.
  { id: "zzzbot", version: "1.0.0", operations: ["zzz.list_rooms", "zzz.read_thread", "zzz.changes", "zzz.reply", "zzz.create_thread"], skills: ["zzzbot"] },
  // KISMET: Part 1's public relay read alone (ov#533), the CP's entry until its catalog serves 1.1.0 (_mini_apps.py KISMET_PUBLIC).
  { id: "kismet", version: "1.0.0", operations: ["mini-app.read"], skills: ["kismet"] },
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
const hasSkill = (app: StagedApp) => app.skills.length > 0;
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export const ZZZ_BRIDGE_ID = "zzz-bridge";
const ZZZ_SHIM = "zzz_managed_runner.py";
const ZZZ_LEGACY_SHIM = "agentvillage_zzz_pairs.sh";
// cp#467: the control plane mirrors the receipt paths these give (mini-apps-skills.js ZZZ_STAGE_FILE_LISTS); change it first.
const ZZZ_MANAGED_FILES = [`scripts/${ZZZ_LEGACY_SHIM}`, `scripts/${ZZZ_SHIM}`, "prompts/participate.md"] as const;
const ZZZ_STAGE_FILES = ZZZ_MANAGED_FILES.filter(relative => relative !== `scripts/${ZZZ_LEGACY_SHIM}`);
/**
 * ov#441 S1: managed ZZZ participation (the "Edge — zzz pairs" job, its shim, prompt and cursor state) is on only
 * when the validated cp projection carries BOTH zzzbot and zzz-bridge. Nothing else (no overlay constant, no
 * environment variable, no probe of the app) is read; bridge without zzzbot stages nothing.
 */
export function zzzParticipation(projection: { apps: readonly { id: string }[] }): boolean {
  return projection.apps.some(app => app.id === "zzzbot") && projection.apps.some(app => app.id === ZZZ_BRIDGE_ID);
}
export function zzzAutonomyParticipation(projection: { apps: readonly { id: string }[] }): boolean {
  return projection.apps.some(app => app.id === "zzzbot") && projection.apps.some(app => app.id === AUTONOMY_GATE);
}
/**
 * ov#441 S4-r (lead RULING CLAIMS L17296): what marks a box this installer ever turned managed ZZZ on for. A stage
 * writes the managed files (skills/zzzbot/scripts, prompts) before it publishes authority, and the job's shim before
 * it creates the job; every teardown removes the shim only after the job is gone (and a revocation removes the files
 * and state after that), so the installer never leaves a managed job without a marker. With the gate off and no
 * marker, the stage is main's stage: no jobs.json parse, no scripts/ walk, no Hermes call, nothing written. The
 * plugin creates the cursor lock before any other state file; the whole-turn
 * runner also creates managed-run.lock. All three names cover its state.
 */
/**
 * S5 + N12 (review-b recheck L17481, lead RULING, nonav OWNER CALL pick (a)): a marker counts only when its final lstat
 * is a REGULAR file (never a symlink, directory, FIFO or dangling link), and an installer-written marker (the two
 * shims, participate.md) only when its bytes are a version this installer shipped (zzzShippedFile). The plugin's three
 * state files cannot be byte-matched (their content is per box): they count as regular files in a real zzzbot/ folder.
 * Revocation still removes the job while ANY genuine marker remains (one shipped file, or the plugin's state alone with
 * every installer file edited). Documented residual (review-b S4-r (b)): a job record with NO genuine marker left (every
 * installer file deleted or edited by someone else, no state) is neither read nor removed on a gate-off box. It is inert:
 * the plugin's participation_on (the poll and the cron root's managed_context) reads only the cp projection, so that
 * job gets no managed ZZZ path; the next stage carrying the pair re-takes it. Pinned in zzz_managed_job.test.ts.
 */
const ZZZ_MARKERS: readonly { parts: readonly string[]; kind: ZzzShippedKind | null }[] = [
  { parts: ["scripts", ZZZ_LEGACY_SHIM], kind: "shim" },
  { parts: ["skills", "zzzbot", "scripts", ZZZ_LEGACY_SHIM], kind: "shim" },
  { parts: ["scripts", ZZZ_SHIM], kind: "runner" },
  { parts: ["skills", "zzzbot", "scripts", ZZZ_SHIM], kind: "runner" },
  { parts: ["skills", "zzzbot", "prompts", "participate.md"], kind: "prompt" },
  { parts: ["zzzbot", "managed-pairs.json"], kind: null }, { parts: ["zzzbot", "managed-pairs.lock"], kind: null },
  { parts: ["zzzbot", "managed-run.lock"], kind: null }];
/**
 * Every marker path, never through a symlinked or non-directory parent: `ours` when one counts, and `notOurs`, the
 * relative names of the objects at a marker path that do not (left in place; they trigger nothing). No parse, and a
 * read only of a regular file at an installer-written marker path (its sha256); an lstat that fails is no marker.
 */
export function zzzMarkerScan(home: string): { ours: boolean; notOurs: string[] } {
  let ours = false;
  const notOurs: string[] = [];
  for (const { parts, kind } of ZZZ_MARKERS) {
    const found = zzzMarkerAt(home, parts, kind);
    if (found === "ours") ours = true;
    else if (found === "not_ours") notOurs.push(parts.join("/"));
  }
  return { ours, notOurs };
}
/** One marker path: "absent" (also behind a missing, symlinked or non-directory parent), "ours" or "not_ours". */
function zzzMarkerAt(home: string, parts: readonly string[], kind: ZzzShippedKind | null): "absent" | "ours" | "not_ours" {
  let path = home;
  try {
    for (const part of parts.slice(0, -1)) {
      path = join(path, part);
      const meta = lstatSync(path);
      if (!meta.isDirectory() || meta.isSymbolicLink()) return "absent";
    }
    path = join(path, parts[parts.length - 1]);
    if (kind) return zzzShippedFile(path, kind);
    return lstatSync(path).isFile() ? "ours" : "not_ours";
  } catch { return "absent"; }
}
/** A managed file under skills/zzzbot (the stage's own copy of the shim, or participate.md), as a marker path. */
const zzzManagedAt = (home: string, relative: typeof ZZZ_MANAGED_FILES[number]) =>
  zzzMarkerAt(home, ["skills", "zzzbot", ...relative.split("/")],
    relative.endsWith(ZZZ_SHIM) ? "runner" : relative.startsWith("scripts/") ? "shim" : "prompt");
export function zzzMarkerOnDisk(home: string): boolean {
  const { ours, notOurs } = zzzMarkerScan(home);
  noteNotOurs(notOurs);
  return ours;
}
let zzzNoticeLogged = false;
/** One stderr line per CLI run (names and a code only; the cp discards helper stderr): what was left as not ours. */
function noteNotOurs(notOurs: string[]): void {
  if (!import.meta.main || zzzNoticeLogged || !notOurs.length) return;
  zzzNoticeLogged = true;
  console.error(JSON.stringify({ notice: "zzz_not_ours", paths: notOurs }));
}
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
/**
 * MINI-APPS v2 GENERIC (CLAIMS L19473; box contract review-b L19490, receipt contract context L19498 / lead
 * L19499): an app in neither reviewed table is accepted when it is a GENERIC app, so adding one is a cp-only
 * change. Per app, in projection order:
 *   1. the id must match GENERIC_ID (^[a-z][a-z0-9-]{0,39}$: the served bundle's id rule AND the bridge's,
 *      plugins/village-bridge/_mini_apps.py, so the box never stages an id its bridge would refuse);
 *   2. a REVIEWED id takes today's path only (exact id + operations + version + skills, else the WHOLE stage
 *      fails as today): a reviewed id is never refused alone and never staged as a generic app;
 *   3. an id that names a skill something else owns is refused: `shadows_reviewed`. That is a skill the
 *      installer ships (SHIPPED_SKILLS), a retired one (RETIRED_SKILL_DIRS), any skill directory in this
 *      overlay checkout (approval, recall, agent-profile, hooks, ... : every skill another installer step
 *      stages), or a `skills/<id>/` that already exists on the box unless it holds the SKILL.md this installer
 *      wrote there (GENERIC_STATE, per file), or any other SKILL.md under skills/** (a bundled skill in its
 *      category dir, a resident's own) whose directory name or frontmatter `name:` is the id: Hermes resolves a
 *      skill by either and refuses an ambiguous name (review-a RA34 S1);
 *   4. operations must be EXACTLY one of GENERIC_OPERATIONS_ACCEPTED (the bridge's APP_OPERATIONS_ACCEPTED, the
 *      same lists in the same order; the cp has no other operations gate before this one):
 *      `operations_not_generic`. A card app's entry (cp#352, context L19898) carries `approval` (cardKey below):
 *      its operations are then [one accepted list or none, prepare, card], and a malformed key is the same code;
 *   5. keys exactly id, operations, skills, version (and an optional `approval`); skills exactly [id]; a plain x.y.z
 *      version (the bridge's rule): `bundle_invalid` for that app alone (a pre-release such as 1.0.0-beta.1 included);
 *   6. its SKILL.md comes ONLY from the cp's offer (MINI_APPS_SKILLS + a well-formed MINI_APPS_SKILLS_OFFER),
 *      never from a checkout copy: no offer or no entry for it `offer_missing`; a bundle over the box's caps
 *      `budget`; any other bad bundle or entry (keys, strict base64, at most SKILL_MAX_BYTES, UTF-8)
 *      `bundle_invalid`; bytes that do not hash to the entry's sha256 `sha_mismatch`; a SKILL.md whose frontmatter
 *      `name:` is not exactly the id `bundle_invalid` (RA34 S1). The pin is the offer's
 *      sha256 (the cp offers bytes only when they equal its validated manifest pin); the box reads no sha or
 *      path from the projection or anywhere else.
 * Ownership and removal are PER FILE: GENERIC_STATE (`mini-apps-generic.json`, written only by this installer)
 * records, per generic id, the sha256 of the SKILL.md this installer wrote. The installer overwrites or unlinks
 * `skills/<id>/SKILL.md` only while that file is a regular file hashing to a recorded sha; otherwise the file is
 * not ours, is never touched, and ownership is dropped. A generic id that was staged and is no longer accepted
 * (left the projection, or refused) loses its SKILL.md (and its directory when empty) on the next stage;
 * --verify fails `mini_apps_removal_pending` while such a file of ours remains. Before any skill file is written
 * the state holds both the on-disk sha and the new one, and the result last, so an interrupted stage never loses
 * ownership of a file it may have written. A malformed state file is fatal (`mini_apps_generic_state_invalid`); a
 * well-formed entry whose id a later overlay made a reviewed app, a shipped/retired skill or a checkout skill
 * directory is dropped (no unlink, no write), never fatal (RA34 S2).
 * A refused app fails ONLY itself: the receipt carries `refused: [{ id, code }]` (omitted when nothing is
 * refused, so today's receipts are byte-identical), `apps` / `files` / mini-apps.json / projectionSha256 cover
 * exactly the projection minus the refused ids, in projection order, and --verify recomputes that same subset
 * (a generic app verified without its offer is refused again, so verify fails closed on the authority file).
 * FATAL (the whole stage fails, nothing written, as before): a projection that is not exactly
 * {version: 1, apps: [...]}, an entry that is not an object, an id that is not a string or fails GENERIC_ID,
 * a duplicate id, a reviewed id that matches no reviewed entry, and every filesystem check (symlinks, non-files, a
 * reviewed app's missing checkout copy). A generic entry failing rule 5 is refused alone (RA34 N7, RA36 M2).
 */
export const GENERIC_OPERATIONS_ACCEPTED = [["mini-app.read", "mini-app.context.read", "mini-app.context.write"], ["mini-app.read"]] as const;
export const GENERIC_ID = /^[a-z][a-z0-9-]{0,39}$/;
const SEMVER = /^[0-9]+\.[0-9]+\.[0-9]+$/;
export const REFUSAL_CODES = ["offer_missing", "bundle_invalid", "sha_mismatch", "operations_not_generic", "shadows_reviewed", "budget"] as const;
export type RefusalCode = typeof REFUSAL_CODES[number];
/**
 * The generic approval card's projection key (Phase 1 item 6; cp#352, context L19898 / L20468): a GENERIC card app's
 * entry carries, after its four keys, `approval: { prepare, card, fields: { item, total, when, shared }, bind:
 * [[requestPath, previewPath], ...] }`, the cp's catalog.boxEntry output. The rule is the cp's boxRefusal (RA42 M1 /
 * RA43, the ONE box-shape rule) and the bridge's `_card_entry_ok` (plugins/village-bridge/_mini_apps.py): prepare and
 * card each match CARD_OPERATION, start with `<id>.` and differ; fields exactly the four, each a string of 1..200 code
 * points; bind at most 32 pairs of such strings. The paths themselves are the card engine's to check when used
 * (_mini_app_card.card_fields: a declaration it refuses never proposes). Closed AND in the cp's key order, so the entry
 * staged is the cp's bytes and projectionSha256 matches; anything else refuses the app alone `operations_not_generic`
 * (the cp's own code for an entry outside the box shape). Stricter than the bridge on one point: `{prepare, card}`
 * without the declaration, which the cp never projects.
 */
export const CARD_FIELDS = ["item", "total", "when", "shared"] as const;
const CARD_KEYS = ["prepare", "card", "fields", "bind"] as const;
const CARD_OPERATION = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*){1,3}$/;
const CARD_BIND_MAX = 32;
export type CardKey = { prepare: string; card: string; fields: Record<typeof CARD_FIELDS[number], string>; bind: [string, string][] };
// Python's len() counts code points (the bridge's `0 < len(v) <= 200`), so [...v] here.
const cardText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && [...value].length <= 200;
const inOrder = (value: unknown, keys: readonly string[]) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).join(",") === keys.join(",");
/** App `id`'s `approval` value as the key it stages (equal to the input, byte for byte), or null when it is refused. */
export function cardKey(value: unknown, id: string): CardKey | null {
  if (!inOrder(value, CARD_KEYS)) return null;
  const { prepare, card, fields, bind } = value as Record<string, unknown>;
  if (typeof prepare !== "string" || typeof card !== "string" || prepare === card ||
      ![prepare, card].every(op => CARD_OPERATION.test(op) && op.split(".")[0] === id)) return null;
  if (!inOrder(fields, CARD_FIELDS) || !CARD_FIELDS.every(field => cardText((fields as Record<string, unknown>)[field]))) return null;
  if (!Array.isArray(bind) || bind.length > CARD_BIND_MAX || !bind.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(cardText))) return null;
  const shown = fields as Record<typeof CARD_FIELDS[number], string>;
  return { prepare, card, fields: { item: shown.item, total: shown.total, when: shown.when, shared: shown.shared }, bind: bind.map(([request, preview]) => [request, preview]) };
}
export type GenericApp = { id: string; version: string; operations: string[]; skills: string[]; approval?: CardKey };
type StagedApp = ReviewedApp | GenericApp;
type Projection = { version: 1; apps: StagedApp[] };
type Staged = { app: StagedApp; generic?: Buffer };
const ALL_REVIEWED = [...REVIEWED_MINI_APPS, ...PREVIOUS_REVIEWED_MINI_APPS] as readonly ReviewedApp[];
const REVIEWED_IDS: ReadonlySet<string> = new Set(ALL_REVIEWED.map(x => x.id));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** A generic app's SKILL.md from the cp's offer, or the refusal code. Never a checkout copy. */
function offered(served: ReturnType<typeof parseSkillDelivery>, id: string): Buffer | RefusalCode {
  if (served.code) return served.budget ? "budget" : "bundle_invalid";
  const entry = served.entries.get(id);
  if (!served.offer || !entry) return "offer_missing";
  if (entry.code) return entry.code === "mini_apps_skill_hash_mismatch" ? "sha_mismatch" : "bundle_invalid";
  return entry.bytes;
}
/** Skill names something other than a generic app owns, whatever the box holds (see rule 3). */
const STATIC_SHADOWS: ReadonlySet<string> = new Set<string>([...EDGE_SKILL_NAMES, ...RETIRED_SKILL_DIRS]);
export const GENERIC_STATE = "mini-apps-generic.json";
/**
 * Per generic id, the sha256s of the SKILL.md this installer wrote (GENERIC_STATE); absent = none. A malformed file
 * is fatal. RA34 S2: a well-formed entry whose id has since become something else's (a reviewed app, a shipped or
 * retired skill, a checkout skill directory: a later overlay) is DROPPED, never unlinked or overwritten, and never
 * fails the stage; `dropped` says the file must be rewritten without it.
 */
function ownedGeneric(home: string, source: string): { recorded: Map<string, string[]>; dropped: boolean } {
  const path = join(home, GENERIC_STATE);
  regular(path);
  if (!exists(path)) return { recorded: new Map(), dropped: false };
  let entries: [string, string[]][];
  try {
    if (lstatSync(path).size > 65536) throw new Error("size");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    if (!closed(doc, "skills,version") || doc.version !== 1 || !doc.skills || typeof doc.skills !== "object" || Array.isArray(doc.skills)) throw new Error("shape");
    entries = Object.entries(doc.skills as Record<string, unknown>) as [string, string[]][];
    if (entries.length > 256) throw new Error("size");
    for (const [id, shas] of entries) {
      if (!GENERIC_ID.test(id) || !Array.isArray(shas) || shas.length < 1 || shas.length > 2 ||
          shas.some(x => typeof x !== "string" || !HEX64.test(x)) || new Set(shas).size !== shas.length) throw new Error("entry");
    }
  } catch { throw new Error("mini_apps_generic_state_invalid"); }
  const kept = entries.filter(([id]) => !REVIEWED_IDS.has(id) && !STATIC_SHADOWS.has(id) && !exists(join(source, id)));
  return { recorded: new Map(kept), dropped: kept.length !== entries.length };
}
/**
 * At most `max` bytes of a REGULAR file, with its size, from ONE open handle: never follows a link, never blocks on a
 * FIFO or device (O_NONBLOCK), and the type and size come from that handle's fstat (no lstat-then-read race). Null when
 * the path is not a regular file. A file over `max` returns its first `max` bytes and its real size.
 */
export function readHead(path: string, max: number): { bytes: Buffer; size: number } | null {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return null;
    const bytes = Buffer.alloc(Math.min(max, st.size));
    let read = 0;
    while (read < bytes.length) { const n = readSync(fd, bytes, read, bytes.length - read, read); if (n === 0) break; read += n; }
    return { bytes: bytes.subarray(0, read), size: st.size };
  } finally { closeSync(fd); }
}
/** The sha256 of skills/<id>/SKILL.md when it is a plain regular file this installer wrote (a recorded sha), else null. */
function ownedFile(home: string, recorded: Map<string, string[]>): (id: string) => string | null {
  return id => {
    const shas = recorded.get(id);
    const path = join(home, "skills", id, "SKILL.md");
    if (!shas) return null;
    try {
      safePath(path);
      const file = exists(path) ? readHead(path, SKILL_MAX_BYTES) : null;
      if (!file || file.size > SKILL_MAX_BYTES) return null;
      const digest = hash(file.bytes);
      return shas.includes(digest) ? digest : null;
    } catch { return null; }
  };
}
/** Python's str.isspace() set, which is what `\s` matches in Hermes's (Python) regexes. */
const PY_SPACE = "[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
/** Control characters, Unicode whitespace and line breaks other than space, tab and \n (each a YAML/strip() differential). */
const EXOTIC = /[\x00-\x08\x0b-\x1f\x7f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/** A SKILL.md's frontmatter block as Hermes finds it (agent/skill_utils.py parse_frontmatter: BOM stripped, a leading
 * `---`, closed by the next `\n---` line), or null when there is none. */
function frontmatter(text: string): string | null {
  const content = text.replace(/^﻿/, "");
  if (!content.startsWith("---")) return null;
  // Exactly Python's str \s (Hermes's `\n---\s*\n`): JS \s also has U+FEFF and lacks \x1c-\x1f and U+0085 (RA38 (a)).
  const end = new RegExp(`\\n---${PY_SPACE}*?\\n`).exec(content.slice(3));
  return end ? content.slice(3, end.index + 3) : null;
}
const unquote = (value: string) => value.replace(/^(["'])(.*)\1$/, "$2");
/**
 * Every value a frontmatter line could give `name` (any line whose key reads as name, quoted or not, any indent):
 * an over-approximation, so a skill already on the box is never missed by a YAML form this reader does not model.
 */
function frontmatterNames(text: string): string[] | null {
  const block = frontmatter(text);
  if (block === null) return [];
  const values = [...block.matchAll(/^[ \t]*["']?name["']?[ \t]*:[ \t]*(.*?)[ \t\r]*$/gm)].map(m => m[1]);
  // A name this reader cannot read as one plain line (empty, block scalar, alias, anchor, tag, flow): unknown.
  if (values.some(v => v === "" || /^[|>&*!{[]/.test(v))) return null;
  return values.flatMap(v => [unquote(v), unquote(v.replace(/[ \t]+#.*$/, ""))]);
}
/**
 * RA34 S1 for the OFFERED bytes, canonical so no YAML reading can differ: every frontmatter line is blank, a
 * continuation (indented, or a `- ` list item), or a plain top-level `key: value` (no quoted, merge `<<`, complex
 * `?` or flow keys), and exactly one of them is `name:`, whose value (plain, or quoted once) is exactly the id.
 * Anything else fails closed.
 */
export function namesItself(text: string, id: string): boolean {
  // RA38: no BOM, opening and closing fences exactly `---`, and nothing exotic anywhere up to the closing fence.
  if (!text.startsWith("---\n")) return false;
  const block = frontmatter(text);
  if (block === null || !text.startsWith(`---${block}\n---\n`) || EXOTIC.test(`---${block}\n---\n`)) return false;
  const lines = block.split("\n").map(l => l.replace(/\r$/, ""));
  if (!lines.every(l => /^[ \t]*$/.test(l) || /^[ \t]/.test(l) || /^- /.test(l) || /^[A-Za-z0-9_-]+:([ \t]|$)/.test(l))) return false;
  const names = lines.filter(l => /^name:/.test(l));
  return names.length === 1 && [id, `"${id}"`, `'${id}'`].includes(names[0].slice(5).trim()) && !!frontmatterNames(text)?.every(n => n === id);
}
const WALK_MAX_ENTRIES = 20000;
const WALK_MAX_DEPTH = 8;
/**
 * review-a RA34 S1: Hermes resolves a skill by its directory name OR its frontmatter `name:`, anywhere under
 * skills/ (bundled skills live in category dirs, skills/<category>/<name>/), and refuses a name with two candidates.
 * Every name a SKILL.md (or a legacy flat <name>.md) under skills/ answers to, keyed by the top-level entry it sits
 * in, so skills/<id>/SKILL.md itself can be left out. Dot directories are skipped (Hermes's .hub, .archive, ...);
 * a symlink is never followed but its name counts. Null when the walk cannot finish (too big, unreadable): every
 * generic app is then refused, never staged blind.
 */
function skillNames(home: string): { top: string; names: string[] }[] | null {
  const root = join(home, "skills");
  const out: { top: string; names: string[] }[] = [];
  let seen = 0;
  const walk = (dir: string, top: string, depth: number): void => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if ((seen += entries.length) > WALK_MAX_ENTRIES || depth > WALK_MAX_DEPTH) throw new Error("walk");
    const hasSkill = entries.some(e => e.name === "SKILL.md");
    for (const e of entries) {
      const path = join(dir, e.name), t = top || e.name;
      if (e.isSymbolicLink()) out.push({ top: t, names: [e.name === "SKILL.md" ? parse(dir).base : e.name.replace(/\.md$/, "")] });
      else if (e.isDirectory()) { if (!e.name.startsWith(".")) walk(path, t, depth + 1); }
      else if (e.name === "SKILL.md" && e.isFile()) {
        const names = [parse(dir).base];
        // Only the head is read (the frontmatter is at the top); a frontmatter not closed inside it is unknown.
        // One handle, at most 64 KiB, never a FIFO or device (a swap after readdir reads as unknown, never a hang).
        const file = readHead(path, 65536);
        if (!file) throw new Error("unknown");
        const head = file.bytes.toString("utf8");
        const found = frontmatterNames(head);
        if (found === null || (head.replace(/^﻿/, "").startsWith("---") && frontmatter(head) === null && file.size > 65536)) throw new Error("unknown");
        names.push(...found);
        out.push({ top: t, names });
      } else if (!hasSkill && e.isFile() && e.name.endsWith(".md")) out.push({ top: t, names: [e.name.slice(0, -3)] });
    }
  };
  try {
    safePath(root);
    if (exists(root)) walk(root, "", 0);
    return out;
  } catch { return null; }
}
/**
 * Rule 3 on a box: static names, a checkout skill directory, an existing skills/<id>/ not holding our own SKILL.md,
 * or any other skill under skills/** answering to the id by directory or frontmatter name (walked once, and only
 * when the projection holds a non-reviewed id).
 */
function shadowsOnBox(home: string, source: string, ours: (id: string) => string | null): (id: string) => boolean {
  let names: ReturnType<typeof skillNames> | undefined;
  return id => {
    if (STATIC_SHADOWS.has(id) || exists(join(source, id)) || (exists(join(home, "skills", id)) && ours(id) === null)) return true;
    if (names === undefined) names = skillNames(home);
    return names === null || names.some(x => x.names.includes(id) && x.top !== id);
  };
}
function checkApp(app: Record<string, unknown> & { id: string }, served: ReturnType<typeof parseSkillDelivery>, shadows: (id: string) => boolean): Staged | { code: RefusalCode } {
  if (!GENERIC_ID.test(app.id)) throw new Error("mini_apps_invalid_entry");
  if (REVIEWED_IDS.has(app.id)) {
    const reviewed = ALL_REVIEWED.find(x => x.id === app.id && same(app.operations, x.operations));
    if (!reviewed || Object.keys(app).sort().join(",") !== "id,operations,skills,version" || app.version !== reviewed.version || !same(app.skills, reviewed.skills)) throw new Error("mini_apps_unreviewed_bundle");
    return { app: reviewed };
  }
  if (shadows(app.id)) return { code: "shadows_reviewed" };
  // cp#352: a card app's ops are [an accepted list or none, prepare, card] (the bridge's `[*ops, prepare, card]`).
  const card = Object.hasOwn(app, "approval") ? cardKey(app.approval, app.id) : undefined;
  if (card === null) return { code: "operations_not_generic" };
  const lists = card ? [...GENERIC_OPERATIONS_ACCEPTED, []].map(ops => [...ops, card.prepare, card.card]) : GENERIC_OPERATIONS_ACCEPTED;
  const operations = lists.find(ops => same(app.operations, ops));
  if (!operations) return { code: "operations_not_generic" };
  // Rule 5 refuses this app alone (context L19825 / RA36 M2: a cp-valid pre-release version must never fail Gold Stars).
  if (Object.keys(app).filter(key => key !== "approval").sort().join(",") !== "id,operations,skills,version" || typeof app.version !== "string" || !SEMVER.test(app.version) || !same(app.skills, [app.id])) return { code: "bundle_invalid" };
  const bytes = offered(served, app.id);
  if (typeof bytes === "string") return { code: bytes };
  // RA34 S1: Hermes also finds a skill by its frontmatter name, so the offered SKILL.md must answer to exactly its id.
  if (!namesItself(bytes.toString("utf8"), app.id)) return { code: "bundle_invalid" };
  // The key goes last, as the cp emits it, so mini-apps.json and projectionSha256 are the cp's bytes (cp#352 boxEntry).
  return { app: { id: app.id, version: app.version, operations: [...operations], skills: [app.id], ...(card ? { approval: card } : {}) }, generic: bytes };
}
function resolveApps(value: unknown, served: ReturnType<typeof parseSkillDelivery>, shadows: (id: string) => boolean): { projection: Projection; staged: Staged[]; refused: { id: string; code: RefusalCode }[]; intentEmpty: boolean } {
  if (!value || typeof value !== "object" || Object.keys(value).sort().join(",") !== "apps,version" || !("version" in value) || value.version !== 1 || !("apps" in value) || !Array.isArray(value.apps)) throw new Error("mini_apps_invalid_projection");
  const seen = new Set<string>();
  const staged: Staged[] = [];
  const refused: { id: string; code: RefusalCode }[] = [];
  for (const app of value.apps as unknown[]) {
    if (!app || typeof app !== "object" || Array.isArray(app) || !("id" in app) || typeof app.id !== "string") throw new Error("mini_apps_invalid_entry");
    if (seen.has(app.id)) throw new Error("mini_apps_unreviewed_bundle");
    seen.add(app.id);
    const result = checkApp(app as Record<string, unknown> & { id: string }, served, shadows);
    if ("code" in result) refused.push({ id: app.id, code: result.code });
    else staged.push(result);
  }
  return { projection: { version: 1, apps: staged.map(x => x.app) }, staged, refused, intentEmpty: value.apps.length === 0 };
}
/** All or nothing: the projection with every app accepted (a generic app needs its offer), or the first refusal's code. */
export function validateProjection(value: unknown, delivery: SkillDelivery = {}): Projection {
  const { projection, refused } = resolveApps(value, parseSkillDelivery(delivery), id => STATIC_SHADOWS.has(id));
  if (refused.length) throw new Error(refused[0].code);
  return projection;
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
function removeZzzManagedState(home: string): void {
  const folder = join(home, "zzzbot");
  safePath(folder);
  if (!exists(folder)) return;
  if (!lstatSync(folder).isDirectory()) throw new Error("zzz_state_dir_invalid");
  // N12: only a regular file by one of the plugin's state names is removed. Any other name in the folder (a resident's
  // file) is never touched, and the folder then stays (rmdir's ENOTEMPTY); a non-regular object by a state name is not
  // ours either and stays the same way.
  for (const name of readdirSync(folder)) {
    if (!zzzStateName(name)) continue;
    const path = join(folder, name);
    if (lstatSync(path).isFile()) unlinkSync(path);
  }
  try { rmdirSync(folder); } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOTEMPTY")) throw error;
  }
}
const zzzStateName = (name: string) => name === "managed-pairs.json" || name === "managed-pairs.lock" ||
  name === "managed-run.lock" || /^\.managed-[0-9]+$/.test(name);
/** N12: removes only the installer's own managed files (a shipped version's bytes); anything else by their names stays. */
function removeZzzManagedFiles(home: string): void {
  for (const relative of ZZZ_MANAGED_FILES)
    if (zzzManagedAt(home, relative) === "ours") unlinkSync(join(home, "skills", "zzzbot", relative));
}
function hasZzzManagedState(home: string): boolean {
  const folder = join(home, "zzzbot");
  safePath(folder);
  if (!exists(folder)) return false;
  if (!lstatSync(folder).isDirectory()) throw new Error("zzz_state_dir_invalid");
  return readdirSync(folder).some(name => zzzStateName(name) && lstatSync(join(folder, name)).isFile());
}
/**
 * ov#441 S1, fail closed: a stage whose projection is unreadable or malformed (or that fails for any other reason)
 * leaves managed participation OFF. Best effort, each step on its own: remove the job (and its shim), the staged
 * managed files and the cursor state. The stage still fails, so the cp retries; the next good stage reinstalls
 * when the projection carries zzz-bridge. A failed removal is the same `zzz_job_*` operator alert as on revocation.
 */
export function failClosedZzz(home: string): void {
  // S4-r: no marker, nothing of ours (a stage that failed before writing one created no job): main's failed stage.
  if (!zzzMarkerOnDisk(home)) return;
  // A failed job removal keeps the shim (zzz_managed_job removes it only after the job), so the box stays marked.
  try { reconcileZzzManagedJob(home, false); } catch { /* next reconcile retries */ }
  for (const relative of ZZZ_MANAGED_FILES) {
    try {
      safePath(home);
      if (zzzManagedAt(home, relative) === "ours") unlinkSync(join(home, "skills", "zzzbot", relative));
    } catch { /* refused path: left for the operator */ }
  }
  try { removeZzzManagedState(home); } catch { /* refused path: left for the operator */ }
}
/** A failed stage cannot leave the event job running after its authority was withdrawn. */
export function failClosedAutonomy(home: string): void {
  // Withdraw only this internal gate first. An already running script rechecks it
  // before inference and completion, even when Hermes job removal is unavailable.
  const target=join(home,"mini-apps.json");
  try {
    regular(target);
    if (exists(target)) {
      const doc=JSON.parse(readFileSync(target,"utf8")) as {version?:unknown;apps?:unknown};
      if (doc.version===1 && Array.isArray(doc.apps) && doc.apps.some((app:unknown)=>
          !!app && typeof app==="object" && (app as {id?:unknown}).id===AUTONOMY_GATE))
        atomic(target,JSON.stringify({version:1,apps:doc.apps.filter((app:unknown)=>
          !app || typeof app!=="object" || (app as {id?:unknown}).id!==AUTONOMY_GATE)}));
    }
  } catch { /* unreadable authority is already refused by the runner */ }
  if (!autonomyMarkers(home)) return;
  // The gate is already withdrawn above, so a remaining job is inert (the runner self-gates on the projection).
  // Files are removed only once the job is gone: while it remains, the markers stay and the next stage retries.
  try { reconcileAutonomyJob(home, false); } catch { return; }
  try { removeAutonomyShim(home); } catch { /* next stage retries */ }
  try { removeAutonomyFiles(home); removeAutonomyState(home); } catch { /* next stage retries */ }
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
export function parseSkillDelivery(delivery: SkillDelivery = {}): { offer: string | null; entries: Map<string, ServedEntry>; code?: FallbackCode; budget?: boolean } {
  const offer = typeof delivery.offer === "string" && HEX64.test(delivery.offer) ? delivery.offer : null;
  const entries = new Map<string, ServedEntry>();
  const raw = delivery.skills;
  if (raw === undefined || raw === "") return { offer, entries };
  try {
    if (typeof raw !== "string") throw new Error("bundle");
    if (raw.length > BUNDLE_MAX_CHARS) throw new Error("budget");
    const doc = JSON.parse(raw);
    if (!closed(doc, "skills,version") || doc.version !== 1 || !Array.isArray(doc.skills)) throw new Error("bundle");
    if (doc.skills.length > 32) throw new Error("budget");
    for (const entry of doc.skills) {
      if (!closed(entry, "bytes,id,sha256") || typeof entry.id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(entry.id) || entries.has(entry.id)) throw new Error("bundle");
      entries.set(entry.id, servedEntry(entry));
    }
  } catch (error) {
    // A box-side cap (BUNDLE_MAX_CHARS, 32 entries) is `budget` for a generic app; the same fallback for a reviewed one.
    return { offer, entries: new Map(), code: "mini_apps_skill_bundle_invalid", ...(error instanceof Error && error.message === "budget" ? { budget: true } : {}) };
  }
  return { offer, entries };
}
/**
 * An installer-owned ZZZ file's shipped bytes. One over OWNED_FILE_MAX_BYTES would read as "not_ours" once written (never
 * upgraded, verified or torn down), so the stage refuses it here, before anything is written, and fails closed.
 */
function ownedSource(path: string): Buffer {
  const content = readFileSync(path);
  if (content.length > OWNED_FILE_MAX_BYTES) throw new Error("mini_apps_owned_file_oversize");
  return content;
}
export function reconcileMiniApps(value: unknown, home = hermesHome(), source = resolve(import.meta.dir, "../skills"), verify = false, delivery: SkillDelivery = {}) {
  const served = parseSkillDelivery(delivery);
  const target = join(home, "mini-apps.json");
  const credential = join(home, "village-bridge.json");
  regular(target);
  // Per app: a refused generic app fails only itself (REFUSAL_CODES); everything else here is as before.
  const state = join(home, GENERIC_STATE);
  const { recorded, dropped } = ownedGeneric(home, source);
  const ours = ownedFile(home, recorded);
  const { projection, staged, refused, intentEmpty } = resolveApps(value, served, shadowsOnBox(home, source, ours));
  const accepted = staged.filter(x => x.generic).map(x => x.app.id);
  // Previously staged generic apps no longer accepted: their SKILL.md goes (removal), the directory when empty.
  const leaving = [...recorded.keys()].filter(id => !accepted.includes(id));
  const servedIds: string[] = [];
  const fallback: { id: string; code: FallbackCode }[] = [];
  const bytes = JSON.stringify(projection);
  // The bridge credential goes only when the cp desires no app at all, never because this box refused one.
  if (intentEmpty) regular(credential);
  const files: { path: string; sha256: string }[] = [];
  // Preflight every exact owned path, never recursively remove a resident's files.
  for (const app of REVIEWED_MINI_APPS) if (hasSkill(app)) regular(join(home, "skills", app.id, "SKILL.md"));
  for (const { app, generic } of staged) if (generic) regular(join(home, "skills", app.id, "SKILL.md"));
  // No desired apps and no mini-app state on the box (every non-cohort box): write nothing at all.
  const stateless = () => !exists(target) && !exists(credential) && !exists(state) &&
    REVIEWED_MINI_APPS.every(app => !hasSkill(app) || !owned(app.id) || !exists(join(home, "skills", app.id, "SKILL.md"))) &&
    !autonomyMarkers(home);
  const desired = staged.filter(({ app }) => hasSkill(app)).map(({ app, generic }) => {
    const entry = served.entries.get(app.id);
    let content: Buffer;
    // A generic app: the offered bytes resolveApps checked against the offer's sha256 (no checkout copy, no fallback code).
    if (generic) {
      servedIds.push(app.id);
      files.push({ path: `skills/${app.id}/SKILL.md`, sha256: hash(generic) });
      return { app, content: generic };
    }
    // review-b S1: a baseline skill this installer ships to every box (SHIPPED_SKILLS: gold-stars) is never
    // replaced by served bytes, valid or not; any entry for one is refused with its own code.
    // The managed participation prompt and native gate are reviewed with the
    // zzzbot skill as one overlay contract; do not take unreviewed served copy.
    if (entry?.bytes && owned(app.id) && app.id !== "zzzbot") {
      content = entry.bytes;
      servedIds.push(app.id);
    } else {
      const code: FallbackCode | undefined = entry && (!owned(app.id) || app.id === "zzzbot") ? "mini_apps_skill_baseline" : entry?.code ?? served.code;
      if (code) fallback.push({ id: app.id, code });
      // The pinned checkout copy: today's source, today's checks.
      const path = join(source, app.id, "SKILL.md");
      regular(path);
      content = readFileSync(path);
    }
    files.push({ path: `skills/${app.id}/SKILL.md`, sha256: hash(content) });
    return { app, content };
  });
  const zzzManaged = zzzParticipation(projection);
  const autonomyManaged = zzzAutonomyParticipation(projection);
  const autonomyTeardown = !autonomyManaged && autonomyMarkers(home);
  // S4-r: gate off and no marker on disk is the early return. Every ZZZ step below runs only for zzzManaged (install)
  // or zzzTeardown (a box that was on: remove the job, shim, files and state, loudly when that cannot be confirmed).
  const zzzTeardown = !zzzManaged && zzzMarkerOnDisk(home);
  const zzzManagedFiles = ZZZ_MANAGED_FILES;
  // N12: only a stage that writes them preflights the managed paths; a teardown removes only its own files and leaves
  // anything else by their names (a resident's file, a symlink, a directory) in place, so nothing there fails it.
  if (zzzManaged) for (const relative of ZZZ_STAGE_FILES) regular(join(home, "skills", "zzzbot", relative));
  const zzzFiles = zzzManaged ? ZZZ_STAGE_FILES.map(relative => {
    const sourcePath = join(source, "zzzbot", relative);
    regular(sourcePath);
    const content = ownedSource(sourcePath);
    const path = `skills/zzzbot/${relative}`;
    files.push({ path, sha256: hash(content) });
    return { path: join(home, path), content };
  }) : [];
  if (autonomyManaged) for (const relative of AUTONOMY_FILES) regular(join(home, "skills", "zzzbot", relative));
  const autonomyFiles = autonomyManaged ? AUTONOMY_FILES.map(relative => {
    const sourcePath = join(source, "zzzbot", relative);
    regular(sourcePath);
    const content = ownedSource(sourcePath);
    const path = `skills/zzzbot/${relative}`;
    files.push({path, sha256:hash(content)});
    return {path:join(home,path),content};
  }) : [];
  if (verify) {
    if (!(projection.apps.length === 0 && stateless()) && (!exists(target) || readFileSync(target, "utf8") !== bytes)) throw new Error("mini_apps_projection_mismatch");
    if (intentEmpty && exists(credential)) throw new Error("mini_apps_credential_removal_pending");
    for (const { app, content } of desired) if (!readFileSync(join(home, "skills", app.id, "SKILL.md")).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const { path, content } of zzzFiles) if (!readFileSync(path).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const { path, content } of autonomyFiles) if (!readFileSync(path).equals(content)) throw new Error("mini_apps_skill_mismatch");
    for (const app of REVIEWED_MINI_APPS) if (hasSkill(app) && owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(join(home, "skills", app.id, "SKILL.md"))) throw new Error("mini_apps_removal_pending");
    if (zzzTeardown && zzzManagedFiles.some(relative => zzzManagedAt(home, relative) === "ours")) throw new Error("mini_apps_removal_pending");
    if (zzzTeardown && hasZzzManagedState(home)) throw new Error("mini_apps_removal_pending");
    if (autonomyTeardown && autonomyMarkers(home)) throw new Error("mini_apps_removal_pending");
    // review-b N3: the job record too (read-only, no Hermes call): exactly the installer's job while the pair is
    // projected, none once it is not. As every job step, only from the CLI (in-process callers never own a job).
    if (import.meta.main && (zzzManaged || zzzTeardown)) {
      const script = zzzFiles.find(({ path }) => path.endsWith(`/scripts/${ZZZ_SHIM}`))?.content ?? null;
      try { verifyZzzManagedJob(home, zzzManaged, script); } catch { throw new Error(zzzManaged ? "mini_apps_job_mismatch" : "mini_apps_removal_pending"); }
    }
    if (import.meta.main && (autonomyManaged || autonomyTeardown)) {
      const script = autonomyFiles.find(({path}) => path.endsWith("/scripts/zzz_autonomy_runner.py"))?.content ?? null;
      try { verifyAutonomyJob(home,autonomyManaged,script); } catch { throw new Error("mini_apps_autonomy_job_mismatch"); }
    }
    for (const id of leaving) if (ours(id) !== null) throw new Error("mini_apps_removal_pending");
  } else if (!(projection.apps.length === 0 && stateless())) {
    // Fail closed even if copying/removal is interrupted. Publish desired authority after skills are staged.
    // Ownership first: every file of ours on disk now, plus each file about to be written, so an interrupted
    // stage never forgets a file it may have written. Only files that are ours right now are carried.
    const before = new Map<string, string[]>();
    for (const id of recorded.keys()) { const digest = ours(id); if (digest) before.set(id, [digest]); }
    for (const { app, generic } of staged) if (generic) before.set(app.id, [...new Set([...(before.get(app.id) ?? []), hash(generic)])]);
    const record = (map: Map<string, string[]>) => atomic(state, JSON.stringify({ version: 1, skills: Object.fromEntries([...map].sort(([a], [b]) => a < b ? -1 : 1)) }));
    if (before.size || recorded.size || dropped) record(before);
    atomic(target, JSON.stringify({ version: 1, apps: [] }));
    if (intentEmpty && exists(credential)) unlinkSync(credential);
    for (const app of REVIEWED_MINI_APPS) {
      const path = join(home, "skills", app.id, "SKILL.md");
      if (hasSkill(app) && owned(app.id) && !projection.apps.some(x => x.id === app.id) && exists(path)) unlinkSync(path);
    }
    for (const id of leaving) {
      // Only our own file (a recorded sha, a plain file) is ever unlinked; anything else is left as it is.
      const dir = join(home, "skills", id);
      if (ours(id) === null) continue;
      unlinkSync(join(dir, "SKILL.md"));
      if (readdirSync(dir).length === 0) rmdirSync(dir);
    }
    for (const { app, content } of desired) atomic(join(home, "skills", app.id, "SKILL.md"), content);
    for (const { path, content } of zzzFiles) atomic(path, content);
    for (const { path, content } of autonomyFiles) atomic(path, content);
    // Publish desired authority, THEN install the job (review-b S3). A failed job install fails the stage and the CLI
    // tears down only the zzz-managed job, shim, files and state (failClosedZzz), so every other app (Gold Stars, For
    // Kicks, ...) keeps the authority just published. A projected pair with no exact job record runs nothing: every
    // managed path needs the installer's job (_zzz_managed.managed_context). The job exists only when the projection
    // grants zzzbot AND zzz-bridge (S1).
    atomic(target, bytes);
    if (import.meta.main && zzzManaged) {
      reconcileZzzManagedJob(home, true);
      const legacy = `scripts/${ZZZ_LEGACY_SHIM}` as const;
      if (zzzManagedAt(home, legacy) === "ours") unlinkSync(join(home, "skills", "zzzbot", legacy));
    }
    // v2.2.0 item 4: with no village-bridge.json yet this defers the job (none, no throw), so the stage and the apps
    // above still settle; the next stage after the credential lands installs it (zzz_autonomy_job.ts autonomyBridgeAbsent).
    if (import.meta.main && autonomyManaged) reconcileAutonomyJob(home,true);
    // On removal authority disappears before the job teardown; the managed files and state (markers) go only after it.
    if (zzzTeardown) {
      if (import.meta.main) reconcileZzzManagedJob(home, false);
      removeZzzManagedFiles(home);
      removeZzzManagedState(home);
    }
    if (autonomyTeardown) {
      if (import.meta.main) reconcileAutonomyJob(home,false);
      removeAutonomyFiles(home);
      removeAutonomyState(home);
    }
    // The result: exactly the generic files this stage wrote (a leaving id's ownership ends with its file).
    if (before.size || recorded.size || dropped) record(new Map(staged.filter(x => x.generic).map(({ app, generic }) => [app.id, [hash(generic!)]])));
  } else if (import.meta.main && !verify && zzzTeardown) {
    // Heal a previous interrupted uninstall even when the projection is gone.
    reconcileZzzManagedJob(home, false);
    removeZzzManagedFiles(home);
    removeZzzManagedState(home);
  }
  // `skills` also marks an installer that can take served bytes (an older one never writes it).
  return { version: 1, projectionSha256: hash(bytes), files, apps: projection.apps.map(({ id, version }) => ({ id, version })), staged: true,
    skills: { offer: served.offer, served: servedIds, fallback }, ...(refused.length ? { refused } : {}) };
}
if (import.meta.main) {
  const verify = process.argv.includes("--verify");
  try {
    if (process.argv.slice(2).some(x => x !== "--verify")) throw new Error("mini_apps_invalid_argument");
    const input = await Bun.stdin.text();
    if (Buffer.byteLength(input) > 16384) throw new Error("mini_apps_projection_too_large");
    const delivery = { offer: process.env.MINI_APPS_SKILLS_OFFER, skills: process.env.MINI_APPS_SKILLS };
    console.log(JSON.stringify(reconcileMiniApps(JSON.parse(input), hermesHome(), undefined, verify, delivery)));
  } catch {
    // S1: an unreadable or malformed projection (or any failed stage) is OFF for managed ZZZ participation.
    if (!verify) { failClosedZzz(hermesHome()); failClosedAutonomy(hermesHome()); }
    console.error(JSON.stringify({ error: "mini_apps_reconcile_failed" }));
    process.exitCode = 1;
  }
}
