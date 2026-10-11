/**
 * Test only, never imported by the installer: `bun --preload install/tests/gate_verified_preload.ts
 * install/install.ts ...` runs the real install entry point with this run's approval verdict read as
 * verified (`lastInstallVerified()` true), so the Index plugin step is reached with the gate verified,
 * the condition the OV-249 post-hoc M1 broke (ov#277 refute S3). The approval step itself, its live
 * fire included, is install_approval.test.ts's. Throws when the function is not found, so a change to
 * it fails the tests that use this instead of passing them unverified.
 */
import { plugin } from "bun";
import { readFileSync } from "node:fs";

const VERDICT = "export function lastInstallVerified(): boolean {\n  return lastVerified;\n}";

plugin({
  name: "av-test-gate-verified",
  setup(build) {
    build.onLoad({ filter: /[\\/]install[\\/]install_approval\.ts$/ }, (args) => {
      const source = readFileSync(args.path, "utf8");
      if (source.split(VERDICT).length !== 2) throw new Error("gate_verified_preload: lastInstallVerified() not found");
      return { contents: source.replace(VERDICT, "export function lastInstallVerified(): boolean {\n  return true;\n}"), loader: "ts" };
    });
  },
});
