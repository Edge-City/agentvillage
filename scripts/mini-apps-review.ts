#!/usr/bin/env bun
/**
 * Mini-apps PR review, the deterministic half ("bot v0"): MINIAPPS-PLATFORM-v2-design.md §5 (lanes and
 * their rules), §6.1 (the checks), §6.3 (the output), §6.4 and §8 Phase 0 item 3. jmill's LLM half
 * (§6.2) reads this JSON and posts the PR comment later; this script posts nothing.
 *
 *   bun scripts/mini-apps-review.ts --base <rev> --head <rev> [--base-tip <rev>] [--author <login>]
 *       [--repo <dir>] [--out <file.json>] [--summary <file.md>] [--conformance-dir <dir>]
 *
 * It reads `git diff --raw --no-renames base...head` (the --name-status list plus the file modes), the
 * files at the merge base and at head, and judges the pull request. The base branch's current tip
 * (--base-tip, default --base) is read too, as data: what main gained after the fork (a needs-card op, a
 * wider visibility, another app's host) still counts (review-b N-d).
 *   lane     changed files ⊆ mini-apps/<id>/** ∪ skills/<id>/** for exactly one id that has a manifest at
 *            head is a manifest lane, and the lane is that manifest's visibility (sandbox | admins |
 *            everyone; v1's `restricted` is sandbox or admins, as v1Entry serves them). Anything else is
 *            `core`. So is a pull request that turns a needs-card op into a read or write.
 *   checks   paths, author, schema (the ONE validator, scripts/mini-apps-manifests.cjs, loaded only when
 *            its bytes and the schema's hash to mini-apps/manifests.pins.json), hashes, version_bump
 *            (reported as N, not enforced, until S2 is settled), secrets, data_context, approval_classes,
 *            conformance (P0-5's suite, run here with --base when scripts/mini-apps-conformance.ts is in
 *            the checkout; a committed conformance.json is never trusted), lane_rules (§5).
 *   verdict  any M finding: FAIL. Else core, or a §5 rule that needs the human read: NEEDS_HUMAN. Else any
 *            S finding: PASS in sandbox, NEEDS_HUMAN in admins and everyone. Else PASS. N is a note.
 *
 * The §6.3 JSON goes to stdout (and --out); a short summary goes to stderr (and --summary, markdown for
 * the job summary). Phase 0 is advisory and not a required check. Exit 0: PASS or NEEDS_HUMAN. Exit 1:
 * FAIL, so the job is red on a FAIL (release N1; the check stays non-required). Exit 2 means the bot itself
 * could not judge (bad arguments, git failed, the validator is not the pinned one): it fails closed, still
 * prints a FAIL report with code bot_error, and never prints PASS.
 *
 * Trust (release S1, CLAIMS L14538): the pull request is DATA, never code. The tool (this script, the
 * validator and P0-5's suite) is read from its own tree, `toolRoot` (default: this file's repository); in
 * CI that tree is the BASE commit's, checked out on its own, run by explicit path (`./tool/scripts/...`,
 * never a bare name a package.json script could shadow) with `bun --config=/dev/null --no-env-file
 * --no-install --tsconfig-override=/dev/null` (no bunfig, no .env, no auto-install, no cwd tsconfig.json
 * path mapping: review-b N-a), and the pull request head is only fetched as git objects. Everything the bot
 * knows about the head comes from `git diff`, `git ls-tree` and `git cat-file` on the head sha; P0-5's suite
 * runs from the tool tree on the head's manifest and skill bytes, written out of git into a throwaway
 * directory. Nothing from the pull request's tree is executed, installed or read as configuration.
 * Known limits, so this check is NOT a required check (review-b N-b, a design item for the lead and release):
 *   - on pull_request GitHub runs the pull request's own copy of the WORKFLOW file, so a pull request that
 *     edits .github/workflows/mini-apps-review.yml can change what runs (it is a gate file, core by the
 *     honest bot);
 *   - a pull request can ADD a workflow of its own with the same workflow name, job name and artifact name,
 *     and NEEDS_HUMAN exits 0 (green), so a check required by name is satisfied by a forgery or by a
 *     NEEDS_HUMAN alike.
 *   Real gating needs a ruleset-required workflow pinned to the base (pull_request_target alone is not
 *   enough), with the verdict read from that run's JSON artifact by run id, never from a check's name or
 *   colour. Design §6.4.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runInThisContext } from "node:vm";
import { EDGE_SKILL_NAMES } from "../install/paths";

export const BOT = "av-miniapp-review";
export const BOT_VERSION = "0.1";
export const REPO_ROOT = resolve(import.meta.dir, "..");
export const VALIDATOR_PATH = "scripts/mini-apps-manifests.cjs";
export const SCHEMA_PATH = "mini-apps/manifest.v2.schema.json";
export const PINS_PATH = "mini-apps/manifests.pins.json";
export const CATALOG_PATH = "mini-apps/catalog.json";
/** The review gate itself: a pull request that changes one of these is core, and says so. */
export const GATE_FILES = Object.freeze([
  "scripts/mini-apps-review.ts", "scripts/tests/mini-apps-review.test.ts", VALIDATOR_PATH, SCHEMA_PATH, PINS_PATH,
  CATALOG_PATH, "scripts/tests/mini-app-manifests.test.ts", ".github/workflows/mini-apps-review.yml",
  // P0-5's conformance suite (ov#422) and the package.json line that runs it (`bun run conformance`).
  "scripts/mini-apps-conformance.ts", "scripts/tests/mini-apps-conformance.test.ts", "package.json",
  // The baseline-skill list the lane classifier reads (EDGE_SKILL_NAMES).
  "install/paths.ts",
  // P0-3's comment wiring (the bot's PR comment, edited in place) and its test.
  "scripts/mini-apps-review-comment.ts", "scripts/tests/mini-apps-review-comment.test.ts",
]);
/**
 * Baseline skills (install/paths.ts EDGE_SKILL_NAMES) ship to EVERY box at roll time whatever a manifest's
 * visibility says (gold-stars is one), so an id in this list is never a manifest lane: core (release S2).
 */
export const BASELINE_SKILLS: ReadonlySet<string> = new Set(EDGE_SKILL_NAMES);
export const CHECKED = Object.freeze(["paths", "author", "schema", "hashes", "version_bump", "secrets", "data_context",
  "approval_classes", "conformance", "lane_rules"]);
/**
 * The checks a PASS needs to have RUN (fail closed: a required check that did not run is check_not_run, the
 * human read). author (no owner.github yet), version_bump (S2 open) and conformance (P0-5 not on this base)
 * are advisory in Phase 0: when they do not run they are listed in not_run but do not block.
 */
export const REQUIRED_CHECKS = Object.freeze(["paths", "schema", "hashes", "secrets", "data_context", "approval_classes", "lane_rules"]);
export const VISIBILITY = Object.freeze(["sandbox", "admins", "everyone"]);
export const CEILINGS = Object.freeze(["private", "village", "public"]);
/** The widest data.context ceiling each lane may declare without the human lane (design §1.3, §7). */
export const LANE_CEILING: Readonly<Record<string, string>> = Object.freeze({ sandbox: "public", admins: "public", everyone: "village" });
/** The §5 rules: a finding with one of these codes needs the human read in every lane. */
export const HUMAN_CODES = Object.freeze(new Set(["core_path", "baseline_skill", "new_app", "visibility_lowered_from_everyone", "auth_mode_review",
  "empty_diff", "multiple_apps", "gate_changed", "manifest_deleted", "no_manifest",
  "path_status_unknown", "path_mode_unusual", "binary_unscanned", "base_manifest_missing", "base_manifest_unexpected", "base_unparseable",
  "base_invalid", "catalog_unreadable", "catalog_unlisted", "check_not_run", "needs_card_downgrade", "needs_card_removed",
  "needs_card_replaced", "needs_card_review", "cross_app_target", "cross_app_host", "oauth_review", "context_ceiling_above_private", "events_review",
  "events_entering_everyone", "visibility_raise_multi_step", "visibility_raise_with_major", "author_not_owner"]));
/**
 * The files a manifest lane may hold: P0-1's closed mini-apps/ tree. No conformance.json: anyone can hand-write
 * one, so the bot generates it itself (release's owner read of P0-5, CLAIMS L14465) and a committed one fails.
 */
const LANE_FILES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "mini-apps": ["manifest.json", "README.md"], skills: ["SKILL.md"],
});
const APP_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REV = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._\/^~-]{0,199}$/;
const MAX_PER_CODE = 10;
/** The version-bump rule is reported, not enforced, in Phase 0 (release, L14465 (c); S2 open). */
export const BUMP_SEVERITY: "M" | "S" | "N" = "N";

export type Severity = "M" | "S" | "N";
export type Finding = { code: string; severity: Severity; file?: string; line?: number; text: string };
export type Lane = "sandbox" | "admins" | "everyone" | "core";
export type Verdict = "PASS" | "FAIL" | "NEEDS_HUMAN";
export type Report = {
  bot: string; version: string; manifest: string | null; head: string; verdict: Verdict; lane: Lane;
  findings: Finding[]; checked: string[]; not_run: { check: string; reason: string }[];
};
export type Change = { status: string; path: string; oldMode: string; newMode: string };
export type Bytes = Buffer | null;
/** What a review reads. `review()` builds one from git; the tests build them by hand too. */
/** One run of P0-5's suite on the lane's manifest (`runConformance`). */
export type ConformanceRun =
  | { status: "unavailable" }
  | { status: "refused"; exit: number | null; message: string }
  | { status: "ran"; exit: number | null; bytes: Buffer };
