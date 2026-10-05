#!/usr/bin/env bun
/**
 * Tag release: the logic behind .github/workflows/tag-release.yml (the "Tag
 * release" button). It creates the annotated `vX.Y.Z-rcN` tag on `main` that
 * the control plane's Roll workflow takes. docs/deployment.md, "Roll", is the
 * procedure; the hand `git tag -a` stays the fallback.
 *
 *   bun scripts/tag-release.ts plan --ref <ref> [--version <v>] [--note <text>] [--dry-run true|false]
 *       Read-only. Resolves the ref, refuses what the button must not tag,
 *       computes the next version, lists the commits since the previous release
 *       tag and compares the plugin seed files. Writes the plan to
 *       $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY when they are set.
 *
 *   bun scripts/tag-release.ts tag [--version <v>] [--note <text>]
 *       --expect-commit <sha> --expect-version <v> --actor <login> --run-url <url>
 *       [--triggering-actor <login>] [--fetch]
 *       Refreshes the remote's branches and tags (--fetch), plans again, fails
 *       unless the plan still names the same commit and version, creates the
 *       annotated tag and pushes only refs/tags/<version> (never --force, never
 *       a branch). A tag pushed by someone else meanwhile makes the push fail.
 *
 * Common options: --cwd <dir> (default .), --main <ref> (default
 * refs/remotes/origin/main), --remote <name> (default origin).
 * Exit codes: 0 done, 1 refused or failed (nothing created), 2 bad usage.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The files the Roll button compares (controlplane scripts/roll/lib.js SEED_FILES). */
export const SEED_FILES = [
  "plugins/av-events/tool_categories.json",
  "plugins/av-events/edgeos_tool_allowlist.json",
  "plugins/av-events/cron_job_names.json",
] as const;

/** Every tag the Roll button would accept (controlplane scripts/roll/lib.js TAG_RE). */
export const RELEASE_TAG_RE = /^v\d+\.\d+\.\d+(-rc\d+)?$/;
/** A release tag in canonical form: no leading zeros, rc numbers from 1. The only form this tool creates. */
export const CANONICAL_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc([1-9]\d*))?$/;

export const ROLL_WORKFLOW_URL =
  "https://github.com/Edge-City/agentvillage-controlplane/actions/workflows/roll.yml";
export const DOCS_PATH = "docs/deployment.md";
/** Subject lines beyond this many are summarised as "and N more". */
export const MAX_LISTED_COMMITS = 150;

/** An optional one-line note for the tag message: printable ASCII from a small set, at most 200 characters. */
export const NOTE_MAX = 200;
const NOTE_RE = /^[A-Za-z0-9 .,:;()\/_+=?!'@#%&-]+$/;

const SHA_RE = /^[0-9a-f]{7,40}$/;
const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const ACTOR_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const RUN_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?$/;

export class Refusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Versions

export type Version = { name: string; major: number; minor: number; patch: number; rc: number | null };

/** Any tag Roll accepts, numbers read as integers (so v2.0.0-rc011 reads as rc 11). */
export function parseReleaseTag(name: string): Version | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?$/.exec(name);
  if (!m) return null;
  return { name, major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: m[4] === undefined ? null : Number(m[4]) };
}

export function isCanonical(name: string): boolean {
  return CANONICAL_RE.test(name);
}

/** Semver order: by major, minor, patch; a release candidate sorts before its final version. */
export function compareVersions(a: Version, b: Version): number {
  for (const k of ["major", "minor", "patch"] as const) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.rc === b.rc) return 0;
  if (a.rc === null) return 1;
  if (b.rc === null) return -1;
  return a.rc < b.rc ? -1 : 1;
}

export type VersionChoice = {
  version: string;
  highest: string | null;
  /** True when an override skips the version the button would have computed. */
  skips: string | null;
};

/**
 * The version to create. `tags` are all tag names in the repository.
 *  - No override: the highest release tag must be a canonical release candidate
 *    vX.Y.Z-rcN; the result is vX.Y.Z-rc(N+1). Gaps below N are not filled.
 *    Refused when there is no release tag, when the highest is a final version
 *    (what follows a final is a human call), or when any release tag is not in
 *    canonical form (its number cannot be trusted).
 *  - Override: must be canonical, must not exist (also not as v2.0.0-rc011 for
 *    rc11), and must be strictly higher than every release tag.
 */
