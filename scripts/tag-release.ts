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
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
/**
 * A release tag in canonical form: no leading zeros, rc numbers from 1, every
 * number at most 6 digits. The only form this tool creates.
 */
export const CANONICAL_RE = /^v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(?:-rc([1-9]\d{0,5}))?$/;
/** The test workflow whose `bun test` directories must exist at the commit (main's copy, as the run uses it). */
export const TEST_WORKFLOW = ".github/workflows/test.yml";

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

// ---------------------------------------------------------------------------
// Output hygiene: every string that comes from the repository or an input
// passes through these before it reaches a log line, the step summary or a
// tag message.

/**
 * C0 and C1 controls, DEL and Unicode line breaks become spaces (the runner
 * splits lines on \r too); bidi controls and zero-width characters are removed;
 * clipped to max.
 */
export function clean(text: string, max: number): string {
  const t = text
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ")
    .replace(/[\u200b-\u200d\u202a-\u202e\u2066-\u2069\ufeff]/g, "");
  return t.length > max ? `${t.slice(0, Math.max(0, max - 3))}...` : t;
}

/** GitHub's escaping for a workflow command's data. */
export function escapeData(text: string): string {
  return text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/** GitHub's escaping for a workflow command's property value (title=...). */
export function escapeProperty(text: string): string {
  return escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");
}

/** clean(), then backticks and angle brackets replaced, for markdown. */
export function neutral(text: string, max: number): string {
  return clean(text, max).replace(/`/g, "'").replace(/</g, "\u2039").replace(/>/g, "\u203a");
}

/** A markdown code span of neutral(text). */
export function code(text: string, max: number): string {
  return `\`${neutral(text, max)}\``;
}

export const MAX_SUBJECT = 200;
export const MAX_TAG_NAME = 100;
export const MAX_VERSION_STRING = 64;

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

/**
 * A tag Roll accepts with every number at most 6 digits, numbers read as
 * integers (so v2.0.0-rc011 reads as rc 11). Longer numbers: null.
 */
export function parseReleaseTag(name: string): Version | null {
  const m = /^v(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-rc(\d{1,6}))?$/.exec(name);
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
 *  - Either way: refused when a tag Roll would accept has a number longer than
 *    6 digits (it cannot be ordered safely), and the result is checked once
 *    more (canonical, new, higher than every release tag) before it is returned.
 */
export function chooseVersion(tags: string[], override: string): VersionChoice {
  const oversize = tags.filter((t) => RELEASE_TAG_RE.test(t) && parseReleaseTag(t) === null);
  if (oversize.length > 0) {
    throw new Refusal(
      "oversize_tags",
      `Tag${oversize.length > 1 ? "s" : ""} ${oversize.map((t) => clean(t, MAX_TAG_NAME)).join(", ")} look${oversize.length > 1 ? "" : "s"} like a release tag with a number longer than 6 digits, so versions cannot be compared safely. Delete or rename ${oversize.length > 1 ? "them" : "it"}, or tag by hand.`,
    );
  }
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
    return assertNewVersion({ version: computed as string, highest: highest?.name ?? null, skips: null }, tags, release);
  }

  if (!isCanonical(override)) {
    throw new Refusal(
      "bad_version",
      `The version "${clean(override, MAX_TAG_NAME)}" is not a release version. Use vX.Y.Z or vX.Y.Z-rcN (N from 1, no leading zeros), e.g. v2.0.0-rc11.`,
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
  return assertNewVersion(
    { version: override, highest: highest?.name ?? null, skips: computed !== null && computed !== override ? computed : null },
    tags,
    release,
  );
}

/** The last check on a chosen version: canonical, no tag of that name, strictly higher than every release tag. */
function assertNewVersion(choice: VersionChoice, tags: string[], release: Version[]): VersionChoice {
  const v = isCanonical(choice.version) ? parseReleaseTag(choice.version) : null;
  if (v === null || tags.includes(choice.version) || release.some((r) => compareVersions(r, v) >= 0)) {
    throw new Refusal("version_check_failed", `The chosen version ${clean(choice.version, MAX_TAG_NAME)} failed the final check (canonical, new, higher than every release tag). Nothing was created.`);
  }
  return choice;
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
    throw new Refusal("bad_ref", `The ref "${clean(ref, MAX_TAG_NAME)}" is not a commit id, branch or tag name this button accepts.`);
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

/** Shown for a seed file whose "version" cannot be trusted; such a file always counts as changed. */
export const UNREADABLE_VERSION = "(unreadable version)";
const SEED_VERSION_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The keys of a JSON text's top-level object, decoded, in order (duplicates kept); null when it cannot be scanned. */
export function topLevelKeys(raw: string): string[] | null {
  const keys: string[] = [];
  let depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < raw.length && raw[j] !== '"') j += raw[j] === "\\" ? 2 : 1;
      if (j >= raw.length) return null;
      let k = j + 1;
      while (k < raw.length && /\s/.test(raw[k])) k++;
      if (depth === 1 && raw[k] === ":") {
        try {
          keys.push(JSON.parse(raw.slice(i, j + 1)));
        } catch {
          return null;
        }
      }
      i = j;
    } else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") depth--;
  }
  return keys;
}

/**
 * The file's top-level "version" string; UNREADABLE_VERSION when the JSON does
 * not parse, has no or more than one top-level "version" key, or the value is
 * not 1 to 64 of A-Z a-z 0-9 . _ -; null when the file is absent.
 */
export function seedVersionOf(raw: string): string {
  const keys = topLevelKeys(raw);
  if (keys === null || keys.filter((k) => k === "version").length !== 1) return UNREADABLE_VERSION;
  try {
    const v = JSON.parse(raw)?.version;
    return typeof v === "string" && SEED_VERSION_RE.test(v) ? v : UNREADABLE_VERSION;
  } catch {
    return UNREADABLE_VERSION;
  }
}

function seedVersion(git: Git, blob: string | null): string | null {
  return blob === null ? null : seedVersionOf(git(["cat-file", "blob", blob]).stdout);
}

export function seedCheck(git: Git, base: string | null, target: string): SeedFile[] {
  return SEED_FILES.map((file) => {
    const a = blobAt(git, base, file);
    const b = blobAt(git, target, file);
    const after = seedVersion(git, b);
    return {
      file,
      before: { blob: a, version: seedVersion(git, a) },
      after: { blob: b, version: after },
      changed: a !== b || after === UNREADABLE_VERSION,
    };
  });
}

const base = (file: string) => file.split("/").pop() as string;

/** The one line the operator acts on for Roll's allow_seed_change input; `since` names the comparison base. */
export function seedLine(seeds: SeedFile[], since: string | null): string {
  const from = since ?? "the start (no earlier release tag)";
  const changed = seeds.filter((s) => s.changed);
  if (changed.length === 0) return `Roll input allow_seed_change: no seed change since ${from}; leave allow_seed_change off.`;
  const carries = changed.map((s) => {
    if (s.after.blob === null) return `${base(s.file)} removed`;
    if (s.after.version === UNREADABLE_VERSION) return `${base(s.file)} ${UNREADABLE_VERSION} (read the file before rolling)`;
    if (s.before.blob !== null && s.before.version === s.after.version) {
      return `${base(s.file)} ${s.after.version} (content changed, version string unchanged: confirm with the data owner)`;
    }
    return `${base(s.file)} ${s.after.version}`;
  });
  return `Roll input allow_seed_change: tick it ONLY after the data pipeline release carries ${carries.join(" and ")} (changed since ${from}).`;
}

export function seedDetail(seeds: SeedFile[]): string[] {
  return seeds.map((s) => {
    const a = s.before.version ?? "(absent)";
    const b = s.after.version ?? "(absent)";
    return s.changed ? `${base(s.file)}: ${a} to ${b} (changed)` : `${base(s.file)}: ${b} (unchanged)`;
  });
}

/** A digest of the seed comparison, so the tag job can tell whether it still matches the plan job's. */
export function seedDigest(previous: string | null, seeds: SeedFile[]): string {
  const material = JSON.stringify([previous, seeds.map((s) => [s.file, s.before.blob, s.after.blob, s.changed, s.after.version])]);
  return createHash("sha256").update(material).digest("hex");
}

// ---------------------------------------------------------------------------
// The suites' directories

/**
 * The directories test.yml's `bun test` line names. Exactly one such line, each
 * argument a plain relative path; otherwise null.
 */
export function suiteDirs(workflow: string): string[] | null {
  const lines = workflow.split("\n").filter((l) => /^\s*(?:-\s+)?run:\s*bun test\s/.test(l));
  if (lines.length !== 1) return null;
  const args = lines[0].replace(/^\s*(?:-\s+)?run:\s*bun test\s+/, "").trim().split(/\s+/);
  if (args.length === 0 || args.some((a) => !/^[A-Za-z0-9_][A-Za-z0-9._\/-]*$/.test(a) || a.includes(".."))) return null;
  return args;
}

/** Refuses unless every directory the suites run exists at the commit (a missing one would be a silent green). */
export function checkSuiteDirs(git: Git, commit: string, workflow: string | null): void {
  if (workflow === null) throw new Refusal("suite_list_unreadable", `${TEST_WORKFLOW} was not found, so the suites' directories cannot be checked.`);
  const dirs = suiteDirs(workflow);
  if (dirs === null) throw new Refusal("suite_list_unreadable", `${TEST_WORKFLOW} does not have exactly one plain \`bun test <dirs>\` line.`);
  // A directory must exist at the commit and hold at least one test file, or bun would run nothing there.
  const missing = dirs.filter((d) => {
    if (git(["cat-file", "-t", `${commit}:${d}`], { allowFail: true }).stdout.trim() !== "tree") return true;
    const files = git(["ls-tree", "-r", "--name-only", commit, "--", `${d}/`]).stdout.split("\n");
    return !files.some((f) => /\.test\.(ts|js)$/.test(f));
  });
  if (missing.length > 0) {
    throw new Refusal(
      "suite_dir_missing",
      `${missing.join(", ")} ${missing.length > 1 ? "do" : "does"} not exist at ${commit.slice(0, 7)}, or hold${missing.length > 1 ? "" : "s"} no *.test.ts or *.test.js file, so the suites would skip ${missing.length > 1 ? "them" : "it"} and pass without running. Release a newer commit, or tag by hand after running the suites that exist there.`,
    );
  }
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
  seedDigest: string;
  ignoredTags: string[];
  note: string;
};

export type PlanOptions = {
  ref: string;
  version?: string;
  note?: string;
  mainRef?: string;
  remote?: string;
  /** test.yml's text (null: the file is absent). Undefined skips the suite-directory check (library use only; the CLI always passes it). */
  testWorkflow?: string | null;
};

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
  const ignoredTags = tags.filter((t) => t.name.startsWith("v") && !RELEASE_TAG_RE.test(t.name)).map((t) => clean(t.name, MAX_TAG_NAME));

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
        `${commit.slice(0, 7)} does not contain the latest release tag ${previous.name} (${previous.commit.slice(0, 7)}). A new release must be at or after the latest one; tag by hand if this is really intended.`,
      );
    }
  }

  if (opts.testWorkflow !== undefined) checkSuiteDirs(git, commit, opts.testWorkflow);

  const range = previous ? [`${previous.commit}..${commit}`] : [commit];
  const commits = git(["log", "--no-color", "--format=%H%x09%s", ...range, "--"]).stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf("\t");
      return { sha: line.slice(0, i), subject: clean(line.slice(i + 1), MAX_SUBJECT) };
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
    seedDigest: seedDigest(previous?.name ?? null, seeds),
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
  "Roll compares the seed files with what the residents run now (EDGE_HERMES_REF, a tag or a branch tip), not with the previous tag: " +
  "it can name a file this check calls unchanged, and it refuses with seed_uncomparable when it cannot read that ref. " +
  `How to check the data pipeline's release: ${DOCS_PATH}, "The data pipeline".`;

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
    `Seed check: ${seedLine(plan.seeds, plan.previous?.name ?? null)}`,
    ...seedDetail(plan.seeds).map((l) => `  ${l}`),
    ROLL_CAVEAT,
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
    seedLine(plan.seeds, plan.previous?.name ?? null),
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