export type Source = {
  files: Change[];
  /** The file at the MERGE BASE (what the diff is against). */
  base: (path: string) => Bytes;
  head: (path: string) => Bytes;
  /** The file at the base branch's current tip, read as data (review-b N-d); absent means "the merge base". */
  baseTip?: (path: string) => Bytes;
  added: (path: string) => { line: number; text: string }[] | "binary";
  headSha: string;
  author: string;
  /** Runs the tool's P0-5 suite on head's bytes of a manifest; absent means the suite is not available. */
  conformance?: (manifestPath: string) => ConformanceRun;
};

/** The bot cannot judge: exit 2, fail closed. */
export class BotError extends Error {}

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const isObject = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);
/** Key-sorted JSON, so two manifests compare by content, not by key order. */
export function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canon(value[k])}`).join(",")}}`;
  return value === undefined ? "null" : JSON.stringify(value);
}

// ---- The validator: P0-1's one module, loaded only at its pinned bytes -----------------------------
export type Validator = {
  validateManifest: (value: unknown) => { ok: boolean; errors?: { path: string; reason: string }[] };
  buildCatalog: (index: unknown, byId: Record<string, unknown>) => { ok: boolean; dropped?: { id: string; code: string; errors: { path: string; reason: string }[] }[]; errors?: unknown[] };
  operationBudgets: (op: unknown) => Record<string, number | string>;
};
/**
 * Read the validator and the schema from `root`, refuse unless both hash to manifests.pins.json, and run
 * exactly the bytes that were hashed (never a second read through require). Any mismatch: BotError.
 */
export function loadValidator(root = REPO_ROOT): Validator {
  const read = (rel: string) => {
    try { return readFileSync(join(root, rel)); } catch { throw new BotError(`validator_unreadable: ${rel}`); }
  };
  let pins: any;
  try { pins = JSON.parse(read(PINS_PATH).toString("utf8")); } catch (e) {
    if (e instanceof BotError) throw e;
    throw new BotError(`validator_pins_unparseable: ${PINS_PATH}`);
  }
  const source = read(VALIDATOR_PATH), schema = read(SCHEMA_PATH);
  const want = isObject(pins?.sha256) ? pins.sha256 : {};
  if (typeof want.module !== "string" || sha256(source) !== want.module) {
    throw new BotError(`validator_pin_mismatch: ${VALIDATOR_PATH} is ${sha256(source)}, ${PINS_PATH} pins ${String(want.module)}`);
  }
  if (typeof want.schema !== "string" || sha256(schema) !== want.schema) {
    throw new BotError(`validator_pin_mismatch: ${SCHEMA_PATH} is ${sha256(schema)}, ${PINS_PATH} pins ${String(want.schema)}`);
  }
  const module = { exports: {} as any };
  try {
    const wrapped = runInThisContext(`(function (exports, require, module) {${source.toString("utf8")}\n})`, { filename: join(root, VALIDATOR_PATH) });
    wrapped(module.exports, (name: string) => { throw new Error(`the validator is dependency-free; it asked for ${name}`); }, module);
  } catch (e) {
    throw new BotError(`validator_load_failed: ${(e as Error).message}`);
  }
  const v = module.exports;
  for (const name of ["validateManifest", "buildCatalog", "operationBudgets"]) {
    if (typeof v[name] !== "function") throw new BotError(`validator_shape: no ${name}`);
  }
  if (JSON.stringify(v.SCHEMA, null, 2) + "\n" !== schema.toString("utf8")) throw new BotError("validator_shape: SCHEMA is not the schema file");
  return v as Validator;
}

