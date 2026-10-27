import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { stagePlugins } from "../install_approval";
import { DIGEST_CRON_SPECS } from "../install_index";
import { EDGE_SKILL_NAMES, RETIRED_SKILL_DIRS } from "../paths";
import { copySkillBundles } from "../skill_copy";

// BUG-esmeralda (20 Oct 2026): a resident's agent "keeps asking about Edge
// Esmeralda", the summer V1 village. This is Edge City India. Every word the
// agent can load comes from what the installer puts on the box, so this test
// stages that set the way the installer does and requires zero mentions of the
// previous village, except the entries below, each pinned with a reason.
//
// The set: workspace/**/*.md (install.ts copyWorkspaceFiles, SOUL.md included,
// and workspace/odin/ for AV_PROFILE=odin), skills/<EDGE_SKILL_NAMES> staged by
// copySkillBundles, every other skill directory under skills/ that is not
// retired (the approval skill and the mini-app skills are installed by their
// own steps), plugins/ staged by stagePlugins, mini-apps/, and the inline
// prompt of every Index cron job (install_index.ts DIGEST_CRON_SPECS
// promptBody; the promptFile ones are skill files, scanned above).
//
// The words (lead L22646, OV426 S1): the previous popup's event name, matched
// anywhere (it is never part of another word, and it hides inside URLs and
// identifiers such as an `..._POPUP_ID`), and its town, county and state,
// matched as whole words (no letter on either side). Case-insensitive. Each
// mention counts, not each line (OV426 N3).
//
// Before matching, the text is folded so a mention cannot hide (OV426 N3):
// NUL bytes are dropped (a file is never skipped as binary), zero-width and
// soft-hyphen characters are dropped, NFKC is applied, and the common Cyrillic
// and Greek lookalikes of Latin letters are mapped to them. Limit: a lookalike
// outside HOMOGLYPHS, or a mention split by markup or spacing, is not caught.
const REPO = join(import.meta.dir, "..", "..");
const PATTERN = /esmeralda|(?<!\p{L})(?:healdsburg|sonoma|california)(?!\p{L})/giu;
/** Cyrillic and Greek letters that look like Latin ones, mapped to them. */
const HOMOGLYPHS: Record<string, string> = {
  "а": "a", "в": "b", "е": "e", "ё": "e", "к": "k", "м": "m", "н": "h", "о": "o", "р": "p", "с": "c", "т": "t",
  "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s", "ԁ": "d", "ӏ": "l", "ԛ": "q", "ԝ": "w",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X",
  "І": "I", "Ј": "J", "Ѕ": "S",
  "α": "a", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x",
  "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T",
  "Υ": "Y", "Χ": "X", "Ζ": "Z",
};
const INVISIBLE = /[\u0000\u00ad\u200b-\u200f\u2060-\u2064\ufeff]/g;

/** `text` folded as above. */
export function fold(text: string): string {
  return text
    .replace(INVISIBLE, "")
    .normalize("NFKC")
    .replace(/[\u0370-\u03ff\u0400-\u052f]/g, (c) => HOMOGLYPHS[c] ?? c);
}

/** How many times `text` mentions the previous village, after folding. */
export function mentions(text: string): number {
  return fold(text).match(PATTERN)?.length ?? 0;
}

/**
 * A path prefix (directory, ends with "/") or one file, the hit counts it may have (or "any" for a prefix),
 * and why.
 */
const ALLOWED: ReadonlyArray<{ path: string; hits: readonly number[] | "any"; reason: string }> = [
  {
    path: "workspace/AGENTS.md",
    hits: [7, 0],
    reason:
      "FROZEN file: Carter owns its edit (the V2116 AGENTS.md PR removes the three lines). Pinned to today's " +
      "exact count of mentions (seven on three lines) or to zero once that edit lands, in either press order; " +
      "any other count fails, so a new mention fails here. After the edit lands, drop this entry.",
  },
  {
    path: "skills/edge-india/references/",
    hits: "any",
    reason:
      "Verbatim copy of Edge City's public website and newsletter pages (scripts/sync-india-references.ts, " +
      "refreshed every 30 min). They name earlier villages as Edge City's history; they are reference " +
      "material read on demand, never instructions, and editing them by hand is undone by the next sync.",
  },
  {
    path: "skills/edge-india/scripts/tests/",
    hits: "any",
    reason:
      "Test code staged with the bundle (copySkillBundles copies the whole tree) but never loaded into the " +
      "agent's context; its guards must name the previous village to keep it out of the India skill.",
  },
  {
    path: "skills/edgeos/scripts/tests/",
    hits: "any",
    reason:
      "Test code staged with the bundle but never loaded into the agent's context; it uses the previous " +
      "popup's id as a known foreign popup for the directory script's --popup override.",
  },
];

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "av-no-previous-village-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function walk(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** `{ "<shipped path>": hits }` for every file in `root` that mentions the previous village. */
function hits(root: string, as: (rel: string) => string): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(root)) {
    const n = mentions(readFileSync(file).toString("utf8"));
    if (n > 0) found[as(relative(root, file).split(sep).join("/"))] = n;
  }
  return found;
}

