#!/usr/bin/env bun
/**
 * Mini-apps PR review, bot v0: the PR comment (MINIAPPS-PLATFORM-v2-design.md §6.3, §6.4; the P0-3 operating
 * rule). It reads the §6.3 JSON that scripts/mini-apps-review.ts wrote for one pull request head and posts it
 * as ONE comment on that pull request, edited in place on every later run.
 *
 *   printf '%s' "<installation token>" | bun scripts/mini-apps-review-comment.ts --repo <owner/name> --pr <n>
 *       --head <40 hex> --report <mini-apps-review.json> --bot-login <app-slug>[bot] [--run-url <url>] [--summary <file.md>]
 *
 * What it does, and nothing else:
 *   - lists the pull request's issue comments, and finds its own comment by the hidden MARKER at the start of
 *     the body AND the App's bot login (a marker in anyone else's comment is ignored, never edited);
 *   - edits that comment in place, or creates it when there is none (never a second one; when a race left two
 *     of its own, it edits both, so no stale verdict stays visible);
 *   - every body carries the visible DRY RUN marker (DRY_RUN is a constant: leaving dry run is a reviewed change
 *     to this file, never a flag or a variable).
 * It never approves, merges, requests changes, pushes, edits the pull request or posts a check run: the HTTP
 * client refuses every endpoint except the three it needs (ENDPOINTS), before any request is sent.
 *
 * Fail closed (the operating rule: "it never says PASS when it could not judge"):
 *   - no token, a bad argument, or a non-https API URL: exit 1, no request at all;
 *   - the report is missing, not JSON, not the §6.3 shape, for another head, or its verdict does not follow
 *     from its own findings (verdictOf): the comment is set to FAIL bot_error (errorReport) for this head,
 *     so an earlier PASS never stays up looking current, and the exit is 1;
 *   - any API failure (a non-2xx answer, a network error, an unexpected body, a redirect, too many pages): exit 1.
 * Exit 0 only when the verdict comment for this head is up. The verdict itself does not set the exit code:
 * the review job already does (0 PASS / NEEDS_HUMAN, 1 FAIL, 2 bot error).
 *
 * The token arrives on stdin, never through an environment variable or an argument, so it is never in this
 * process's environment or argv, and it is never printed. Errors name an endpoint and a status, never a body.
 *
 * Trust: this file runs from the BASE commit's tree (tool/), like the review. The report is data: every value
 * shown outside the JSON block is a validated enum, a 40-hex sha, a count or a code; the JSON block escapes
 * < > & and backticks as \u escapes, so no pull request text can close the fence, plant HTML or forge a line.
 */
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { BOT, BOT_VERSION, CHECKED, errorReport, verdictOf, type Finding, type Report } from "./mini-apps-review";

/** The hidden marker that starts the bot's own comment. */
export const MARKER = "<!-- av-miniapp-review:bot-v0 -->";
/** Phase 0 stays in dry run (operating rule item 7). A constant on purpose: see the header. */
export const DRY_RUN = true;
export const DRY_RUN_NOTICE = "> **DRY RUN.** Advice only: this bot never approves, merges or requests changes, posts no check run, and is not a required check. One comment, edited in place on each push.";
/** GitHub's comment limit is 65536 characters; stay under it. */
export const MAX_BODY = 60_000;
export const PER_PAGE = 100;
export const MAX_PAGES = 30;
export const MAX_REPORT_BYTES = 2 * 1024 * 1024;
export const MAX_TABLE_ROWS = 50;
const VERDICTS = new Set(["PASS", "FAIL", "NEEDS_HUMAN"]);
const LANES = new Set(["sandbox", "admins", "everyone", "core"]);
const SEVERITIES = new Set(["M", "S", "N"]);
const REPORT_KEYS = ["bot", "checked", "findings", "head", "lane", "manifest", "not_run", "verdict", "version"];
const FINDING_KEYS = new Set(["code", "severity", "file", "line", "text"]);
const SHA = /^[0-9a-f]{40}$/;
const REPO = /^[A-Za-z0-9-]{1,39}\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;
const PR = /^[1-9][0-9]{0,9}$/;
const BOT_LOGIN = /^[a-z0-9][a-z0-9-]{0,38}\[bot\]$/;
const RUN_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/actions\/runs\/[0-9]{1,20}(?:\/attempts\/[0-9]{1,5})?$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** The only requests this script may send. Anything else (reviews, merge, check runs, PUT, DELETE) is refused. */
export const ENDPOINTS: readonly (readonly ["GET" | "POST" | "PATCH", RegExp, string])[] = Object.freeze([
  ["GET", /^\/repos\/[^/?]+\/[^/?]+\/issues\/[0-9]+\/comments\?per_page=[0-9]+&page=[0-9]+$/, "list issue comments"],
  ["POST", /^\/repos\/[^/?]+\/[^/?]+\/issues\/[0-9]+\/comments$/, "create an issue comment"],
  ["PATCH", /^\/repos\/[^/?]+\/[^/?]+\/issues\/comments\/[0-9]+$/, "update an issue comment"],
] as const);

