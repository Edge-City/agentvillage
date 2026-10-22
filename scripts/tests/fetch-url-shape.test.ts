/**
 * EDGEOS-BLOCK (20 Oct): no agent-facing `curl` or `wget` recipe passes a word
 * that starts with `$` in an option slot, and the EdgeOS recipes pass their URL
 * with `--url`.
 *
 * Why: approval.md core 0.4.6 (APRV-511, approval-md #639) treats a fetch
 * whose argv has a word starting with `$` in an option slot as one whose
 * download target it cannot know (`src/core/command-class.ts`
 * `argvWordUnknowable`: `if (slot === "option" && word.startsWith("$")) return true;`):
 * the variable could expand to `-o <organ path>`. The command then classes
 * `policy.core` (rule `fetch-output-unknown`), which the template policy
 * reserves to humans, so the gate denies it (`hook-class-human-only`) and
 * Hermes reports `plugin_block`. Every `skills/edgeos/SKILL.md` recipe wrote
 * its URL as the bare word `"${EDGEOS_API_BASE:-https://…}/…"`, so from the
 * 19 Oct morning rolls (approvald 0.4.5 -> 0.4.6) no EdgeOS curl ran.
 * `--url "${EDGEOS_API_BASE:-…}/…"` puts the same word in `--url`'s value
 * slot: curl takes the next argv word as the URL whatever it starts with, and
 * core classes the command `network.call`.
 *
 * Two parts:
 * 1. A static shape test that runs everywhere (overlay CI has no approval.md
 *    core): every fenced or inline `curl`/`wget` in the skills, the workspace
 *    files and the inline cron prompts is lexed, and no word in an option slot
 *    may start with `$`.
 * 2. The classifier itself, when `AV_APPROVAL_MD_CORE_DIR` names an approval-md
 *    checkout (it skips otherwise, as in CI): every EdgeOS recipe classes
 *    autonomous under the template policy, never `fetch-output-unknown`. It
 *    first asserts the checkout is APPROVAL_MD_PINNED, so when the boxes' pin
 *    (the control plane's APPROVAL_MD_VERSION) moves, this test fails until it
 *    is re-run against the new core and the constant follows.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { DIGEST_CRON_SPECS } from "../../install/install_index";

const REPO = join(import.meta.dir, "..", "..");

/**
 * The approval.md core version the boxes run (control plane APPROVAL_MD_VERSION,
 * set 19 Oct) and the one this file's rule and classifier run were checked
 * against. Moving the pin means re-running part 2 against that core first.
 */
export const APPROVAL_MD_PINNED = "0.4.6";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(md|txt)$/.test(entry)) out.push(path);
  }
  return out;
}

interface Recipe {
  where: string;
  command: string;
}

const SHELL_FENCE = new Set(["", "sh", "bash", "shell", "zsh", "console"]);

/** Every fenced shell command (continuations joined) and every inline `curl …`/`wget …` span. */
export function recipesIn(name: string, text: string, plain = false): Recipe[] {
  const out: Recipe[] = [];
  const lines = text.split("\n");
  let fence: string | null = null;
  let lang = "";
  let pending = "";
  let start = 0;
  lines.forEach((line, i) => {
    const open = line.match(/^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_-]*)/);
    if (!plain && fence === null && open) {
      fence = open[1];
      lang = open[2].toLowerCase();
      pending = "";
      return;
    }
    if (!plain && fence !== null && line.trim().startsWith(fence)) {
      fence = null;
      return;
    }
    if (!plain && fence !== null) {
      if (!SHELL_FENCE.has(lang)) return;
      if (pending === "") start = i + 1;
      pending += (pending ? " " : "") + line.replace(/\\\s*$/, "");
      if (/\\\s*$/.test(line)) return;
      const command = pending.replace(/^\s*\$\s+/, "").trim();
      pending = "";
      if (command && !command.startsWith("#")) out.push({ where: `${name}:${start}`, command });
      return;
    }
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      if (/^\s*(curl|wget)\s/.test(m[1])) out.push({ where: `${name}:${i + 1}`, command: m[1] });
    }
  });
  return out;
}