// ---- Git -----------------------------------------------------------------------------------------
function git(repo: string, args: string[], allowFail = false): Buffer | null {
  const r = spawnSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new BotError(`git_unavailable: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new BotError(`git_failed: git ${args[0]}: ${String(r.stderr).split("\n")[0].slice(0, 200)}`);
  }
  return r.stdout as Buffer;
}
/**
 * Parse `git diff --raw -z`. A rename or copy (R/C: only if renames were on) has two paths, and BOTH are
 * changes: a file moved out of mini-apps/<id>/ into core is core. Anything unparseable is a BotError.
 */
export function parseRawDiff(out: Buffer | string): Change[] {
  const parts = out.toString().split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  const files: Change[] = [];
  for (let i = 0; i < parts.length;) {
    const meta = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])\d*$/.exec(parts[i]);
    if (!meta) throw new BotError(`git_diff_unparseable: ${parts[i].slice(0, 80)}`);
    const n = meta[3] === "R" || meta[3] === "C" ? 2 : 1;
    const paths = parts.slice(i + 1, i + 1 + n);
    if (paths.length !== n || paths.some(p => !p)) throw new BotError("git_diff_unparseable: a path is missing");
    for (const path of paths) files.push({ oldMode: meta[1], newMode: meta[2], status: meta[3], path });
    i += 1 + n;
  }
  return files;
}
/** `git diff --raw --no-renames -z base...head`: status, path and both modes of every changed file. */
export function changedFiles(repo: string, base: string, head: string): Change[] {
  return parseRawDiff(git(repo, ["diff", "--raw", "--no-renames", "--no-abbrev", "--no-ext-diff", "--no-textconv", "-z", `${base}...${head}`])!);
}
/** The lines `head` adds to one file since the merge base, with their head line numbers. */
export function addedLines(repo: string, base: string, head: string, path: string): { line: number; text: string }[] | "binary" {
  const out = git(repo, ["--literal-pathspecs", "diff", "-U0", "--no-color", "--no-ext-diff", "--no-textconv", `${base}...${head}`, "--", path])!;
  const lines = out.toString("utf8").split("\n");
  const added: { line: number; text: string }[] = [];
  let n = 0, inHunk = false;
  for (const l of lines) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (hunk) { n = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk) { if (/^Binary files .* differ$/.test(l)) return "binary"; continue; }
    if (l.startsWith("+")) added.push({ line: n++, text: l.slice(1) });
    else if (l.startsWith(" ")) n++;
  }
  return added;
}
/**
 * The file at `rev:path`, or null when no file is there (absent, or a directory or submodule at that path).
 * A file that is listed but cannot be read is a git failure (BotError, exit 2), never "missing": an unread
 * base manifest must not look like a new app.
 */
function blobAt(repo: string, rev: string, path: string): Bytes {
  const listing = git(repo, ["--literal-pathspecs", "ls-tree", "-z", rev, "--", path])!.toString("utf8");
  const entry = listing.split("\0").find(e => e.endsWith(`\t${path}`));
  if (!entry) return null;
  if (entry.split(/\s/)[1] !== "blob") return null;
  return git(repo, ["cat-file", "blob", `${rev}:${path}`])!;
}
export const CONFORMANCE_PATH = "scripts/mini-apps-conformance.ts";
const SKILL_PATH = /^skills\/[a-z][a-z0-9-]{0,63}\/SKILL\.md$/;
/** What the suite reads, taken from git objects: never the pull request's working tree. */
export type ConformanceInput = { manifestPath: string; headBytes: Buffer; baseBytes: Bytes; skills: { path: string; bytes: Buffer }[] };
/** A throwaway git repository: base manifest (if any) committed, head's bytes in the working tree. */
function dataRepo(input: ConformanceInput): { root: string; base: string } {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-data-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
  const g = (...args: string[]) => {
    const r = spawnSync("git", ["-C", root, "-c", "user.name=av-miniapp-review", "-c", "user.email=review@invalid", "-c", "commit.gpgsign=false",
      "-c", "core.hooksPath=/dev/null", ...args], { env, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new BotError(`conformance_data_failed: git ${args[0]}`);
    return String(r.stdout).trim();
  };
  const put = (rel: string, bytes: Buffer) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), bytes); };
  g("init", "-q");
  if (input.baseBytes) { put(input.manifestPath, input.baseBytes); g("add", "--", input.manifestPath); g("commit", "-q", "-m", "base"); }
  else g("commit", "-q", "--allow-empty", "-m", "base (no manifest)");
  const base = g("rev-parse", "HEAD");
  put(input.manifestPath, input.headBytes);
  for (const skill of input.skills) if (SKILL_PATH.test(skill.path)) put(skill.path, skill.bytes);
  return { root, base };
}
/**
 * Run P0-5's suite (ov#422) on one manifest and hand back its conformance.json bytes. The suite is the
 * TOOL's (`toolRoot`, in CI the base commit's tree), never the pull request's, and it runs on head's
 * manifest and skill bytes taken from git objects (`ConformanceInput`), in a throwaway repository whose one
 * commit is the merge base's manifest, so `--base` is always passed. Run with `bun --config=/dev/null
 * --no-env-file --no-install --tsconfig-override=/dev/null` (SUITE_FLAGS) from the tool tree, by its absolute
 * path; the output goes to a temp dir outside both trees.
 */
export const SUITE_FLAGS = Object.freeze(["--config=/dev/null", "--no-env-file", "--no-install", "--tsconfig-override=/dev/null"]);
export function runConformance(input: ConformanceInput, opts: { toolRoot?: string; saveDir?: string; timeoutMs?: number } = {}): ConformanceRun {
  const toolRoot = opts.toolRoot ?? REPO_ROOT;
  const script = join(toolRoot, CONFORMANCE_PATH);
  if (!existsSync(script)) return { status: "unavailable" };
  const data = dataRepo(input);
  const dir = mkdtempSync(join(realpathSync(tmpdir()), "mini-apps-review-conformance-"));
  const out = join(dir, "conformance.json");
  try {
    const r = spawnSync(process.execPath, [...SUITE_FLAGS, script, join(data.root, input.manifestPath), "--base", data.base, "--out", out],
      { cwd: toolRoot, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024 });
    const said = `${String(r.stderr ?? "")}\n${String(r.stdout ?? "")}`.split("\n").map(l => l.trim()).filter(Boolean)[0] ?? "";
    if (r.error) return { status: "refused", exit: r.status, message: r.error.message.slice(0, 200) };
    if (!existsSync(out)) return { status: "refused", exit: r.status, message: said.slice(0, 200) || "it wrote no conformance.json" };
    const bytes = readFileSync(out);
    if (opts.saveDir) {
      mkdirSync(opts.saveDir, { recursive: true });
      writeFileSync(join(opts.saveDir, `${input.manifestPath.split("/")[1]}.conformance.json`), bytes);
    }
    return { status: "ran", exit: r.status, bytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data.root, { recursive: true, force: true });
  }
}
/**
 * A Source from a real repository: everything head-side is read from git objects at the head sha, and
 * everything base-side at the merge base, as the diff is. `baseTip` (default `base`) is the base branch's
 * current tip, also read only from git objects. The repository's working tree is never read.
 */
export function gitSource(repo: string, base: string, head: string, author: string, opts: { conformanceDir?: string; toolRoot?: string; baseTip?: string } = {}): Source {
  const tip = opts.baseTip ?? base;
  for (const rev of [base, head, tip]) if (!REV.test(rev)) throw new BotError(`bad_revision: ${JSON.stringify(rev).slice(0, 80)}`);
  // P0-5's suite reads base blobs with git cat-file and no lazy fetch: full history, never shallow or blob-less.
  if (git(repo, ["rev-parse", "--is-shallow-repository"])!.toString("utf8").trim() === "true") throw new BotError("shallow_checkout: fetch the full history (fetch-depth: 0)");
  if (git(repo, ["config", "--get", "extensions.partialClone"], true)?.toString("utf8").trim()) throw new BotError("partial_clone: a blob-less or tree-less clone cannot be judged; clone with full history");
  const headSha = git(repo, ["rev-parse", "--verify", `${head}^{commit}`])!.toString("utf8").trim();
  git(repo, ["rev-parse", "--verify", `${base}^{commit}`]);
  const tipSha = git(repo, ["rev-parse", "--verify", `${tip}^{commit}`])!.toString("utf8").trim();
  const mergeBase = git(repo, ["merge-base", base, head])!.toString("utf8").trim();
  const headBlob = (path: string) => blobAt(repo, headSha, path);
  const baseBlob = (path: string) => blobAt(repo, mergeBase, path);
  return {
    files: changedFiles(repo, base, head),
    base: baseBlob,
    head: headBlob,
    baseTip: path => blobAt(repo, tipSha, path),
    added: path => addedLines(repo, base, head, path),
    headSha,
    author,
    conformance: path => {
      const headBytes = headBlob(path);
      if (!headBytes) return { status: "refused", exit: null, message: "no manifest at head" };
      let skills: { path: string; bytes: Buffer }[] = [];
      try {
        const m = JSON.parse(headBytes.toString("utf8"));
        const paths = Array.isArray(m?.skills) ? m.skills.map((x: any) => x?.path).filter((p: unknown) => typeof p === "string" && SKILL_PATH.test(p)) : [];
        skills = [...new Set<string>(paths)].flatMap(p => { const bytes = headBlob(p); return bytes ? [{ path: p, bytes }] : []; });
      } catch { skills = []; }
      return runConformance({ manifestPath: path, headBytes, baseBytes: baseBlob(path), skills }, { toolRoot: opts.toolRoot, saveDir: opts.conformanceDir });
    },
  };
}

// ---- Paths: the lane classifier --------------------------------------------------------------------
const LANE_PATH = /^(mini-apps|skills)\/([^/]+)\/(.+)$/;
/** The one app id the pull request stays inside, or null (core) with why. A baseline skill's id is core. */
export function classify(files: Change[]): { id: string | null; core: string[] } {
  const ids = new Set<string>(), core: string[] = [];
  for (const f of files) {
    const m = LANE_PATH.exec(f.path);
    if (!m || !APP_ID.test(m[2]) || BASELINE_SKILLS.has(m[2])) core.push(f.path);
    else ids.add(m[2]);
  }
  if (files.length === 0) return { id: null, core: ["(no changed files)"] };
  if (ids.size !== 1) return { id: null, core: [...core, ...(ids.size > 1 ? [`${ids.size} app ids: ${[...ids].sort().join(", ")}`] : [])] };
  return { id: core.length ? null : [...ids][0], core };
}

// ---- Secrets: gitleaks-style shapes over the added lines --------------------------------------------
/** Each names a credential shape; a hit is reported by name and line, never by value. */
export const SECRET_PATTERNS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ["openai_or_anthropic_key", /\bsk-(?:proj-|ant-[a-z0-9]*-)?[A-Za-z0-9_-]{16,}/],
  ["stripe_key", /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/],
  ["github_token", /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}/],
  ["github_pat", /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/],
  ["pem_private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["aws_access_key_id", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["aws_secret_access_key", /\baws_?secret_?access_?key\b["']?\s*[:=]\s*["']?[A-Za-z0-9\/+]{40}\b/i],
  ["slack_token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["password_assignment", /\bpass(?:word|wd)\s*=\s*["']?[^\s"'`]{3,}/i],
  ["password_field", /["']pass(?:word|wd)["']\s*:\s*["'][^"']{3,}["']/i],
  ["bearer_token", /\bBearer\s+[A-Za-z0-9._~+\/-]{20,}=*/],
  // The value must hold a letter and a digit: a plain identifier or an upper-case variable name is not a credential.
  ["credential_assignment", /\b(?:api[_-]?key|secret|token|access[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["'](?=[^"'\s]*\d)(?=[^"'\s]*[A-Za-z])[A-Za-z0-9_\-+\/=.]{16,}["']/i],
]);
const DATA_URI = /\bdata:[a-z]+\/[a-z0-9.+-]+[;,]/i;
const BASE64_RUN = /[A-Za-z0-9+\/_-]{1025,}={0,2}/;
/** JSON string escapes decoded (\uXXXX and the simple ones), so an escaped secret matches its shape. */
export function jsonUnescape(text: string): string {
  if (!text.includes("\\")) return text;
  const simple: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|(["\\/bfnrt]))/g, (_, hex, c) => (hex ? String.fromCharCode(parseInt(hex, 16)) : simple[c]));
}
export function secretHits(text: string): string[] {
  return SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

// ---- Version bump class ---------------------------------------------------------------------------
export const LEVELS = Object.freeze(["none", "patch", "minor", "major"] as const);
export type Level = (typeof LEVELS)[number];
const rank = (l: Level) => LEVELS.indexOf(l);
const ops = (m: any): any[] => (Array.isArray(m?.operations) ? m.operations.filter(isObject) : []);
const byName = (m: any) => new Map(ops(m).filter(op => typeof op.name === "string").map(op => [op.name as string, op]));
const ceilingRank = (m: any) => (isObject(m?.data?.context) ? Math.max(0, CEILINGS.indexOf(m.data.context.ceiling ?? "private")) : -1);
/**
 * The smallest version bump the change from `base` to `head` needs (design §1.1 `version`): major for an
 * added op, a class/target/input/service/auth/approval change, a raised budget, added or widened data or
 * events, a new permission; minor for a narrowing or a visibility change; patch for copy and skill bytes.
 * An input schema change counts as major: whether it only tightens cannot be told from the diff.
 */
export function requiredBump(base: any, head: any, budgets: Validator["operationBudgets"]): { level: Level; reasons: string[] } {
  const found: [Level, string][] = [];
  const need = (level: Level, why: string) => found.push([level, why]);
  if (canon(base) === canon(head)) return { level: "none", reasons: [] };
  const bo = byName(base), ho = byName(head);
  for (const [name, op] of ho) {
    const b = bo.get(name);
    if (!b) { need("major", `operation ${name} added`); continue; }
    if (b.class !== op.class) need("major", `${name} class ${b.class} -> ${op.class}`);
    if (canon(b.target) !== canon(op.target)) need("major", `${name} target changed`);
    if (canon(b.input) !== canon(op.input)) {
      // P0-5's $ref gate (annotationOnlyEdit): an annotation edit is a patch only when no $ref could point into one.
      const same = annotationOnlyEdit(b.input, op.input);
      need(same ? "patch" : "major", `${name} input schema ${same ? "annotations (description, title, examples) changed" : "changed"}`);
    }
    const bb = budgets(b), hb = budgets(op);
    for (const k of ["maxRequestBytes", "maxResponseBytes", "timeoutMs"]) {
      if (Number(hb[k]) > Number(bb[k])) need("major", `${name} ${k} raised ${bb[k]} -> ${hb[k]}`);
      else if (Number(hb[k]) < Number(bb[k])) need("minor", `${name} ${k} lowered`);
    }
    if (bb.framing !== hb.framing) need("major", `${name} framing ${bb.framing} -> ${hb.framing}`);
    if (canon(b.returns) !== canon(op.returns)) {
      const br = b.returns, hr = op.returns;
      const widened = !isObject(br) || !isObject(hr) || br.draftIdPath !== hr.draftIdPath || br.previewPath !== hr.previewPath ||
        Number(hr.previewMaxBytes) > Number(br.previewMaxBytes) || Number(hr.previewTtlSeconds) > Number(br.previewTtlSeconds);
      need(widened ? "major" : "minor", `${name} returns ${widened ? "changed" : "narrowed"}`);
    }
    if (canon(b.approval) !== canon(op.approval)) need("major", `${name} approval (prepare or summary) changed`);
  }
  for (const name of bo.keys()) if (!ho.has(name)) need("minor", `operation ${name} removed`);
  if (canon(base?.service) !== canon(head?.service)) need("major", "service (kind, baseUrl or auth) changed");
  if (canon(base?.data) !== canon(head?.data)) {
    const bc = base?.data?.context, hc = head?.data?.context;
    const otherKeys = (d: any) => canon(isObject(d) ? Object.fromEntries(Object.entries(d).filter(([k]) => k !== "context")) : {});
    if (otherKeys(base?.data) !== otherKeys(head?.data)) need("major", "a data block other than data.context changed");
    if (!isObject(bc) && isObject(hc)) need("major", "data.context added");
    else if (isObject(bc) && !isObject(hc)) need("minor", "data.context removed");
    else if (isObject(bc) && isObject(hc)) {
      if (Number(hc.maxEntries) > Number(bc.maxEntries)) need("major", "data.context.maxEntries raised");
      else if (Number(hc.maxEntries) < Number(bc.maxEntries)) need("minor", "data.context.maxEntries lowered");
      const br = ceilingRank(base), hr = ceilingRank(head);
      if (hr > br) need("major", "data.context.ceiling raised");
      else if (hr < br) need("minor", "data.context.ceiling lowered");
    }
  }
  if (canon(base?.events) !== canon(head?.events)) {
    const be = isObject(base?.events) ? base.events : {}, he = isObject(head?.events) ? head.events : {};
    const widened = Object.keys(he).some(k => canon(he[k]) !== canon(be[k]));
    need(widened ? "major" : "minor", `events ${widened ? "added or changed" : "removed"}`);
  }
  if (canon(base?.permissions) !== canon(head?.permissions)) {
    const list = (m: any) => (Array.isArray(m?.permissions) ? m.permissions : []);
    const actions = (m: any) => list(m).filter((p: any) => p?.kind === "action").length;
    const widened = list(head).length > list(base).length || actions(head) > actions(base);
    need(widened ? "major" : "minor", `permissions ${widened ? "added" : "reworded"}`);
  }
  if (canon(base?.legacy) !== canon(head?.legacy)) need("major", "legacy block changed");
  if (base?.visibility !== head?.visibility) need("minor", `visibility ${base?.visibility} -> ${head?.visibility}`);
  if (canon(base?.skills) !== canon(head?.skills)) need("patch", "skill bytes or version changed");
  for (const k of ["name", "description", "homepage", "owner", "credit", "manifest", "id"]) {
    if (canon(base?.[k]) !== canon(head?.[k])) need("patch", `${k} changed`);
  }
  if (!found.length) need("patch", "manifest changed");
  const level = found.reduce<Level>((top, [l]) => (rank(l) > rank(top) ? l : top), "none");
  return { level, reasons: found.filter(([l]) => l === level).map(([, why]) => why) };
}
/** Schema keywords that only annotate: an edit to these alone is a patch (release, L14465 (e)). */
const ANNOTATIONS = new Set(["description", "title", "examples", "$comment"]);
const SCHEMA_MAPS = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const SCHEMA_ONE = new Set(["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames",
  "unevaluatedItems", "unevaluatedProperties", "additionalItems"]);
const SCHEMA_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
/**
 * A JSON Schema with its annotation keywords dropped at schema positions only, so a property NAMED
 * "description" (under properties) is kept: that is a real input change.
 */
export function withoutAnnotations(schema: unknown, depth = 0): unknown {
  if (!isObject(schema) || depth > 64) return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (ANNOTATIONS.has(k)) continue;
    if (SCHEMA_MAPS.has(k) && isObject(v)) out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, withoutAnnotations(sub, depth + 1)]));
    else if (SCHEMA_ONE.has(k)) out[k] = Array.isArray(v) ? v.map(x => withoutAnnotations(x, depth + 1)) : withoutAnnotations(v, depth + 1);
    else if (SCHEMA_LIST.has(k) && Array.isArray(v)) out[k] = v.map(x => withoutAnnotations(x, depth + 1));
    else out[k] = v;
  }
  return out;
}
/**
 * Copied from P0-5's scripts/mini-apps-conformance.ts (ov#422 5aacadf4, fold 2: review-b S1 on ov#422), so
 * the bot and the suite class an input edit alike (the test pins the two to the same cases). A reference can
 * point INTO an annotation (`{$ref: "#/examples/0"}`, `#/$defs/x/description`), and then an "annotation" edit
 * changes what is enforced. So the annotation-only patch holds only when neither input has a reference, or
 * when every reference (any depth, any position) is exactly `#/$defs/<name>` to a def at the input's root
 * that both inputs hold and that is unchanged beyond annotations, and neither input has an `$id` (which
 * moves what `#` names). Anything else is major.
 */
const REF_KEYS = new Set(["$ref", "$dynamicRef", "$recursiveRef"]);
const LOCAL_DEF_REF = /^#\/\$defs\/[A-Za-z0-9_-]+$/;
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
function refsOf(value: unknown, out: { refs: unknown[]; ids: boolean } = { refs: [], ids: false }) {
  if (Array.isArray(value)) for (const item of value) refsOf(item, out);
  else if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) {
      if (REF_KEYS.has(key)) out.refs.push(v);
      if (key === "$id") out.ids = true;
      refsOf(v, out);
    }
  }
  return out;
}
export function annotationOnlyEdit(from: unknown, to: unknown): boolean {
  const same = (a: unknown, b: unknown) => canon(a) === canon(b);
  if (!same(withoutAnnotations(from), withoutAnnotations(to))) return false;
  const a = refsOf(from), b = refsOf(to);
  if (!a.refs.length && !b.refs.length) return true;
  if (a.ids || b.ids) return false;
  const defs = (schema: unknown) => isObject(schema) && isObject(schema.$defs) ? schema.$defs : null;
  const x = defs(from), y = defs(to);
  return [...a.refs, ...b.refs].every(ref => {
    if (typeof ref !== "string" || !LOCAL_DEF_REF.test(ref)) return false;
    const name = ref.slice("#/$defs/".length);
    return !!x && !!y && own(x, name) && own(y, name) && same(withoutAnnotations(x[name]), withoutAnnotations(y[name]));
  });
}
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
/** The bump `from -> to` is (by the numeric triple), "down" for a decrease, or null if either is not semver. */
export function bumpOf(from: unknown, to: unknown): Level | "down" | null {
  const a = typeof from === "string" ? SEMVER.exec(from) : null, b = typeof to === "string" ? SEMVER.exec(to) : null;
  if (!a || !b) return null;
  for (const [i, level] of [[1, "major"], [2, "minor"], [3, "patch"]] as const) {
    if (Number(b[i]) > Number(a[i])) return level;
    if (Number(b[i]) < Number(a[i])) return "down";
  }
  return "none";
}

