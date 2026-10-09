#!/usr/bin/env bun
/**
 * Edge Hermes installer (orchestrator).
 *
 * Installs into Hermes defaults (flat under `$HERMES_HOME`):
 *
 *   - `SOUL.md` → `$HERMES_HOME/SOUL.md` (identity; overwrites generic Hermes soul)
 *   - `AGENTS.md`, `USER.md` → `$HERMES_HOME/`
 *   - Edge skill bundles → `$HERMES_HOME/skills/{index-network,edgeos,edge-india,edge-esmeralda,…}/`
 *     (`skill_copy.ts`; `edge-india/references` is replaced, not merged, so upstream deletions land)
 *   - retired skill bundles (`RETIRED_SKILL_DIRS`, e.g. `geo-esmeralda`) → removed from `$HERMES_HOME/skills/`
 *   - `terminal.cwd` in config.yaml → `$HERMES_HOME`
 *   - Telegram display: no reasoning, no tool-progress message (only the 3-minute heartbeat; `display_defaults.ts`; `AV_DISPLAY_DEFAULTS=0` skips)
 *   - STT enabled with Groq Whisper so voice notes are auto-transcribed
 *   - Telegram backlog kept across gateway restarts (`platforms.telegram.extra.drop_pending_on_cold_boot: false`, only when unset)
 *   - Cron in village time (`timezone: Asia/Kolkata`, only when no zone is configured; a loud warning when another is)
 *   - `cron.script_timeout_seconds: 120` when unset, Hermes's default 3600, or lower (the proactive triggers' budgets)
 *   - `context_file_max_chars: 48000` unless already 48000 or more (Hermes's dynamic 21,600 cap truncated AGENTS.md)
 *   - Index MCP + morning digest cron (`install_index.ts`)
 *   - Index Hermes plugin (`index-network`): install or update, then enable; seed `$HERMES_HOME/index/negotiator.ts` only when absent (`install_index_plugin.ts`)
 *   - opt-in recall skill + plugin when `AV_RECALL_ENABLED=1` (`install_recall.ts`)
 *   - opt-in approval.md gate when `AV_APPROVAL_ENABLED=1` (`install_approval.ts`):
 *     a failure there exits non-zero, because an opted-in tenant left ungated
 *     is the failure the gate exists to prevent
 *   - an Index cron job that fails to update does not fail the install (exit
 *     0): every run writes `$HERMES_HOME/av-events/install-status.json`
 *     (`install_status.ts`, `cron_failed` empty when none failed), and a run
 *     with failures prints one line, `agentvillage-install: cron_failed=<n>`
 *
 * Usage (from repo root):
 *   bun install/install.ts --index-api-key <KEY>
 *   bun install/install.ts --index-api-key <KEY> --dev
 *   bun install/install.ts --index-api-key <KEY> --wipe-user
 *   bun install/install.ts --index-api-key <KEY> --no-restart   # containers (gateway starts after)
 */

