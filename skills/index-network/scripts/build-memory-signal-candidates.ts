#!/usr/bin/env bun
/**
 * Build bounded, source-typed memory evidence for the nightly Index signal sync.
 *
 * This script does not call LLMs or Index. It only reads canonical local memory
 * sources and emits candidates that the cron prompt must verify before writing
 * premises or intents.
 */

import { dirname, join, relative } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";

type CandidateKind = "premise" | "intent" | "ranking_context_only";
type SourceType =
  | "user_notebook"
  | "curated_memory"
  | "daily_note"
  | "session_provenance"
  | "forum_observation"
  | "irl_observation";

interface Candidate {
  kind: CandidateKind;
  text: string;
  sourceType: SourceType;
  sourcePath: string;
  evidence: string;
  date?: string;
  confidence: "candidate" | "weak_context";
}

const ROOT = process.cwd();
const DEFAULT_OUT = join(ROOT, "memory", "memory-signal-candidates.json");
const MAX_CANDIDATES = 40;
const MAX_EVIDENCE_CHARS = 420;

function readFlag(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function isoDateFromPath(path: string): string | undefined {
  return path.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
}

function normalizeSnippet(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .replace(/^[-*#>\s]+/, "")
    .trim()
    .slice(0, MAX_EVIDENCE_CHARS);
}

function sourceText(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function recentMarkdownFiles(dir: string, limit: number): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      if (entry === "__pycache__" || entry === ".enzyme" || entry === ".git") continue;
      const path = join(current, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        walk(path);
      } else if (entry.endsWith(".md")) {
        files.push(path);
      }
    }
  };
  walk(dir);
  return files
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, limit);
}

function linesOfInterest(text: string): string[] {
  return text
    .split(/\n+/)
    .map(normalizeSnippet)
    .filter((line) => line.length >= 24)
    .filter((line) => !/^\[gate\]/i.test(line));
}

function classify(line: string, sourceType: SourceType): CandidateKind {
  const activeWant =
    /\b(looking for|seeking|wants?|needs?|open to|hiring|raising|building|working on|searching for|would like|trying to find)\b/i;
  const durableFact =
    /\b(is a|works on|works at|based in|lives in|focus(?:es)? on|interested in|expertise|background|affiliation|role|founder|researcher|engineer|designer|investor|operator)\b/i;

  if (sourceType === "forum_observation" || sourceType === "irl_observation" || sourceType === "session_provenance") {
    return "ranking_context_only";
  }
  if (activeWant.test(line)) return "intent";
  if (durableFact.test(line)) return "premise";
  return "ranking_context_only";
}

function candidatesFromFile(path: string, sourceType: SourceType): Candidate[] {
  const text = sourceText(path);
  if (!text.trim()) return [];
  const relPath = relative(ROOT, path) || path;
  return linesOfInterest(text).map((line) => {
    const kind = classify(line, sourceType);
    return {
      kind,
      text: line,
      sourceType,
      sourcePath: relPath,
      evidence: line,
      date: isoDateFromPath(path),
      confidence: kind === "ranking_context_only" ? "weak_context" : "candidate",
    };
  });
}

function dedupe(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function main(): void {
  const outPath = readFlag("--out") || DEFAULT_OUT;
  const candidates: Candidate[] = [];

  candidates.push(...candidatesFromFile(join(ROOT, "USER.md"), "user_notebook"));
  candidates.push(...candidatesFromFile(join(ROOT, "MEMORY.md"), "curated_memory"));

  for (const file of recentMarkdownFiles(join(ROOT, "memory"), 7)) {
    candidates.push(...candidatesFromFile(file, "daily_note"));
  }
  for (const file of recentMarkdownFiles(join(ROOT, "agent-memory-vault", "hermes", "sessions"), 6)) {
    candidates.push(...candidatesFromFile(file, "session_provenance"));
  }
  for (const file of recentMarkdownFiles(join(ROOT, "agent-memory-vault", "forum"), 6)) {
    candidates.push(...candidatesFromFile(file, "forum_observation"));
  }
  for (const file of recentMarkdownFiles(join(ROOT, "agent-memory-vault", "irl"), 8)) {
    candidates.push(...candidatesFromFile(file, "irl_observation"));
  }

  const bounded = dedupe(candidates).slice(0, MAX_CANDIDATES);
  const payload = {
    generatedAt: new Date().toISOString(),
    root: ROOT,
    candidateCount: bounded.length,
    candidates: bounded,
    policy: {
      indexWritableSources: ["user_notebook", "curated_memory"],
      corroborationSources: ["daily_note", "session_provenance"],
      contextOnlySources: ["forum_observation", "irl_observation"],
      note: "Open and verify canonical source files before any Index write. Forum/IRL/session observations are ranking/context/question sources unless corroborated by user-authored or curated memory.",
    },
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, out: outPath, candidateCount: bounded.length }));
}

main();
