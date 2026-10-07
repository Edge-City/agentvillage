import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// R1 (overlay#200, controlplane#83): skills/approval/templates/APPROVAL.md documents the resident
// policy the control plane renders from its own templates/resident-approval-policy.md. The headers
// differ on purpose; the policy block (the yaml approval-policy fence to its closing fence) must be
// byte-identical. This copy had drifted once (DATA-253's prompt.always lines) and nothing caught it.
//
// 1. Always: this copy's policy block hashes to POLICY_BLOCK_SHA256. The control plane pins the
//    same digest (control-plane/tests/approval-template-mirror.test.js); move both pins together.
// 2. With AV_CONTROLPLANE_DIR set to an agentvillage-controlplane checkout: byte-for-byte compare.
//    Run: AV_CONTROLPLANE_DIR=/path/to/controlplane bun test scripts/tests/approval-template-mirror.test.ts
// R2 moved the pin (marketplace.app.install/action/read, review.delegate.model, resource.allocate and
// the odin.* comment; seven added lines).
// R3 (DATA-344) moved it again: `defaults.unmapped_tool: record` and the APRV-499 `tools:` list
// (approval.md 0.4.2; a 0.4.0 or 0.4.1 daemon refuses both keys and fails every class closed), and
// the reserved opportunity.accept row its accept_opportunity lines map to. Its fix round 2 moved it
// once more: the plugin's index_update_opportunity and Index's reject_opportunity map to
// opportunity.accept (accept or decline), the phantom index_accept_opportunity line is gone, and the
// row's comment says the hook judges it.
// DATA-370 moved it: `prompt.style: minimal` (Carter's ruling: the default for every resident; the
// line stands alone because the app's Approvals setting rewrites it) and the `say:` block, one entry
// per class a resident can be asked about whose payload keys are known (approval.md 0.4.1+, APRV-489).
// Its fix round (CARD-refute) reworded the `does` lines, dropped village.vote's default `note` and
// the opportunity.accept entry (the control plane's say test wants every entry to be a class row
// there, and its row arrives with cp#108).
// The R3 landing (controlplane#108 merged with cp main's #118/#120, paired with this PR) moved it
// once more: the opportunity.accept say entry is back ({tool, input}: only an Index tool call the
// hook routes reaches the class), now that the control plane's copy carries the row. Both copies'
// blocks are R3 + DATA-370 + that entry, and the two pins are equal again.
const POLICY_BLOCK_SHA256 = "67dc1fb0ce9f7fc3d505d2881cb39dd82e2dd6cd3d7162794277c22e773f40d9";

const OPEN = "```yaml approval-policy\n";
function policyBlock(text: string): string {
  const start = text.indexOf(OPEN);
  if (start < 0 || text.indexOf(OPEN, start + 1) >= 0) throw new Error("exactly one policy fence expected");
  const end = text.indexOf("\n```", start + OPEN.length);
  if (end < 0) throw new Error("unclosed policy fence");
  return text.slice(start, end + 4);
}
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const overlayText = readFileSync(join(import.meta.dir, "..", "..", "skills", "approval", "templates", "APPROVAL.md"), "utf8");
const cpDir = process.env.AV_CONTROLPLANE_DIR ?? "";
const cpPath = cpDir ? join(cpDir, "control-plane", "templates", "resident-approval-policy.md") : "";

describe("the resident policy block mirrors the control plane's template", () => {
  test("this copy's policy block is the pinned one (the control plane pins the same digest)", () => {
    const block = policyBlock(overlayText);
    expect(block.endsWith("\n```")).toBe(true);
    expect(sha(block)).toBe(POLICY_BLOCK_SHA256);
  });

  test.skipIf(!cpDir)("with AV_CONTROLPLANE_DIR: the control plane's policy block is byte-identical", () => {
    expect(existsSync(cpPath)).toBe(true);
    const a = policyBlock(readFileSync(cpPath, "utf8")).split("\n");
    const b = policyBlock(overlayText).split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) expect([i + 1, b[i]]).toEqual([i + 1, a[i]]);
  });
});