// ---- The verdict (§6.3) -------------------------------------------------------------------------------
export function verdictOf(lane: Lane, findings: Finding[]): Verdict {
  if (findings.some(f => f.severity === "M")) return "FAIL";
  if (lane === "core") return "NEEDS_HUMAN";
  if (findings.some(f => f.severity !== "N" && HUMAN_CODES.has(f.code))) return "NEEDS_HUMAN";
  if (findings.some(f => f.severity === "S")) return lane === "sandbox" ? "PASS" : "NEEDS_HUMAN";
  return "PASS";
}

// ---- The review -----------------------------------------------------------------------------------------
const parseJson = (bytes: Bytes): { ok: true; value: any } | { ok: false } => {
  if (!bytes) return { ok: false };
  try { return { ok: true, value: JSON.parse(bytes.toString("utf8")) }; } catch { return { ok: false }; }
};
const ownerLogins = (m: any): string[] | null => {
  const g = m?.owner?.github;
  const list = typeof g === "string" ? [g] : Array.isArray(g) ? g.filter(x => typeof x === "string") : [];
  return list.length ? list : null;
};

// ---- Targets, normalised for matching (review-b N-c) -----------------------------------------------------
/** A path for matching: %XX of an unreserved character decoded, lower case, "//" collapsed, no trailing "/". */
const matchPath = (p: string) => {
  const s = p.replace(/%([0-9A-Fa-f]{2})/g, (m, hex) => { const c = String.fromCharCode(parseInt(hex, 16)); return /[A-Za-z0-9._~-]/.test(c) ? c : m.toUpperCase(); })
    .toLowerCase().replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  return s.startsWith("/") ? s : `/${s}`;
};
/** The host (lower case, no trailing dot) and base path of a baseUrl, or null when there is none. */
export function endpointOf(baseUrl: unknown): { host: string; path: string } | null {
  if (typeof baseUrl !== "string") return null;
  try {
    const u = new URL(baseUrl);
    return u.hostname ? { host: u.hostname.toLowerCase().replace(/\.$/, ""), path: matchPath(u.pathname) } : null;
  } catch { return null; }
}
/**
 * The keys one op's target is matched by. `local` ignores the host (one app against itself, across a
 * baseUrl change); `global` is host-qualified (one app against another). A path is keyed both as written
 * and joined under the baseUrl's path, since either reading can be what is fetched; matching on any key is
 * the fail-closed direction (more matches, never fewer). A tool name is lower-cased for the same reason.
 */