export function chooseVersion(tags: string[], override: string): VersionChoice {
  const release = tags.map(parseReleaseTag).filter((v): v is Version => v !== null);
  release.sort(compareVersions);
  const highest = release.at(-1) ?? null;
  const nonCanonical = release.filter((v) => !isCanonical(v.name)).map((v) => v.name);

  let computed: string | null = null;
  let computeRefusal: Refusal | null = null;
  if (highest === null) {
    computeRefusal = new Refusal(
      "no_release_tags",
      "There is no release tag (vX.Y.Z or vX.Y.Z-rcN) to count from. Give the version explicitly in the version input.",
    );
  } else if (nonCanonical.length > 0) {
    computeRefusal = new Refusal(
      "noncanonical_tags",
      `Release tag${nonCanonical.length > 1 ? "s" : ""} ${nonCanonical.join(", ")} ${nonCanonical.length > 1 ? "are" : "is"} not in canonical form (leading zeros or rc0), so the next number is not computed. Give the version explicitly in the version input.`,
    );
  } else if (highest.rc === null) {
    computeRefusal = new Refusal(
      "highest_is_final",
      `The highest release tag is the final version ${highest.name}. What comes next (a new release candidate line or a patch) is a human decision: give the version explicitly in the version input.`,
    );
  } else {
    computed = `v${highest.major}.${highest.minor}.${highest.patch}-rc${highest.rc + 1}`;
  }

  if (override === "") {
    if (computeRefusal) throw computeRefusal;
    return { version: computed as string, highest: highest?.name ?? null, skips: null };
  }

  if (!isCanonical(override)) {
    throw new Refusal(
      "bad_version",
      `The version "${override}" is not a release version. Use vX.Y.Z or vX.Y.Z-rcN (N from 1, no leading zeros), e.g. v2.0.0-rc11.`,
    );
  }
  const wanted = parseReleaseTag(override) as Version;
  const same = release.find((v) => compareVersions(v, wanted) === 0);
  if (same) {
    throw new Refusal(
      "version_exists",
      same.name === override ? `The tag ${override} already exists.` : `The tag ${same.name} already exists and is the same version as ${override}.`,
    );
  }
  if (highest && compareVersions(wanted, highest) < 0) {
    throw new Refusal(
      "version_not_higher",
      `The version ${override} is lower than the existing release tag ${highest.name}. A new release must be higher than every release tag.`,
    );
  }
  return { version: override, highest: highest?.name ?? null, skips: computed !== null && computed !== override ? computed : null };
}

/**
 * The note as given, or a refusal. Empty means no note. Refused: control
 * characters (a newline included), anything outside letters, digits, space and
 * . , : ; ( ) / _ + = ? ! ' @ # % & -, more than NOTE_MAX characters, and a note
 * starting with '-', '#' or a space.
 */
export function checkNote(note: string): string {
  if (note === "") return "";
  if (/[\u0000-\u001f\u007f]/.test(note)) throw new Refusal("bad_note", "The note must be one line with no control characters.");
  if (note.length > NOTE_MAX) throw new Refusal("bad_note", `The note is ${note.length} characters; at most ${NOTE_MAX}.`);
  if (/^[-# ]/.test(note)) throw new Refusal("bad_note", "The note must not start with '-', '#' or a space.");
  if (!NOTE_RE.test(note)) {
    throw new Refusal("bad_note", "The note may use only letters, digits, spaces and . , : ; ( ) / _ + = ? ! ' @ # % & -");
  }
  return note;
}

// ---------------------------------------------------------------------------
// Git

export type Git = (args: string[], opts?: { allowFail?: boolean }) => { code: number; stdout: string; stderr: string };

export function gitIn(cwd: string): Git {
  return (args, opts = {}) => {
    const r = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
    });
    if (r.error) throw r.error;
    const out = { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    if (out.code !== 0 && !opts.allowFail) {
      throw new Refusal("git_failed", `git ${args[0]} failed (exit ${out.code}): ${out.stderr.trim().split("\n").slice(-3).join(" ")}`);
    }
    return out;
  };
}

/** The commit a full ref name or object id names, or null. */
function commitOf(git: Git, spec: string): string | null {
  const r = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${spec}^{commit}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

function refExists(git: Git, full: string): boolean {
  return git(["show-ref", "--verify", "--quiet", full], { allowFail: true }).code === 0;
}

function isAncestor(git: Git, a: string, b: string): boolean {
  const r = git(["merge-base", "--is-ancestor", a, b], { allowFail: true });
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Refusal("git_failed", `git merge-base failed (exit ${r.code}).`);
}

/** Ref names this tool accepts: no option-looking, range, reflog or path-escaping forms. */
export function validRefInput(ref: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,127}$/.test(ref) &&
    !ref.includes("..") &&
    !ref.includes("//") &&
    !ref.endsWith("/") &&
    !ref.endsWith(".") &&
    !ref.endsWith(".lock")
  );
}

