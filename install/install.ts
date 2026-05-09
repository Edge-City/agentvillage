#!/usr/bin/env bun
/**
 * EdgeClaw installer.
 *
 * Pre-stages OpenClaw config and the EdgeClaw workspace so the agent comes
 * online with a single chat turn. The installer owns everything that does not
 * belong in a runtime prompt:
 *
 *   - Writes `mcp.servers.index` to the canonical production protocol URL
 *     with the user's API key.
 *   - Disables Telegram progress-draft "tidepooling" so the streaming-off
 *     setting is loaded on the very first gateway start (not deferred until
 *     the first bootstrap turn drains).
 *   - Copies the workspace markdown bundle (BOOTSTRAP, AGENTS, SOUL, USER,
 *     IDENTITY, TOOLS, HEARTBEAT, COMMUNITY, prompts/*) into
 *     `~/.openclaw/workspace/`.
 *   - Installs three cron jobs: the daily morning digest (08:00), and two
 *     ambient discovery passes (14:00 and 20:00 host-local). Each pass is
 *     selective — max 3 direct + 3 introducer opportunities per dispatch,
 *     gated on the same quality bar.
 *   - Restarts the gateway so all config changes and cron jobs take effect.
 *
 * Anything the agent should *do at runtime* (greet the user, create their
 * profile, send the welcome message body) stays in BOOTSTRAP.md /
 * prompts/welcome.md — the installer does not impersonate the agent.
 *
 * The welcome message is delivered by `BOOTSTRAP.md` Step 6 at the end of
 * onboarding for new users. Already-onboarded users who reinstall don't get
 * an automatic welcome — the next ambient (14:00 / 20:00) or digest (08:00)
 * pass picks them up.
 *
 * Usage:
 *   bun install.ts <API_KEY>
 *   API_KEY=... bun install.ts
 */

