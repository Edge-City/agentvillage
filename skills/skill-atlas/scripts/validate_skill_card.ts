#!/usr/bin/env bun
/**
 * Validate a Skill Atlas card.
 *
 * Usage:
 *   bun scripts/validate_skill_card.ts path/to/skill-card.yaml
 *
 * Stdout:
 *   JSON with ok, missing_required, warnings, and next_action.
 *
 * Exit codes:
 *   0 - valid. 1 - missing fields or invalid status. 2 - file read error. 3 - parse error.
 *
 * Zero dependencies: parses the card's flat YAML subset (top-level scalars,
 * string lists, and the one-level `examples:` block) directly. Runs on Bun or Node 20+.
 */

import { readFileSync } from "node:fs";

const REQUIRED = [
  "title", "slug", "expert", "expertise_basis", "task", "target_user",
  "trigger", "negative_trigger", "output_contract", "judgment_heavy_step",
  "key_cues", "decision_criteria", "examples", "novice_traps",
  "validation_cases", "known_limits", "status",
];

const VALID_STATUS = new Set(["captured", "expert-reviewed", "scenario-tested", "community-tested"]);

type CardValue = string | string[] | Record<string, string>;

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Parse the template's YAML subset: `key: value`, `key: [a, b]`, `- item` lists, and one nested mapping level. */
function parseCard(text: string): Record<string, CardValue> {
  const card: Record<string, CardValue> = {};
  let currentKey: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith("#")) continue;

    const topLevel = rawLine.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (topLevel) {
      const [, key, rest] = topLevel;
      currentKey = key;
      const value = rest.trim();
      if (value === "" ) {
        card[key] = card[key] ?? "";          // list/mapping items may follow
      } else if (value === "[]") {
        card[key] = [];
      } else if (value.startsWith("[") && value.endsWith("]")) {
        card[key] = value.slice(1, -1).split(",").map(stripQuotes).filter(Boolean);
      } else {
        card[key] = stripQuotes(value);
      }
      continue;
    }

    if (!currentKey) continue;

    const listItem = rawLine.match(/^\s+-\s*(.*)$/);
    if (listItem) {
      const existing = card[currentKey];
      const list = Array.isArray(existing) ? existing : [];
      const item = stripQuotes(listItem[1]);
      if (item) list.push(item);
      card[currentKey] = list;
      continue;
    }

    const nested = rawLine.match(/^\s+([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested) {
      const existing = card[currentKey];
      const map = existing && typeof existing === "object" && !Array.isArray(existing) ? existing : {};
      map[nested[1]] = stripQuotes(nested[2]);
      card[currentKey] = map;
    }
  }

  if (Object.keys(card).length === 0) throw new Error("Could not parse any key: value lines.");
  return card;
}

function isEmpty(value: CardValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  return Object.keys(value).length === 0;
}

// process.exitCode (not process.exit) — hard exit after console output trips a libuv assertion on Windows.
function emit(result: object, code: number): void {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = code;
}

function main(): void {
  const path = process.argv[2];
  if (!path || process.argv.length !== 3) {
    return emit({
      ok: false, missing_required: [], warnings: ["Expected exactly one path argument."],
      next_action: "Run: bun scripts/validate_skill_card.ts path/to/skill-card.yaml",
    }, 2);
  }

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (exc) {
    return emit({
      ok: false, missing_required: [], warnings: [`File read error: ${exc}`],
      next_action: "Check the path and rerun the validator.",
    }, 2);
  }

  let card: Record<string, CardValue>;
  try {
    card = parseCard(text);
  } catch (exc) {
    return emit({
      ok: false, missing_required: [], warnings: [`Parse error: ${exc}`],
      next_action: "Fix YAML syntax or use simple key: value lines.",
    }, 3);
  }

  const missing = REQUIRED.filter((field) => isEmpty(card[field]));
  const warnings: string[] = [];

  const status = typeof card.status === "string" ? card.status.trim() : "";
  if (status && !VALID_STATUS.has(status)) {
    warnings.push(`Status '${status}' is not one of: ${[...VALID_STATUS].sort().join(", ")}.`);
  }
  if (status === "community-tested") {
    warnings.push("Community-tested requires evidence from at least one non-expert user or reviewer.");
  }

  const examples = card.examples;
  if (examples && typeof examples === "object" && !Array.isArray(examples)) {
    for (const key of ["good", "messy", "edge", "negative", "novice_trap"]) {
      if (isEmpty(examples[key])) warnings.push(`examples.${key} is empty.`);
    }
  }

  const ok = missing.length === 0 && !warnings.some((w) => w.includes("not one of"));
  emit({
    ok,
    missing_required: missing,
    warnings,
    next_action: ok
      ? "Review with the expert before skill generation."
      : "Fill missing fields and rerun validation.",
  }, ok ? 0 : 1);
}

main();