/**
 * The commit `ref` names: a hexadecimal commit id (7 to 40 characters), `main`
 * (the main ref given), a branch on the remote or a tag. A name that is both a
 * branch and a tag is refused as ambiguous.
 */
export function resolveRef(git: Git, ref: string, mainRef: string, remote: string): { commit: string; kind: string } {
  if (!validRefInput(ref)) {
    throw new Refusal("bad_ref", `The ref "${ref}" is not a commit id, branch or tag name this button accepts.`);
  }
  if (SHA_RE.test(ref)) {
    const commit = commitOf(git, ref);
    if (!commit || !commit.startsWith(ref)) {
      throw new Refusal("ref_not_found", `No single commit ${ref} exists in this repository (unknown, or an ambiguous short id).`);
    }
    return { commit, kind: "commit" };
  }
  const branch = ref === "main" ? mainRef : `refs/remotes/${remote}/${ref}`;
  const tag = `refs/tags/${ref}`;
  const isBranch = refExists(git, branch);
  const isTag = refExists(git, tag);
  if (isBranch && isTag) {
    throw new Refusal("ref_ambiguous", `"${ref}" is both a branch and a tag. Give the commit id instead.`);
  }
  if (!isBranch && !isTag) throw new Refusal("ref_not_found", `No branch or tag named "${ref}" exists.`);
  const commit = commitOf(git, isBranch ? branch : tag);
  if (!commit) throw new Refusal("ref_not_found", `"${ref}" does not name a commit.`);
  return { commit, kind: isBranch ? "branch" : "tag" };
}

export type TagInfo = { name: string; commit: string | null };

export function listTags(git: Git): TagInfo[] {
  const names = git(["for-each-ref", "--format=%(refname:strip=2)", "refs/tags"]).stdout.split("\n").filter(Boolean);
  return names.map((name) => ({ name, commit: RELEASE_TAG_RE.test(name) ? commitOf(git, `refs/tags/${name}`) : null }));
}

// ---------------------------------------------------------------------------
// Seed files

export type SeedFile = {
  file: string;
  before: { blob: string | null; version: string | null };
  after: { blob: string | null; version: string | null };
  changed: boolean;
};

