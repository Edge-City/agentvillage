/**
 * R-DEON proof harness: on a box-shaped prompt, does Haiku call `ask_village` for the resident's two
 * phrasings? Off unless `AV_RDEON_PROOF=1`, so CI (and a plain `bun test`) never calls the API.
 *
 * Box shape, as Hermes v2026.9.24 assembles a resident's DM turn once av-events keeps the village
 * tools visible (plugins/av-events/_village_visible.py):
 * - system: `## AGENTS.md\n\n` + workspace/AGENTS.md (prompt_builder.py `_context_section`, the label
 *   scripts/tests/agents-md-budget.test.ts measures);
 * - tools: the village tools exactly as their plugins register them (name, description, parameters:
 *   av-events `ask_village` / `search_village` / `query_village`, read from the plugin with python3;
 *   village-bridge's `village`, its `SCHEMA` literal), a stand-in for the core tools a Telegram DM
 *   keeps, and Hermes's `tool_search` bridge for everything else (`session_search` and the other
 *   plugin tools are behind it). `AV_RDEON_ARM=before` puts the village tools behind the bridge too,
 *   as on the resident's box (17 Oct), for contrast.
 *
 * Run (Carter's hands; the key is read by name, never printed):
 *   AV_RDEON_PROOF=1 ANTHROPIC_API_KEY=... bun test scripts/tests/rdeon-haiku-proof.test.ts
 * Optional: AV_RDEON_RUNS (default 3 per phrasing), AV_RDEON_MODEL (default claude-haiku-5-5),
 * AV_RDEON_ARM=after|before (default after; only `after` asserts). Output: tool call names only.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const GATE = process.env.AV_RDEON_PROOF === "1";
const MODEL = process.env.AV_RDEON_MODEL?.trim() || "claude-haiku-5-5";
const RUNS = Math.max(1, Math.min(10, Number(process.env.AV_RDEON_RUNS ?? "3") || 3));
const ARM = process.env.AV_RDEON_ARM === "before" ? "before" : "after";

/** The resident's two phrasings (R-DEON, CLAIMS L10388). */
export const PHRASINGS = ["what's going on in the group chat", "ask the village"] as const;

type Tool = { name: string; description: string; input_schema: Record<string, unknown> };