export function targetKeys(op: any, baseUrl: unknown): { local: string[]; global: string[] } {
  const t = op?.target;
  if (!isObject(t)) return { local: [], global: [] };
  const ep = endpointOf(baseUrl);
  const at = ep ? `${ep.host}${ep.path === "/" ? "" : ep.path}` : null;
  if (typeof t.tool === "string") {
    const k = `tool ${t.tool.toLowerCase()}`;
    return { local: [k], global: at ? [`${at} ${k}`] : [] };
  }
  if (typeof t.path === "string") {
    const forms = [...new Set([matchPath(t.path), ...(ep ? [matchPath(`${ep.path}/${t.path}`)] : [])])].map(p => `path ${p}`);
    return { local: forms, global: ep ? forms.map(f => `${ep.host} ${f}`) : [] };
  }
  return { local: [canon(t).toLowerCase()], global: [] };
}
const overlaps = (a: readonly string[], b: ReadonlySet<string>) => a.some(k => b.has(k));

/** Judge one pull request. Pure over `src` and `validator`; throws BotError only for a broken input. */
export function evaluate(src: Source, validator: Validator): Report {
  const findings: Finding[] = [];
  const counts = new Map<string, number>();
  const add = (f: Finding) => {
    const n = (counts.get(f.code) ?? 0) + 1;
    counts.set(f.code, n);
    if (n <= MAX_PER_CODE) findings.push(f);
    else if (n === MAX_PER_CODE + 1) findings.push({ code: f.code, severity: f.severity, text: `more ${f.code} findings not listed` });
  };

  // Which checks ran: PASS needs every REQUIRED check to have run (fail closed); the rest are listed in not_run.
  const ran = new Set<string>(), skipped = new Map<string, string>();
  const skip = (check: string, reason: string) => { if (!skipped.has(check)) skipped.set(check, reason); };

  // paths
  const { id, core } = classify(src.files);
  let lane: Lane = "core";
  ran.add("paths");
  for (const path of core) {
    if (path === "(no changed files)") add({ code: "empty_diff", severity: "S", text: "the pull request changes no file: nothing to judge, so core (never a PASS on nothing)" });
    else if (/ app ids: /.test(path)) add({ code: "multiple_apps", severity: "S", text: `${path}: a manifest lane is exactly one app id, so core` });
    else if (BASELINE_SKILLS.has(LANE_PATH.exec(path)?.[2] ?? "")) add({ code: "baseline_skill", severity: "S", file: path, text: `${LANE_PATH.exec(path)![2]} is a baseline skill (install/paths.ts EDGE_SKILL_NAMES): its skill ships to every box whatever the manifest says, so core` });
    else add({ code: "core_path", severity: "S", file: path, text: `${path} is outside one app's mini-apps/<id>/ and skills/<id>/: core, the human gate` });
  }
  for (const f of src.files) {
    if (!["A", "M", "D"].includes(f.status)) add({ code: "path_status_unknown", severity: "S", file: f.path, text: `git status ${f.status} (a rename, copy, type change or unmerged entry) is not a plain add, edit or delete: the human read` });
    else if (f.status !== "D" && LANE_PATH.test(f.path) && f.newMode !== "100644" && f.newMode !== "120000" && f.newMode !== "160000") {
      add({ code: "path_mode_unusual", severity: "S", file: f.path, text: `mode ${f.newMode}: a catalog file is a plain 100644 file` });
    }
    if (GATE_FILES.includes(f.path)) add({ code: "gate_changed", severity: "S", file: f.path, text: "this pull request changes the review gate itself (script, validator, pins, catalog index or workflow); its own result is advisory only" });
    if (f.newMode === "120000" || f.newMode === "160000") add({ code: "path_symlink", severity: "M", file: f.path, text: `${f.newMode === "120000" ? "a symlink" : "a submodule"} is never a reviewed catalog file` });
    const m = LANE_PATH.exec(f.path);
    // skills/<id>/ holds only SKILL.md for an app (an id with a manifest at the base or head); a baseline
    // skill (skills/edge-india/references/...) or another skill directory is core, never a false FAIL.
    const appSkill = m?.[1] === "skills" ? !BASELINE_SKILLS.has(m[2]) && !!(src.head(`mini-apps/${m[2]}/manifest.json`) || src.base(`mini-apps/${m[2]}/manifest.json`)) : true;
    if (m && f.status !== "D" && appSkill && !(LANE_FILES[m[1]] ?? []).includes(m[3])) {
      add({ code: "path_unknown_file", severity: "M", file: f.path, text: m[1] === "mini-apps" && m[3] === "conformance.json"
        ? "a committed conformance.json is never trusted: the bot runs the suite itself; remove it"
        : `only ${LANE_FILES[m[1]].join(", ")} may sit in ${m[1]}/<id>/ (no code, no other files)` });
    }
  }
  const manifestPath = id ? `mini-apps/${id}/manifest.json` : null;
  const headBytes = manifestPath ? src.head(manifestPath) : null;
  const baseBytes = manifestPath ? src.base(manifestPath) : null;
  // A base manifest is expected unless the pull request adds the manifest; either surprise is "could not check".
  const manifestChange = manifestPath ? src.files.find(f => f.path === manifestPath) : undefined;
  const expectBase = manifestChange?.status !== "A";
  // A manifest absent at the merge base is a new app (core in Phase 0), even when catalog.json already lists its id.
  if (id && headBytes && !baseBytes) add({ code: "new_app", severity: "S", file: manifestPath!, text: `${id} has no manifest at the merge base: a new app is core in Phase 0 (whether or not catalog.json lists it)` });
  if (id && !headBytes) add({ code: baseBytes ? "manifest_deleted" : "no_manifest", severity: "S", file: manifestPath!, text: baseBytes ? "the pull request removes this app's manifest: unpublishing is core" : `${id} has no manifest at head: skills/${id}/ is a baseline skill or a new app without one, core` });
  const laneId = id && headBytes ? id : null;

  // Everything below reads one manifest: the lane's.
  const head = laneId ? parseJson(headBytes) : { ok: false as const };
  const baseParsed = laneId && baseBytes ? parseJson(baseBytes) : { ok: false as const };
  const hm: any = head.ok ? head.value : null;
  const bm: any = baseParsed.ok ? baseParsed.value : null;
  if (laneId && !head.ok) add({ code: "manifest_unparseable", severity: "M", file: manifestPath!, text: "the manifest is not JSON" });
  if (laneId && expectBase && !baseBytes) add({ code: "base_manifest_missing", severity: "S", file: manifestPath!, text: "the pull request edits this manifest but there is none at the merge base: the base comparisons could not run" });
  if (laneId && !expectBase && baseBytes) add({ code: "base_manifest_unexpected", severity: "S", file: manifestPath!, text: "git says the manifest is added, yet the merge base has one: the base comparisons are not trusted" });
  if (laneId && baseBytes && !baseParsed.ok) add({ code: "base_unparseable", severity: "S", file: manifestPath!, text: "the base manifest is not JSON: the base comparisons could not run" });
  if (laneId && bm && !validator.validateManifest(bm).ok) add({ code: "base_invalid", severity: "S", file: manifestPath!, text: "the base manifest is not a valid v2 manifest: the base comparisons are not trusted" });
  // The base is known: a parsed base manifest, or a manifest this pull request genuinely adds.
  const baseKnown = !!laneId && head.ok && (bm !== null || (!expectBase && !baseBytes));
  const baseWhy = "the base manifest is missing or unreadable";
  if (!laneId) for (const c of CHECKED.filter(c => c !== "paths" && c !== "secrets")) skip(c, id && !headBytes ? "the app has no manifest at head (core)" : "no single app manifest: core");
  else if (!head.ok) for (const c of ["author", "schema", "hashes", "version_bump", "data_context", "approval_classes", "lane_rules"]) skip(c, "the manifest is not JSON");
  // The base branch's tip, as data (review-b N-d): main may have gained a needs-card op or a wider visibility
  // after the fork, and that is what the merge lands on. Unreadable or absent there: the merge base alone.
  const tipParsed = laneId && src.baseTip ? parseJson(src.baseTip(manifestPath!)) : { ok: false as const };
  const tm: any = tipParsed.ok && isObject(tipParsed.value) ? tipParsed.value : null;
  // The lane is the WIDEST of the merge base's, the base tip's and the head's visibility (release S2, review-b
  // N-d): lowering an app out of a lane never moves its review into a narrower one, and lowering it out of
  // everyone takes the human read.
  if (laneId) {
    const to = VISIBILITY.indexOf(hm?.visibility), from = bm ? VISIBILITY.indexOf(bm.visibility) : -1, atTip = tm ? VISIBILITY.indexOf(tm.visibility) : -1;
    lane = to < 0 ? "core" : (VISIBILITY[Math.max(to, from, atTip)] as Lane);
    if (bm?.visibility === "everyone" && to >= 0 && hm.visibility !== "everyone") {
      add({ code: "visibility_lowered_from_everyone", severity: "S", file: manifestPath!, text: `visibility everyone -> ${hm.visibility} takes the app away from every resident: the human read (judged in the everyone lane)` });
    }
  }
  if (laneId && !baseBytes) lane = "core";

  // author: owner.github is not filled in any manifest yet (P0-1), so this never passes on its own.
  if (laneId && head.ok) {
    ran.add("author");
    const owners = ownerLogins(hm);
    // With owners listed, anyone else is S: a [bot] or a missing author too (review-b N1).
    if (!owners) add({ code: "author_unverified", severity: "N", file: manifestPath!, text: "the manifest names no owner.github yet: the author is not checked" });
    else if (LOGIN.test(src.author) && owners.some(o => o.toLowerCase() === src.author.toLowerCase())) add({ code: "author_is_owner", severity: "N", file: manifestPath!, text: `${src.author} is a listed owner` });
    else add({ code: "author_not_owner", severity: "S", file: manifestPath!, text: `${src.author ? src.author.slice(0, 60) : "(no author)"} is not in owner.github: the human read decides (staff may open it)` });
  }

  // schema: the one validator, and the catalog it builds.
  let schemaOk = false;
  if (laneId && head.ok) {
    ran.add("schema");
    const r = validator.validateManifest(hm);
    schemaOk = r.ok;
    if (!r.ok && !(r.errors ?? []).length) add({ code: "schema_invalid", severity: "M", file: manifestPath!, text: "the validator refused the manifest without a reason" });
    for (const e of r.errors ?? []) add({ code: "schema_invalid", severity: "M", file: manifestPath!, text: `${e.path} ${e.reason}` });
    const index = parseJson(src.head(CATALOG_PATH));
    const listed = index.ok && Array.isArray(index.value?.apps) && index.value.apps.includes(laneId);
    if (!index.ok) add({ code: "catalog_unreadable", severity: "S", file: CATALOG_PATH, text: "mini-apps/catalog.json at head is missing or not JSON: the catalog check could not run" });
    else if (!listed) add({ code: "catalog_unlisted", severity: "S", file: CATALOG_PATH, text: `${laneId} is not in mini-apps/catalog.json at head: an id the catalog does not know (listing it is a core change)` });
    else if (schemaOk) {
      const byId: Record<string, unknown> = {};
      for (const other of index.value.apps) {
        if (typeof other !== "string") continue;
        const p = parseJson(src.head(`mini-apps/${other}/manifest.json`));
        byId[other] = p.ok ? p.value : new Error("unreadable");
      }
      const built = validator.buildCatalog(index.value, byId);
      const dropped = built.ok ? built.dropped?.find(d => d.id === laneId) : null;
      if (!built.ok) add({ code: "catalog_invalid", severity: "M", file: CATALOG_PATH, text: "mini-apps/catalog.json at head is not a valid index" });
      else if (dropped) add({ code: "catalog_dropped", severity: "M", file: manifestPath!, text: `the cp would drop ${laneId}: ${dropped.errors.map(e => `${e.path} ${e.reason}`).join("; ") || dropped.code}` });
    }
  }

  // hashes: each skill's sha256 and frontmatter version, at head.
  if (laneId && head.ok && !(Array.isArray(hm.skills) && hm.skills.length)) skip("hashes", "the manifest lists no skills");
  if (laneId && head.ok && Array.isArray(hm.skills) && hm.skills.length) {
    ran.add("hashes");
    for (const skill of hm.skills) {
      if (!isObject(skill) || typeof skill.path !== "string" || !/^skills\/[a-z][a-z0-9-]{0,63}\/SKILL\.md$/.test(skill.path)) {
        add({ code: "skill_path_invalid", severity: "M", file: manifestPath!, text: "a skills[] entry has no skills/<name>/SKILL.md path: its hash could not be checked" });
        continue;
      }
      const bytes = src.head(skill.path);
      if (!bytes) { add({ code: "skill_missing", severity: "M", file: skill.path, text: "the manifest names a skill file that is not at head" }); continue; }
      if (sha256(bytes) !== skill.sha256) add({ code: "skill_hash_mismatch", severity: "M", file: skill.path, text: `skills[].sha256 is not the file's sha256 (${sha256(bytes).slice(0, 12)}…)` });
      const version = /^---\n(?:.*\n)*?version: (\S+)\n(?:.*\n)*?---\n/.exec(bytes.toString("utf8"))?.[1];
      if (version !== skill.version) add({ code: "skill_version_mismatch", severity: "M", file: skill.path, text: `skills[].version ${skill.version} is not the frontmatter version ${version ?? "(none)"}` });
    }
  }

  // version_bump: against the base manifest; a new manifest has no bump to check. Reported, not enforced:
  // every bump finding is BUMP_SEVERITY (N) until the lead and release settle S2 (the installer's
  // validateProjection matches the exact {id, version, operations, skills}; release prefers the version
  // informational). Turning it on is that one constant.
  let bump: { level: Level; reasons: string[] } = { level: "none", reasons: [] };
  let actual: Level | "down" | null = null;
  if (laneId && head.ok && !baseKnown) skip("version_bump", baseWhy);
  if (laneId && head.ok && bm) {
    ran.add("version_bump");
    bump = requiredBump(bm, hm, validator.operationBudgets);
    actual = bumpOf(bm.version, hm.version);
    if (actual === "down") add({ code: "version_not_monotonic", severity: BUMP_SEVERITY, file: manifestPath!, text: `version ${bm.version} -> ${hm.version} goes down` });
    else if (actual !== null && rank(actual) < rank(bump.level)) {
      add({ code: actual === "none" ? "version_not_bumped" : "version_bump_too_small", severity: BUMP_SEVERITY, file: manifestPath!,
        text: `version ${bm.version} -> ${hm.version} is ${actual}; the change needs ${bump.level}: ${bump.reasons.slice(0, 3).join("; ")}` });
    } else if (bump.level !== "none") add({ code: "version_bump", severity: "N", file: manifestPath!, text: `version ${bm.version} -> ${hm.version} (${actual}); the change needs ${bump.level}` });
  } else if (baseKnown) { ran.add("version_bump"); add({ code: "version_new_manifest", severity: "N", file: manifestPath!, text: "a new manifest: no bump to check" }); }

  // secrets: credential shapes on every added line of every file; data: URIs and big base64 in catalog files.
  // A binary file cannot be scanned: in a catalog path that is FAIL (catalog files are text), elsewhere the human read.
  ran.add("secrets");
  for (const f of src.files) {
    if (f.status === "D") continue;
    const added = src.added(f.path);
    if (added === "binary") {
      if (LANE_PATH.test(f.path)) add({ code: "binary_file", severity: "M", file: f.path, text: "a binary file in a catalog path: catalog files are text, and this one could not be scanned" });
      else add({ code: "binary_unscanned", severity: "S", file: f.path, text: "a binary file: not scanned for secrets" });
      continue;
    }
    for (const { line, text } of added) {
      // Matched raw AND JSON-unescaped, so "\u0067hp_..." in a manifest string is still a ghp_ token (release N4).
      for (const name of new Set([...secretHits(text), ...secretHits(jsonUnescape(text))])) add({ code: "secret_in_diff", severity: "M", file: f.path, line, text: `an added line matches the ${name} shape (value not shown)` });
    }
    if (LANE_PATH.test(f.path)) {
      const body = src.head(f.path)?.toString("utf8") ?? "";
      const lineOf = (re: RegExp) => { const m = re.exec(body); return m ? body.slice(0, m.index).split("\n").length : undefined; };
      if (DATA_URI.test(body)) add({ code: "data_uri", severity: "M", file: f.path, line: lineOf(DATA_URI), text: "a data: URI in a catalog file" });
      if (BASE64_RUN.test(body)) add({ code: "base64_blob", severity: "M", file: f.path, line: lineOf(BASE64_RUN), text: "a base64-alphabet run over 1 KiB in a catalog file" });
    }
  }

  // data_context: maxEntries, the lane's ceiling, and no other data block.
  if (laneId && head.ok) ran.add("data_context");
  if (laneId && head.ok && hm.data !== undefined) {
    const data = hm.data;
    if (!isObject(data)) add({ code: "data_block_invalid", severity: "M", file: manifestPath!, text: "data is not an object" });
    else {
      for (const k of Object.keys(data)) if (k !== "context") add({ code: "data_block_not_allowed", severity: "M", file: manifestPath!, text: `data.${k}: only data.context is allowed (no other storage)` });
      const ctx = data.context;
      if (ctx !== undefined) {
        if (!isObject(ctx) || !Number.isInteger(ctx.maxEntries) || ctx.maxEntries < 1 || ctx.maxEntries > 64) add({ code: "context_max_entries", severity: "M", file: manifestPath!, text: "data.context.maxEntries must be an integer 1..64" });
        if (isObject(ctx) && ctx.ceiling === undefined) add({ code: "context_ceiling_missing", severity: "S", file: manifestPath!, text: "data.context declares no ceiling (read as private); declare it" });
        const ceiling = isObject(ctx) ? (ctx.ceiling ?? "private") : "private";
        if (lane !== "core" && CEILINGS.indexOf(ceiling) > CEILINGS.indexOf(LANE_CEILING[lane])) add({ code: "context_ceiling_over_lane", severity: "M", file: manifestPath!, text: `data.context.ceiling ${ceiling} is above the ${lane} lane's ${LANE_CEILING[lane]}` });
        if (ceilingRank(hm) > 0 && ceilingRank(hm) !== ceilingRank(bm)) add({ code: "context_ceiling_above_private", severity: "S", file: manifestPath!, text: `data.context.ceiling ${ceiling} is new in this pull request: above private needs the human read (§5)` });
      }
    }
  }

  // approval_classes: needs-card ↔ prepare; no downgrade; the template render is not run yet.
  if (laneId && head.ok && !baseKnown) skip("approval_classes", `${baseWhy}: the needs-card downgrade check could not run`);
  if (laneId && head.ok) {
    if (baseKnown) ran.add("approval_classes");
    const ho = byName(hm), bo = byName(bm);
    for (const op of ho.values()) {
      if (op.class !== "needs-card") continue;
      const prep = ho.get(op.approval?.prepare);
      if (!prep || prep.class !== "prepare") add({ code: "needs_card_without_prepare", severity: "M", file: manifestPath!, text: `${op.name} names no prepare op of class prepare` });
      if (!Array.isArray(op.approval?.summary)) add({ code: "approval_summary_missing", severity: "N", file: manifestPath!, text: `${op.name} has no approval.summary template: its card is still hand-coded (P0-1 decision 4)` });
      add({ code: "template_render_not_run", severity: "N", file: manifestPath!, text: `${op.name}: no §3.2 summary renderer exists in this repository yet, so the card template was not rendered (not a pass)` });
      const was = bo.get(op.name);
      if (!was || canon(was) !== canon(op)) add({ code: "needs_card_review", severity: "S", file: manifestPath!, text: `${op.name} is a needs-card op ${was ? "changed" : "added"} in this pull request: the human read (§5, §6.5)` });
    }
    let downgraded = false;
    for (const was of bo.values()) {
      if (was.class !== "needs-card") continue;
      const now = ho.get(was.name);
      if (now && now.class !== "needs-card") {
        downgraded = true;
        add({ code: "needs_card_downgrade", severity: "S", file: manifestPath!, text: `${was.name} was needs-card and is now ${now.class}: a downgrade is core` });
      }
    }
    // An alias: a card-less op on a target a needs-card op uses, at the merge base, the base tip or the head
    // (review-b S1, N-d). Keeping X.confirm (needs-card) and adding X.quick (write) or X.peek (read) on the same
    // tool or path is a downgrade. Targets are matched normalised (targetKeys: trailing "/", case, the baseUrl's
    // path; review-b N-c), each manifest's ops under its own baseUrl.
    const tipOps = byName(tm);
    const cardKeys = new Set<string>();
    for (const [m, list] of [[bm, bo], [tm, tipOps], [hm, ho]] as const) {
      for (const op of list.values()) if (op.class === "needs-card") for (const k of targetKeys(op, m?.service?.baseUrl).local) cardKeys.add(k);
    }
    for (const op of ho.values()) {
      const keys = targetKeys(op, hm?.service?.baseUrl).local;
      if (op.class === "needs-card" || !overlaps(keys, cardKeys)) continue;
      downgraded = true;
      add({ code: "needs_card_downgrade", severity: "S", file: manifestPath!, text: `${op.name} (${op.class}) calls ${keys.find(k => cardKeys.has(k))}, which a needs-card op calls (at the merge base, the base tip or head): a card-less alias is a downgrade, core` });
    }
    // A needs-card op at the merge base with no op of that name at head is removed: the human read in every lane,
    // never a PASS (review-b S, the two-pull-request split: PR1 removes the card, PR2 adds a write on its target).
    const removed = [...bo.values()].filter(op => op.class === "needs-card" && !ho.has(op.name));
    for (const op of removed) add({ code: "needs_card_removed", severity: "S", file: manifestPath!, text: `${op.name} (needs-card) is removed: dropping a card is the human read in every lane (a later op on its target would carry no card)` });
    const newPlain = [...ho.values()].some(op => !bo.has(op.name) && op.class !== "needs-card");
    if (bm && removed.length && newPlain) add({ code: "needs_card_replaced", severity: "S", file: manifestPath!, text: "a needs-card op was removed and a new op without a card was added: the human read decides whether it is a renamed downgrade" });
    if (downgraded) lane = "core";

    // Another first-party app's endpoint (review-b N-c): an op whose target resolves to an op target another
    // app in catalog.json calls (cross_app_target), or a baseUrl on another app's host (cross_app_host), is core.
    let crossApp = false;
    const others = new Map<string, any[]>();
    const listed = (read: ((p: string) => Bytes) | undefined) => { const c = read ? parseJson(read(CATALOG_PATH)) : { ok: false as const }; return c.ok && Array.isArray(c.value?.apps) ? c.value.apps.filter((x: unknown): x is string => typeof x === "string") : []; };
    for (const read of [src.head, src.baseTip]) {
      if (!read) continue;
      for (const other of new Set<string>([...listed(src.head), ...listed(src.baseTip)])) {
        if (other === laneId || !APP_ID.test(other)) continue;
        const p = parseJson(read(`mini-apps/${other}/manifest.json`));
        if (p.ok && isObject(p.value)) others.set(other, [...(others.get(other) ?? []), p.value]);
      }
    }
    const mine = endpointOf(hm?.service?.baseUrl);
    const myKeys = [...ho.values()].map(op => ({ op, keys: targetKeys(op, hm?.service?.baseUrl).global }));
    for (const [other, manifests] of [...others].sort(([a], [b]) => a.localeCompare(b))) {
      const theirs = new Map<string, any>();
      for (const m of manifests) for (const op of ops(m)) for (const k of targetKeys(op, m.service?.baseUrl).global) if (!theirs.has(k)) theirs.set(k, op);
      for (const { op, keys } of myKeys) {
        const hit = keys.find(k => theirs.has(k));
        if (!hit) continue;
        crossApp = true;
        add({ code: "cross_app_target", severity: "S", file: manifestPath!, text: `${op.name} calls ${hit}, which ${other}'s ${String(theirs.get(hit)?.name).slice(0, 80)} (${String(theirs.get(hit)?.class)}) calls: another app's endpoint is core` });
      }
      const host = mine ? manifests.map(m => endpointOf(m.service?.baseUrl)).find(e => e?.host === mine.host) : undefined;
      if (mine && host) {
        crossApp = true;
        add({ code: "cross_app_host", severity: "S", file: manifestPath!, text: `service.baseUrl's host ${mine.host} is ${other}'s host: an app on another first-party app's host is core` });
      }
    }
    if (crossApp) lane = "core";
  }

  // conformance: the bot runs P0-5's suite itself (release, L14465 (a)); a committed conformance.json is never
  // read (it fails path_unknown_file above). Its output: {manifest: <repo-relative path>, sha256: <of the
  // manifest's exact bytes>, results: [{check, pass, note}], passed}; a not_run row is pass: null, never a pass.
  if (laneId && headBytes) {
    const run: ConformanceRun = src.conformance ? src.conformance(manifestPath!) : { status: "unavailable" };
    for (const f of judgeConformance(run, manifestPath!, headBytes)) add(f);
    if (run.status === "ran") ran.add("conformance");
    else skip("conformance", run.status === "unavailable" ? `${CONFORMANCE_PATH} is not in the tool tree` : "the suite refused");
  }

  // lane_rules (§5): visibility one step at a time and never with a major bump; oauth and events read by a human.
  if (laneId && head.ok && !baseKnown) skip("lane_rules", `${baseWhy}: the one-step visibility rule could not run`);
  if (laneId && head.ok && baseKnown) {
    ran.add("lane_rules");
    const from = bm ? VISIBILITY.indexOf(bm.visibility) : -1, to = VISIBILITY.indexOf(hm.visibility);
    if (to >= 0 && to - from > 1) add({ code: "visibility_raise_multi_step", severity: "S", file: manifestPath!, text: `visibility ${bm?.visibility ?? "(new)"} -> ${hm.visibility} is more than one step` });
    if (to >= 0 && to > from && from >= 0 && (bump.level === "major" || actual === "major")) add({ code: "visibility_raise_with_major", severity: "S", file: manifestPath!, text: `visibility raised to ${hm.visibility} in the same pull request as a major bump` });
    if (hm.service?.auth?.mode === "oauth" && canon(hm.service.auth) !== canon(bm?.service?.auth)) add({ code: "oauth_review", severity: "S", file: manifestPath!, text: "an oauth auth block is new or changed: the human read (a client registration and env vars)" });
    // Any auth-mode change (none -> app-token included) is the human read (review-b N2).
    if (bm && canon(hm.service?.auth?.mode) !== canon(bm.service?.auth?.mode)) add({ code: "auth_mode_review", severity: "S", file: manifestPath!, text: `service.auth.mode ${String(bm.service?.auth?.mode)} -> ${String(hm.service?.auth?.mode)}: an auth-mode change is the human read` });
    const events = isObject(hm.events) && Object.keys(hm.events).length > 0;
    const entering = hm.visibility === "everyone" && bm?.visibility !== "everyone";
    if (events && (canon(hm.events) !== canon(bm?.events) || entering)) {
      add({ code: hm.visibility === "everyone" ? "events_entering_everyone" : "events_review", severity: "S", file: manifestPath!, text: "an events block is new or changed, or enters the everyone lane: a data release is the data seat's read (§6.5)" });
    }
  }

  const notRun = CHECKED.filter(c => !ran.has(c)).map(check => ({ check, reason: skipped.get(check) ?? "did not run" }));
  if (laneId) for (const { check, reason } of notRun) {
    if (REQUIRED_CHECKS.includes(check)) add({ code: "check_not_run", severity: "S", text: `the required check ${check} did not run (${reason}): never a PASS` });
  }
  return {
    bot: BOT, version: BOT_VERSION, manifest: laneId && hm ? `${laneId}@${typeof hm.version === "string" ? hm.version : "?"}` : (id ?? null),
    head: src.headSha, verdict: verdictOf(lane, findings), lane, findings, checked: CHECKED.filter(c => ran.has(c)), not_run: notRun,
  };
}