function blobAt(git: Git, commit: string | null, file: string): string | null {
  if (commit === null) return null;
  const r = git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${commit}:${file}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** The file's top-level "version" string, "(no version)" or "(unreadable)"; null when the file is absent. */
function seedVersion(git: Git, blob: string | null): string | null {
  if (blob === null) return null;
  try {
    const v = JSON.parse(git(["cat-file", "blob", blob]).stdout)?.version;
    return typeof v === "string" && v !== "" ? v : "(no version)";
  } catch {
    return "(unreadable)";
  }
}

export function seedCheck(git: Git, base: string | null, target: string): SeedFile[] {
  return SEED_FILES.map((file) => {
    const a = blobAt(git, base, file);
    const b = blobAt(git, target, file);
    return {
      file,
      before: { blob: a, version: seedVersion(git, a) },
      after: { blob: b, version: seedVersion(git, b) },
      changed: a !== b,
    };
  });
}

const base = (file: string) => file.split("/").pop() as string;

/** The one line the operator acts on for Roll's allow_seed_change input. */
export function seedLine(seeds: SeedFile[]): string {
  const changed = seeds.filter((s) => s.changed);
  if (changed.length === 0) return "Roll input allow_seed_change: no seed change; leave allow_seed_change off.";
  const carries = changed.map((s) => {
    if (s.after.blob === null) return `${base(s.file)} removed`;
    if (s.before.blob !== null && s.before.version === s.after.version) {
      return `${base(s.file)} ${s.after.version} (content changed, version string unchanged: confirm with the data owner)`;
    }
    return `${base(s.file)} ${s.after.version}`;
  });
  return `Roll input allow_seed_change: tick it ONLY after the data pipeline release carries ${carries.join(" and ")}.`;
}

export function seedDetail(seeds: SeedFile[]): string[] {
  return seeds.map((s) => {
    const a = s.before.version ?? "(absent)";
    const b = s.after.version ?? "(absent)";
    return s.changed ? `${base(s.file)}: ${a} -> ${b} (changed)` : `${base(s.file)}: ${b} (unchanged)`;
  });
}

// ---------------------------------------------------------------------------
// The plan

export type Plan = {
  ref: string;
  refKind: string;
  commit: string;
  version: string;
  previous: { name: string; commit: string } | null;
  skips: string | null;
  commits: { sha: string; subject: string }[];
  seeds: SeedFile[];
  seedChanged: boolean;
  ignoredTags: string[];
  note: string;
};

export type PlanOptions = { ref: string; version?: string; note?: string; mainRef?: string; remote?: string };

export function makePlan(git: Git, opts: PlanOptions): Plan {
  const mainRef = opts.mainRef ?? "refs/remotes/origin/main";
  const remote = opts.remote ?? "origin";
  const override = (opts.version ?? "").trim();
  const ref = opts.ref.trim();
  const note = checkNote(opts.note ?? "");
  if (ref === "") throw new Refusal("bad_ref", "The ref is empty. Use main, a commit id or a tag.");

  const mainCommit = commitOf(git, mainRef);
  if (!mainCommit) throw new Refusal("main_missing", `${mainRef} does not exist here. Fetch the remote's main first.`);

  const { commit, kind } = resolveRef(git, ref, mainRef, remote);
  if (!isAncestor(git, commit, mainCommit)) {
    throw new Refusal(
      "not_on_main",
      `${ref} (${commit.slice(0, 7)}) is not on main. Only a commit that main contains can be released; merge it first.`,
    );
  }

  const tags = listTags(git);
  const release = tags.filter((t) => RELEASE_TAG_RE.test(t.name));
  const ignoredTags = tags.filter((t) => t.name.startsWith("v") && !RELEASE_TAG_RE.test(t.name)).map((t) => t.name);

  const already = release.filter((t) => t.commit === commit).map((t) => t.name);
  if (already.length > 0) {
    throw new Refusal(
      "already_tagged",
      `${commit.slice(0, 7)} is already tagged ${already.join(", ")}: roll that (Roll input tag: ${already.at(-1)}). Nothing was created.`,
    );
  }

  const choice = chooseVersion(
    tags.map((t) => t.name),
    override,
  );

  if (refExists(git, `refs/remotes/${remote}/${choice.version}`)) {
    throw new Refusal(
      "tag_name_is_branch",
      `A branch named ${choice.version} exists. The residents' VMs would follow that branch instead of the tag, and Roll refuses it. Delete or rename the branch first.`,
    );
  }

  let previous: Plan["previous"] = null;
  if (choice.highest !== null) {
    const p = release.find((t) => t.name === choice.highest);
    if (!p?.commit) throw new Refusal("previous_unreadable", `The previous release tag ${choice.highest} does not name a commit.`);
    previous = { name: p.name, commit: p.commit };
    if (!isAncestor(git, previous.commit, commit)) {
      throw new Refusal(
        "not_after_previous",
        `${commit.slice(0, 7)} does not contain the previous release ${previous.name} (${previous.commit.slice(0, 7)}). A new release must be at or after the latest one; tag by hand if this is really intended.`,
      );
    }
  }

  const range = previous ? [`${previous.commit}..${commit}`] : [commit];
  const commits = git(["log", "--no-color", "--format=%H%x09%s", ...range, "--"]).stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("\t");
      return { sha: line.slice(0, i), subject: line.slice(i + 1) };
    });

  const seeds = seedCheck(git, previous?.commit ?? null, commit);
  return {
    ref,
    refKind: kind,
    commit,
    version: choice.version,
    previous,
    skips: choice.skips,
    commits,
    seeds,
    seedChanged: seeds.some((s) => s.changed),
    ignoredTags,
    note,
  };
}

// ---------------------------------------------------------------------------
// Rendering