export class CommentError extends Error {}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; redirect: "error"; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>;
export type Deps = {
  fetch: FetchLike;
  /** The installation token, as read from stdin (a trailing newline is dropped). */
  token: string;
  /** The REST API root; GITHUB_API_URL on a runner. Must be https. */
  apiUrl?: string;
  readReport?: (path: string) => string;
  appendSummary?: (path: string, text: string) => void;
  stderr?: (s: string) => void;
  timeoutMs?: number;
};
export type Outcome = { action: "created" | "updated" | "unchanged"; ids: number[] };

// ---- The report ------------------------------------------------------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The §6.3 report, validated. Throws CommentError (fixed wording: never echoes the report's text). */
export function parseReport(text: string, head: string): Report {
  let r: unknown;
  try { r = JSON.parse(text); } catch { throw new CommentError("the review report is not JSON"); }
  const bad = (why: string) => new CommentError(`the review report is malformed: ${why}`);
  if (!isObj(r)) throw bad("not an object");
  if (JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(REPORT_KEYS)) throw bad("its keys are not the §6.3 keys plus not_run");
  if (r.bot !== BOT) throw bad("bot is not av-miniapp-review");
  if (r.version !== BOT_VERSION) throw bad("version is not this bot's");
  if (r.manifest !== null && (typeof r.manifest !== "string" || r.manifest.length > 200)) throw bad("manifest");
  if (typeof r.verdict !== "string" || !VERDICTS.has(r.verdict)) throw bad("verdict");
  if (typeof r.lane !== "string" || !LANES.has(r.lane)) throw bad("lane");
  if (!Array.isArray(r.findings) || r.findings.length > 5000) throw bad("findings");
  for (const f of r.findings) {
    if (!isObj(f) || Object.keys(f).some(k => !FINDING_KEYS.has(k))) throw bad("a finding has unknown keys");
    if (typeof f.code !== "string" || !CODE.test(f.code)) throw bad("a finding's code");
    if (typeof f.severity !== "string" || !SEVERITIES.has(f.severity)) throw bad("a finding's severity");
    if (typeof f.text !== "string" || f.text.length > 4000) throw bad("a finding's text");
    if (f.file !== undefined && (typeof f.file !== "string" || f.file.length > 1000)) throw bad("a finding's file");
    if (f.line !== undefined && (!Number.isSafeInteger(f.line) || (f.line as number) < 0)) throw bad("a finding's line");
  }
  const checks = new Set<string>(CHECKED);
  if (!Array.isArray(r.checked) || r.checked.some(c => typeof c !== "string" || !checks.has(c))) throw bad("checked");
  if (!Array.isArray(r.not_run) || r.not_run.some(n => !isObj(n) || typeof n.check !== "string" || !checks.has(n.check) || typeof n.reason !== "string" || n.reason.length > 1000)) throw bad("not_run");
  const findings = r.findings as Finding[];
  // The bot's own fail-closed report (errorReport) may carry an empty head; it is a FAIL with bot_error.
  const botError = r.head === "" && r.verdict === "FAIL" && findings.some(f => f.code === "bot_error" && f.severity === "M");
  if (r.head !== head && !botError) throw bad("it is for another head");
  if (verdictOf(r.lane as Report["lane"], findings) !== r.verdict) throw bad("its verdict does not follow from its findings");
  return r as unknown as Report;
}

