#!/usr/bin/env bun
/**
 * The mini-app merge Action (RULINGS RM-08 as changed 23 Oct: option (b), "our Action merges a mini-app PR
 * when both checks are green (no branch protection)"). .github/workflows/mini-apps-automerge.yml runs this
 * file from main's own tree; it squash-merges an open pull request only when EVERY condition below holds at
 * one pinned head sha, read twice (the second read just before the merge), and the merge call itself carries
 * that sha (REST `PUT pulls/{n}/merge` with `sha`: a push in between makes GitHub refuse it).
 *
 *   bun scripts/mini-apps-automerge.ts --repo <owner/name>        (GH_TOKEN and MINI_APPS_AUTOMERGE from env)
 *
 * Kill switch: the repository variable MINI_APPS_AUTOMERGE must be exactly "1". Anything else (unset, the
 * shipped state) logs "disabled" and exits 0 before one API call. The workflow checks it too, before checkout.
 *
 * The conditions (CONDITIONS, in this order; each is logged true/false on one line per pull request):
 *   switch_on            MINI_APPS_AUTOMERGE === "1"
 *   pr_open              state open, not merged
 *   not_draft            draft === false
 *   base_main            base ref main, base repository this repository (the head may be any fork)
 *   base_fresh           B-194 (review-b RP8, ov#477 recheck): the pull request's base.sha (which the verdict's
 *                        base_sha must equal) is at most MAX_BASE_BEHIND commits behind main's tip: compare
 *                        <base.sha>...main answers for that base, status ahead or identical, behind_by 0 and
 *                        ahead_by (how far main has moved past the base) an integer 0..MAX_BASE_BEHIND. An open
 *                        pull request keeps its base.sha for days, so without this a verdict judged against an old
 *                        main still merged. A compare that fails or answers oddly is no merge; a stale base needs
 *                        a push that updates it (a new bot run and CI), then the label again.
 *   head_pinned          the pull request's head sha is the full sha every other fact was read for
 *   files_complete       pulls/{n}/files read in full: as many entries as changed_files, 1..2999 (3000 is the API cap)
 *   files_in_scope       every path, and every rename's old path, is mini-apps/<id>/... or skills/<id>/...
 *                        (belt and braces ON TOP of the bot's own lane, never instead of it)
 *   no_forbidden_path    no path under .github/ or skills/edge-india/references/, none of the bot's GATE_FILES,
 *                        not this file or its test
 *   review_run_green     the NEWEST run of .github/workflows/mini-apps-review.yml (by workflow id AND path, never
 *                        by display name) for this sha, event pull_request, this head repository and branch, is
 *                        completed/success, and its one job "mini-apps review (bot v0, advisory)" succeeded at sha
 *   review_verdict_pass  that run's artifact mini-apps-review (exactly one, unexpired, <= 5 MB, of that run and
 *                        sha) holds mini-apps-review.json with bot av-miniapp-review, head === sha, verdict PASS.
 *                        The check's colour is never enough: NEEDS_HUMAN exits 0 (green). Fold 1 (review-b M1,
 *                        ov#477): the JSON is bound to THIS pull request into main: pr === n, base_ref === "main",
 *                        base_sha (the event's pull_request.base.sha the bot's tool tree was checked out at,
 *                        mini-apps-review.yml checkout + --base) equals the pull request's base.sha (GitHub sets it
 *                        at each push or base edit, so a base edited after the run breaks it) and is on main
 *                        (compare base_sha...main is ahead or identical); a same-repository run's own
 *                        pull_requests entry must say base main at that sha. A JSON without these fields (every
 *                        bot run before fold 1) never merges.
 *   review_lane_mini_app the bot's own classifier said a manifest lane (sandbox | admins | everyone), never core,
 *                        and no finding gate_changed, core_path, first_party_package (ov#475), baseline_skill,
 *                        bot_error
 *   ci_green             the NEWEST run of .github/workflows/test.yml for this sha (same matching) is
 *                        completed/success and each of CI_JOBS appears exactly once, succeeded, at sha. A missing
 *                        check is no merge. test.yml writes no JSON to bind it, so (fold 1) a CI run counts only
 *                        when this pull request is the ONLY one ever opened from its head label (pulls?state=all&
 *                        head=<owner:branch> lists exactly #n): a fork run (empty pull_requests) is never accepted
 *                        on sha, branch and repository alone.
 *   label_present        the pull request carries mini-app:automerge
 *   label_by_writer      the timeline's LAST labeled/unlabeled event for that label is a labeled event by a
 *                        User whose repository role (collaborators/{login}/permission role_name) is
 *                        write, maintain or admin (triage can label; it does not count)
 *   label_after_push     that label event is strictly later than every head change GitHub records with a server
 *                        time: each matching run of either workflow for this sha (a run is created by the push,
 *                        reopen or ready-for-review that starts it), and each head_ref_force_pushed /
 *                        head_ref_restored / reopened event. A push after the label invalidates it: relabel.
 *
 * Trust: nothing here checks out, installs or runs the pull request. Every fact comes from the REST API; the
 * one file read out of the pull request's world is the bot's JSON report, unzipped to stdout and JSON.parsed.
 * Any read that fails, any answer of an unexpected shape, any malformed timestamp: that condition is false.
 * Log lines carry only fixed words, numbers, hex shas and true/false (no titles, logins or API text unescaped).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GATE_FILES } from "./mini-apps-review";

export const SWITCH_VAR = "MINI_APPS_AUTOMERGE";
export const LABEL = "mini-app:automerge";
export const BASE_BRANCH = "main";
export const REVIEW_WORKFLOW = ".github/workflows/mini-apps-review.yml";
export const REVIEW_JOB = "mini-apps review (bot v0, advisory)";
export const REVIEW_ARTIFACT = "mini-apps-review";
export const REVIEW_REPORT_FILE = "mini-apps-review.json";
export const REVIEW_BOT = "av-miniapp-review";
export const CI_WORKFLOW = ".github/workflows/test.yml";
/** The closed list of CI checks (test.yml's job names). */
export const CI_JOBS = Object.freeze(["bun test (install, scripts, skills)", "pytest (plugins)"]);
export const MINI_APP_LANES = Object.freeze(["sandbox", "admins", "everyone"]);
export const DENY_CODES = Object.freeze(["gate_changed", "core_path", "first_party_package", "baseline_skill", "bot_error"]);
export const WRITE_ROLES = Object.freeze(["admin", "maintain", "write"]);
export const FORBIDDEN_PREFIXES = Object.freeze([".github/", "skills/edge-india/references/"]);
export const FORBIDDEN_FILES: ReadonlySet<string> = new Set([...GATE_FILES, "scripts/mini-apps-automerge.ts", "scripts/tests/mini-apps-automerge.test.ts"]);
/** Timeline events that move or reset the head, with a server time. */
export const HEAD_EVENTS = Object.freeze(["head_ref_force_pushed", "head_ref_restored", "reopened"]);
export const MAX_FILES = 3000;
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
/**
 * B-194: the most commits main may have moved past the pull request's base (compare base...main ahead_by).
 * Main moved 4 to 17 commits a day over 16-23 Oct 2026 (squash merges plus the reference-sync bot), so 20 is
 * about one to two days of main: a verdict, its CI run and the bot's GATE / EDGE_SKILL_NAMES / ownership tree
 * are at most that far behind what they are merged into, while a pull request labeled within a day of its last
 * push still merges without a rebase. RP8's probe (50 behind) and an ov#379-like base (88 behind) do not.
 */