function commitLines(plan: Plan, indent: string): string[] {
  const shown = plan.commits.slice(0, MAX_LISTED_COMMITS).map((c) => `${indent}${c.sha.slice(0, 7)} ${c.subject}`);
  const more = plan.commits.length - shown.length;
  if (more > 0) shown.push(`${indent}... and ${more} more`);
  return shown;
}

function sinceText(plan: Plan): string {
  const n = plan.commits.length;
  return plan.previous ? `${n} commit${n === 1 ? "" : "s"} since ${plan.previous.name}` : `${n} commit${n === 1 ? "" : "s"} (no earlier release tag)`;
}

export const ROLL_CAVEAT =
  "Roll compares the seed files with the ref the residents run now (EDGE_HERMES_REF), not with the previous tag; " +
  `if residents are on an older tag, Roll can refuse for a file this check calls unchanged. How to check the data pipeline's release: ${DOCS_PATH}, "The data pipeline".`;

export function tagMessage(plan: Plan, who: { actor: string; triggeringActor?: string; runUrl: string }): string {
  const by = who.triggeringActor && who.triggeringActor !== who.actor ? `${who.actor} (re-run by ${who.triggeringActor})` : who.actor;
  const lines = [
    `${plan.version}: ${sinceText(plan)}, tagged with the Tag release button`,
    "",
    `Run by: ${by}`,
    `Run: ${who.runUrl}`,
    `Commit: ${plan.commit}`,
    `Previous release: ${plan.previous ? `${plan.previous.name} (${plan.previous.commit})` : "none"}`,
    ...(plan.note ? [`Note: ${plan.note}`] : []),
    "",
    `Seed check: ${seedLine(plan.seeds)}`,
    ...seedDetail(plan.seeds).map((l) => `  ${l}`),
    "",
    plan.previous ? `Commits since ${plan.previous.name}:` : "Commits:",
    ...commitLines(plan, "  "),
  ];
  return lines.join("\n") + "\n";
}

export type Stage = "dry-run" | "planned" | "created";

function nextStep(plan: Plan, stage: Stage): string[] {
  const seedInput = plan.seedChanged ? "ticked ONLY after the data pipeline check above" : "off";
  if (stage === "dry-run") {
    return [
      `Nothing was created. To create it, run Tag release again with dry_run unticked and ref ${plan.commit} ` +
        `(the version is worked out again then; put ${plan.version} in the version input to insist on it).`,
      "The real run tags only after this repository's suites pass at that commit.",
    ];
  }
  if (stage === "planned") return ["The tag is created after the suites pass, by the tag job of this run."];
  return [
    `Roll it: ${ROLL_WORKFLOW_URL}`,
    `  Use workflow from: main; tag: ${plan.version}; dry_run: on; scope: test-tenants; allow_seed_change: ${seedInput}.`,
    `  Then the staged procedure in ${DOCS_PATH} ("Roll"): real run, the Telegram check on your own canary, 48 hours, then scope all.`,
  ];
}

function headline(plan: Plan, stage: Stage): string {
  if (stage === "dry-run") return `Dry run: would create ${plan.version} at ${plan.commit.slice(0, 7)}`;
  if (stage === "planned") return `Will create ${plan.version} at ${plan.commit.slice(0, 7)} once the suites pass`;
  return `Created ${plan.version} at ${plan.commit.slice(0, 7)}`;
}

function notes(plan: Plan): string[] {
  const out: string[] = [];
  if (plan.skips) out.push(`The version input skips ${plan.skips}, the version the button would have computed.`);
  if (plan.ignoredTags.length > 0) out.push(`Ignored tags that are not release tags: ${plan.ignoredTags.join(", ")}.`);
  return out;
}

export function renderText(plan: Plan, stage: Stage): string {
  const lines = [
    `Tag release. ${headline(plan, stage)}.`,
    `  tag          ${plan.version} (annotated)`,
    `  commit       ${plan.commit} (from ${plan.refKind} ${plan.ref}, on main)`,
    `  previous     ${plan.previous ? `${plan.previous.name} (${plan.previous.commit.slice(0, 7)})` : "none"}`,
    `  commits      ${sinceText(plan)}`,
    ...(plan.note ? [`  note         ${plan.note}`] : []),
    "",
    seedLine(plan.seeds),
    ...seedDetail(plan.seeds).map((l) => `  ${l}`),
    ROLL_CAVEAT,
    "",
    ...notes(plan),
    ...(notes(plan).length ? [""] : []),
    "Next:",
    ...nextStep(plan, stage).map((l) => `  ${l}`),
    "",
    plan.previous ? `Commits since ${plan.previous.name}:` : "Commits:",
    ...commitLines(plan, "  "),
  ];
  return lines.join("\n") + "\n";
}