/** Rows about the version bump: reported as notes while the bump rule is not enforced (BUMP_SEVERITY). */
const BUMP_ROW = /^version\./;
/** The findings one conformance run gives (pure; the tests feed it every shape). */
export function judgeConformance(run: ConformanceRun, manifestPath: string, headBytes: Buffer): Finding[] {
  const out: Finding[] = [];
  const file = manifestPath;
  if (run.status === "unavailable") return [{ code: "conformance_not_available", severity: "N", file, text: `${CONFORMANCE_PATH} is not in the tool tree (P0-5, ov#422): conformance was not run` }];
  if (run.status === "refused") return [{ code: "conformance_refused", severity: "M", file, text: `the conformance suite refused (exit ${run.exit}): ${run.message}` }];
  const c = parseJson(run.bytes);
  if (!c.ok || !isObject(c.value)) return [{ code: "conformance_unreadable", severity: "M", file, text: "the suite's conformance.json is not a JSON object" }];
  const v = c.value;
  const rows = Array.isArray(v.results) ? v.results.filter(isObject) : [];
  const name = (r: any) => String(r.check).slice(0, 60);
  if (v.manifest !== manifestPath) out.push({ code: "conformance_wrong_manifest", severity: "M", file, text: `conformance.json names ${JSON.stringify(v.manifest)?.slice(0, 80)}, not ${manifestPath}` });
  if (v.sha256 !== sha256(headBytes)) out.push({ code: "conformance_stale", severity: "M", file, text: "conformance.json's sha256 is not the manifest's exact bytes at head" });
  if (typeof v.passed !== "boolean" || (v.passed === true) !== (run.exit === 0) || (v.passed === true && rows.some(r => r.pass === false))) {
    out.push({ code: "conformance_inconsistent", severity: "M", file, text: `passed ${JSON.stringify(v.passed)} with exit ${run.exit}${rows.some(r => r.pass === false) ? " and a failed row" : ""}` });
  }
  const failed = rows.filter(r => r.pass === false && !BUMP_ROW.test(String(r.check)));
  const bump = rows.filter(r => r.pass === false && BUMP_ROW.test(String(r.check)));
  const notRun = rows.filter(r => r.pass === null);
  if (failed.length) out.push({ code: "conformance_check_failed", severity: "M", file, text: `failed: ${failed.map(name).join(", ")}` });
  if (bump.length) out.push({ code: "conformance_bump", severity: BUMP_SEVERITY, file, text: `the suite's ${bump.map(name).join(", ")} failed; the bump rule is reported, not enforced (S2)` });
  if (notRun.length) out.push({ code: "conformance_not_run", severity: "N", file, text: `not run (never a pass): ${notRun.map(name).slice(0, 8).join(", ")}` });
  if (v.passed !== true && !failed.length && !out.some(f => f.severity === "M")) {
    out.push({ code: "conformance_incomplete", severity: "S", file, text: `passed: false with no failed check${notRun.length ? `: ${notRun.length} checks did not run, so it is not a pass (first: ${notRun.map(name).slice(0, 3).join(", ")})` : ""}` });
  }
  return out;
}