export const MAX_BASE_BEHIND = 20;
const MAX_PAGES = 30;
const MAX_CANDIDATES = 30;
export const CONDITIONS = Object.freeze(["switch_on", "pr_open", "not_draft", "base_main", "base_fresh", "head_pinned", "files_complete", "files_in_scope",
  "no_forbidden_path", "review_run_green", "review_verdict_pass", "review_lane_mini_app", "ci_green", "label_present", "label_by_writer",
  "label_after_push"] as const);
export type Condition = (typeof CONDITIONS)[number];

const SHA_RE = /^[0-9a-f]{40}$/;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HEAD_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}:[A-Za-z0-9._\/-]{1,250}$/;
const SCOPE_RE = /^(?:mini-apps|skills)\/[a-z0-9][a-z0-9-]{0,39}\/(.+)$/;

type Obj = Record<string, any>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fullName = (v: unknown): unknown => (isObj(v) ? v.full_name : undefined);
const safeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
/** A server timestamp in ms, or NaN for anything that is not one. */
export const ts = (v: unknown): number => (typeof v === "string" && TIME_RE.test(v) ? Date.parse(v) : NaN);

/** What the decision reads, all from the REST API. A null is a read that failed or answered oddly. */
export type Facts = {
  repo: string;
  n: number;
  switchValue: string | undefined;
  pinnedSha: string | null;
  pr: Obj | null;
  files: unknown[] | null;
  timeline: unknown[] | null;
  labelPermission: unknown;
  /** pulls?state=all&head=<head label>: every pull request ever opened from this head (fold 1). */
  headPulls: unknown[] | null;
  /** compare/<the pull request's base.sha>...main (fold 1; B-194). The verdict needs its base_sha to equal that
   *  base.sha, so this is the compare of the JSON's base_sha whenever the verdict can pass. */
  baseCompare: unknown;
  review: { workflow: unknown; runs: unknown[] | null; jobs: unknown[] | null; artifacts: unknown[] | null; report: unknown };
  ci: { workflow: unknown; runs: unknown[] | null; jobs: unknown[] | null };
};
export type Decision = { merge: boolean; pr: number; sha: string | null; conditions: [Condition, boolean][] };

