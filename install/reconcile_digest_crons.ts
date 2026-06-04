#!/usr/bin/env bun
/**
 * Reconcile AgentVillage's stored Hermes digest cron jobs with the currently
 * installed prompt files under `$HERMES_HOME/skills/index-network/prompts`.
 *
 * Hermes stores a copy of each cron prompt at creation time, so updating the
 * workspace files alone does not update existing residents' scheduled jobs.
 * Run this after copying new skill files into a resident workspace, or as a
 * fleet repair command, to remove stale Edge digest jobs and recreate them with
 * current prompt bodies while preserving all user memory and Kanban data.
 *
 * Usage:
 *   HERMES_HOME=/opt/data bun install/reconcile_digest_crons.ts
 */

import { hermesExecEnv } from "./hermes_cli";
import { reconcileDigestCronJobs } from "./install_index";

console.log("AgentVillage digest cron reconciler");
console.log("====================================");
reconcileDigestCronJobs(hermesExecEnv());
console.log("✓ digest crons reconciled");