interface Word {
  /** The word after quote removal. */
  text: string;
}

/** A small POSIX-ish lexer: words and the control operators that end a simple command. */
export function lex(command: string): (Word | "|")[] {
  const out: (Word | "|")[] = [];
  let i = 0;
  let cur: string | null = null;
  const end = () => {
    if (cur !== null) out.push({ text: cur });
    cur = null;
  };
  while (i < command.length) {
    const c = command[i];
    if (c === "'") {
      const j = command.indexOf("'", i + 1);
      cur = (cur ?? "") + command.slice(i + 1, j < 0 ? command.length : j);
      i = j < 0 ? command.length : j + 1;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < command.length && command[j] !== '"') {
        if (command[j] === "\\" && j + 1 < command.length) {
          s += command[j + 1];
          j += 2;
        } else s += command[j++];
      }
      cur = (cur ?? "") + s;
      i = j + 1;
    } else if (c === "\\" && i + 1 < command.length) {
      cur = (cur ?? "") + command[i + 1];
      i += 2;
    } else if (/\s/.test(c)) {
      end();
      i += 1;
    } else if ("|;&()".includes(c)) {
      end();
      out.push("|");
      i += 1;
    } else {
      cur = (cur ?? "") + c;
      i += 1;
    }
  }
  end();
  return out;
}

/** Options whose value is the next word (curl and wget, the ones a recipe could use). */
const TAKES_VALUE: Record<string, Set<string>> = {
  curl: new Set([
    "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json", "-X", "--request",
    "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-F", "--form", "-w", "--write-out",
    "-T", "--upload-file", "-b", "--cookie", "-c", "--cookie-jar", "-m", "--max-time", "--connect-timeout",
    "--retry", "-K", "--config", "-x", "--proxy", "--url", "--output-dir", "-D", "--dump-header", "--proto",
    "--unix-socket", "-r", "--range", "-z", "--time-cond", "--resolve", "--cacert", "--cert", "--key",
  ]),
  wget: new Set([
    "-O", "--output-document", "-o", "--output-file", "-a", "--append-output", "-P", "--directory-prefix",
    "-U", "--user-agent", "--header", "--post-data", "--post-file", "--body-data", "--method", "-T", "--timeout",
    "-t", "--tries", "-i", "--input-file", "-e", "--execute", "--user", "--password",
  ]),
};

/** The words of each curl/wget invocation in `command` that sit in an option slot and start with `$`. */
export function dollarFirstOptionWords(command: string): string[] {
  const words = lex(command);
  const bad: string[] = [];
  let first = true;
  let bin: string | null = null;
  let valueNext = false;
  let operands = false;
  for (const w of words) {
    if (w === "|") {
      first = true;
      bin = null;
      continue;
    }
    if (first) {
      first = false;
      const base = w.text.split("/").pop() ?? "";
      bin = base === "curl" || base === "wget" ? base : null;
      valueNext = false;
      operands = false;
      continue;
    }
    if (bin === null) continue;
    if (valueNext) {
      valueNext = false;
      continue;
    }
    if (operands) continue;
    if (w.text === "--") {
      operands = true;
      continue;
    }
    if (w.text.startsWith("$")) {
      bad.push(w.text);
      continue;
    }
    if (w.text.startsWith("-") && !w.text.includes("=") && TAKES_VALUE[bin].has(w.text)) valueNext = true;
  }
  return bad;
}

function agentFacingRecipes(): Recipe[] {
  const out: Recipe[] = [];
  for (const dir of ["skills", "workspace"]) {
    for (const path of walk(join(REPO, dir))) {
      out.push(...recipesIn(relative(REPO, path), readFileSync(path, "utf8")));
    }
  }
  for (const spec of DIGEST_CRON_SPECS) {
    if (spec.promptBody !== undefined) out.push(...recipesIn(`install/install_index.ts#${spec.name}`, spec.promptBody, true));
  }
  return out;
}

