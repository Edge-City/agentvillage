#!/usr/bin/env bun
/**
 * Reconcile AgentVillage's stored Hermes Index cron jobs with the currently
 * installed prompt files under `$HERMES_HOME/skills`.
 *
 * Hermes stores a copy of each cron prompt at creation time, so updating the
 * workspace files alone does not update existing residents' scheduled jobs.
 * Run this after copying new skill files into a resident workspace, or as a
 * fleet repair command: retired Edge cron jobs are removed, and each current
 * one is edited in place (prompt, script, agent mode, failure target; id,
 * schedule, pause state and next run kept, DATA-314), preserving all user
 * memory and Kanban data. It also sets `cron.script_timeout_seconds` as
 * install.ts does.
 *
 * Usage:
 *   HERMES_HOME=/opt/data bun install/reconcile_digest_crons.ts
 */

import { configureCronScriptTimeout } from "./config";
import { hermesExecEnv } from "./hermes_cli";
import { reconcileDigestCronJobs } from "./install_index";

console.log("AgentVillage Index cron reconciler");
console.log("===================================");
// The proactive triggers' budgets need it, as install.ts sets it (DATA-314).
configureCronScriptTimeout();
const failed = reconcileDigestCronJobs(hermesExecEnv());
if (failed.length > 0) {
  // Every job was attempted; a mixed tenant is reported, never silent (B1-fix F9).
  console.error(`error: ${failed.length} Index cron job(s) failed to update (${failed.join(", ")})`);
  process.exit(1);
}
console.log("✓ Index crons reconciled");