/** Review a real pull request. */
/**
 * Review a real pull request. `toolRoot` (default REPO_ROOT, this script's tree; in CI the base commit's) is
 * where the validator and P0-5's suite are read from; `repo` is only ever read through git objects.
 */
export function review(opts: { repo: string; base: string; head: string; baseTip?: string; author?: string; toolRoot?: string; validatorRoot?: string; conformanceDir?: string; validator?: Validator }): Report {
  const toolRoot = opts.toolRoot ?? opts.validatorRoot ?? REPO_ROOT;
  const validator = opts.validator ?? loadValidator(toolRoot);
  return evaluate(gitSource(opts.repo, opts.base, opts.head, opts.author ?? "", { conformanceDir: opts.conformanceDir, toolRoot, baseTip: opts.baseTip }), validator);
}

/** The fail-closed report: the bot could not judge, so it never says PASS. */
export function errorReport(message: string, head = ""): Report {
  return {
    bot: BOT, version: BOT_VERSION, manifest: null, head, verdict: "FAIL", lane: "core",
    findings: [{ code: "bot_error", severity: "M", text: message.slice(0, 500) }], checked: [],
    not_run: CHECKED.map(check => ({ check, reason: "the bot could not run" })),
  };
}

const cell = (s: unknown) => String(s ?? "").replace(/[|`\n\r]/g, " ").slice(0, 300);
export function summary(r: Report): string {
  const rows = r.findings.map(f => `| ${f.severity} | \`${cell(f.code)}\` | ${cell(f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "")} | ${cell(f.text)} |`);
  return [
    "### Mini-apps review (bot v0, deterministic, advisory)",
    "",
    `**${r.verdict}** · lane \`${r.lane}\` · ${r.manifest ? `\`${cell(r.manifest)}\`` : "no single manifest"} · head \`${r.head.slice(0, 12)}\``,
    "",
    ...(rows.length ? ["| sev | code | where | note |", "|---|---|---|---|", ...rows] : ["No findings."]),
    "",
    `Checked: ${r.checked.join(", ") || "nothing (the bot could not run)"}.${r.not_run.length ? ` Not run (never a pass): ${r.not_run.map(n => `${n.check} (${cell(n.reason)})`).join(", ")}.` : ""}`,
    "M = FAIL; S = PASS in sandbox, NEEDS_HUMAN in admins/everyone; N = note. Phase 0: not a required check.",
    "",
  ].join("\n");
}