export type Io = {
  /** GET a REST path (relative to the API root); parsed JSON; throws on any failure. */
  get: (path: string) => unknown;
  /** The text of mini-apps-review.json inside artifact `artifactId`'s zip; throws on any failure. */
  artifactJson: (repo: string, artifactId: number) => string;
  /** PUT pulls/{n}/merge with merge_method squash and sha; the parsed answer; throws when GitHub refuses. */
  merge: (repo: string, pr: number, sha: string) => unknown;
  log: (line: string) => void;
};

// ---- Paths -------------------------------------------------------------------------------------------
/** Inside one app's directory under mini-apps/ or skills/, with no empty, "." or ".." segment. */
export function inScope(path: string): boolean {
  if (typeof path !== "string" || /[\x00-\x1f\x7f\\]/.test(path)) return false;
  const m = SCOPE_RE.exec(path);
  if (!m) return false;
  return m[1].split("/").every(s => s !== "" && s !== "." && s !== "..");
}
export function forbiddenPath(path: string): boolean {
  return FORBIDDEN_PREFIXES.some(p => path.startsWith(p)) || FORBIDDEN_FILES.has(path);
}
/** Every path a file entry names: the path, and a rename's or copy's old path. */
function entryPaths(f: unknown): string[] | null {
  if (!isObj(f) || typeof f.filename !== "string") return null;
  if (f.previous_filename === undefined || f.previous_filename === null) return [f.filename];
  return typeof f.previous_filename === "string" ? [f.filename, f.previous_filename] : null;
}

// ---- Runs and the label ------------------------------------------------------------------------------
function validWorkflow(wf: unknown, path: string): wf is Obj {
  return isObj(wf) && safeInt(wf.id) && wf.path === path;
}
/** The runs of THIS workflow file for THIS pull request's head (sha, branch, repository). */
export function matchingRuns(runs: unknown[] | null, wf: unknown, path: string, pr: Obj | null, n: number, sha: string | null, repo: string, acceptUnlisted: boolean): Obj[] {
  if (!Array.isArray(runs) || !validWorkflow(wf, path) || !isObj(pr) || !sha) return [];
  const headRef = pr.head?.ref, headRepo = fullName(pr.head?.repo);
  if (typeof headRef !== "string" || typeof headRepo !== "string") return [];
  return runs.filter(isObj).filter(r =>
    safeInt(r.id) && r.workflow_id === wf.id && r.path === path && r.head_sha === sha && r.event === "pull_request" &&
    r.head_branch === headRef && fullName(r.head_repository) === headRepo && fullName(r.repository) === repo &&
    // A run that lists no pull request (every fork run) is accepted only when the caller binds it another way
    // (fold 1: the bot's JSON names the PR; CI needs this PR to be the only one from its head label).
    Array.isArray(r.pull_requests) && (r.pull_requests.length === 0 ? acceptUnlisted : r.pull_requests.some((p: unknown) => isObj(p) && p.number === n)));
}
export function newestRun(runs: Obj[]): Obj | null {
  const num = (v: unknown) => (Number.isSafeInteger(v) ? (v as number) : -1);
  return [...runs].sort((a, b) => num(b.run_number) - num(a.run_number) || b.id - a.id)[0] ?? null;
}
const green = (x: Obj) => x.status === "completed" && x.conclusion === "success";
/** All jobs belong to the run, and `name` appears exactly once, green, at sha. */
function jobGreen(jobs: unknown[] | null, run: Obj, name: string, sha: string): boolean {
  if (!Array.isArray(jobs) || !jobs.every(j => isObj(j) && j.run_id === run.id)) return false;
  const named = (jobs as Obj[]).filter(j => j.name === name);
  return named.length === 1 && named[0].head_sha === sha && green(named[0]);
}
/** Fold 1: this pull request is the only one ever opened from its head label (open or closed). */
export function headUnique(headPulls: unknown[] | null, n: number): boolean {
  return Array.isArray(headPulls) && headPulls.length === 1 && isObj(headPulls[0]) && headPulls[0].number === n;
}
/** The last labeled/unlabeled event for LABEL, when it is a labeled one; else null. */
export function labelEvent(timeline: unknown[] | null): Obj | null {
  if (!Array.isArray(timeline)) return null;
  const evs = timeline.filter(isObj).filter(e => (e.event === "labeled" || e.event === "unlabeled") && isObj(e.label) && e.label.name === LABEL);
  const last = evs[evs.length - 1];
  return last && last.event === "labeled" ? last : null;
}

