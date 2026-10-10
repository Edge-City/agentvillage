import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Api,
  type Git,
  compareTestWorkflow,
  findTestedRun,
  main,
  runUrl,
  testedLine,
  checkNote,
  checkSuiteDirs,
  chooseVersion,
  clean,
  escapeData,
  escapeProperty,
  neutral,
  refusalLine,
  seedVersionOf,
  suiteDirs,
  tagMessage,
  topLevelKeys,
  UNREADABLE_VERSION,
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

  test("a tag Roll would accept with a number over 6 digits refuses computation and override", () => {
    for (const odd of ["v2.0.0-rc1234567", "v1234567.0.0", "v2.0.0000000-rc1"]) {
      expect(refusalCode(() => chooseVersion(["v2.0.0-rc10", odd], ""))).toBe("oversize_tags");
      expect(refusalCode(() => chooseVersion(["v2.0.0-rc10", odd], "v3.0.0-rc1"))).toBe("oversize_tags");
    }
    // 6 digits is fine; an override over 6 digits is not a release version
    expect(chooseVersion(["v2.0.0-rc123456"], "").version).toBe("v2.0.0-rc123457");
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc10"], "v2.0.0-rc1000000"))).toBe("bad_version");
  });

  test("the computed version is checked again: rc999999 + 1 has 7 digits and is refused", () => {
    expect(refusalCode(() => chooseVersion(["v2.0.0-rc999999"], ""))).toBe("version_check_failed");
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

describe("output hygiene", () => {
  test("clean turns controls, DEL and Unicode line breaks into spaces and clips", () => {
    expect(clean("a\r::error ::x\nb\tc\u0000d\u007fe\u2028f\u0085g", 100)).toBe("a ::error ::x b c d e f g");
    expect(clean("x".repeat(10), 8)).toBe("xxxxx...");
    expect(neutral("a`b<c>d\n", 100)).toBe("a'b\u2039c\u203ad ");
  });

  test("clean turns C1 controls into spaces and removes bidi and zero-width characters", () => {
    expect(clean("a\u0080b\u009fc\u0090d", 100)).toBe("a b c d");
    expect(clean("ok\u202eevil\u202c|\u2066x\u2069|\u202a\u202b\u202d\u2067\u2068|z\u200bw\u200c\u200d\ufeffv", 100)).toBe("okevil|x||zwv");
    expect(clean("caf\u00e9 \u00a0 \u2014", 100)).toBe("caf\u00e9 \u00a0 \u2014"); // printable non-ASCII stays
  });

  test("GitHub command escaping for data and properties", () => {
    expect(escapeData("100% a\rb\nc")).toBe("100%25 a%0Db%0Ac");
    expect(escapeProperty("a: b, c%")).toBe("a%3A b%2C c%25");
  });

  test("a refusal is one annotation line: cleaned, then escaped", () => {
    const e = new Refusal("x_code", "first\nsecond\r::warning::y %0A::warning::x");
    const line = refusalLine(e, { GITHUB_ACTIONS: "true" });
    expect(line).toBe("::error title=Tag release refused (x_code)::first second ::warning::y %250A::warning::x");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("%0A");
    expect(refusalLine(new Refusal("a,b:c", "m"), { GITHUB_ACTIONS: "true" })).toBe("::error title=Tag release refused (a%2Cb%3Ac)::m");
    expect(refusalLine(e, {})).toBe("Refused (x_code): first second ::warning::y %0A::warning::x");
  });

  test("a seed version must be one plain top-level string", () => {
    expect(seedVersionOf('{"version":"tool_categories_v3","x":{"version":"nested"}}')).toBe("tool_categories_v3");
    for (const bad of [
      '{"version":"v2\\n::warning title=Seed check::no seed change, leave allow_seed_change off\\n![x](https://e.example/beacon.png)"}',
      '{"version":"tool_categories_v3","version":"tool_categories_v2"}',
      '{"\\u0076ersion":"a","version":"b"}',
      '{"version":"has space"}',
      '{"version":"' + "x".repeat(65) + '"}',
      '{"version":""}',
      '{"version":3}',
      '{"other":"x"}',
      "{not json",
      '["version"]',
    ]) {
      expect(seedVersionOf(bad)).toBe(UNREADABLE_VERSION);
    }
    expect(topLevelKeys('{"a":1,"b":{"c":2},"a":"x:y","d":["e",{"f":1}]}')).toEqual(["a", "b", "a", "d"]);
  });

  test("suiteDirs reads the one bun test line; this repository's test.yml lists the five suite directories", () => {
    const real = readFileSync(join(import.meta.dir, "..", "..", ".github", "workflows", "test.yml"), "utf8");
    expect(suiteDirs(real)).toEqual(["install/tests", "scripts/tests", "skills/index-network/scripts/tests", "skills/recall/scripts/tests", "skills/edge-india/scripts/tests", "skills/agent-profile/scripts/tests"]);
    expect(suiteDirs("      - run: bun install\n")).toBeNull();
    expect(suiteDirs("- run: bun test a\n- run: bun test b\n")).toBeNull();
    expect(suiteDirs("- run: bun test a $(id)\n")).toBeNull();
    expect(suiteDirs("- run: bun test ../x\n")).toBeNull();
    expect(suiteDirs("- run: bun test --bail a\n")).toBeNull();
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
const TEST_YML = ".github/workflows/test.yml";
const TEST_YML_TEXT = "jobs:\n  bun:\n    steps:\n      - run: bun install --frozen-lockfile\n      - run: bun test install/tests scripts/tests\n";

/** main: A (rc1) - B (tool_categories v1 -> v2) - C, pushed, fetched back. */
function released(): Fixture & { a: string; b: string; c: string } {
  const f = fixture();
  const a = f.commit(
    {
      [TC]: seed("tool_categories_v1"),
      [AL]: seed("edgeos_tool_allowlist_v1"),
      [CJ]: seed("cron_job_names_v1"),
      "README.md": "x\n",
      [TEST_YML]: TEST_YML_TEXT,
      "install/tests/a.test.ts": "\n",
      "scripts/tests/b.test.ts": "\n",
    },
    "first",
  );
  f.run(["tag", "-a", "v2.0.0-rc1", "-m", "rc1", a]);
  const b = f.commit({ [TC]: seed("tool_categories_v2") }, "DATA-1: tool categories v2 (#1)");
  const c = f.commit({ "README.md": "y\n" }, "DATA-2: readme `code` # not a comment (#2)");
  f.run(["push", "--quiet", "origin", "main", "--tags"]);
  f.run(["fetch", "--quiet", "origin"]);
  return { ...f, a, b, c };
}

function cloneOther(f: Fixture): string {
  const other = join(dirname(f.work), `other-${Math.random().toString(16).slice(2)}`);
  sh(dirname(f.work), ["clone", "--quiet", f.origin, other]);
  for (const [k, v] of [["user.name", "Other"], ["user.email", "o@example.invalid"]]) sh(other, ["config", k, v]);
  return other;
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
    expect(seedLine(plan.seeds, plan.previous?.name ?? null)).toBe(
      "Roll input allow_seed_change: tick it ONLY after the data pipeline release carries tool_categories.json tool_categories_v2 (changed since v2.0.0-rc1).",
    );
    const text = renderText(plan, "dry-run");
    expect(text).toContain("would create v2.0.0-rc2");
    expect(text).toContain("tool_categories.json: tool_categories_v1 to tool_categories_v2 (changed)");
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
    expect(seedLine(plan.seeds, plan.previous?.name ?? null)).toBe("Roll input allow_seed_change: no seed change since v2.0.0-rc2; leave allow_seed_change off.");
    expect(renderSummary(plan, "created")).toContain("allow_seed_change: off");
  });

  test("seed content changed with the same version string, removed, added", () => {
    const f = released();
    f.commit({ [TC]: seed("tool_categories_v2", "more"), [CJ]: null }, "same version, new content; cron names removed");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    f.run(["tag", "-a", "v2.0.0-rc2", "-m", "rc2", f.c]);
    const line = ((p) => seedLine(p.seeds, p.previous?.name ?? null))(makePlan(gitIn(f.work), { ref: "main" }));
    expect(line).toContain("tool_categories.json tool_categories_v2 (content changed, version string unchanged: confirm with the data owner)");
    expect(line).toContain("cron_job_names.json removed");

    const g = fixture();
    const a = g.commit({ "README.md": "x\n" }, "first");
    g.run(["tag", "-a", "v2.0.0-rc1", "-m", "rc1", a]);
    g.commit({ [AL]: seed("edgeos_tool_allowlist_v1") }, "allowlist added");
    g.run(["push", "--quiet", "origin", "main", "--tags"]);
    g.run(["fetch", "--quiet", "origin"]);
    const plan = makePlan(gitIn(g.work), { ref: "main" });
    expect(seedLine(plan.seeds, plan.previous?.name ?? null)).toBe("Roll input allow_seed_change: tick it ONLY after the data pipeline release carries edgeos_tool_allowlist.json edgeos_tool_allowlist_v1 (changed since v2.0.0-rc1).");
    expect(renderText(plan, "dry-run")).toContain("edgeos_tool_allowlist.json: (absent) to edgeos_tool_allowlist_v1 (changed)");
  });

  test("a seed file that is not JSON is reported, not trusted", () => {
    const f = released();
    f.commit({ [TC]: "{not json" }, "broken");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    expect(((p) => seedLine(p.seeds, p.previous?.name ?? null))(makePlan(gitIn(f.work), { ref: "main" }))).toContain("tool_categories.json (unreadable version)");
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

  test("refuses when a directory the suites run is missing at the commit", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(makePlan(git, { ref: "main", testWorkflow: TEST_YML_TEXT }).version).toBe("v2.0.0-rc2");
    const more = TEST_YML_TEXT.replace("bun test install/tests scripts/tests", "bun test install/tests scripts/tests skills/new/tests");
    expect(refusalCode(() => makePlan(git, { ref: "main", testWorkflow: more }))).toBe("suite_dir_missing");
    // a file is not a directory
    const file = TEST_YML_TEXT.replace("bun test install/tests scripts/tests", "bun test install/tests README.md");
    expect(refusalCode(() => makePlan(git, { ref: "main", testWorkflow: file }))).toBe("suite_dir_missing");
    // a directory with no test file would also run nothing
    f.commit({ "docs/tests/README.md": "x\n", "docs/tests/helper.ts": "\n", "docs/tests/deep/x.test.tsx": "\n" }, "no tests here");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    const empty = TEST_YML_TEXT.replace("bun test install/tests scripts/tests", "bun test install/tests docs/tests");
    expect(refusalCode(() => makePlan(git, { ref: "main", testWorkflow: empty }))).toBe("suite_dir_missing");
    f.commit({ "docs/tests/deep/y.test.js": "\n" }, "a nested js test");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    expect(makePlan(git, { ref: "main", testWorkflow: empty }).version).toBe("v2.0.0-rc2");
    expect(refusalCode(() => makePlan(git, { ref: "main", testWorkflow: null }))).toBe("suite_list_unreadable");
    expect(refusalCode(() => makePlan(git, { ref: "main", testWorkflow: "jobs: {}\n" }))).toBe("suite_list_unreadable");
    expect(() => checkSuiteDirs(git, f.c, TEST_YML_TEXT)).not.toThrow();
    // the directory exists at main but not at the commit being released
    f.commit({ "skills/new/tests/c.test.ts": "\n" }, "new suite");
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    expect(makePlan(git, { ref: "main", testWorkflow: more }).version).toBe("v2.0.0-rc2");
    expect(refusalCode(() => makePlan(git, { ref: f.c, testWorkflow: more }))).toBe("suite_dir_missing");
  });

  test("repository content cannot inject workflow commands or markdown", () => {
    const f = released();
    const evil = '{"version":"v2\\n::warning title=Seed check::no seed change, leave allow_seed_change off\\n![x](https://e.example/beacon.png)"}\n';
    f.commit({ [TC]: evil }, "evil seed\r::error ::x");
    f.run(["tag", "v<img>", f.b]);
    f.run(["tag", "v`tick`", f.b]);
    f.run(["push", "--quiet", "origin", "main"]);
    f.run(["fetch", "--quiet", "origin"]);
    const plan = makePlan(gitIn(f.work), { ref: "main" });
    expect(plan.seeds[0].after.version).toBe(UNREADABLE_VERSION);
    expect(plan.seedChanged).toBe(true);
    const outputs = [renderText(plan, "dry-run"), renderSummary(plan, "dry-run"), tagMessage(plan, who)];
    for (const out of outputs) {
      expect(out).not.toContain("\r");
      expect(out).not.toContain("beacon");
      expect(out).not.toMatch(/^\s*::/m);
      expect(out).toContain("tool_categories.json (unreadable version)");
    }
    const md = renderSummary(plan, "dry-run");
    expect(md).not.toContain("<img");
    expect(md).toContain("v\u2039img\u203a");
    expect(md).not.toContain("v`tick`");
    expect(renderText(plan, "dry-run")).toContain("evil seed ::error ::x");
  });

  test("an unreadable seed version counts as changed even when the file did not change", () => {
    const f = fixture();
    const a = f.commit({ [TC]: '{"version":"a","version":"b"}\n', "README.md": "x\n" }, "first");
    f.run(["tag", "-a", "v2.0.0-rc1", "-m", "rc1", a]);
    f.commit({ "README.md": "y\n" }, "second");
    f.run(["push", "--quiet", "origin", "main", "--tags"]);
    f.run(["fetch", "--quiet", "origin"]);
    const plan = makePlan(gitIn(f.work), { ref: "main" });
    expect(plan.seeds[0]).toMatchObject({ changed: true, after: { version: UNREADABLE_VERSION } });
    expect(seedLine(plan.seeds, "v2.0.0-rc1")).toContain("tool_categories.json (unreadable version) (read the file before rolling)");
  });

  test("a release tag on a commit no branch reaches blocks as not after it", () => {
    const f = released();
    const tree = f.run(["rev-parse", `${f.a}^{tree}`]);
    const dangling = f.run(["commit-tree", tree, "-p", f.a, "-m", "nowhere"]);
    f.run(["tag", "-a", "v2.0.0-rc5", "-m", "rc5", dangling]);
    expect(refusalCode(() => makePlan(gitIn(f.work), { ref: "main" }))).toBe("not_after_previous");
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
    expect(body).toContain("Seed check: Roll input allow_seed_change: tick it ONLY after the data pipeline release carries tool_categories.json tool_categories_v2 (changed since v2.0.0-rc1).");
    expect(body).toContain("Roll compares the seed files with what the residents run now (EDGE_HERMES_REF, a tag or a branch tip)");
    expect(body).toContain("seed_uncomparable");
    expect(body).toContain(`  ${f.b.slice(0, 7)} DATA-1: tool categories v2 (#1)`);
    expect(body).toContain(`  ${f.c.slice(0, 7)} DATA-2: readme \`code\` # not a comment (#2)`);
  });

  test("a note goes on its own Note: line; a bad note refuses before anything is created", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(renderText(makePlan(git, { ref: "main", note: "first cut for the canaries" }), "dry-run")).toContain("  note         first cut for the canaries");
    expect(renderSummary(makePlan(git, { ref: "main", note: "first cut" }), "dry-run")).toContain("| Note | `first cut` |");
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

  test("a moved previous tag changes the seed check: plan_changed", () => {
    const f = released();
    const planned = makePlan(gitIn(f.work), { ref: "main" });
    const other = cloneOther(f);
    sh(other, ["tag", "-f", "-a", "v2.0.0-rc1", "-m", "moved", f.b]);
    sh(other, ["push", "--quiet", "--force", "origin", "refs/tags/v2.0.0-rc1"]);
    const before = originRefs(f);
    expect(
      refusalCode(() =>
        createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", expectSeeds: planned.seedDigest, fetch: true, ...who }),
      ),
    ).toBe("plan_changed");
    expect(originRefs(f)).toBe(before);
  });

  test("a deleted previous tag is seen by the fetch", () => {
    const f = released();
    const other = cloneOther(f);
    sh(other, ["push", "--quiet", "origin", ":refs/tags/v2.0.0-rc1"]);
    expect(refusalCode(() => createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", fetch: true, ...who }))).toBe(
      "no_release_tags",
    );
    expect(sh(f.origin, ["tag", "-l"])).toBe("");
  });

  test("a release tag pushed meanwhile on a commit no branch reaches is seen by the fetch", () => {
    const f = released();
    const other = cloneOther(f);
    const tree = sh(other, ["rev-parse", `${f.a}^{tree}`]);
    const dangling = sh(other, ["commit-tree", tree, "-p", f.a, "-m", "nowhere"]);
    sh(other, ["tag", "-a", "v2.0.0-rc3", "-m", "rc3", dangling]);
    sh(other, ["push", "--quiet", "origin", "refs/tags/v2.0.0-rc3"]);
    expect(refusalCode(() => createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", fetch: true, ...who }))).toBe(
      "not_after_previous",
    );
    expect(sh(f.origin, ["tag", "-l", "v2.0.0-rc2"])).toBe("");
  });

  test("the seed digest is checked only in its own shape", () => {
    const f = released();
    expect(refusalCode(() => createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", expectSeeds: "abc", ...who }))).toBe("bad_usage");
    const planned = makePlan(gitIn(f.work), { ref: "main" });
    createTag(gitIn(f.work), { ref: f.c, expectCommit: f.c, expectVersion: "v2.0.0-rc2", expectSeeds: planned.seedDigest, fetch: true, ...who });
    expect(sh(f.origin, ["rev-parse", "refs/tags/v2.0.0-rc2^{commit}"])).toBe(f.c);
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
    expect(readFileSync(out, "utf8")).toMatch(new RegExp(`^commit=${f.c}\nversion=v2.0.0-rc2\nprevious=v2.0.0-rc1\nseed_changed=true\nseeds=[0-9a-f]{64}\n$`));
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

  test("under Actions, repository text is wrapped in stop-commands with a fresh token; a refusal is one line", () => {
    const f = released();
    const run = () => cli(["plan", "--cwd", f.work, "--ref", "main"], { GITHUB_ACTIONS: "true" });
    const r1 = run();
    const r2 = run();
    const lines = r1.stdout.trimEnd().split("\n");
    const m = /^::stop-commands::([0-9a-f]{32})$/.exec(lines[0]);
    expect(m).not.toBeNull();
    expect(lines.at(-1)).toBe(`::${m?.[1]}::`);
    expect(r2.stdout.split("\n")[0]).not.toBe(lines[0]);
    const sum = join(dirname(f.work), "summary.md");
    writeFileSync(sum, "");
    const bad = cli(["plan", "--cwd", f.work, "--ref", "x\n::warning ::y ![b](https://e.example/b.png)"], { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: sum });
    expect(bad.code).toBe(1);
    expect(bad.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(bad.stderr).toStartWith("::error title=Tag release refused (bad_ref)::");
    const pct = cli(["plan", "--cwd", f.work, "--ref", "x\n%0A::warning::x"], { GITHUB_ACTIONS: "true" });
    expect(pct.stderr.trimEnd().split("\n")).toHaveLength(1);
    expect(pct.stderr).toContain("%250A::warning::x");
    expect(pct.stderr).not.toContain("%0A");
    expect(readFileSync(sum, "utf8")).toMatch(/\*\*bad_ref\.\*\* `[^`\n]*!\[b\]\(https:\/\/e\.example\/b\.png\)[^`\n]*`/);
  });

  test("the command line checks the suite directories from the checkout's test.yml", () => {
    const f = released();
    writeFileSync(join(f.work, TEST_YML), TEST_YML_TEXT.replace("scripts/tests", "scripts/tests skills/none/tests"));
    const r = cli(["plan", "--cwd", f.work, "--ref", "main"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Refused (suite_dir_missing): skills/none/tests does not exist");
    rmSync(join(f.work, TEST_YML));
    expect(cli(["plan", "--cwd", f.work, "--ref", "main"]).stderr).toContain("suite_list_unreadable");
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

// ---------------------------------------------------------------------------
// Whether main's own test run already passed at the commit (the API mocked)

const REPO = "Edge-City/agentvillage";
const SHA = "6f9c5fca09ff4d7b6a0a276cf2258967439e8b56";
const OTHER_SHA = "714433926f881601657153873ba6c6847c0d7ca8";
const WF_ID = 372158421;
const WORKFLOW = { id: WF_ID, name: "test", path: ".github/workflows/test.yml", state: "active" };

function run(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 38085948159,
    name: "test",
    path: ".github/workflows/test.yml",
    workflow_id: WF_ID,
    head_sha: SHA,
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    run_attempt: 1,
    run_number: 380,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    ...over,
  };
}

/** A git that answers the two object ids compareTestWorkflow asks for (null: that read fails). */
function gitMock(atCommit: string | null, here: string | null): { git: Git; calls: string[][] } {
  const calls: string[][] = [];
  const git: Git = (args) => {
    calls.push(args);
    const answer = args[0] === "rev-parse" ? atCommit : args[0] === "hash-object" ? here : null;
    return answer === null ? { code: 1, stdout: "", stderr: "fatal: no such path" } : { code: 0, stdout: `${answer}\n`, stderr: "" };
  };
  return { git, calls };
}
const BLOB = "a".repeat(40);
const SAME_GIT = gitMock(BLOB, BLOB).git;

function mockApi(runs: unknown[] | (() => unknown), workflow: unknown = WORKFLOW): { api: Api; calls: string[] } {
  const calls: string[] = [];
  const api: Api = (path) => {
    calls.push(path);
    if (path === `repos/${REPO}/actions/workflows/test.yml`) {
      if (workflow instanceof Error) throw workflow;
      return workflow;
    }
    if (path.startsWith(`repos/${REPO}/actions/workflows/${WF_ID}/runs?`)) {
      const list = typeof runs === "function" ? runs() : runs;
      return { total_count: Array.isArray(list) ? list.length : 0, workflow_runs: list };
    }
    throw new Error(`HTTP 404: Not Found (${path})`);
  };
  return { api, calls };
}

describe("findTestedRun", () => {
  test("test.yml the same at the commit as main's: on to the API check", () => {
    const { git, calls: gitCalls } = gitMock(BLOB, BLOB);
    const { api, calls } = mockApi([run()]);
    expect(findTestedRun(git, api, REPO, SHA).tested).toBe(true);
    expect(gitCalls).toEqual([
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${SHA}:.github/workflows/test.yml`],
      ["hash-object", "--no-filters", "--", ".github/workflows/test.yml"],
    ]);
    expect(calls).toHaveLength(2);
  });

  test("test.yml at the commit differs from main's: not tested, and the API is never asked", () => {
    const { api, calls } = mockApi([run()]);
    const r = findTestedRun(gitMock(BLOB, "b".repeat(40)).git, api, REPO, SHA);
    expect(r).toMatchObject({ tested: false, runId: null, attempt: null });
    expect(r.reason).toStartWith("test.yml at the commit differs from main's");
    expect(calls).toHaveLength(0);
  });

  test("either copy of test.yml unreadable: not tested, and the API is never asked", () => {
    const { api, calls } = mockApi([run()]);
    for (const git of [
      gitMock(null, BLOB).git,
      gitMock(BLOB, null).git,
      gitMock(null, null).git,
      gitMock("", "").git,
      gitMock("not an id", "not an id").git,
      (() => {
        throw new Error("git could not run");
      }) as Git,
    ]) {
      const r = findTestedRun(git, api, REPO, SHA);
      expect(r.tested).toBe(false);
      expect(r.reason).toContain("test.yml at the commit differs from main's");
      expect(r.reason).toContain("could not be read");
    }
    expect(calls).toHaveLength(0);
  });

  test("compareTestWorkflow on a real repository: byte for byte, or unreadable", () => {
    const f = released();
    const git = gitIn(f.work);
    expect(compareTestWorkflow(git, f.c)).toBe("same");
    // One byte more in the working tree (main's copy) differs.
    writeFileSync(join(f.work, TEST_YML), `${TEST_YML_TEXT} `);
    expect(compareTestWorkflow(git, f.c)).toBe("differs");
    // The commit's copy differs from an older one.
    writeFileSync(join(f.work, TEST_YML), TEST_YML_TEXT);
    const d = f.commit({ [TEST_YML]: TEST_YML_TEXT.replace("scripts/tests", "scripts/tests install/tests") }, "test.yml gains a line");
    expect(compareTestWorkflow(git, d)).toBe("same");
    expect(compareTestWorkflow(git, f.c)).toBe("differs");
    // Missing in the working tree, or at the commit, or an unknown commit: unreadable.
    rmSync(join(f.work, TEST_YML));
    expect(compareTestWorkflow(git, d)).toBe("unreadable");
    expect(compareTestWorkflow(git, "0".repeat(40))).toBe("unreadable");
  });

  test("a successful run of test.yml from a push to main at the commit: tested, with its id", () => {
    const { api, calls } = mockApi([run()]);
    const r = findTestedRun(SAME_GIT, api, REPO, SHA);
    expect(r).toEqual({ tested: true, runId: 38085948159, attempt: 1, reason: expect.stringContaining("run 38085948159 (attempt 1) of .github/workflows/test.yml") });
    expect(r.reason).toContain("succeeded");
    // The workflow is looked up by its file, the runs by its id and the exact commit.
    expect(calls[0]).toBe(`repos/${REPO}/actions/workflows/test.yml`);
    expect(calls[1]).toStartWith(`repos/${REPO}/actions/workflows/${WF_ID}/runs?head_sha=${SHA}&event=push&branch=main&`);
  });

  test("a failed run is not tested", () => {
    const r = findTestedRun(SAME_GIT, mockApi([run({ conclusion: "failure" })]).api, REPO, SHA);
    expect(r.tested).toBe(false);
    expect(r.runId).toBe(38085948159);
    expect(r.reason).toContain("concluded failure");
  });

  test("cancelled, skipped, timed out and still running are not tested", () => {
    for (const over of [{ conclusion: "cancelled" }, { conclusion: "skipped" }, { conclusion: "timed_out" }, { conclusion: "neutral" }, { status: "in_progress", conclusion: null }, { status: "queued", conclusion: null }]) {
      expect(findTestedRun(SAME_GIT, mockApi([run(over)]).api, REPO, SHA).tested).toBe(false);
    }
    expect(findTestedRun(SAME_GIT, mockApi([run({ status: "in_progress", conclusion: null })]).api, REPO, SHA).reason).toContain("has not finished (in_progress)");
  });

  test("a re-run whose latest attempt failed after an earlier success is not tested", () => {
    // The run object carries the latest attempt: attempt 1 succeeded, attempt 2 failed.
    const r = findTestedRun(SAME_GIT, mockApi([run({ run_attempt: 2, conclusion: "failure" })]).api, REPO, SHA);
    expect(r.tested).toBe(false);
    expect(r.reason).toContain("(attempt 2)");
    // A re-run still going after a success is not proof either.
    expect(findTestedRun(SAME_GIT, mockApi([run({ run_attempt: 2, status: "in_progress", conclusion: null })]).api, REPO, SHA).tested).toBe(false);
    // A re-run that succeeded is.
    expect(findTestedRun(SAME_GIT, mockApi([run({ run_attempt: 3 })]).api, REPO, SHA)).toMatchObject({ tested: true, attempt: 3 });
  });

  test("the newest matching run decides, not any older success", () => {
    const older = run({ id: 100, run_number: 10 });
    const newer = run({ id: 200, run_number: 11, conclusion: "failure" });
    expect(findTestedRun(SAME_GIT, mockApi([older, newer]).api, REPO, SHA)).toMatchObject({ tested: false, runId: 200 });
    expect(findTestedRun(SAME_GIT, mockApi([newer, older]).api, REPO, SHA)).toMatchObject({ tested: false, runId: 200 });
    expect(findTestedRun(SAME_GIT, mockApi([run({ id: 100, run_number: 10, conclusion: "failure" }), run({ id: 200, run_number: 11 })]).api, REPO, SHA)).toMatchObject({ tested: true, runId: 200 });
  });

  test("a pull request run, even from a fork whose branch is called main, is not tested", () => {
    const pr = run({ event: "pull_request" });
    expect(findTestedRun(SAME_GIT, mockApi([pr]).api, REPO, SHA)).toMatchObject({ tested: false, runId: null });
    const fork = run({ event: "pull_request_target", head_repository: { full_name: "someone/agentvillage" } });
    expect(findTestedRun(SAME_GIT, mockApi([fork]).api, REPO, SHA).tested).toBe(false);
    const forkPush = run({ head_repository: { full_name: "someone/agentvillage" } });
    expect(findTestedRun(SAME_GIT, mockApi([forkPush]).api, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ repository: { full_name: "someone/agentvillage" } })]).api, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ head_repository: null })]).api, REPO, SHA).tested).toBe(false);
  });

  test("other events and branches are not tested", () => {
    for (const over of [{ event: "workflow_dispatch" }, { event: "workflow_call" }, { event: "schedule" }, { head_branch: "release/x" }, { head_branch: "Main" }, { head_branch: null }]) {
      expect(findTestedRun(SAME_GIT, mockApi([run(over)]).api, REPO, SHA).tested).toBe(false);
    }
  });

  test("another workflow, even one named test, is not tested", () => {
    const sameName = run({ path: ".github/workflows/other.yml", workflow_id: 999, name: "test" });
    expect(findTestedRun(SAME_GIT, mockApi([sameName]).api, REPO, SHA).tested).toBe(false);
    // The right id with another path, or the right path with another id: not tested.
    expect(findTestedRun(SAME_GIT, mockApi([run({ path: ".github/workflows/other.yml" })]).api, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ workflow_id: 999 })]).api, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ path: ".github/workflows/test.yml@refs/heads/x" })]).api, REPO, SHA).tested).toBe(false);
    // The workflow lookup must name test.yml's own path.
    const r = findTestedRun(SAME_GIT, mockApi([run()], { ...WORKFLOW, path: ".github/workflows/other.yml" }).api, REPO, SHA);
    expect(r.tested).toBe(false);
    expect(r.reason).toContain("did not answer with the workflow");
    expect(findTestedRun(SAME_GIT, mockApi([run()], { ...WORKFLOW, id: "372158421" }).api, REPO, SHA).tested).toBe(false);
  });

  test("a run at another commit is not tested", () => {
    expect(findTestedRun(SAME_GIT, mockApi([run({ head_sha: OTHER_SHA })]).api, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ head_sha: SHA.slice(0, 7) })]).api, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ head_sha: SHA.toUpperCase() })]).api, REPO, SHA).tested).toBe(false);
  });

  test("no run, an API error or an unexpected answer: not tested, with the reason", () => {
    const none = findTestedRun(SAME_GIT, mockApi([]).api, REPO, SHA);
    expect(none).toEqual({ tested: false, runId: null, attempt: null, reason: `no run of .github/workflows/test.yml from a push to main at ${SHA.slice(0, 7)}` });
    const ignored = findTestedRun(SAME_GIT, mockApi([run({ event: "pull_request" }), "junk", null]).api, REPO, SHA);
    expect(ignored.reason).toContain("(3 other runs ignored");
    const down = findTestedRun(SAME_GIT, mockApi([], new Error("HTTP 403: Resource not accessible by integration")).api, REPO, SHA);
    expect(down.tested).toBe(false);
    expect(down.reason).toContain("could not read the workflow .github/workflows/test.yml: HTTP 403");
    const listFails = findTestedRun(SAME_GIT, mockApi(() => {
      throw new Error("HTTP 502\n::warning::x");
    }).api, REPO, SHA);
    expect(listFails.tested).toBe(false);
    expect(listFails.reason).not.toContain("\n");
    expect(findTestedRun(SAME_GIT, () => ({ workflow_runs: "nope", id: WF_ID, path: ".github/workflows/test.yml" }), REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, () => null, REPO, SHA).tested).toBe(false);
    expect(findTestedRun(SAME_GIT, mockApi([run({ id: "38085948159" })]).api, REPO, SHA).tested).toBe(false);
  });

  test("API text in the reason is cleaned", () => {
    const r = findTestedRun(SAME_GIT, mockApi([run({ conclusion: "fail\n::error::x‮" })]).api, REPO, SHA);
    expect(r.tested).toBe(false);
    expect(r.reason).not.toMatch(/[\n‮]/);
  });

  test("bad arguments refuse", () => {
    const { api, calls } = mockApi([run()]);
    expect(refusalCode(() => findTestedRun(SAME_GIT, api, REPO, SHA.slice(0, 7)))).toBe("bad_usage");
    expect(refusalCode(() => findTestedRun(SAME_GIT, api, "Edge-City/agentvillage/../x", SHA))).toBe("bad_usage");
    expect(refusalCode(() => findTestedRun(SAME_GIT, api, "", SHA))).toBe("bad_usage");
    expect(calls).toHaveLength(0);
  });

  test("the log line and the run link", () => {
    const yes = findTestedRun(SAME_GIT, mockApi([run()]).api, REPO, SHA);
    expect(testedLine(yes, false)).toStartWith("Suites: not run again here. Proved by run 38085948159");
    expect(testedLine({ tested: false, runId: null, attempt: null, reason: "x" }, false)).toBe("Suites: they run in this workflow. Not proven by an earlier run: x.");
    expect(testedLine(yes, true)).toContain("force_tests is on");
    expect(runUrl({}, REPO, 5)).toBe(`https://github.com/${REPO}/actions/runs/5`);
    expect(runUrl({ GITHUB_SERVER_URL: "https://ghe.example.com" }, REPO, 5)).toBe(`https://ghe.example.com/${REPO}/actions/runs/5`);
    expect(runUrl({ GITHUB_SERVER_URL: "javascript:alert(1)" }, REPO, 5)).toBe(`https://github.com/${REPO}/actions/runs/5`);
  });
});

describe("command line: tested", () => {
  function outFiles() {
    const root = mkdtempSync(join(tmpdir(), "tag-release-tested-"));
    dirs.push(root);
    const out = join(root, "out");
    const sum = join(root, "summary.md");
    writeFileSync(out, "");
    writeFileSync(sum, "");
    return { out, sum };
  }

  test("tested=true and the run id when main's run proved the commit", () => {
    const { out, sum } = outFiles();
    const code = main(["tested", "--commit", SHA, "--force-tests", "false"], { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: sum, GITHUB_REPOSITORY: REPO }, { api: mockApi([run()]).api, git: SAME_GIT });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("tested=true\ntested_run=38085948159\n");
    expect(readFileSync(sum, "utf8")).toContain(`[run 38085948159](https://github.com/${REPO}/actions/runs/38085948159)`);
  });

  test("tested=false (exit 0) when not proven, so the suites run", () => {
    const { out } = outFiles();
    const code = main(["tested", "--commit", SHA, "--repo", REPO], { GITHUB_OUTPUT: out }, { api: mockApi([run({ conclusion: "failure" })]).api, git: SAME_GIT });
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).toBe("tested=false\ntested_run=\n");
  });

  test("a differing test.yml writes tested=false without asking the API", () => {
    const { out } = outFiles();
    const { api, calls } = mockApi([run()]);
    expect(main(["tested", "--commit", SHA], { GITHUB_OUTPUT: out, GITHUB_REPOSITORY: REPO }, { api, git: gitMock(BLOB, "c".repeat(40)).git })).toBe(0);
    expect(calls).toHaveLength(0);
    expect(readFileSync(out, "utf8")).toBe("tested=false\ntested_run=\n");
  });

  test("--force-tests true never asks the API and writes tested=false", () => {
    const { out } = outFiles();
    const { api, calls } = mockApi([run()]);
    expect(main(["tested", "--commit", SHA, "--force-tests", "true"], { GITHUB_OUTPUT: out, GITHUB_REPOSITORY: REPO }, { api })).toBe(0);
    expect(calls).toHaveLength(0);
    expect(readFileSync(out, "utf8")).toBe("tested=false\ntested_run=\n");
  });

  test("bad usage exits 2 and writes no outputs", () => {
    const { out } = outFiles();
    const { api, calls } = mockApi([run()]);
    const env = { GITHUB_OUTPUT: out, GITHUB_REPOSITORY: REPO };
    expect(main(["tested", "--commit", SHA, "--force-tests", "yes"], env, { api })).toBe(2);
    expect(main(["tested", "--commit", SHA, "--force-tests", ""], env, { api })).toBe(2);
    expect(main(["tested", "--commit", "main"], env, { api })).toBe(2);
    expect(main(["tested", "--commit", SHA], { GITHUB_OUTPUT: out }, { api })).toBe(2);
    expect(main(["tested", "--commit", SHA, "--ref", "main"], env, { api })).toBe(2);
    expect(main(["plan", "--force-tests", "true"], env, { api })).toBe(2);
    expect(calls).toHaveLength(0);
    expect(readFileSync(out, "utf8")).toBe("");
  });
});
