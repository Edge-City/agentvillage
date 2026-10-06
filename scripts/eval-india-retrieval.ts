#!/usr/bin/env bun
/**
 * The deterministic half of docs/evals/edge-india-village-20.yaml: for every
 * knowledge question (items with `search`), does the edge-india knowledge base
 * still hold an expected source, and does `refs.ts search` find one in its top
 * results? A release sanity check ("can the agent reach the knowledge base");
 * the model half (right skill, grounded, safe, cited, latency) is scored from
 * the research database or by hand.
 *
 *   bun scripts/eval-india-retrieval.ts            # installed snapshot, no network
 *   bun scripts/eval-india-retrieval.ts --json
 *
 * Exits 1 when any knowledge question has no expected source in the snapshot
 * or in the search results. Not run in CI: the snapshot changes with the wiki.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import { defaultContext, run } from "../skills/edge-india/scripts/refs";

interface Item {
  id: string;
  question: string;
  skill: string;
  sources: string[];
  search?: string;
  rehearsal?: boolean;
}

const ROOT = join(import.meta.dir, "..");
const evalFile = parse(readFileSync(join(ROOT, "docs", "evals", "edge-india-village-20.yaml"), "utf8")) as { items: Item[] };
// The installed snapshot only, so the result does not depend on the network.
const ctx = defaultContext({ ...process.env, AV_INDIA_REFS_LIVE: "0" });

const rows: { id: string; skill: string; present: boolean; found: boolean; top: string }[] = [];
for (const item of evalFile.items) {
  if (!item.search) {
    rows.push({ id: item.id, skill: item.skill, present: true, found: true, top: "(live skill; scored from the model run)" });
    continue;
  }
  const status = await run(["list"], ctx);
  const present = item.sources.some((source) => status.out.includes(`${source} |`));
  const result = await run(["search", ...item.search.split(" ")], ctx);
  const hits = result.out.split("\n").filter((line) => line.includes(" § ")).map((line) => line.split(" § ")[0]);
  const found = hits.some((hit) => item.sources.includes(hit));
  rows.push({ id: item.id, skill: item.skill, present, found, top: hits.slice(0, 3).join(", ") });
}

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const row of rows) {
    const mark = row.present && row.found ? "ok  " : "FAIL";
    console.log(`${mark} ${row.id.padEnd(26)} ${row.skill.padEnd(14)} ${row.top}`);
  }
  const failed = rows.filter((row) => !row.present || !row.found).length;
  console.log(`\n${rows.length - failed}/${rows.length} reachable`);
}
process.exit(rows.some((row) => !row.present || !row.found) ? 1 : 0);