function parseArgs(argv: string[]): Record<string, string> {
  const known = new Set(["--base", "--head", "--base-tip", "--author", "--repo", "--out", "--summary", "--conformance-dir"]);
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i]) || argv[i + 1] === undefined) throw new BotError(`usage: unknown or empty option ${JSON.stringify(argv[i]).slice(0, 40)}`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  if (!out.base || !out.head) throw new BotError("usage: --base <rev> --head <rev> [--base-tip <rev>] [--author <login>] [--repo <dir>] [--out <file>] [--summary <file>] [--conformance-dir <dir>]");
  if (out.author && !LOGIN.test(out.author) && !/^[A-Za-z0-9-]{1,39}\[bot\]$/.test(out.author)) throw new BotError("usage: --author is not a GitHub login");
  return out;
}

/** The CLI. 0: PASS or NEEDS_HUMAN. 1: FAIL. 2: the bot is broken; a FAIL report is still written. */
export function main(argv: string[], io: { stdout?: (s: string) => void; stderr?: (s: string) => void; validatorRoot?: string; validator?: Validator } = {}): number {
  const stdout = io.stdout ?? (s => process.stdout.write(s));
  const stderr = io.stderr ?? (s => process.stderr.write(s));
  let args: Record<string, string> = {};
  let report: Report, code = 0;
  try {
    args = parseArgs(argv);
    report = review({ repo: args.repo ?? process.cwd(), base: args.base, head: args.head, baseTip: args["base-tip"], author: args.author ?? "", validatorRoot: io.validatorRoot, validator: io.validator, conformanceDir: args["conformance-dir"] });
  } catch (e) {
    const message = e instanceof BotError ? e.message : `bot_crashed: ${(e as Error)?.stack ?? String(e)}`;
    report = errorReport(message);
    code = 2;
    stderr(`mini-apps-review: cannot judge, failing closed: ${message.split("\n")[0]}\n`);
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  stdout(json);
  const text = summary(report);
  stderr(text);
  try {
    if (args.out) writeFileSync(args.out, json);
    if (args.summary) writeFileSync(args.summary, text);
  } catch (e) {
    stderr(`mini-apps-review: could not write the report file: ${(e as Error).message}\n`);
    return 2;
  }
  return code !== 0 ? code : report.verdict === "FAIL" ? 1 : 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