// ---- The decision (pure) -----------------------------------------------------------------------------
export function decide(f: Facts): Decision {
  const c = new Map<Condition, boolean>();
  const pr = isObj(f.pr) ? f.pr : null;
  const sha = typeof f.pinnedSha === "string" && SHA_RE.test(f.pinnedSha) ? f.pinnedSha : null;

  c.set("switch_on", f.switchValue === "1");
  c.set("pr_open", !!pr && pr.state === "open" && pr.merged === false);
  c.set("not_draft", !!pr && pr.draft === false);
  c.set("base_main", !!pr && pr.base?.ref === BASE_BRANCH && fullName(pr.base?.repo) === f.repo);
  // B-194: the base is on main and at most MAX_BASE_BEHIND commits behind its tip (see the header).
  const baseSha = pr && typeof pr.base?.sha === "string" && SHA_RE.test(pr.base.sha) ? pr.base.sha : null;
  const cmp = isObj(f.baseCompare) ? f.baseCompare : null;
  c.set("base_fresh", !!baseSha && !!cmp && isObj(cmp.base_commit) && cmp.base_commit.sha === baseSha &&
    (cmp.status === "ahead" || cmp.status === "identical") && cmp.behind_by === 0 &&
    Number.isSafeInteger(cmp.ahead_by) && cmp.ahead_by >= 0 && cmp.ahead_by <= MAX_BASE_BEHIND &&
    (cmp.status === "identical") === (cmp.ahead_by === 0));
  c.set("head_pinned", !!pr && !!sha && pr.head?.sha === sha && typeof pr.head?.ref === "string" && typeof fullName(pr.head?.repo) === "string");

  const paths = Array.isArray(f.files) ? f.files.map(entryPaths) : null;
  const complete = !!pr && !!paths && paths.length > 0 && paths.length < MAX_FILES && paths.length === pr.changed_files && paths.every(p => p !== null);
  const all = complete ? (paths as string[][]).flat() : [];
  c.set("files_complete", complete);
  c.set("files_in_scope", complete && all.every(inScope));
  c.set("no_forbidden_path", complete && !all.some(forbiddenPath));

  // The bot: its newest run for this head, its job, its artifact, its report.
  const rRuns = matchingRuns(f.review.runs, f.review.workflow, REVIEW_WORKFLOW, pr, f.n, sha, f.repo, true);
  const rRun = newestRun(rRuns);
  c.set("review_run_green", !!rRun && !!sha && green(rRun) && jobGreen(f.review.jobs, rRun, REVIEW_JOB, sha));
  const arts = Array.isArray(f.review.artifacts) ? f.review.artifacts.filter(a => isObj(a) && a.name === REVIEW_ARTIFACT) as Obj[] : [];
  const art = arts.length === 1 ? arts[0] : null;
  const artOk = !!rRun && !!art && art.expired === false && typeof art.size_in_bytes === "number" && art.size_in_bytes <= MAX_ARTIFACT_BYTES &&
    isObj(art.workflow_run) && art.workflow_run.id === rRun.id && art.workflow_run.head_sha === sha;
  const rep = artOk && isObj(f.review.report) ? f.review.report : null;
  // Fold 1: bound to this pull request into main (see the header).
  const runEntries = rRun && Array.isArray(rRun.pull_requests) ? rRun.pull_requests.filter(isObj) : [];
  const runBase = runEntries.length === 0 || runEntries.some(p => p.number === f.n && isObj(p.base) && p.base.ref === BASE_BRANCH && p.base.sha === rep?.base_sha);
  const bound = !!rep && !!pr && Number.isSafeInteger(rep.pr) && rep.pr === f.n && rep.base_ref === BASE_BRANCH &&
    typeof rep.base_sha === "string" && SHA_RE.test(rep.base_sha) && pr.base?.sha === rep.base_sha && runBase &&
    isObj(f.baseCompare) && (f.baseCompare.status === "ahead" || f.baseCompare.status === "identical");
  c.set("review_verdict_pass", !!rep && bound && rep.bot === REVIEW_BOT && rep.head === sha && rep.verdict === "PASS");
  c.set("review_lane_mini_app", !!rep && MINI_APP_LANES.includes(rep.lane) && Array.isArray(rep.findings) &&
    rep.findings.every((x: unknown) => isObj(x) && typeof x.code === "string" && !DENY_CODES.includes(x.code)));

  // CI: the closed list, every check present, at this sha, from runs bound to this pull request (fold 1).
  const unique = headUnique(f.headPulls, f.n);
  const cRuns = matchingRuns(f.ci.runs, f.ci.workflow, CI_WORKFLOW, pr, f.n, sha, f.repo, unique);
  const cRun = newestRun(cRuns);
  c.set("ci_green", unique && !!cRun && !!sha && green(cRun) && CI_JOBS.every(name => jobGreen(f.ci.jobs, cRun, name, sha)));

  // The label: present, set by a writer, after the last head change.
  c.set("label_present", !!pr && Array.isArray(pr.labels) && pr.labels.some((l: unknown) => isObj(l) && l.name === LABEL));
  const ev = labelEvent(f.timeline);
  const perm = isObj(f.labelPermission) ? f.labelPermission : null;
  c.set("label_by_writer", !!ev && isObj(ev.actor) && ev.actor.type === "User" && typeof ev.actor.login === "string" &&
    !!perm && isObj(perm.user) && perm.user.login === ev.actor.login && WRITE_ROLES.includes(perm.role_name));
  const changes = [...rRuns, ...cRuns].map(r => ts(r.created_at));
  if (Array.isArray(f.timeline)) {
    for (const e of f.timeline) if (isObj(e) && HEAD_EVENTS.includes(e.event)) changes.push(ts(e.created_at));
  }
  const labelAt = ev ? ts(ev.created_at) : NaN;
  c.set("label_after_push", !!ev && rRuns.length + cRuns.length > 0 && Number.isFinite(labelAt) &&
    changes.every(Number.isFinite) && changes.every(t => labelAt > t));

  const conditions = CONDITIONS.map(k => [k, c.get(k) === true] as [Condition, boolean]);
  return { merge: conditions.every(([, v]) => v), pr: f.n, sha, conditions };
}