const EDGEOS_SKILL = join(REPO, "skills", "edgeos", "SKILL.md");
const OLD_SHAPE =
  'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" "${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/x"';

describe("fetch recipes keep `$` out of curl's and wget's option slots (approval.md " + APPROVAL_MD_PINNED + ")", () => {
  test("the detector flags the shapes core 0.4.6 holds and passes the --url and literal forms", () => {
    expect(dollarFirstOptionWords(OLD_SHAPE)).toEqual(["${EDGEOS_API_BASE:-https://api.edgeos.world/api/v1}/events/portal/events/x"]);
    expect(dollarFirstOptionWords('curl -s "$URL"')).toEqual(["$URL"]);
    expect(dollarFirstOptionWords('echo hi | curl -s $URL | jq .')).toEqual(["$URL"]);
    expect(dollarFirstOptionWords('wget -q "${BASE}/x"')).toEqual(["${BASE}/x"]);
    expect(dollarFirstOptionWords(OLD_SHAPE.replace(' "${EDGEOS', ' --url "${EDGEOS'))).toEqual([]);
    expect(dollarFirstOptionWords('curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" https://api.edgeos.world/api/v1/x')).toEqual([]);
    expect(dollarFirstOptionWords('curl -s -- "$URL"')).toEqual([]);
    expect(dollarFirstOptionWords('echo "$URL"')).toEqual([]);
  });

  test("no agent-facing curl or wget recipe has a `$`-first word in an option slot", () => {
    const recipes = agentFacingRecipes();
    const fetches = recipes.filter((r) => /(^|[|;&(]\s*)\s*(\S*\/)?(curl|wget)\s/.test(r.command));
    // EDGEOS-BLOCK step B (v2.1.10): the eleven EdgeOS recipes are script runs now, so few or no fetch
    // recipes remain; the rule still holds for any that are (or will be) written.
    expect(recipes.length).toBeGreaterThan(0);
    const offenders = fetches
      .map((r) => ({ where: r.where, words: dollarFirstOptionWords(r.command) }))
      .filter((r) => r.words.length > 0);
    expect(offenders).toEqual([]);
  });

  test("the EdgeOS skill has no fetch recipe: its eleven EdgeOS calls are runs of its own script (v2.1.10)", () => {
    const recipes = recipesIn("skills/edgeos/SKILL.md", readFileSync(EDGEOS_SKILL, "utf8"));
    expect(recipes.filter((r) => /(^|[|;&(]\s*)\s*(\S*\/)?(curl|wget)\s/.test(r.command))).toEqual([]);
    expect(recipes.filter((r) => r.command.startsWith("bun skills/edgeos/scripts/edgeos.ts ")).length).toBe(11);
    for (const r of recipes) expect(r.command).not.toContain("$");
  });
});

// ---------------------------------------------------------------------------
// Part 2: the classifier, against an approval-md checkout (local; skips in CI)
// ---------------------------------------------------------------------------

const CORE = process.env.AV_APPROVAL_MD_CORE_DIR ?? "";
const HAVE_CORE = CORE !== "" && existsSync(join(CORE, "src", "cli", "hook.ts"));

/** The template policy's `classes:` table: class -> autonomy. */
function templateAutonomy(): Map<string, string> {
  const lines = readFileSync(join(REPO, "skills", "approval", "templates", "APPROVAL.md"), "utf8").split("\n");
  const out = new Map<string, string>();
  let inside = false;
  for (const line of lines) {
    if (/^classes:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && /^\S/.test(line)) inside = false;
    const m = inside ? line.match(/^\s+([A-Za-z0-9_.*-]+):\s*\{\s*autonomy:\s*([a-z-]+)/) : null;
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

/**
 * The template's `defaults.autonomy`: the autonomy of a class its table does not list (e.g. `exec.local`, the
 * class core gives a skill-script run), as the real hook resolves it.
 */
function templateDefaultAutonomy(): string {
  const text = readFileSync(join(REPO, "skills", "approval", "templates", "APPROVAL.md"), "utf8");
  return text.match(/^defaults:\s*\n\s+autonomy:\s*([a-z-]+)/m)?.[1] ?? "manual";
}

const FILL: [RegExp, string][] = [
  [/\{(current_iso_timestamp|start_iso|end_iso|occurrence_iso)\}/g, "2026-10-21T10:00:00Z"],
  [/\{(event_id|popup_id)\}/g, "3fa85f64-5717-4562-b3fc-2c963f66afa6"],
];

describe.skipIf(!HAVE_CORE)("approval.md core classes every EdgeOS recipe autonomous (AV_APPROVAL_MD_CORE_DIR)", () => {
  test("the core checkout is the pinned version", () => {
    const version = JSON.parse(readFileSync(join(CORE, "package.json"), "utf8")).version;
    expect(version).toBe(APPROVAL_MD_PINNED);
  });

  test("each recipe resolves autonomous and never fetch-output-unknown", async () => {
    const { classifyForHook } = await import(join(CORE, "src", "cli", "hook.ts"));
    const autonomy = templateAutonomy();
    const raw = readFileSync(EDGEOS_SKILL, "utf8");
    // v2.1.10: every EdgeOS recipe is a script run (scripts/tests/edgeos-verbs-corpus.test.ts runs them
    // through the real hook from the Hermes folder); the classifier must still class each autonomous.
    const recipes = recipesIn("skills/edgeos/SKILL.md", raw).filter((r) => r.command.startsWith("bun skills/edgeos/scripts/"));
    expect(recipes.length).toBeGreaterThanOrEqual(11);
    const held: string[] = [];
    for (const r of recipes) {
      let command = r.command;
      for (const [re, v] of FILL) command = command.replace(re, v);
      {
        const res = classifyForHook(command, [], "/tmp", []).result;
        const classes: string[] = res.ok ? res.classes : [];
        const rules: string[] = res.ok ? (res.segments ?? []).map((s: { rule: string }) => s.rule) : [];
        const fallback = templateDefaultAutonomy();
        const ok = res.ok && classes.length > 0 && classes.every((c) => (autonomy.get(c) ?? fallback) === "autonomous") && !rules.includes("fetch-output-unknown");
        if (!ok) held.push(`${r.where} ${res.ok ? classes.join(",") + " " + rules.join(",") : res.code}`);
      }
    }
    expect(held).toEqual([]);
  });

  test("the --url value is read as the URL, not an option: a `-o…` value is no write", async () => {
    // What EDGEOS_API_BASE="-o<organ path>" would expand to. curl takes --url's next argv word as
    // the URL whatever it starts with, and core reads it in the value slot, so nothing classes a write.
    const { classifyForHook } = await import(join(CORE, "src", "cli", "hook.ts"));
    const autonomy = templateAutonomy();
    for (const command of [
      'curl -s --url "-o/home/hermes/.hermes/config.yaml/events/portal/events/x"',
      'curl -s -H "Authorization: Bearer $EDGEOS_API_KEY" --url "-o/home/hermes/.hermes/config.yaml/events/portal/events/x"',
      'curl -s -X POST -H "Authorization: Bearer $EDGEOS_API_KEY" -H "Content-Type: application/json" --url "-o/home/hermes/.hermes/config.yaml/x" -d \'{}\'',
    ]) {
      const res = classifyForHook(command, [], "/tmp", []).result;
      expect(res.ok).toBe(true);
      for (const c of res.classes) expect([c, autonomy.get(c)]).toEqual([c, "autonomous"]);
      expect(res.classes).not.toContain("policy.core");
    }
  });
});