import {
  existsSync,
  mkdirSync,
  copyFileSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const PROTOCOL_MCP_URL = "https://protocol.index.network/mcp";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_WORKSPACE = join(SCRIPT_DIR, "../workspace");
const TARGET_WORKSPACE = join(homedir(), ".openclaw", "workspace");

function readApiKey(): string {
  const fromArg = process.argv[2]?.trim();
  const fromEnv = process.env.API_KEY?.trim() ?? process.env.INDEX_API_KEY?.trim();
  const key = fromArg || fromEnv;
  if (!key) {
    console.error("error: API_KEY required");
    console.error("usage: bun install.ts <API_KEY>");
    console.error("       API_KEY=<key> bun install.ts");
    process.exit(1);
  }
  return key;
}

function ensureOpenclawAvailable(): void {
  try {
    execSync("openclaw --version", { stdio: "ignore" });
  } catch {
    console.error("error: `openclaw` CLI not found on PATH");
    console.error("       install OpenClaw first: https://openclaw.dev");
    process.exit(1);
  }
}

function patchOpenclawConfig(apiKey: string): void {
  const mcpEntry = JSON.stringify({
    url: PROTOCOL_MCP_URL,
    transport: "streamable-http",
    headers: { "x-api-key": apiKey },
  });

  console.log("→ writing mcp.servers.index");
  execSync(`openclaw config set mcp.servers.index '${mcpEntry}' --strict-json`, {
    stdio: ["ignore", "ignore", "inherit"],
  });

  console.log("→ disabling telegram progress-draft tidepooling");
  execSync("openclaw config set channels.telegram.streaming.mode off", {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/**
 * Reads `~/.openclaw/agents/main/sessions/sessions.json` and returns the
 * most-recently-updated Telegram-bound session, or `null` if the user has
 * not yet messaged the agent on Telegram. Used to bind cron deliveries to
 * the user's actual chat instead of `--channel last`, which fails for cron
 * jobs because they run in fresh isolated sessions with no `lastTo`.
 */
function findTelegramSession(): { sessionKey: string; to: string } | null {
  const sessionsPath = join(
    homedir(),
    ".openclaw",
    "agents",
    "main",
    "sessions",
    "sessions.json",
  );
  if (!existsSync(sessionsPath)) return null;
  let map: Record<
    string,
    {
      origin?: { provider?: string; to?: string };
      lastChannel?: string;
      lastTo?: string;
      updatedAt?: number;
    }
  >;
  try {
    map = JSON.parse(readFileSync(sessionsPath, "utf-8"));
  } catch {
    return null;
  }
  // Telegram bot delivery needs a numeric chatId — `telegram:<digits>`.
  // Reject sessions whose `to` is the username form (`telegram:@handle`),
  // a group placeholder (`telegram:@telegram`), or has no concrete `lastTo`.
  // OpenClaw can register multiple Telegram sessions per peer (one per
  // surface form); without this filter the most-recent entry can be a
  // username-shaped session that never resolves to a real Bot API chat.
  const TELEGRAM_NUMERIC = /^telegram:-?\d+$/;
  const candidates = Object.entries(map)
    .filter(([key, val]) => {
      if (!key.startsWith("agent:main:telegram:direct:")) return false;
      const to = val.lastTo ?? val.origin?.to ?? "";
      return TELEGRAM_NUMERIC.test(to);
    })
    .sort(([, a], [, b]) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const top = candidates[0];
  if (!top) return null;
  const to = top[1].lastTo ?? top[1].origin?.to ?? "";
  return { sessionKey: top[0], to };
}

function bindCronsToTelegram(
  session: { sessionKey: string; to: string },
  env: NodeJS.ProcessEnv,
): void {
  console.log(`→ binding crons to ${session.to}`);
  let raw: string;
  try {
    raw = execSync("openclaw cron list --json", { encoding: "utf8", env });
  } catch {
    console.warn("  warning: could not list crons to bind delivery");
    return;
  }
  const parsed = JSON.parse(raw) as { jobs?: Array<{ id: string; name: string }> };
  for (const job of parsed.jobs ?? []) {
    if (!job.name.startsWith("EdgeClaw")) continue;
    execSync(
      `openclaw cron edit ${job.id} --session-key ${session.sessionKey} --channel telegram --to ${session.to}`,
      { stdio: ["ignore", "ignore", "inherit"], env },
    );
  }
}

function installCronJobs(): void {
  const npmBin = `${process.env.HOME}/.npm/bin`;
  const localBin = `${process.env.HOME}/.local/bin`;
  const env = { ...process.env, PATH: `${npmBin}:${localBin}:${process.env.PATH}` };
  const workspaceDir = join(homedir(), ".openclaw", "workspace");

  // Remove existing EdgeClaw cron jobs before re-adding to stay idempotent.
  try {
    const raw = execSync("openclaw cron list --json", { encoding: "utf8", env });
    const parsed = JSON.parse(raw) as { jobs?: Array<{ id: string; name: string }> };
    for (const job of parsed.jobs ?? []) {
      if (job.name.startsWith("EdgeClaw")) {
        execSync(`openclaw cron remove ${job.id}`, { stdio: "ignore", env });
      }
    }
  } catch {
    // Gateway may be mid-restart; proceed and let cron add handle any conflicts.
  }

  console.log("→ installing cron jobs");

  execSync(
    `openclaw cron add \
      --name "EdgeClaw — daily digest" \
      --cron "0 8 * * *" \
      --session isolated \
      --light-context \
      --announce \
      --channel last \
      --message "$(cat ${workspaceDir}/prompts/digest.md)"`,
    { stdio: ["ignore", "ignore", "inherit"], env, shell: "/bin/sh" },
  );

  execSync(
    `openclaw cron add \
      --name "EdgeClaw — ambient discovery (afternoon)" \
      --cron "0 14 * * *" \
      --session isolated \
      --light-context \
      --announce \
      --channel last \
      --message "$(cat ${workspaceDir}/prompts/ambient.md)"`,
    { stdio: ["ignore", "ignore", "inherit"], env, shell: "/bin/sh" },
  );

  execSync(
    `openclaw cron add \
      --name "EdgeClaw — ambient discovery (evening)" \
      --cron "0 20 * * *" \
      --session isolated \
      --light-context \
      --announce \
      --channel last \
      --message "$(cat ${workspaceDir}/prompts/ambient.md)"`,
    { stdio: ["ignore", "ignore", "inherit"], env, shell: "/bin/sh" },
  );
}

function restartGateway(): void {
  console.log("→ restarting gateway");
  try {
    execSync("openclaw gateway restart", { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    console.warn("  warning: could not restart gateway — run manually: openclaw gateway restart");
  }
}

function copyWorkspaceFiles(): void {
  if (!existsSync(SOURCE_WORKSPACE)) {
    console.error(`error: bundled workspace missing at ${SOURCE_WORKSPACE}`);
    process.exit(1);
  }

  if (!existsSync(TARGET_WORKSPACE)) {
    mkdirSync(TARGET_WORKSPACE, { recursive: true });
  }

  let copied = 0;
  for (const entry of readdirSync(SOURCE_WORKSPACE)) {
    const sourcePath = join(SOURCE_WORKSPACE, entry);
    const targetPath = join(TARGET_WORKSPACE, entry);
    const stat = statSync(sourcePath);

    if (stat.isDirectory()) {
      if (!existsSync(targetPath)) mkdirSync(targetPath, { recursive: true });
      for (const inner of readdirSync(sourcePath)) {
        if (!inner.endsWith(".md")) continue;
        copyFileSync(join(sourcePath, inner), join(targetPath, inner));
        copied++;
      }
    } else if (entry.endsWith(".md")) {
      copyFileSync(sourcePath, targetPath);
      copied++;
    }
  }

  console.log(`→ staged ${copied} workspace files into ${TARGET_WORKSPACE}`);
}

function main(): void {
  const apiKey = readApiKey();
  ensureOpenclawAvailable();

  console.log("EdgeClaw installer");
  console.log("==================");
  console.log("");

  patchOpenclawConfig(apiKey);
  copyWorkspaceFiles();
  installCronJobs();

  const npmBin = `${process.env.HOME}/.npm/bin`;
  const localBin = `${process.env.HOME}/.local/bin`;
  const env = { ...process.env, PATH: `${npmBin}:${localBin}:${process.env.PATH}` };
  const session = findTelegramSession();
  if (session) {
    bindCronsToTelegram(session, env);
    console.log("→ skipping gateway restart (Telegram session already active)");
  } else {
    restartGateway();
  }

  console.log("");
  console.log("✓ installed");
  console.log("");
  if (session) {
    console.log("crons are bound to your Telegram chat — digest, ambient passes will deliver.");
  } else {
    console.log("next:");
    console.log("  1. send any message to your agent on Telegram");
    console.log("  2. re-run `bun install.ts <key>` to bind cron deliveries to that chat");
  }
}

main();