// ---- The comment body ------------------------------------------------------------------------------------
/** JSON that is inert inside a fenced block: < > & and backticks become \u escapes (JSON.parse reads them back). */
export function inertJson(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[<>&`]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
/** The §6.3 JSON a body carries (for jmill's half and the tests): the one ```json block after the marker. */
export function extractVerdict(body: string): unknown {
  if (!body.startsWith(MARKER)) throw new CommentError("not a bot comment");
  const open = body.indexOf("\n```json\n");
  const close = open < 0 ? -1 : body.indexOf("\n```\n", open + 9);
  if (open < 0 || close < 0 || body.indexOf("\n```json\n", open + 1) >= 0) throw new CommentError("no single JSON block");
  return JSON.parse(body.slice(open + 9, close + 1));
}
/** A table cell that renders as inert code: only path-like characters survive (no backtick, pipe, line break, <, > or @). */
const codeCell = (s: string) => {
  const t = s.replace(/[^A-Za-z0-9._\/:+=,~ -]/g, "?").slice(0, 200).trim();
  return t ? `\`${t}\`` : "";
};
const footer = (runUrl?: string) => `<sub>bot v0, deterministic half (scripts/mini-apps-review.ts, run from the base commit)${runUrl ? ` · [workflow run](${runUrl})` : ""}. The JSON is the verdict.</sub>`;

export function renderBody(report: Report, head: string, runUrl?: string): string {
  const count = (s: string) => report.findings.filter(f => f.severity === s).length;
  const rows = report.findings.slice(0, MAX_TABLE_ROWS).map(f =>
    `| ${f.severity} | ${codeCell(f.code)} | ${codeCell(f.file ? `${f.file}${f.line ? `:${f.line}` : ""}` : "")} |`);
  const more = report.findings.length - rows.length;
  return [
    MARKER,
    "### Mini-apps review (bot v0) · DRY RUN",
    "",
    DRY_RUN_NOTICE,
    "",
    `**${report.verdict}** · lane \`${report.lane}\` · head \`${head.slice(0, 12)}\` · findings: ${count("M")} M, ${count("S")} S, ${count("N")} N`,
    "",
    ...(rows.length ? ["| sev | code | where |", "|---|---|---|", ...rows, ...(more > 0 ? [`| | ${more} more | in the JSON |`] : []), ""] : []),
    "The §6.3 verdict:",
    "",
    "```json",
    inertJson(report),
    "```",
    "",
    "M = FAIL; S = PASS in sandbox, NEEDS_HUMAN in admins/everyone; N = note.",
    footer(runUrl),
    "",
  ].join("\n");
}

/** The fail-closed body: FAIL bot_error for this head, never anything that reads as a pass. */
export function renderError(reason: string, head: string, runUrl?: string): string {
  const report = errorReport(`the comment step could not post a verdict: ${reason}`, head);
  return [
    MARKER,
    "### Mini-apps review (bot v0) · DRY RUN",
    "",
    DRY_RUN_NOTICE,
    "",
    `**FAIL** (bot_error) · head \`${head.slice(0, 12)}\`: the bot has no verdict for this head (${reason}). This is not a pass; any earlier verdict on this pull request is withdrawn.`,
    "",
    "```json",
    inertJson(report),
    "```",
    "",
    footer(runUrl),
    "",
  ].join("\n");
}

// ---- GitHub ----------------------------------------------------------------------------------------------
export function githubClient(deps: Pick<Deps, "fetch" | "token" | "apiUrl" | "timeoutMs">) {
  const root = (deps.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~\/-]*)?$/.test(root)) throw new CommentError("the API URL is not an https URL");
  return async function request(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<unknown> {
    const rule = ENDPOINTS.find(([m, re]) => m === method && re.test(path));
    if (!rule) throw new CommentError(`refused: ${method} is not an endpoint this bot may call`);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await deps.fetch(root + path, {
        method,
        headers: {
          Accept: "application/vnd.github+json", Authorization: `Bearer ${deps.token}`, "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "av-miniapp-review-bot-v0", ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(deps.timeoutMs ?? 20_000),
      });
    } catch {
      throw new CommentError(`${rule[2]}: the request failed (network, timeout or redirect)`);
    }
    if (!(res.status >= 200 && res.status < 300)) throw new CommentError(`${rule[2]}: GitHub answered ${res.status}`);
    try { return await res.json(); } catch { throw new CommentError(`${rule[2]}: the answer is not JSON`); }
  };
}

type Comment = { id: number; body: string; user: { login: string; type: string } };
const isComment = (c: unknown): c is Comment => isObj(c) && Number.isSafeInteger(c.id) && (c.id as number) > 0;

/** Edit the bot's own comment(s) in place, or create the one comment. Never deletes, never a second create. */
export async function upsertComment(request: ReturnType<typeof githubClient>, repo: string, pr: string, botLogin: string, body: string): Promise<Outcome> {
  const all: unknown[] = [];
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw new CommentError(`list issue comments: more than ${MAX_PAGES * PER_PAGE} comments; refusing to guess`);
    const got = await request("GET", `/repos/${repo}/issues/${pr}/comments?per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(got)) throw new CommentError("list issue comments: the answer is not a list");
    all.push(...got);
    if (got.length < PER_PAGE) break;
  }
  const mine = all.filter((c): c is Comment => isComment(c) && isObj(c.user) && c.user.login === botLogin && c.user.type === "Bot"
    && typeof c.body === "string" && c.body.startsWith(MARKER));
  if (mine.length === 0) {
    const created = await request("POST", `/repos/${repo}/issues/${pr}/comments`, { body });
    if (!isComment(created)) throw new CommentError("create an issue comment: the answer has no comment id");
    return { action: "created", ids: [created.id] };
  }
  let changed = false;
  for (const c of mine) {
    if (c.body === body) continue;
    const updated = await request("PATCH", `/repos/${repo}/issues/comments/${c.id}`, { body });
    if (!isComment(updated) || updated.id !== c.id) throw new CommentError("update an issue comment: the answer is not that comment");
    changed = true;
  }
  return { action: changed ? "updated" : "unchanged", ids: mine.map(c => c.id) };
}

// ---- The CLI ---------------------------------------------------------------------------------------------
const OPTIONS = new Set(["--repo", "--pr", "--head", "--report", "--bot-login", "--run-url", "--summary"]);
function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!OPTIONS.has(argv[i]) || argv[i + 1] === undefined || out[argv[i].slice(2)] !== undefined) throw new CommentError("usage: an unknown, repeated or empty option");
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

/** 0: the verdict comment for this head is up. 1: failed closed (see the header). */
export async function run(argv: string[], deps: Deps): Promise<number> {
  const stderr = deps.stderr ?? (s => process.stderr.write(s));
  let args: Record<string, string> = {};
  const say = (line: string) => {
    stderr(`mini-apps-review-comment: ${line}\n`);
    if (args.summary) try { (deps.appendSummary ?? appendFileSync)(args.summary, `\n${line}\n`); } catch { stderr("mini-apps-review-comment: could not write the job summary\n"); }
  };
  try {
    args = parseArgs(argv);
  } catch (e) {
    const at = argv.indexOf("--summary");
    if (at >= 0 && argv[at + 1]) args = { summary: argv[at + 1] };
    say(`**Bot comment FAILED CLOSED** (DRY RUN): ${(e as Error).message}. Nothing was posted.`);
    return 1;
  }
  const failClosed = (why: string) => { say(`**Bot comment FAILED CLOSED** (DRY RUN): ${why}. Nothing that reads as a pass was posted.`); return 1; };
  if (!args.repo || !REPO.test(args.repo)) return failClosed("--repo is not owner/name");
  if (!args.pr || !PR.test(args.pr)) return failClosed("--pr is not a pull request number");
  if (!args.head || !SHA.test(args.head)) return failClosed("--head is not a 40-hex commit sha");
  if (!args.report) return failClosed("--report is missing");
  if (!args["bot-login"] || !BOT_LOGIN.test(args["bot-login"])) return failClosed("--bot-login is not an App bot login (<app-slug>[bot])");
  if (args["run-url"] !== undefined && !RUN_URL.test(args["run-url"])) return failClosed("--run-url is not a workflow run URL");
  const token = deps.token.replace(/\r?\n$/, "");
  if (!token || /\s/.test(token) || token.length > 1000) return failClosed("no usable token on stdin");
  let request: ReturnType<typeof githubClient>;
  try { request = githubClient({ ...deps, token }); } catch (e) { return failClosed((e as Error).message); }

  const head = args.head, runUrl = args["run-url"];
  let body: string, failure: string | null = null, verdict = "";
  try {
    const readReport = deps.readReport ?? ((p: string) => {
      if (statSync(p).size > MAX_REPORT_BYTES) throw new CommentError("the review report is too large");
      return readFileSync(p, "utf8");
    });
    let text: string;
    try { text = readReport(args.report); } catch (e) { throw e instanceof CommentError ? e : new CommentError("the review report is missing or unreadable"); }
    const report = parseReport(text, head);
    body = renderBody(report, head, runUrl);
    if (body.length > MAX_BODY) throw new CommentError("the verdict is too large for one comment");
    verdict = report.verdict;
  } catch (e) {
    failure = e instanceof CommentError ? e.message : "the comment step crashed";
    body = renderError(failure, head, runUrl);
  }
  let outcome: Outcome;
  try {
    outcome = await upsertComment(request, args.repo, args.pr, args["bot-login"], body);
  } catch (e) {
    const why = e instanceof CommentError ? e.message : "the comment step crashed";
    return failClosed(failure ? `${failure}; then ${why}` : why);
  }
  const where = `${outcome.action} comment ${outcome.ids.join(", ")}`;
  if (failure) {
    say(`**Bot comment FAILED CLOSED** (DRY RUN): ${failure}. The comment now says FAIL (bot_error) for head \`${head.slice(0, 12)}\` (${where}).`);
    return 1;
  }
  say(`Bot comment (DRY RUN): **${verdict}** for head \`${head.slice(0, 12)}\` (${where}).`);
  return 0;
}

if (import.meta.main) {
  const token = await Bun.stdin.text();
  process.exit(await run(process.argv.slice(2), { fetch: fetch as unknown as FetchLike, token, apiUrl: process.env.GITHUB_API_URL }));
}