/** Markdown for $GITHUB_STEP_SUMMARY. Commit subjects go inside a fenced block with backticks neutralised. */
export function renderSummary(plan: Plan, stage: Stage): string {
  const fence = "````";
  const commits = commitLines(plan, "").map((l) => l.replace(/`/g, "'"));
  const lines = [
    `## Tag release: ${headline(plan, stage)}`,
    "",
    "| | |",
    "|---|---|",
    `| Tag | \`${plan.version}\` (annotated) |`,
    `| Commit | \`${plan.commit}\` (from ${plan.refKind} \`${plan.ref}\`, on main) |`,
    `| Previous release | ${plan.previous ? `\`${plan.previous.name}\` (\`${plan.previous.commit.slice(0, 7)}\`)` : "none"} |`,
    `| Commits | ${sinceText(plan)} |`,
    ...(plan.note ? [`| Note | ${plan.note} |`] : []),
    "",
    `**Seed check.** ${seedLine(plan.seeds)}`,
    "",
    ...seedDetail(plan.seeds).map((l) => `- ${l}`),
    "",
    ROLL_CAVEAT,
    "",
    ...notes(plan).flatMap((l) => [l, ""]),
    "**Next.**",
    "",
    ...nextStep(plan, stage).map((l) => (l.startsWith("  ") ? `  ${l.trim()}` : `- ${l}`)),
    "",
    `<details><summary>${sinceText(plan)}</summary>`,
    "",
    fence,
    ...commits,
    fence,
    "",
    "</details>",
    "",
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Creating the tag

export type TagOptions = PlanOptions & {
  expectCommit: string;
  expectVersion: string;
  actor: string;
  triggeringActor?: string;
  runUrl: string;
  fetch?: boolean;
};

export function createTag(git: Git, opts: TagOptions): { plan: Plan; tagObject: string } {
  const remote = opts.remote ?? "origin";
  if (!FULL_SHA_RE.test(opts.expectCommit)) throw new Refusal("bad_usage", "--expect-commit must be a full commit id.");
  if (!isCanonical(opts.expectVersion)) throw new Refusal("bad_usage", "--expect-version must be a release version.");
  if (!ACTOR_RE.test(opts.actor)) throw new Refusal("bad_usage", "--actor must be a GitHub login.");
  if (opts.triggeringActor && !ACTOR_RE.test(opts.triggeringActor)) throw new Refusal("bad_usage", "--triggering-actor must be a GitHub login.");
  if (!RUN_URL_RE.test(opts.runUrl)) throw new Refusal("bad_usage", "--run-url must be a GitHub Actions run URL.");

  if (opts.fetch) {
    // The remote's current branches and tags, deleted ones pruned, so the plan below sees what a push would meet.
    git(["fetch", "--quiet", "--force", "--prune", "--no-recurse-submodules", remote, `+refs/heads/*:refs/remotes/${remote}/*`, "+refs/tags/*:refs/tags/*"]);
  }
  const plan = makePlan(git, { ...opts, ref: opts.expectCommit });
  if (plan.commit !== opts.expectCommit || plan.version !== opts.expectVersion) {
    throw new Refusal(
      "plan_changed",
      `The tags changed since this run planned ${opts.expectVersion} at ${opts.expectCommit.slice(0, 7)}; it would now be ${plan.version}. Nothing was created. Run Tag release again.`,
    );
  }

  const dir = mkdtempSync(join(tmpdir(), "tag-release-"));
  try {
    const msg = join(dir, "message.txt");
    writeFileSync(msg, tagMessage(plan, opts));
    git(["tag", "--annotate", "--cleanup=verbatim", "--file", msg, "--end-of-options", plan.version, plan.commit]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const tagObject = git(["rev-parse", "--verify", `refs/tags/${plan.version}`]).stdout.trim();

  // Only the tag, by its full name, never forced: an existing remote tag of that name rejects the push.
  const push = git(["push", "--porcelain", "--no-verify", remote, `refs/tags/${plan.version}:refs/tags/${plan.version}`], { allowFail: true });
  if (push.code !== 0) {
    git(["tag", "--delete", plan.version], { allowFail: true });
    throw new Refusal(
      "push_rejected",
      `The push of ${plan.version} was rejected (another run or person may have created it first): ${(push.stdout + push.stderr).trim().split("\n").slice(-3).join(" ")}. Nothing else was pushed.`,
    );
  }
  const remoteTag = git(["ls-remote", remote, `refs/tags/${plan.version}`]).stdout.trim().split(/\s+/)[0];
  if (remoteTag !== tagObject) {
    throw new Refusal("push_unverified", `${plan.version} on ${remote} is ${remoteTag || "missing"}, not the tag object ${tagObject} this run created.`);
  }
  return { plan, tagObject };
}

// ---------------------------------------------------------------------------
// CLI

function parseArgs(argv: string[]): { cmd: string; flags: Map<string, string> } {
  const [cmd = "", ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Refusal("bad_usage", `Unexpected argument ${JSON.stringify(a)}.`);
    const key = a.slice(2);
    if (key === "fetch") {
      flags.set(key, "true");
      continue;
    }
    if (i + 1 >= rest.length) throw new Refusal("bad_usage", `--${key} needs a value.`);
    flags.set(key, rest[++i]);
  }
  return { cmd, flags };
}

const KNOWN = {
  plan: ["ref", "version", "note", "dry-run", "cwd", "main", "remote"],
  tag: ["ref", "version", "note", "cwd", "main", "remote", "expect-commit", "expect-version", "actor", "triggering-actor", "run-url", "fetch"],
} as const;

function emit(path: string | undefined, text: string) {
  if (path) appendFileSync(path, text);
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const summaryPath = env.GITHUB_STEP_SUMMARY || undefined;
  try {
    const { cmd, flags } = parseArgs(argv);
    if (cmd !== "plan" && cmd !== "tag") throw new Refusal("bad_usage", "Usage: tag-release.ts plan|tag --ref <ref> [...] (see the header of scripts/tag-release.ts).");
    for (const k of flags.keys()) {
      if (!(KNOWN[cmd] as readonly string[]).includes(k)) throw new Refusal("bad_usage", `Unknown option --${k} for ${cmd}.`);
    }
    const git = gitIn(flags.get("cwd") ?? ".");
    const common = {
      ref: flags.get("ref") ?? "",
      version: flags.get("version") ?? "",
      note: flags.get("note") ?? "",
      mainRef: flags.get("main") ?? "refs/remotes/origin/main",
      remote: flags.get("remote") ?? "origin",
    };
    if (cmd === "plan") {
      const dry = flags.get("dry-run") ?? "true";
      if (dry !== "true" && dry !== "false") throw new Refusal("bad_usage", "--dry-run must be true or false.");
      const plan = makePlan(git, common);
      const stage: Stage = dry === "true" ? "dry-run" : "planned";
      process.stdout.write(renderText(plan, stage));
      emit(
        env.GITHUB_OUTPUT,
        `commit=${plan.commit}\nversion=${plan.version}\nprevious=${plan.previous?.name ?? ""}\nseed_changed=${plan.seedChanged}\n`,
      );
      emit(summaryPath, renderSummary(plan, stage));
      return 0;
    }
    const { plan, tagObject } = createTag(git, {
      ...common,
      ref: flags.get("expect-commit") ?? "",
      expectCommit: flags.get("expect-commit") ?? "",
      expectVersion: flags.get("expect-version") ?? "",
      actor: flags.get("actor") ?? "",
      triggeringActor: flags.get("triggering-actor") || undefined,
      runUrl: flags.get("run-url") ?? "",
      fetch: flags.get("fetch") === "true",
    });
    process.stdout.write(renderText(plan, "created"));
    process.stdout.write(`\nTag object ${tagObject}, pushed as refs/tags/${plan.version}.\n`);
    emit(summaryPath, renderSummary(plan, "created"));
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    const where = env.GITHUB_ACTIONS === "true" ? `::error title=Tag release refused (${e.code})::` : `Refused (${e.code}): `;
    process.stderr.write(`${where}${e.message}\n`);
    emit(summaryPath, `## Tag release refused: nothing was created\n\n**${e.code}.** ${e.message}\n`);
    return e.code === "bad_usage" ? 2 : 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