/** Stages the shipped set into `home` and returns every hit by its path in the repo. */
function shippedHits(): Record<string, number> {
  const found: Record<string, number> = {};
  for (const file of walk(join(REPO, "workspace"))) {
    if (!file.endsWith(".md")) continue;
    const n = mentions(readFileSync(file).toString("utf8"));
    if (n > 0) found[`workspace/${relative(join(REPO, "workspace"), file).split(sep).join("/")}`] = n;
  }
  const skills = join(home, "skills");
  copySkillBundles(join(REPO, "skills"), skills);
  Object.assign(found, hits(skills, (rel) => `skills/${rel}`));
  const shipped = new Set<string>(EDGE_SKILL_NAMES);
  const retired = new Set<string>(RETIRED_SKILL_DIRS);
  for (const entry of readdirSync(join(REPO, "skills"))) {
    const dir = join(REPO, "skills", entry);
    if (!statSync(dir).isDirectory() || shipped.has(entry) || retired.has(entry)) continue;
    Object.assign(found, hits(dir, (rel) => `skills/${entry}/${rel}`));
  }
  const plugins = join(home, "plugins");
  stagePlugins(join(REPO, "plugins"), plugins, "before-approval");
  Object.assign(found, hits(plugins, (rel) => `plugins/${rel}`));
  Object.assign(found, hits(join(REPO, "mini-apps"), (rel) => `mini-apps/${rel}`));
  for (const spec of DIGEST_CRON_SPECS) {
    const n = mentions(spec.promptBody ?? "");
    if (n > 0) found[`install/install_index.ts (${spec.name} promptBody)`] = n;
  }
  return found;
}

function allowedBy(path: string) {
  return ALLOWED.find((entry) => (entry.path.endsWith("/") ? path.startsWith(entry.path) : path === entry.path));
}

test("BUG-esmeralda: the shipped prompt and skill set never names the previous village outside the pinned allowlist", () => {
  const found = shippedHits();
  const unexpected = Object.entries(found).filter(([path, n]) => {
    const entry = allowedBy(path);
    return !entry || (entry.hits !== "any" && !entry.hits.includes(n));
  });
  expect(Object.fromEntries(unexpected)).toEqual({});
  // A pinned file holds one of its pinned counts (zero only where the entry lists it: Carter's AGENTS.md edit).
  for (const entry of ALLOWED) {
    if (entry.hits === "any") continue;
    const n = found[entry.path] ?? 0;
    expect({ path: entry.path, pinned: entry.hits.includes(n) }).toEqual({ path: entry.path, pinned: true });
  }
});

test("BUG-esmeralda: the previous popup's skill is retired, so the installer removes it from every box", () => {
  expect(EDGE_SKILL_NAMES as readonly string[]).not.toContain("edge-esmeralda");
  expect(RETIRED_SKILL_DIRS as readonly string[]).toContain("edge-esmeralda");
  copySkillBundles(join(REPO, "skills"), join(home, "skills"));
  expect(readdirSync(join(home, "skills"))).not.toContain("edge-esmeralda");
});

test("the fold and the count: case, lookalikes, invisible characters, NUL bytes, whole place words, every mention", () => {
  // Built from parts so this file's own text holds no whole word to match.
  const event = ["esm", "eralda"].join("");
  const town = ["healds", "burg"].join("");
  const state = ["calif", "ornia"].join("");
  expect(mentions(event.toUpperCase())).toBe(1);
  expect(mentions(`${event.slice(0, 3)}\u200b${event.slice(3)}`)).toBe(1);
  expect(mentions(`${event.slice(0, 3)}\u0000${event.slice(3)}`)).toBe(1);
  expect(mentions(event.replace("e", "е"))).toBe(1); // Cyrillic е
  expect(mentions(`${event} and ${town}, ${state}`)).toBe(3);
  expect(mentions(`a ${event} line with ${event} twice`)).toBe(2);
  expect(mentions(`EDGE${event.toUpperCase()}_POPUP_ID`)).toBe(1);
  expect(mentions(`${state}n`)).toBe(0);
  expect(mentions("Edge City India, Mandrem, Goa")).toBe(0);
});

test("the Index cron jobs' inline prompts are scanned", () => {
  expect(DIGEST_CRON_SPECS.filter((s) => s.promptBody).length).toBeGreaterThanOrEqual(3);
});

test("BUG-esmeralda: every allowlist entry says why", () => {
  for (const entry of ALLOWED) expect(entry.reason.length).toBeGreaterThan(40);
});