// ---- Reading the facts -------------------------------------------------------------------------------
function tryGet(io: Io, path: string): unknown {
  try { return io.get(path); } catch { return null; }
}
/** Every page of an array endpoint; null when a page fails or the cap is reached without a short page. */
function pages(io: Io, path: string): unknown[] | null {
  const out: unknown[] = [];
  for (let p = 1; p <= MAX_PAGES; p++) {
    const page = tryGet(io, `${path}?per_page=100&page=${p}`);
    if (!Array.isArray(page)) return null;
    out.push(...page);
    if (page.length < 100) return out;
  }
  return path.endsWith("/files") ? out : null; // files: 3000 entries is the API's cap, which files_complete refuses
}
function list(v: unknown, key?: string): unknown[] | null {
  const arr = key === undefined ? v : isObj(v) ? v[key] : null;
  return Array.isArray(arr) && arr.length < 100 ? arr : null;
}

export function gather(io: Io, repo: string, n: number, switchValue: string | undefined): Facts {
  const R = `repos/${repo}`;
  const raw = tryGet(io, `${R}/pulls/${n}`);
  const pr = isObj(raw) ? raw : null;
  const pinnedSha = pr && typeof pr.head?.sha === "string" && SHA_RE.test(pr.head.sha) ? pr.head.sha : null;
  const files = pages(io, `${R}/pulls/${n}/files`);
  const timeline = pages(io, `${R}/issues/${n}/timeline`);
  const ev = labelEvent(timeline);
  const login = ev && isObj(ev.actor) && typeof ev.actor.login === "string" && LOGIN_RE.test(ev.actor.login) ? ev.actor.login : null;
  const labelPermission = login ? tryGet(io, `${R}/collaborators/${login}/permission`) : null;
  const label = pr && typeof pr.head?.label === "string" && HEAD_LABEL_RE.test(pr.head.label) ? pr.head.label : null;
  const headPulls = label ? list(tryGet(io, `${R}/pulls?state=all&head=${encodeURIComponent(label)}&per_page=100`)) : null;
  const unique = headUnique(headPulls, n);

  const runsOf = (file: string, path: string, acceptUnlisted: boolean) => {
    const workflow = tryGet(io, `${R}/actions/workflows/${file}`);
    const runs = validWorkflow(workflow, path) && pinnedSha
      ? list(tryGet(io, `${R}/actions/workflows/${workflow.id}/runs?head_sha=${pinnedSha}&event=pull_request&per_page=100`), "workflow_runs")
      : null;
    const newest = newestRun(matchingRuns(runs, workflow, path, pr, n, pinnedSha, repo, acceptUnlisted));
    const jobs = newest ? list(tryGet(io, `${R}/actions/runs/${newest.id}/jobs?filter=latest&per_page=100`), "jobs") : null;
    return { workflow, runs, newest, jobs };
  };
  const r = runsOf("mini-apps-review.yml", REVIEW_WORKFLOW, true);
  const artifacts = r.newest ? list(tryGet(io, `${R}/actions/runs/${r.newest.id}/artifacts?per_page=100`), "artifacts") : null;
  let report: unknown = null;
  const named = (artifacts ?? []).filter(a => isObj(a) && a.name === REVIEW_ARTIFACT) as Obj[];
  const art = named.length === 1 ? named[0] : null;
  if (r.newest && art && safeInt(art.id) && art.expired === false && typeof art.size_in_bytes === "number" &&
      art.size_in_bytes <= MAX_ARTIFACT_BYTES && isObj(art.workflow_run) && art.workflow_run.id === r.newest.id) {
    try { report = JSON.parse(io.artifactJson(repo, art.id)); } catch { report = null; }
  }
  const c = runsOf("test.yml", CI_WORKFLOW, unique);
  // B-194: the pull request's own base.sha (the verdict's base_sha must equal it), never a sha from the JSON.
  const baseSha = pr && typeof pr.base?.sha === "string" && SHA_RE.test(pr.base.sha) ? pr.base.sha : null;
  const baseCompare = baseSha ? tryGet(io, `${R}/compare/${baseSha}...${BASE_BRANCH}?per_page=1`) : null;
  return {
    repo, n, switchValue, pinnedSha, pr, files, timeline, labelPermission, headPulls, baseCompare,
    review: { workflow: r.workflow, runs: r.runs, jobs: r.jobs, artifacts, report },
    ci: { workflow: c.workflow, runs: c.runs, jobs: c.jobs },
  };
}