import {
  existsSync,
  copyFileSync,
  lstatSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

import { installIndex } from "./install_index";
import { installIndexPlugin } from "./install_index_plugin";
import { installEdgeos } from "./install_edgeos";
import { safeInstallRecall, wipeRecallIndex } from "./install_recall";
import { gateReceiptLine, runApprovalStep, stagePlugins } from "./install_approval";
import {
  capModelMaxTokens,
  configureAvEvents,
  configureCronScriptTimeout,
  configureCronWrapResponse,
  configureIndexLinks,
  configureDashboardAuth,
  configureHostedGateway,
  configureStt,
  configureVillageTimezone,
  disableTelegramLinkPreviews,
  keepTelegramBacklogOnColdBoot,
  setCompactionSettings,
  setContextFileMaxChars,
  setTerminalCwd,
} from "./config";
import { configureTelegramDisplay } from "./display_defaults";
import { configureAvDisplay } from "./av_display";
import { copySkillBundles, removeRetiredSkillDirs } from "./skill_copy";
import { hermesBin, hermesExecEnv, hermesRunner } from "./hermes_cli";
import {
  EDGE_SKILL_NAMES,
  hermesHome,
  skillsDir,
  targetWorkspace,
} from "./paths";
import { captureWelcomeState, restoreWelcomeState } from "./welcome_state";
import { describeResult, regenerateKnowledgeIndex } from "./knowledge-index";
import { cronFailedLine, writeInstallStatus } from "./install_status";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_WORKSPACE = join(SCRIPT_DIR, "../workspace");
const SOURCE_SKILLS = join(SCRIPT_DIR, "../skills");
const SOURCE_PLUGINS = join(SCRIPT_DIR, "../plugins");
const TARGET_HOME = targetWorkspace();

function ensureHermesAvailable(): void {
  if (process.argv.includes("--no-restart")) return;

  const bin = hermesBin();
  try {
    execSync(`"${bin}" --version`, { stdio: "ignore", env: hermesExecEnv() });
  } catch {
    console.error("error: `hermes` CLI not found on PATH");
    console.error("       install Hermes first: https://github.com/NousResearch/hermes-agent");
    process.exit(1);
  }
}

function removeLegacyWorkspaceEdge(): void {
  const legacy = join(hermesHome(), "workspace", "edge");
  if (!existsSync(legacy)) return;
  rmSync(legacy, { recursive: true, force: true });
  console.log(`→ removed legacy ${legacy}`);
}

function removeRetiredFiles(): void {
  // SCHEDULE.md is no longer shipped; clear stale copies from prior installs.
  const stale = join(hermesHome(), "SCHEDULE.md");
  if (existsSync(stale)) {
    rmSync(stale, { force: true });
    console.log(`→ removed retired ${stale}`);
  }
}

function copySoulFile(): void {
  const sourceSoul = join(SOURCE_WORKSPACE, "SOUL.md");
  const targetSoul = join(hermesHome(), "SOUL.md");
  if (!existsSync(sourceSoul)) return;
  if (process.argv.includes("--preserve-context") && existsSync(targetSoul)) return;
  copyFileSync(sourceSoul, targetSoul);
  console.log(`→ wrote SOUL.md to ${targetSoul}`);
}

function copyWorkspaceFiles(wipeUser: boolean): void {
  if (!existsSync(SOURCE_WORKSPACE)) {
    console.error(`error: bundled workspace missing at ${SOURCE_WORKSPACE}`);
    process.exit(1);
  }

  let copied = 0;
  let preservedUserNotes = false;
  for (const entry of readdirSync(SOURCE_WORKSPACE)) {
    if (entry === "SOUL.md") continue;

    const sourcePath = join(SOURCE_WORKSPACE, entry);
    const targetPath = join(TARGET_HOME, entry);
    const stat = statSync(sourcePath);

    if (stat.isDirectory()) continue;

    if (!entry.endsWith(".md")) continue;
    if (process.argv.includes("--preserve-context") && existsSync(targetPath)) continue;


    if (entry === "USER.md" && !wipeUser && existsSync(targetPath)) {
      preservedUserNotes = true;
      continue;
    }
    copyFileSync(sourcePath, targetPath);
    copied++;
  }

  console.log(`→ staged ${copied} project files into ${TARGET_HOME}`);
  if (preservedUserNotes) {
    console.log("  (USER.md preserved — pass --wipe-user to overwrite it)");
  }

  if (wipeUser) {
    const filesToWipe = [
      join(TARGET_HOME, "MEMORY.md"),
      join(TARGET_HOME, "memory", "agentvillage-state.json"),
      join(TARGET_HOME, "memory", "edge-state.json"),
      join(TARGET_HOME, "memory", "welcome-state.json"),
    ];
    for (const path of filesToWipe) {
      if (existsSync(path)) {
        rmSync(path, { force: true });
        console.log(`→ removed ${path.replace(TARGET_HOME + "/", "")} (--wipe-user)`);
      }
    }
    // What the previous user shared goes first, then the recall index, which holds copies of
    // MEMORY.md, notes and knowledge files; the epoch keeps earlier conversations out of any
    // future index. (The other order left a window in which a live recall could re-index the
    // old knowledge files after the index wipe.)
    wipeKnowledgeAgentvillage();
    wipeRecallIndex();
  }
}

/**
 * `--wipe-user`: what the previous user shared on the Context page
 * (`knowledge/agentvillage/`, written by the control plane's renderer), then
 * `knowledge/index.md` regenerated. `knowledge/edge-india/` (public) and
 * `knowledge-prev/` stay. A failed index step is a warning, never fatal.
 */
function wipeKnowledgeAgentvillage(): void {
  const target = join(TARGET_HOME, "knowledge", "agentvillage");
  let present = true;
  try {
    lstatSync(target); // a dangling symlink counts: it goes too
  } catch {
    present = false;
  }
  if (present) {
    rmSync(target, { recursive: true, force: true });
    console.log(`→ removed ${target.replace(TARGET_HOME + "/", "")} (--wipe-user)`);
  }
  try {
    console.log(`→ ${describeResult(regenerateKnowledgeIndex(TARGET_HOME))}`);
  } catch {
    console.warn("  warning: could not regenerate knowledge/index.md");
  }
}

/**
 * N3 (R3 fix round 2): `before-approval` stages every plugin but an installed
 * `av-approval`, whose new copy waits for the approval step (`after-approval`,
 * below): its matcher list must never run ahead of the hooks block that step
 * writes (`stagePlugins` in install_approval.ts).
 */
function copyPluginFiles(phase: "before-approval" | "after-approval"): void {
  const target = join(hermesHome(), "plugins");
  const copied = stagePlugins(SOURCE_PLUGINS, target, phase);
  if (copied > 0) console.log(`→ staged ${copied} plugin files into ${target}${phase === "after-approval" ? " (av-approval, after the approval step)" : ""}`);
}

function copySkillFiles(): void {
  const targetSkillsRoot = skillsDir();
  removeRetiredSkillDirs(targetSkillsRoot);
  const copied = copySkillBundles(SOURCE_SKILLS, targetSkillsRoot);
  if (copied > 0) {
    console.log(`→ staged ${copied} files into ${targetSkillsRoot}/{${EDGE_SKILL_NAMES.join(",")}}`);
  }
}

/** Clone or update `index-network`, enable it, and seed the negotiator file. A failure does not stop the install. */
function installIndexHermesPlugin(): void {
  try {
    installIndexPlugin(hermesRunner(hermesBin(), hermesExecEnv(), 120_000));
  } catch (err) {
    const kind = err instanceof Error ? err.name : typeof err;
    console.warn(`  warning: index-network plugin was not installed (${kind}) — core install continues`);
  }
}

function restartGateway(): void {
  console.log("→ restarting gateway");
  try {
    const bin = hermesBin();
    execSync(`"${bin}" gateway restart`, {
      stdio: ["ignore", "ignore", "inherit"],
      env: hermesExecEnv(),
    });
  } catch {
    console.warn("  warning: could not restart gateway — run manually: hermes gateway restart");
  }
}

function main(): void {
  ensureHermesAvailable();

  const wipeUser = process.argv.includes("--wipe-user");
  const welcomeState = wipeUser ? null : captureWelcomeState(TARGET_HOME);

  console.log("Edge Hermes installer");
  console.log("===================");
  console.log("");

  removeLegacyWorkspaceEdge();
  removeRetiredFiles();
  copySoulFile();
  copyWorkspaceFiles(wipeUser);
  copySkillFiles();
  copyPluginFiles("before-approval");
  setTerminalCwd();
  capModelMaxTokens();
  configureStt();
  configureHostedGateway();
  keepTelegramBacklogOnColdBoot();
  disableTelegramLinkPreviews();
  configureVillageTimezone();
  configureCronScriptTimeout();
  configureCronWrapResponse();
  setContextFileMaxChars();
  setCompactionSettings();
  configureTelegramDisplay();
  configureDashboardAuth();
  configureAvEvents();
  configureIndexLinks();
  configureAvDisplay();
  // Opt-in and off the core path: a failure here is counted, never fatal.
  safeInstallRecall(SOURCE_SKILLS);

  // Index cron jobs that failed to reconcile. They do not fail the install:
  // the control plane stops a roll on any non-zero exit, before its later
  // steps (B1-fix2 R1). They are recorded in the status file, written on
  // every run, and reported in one line at the end.
  let cronFailures: string[] = [];
  if (process.argv.includes("--skip-index")) {
    console.log("→ index network: unconfigured (--skip-index); bundled skills remain installed");
  } else {
    cronFailures = installIndex();
  }
  try {
    writeInstallStatus(hermesHome(), cronFailures);
  } catch {
    console.warn("  warning: could not write av-events/install-status.json");
  }
  installEdgeos();
  restoreWelcomeState(welcomeState);

  // Opt-in (DATA-43), and the one step that is not fail-open: with
  // AV_APPROVAL_ENABLED on, missing credentials or a failed self-check stop
  // the install with a named reason before the gateway is restarted.
  if (!runApprovalStep(SOURCE_SKILLS)) {
    console.error("error: the approval gate was requested (AV_APPROVAL_ENABLED) but not installed; gateway not restarted");
    process.exit(1);
  }
  // N3: the av-approval plugin only after its hooks block is written.
  copyPluginFiles("after-approval");
  installIndexHermesPlugin();

  if (!process.argv.includes("--no-restart")) {
    restartGateway();
  }

  if (cronFailures.length > 0) {
    console.log(cronFailedLine(cronFailures.length));
    console.warn(
      `warning: ${cronFailures.length} Index cron job(s) failed to update (${cronFailures.join(", ")}); `
      + "this install's other steps ran. Rerun the install on this resident to retry them.",
    );
  }

  console.log("");
  console.log("✓ installed");
  console.log(`  HERMES_HOME: ${TARGET_HOME}`);
  console.log("");
  console.log("next: message your Telegram bot — gateway uses terminal.cwd above");

  // R3 fix round 4 (trust boundary): the gate receipt is the LAST line of this process's stdout,
  // carrying the control plane's per-exec nonce (AV_GATE_NONCE) and what Hermes's own parse of
  // config.yaml routes. Nothing is printed after it; without a nonce or a successful approval
  // install it is not printed at all.
  const receipt = gateReceiptLine();
  if (receipt) process.stdout.write(`${receipt}\n`);
}

main();
