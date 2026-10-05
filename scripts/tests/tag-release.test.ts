import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  checkNote,
  chooseVersion,
  createTag,
  gitIn,
  makePlan,
  Refusal,
  renderSummary,
  renderText,
  seedLine,
  validRefInput,
} from "../tag-release.ts";

const SCRIPT = join(import.meta.dir, "..", "tag-release.ts");
const RUN_URL = "https://github.com/Edge-City/agentvillage/actions/runs/123";
let dirs: string[] = [];
// Each test builds real repositories with dozens of git processes; the 5 s default is tight under a loaded suite.
setDefaultTimeout(60_000);

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function refusalCode(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof Refusal) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

// ---------------------------------------------------------------------------
// Version arithmetic

describe("chooseVersion", () => {
  test("next release candidate after the highest", () => {
    expect(chooseVersion(["v2.0.0-rc1", "v2.0.0-rc10", "v2.0.0-rc9"], "")).toEqual({ version: "v2.0.0-rc11", highest: "v2.0.0-rc10", skips: null });
  });

  test("numeric, not string, order (rc9 < rc10)", () => {
    expect(chooseVersion(["v2.0.0-rc9", "v2.0.0-rc10"], "").version).toBe("v2.0.0-rc11");
  });

  test("gaps are not filled: highest + 1", () => {
    expect(chooseVersion(["v2.0.0-rc1", "v2.0.0-rc2", "v2.0.0-rc5"], "").version).toBe("v2.0.0-rc6");
  });

  test("a newer release line wins", () => {
    expect(chooseVersion(["v2.0.0-rc10", "v2.1.0-rc1", "v1.9.9-rc40"], "").version).toBe("v2.1.0-rc2");
    expect(chooseVersion(["v2.0.0-rc10", "v10.0.0-rc1"], "").version).toBe("v10.0.0-rc2");
  });

  test("non-release and malformed tags are ignored", () => {
    const tags = ["v2.0.0-rc3", "release-2026-10-01", "v2.0", "v2.0.0-rc", "v2.0.0-beta9", "V2.0.0-rc9", "v2.0.0-rc9x", "rc9", "v2.0.0-rc9-hotfix"];
    expect(chooseVersion(tags, "").version).toBe("v2.0.0-rc4");
  });

  test("a final version as the highest is refused without an explicit version", () => {
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc10", "v2.0.0"], ""))).toBe("highest_is_final");
    // the final sorts above any of its release candidates
    expect(refusalCode(() => chooseVersion(["v2.0.0", "v2.0.0-rc12"], ""))).toBe("highest_is_final");
  });

  test("a final below a newer release candidate does not block", () => {
    expect(chooseVersion(["v2.0.0", "v2.1.0-rc3"], "").version).toBe("v2.1.0-rc4");
  });

  test("no release tag at all is refused without an explicit version", () => {
    expect(refusalCode(() => chooseVersion([], ""))).toBe("no_release_tags");
    expect(refusalCode(() => chooseVersion(["release-2026-10-01", "v2"], ""))).toBe("no_release_tags");
  });

  test("a non-canonical release tag (one Roll would accept) blocks the computation", () => {
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc10", "v2.0.0-rc011"], ""))).toBe("noncanonical_tags");
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc0"], ""))).toBe("noncanonical_tags");
    expect(refusalCode(() => chooseVersion(["v02.0.0-rc1"], ""))).toBe("noncanonical_tags");
  });

  test("override: a higher canonical version is taken; a skip is reported", () => {
    expect(chooseVersion(["v2.0.0-rc10"], "v2.0.0-rc11")).toEqual({ version: "v2.0.0-rc11", highest: "v2.0.0-rc10", skips: null });
    expect(chooseVersion(["v2.0.0-rc10"], "v2.0.0-rc13")).toEqual({ version: "v2.0.0-rc13", highest: "v2.0.0-rc10", skips: "v2.0.0-rc11" });
    expect(chooseVersion(["v2.0.0-rc10"], "v2.0.0").version).toBe("v2.0.0");
    expect(chooseVersion(["v2.0.0"], "v2.0.1-rc1").version).toBe("v2.0.1-rc1");
    expect(chooseVersion([], "v2.0.0-rc1")).toEqual({ version: "v2.0.0-rc1", highest: null, skips: null });
    expect(chooseVersion(["v2.0.0-rc011"], "v2.0.0-rc12").version).toBe("v2.0.0-rc12");
  });

  test("override: an existing version is refused, also under another spelling", () => {
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc10", "v2.0.0-rc11"], "v2.0.0-rc11"))).toBe("version_exists");
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc011"], "v2.0.0-rc11"))).toBe("version_exists");
  });

  test("override: a lower version is refused", () => {
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc10"], "v2.0.0-rc9"))).toBe("version_not_higher");
    expect(refusalCode(() => chooseVersion(["v2.0.0"], "v2.0.0-rc99"))).toBe("version_not_higher");
    expect(refusalCode(() => chooseVersion(["v2.1.0-rc1"], "v2.0.9"))).toBe("version_not_higher");
  });

  test("override: anything but a canonical release version is refused", () => {
    for (const bad of ["2.0.0-rc11", "v2.0.0-rc01", "v2.0.0-rc0", "v2.0.0-RC11", "v2.0.0-rc11 ", "v2.0.0-rc11;x", "v2.0", "release-2026-10-04", "v2.0.0-beta1", "-v2.0.0"]) {
      expect(refusalCode(() => chooseVersion(["v2.0.0-rc10"], bad))).toBe("bad_version");
    }
  });
});