// ---- The sweep ---------------------------------------------------------------------------------------
/** One line: the PR, the sha, the outcome and each condition true/false. Fixed tokens only. */
export function formatDecision(d: Decision): string {
  return `mini-apps automerge: pr=#${d.pr} sha=${d.sha ?? "none"} merge=${d.merge} ${d.conditions.map(([k, v]) => `${k}=${v}`).join(" ")}`;
}
/** API text for a log line: no workflow commands (::), no control characters, short. */
export function clean(s: unknown): string {
  return String(s instanceof Error ? s.message : s).replace(/[\x00-\x1f\x7f]+/g, " ").replace(/::/g, ": :").replace(/%/g, "%25").slice(0, 200);
}

/**
 * Every open pull request carrying the label, judged twice, merged when both reads say yes at the same sha.
 * Exit 0: done (including "disabled" and "nothing to merge"); 1: a read of the candidate list or a merge
 * failed; 2: bad arguments.
 */
export function sweep(io: Io, repo: string, env: Record<string, string | undefined>): number {
  if (env[SWITCH_VAR] !== "1") {
    io.log(`mini-apps automerge: disabled (repository variable ${SWITCH_VAR} is not 1): nothing read, nothing merged`);
    return 0;
  }
  if (typeof repo !== "string" || !REPO_RE.test(repo)) {
    io.log("mini-apps automerge: refused: --repo must be owner/name");
    return 2;
  }
  const issues = tryGet(io, `repos/${repo}/issues?state=open&labels=${encodeURIComponent(LABEL)}&per_page=100`);
  if (!Array.isArray(issues)) {
    io.log("mini-apps automerge: could not list the labeled pull requests; nothing merged");
    return 1;
  }
  const numbers = [...new Set(issues.filter(i => isObj(i) && isObj(i.pull_request) && safeInt(i.number)).map(i => (i as Obj).number as number))]
    .sort((a, b) => a - b).slice(0, MAX_CANDIDATES);
  io.log(`mini-apps automerge: enabled; ${numbers.length} open pull request(s) carry the label`);
  let rc = 0;
  for (const n of numbers) {
    const first = decide(gather(io, repo, n, env[SWITCH_VAR]));
    io.log(formatDecision(first));
    if (!first.merge || !first.sha) continue;
    // Re-read everything at merge time; merge only when the second read agrees on the same sha.
    const second = decide(gather(io, repo, n, env[SWITCH_VAR]));
    io.log(formatDecision(second));
    if (!second.merge || second.sha !== first.sha) {
      io.log(`mini-apps automerge: no merge of pull request ${n}: the second read does not agree`);
      continue;
    }
    // Fold 1 (review-b S1): at most ONE merge attempt per run, whatever its outcome. The next labeled pull
    // request waits for the next run, whose checks and reads then see the main this merge made.
    try {
      const answer = io.merge(repo, n, first.sha);
      if (isObj(answer) && answer.merged === true) {
        io.log(`mini-apps automerge: merged pull request ${n} at ${first.sha} (squash)`);
      } else {
        io.log(`mini-apps automerge: merge refused for pull request ${n}: GitHub did not answer merged`);
        rc = 1;
      }
    } catch (e) {
      io.log(`mini-apps automerge: merge refused for pull request ${n}: ${clean(e)}`);
      rc = 1;
    }
    break;
  }
  return rc;
}