/** The village tools as registered: av-events through its own package import, village-bridge from its literal. */
function villageTools(): Tool[] {
  const script = String.raw`
import ast, importlib.util, json, sys, types
from pathlib import Path
repo = Path(sys.argv[1])
d = repo / "plugins" / "av-events"
parent = types.ModuleType("hermes_plugins"); parent.__path__ = []
sys.modules["hermes_plugins"] = parent
spec = importlib.util.spec_from_file_location("hermes_plugins.av_events", d / "__init__.py", submodule_search_locations=[str(d)])
m = importlib.util.module_from_spec(spec); sys.modules["hermes_plugins.av_events"] = m; spec.loader.exec_module(m)
out = [sys.modules["hermes_plugins.av_events." + n].TOOL_SCHEMA for n in ("_ask_village", "_search_village", "_query_village")]
tree = ast.parse((repo / "plugins" / "village-bridge" / "__init__.py").read_text(encoding="utf-8"))
out += [ast.literal_eval(n.value) for n in tree.body if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", None) == "SCHEMA"]
print(json.dumps(out))
`;
  const raw = execFileSync("python3", ["-I", "-c", script, REPO], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
  return (JSON.parse(raw) as { name: string; description: string; parameters: Record<string, unknown> }[]).map((s) => ({
    name: s.name,
    description: s.description,
    input_schema: s.parameters,
  }));
}

const stub = (name: string, description: string, properties: Record<string, unknown> = {}): Tool => ({
  name,
  description,
  input_schema: { type: "object", properties },
});

/** Stand-ins for the core tools a resident's Telegram DM keeps visible (names as Hermes registers them). */
const CORE: Tool[] = [
  stub("terminal", "Run a shell command on the agent's machine and return its output.", { command: { type: "string" } }),
  stub("read_file", "Read a text file from the agent's machine.", { path: { type: "string" } }),
  stub("web_search", "Search the web and return result titles, links and snippets.", { query: { type: "string" } }),
  stub("web_extract", "Fetch web pages and return their text.", { urls: { type: "array", items: { type: "string" } } }),
  stub("memory", "Add, replace or remove an entry in the agent's long-term memory (MEMORY.md or USER.md).", {
    action: { type: "string" },
    target: { type: "string" },
    content: { type: "string" },
  }),
  stub("skills_list", "List the installed skills with their descriptions.", {}),
  stub("skill_view", "Load a skill's instructions (SKILL.md) or one of its files.", { name: { type: "string" } }),
  stub("clarify", "Ask the user a clarifying question.", { question: { type: "string" } }),
  stub("execute_code", "Run a Python script.", { code: { type: "string" } }),
  stub("recall", "Search earlier turns of this conversation that were summarised away.", { query: { type: "string" } }),
];

/** Hermes's bridge (tools/tool_search.py `_search_description` and `bridge_tool_schemas`, no listing). */
function bridge(deferred: number): Tool[] {
  return [
    stub(
      "tool_search",
      `Search ${deferred} additional tools that are loaded on demand. Takes a list of queries searched in parallel against the same catalog; send one query per distinct capability you need. Queries are keyword searches, not questions: the app or service name plus an action and object, no filler words (\`gmail send email\`, \`nvidia driver status\`, not \`what's my GPU driver version?\`); a word no tool contains makes the query return nothing. Returns matching tool names grouped per query plus a shared map with each tool's description. Follow with \`tool_describe\` to load full parameter schemas, then \`tool_call\` to invoke. Tools listed at the top of this system prompt are already available and do not need to be searched.`,
      { queries: { type: "array", items: { type: "string" } }, limit: { type: "integer" } },
    ),
    stub("tool_describe", "Load the full parameter schemas of deferred tools by name.", { names: { type: "array", items: { type: "string" } } }),
    stub("tool_call", "Invoke deferred tools. Takes `calls`, an array of {name, arguments}.", {
      calls: { type: "array", items: { type: "object" } },
    }),
  ];
}

export function boxShapedRequest(phrasing: string, arm: "after" | "before" = "after") {
  const agents = readFileSync(join(REPO, "workspace", "AGENTS.md"), "utf8");
  const village = villageTools();
  // 48 deferred on the resident's box with ask_village among them; after the fix the village tools are listed.
  const tools = arm === "after" ? [...CORE, ...village, ...bridge(48 - 2)] : [...CORE, ...bridge(48)];
  return {
    model: MODEL,
    max_tokens: 2048,
    system: `## AGENTS.md\n\n${agents}`,
    tools,
    messages: [{ role: "user", content: `[Sat 2026-10-17 14:27:22 IST] ${phrasing}` }],
  };
}

async function toolCallNames(body: unknown): Promise<string[]> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set (checked by name only)");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Messages API answered HTTP ${response.status}`);
  const message = (await response.json()) as { content?: { type: string; name?: string }[]; stop_reason?: string };
  const names = (message.content ?? []).filter((b) => b.type === "tool_use").map((b) => b.name ?? "");
  return names.length ? names : [`(no tool call; stop_reason=${message.stop_reason ?? "?"})`];
}

describe.skipIf(!GATE)(`R-DEON proof: ${MODEL} on the box-shaped prompt (arm ${ARM})`, () => {
  for (const phrasing of PHRASINGS) {
    test(
      `"${phrasing}" -> ask_village (${RUNS} runs)`,
      async () => {
        const runs: string[][] = [];
        for (let i = 0; i < RUNS; i += 1) runs.push(await toolCallNames(boxShapedRequest(phrasing, ARM)));
        // Tool call names only: never the model's text.
        console.log(`R-DEON ${ARM} "${phrasing}": ${runs.map((r) => r.join("+")).join(" | ")}`);
        if (ARM === "after") for (const names of runs) expect(names).toContain("ask_village");
      },
      120_000,
    );
  }
});

// Offline, no API call: the request the gated test sends is box-shaped.
test("the box-shaped request: AGENTS.md labelled, the village tools listed after the fix, behind the bridge before", () => {
  const after = boxShapedRequest(PHRASINGS[0], "after");
  const before = boxShapedRequest(PHRASINGS[0], "before");
  expect(after.system.startsWith("## AGENTS.md\n\n# AGENTS.md")).toBe(true);
  const names = (r: typeof after) => r.tools.map((t) => t.name);
  for (const name of ["ask_village", "search_village", "query_village", "village"]) {
    expect(names(after)).toContain(name);
    expect(names(before)).not.toContain(name);
  }
  expect(names(after)).toContain("tool_search");
  expect(names(after)).not.toContain("session_search");
  const ask = after.tools.find((t) => t.name === "ask_village");
  expect(ask?.description.startsWith("Village group chat:")).toBe(true);
  expect(Object.keys((ask?.input_schema as { properties: object }).properties)).toContain("question");
});
