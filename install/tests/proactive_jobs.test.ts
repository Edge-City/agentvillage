/**
 * DATA-314 brief-lite: the six proactive jobs as the installer defines them.
 *
 *   - AC #10: no prompt of the six needs a model tool call; each renders from
 *     its pre-run script's output only.
 *   - Every delivered message is recorded: no no_agent job delivers text. The
 *     no_agent jobs are the 02:00 prefetch and the knowledge sync (K1), both silent.
 *   - Every job that delivers sends a failure to `local`, never the resident.
 *   - Each prompt passes Hermes's strict scan of a job's own prompt (it runs
 *     when a run carries Script Output and no skill: every one of these).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DIGEST_CRON_SPECS, PREFETCH_PROMPT, PROACTIVE_SHIM, type DigestCronSpec } from "../install_index";
import { SCAN_INVISIBLE_CHARS, cronScanHit } from "../../skills/index-network/scripts/proactive-text";
import { ACTIONS } from "../../skills/index-network/scripts/proactive";
import { createHash } from "node:crypto";
import { KEY_REMOVE, QUESTION_SPACES, outcomeQuestion, questionKey, questionSha256 } from "../../skills/index-network/scripts/outcome-ask";

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

/** The one line every resident-facing prompt carries (B1-fix F3). */
const SCRIPT_ERROR_LINE = "If the block above is headed Script Error, or there is no Script Output above, reply exactly `[SILENT]`.";

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

  test("F3: every resident-facing prompt replies [SILENT] on a Script Error block or no Script Output", () => {
    // A timed-out, missing or cancelled pre-run script skips the wake gate and
    // Hermes heads the block "## Script Error" with "Report this to the user."
    const delivering = proactive.filter((spec) => spec.deliver);
    expect(delivering).toHaveLength(5);
    for (const spec of delivering) {
      expect({ job: spec.name, has: prompt(spec).includes(SCRIPT_ERROR_LINE) }).toEqual({ job: spec.name, has: true });
    }
  });

  test("F11: AGENTS.md, which Hermes loads into these runs, sends no Script Output job to look anything up", () => {
    const agents = readFileSync(join(import.meta.dir, "..", "..", "workspace", "AGENTS.md"), "utf8");
    const line = agents.split("\n").find((l) => l.includes("pre-fetch network data"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/or a cron fires\.(\s|$)/);
    expect(line).toContain("whose prompt says to write only from the Script Output is not one of those");
    expect(line).toContain("call no tool");
  });

  test("F12: the prefetch's prompt ends by telling a model that reads it (after the rollback command) to reply [SILENT]", () => {
    const prefetch = proactive.find((spec) => spec.noAgent)!;
    expect(prompt(prefetch)).toBe(PREFETCH_PROMPT);
    expect(PREFETCH_PROMPT.endsWith(" If you are a model reading this, reply exactly `[SILENT]`.")).toBe(true);
  });

  test("no no_agent job delivers text: the no_agent jobs are the prefetch and the knowledge sync (K1), and neither delivers", () => {
    const noAgent = DIGEST_CRON_SPECS.filter((spec) => spec.noAgent);
    expect(noAgent.map((spec) => spec.name)).toEqual(["Edge — digest prepare", "Edge — knowledge sync"]);
    expect(noAgent.map((spec) => spec.scriptInstallName)).toEqual(["agentvillage_proactive_prefetch.sh", "agentvillage_knowledge_sync.sh"]);
    for (const spec of noAgent) {
      expect({ job: spec.name, deliver: spec.deliver, failureDeliver: spec.failureDeliver }).toEqual({ job: spec.name, deliver: false, failureDeliver: "local" });
    }
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

  test("DATA-42: the 14:00 follow-up no longer asks how a connection went; the evening asks the one fixed question", () => {
    const followUpPrompt = prompt(proactive.find((spec) => PROACTIVE[spec.name] === "negotiation")!);
    expect(followUpPrompt).not.toMatch(/reply met|not useful|missed/i);
    expect(followUpPrompt).toContain("Ask nothing about how it went");
    const evening = prompt(proactive.find((spec) => PROACTIVE[spec.name] === "evening")!);
    expect(evening).toContain("With `outcomeQuestion`: deliver it as the whole reply, word for word, and nothing else.");
    expect(evening).toContain("`Did you and <name> meet? Reply met, not useful, or missed.`");
    expect(outcomeQuestion("Maya")).toBe("Did you and Maya meet? Reply met, not useful, or missed.");
  });

  test("DATA-42 F2: the plugin arms only on a normalised reply that fully matches the one shared sentence, and the prompt's sentence matches it", () => {
    // plugins/av-events/outcome_question.json: every rule the plugin's `is_the_question` uses, and the cases both suites check.
    const seed = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "plugins", "av-events", "outcome_question.json"), "utf8"));
    expect(seed.sentence).toBe("Did you and [^?\\n]{1,64} meet\\? [Rr][Ee][Pp][Ll][Yy] met, not useful, or missed\\.?");
    const pattern = new RegExp(`^(?:${seed.sentence})$`, "u");
    // The plugin's `normalise_reply`, step for step from the file's `normalise`.
    const emoji = (ch: string) => /[\u200d\ufe0e\ufe0f\u20e3]/u.test(ch) || /\p{So}/u.test(ch) || /[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u.test(ch);
    const stripTrailingEmoji = (text: string) => {
      const chars = Array.from(text);
      while (chars.length && (/\s/u.test(chars[chars.length - 1]) || emoji(chars[chars.length - 1]))) chars.pop();
      return chars.join("");
    };
    const normalise = (reply: string) => {
      let text = reply;
      for (const space of seed.normalise.spaces as string[]) text = text.split(space).join(" ");
      text = stripTrailingEmoji(text.trim());
      for (const [opening, closing] of seed.normalise.wrappers as Array<[string, string]>) {
        if (text.length > opening.length + closing.length && text.startsWith(opening) && text.endsWith(closing)) {
          text = text.slice(opening.length, text.length - closing.length);
          break;
        }
      }
      return stripTrailingEmoji(text.trim());
    };
    const arms = (reply: string) => pattern.test(normalise(reply));
    for (const { reply } of seed.cases.arm as Array<{ reply: string }>) expect([reply, arms(reply)]).toEqual([reply, true]);
    for (const reply of seed.cases.unarmed as string[]) expect([reply, arms(reply)]).toEqual([reply, false]);
    // The sentence the evening prompt pins, with a name in it, and the trigger's own question: exactly, with no normalising.
    const evening = prompt(proactive.find((spec) => PROACTIVE[spec.name] === "evening")!);
    const sentence = evening.match(/`(Did you and <name> meet\? [^`]+)`/)![1];
    expect(pattern.test(sentence.replace("<name>", "Maya"))).toBe(true);
    expect(pattern.test(outcomeQuestion("Maya"))).toBe(true);
    expect(pattern.test(outcomeQuestion("M".repeat(40)))).toBe(true);
    expect(arms(`Hi! ${outcomeQuestion("Maya")}`)).toBe(false);
  });

  test("DATA-42 round 3: the trigger's question key and hash are the plugin's, case for case", () => {
    // The stage's `question_sha256` is the trigger's `questionSha256` of the question it shows; the plugin
    // arms only when its own `question_sha256` of the normalised reply is equal. Both are checked against
    // the same keys and hashes in plugins/av-events/outcome_question.json.
    const seed = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "plugins", "av-events", "outcome_question.json"), "utf8"));
    expect(KEY_REMOVE).toBe(seed.key.remove);
    expect(QUESTION_SPACES).toEqual(seed.normalise.spaces);
    const emoji = (ch: string) => /[\u200d\ufe0e\ufe0f\u20e3]/u.test(ch) || /\p{So}/u.test(ch) || /[\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u.test(ch);
    const stripTrailingEmoji = (text: string) => {
      const chars = Array.from(text);
      while (chars.length && (/\s/u.test(chars[chars.length - 1]) || emoji(chars[chars.length - 1]))) chars.pop();
      return chars.join("");
    };
    const normalise = (reply: string) => {
      let text = reply;
      for (const space of seed.normalise.spaces as string[]) text = text.split(space).join(" ");
      text = stripTrailingEmoji(text.trim());
      for (const [opening, closing] of seed.normalise.wrappers as Array<[string, string]>) {
        if (text.length > opening.length + closing.length && text.startsWith(opening) && text.endsWith(closing)) {
          text = text.slice(opening.length, text.length - closing.length);
          break;
        }
      }
      return stripTrailingEmoji(text.trim());
    };
    for (const { reply, key, sha256 } of seed.cases.arm as Array<{ reply: string; key: string; sha256: string }>) {
      expect([reply, questionKey(normalise(reply))]).toEqual([reply, key]);
      expect([reply, questionSha256(normalise(reply))]).toEqual([reply, sha256]);
      expect(createHash("sha256").update(key, "utf8").digest("hex")).toBe(sha256);
    }
    // The trigger's own question for a name has the key the plugin expects of a reply with that name.
    expect(questionKey(outcomeQuestion("Maya"))).toBe("did you and maya meet? reply met, not useful, or missed");
    const shownHash = questionSha256(outcomeQuestion(seed.cases.mismatch.shown_name));
    expect(shownHash).toBe((seed.cases.arm as Array<{ reply: string; sha256: string }>)[0].sha256);
    for (const reply of seed.cases.mismatch.replies as string[]) expect([reply, questionSha256(normalise(reply)) === shownHash]).toEqual([reply, false]);
  });
});