// ---- The runner's I/O (gh, with GH_TOKEN from the environment) ---------------------------------------
function gh(args: string[], opts: { buffer?: boolean } = {}) {
  const r = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github+json", "-H", "X-GitHub-Api-Version: 2022-11-28", ...args], {
    encoding: opts.buffer ? "buffer" : "utf8", maxBuffer: MAX_ARTIFACT_BYTES + 1024 * 1024, timeout: 60_000,
    env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
  });
  if (r.error) throw new Error(`gh could not run: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`gh api exited ${r.status}: ${String(r.stderr || r.stdout).trim().split("\n").slice(-1)[0] ?? ""}`);
  return r.stdout;
}
export function ghIo(): Io {
  return {
    get: path => JSON.parse(gh(["--method", "GET", path]) as string),
    artifactJson: (repo, id) => {
      const zip = gh(["--method", "GET", `repos/${repo}/actions/artifacts/${id}/zip`], { buffer: true }) as Buffer;
      if (zip.length > MAX_ARTIFACT_BYTES) throw new Error("artifact too large");
      const dir = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP || tmpdir()), "mini-apps-automerge-"));
      try {
        const file = join(dir, "artifact.zip");
        writeFileSync(file, zip);
        // -p: the one member to stdout; nothing is written to disk from the archive.
        const r = spawnSync("unzip", ["-p", file, REVIEW_REPORT_FILE], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 30_000 });
        if (r.error || r.status !== 0) throw new Error(`unzip exited ${r.status}`);
        return r.stdout;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    merge: (repo, n, sha) => JSON.parse(gh(["--method", "PUT", `repos/${repo}/pulls/${n}/merge`, "-f", "merge_method=squash", "-f", `sha=${sha}`]) as string),
    log: line => console.log(line),
  };
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env, io: Io = ghIo()): number {
  if (env[SWITCH_VAR] !== "1") return sweep(io, "", env); // disabled: logs and exits 0 before reading anything
  if (argv.length !== 2 || argv[0] !== "--repo") {
    io.log("mini-apps automerge: usage: --repo <owner/name>");
    return 2;
  }
  return sweep(io, argv[1], env);
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
