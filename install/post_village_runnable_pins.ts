/** Regenerate shipped runtime proof pins after reviewed gate changes; never tenant input. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DIGEST_CRON_SPECS, expectedCronScriptArg, templateCronSpec } from "./install_index";
import { postVillageKeyForJob } from "../skills/index-network/scripts/post-village-policy";
export function runnablePins() {
  const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
  const source = (path: string) => readFileSync(join(import.meta.dir, "..", path));
  const files = Object.fromEntries(["post-village-policy.ts", "job-holds.ts", "proactive.ts", "post-village-runnable.ts", "send-daily-brief.ts", "drop-opportunity.ts", "pending-alert.ts", "summarize-negotiations.ts"].map((name) => [`skills/index-network/scripts/${name}`, hash(source(`skills/index-network/scripts/${name}`))]));
  const specs = [...DIGEST_CRON_SPECS, templateCronSpec("brief", "0 9 * * *"), templateCronSpec("digest-preview", "0 9 * * *")].filter((spec) => postVillageKeyForJob(spec.name));
  const jobs = Object.fromEntries(specs.map((spec) => {
    if (!spec.scriptFile) throw new Error("covered-script-missing");
    const script = expectedCronScriptArg(spec)!;
    return [spec.name, { script, scriptSha256: hash(source(`skills/${spec.scriptFile}`)), promptSha256: hash((spec.promptFile ? source(`skills/${spec.promptFile}`).toString() : spec.promptBody ?? "").trimEnd()), noAgent: Boolean(spec.noAgent), failureDeliver: spec.failureDeliver }];
  }));
  return { files, jobs };
}
if (import.meta.main) writeFileSync(join(import.meta.dir, "../skills/index-network/scripts/post-village-runnable-pins.json"), JSON.stringify(runnablePins(), null, 2) + "\n");
