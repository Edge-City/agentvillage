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
// DATA-370 moved it: `prompt.style: minimal` (Carter's ruling: the default for every resident; the
// line stands alone because the app's Approvals setting rewrites it) and the `say:` block, one entry
// per class a resident can be asked about whose payload keys are known (approval.md 0.4.1+, APRV-489).
const POLICY_BLOCK_SHA256 = "3ba7de95486bde625c00f2e9fc94516f514d11fad623e0872bdb72f94d20c1ca";

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