/**
 * Markdown for $GITHUB_STEP_SUMMARY. Everything that came from the repository
 * or an input is a code span, or a line of the fenced commit list, with
 * backticks and angle brackets neutralised (so it can neither close the span
 * or fence nor become HTML, a link or an image).
 */
export function renderSummary(plan: Plan, stage: Stage): string {
  const fence = "````";
  const commits = commitLines(plan, "").map((l) => neutral(l, MAX_SUBJECT + 20));
  const lines = [
    `## Tag release: ${headline(plan, stage)}`,
    "",
    "| | |",
    "|---|---|",
    `| Tag | \`${plan.version}\` (annotated) |`,
    `| Commit | \`${plan.commit}\` (from ${plan.refKind} \`${plan.ref}\`, on main) |`,
    `| Previous release | ${plan.previous ? `\`${plan.previous.name}\` (\`${plan.previous.commit.slice(0, 7)}\`)` : "none"} |`,
    `| Commits | ${sinceText(plan)} |`,
    ...(plan.note ? [`| Note | ${code(plan.note, NOTE_MAX)} |`] : []),
    "",
    `**Seed check.** ${code(seedLine(plan.seeds, plan.previous?.name ?? null), 2000)}`,
    "",
    ...seedDetail(plan.seeds).map((l) => `- ${code(l, 300)}`),
    "",
    ROLL_CAVEAT,
    "",
    ...notes(plan).flatMap((l) => [code(l, 2000), ""]),
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
  /** The plan job's seedDigest; when given, a different fresh digest refuses. */
  expectSeeds?: string;
  actor: string;
  triggeringActor?: string;
  runUrl: string;
  fetch?: boolean;
};

export function createTag(git: Git, opts: TagOptions): { plan: Plan; tagObject: string } {
  const remote = opts.remote ?? "origin";
  if (!FULL_SHA_RE.test(opts.expectCommit)) throw new Refusal("bad_usage", "--expect-commit must be a full commit id.");
  if (!isCanonical(opts.expectVersion)) throw new Refusal("bad_usage", "--expect-version must be a release version.");
  if (opts.expectSeeds !== undefined && !/^[0-9a-f]{64}$/.test(opts.expectSeeds)) throw new Refusal("bad_usage", "--expect-seeds must be the plan's seed digest.");
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
  if (opts.expectSeeds !== undefined && plan.seedDigest !== opts.expectSeeds) {
    throw new Refusal(
      "plan_changed",
      `The seed check differs from the one this run planned (the previous release tag moved or changed since). Nothing was created. Run Tag release again and read the new seed check.`,
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
  tag: ["ref", "version", "note", "cwd", "main", "remote", "expect-commit", "expect-version", "expect-seeds", "actor", "triggering-actor", "run-url", "fetch"],
} as const;

function emit(path: string | undefined, text: string) {
  if (path) appendFileSync(path, text);
}

/**
 * Prints text that carries repository content. Under GitHub Actions it is
 * wrapped in ::stop-commands:: with a fresh random token, so nothing in it is
 * read as a workflow command (on top of the per-field cleaning).
 */
function printRepoText(text: string, env: Record<string, string | undefined>) {
  if (env.GITHUB_ACTIONS !== "true") {
    process.stdout.write(text);
    return;
  }
  const token = randomBytes(16).toString("hex");
  process.stdout.write(`::stop-commands::${token}\n${text}::${token}::\n`);
}

/**
 * The refusal as one stderr line, whatever the message carries (a raw input,
 * git's or the remote's own words): cleaned, and under Actions an ::error
 * annotation with GitHub's command escaping on the title and the data.
 */
export function refusalLine(e: Refusal, env: Record<string, string | undefined>): string {
  const msg = clean(e.message, 1000);
  if (env.GITHUB_ACTIONS !== "true") return `Refused (${clean(e.code, 64)}): ${msg}`;
  return `::error title=${escapeProperty(`Tag release refused (${clean(e.code, 64)})`)}::${escapeData(msg)}`;
}

function readTestWorkflow(cwd: string): string | null {
  const path = join(cwd, TEST_WORKFLOW);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

export function main(argv: string[], env: Record<string, string | undefined> = process.env): number {
  const summaryPath = env.GITHUB_STEP_SUMMARY || undefined;
  try {
    const { cmd, flags } = parseArgs(argv);
    if (cmd !== "plan" && cmd !== "tag") throw new Refusal("bad_usage", "Usage: tag-release.ts plan|tag --ref <ref> [...] (see the header of scripts/tag-release.ts).");
    for (const k of flags.keys()) {
      if (!(KNOWN[cmd] as readonly string[]).includes(k)) throw new Refusal("bad_usage", `Unknown option --${k} for ${cmd}.`);
    }
    const cwd = flags.get("cwd") ?? ".";
    const git = gitIn(cwd);
    const common = {
      ref: flags.get("ref") ?? "",
      version: flags.get("version") ?? "",
      note: flags.get("note") ?? "",
      mainRef: flags.get("main") ?? "refs/remotes/origin/main",
      remote: flags.get("remote") ?? "origin",
      testWorkflow: readTestWorkflow(cwd),
    };
    if (cmd === "plan") {
      const dry = flags.get("dry-run") ?? "true";
      if (dry !== "true" && dry !== "false") throw new Refusal("bad_usage", "--dry-run must be true or false.");
      const plan = makePlan(git, common);
      const stage: Stage = dry === "true" ? "dry-run" : "planned";
      printRepoText(renderText(plan, stage), env);
      emit(
        env.GITHUB_OUTPUT,
        `commit=${plan.commit}\nversion=${plan.version}\nprevious=${plan.previous?.name ?? ""}\nseed_changed=${plan.seedChanged}\nseeds=${plan.seedDigest}\n`,
      );
      emit(summaryPath, renderSummary(plan, stage));
      return 0;
    }
    const { plan, tagObject } = createTag(git, {
      ...common,
      ref: flags.get("expect-commit") ?? "",
      expectCommit: flags.get("expect-commit") ?? "",
      expectVersion: flags.get("expect-version") ?? "",
      expectSeeds: flags.get("expect-seeds"),
      actor: flags.get("actor") ?? "",
      triggeringActor: flags.get("triggering-actor") || undefined,
      runUrl: flags.get("run-url") ?? "",
      fetch: flags.get("fetch") === "true",
    });
    printRepoText(`${renderText(plan, "created")}\nTag object ${tagObject}, pushed as refs/tags/${plan.version}.\n`, env);
    emit(summaryPath, renderSummary(plan, "created"));
    return 0;
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    process.stderr.write(`${refusalLine(e, env)}\n`);
    emit(summaryPath, `## Tag release refused: nothing was created\n\n**${e.code}.** ${code(e.message, 1000)}\n`);
    return e.code === "bad_usage" ? 2 : 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