describe("checkNote", () => {
  test("accepts one plain line up to 200 characters; empty is no note", () => {
    expect(checkNote("")).toBe("");
    const ok = "Excludes 1a040b9 (Index flow retirement; its tests are red on main): rc10 + #172, 100% & done? yes! a/b_c+d=e 'q' @x";
    expect(checkNote(ok)).toBe(ok);
    expect(checkNote("x".repeat(200))).toBe("x".repeat(200));
  });
  test("refuses control characters, other characters, length and a leading '-', '#' or space", () => {
    for (const bad of [
      "line one\nline two",
      "a\rb",
      "tab\there",
      "nul\u0000",
      "del\u007f",
      "x".repeat(201),
      "-x",
      "--force",
      "# heading",
      "#1",
      " leading space",
      "back`tick",
      "$(id)",
      "a|b",
      "<script>",
      'double "quote"',
      "back\\slash",
      "caf\u00e9",
      "emoji \u{1F600}",
      "a\u2028b",
    ]) {
      expect(refusalCode(() => checkNote(bad))).toBe("bad_note");
    }
    expect(() => checkNote("a\nb")).toThrow("one line with no control characters");
  });
});

describe("validRefInput", () => {
  test("accepts branch, tag and commit forms", () => {
    for (const ok of ["main", "v2.0.0-rc10", "carter/tag-release", "2ef2194", "a".repeat(40)]) expect(validRefInput(ok)).toBe(true);
  });
  test("refuses option, range, reflog and odd forms", () => {
    for (const bad of ["", "-x", "--upload-pack=x", "main..x", "main...x", "HEAD@{1}", "a b", "x/", "x.", "x.lock", "a//b", "main~1", "main^", "$(id)", "a;b", "/abs"]) {
      expect(validRefInput(bad)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Temporary repositories

type Fixture = { origin: string; work: string; run: (args: string[], cwd?: string) => string; commit: (files: Record<string, string | null>, subject: string) => string };

function sh(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function seed(version: string, extra = ""): string {
  return JSON.stringify({ version, categories: { a: extra } }, null, 2) + "\n";
}

function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "tag-release-test-"));
  dirs.push(root);
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  sh(root, ["init", "--quiet", "--bare", "--initial-branch=main", origin]);
  sh(root, ["init", "--quiet", "--initial-branch=main", work]);
  for (const [k, v] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"], ["tag.gpgsign", "false"]]) sh(work, ["config", k, v]);
  sh(work, ["remote", "add", "origin", origin]);
  const run = (args: string[], cwd = work) => sh(cwd, args);
  const commit = (files: Record<string, string | null>, subject: string) => {
    for (const [p, content] of Object.entries(files)) {
      const full = join(work, p);
      if (content === null) rmSync(full);
      else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, content);
      }
    }
    sh(work, ["add", "-A"]);
    sh(work, ["commit", "--quiet", "--allow-empty", "-m", subject]);
    return sh(work, ["rev-parse", "HEAD"]);
  };
  return { origin, work, run, commit };
}

const TC = "plugins/av-events/tool_categories.json";
const AL = "plugins/av-events/edgeos_tool_allowlist.json";
const CJ = "plugins/av-events/cron_job_names.json";

/** main: A (rc1) - B (tool_categories v1 -> v2) - C, pushed, fetched back. */
function released(): Fixture & { a: string; b: string; c: string } {
  const f = fixture();
  const a = f.commit({ [TC]: seed("tool_categories_v1"), [AL]: seed("edgeos_tool_allowlist_v1"), [CJ]: seed("cron_job_names_v1"), "README.md": "x\n" }, "first");
  f.run(["tag", "-a", "v2.0.0-rc1", "-m", "rc1", a]);
  const b = f.commit({ [TC]: seed("tool_categories_v2") }, "DATA-1: tool categories v2 (#1)");
  const c = f.commit({ "README.md": "y\n" }, "DATA-2: readme `code` # not a comment (#2)");
  f.run(["push", "--quiet", "origin", "main", "--tags"]);
  f.run(["fetch", "--quiet", "origin"]);
  return { ...f, a, b, c };
}

function originRefs(f: Fixture): string {
  return sh(f.origin, ["for-each-ref", "--format=%(refname) %(objectname)"]);
}

// ---------------------------------------------------------------------------
// The plan

describe("makePlan", () => {
  test("plans the next rc at main with the commits and the seed change", () => {
    const f = released();
    const plan = makePlan(gitIn(f.work), { ref: "main" });
    expect(plan.commit).toBe(f.c);
    expect(plan.refKind).toBe("branch");
    expect(plan.version).toBe("v2.0.0-rc2");
    expect(plan.previous).toEqual({ name: "v2.0.0-rc1", commit: f.a });
    expect(plan.commits.map((c) => c.sha)).toEqual([f.c, f.b]);
    expect(plan.commits[1].subject).toBe("DATA-1: tool categories v2 (#1)");
    expect(plan.seedChanged).toBe(true);
    expect(plan.seeds.map((s) => s.changed)).toEqual([true, false, false]);
    expect(seedLine(plan.seeds)).toBe(
      "Roll input allow_seed_change: tick it ONLY after the data pipeline release carries tool_categories.json tool_categories_v2.",
    );
    const text = renderText(plan, "dry-run");
    expect(text).toContain("would create v2.0.0-rc2");
    expect(text).toContain("tool_categories.json: tool_categories_v1 -> tool_categories_v2 (changed)");
    expect(text).toContain("edgeos_tool_allowlist.json: edgeos_tool_allowlist_v1 (unchanged)");
    expect(text).toContain("Nothing was created");
    expect(text).toContain("docs/deployment.md");
    const md = renderSummary(plan, "dry-run");
    expect(md).toContain("would create v2.0.0-rc2");
    expect(md).toContain("readme 'code'"); // backticks neutralised inside the fence
    expect(renderSummary(plan, "created")).toContain("https://github.com/Edge-City/agentvillage-controlplane/actions/workflows/roll.yml");
    expect(renderSummary(plan, "created")).toContain("tag: v2.0.0-rc2; dry_run: on; scope: test-tenants; allow_seed_change: ticked ONLY");
  });

  test("no seed change says to leave allow_seed_change off", () => {
    const f = released();
    f.run(["tag", "-a", "v2.0.0-rc2", "-m", "rc2", f.b]);
    const d = f.commit({ "README.md": "z\n" }, "DATA-3: z");
    f.run(["push", "--quiet", "origin", "main", "--tags"]);
    f.run(["fetch", "--quiet", "origin"]);
    const plan = makePlan(gitIn(f.work), { ref: "main" });
    expect(plan.commit).toBe(d);
    expect(plan.version).toBe("v2.0.0-rc3");
    expect(plan.seedChanged).toBe(false);
    expect(seedLine(plan.seeds)).toBe("Roll input allow_seed_change: no seed change; leave allow_seed_change off.");
    expect(renderSummary(plan, "created")).toContain("allow_seed_change: off");
  });

  test("seed content changed with the same version string, removed, added", () => {
    const f = released();
    f.commit({ [TC]: seed("tool_categories_v2", "more"), [CJ]: null }, "same version, new content; cron names removed");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    f.run(["tag", "-a", "v2.0.0-rc2", "-m", "rc2", f.c]);
    const line = seedLine(makePlan(gitIn(f.work), { ref: "main" }).seeds);
    expect(line).toContain("tool_categories.json tool_categories_v2 (content changed, version string unchanged: confirm with the data owner)");
    expect(line).toContain("cron_job_names.json removed");

    const g = fixture();
    const a = g.commit({ "README.md": "x\n" }, "first");
    g.run(["tag", "-a", "v2.0.0-rc1", "-m", "rc1", a]);
    g.commit({ [AL]: seed("edgeos_tool_allowlist_v1") }, "allowlist added");
    g.run(["push", "--quiet", "origin", "main", "--tags"]);
    g.run(["fetch", "--quiet", "origin"]);
    const plan = makePlan(gitIn(g.work), { ref: "main" });
    expect(seedLine(plan.seeds)).toBe("Roll input allow_seed_change: tick it ONLY after the data pipeline release carries edgeos_tool_allowlist.json edgeos_tool_allowlist_v1.");
    expect(renderText(plan, "dry-run")).toContain("edgeos_tool_allowlist.json: (absent) -> edgeos_tool_allowlist_v1 (changed)");
  });

  test("a seed file that is not JSON is reported, not trusted", () => {
    const f = released();
    f.commit({ [TC]: "{not json" }, "broken");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    expect(seedLine(makePlan(gitIn(f.work), { ref: "main" }).seeds)).toContain("tool_categories.json (unreadable)");
  });

  test("resolves a full or short commit id and a tag name", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(makePlan(git, { ref: f.b }).commit).toBe(f.b);
    expect(makePlan(git, { ref: f.b.slice(0, 7) }).refKind).toBe("commit");
    f.run(["tag", "marker", f.c]);
    expect(makePlan(git, { ref: "marker" })).toMatchObject({ commit: f.c, refKind: "tag", version: "v2.0.0-rc2" });
  });

  test("refuses a ref that is not on main", () => {
    const f = released();
    f.run(["checkout", "--quiet", "-b", "feature"]);
    const x = f.commit({ "README.md": "feature\n" }, "unmerged");
    f.run(["push", "--quiet", "origin", "feature"]);
    f.run(["fetch", "--quiet", "origin"]);
    const git = gitIn(f.work);
    expect(refusalCode(() => makePlan(git, { ref: "feature" }))).toBe("not_on_main");
    expect(refusalCode(() => makePlan(git, { ref: x }))).toBe("not_on_main");
    // a local main that is ahead of the remote's does not count
    f.run(["checkout", "--quiet", "main"]);
    const y = f.commit({ "README.md": "local only\n" }, "local only");
    expect(refusalCode(() => makePlan(git, { ref: y }))).toBe("not_on_main");
  });

  test("refuses unknown, ambiguous and malformed refs", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(refusalCode(() => makePlan(git, { ref: "nope" }))).toBe("ref_not_found");
    expect(refusalCode(() => makePlan(git, { ref: "deadbeef" }))).toBe("ref_not_found");
    // a hex id that is not a commit's (here the rc1 tag object, which peels to a commit) is not taken as one
    expect(refusalCode(() => makePlan(git, { ref: f.run(["rev-parse", "refs/tags/v2.0.0-rc1"]).slice(0, 12) }))).toBe("ref_not_found");
    expect(refusalCode(() => makePlan(git, { ref: "" }))).toBe("bad_ref");
    expect(refusalCode(() => makePlan(git, { ref: "--upload-pack=touch" }))).toBe("bad_ref");
    expect(refusalCode(() => makePlan(git, { ref: "main~1" }))).toBe("bad_ref");
    f.run(["branch", "both", f.b]);
    f.run(["push", "--quiet", "origin", "both"]);
    f.run(["fetch", "--quiet", "origin"]);
    f.run(["tag", "both", f.b]);
    expect(refusalCode(() => makePlan(git, { ref: "both" }))).toBe("ref_ambiguous");
  });

  test("refuses a commit that already carries a release tag, and names it", () => {
    const f = released();
    const git = gitIn(f.work);
    try {
      makePlan(git, { ref: f.a });
      throw new Error("no refusal");
    } catch (e) {
      expect((e as Refusal).code).toBe("already_tagged");
      expect((e as Refusal).message).toContain("already tagged v2.0.0-rc1: roll that");
    }
    // a lightweight release tag counts too; a non-release tag does not
    f.run(["tag", "v2.0.0-rc2", f.c]);
    expect(refusalCode(() => makePlan(git, { ref: "main" }))).toBe("already_tagged");
    const g = released();
    g.run(["tag", "-a", "release-2026-10-04", "-m", "x", g.c]);
    expect(makePlan(gitIn(g.work), { ref: "main" }).version).toBe("v2.0.0-rc2");
  });

  test("refuses a commit before the previous release", () => {
    const f = released();
    f.run(["tag", "-a", "v2.0.0-rc2", "-m", "rc2", f.c]);
    expect(refusalCode(() => makePlan(gitIn(f.work), { ref: f.b }))).toBe("not_after_previous");
  });

  test("refuses when a branch has the new tag's name", () => {
    const f = released();
    f.run(["branch", "v2.0.0-rc2", f.b]);
    f.run(["push", "--quiet", "origin", "v2.0.0-rc2"]);
    f.run(["fetch", "--quiet", "origin"]);
    f.run(["branch", "-D", "v2.0.0-rc2"]);
    expect(refusalCode(() => makePlan(gitIn(f.work), { ref: f.c }))).toBe("tag_name_is_branch");
  });

  test("refuses when main is not fetched", () => {
    const f = fixture();
    f.commit({ "README.md": "x\n" }, "first");
    expect(refusalCode(() => makePlan(gitIn(f.work), { ref: "main" }))).toBe("main_missing");
  });

  test("version override and its refusals in a real repository", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(makePlan(git, { ref: "main", version: "v2.0.0-rc5" })).toMatchObject({ version: "v2.0.0-rc5", skips: "v2.0.0-rc2" });
    expect(renderText(makePlan(git, { ref: "main", version: "v2.0.0-rc5" }), "dry-run")).toContain("skips v2.0.0-rc2");
    expect(refusalCode(() => makePlan(git, { ref: "main", version: "v2.0.0-rc1" }))).toBe("version_exists");
    expect(refusalCode(() => makePlan(git, { ref: "main", version: "v1.0.0" }))).toBe("version_not_higher");
    expect(refusalCode(() => makePlan(git, { ref: "main", version: "rc2" }))).toBe("bad_version");
  });

  test("lists other v-tags it ignored", () => {
    const f = released();
    f.run(["tag", "v2.0.0-beta1", f.b]);
    expect(renderText(makePlan(gitIn(f.work), { ref: "main" }), "dry-run")).toContain("Ignored tags that are not release tags: v2.0.0-beta1.");
  });

  test("the plan never writes to the repository or the remote", () => {
    const f = released();
    const before = [originRefs(f), f.run(["for-each-ref"]), f.run(["status", "--porcelain"])];
    makePlan(gitIn(f.work), { ref: "main" });
    expect([originRefs(f), f.run(["for-each-ref"]), f.run(["status", "--porcelain"])]).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Creating the tag

const who = { actor: "octocat", runUrl: RUN_URL };

describe("createTag", () => {
  test("creates an annotated tag naming actor, run, commit, seed line and commits, and pushes only the tag", () => {
    const f = released();
    // a local main ahead of the remote's, and a local branch: neither may reach the remote
    f.commit({ "README.md": "local\n" }, "local only");
    f.run(["branch", "local-branch"]);
    const before = sh(f.origin, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
    const { plan, tagObject } = createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", fetch: true, ...who });
    expect(plan.version).toBe("v2.0.0-rc2");
    expect(sh(f.origin, ["cat-file", "-t", "refs/tags/v2.0.0-rc2"])).toBe("tag");
    expect(sh(f.origin, ["rev-parse", "refs/tags/v2.0.0-rc2"])).toBe(tagObject);
    expect(sh(f.origin, ["rev-parse", "refs/tags/v2.0.0-rc2^{commit}"])).toBe(f.c);
    expect(sh(f.origin, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"])).toBe(before);
    const body = sh(f.origin, ["cat-file", "-p", "refs/tags/v2.0.0-rc2"]);
    expect(body).toContain("tagger Test <test@example.invalid>");
    expect(body).toContain("v2.0.0-rc2: 2 commits since v2.0.0-rc1, tagged with the Tag release button");
    expect(body).toContain("Run by: octocat");
    expect(body).toContain(`Run: ${RUN_URL}`);
    expect(body).toContain(`Commit: ${f.c}`);
    expect(body).toContain(`Previous release: v2.0.0-rc1 (${f.a})`);
    expect(body).toContain("Seed check: Roll input allow_seed_change: tick it ONLY after the data pipeline release carries tool_categories.json tool_categories_v2.");
    expect(body).toContain(`  ${f.b.slice(0, 7)} DATA-1: tool categories v2 (#1)`);
    expect(body).toContain(`  ${f.c.slice(0, 7)} DATA-2: readme \`code\` # not a comment (#2)`);
  });

  test("a note goes on its own Note: line; a bad note refuses before anything is created", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(renderText(makePlan(git, { ref: "main", note: "first cut for the canaries" }), "dry-run")).toContain("  note         first cut for the canaries");
    expect(renderSummary(makePlan(git, { ref: "main", note: "first cut" }), "dry-run")).toContain("| Note | first cut |");
    expect(refusalCode(() => makePlan(git, { ref: "main", note: "a\nRun by: someone-else" }))).toBe("bad_note");
    expect(refusalCode(() => createTag(git, { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", ...who, note: "-x" }))).toBe("bad_note");
    expect(sh(f.origin, ["tag", "-l", "v2.0.0-rc*"])).toBe("v2.0.0-rc1");
    createTag(git, { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", ...who, note: "Excludes 1a040b9 (its tests are red on main)" });
    const body = sh(f.origin, ["cat-file", "-p", "refs/tags/v2.0.0-rc2"]);
    expect(body).toContain(`Previous release: v2.0.0-rc1 (${f.a})\nNote: Excludes 1a040b9 (its tests are red on main)\n`);
    // without a note there is no Note: line
    const g = released();
    createTag(gitIn(g.work), { ref: g.c, expectCommit: g.c, expectVersion: "v2.0.0-rc2", ...who });
    expect(sh(g.origin, ["cat-file", "-p", "refs/tags/v2.0.0-rc2"])).not.toContain("Note:");
  });

  test("a re-run names both actors", () => {
    const f = released();
    createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", ...who, triggeringActor: "hubot" });
    expect(sh(f.origin, ["cat-file", "-p", "refs/tags/v2.0.0-rc2"])).toContain("Run by: octocat (re-run by hubot)");
  });

  test("loses cleanly when another run tagged meanwhile (seen by the fetch)", () => {
    const f = released();
    // someone else tags rc2 on B and pushes it after this run planned rc2 at C
    const other = join(dirname(f.work), "other");
    sh(dirname(f.work), ["clone", "--quiet", f.origin, other]);
    for (const [k, v] of [["user.name", "Other"], ["user.email", "o@example.invalid"]]) sh(other, ["config", k, v]);
    sh(other, ["tag", "-a", "v2.0.0-rc2", "-m", "theirs", f.b]);
    sh(other, ["push", "--quiet", "origin", "v2.0.0-rc2"]);
    const before = originRefs(f);
    expect(refusalCode(() => createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", fetch: true, ...who }))).toBe("plan_changed");
    expect(originRefs(f)).toBe(before);
    // and when they tagged the same commit, it is already tagged
    const g = released();
    const other2 = join(dirname(g.work), "other");
    sh(dirname(g.work), ["clone", "--quiet", g.origin, other2]);
    for (const [k, v] of [["user.name", "Other"], ["user.email", "o@example.invalid"]]) sh(other2, ["config", k, v]);
    sh(other2, ["tag", "-a", "v2.0.0-rc2", "-m", "theirs", g.c]);
    sh(other2, ["push", "--quiet", "origin", "v2.0.0-rc2"]);
    expect(refusalCode(() => createTag(gitIn(g.work), { ref: g.c, expectCommit: g.c, expectVersion: "v2.0.0-rc2", fetch: true, ...who }))).toBe("already_tagged");
  });

  test("loses cleanly when the tag appears between the fetch and the push", () => {
    const f = released();
    const other = join(dirname(f.work), "other");
    sh(dirname(f.work), ["clone", "--quiet", f.origin, other]);
    for (const [k, v] of [["user.name", "Other"], ["user.email", "o@example.invalid"]]) sh(other, ["config", k, v]);
    sh(other, ["tag", "-a", "v2.0.0-rc2", "-m", "theirs", f.b]);
    sh(other, ["push", "--quiet", "origin", "v2.0.0-rc2"]);
    const theirs = sh(f.origin, ["rev-parse", "refs/tags/v2.0.0-rc2"]);
    const before = originRefs(f);
    // no fetch: this run still believes rc2 is free
    expect(refusalCode(() => createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", ...who }))).toBe("push_rejected");
    expect(originRefs(f)).toBe(before);
    expect(sh(f.origin, ["rev-parse", "refs/tags/v2.0.0-rc2"])).toBe(theirs);
    expect(spawnSync("git", ["-C", f.work, "rev-parse", "--verify", "--quiet", "refs/tags/v2.0.0-rc2"]).status).not.toBe(0);
  });

  test("refuses when main moved under a plan for a stale expectation", () => {
    const f = released();
    expect(refusalCode(() => createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc3", ...who }))).toBe("plan_changed");
    expect(sh(f.origin, ["tag", "-l", "v2.0.0-rc*"])).toBe("v2.0.0-rc1");
  });

  test("validates its inputs before touching anything", () => {
    const f = released();
    const git = gitIn(f.work);
    const ok = { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", ...who };
    for (const bad of [
      { expectCommit: f.c.slice(0, 7) },
      { expectVersion: "rc2" },
      { actor: "a b" },
      { actor: "x\nRun: https://evil" },
      { triggeringActor: "-x" },
      { runUrl: "https://example.com/actions/runs/1" },
      { runUrl: `${RUN_URL}\nx` },
    ]) {
      expect(refusalCode(() => createTag(git, { ...ok, ...bad }))).toBe("bad_usage");
    }
    expect(sh(f.origin, ["tag", "-l", "v2.0.0-rc*"])).toBe("v2.0.0-rc1");
  });
});

// ---------------------------------------------------------------------------
// The command line, as the workflow runs it

function cli(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync("bun", [SCRIPT, ...args], { encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "", GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe("command line", () => {
  test("plan writes the outputs and the summary; exit 0", () => {
    const f = released();
    const out = join(dirname(f.work), "out");
    const sum = join(dirname(f.work), "summary.md");
    writeFileSync(out, "");
    writeFileSync(sum, "");
    const r = cli(["plan", "--cwd", f.work, "--ref", "main", "--dry-run", "true"], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Dry run: would create v2.0.0-rc2");
    expect(readFileSync(out, "utf8")).toBe(`commit=${f.c}\nversion=v2.0.0-rc2\nprevious=v2.0.0-rc1\nseed_changed=true\n`);
    expect(readFileSync(sum, "utf8")).toContain("## Tag release: Dry run: would create v2.0.0-rc2");
    const real = cli(["plan", "--cwd", f.work, "--ref", "main", "--dry-run", "false"]);
    expect(real.stdout).toContain("Will create v2.0.0-rc2");
  });

  test("a refusal exits 1, writes the summary and no outputs", () => {
    const f = released();
    const out = join(dirname(f.work), "out");
    const sum = join(dirname(f.work), "summary.md");
    writeFileSync(out, "");
    writeFileSync(sum, "");
    const r = cli(["plan", "--cwd", f.work, "--ref", f.a], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_ACTIONS: "true" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("::error title=Tag release refused (already_tagged)::");
    expect(readFileSync(out, "utf8")).toBe("");
    expect(readFileSync(sum, "utf8")).toContain("nothing was created");
  });

  test("--note reaches the plan and the tag; a bad note exits 1", () => {
    const f = released();
    expect(cli(["plan", "--cwd", f.work, "--ref", "main", "--note", "for the canaries"]).stdout).toContain("note         for the canaries");
    expect(cli(["plan", "--cwd", f.work, "--ref", "main", "--note", ""]).code).toBe(0);
    const bad = cli(["plan", "--cwd", f.work, "--ref", "main", "--note", "#x"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("Refused (bad_note)");
    const r = cli(["tag", "--cwd", f.work, "--expect-commit", f.c, "--expect-version", "v2.0.0-rc2", "--actor", "octocat", "--run-url", RUN_URL, "--note", "hello there"]);
    expect(r.code).toBe(0);
    expect(sh(f.origin, ["cat-file", "-p", "refs/tags/v2.0.0-rc2"])).toContain("\nNote: hello there\n");
  });

  test("bad usage exits 2", () => {
    const f = released();
    expect(cli(["plan", "--cwd", f.work, "--ref", "main", "--dry-run", "yes"]).code).toBe(2);
    expect(cli(["plan", "--cwd", f.work, "--ref", "main", "--force", "true"]).code).toBe(2);
    expect(cli(["push", "--cwd", f.work]).code).toBe(2);
    expect(cli(["plan", "--cwd", f.work, "--ref"]).code).toBe(2);
  });

  test("tag creates and pushes the tag; exit 0", () => {
    const f = released();
    const r = cli(["tag", "--cwd", f.work, "--expect-commit", f.c, "--expect-version", "v2.0.0-rc2", "--actor", "octocat", "--run-url", RUN_URL, "--fetch"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Created v2.0.0-rc2");
    expect(sh(f.origin, ["rev-parse", "refs/tags/v2.0.0-rc2^{commit}"])).toBe(f.c);
  });
});
