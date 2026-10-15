/**
 * Test only, never imported by the installer: `bun --preload install/tests/gate_receipt_preload.ts
 * install/install.ts ...` runs the real install entry point as if this run's approval step had
 * installed the gate, so `gateReceiptLine()` prints a receipt for a valid AV_GATE_NONCE. The
 * approval step itself is install_approval.test.ts's; this exists so code_exec_install.test.ts can
 * show which runs end with a receipt. Throws when the function is not found, so a change to it fails
 * the tests that use this instead of passing them unverified.
 */
import { plugin } from "bun";
import { readFileSync } from "node:fs";

const SIGNATURE =
  "export function gateReceiptLine(nonce: string | undefined = process.env.AV_GATE_NONCE, routed: RoutedFacts | null = lastRouted): string | null {";

plugin({
  name: "av-test-gate-receipt",
  setup(build) {
    build.onLoad({ filter: /[\\/]install[\\/]install_approval\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (source.split(SIGNATURE).length !== 2) throw new Error("gate_receipt_preload: gateReceiptLine() not found");
      const routed = '{ entries: 35, sha256: "551d13e3861b9fb80e4f2af33d5d5ef04d0faf22a78a43b05bc663dc6ab72cbc" }';
      return {
        contents: source.replace(SIGNATURE, `${SIGNATURE}\n  routed = routed ?? ${routed};`),
        loader: "ts",
      };
    });
  },
});
