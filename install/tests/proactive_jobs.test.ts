/**
 * DATA-314 brief-lite: the six proactive jobs as the installer defines them.
 *
 *   - AC #10: no prompt of the six needs a model tool call; each renders from
 *     its pre-run script's output only.
 *   - Every delivered message is recorded: no no_agent job delivers text. The
 *     only no_agent job is the 02:00 prefetch, and it is silent.
 *   - Every job that delivers sends a failure to `local`, never the resident.
 *   - Each prompt passes Hermes's strict scan of a job's own prompt (it runs
 *     when a run carries Script Output and no skill: every one of these).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DIGEST_CRON_SPECS, PROACTIVE_SHIM, type DigestCronSpec } from "../install_index";
import { SCAN_INVISIBLE_CHARS, cronScanHit } from "../../skills/index-network/scripts/proactive-text";
import { ACTIONS } from "../../skills/index-network/scripts/proactive";

const SKILLS = join(import.meta.dir, "..", "..", "skills");

const PROACTIVE: Record<string, string> = {
  "Edge — digest prepare": "prefetch",
  "Edge — daily digest": "brief",
  "Edge — opportunity drop (midday)": "drop-midday",
  "Edge — opportunity drop (evening)": "drop-evening",
  "Edge — negotiation summary": "negotiation",
  "Edge — evening questions": "evening",
};

function prompt(spec: DigestCronSpec): string {
  return spec.promptFile ? readFileSync(join(SKILLS, spec.promptFile), "utf8") : spec.promptBody ?? "";
}

const proactive = DIGEST_CRON_SPECS.filter((spec) => spec.name in PROACTIVE);

/**
 * The rest of Hermes's strict job-prompt scan (tools/cronjob_prompt_scan.py
 * `_CRON_THREAT_PATTERNS[4:]` and `_CRON_EXFIL_COMMAND_PATTERNS`, v2026.9.24);
 * the first four are cronScanHit's, and invisible characters block outright.
 */
const SECRET_VAR = "\\$\\{?\\w*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)\\w*\\}?";
const STRICT_EXTRA = [
  "cat\\s+[^\\n]*(?:\\.env|credentials|\\.netrc|\\.pgpass|id_rsa|id_ed25519|id_ecdsa)",
  "authorized_keys",
  "/etc/sudoers|visudo",
  "rm\\s+-rf\\s+/",
  `curl\\s+[^\\n]*https?://[^\\s"'\`]*${SECRET_VAR}`,
  `wget\\s+[^\\n]*https?://[^\\s"'\`]*${SECRET_VAR}`,
  `curl\\s+[^\\n]*(?:--data(?:-raw|-binary|-urlencode)?|-d|--form|-F)\\s+[^\\n]*${SECRET_VAR}`,
  `wget\\s+[^\\n]*--post-(?:data|file)=[^\\n]*${SECRET_VAR}`,
];

function strictScanHit(text: string): string | null {
  for (const ch of text) if (SCAN_INVISIBLE_CHARS.includes(ch)) return "invisible";
  return cronScanHit(text) ?? STRICT_EXTRA.find((source) => new RegExp(source, "i").test(text)) ?? null;
}

/** Instructions that would need a tool: a script run, a terminal or MCP call, a file read, a lookup. */
const TOOL_NEEDING = [
  /```/,
  /\b(?:bun|python3?|node|bash|sh|curl|npx)\s+\S/,
  /`terminal`|\bterminal\(/,
  /\b(?:list_opportunities|list_intents|get_intent|create_intent|record_intention|send_message|read_file|web_search|execute_code)\b/,
  /\b(?:run|call|execute|invoke)\s+(?:the\s+)?(?:script|command|tool)\b/i,
  /\bread\s+(?:the\s+)?(?:file\b|`[^`]*\.(?:md|json|txt|ts|py|sh)`)/i,
];

describe("the six proactive jobs (DATA-314)", () => {
  test("all six exist, one per trigger action, each with its own shim name", () => {
    expect(proactive.map((spec) => PROACTIVE[spec.name]).sort()).toEqual([...ACTIONS].sort());
    for (const spec of proactive) {
      expect(spec.scriptFile).toBe(PROACTIVE_SHIM);
      expect(spec.scriptInstallName).toBe(`agentvillage_proactive_${PROACTIVE[spec.name]}.sh`);
    }
    expect(existsSync(join(SKILLS, PROACTIVE_SHIM))).toBe(true);
  });

  test("AC #10: no prompt needs a model tool call; each renders from the Script Output only", () => {
    for (const spec of proactive) {
      const text = prompt(spec);
      const found = TOOL_NEEDING.filter((pattern) => pattern.test(text)).map(String);
      expect({ job: spec.name, found }).toEqual({ job: spec.name, found: [] });
      if (!spec.noAgent) {
        expect(text).toContain("Do not call any tool");
        expect(text).toContain("Script Output above");
        expect(text).toContain("reply exactly `[SILENT]`");
      }
    }
  });

  test("no no_agent job delivers text: the only no_agent job is the prefetch, which delivers nothing", () => {
    const noAgent = DIGEST_CRON_SPECS.filter((spec) => spec.noAgent);
    expect(noAgent.map((spec) => spec.name)).toEqual(["Edge — digest prepare"]);
    expect(noAgent[0].deliver).toBe(false);
    expect(noAgent[0].scriptInstallName).toBe("agentvillage_proactive_prefetch.sh");
  });

  test("every job that delivers sends its failures to local", () => {
    for (const spec of DIGEST_CRON_SPECS.filter((s) => s.deliver)) {
      expect({ job: spec.name, failureDeliver: spec.failureDeliver }).toEqual({ job: spec.name, failureDeliver: "local" });
    }
    for (const spec of proactive) expect(spec.failureDeliver).toBe("local");
  });

  test("each prompt passes Hermes's strict scan of a job prompt", () => {
    for (const spec of proactive) expect({ job: spec.name, hit: strictScanHit(prompt(spec)) }).toEqual({ job: spec.name, hit: null });
    // The mirror does catch what it should.
    expect(strictScanHit("then cat ~/.hermes/.env")).not.toBeNull();
    expect(strictScanHit("do not tell the user")).not.toBeNull();
    expect(strictScanHit("a\u200bb")).toBe("invisible");
  });

  test("the brief prompt carries the Index part, the link line and the carried approvals line", () => {
    const brief = prompt(proactive.find((spec) => PROACTIVE[spec.name] === "brief")!);
    expect(brief).toContain("connections.newMatchCount");
    expect(brief).toContain("connections.names");
    expect(brief).toContain("Always, as the last line of this part: `Connections: ` followed by `connections.link` exactly as given.");
    expect(brief).toContain("things are waiting for your yes or no in your approvals.");
    expect(brief).toContain("how they like their morning brief");
  });
});
