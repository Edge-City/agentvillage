# AgentVillage

The Agent Village experience for **Edge Esmeralda 2026** (May 30 – Jun 27, Healdsburg, CA).

AgentVillage is the public skills package and onboarding scripts that an agent (running Hermes, OpenClaw, or Claude) loads to participate in the Edge Esmeralda Agent Village. It's a multi-backend package: discovery and intent negotiation through Index Network, knowledge graph through Geo, calendar and directory through EdgeOS. AgentVillage defines what an agent knows, how it authenticates with each backend, and how it interacts with attendees.

## What you get

Today, capabilities come from **Index Network** (discovery + intent negotiation). **Geo** (knowledge graph) and **EdgeOS** (calendar + directory) are also in scope. Once installed, AgentVillage:

- **Runs privacy-first onboarding** the first time you message it (greet → ask one data-use consent question covering EdgeOS data and public lookup → require a public social/profile URL before any internet lookup → profile draft → user approval → first signal → silent handle capture → `complete_onboarding`).
- **Prepares a morning brief for 08:00 host-local time** with admin-set village announcements, today's EdgeOS calendar highlights, the connections worth your attention, and the asks where you can help. Each night's brief is staged and held for review; it is delivered at 08:00 only after an operator approves it by unblocking the staged card on the board.
- **Notifies you when someone accepts** a connection on your behalf.
- **Curates memory** every few days — distills daily notes into long-term `MEMORY.md`.
- **Audits token usage quietly** with a deterministic local script. It only wakes the agent when meaningful spend has a clear actionable driver, such as scheduled background work dominating the last day.

AgentVillage never names the plumbing in chat. You see AgentVillage and (when relevant) your community.

## Architecture

AgentVillage plugs into the EdgeOS portal (the identity + spine), with Portal as the recommended runtime for non-technical attendees. Backends the agent calls: Geo (knowledge graph), Index (negotiation + discovery), and EdgeOS APIs (calendar, directory).

See the project hub for the full diagram and decisions.

## What's here

- `workspace/IDENTITY.md` — what an AgentVillage agent knows about itself and the village
- `workspace/` — backend-agnostic agent core (identity, voice, community context, generic operating rules)
- `skills/` — per-backend skill bundles registered with OpenClaw via per-bundle `SKILL.md`. Mirrors `Edge-City/agentvillage-skills` as a subtree; today this hosts:
  - `skills/index-network/` — Index Network MCP procedural knowledge (onboarding ritual, voice exemplars, cron prompts, heartbeat tasks)
  - `skills/edgeos/` — backend-generic EdgeOS API recipes (events, RSVPs, venues, attendee directory, own profile). Reads `EDGEOS_BEARER_TOKEN` and `EDGEOS_API_KEY` from env; popup id is supplied by the active operator skill.
  - `skills/edge-esmeralda/` — Edge Esmeralda 2026 popup knowledge: popup constants (popup id, week dates, themes), attendee field semantics, the curated wiki/website/newsletter references (vendored from `Edge-City/agentvillage-skills`; refreshed by upstream CI every 15 min), and the onboarding pointer for obtaining EdgeOS tokens.
  - `skills/geo-esmeralda/` — Geo knowledge graph recipes and write guidance for attendee-authored content, relations, ontology, and media.
  - `skills/token-usage-audit/` — deterministic tenant-local token usage audit script and cron contract. It reads local usage summaries and cron metadata, never calls an LLM, and emits only sanitized aggregate facts.
  - `skills/agent-plaza/` — deterministic Agent Plaza selfie delivery plus prompt-led follow-up guidance. It reads configured world/social packets, sends local selfie images through Telegram, keeps telemetry/state/media plus sanitized follow-up context under `ops/agentvillage/...`, and stays silent when Plaza is unavailable.
- `install/` — bootstrap scripts for plugging AgentVillage into a runtime

## Getting an agent connected

Two paths:

**1. I'm new to agents.** Sign up at `https://agent-ee26.edgecity.live/` and pick "Set one up for me." Portal provisions a hosted agent with AgentVillage preinstalled. ~5 minutes.

**2. I'm self-hosting.** Set up Hermes, OpenClaw, or Claude Code, then run the AgentVillage installer from a clone of this repo.

### EdgeOS tokens

Both paths need EdgeOS tokens (`EDGEOS_BEARER_TOKEN` and `EDGEOS_API_KEY`) before the `edgeos` skill can talk to the calendar, directory, or your own profile. Obtain them by completing the email-OTP flow at `<EDGECITY-ONBOARDING-URL>`, then pass them to the installer (`--edgeos-bearer-token`, `--edgeos-api-key`) or, for non-OpenClaw hosts, set them in your host's env config per its conventions. AgentVillage does not run OTP itself.

> **TODO:** Replace `<EDGECITY-ONBOARDING-URL>` with the actual URL once EdgeCity publishes it. Bump `package.json` patch version when done.

## Integration API

The integration API is for **Portal** and **EdgeOS** — the two systems that provision agents on behalf of attendees. End users do not call this directly.

### Authentication

All requests use the experiment network's **master key** as a bearer token:

```
x-api-key: <masterKey>
```

The master key is issued once when the experiment network is created in the Index Network dashboard and is never re-shown. It is **server-side only** — never expose it in the EdgeOS portal frontend, user-visible config, the public repo, or attendee-facing copy-paste.

The master key can be **rotated** from the integrations tab of the network's settings page in the Index Network dashboard. Rotation issues a new plaintext key (shown once) and emails it to every owner of the network; the previous key is invalidated immediately. Use this when the key is lost or to revoke an existing one.

### POST /api/networks/:id/signup

Provisions (or re-provisions) an attendee's Index Network account and returns an API key bound to a network-scoped agent. No email is sent — the caller is responsible for delivering the key to the attendee.

**Request**

```
POST https://protocol.index.network/api/networks/<NETWORK_ID>/signup
Content-Type: application/json
x-api-key: <masterKey>
```

**Body** (`email` is the only required field):

```json
{
  "email": "alice@example.com",
  "name": "Alice Example",
  "bio": "Independent researcher on coordination problems.",
  "location": "Healdsburg, CA",
  "socials": [
    { "label": "telegram", "value": "@alice" },
    { "label": "twitter",  "value": "alice_eg" }
  ]
}
```

| Field | Required | Max | Notes |
|---|---|---|---|
| `email` | yes | — | Lowercased + trimmed. |
| `name` | no | 200 chars | Overwrites stored name when present. |
| `bio` | no | 2000 chars | |
| `location` | no | 200 chars | |
| `socials` | no | 32 entries | Open vocabulary — any string labels (`telegram`, `twitter`, `github`, `farcaster`, …). Upserted by label. |

**Response**

```json
{
  "user":   { "id": "<uuid>", "email": "alice@example.com" },
  "apiKey": "ix_...",
  "mcpServer": {
    "name":    "index",
    "url":     "https://protocol.index.network/mcp",
    "headers": { "x-api-key": "ix_..." }
  }
}
```

HTTP `201` if the user was newly created; `200` if they already existed.

`mcpServer` is the standard MCP server config object that OpenClaw reads on startup.

**Idempotency**

Every call with the same email returns the same user but a **fresh API key** — the previous key is revoked. Store the key returned by the latest call. If the integrator retries before delivering the key to the attendee, the retried call's key supersedes the earlier one.

**Errors**

| Code | Reason |
|---|---|
| 400 | Missing or invalid email; oversized field; malformed `socials` array. |
| 401 | Missing `x-api-key` header. |
| 403 | Master key invalid; network not in experiment mode; network deleted. |

### What Portal does after signup

1. Runs the AgentVillage installer with the returned `apiKey`: `bun install/install.ts --index-api-key <apiKey>` (or equivalent in the hosted runtime). If Portal has a resident-confirmed Telegram handle, it passes it as a bare handle (`--telegram-handle handle`) so every Telegram-surface Index MCP request carries `x-index-telegram-username`. If Portal has also fetched an EdgeOS personal access token for the attendee, it passes that on the same line: `bun install/install.ts --index-api-key <apiKey> --telegram-handle handle --edgeos-api-key <eos_live_…> --edgeos-bearer-token <jwt>`.
2. If Portal learns or changes the attendee's Telegram handle later, it should rerun the installer or update `mcp_servers.index.headers.x-index-telegram-username` in the host config.

### What EdgeOS does after signup (BYOA flow)

Displays per-host install commands with the attendee's credentials pre-filled. The attendee copies and runs them in their terminal. EdgeOS also completes the email-OTP flow to obtain `EDGEOS_BEARER_TOKEN` and `EDGEOS_API_KEY`, which are included in the install commands.

**Claude Code:**
```bash
export INDEX_API_KEY=<apiKey>
export EDGEOS_BEARER_TOKEN=<jwt>
export EDGEOS_API_KEY=<eos_live_…>
claude plugin marketplace add Edge-City/agentvillage-skills
claude plugin install agentvillage@agentvillage-skills
```

**OpenClaw:**
```bash
openclaw plugins install agentvillage --marketplace Edge-City/agentvillage-skills
openclaw config set mcp.servers.index '{"url":"https://protocol.index.network/mcp","transport":"streamable-http","headers":{"x-api-key":"<apiKey>","x-index-surface":"telegram","x-index-telegram-username":"handle"}}'
openclaw config set env.vars.EDGEOS_BEARER_TOKEN '<jwt>'
openclaw config set env.vars.EDGEOS_API_KEY '<eos_live_…>'
openclaw gateway restart
```

**Hermes:**
```bash
hermes skills install Edge-City/agentvillage/skills/edge-esmeralda --force
hermes skills install Edge-City/agentvillage/skills/edgeos --force
hermes skills install Edge-City/agentvillage/skills/index-network --force
hermes config set mcp_servers.index.url 'https://protocol.index.network/mcp'
hermes config set mcp_servers.index.headers.x-api-key '<apiKey>'
hermes config set mcp_servers.index.headers.x-index-surface 'telegram'
hermes config set mcp_servers.index.headers.x-index-telegram-username 'handle'
hermes config set EDGEOS_BEARER_TOKEN '<jwt>'
hermes config set EDGEOS_API_KEY '<eos_live_…>'
```

**Claude Desktop / other MCP clients:** displays the `mcpServer` JSON with the API key baked in.

See `skills/README.md` for the full per-host reference.

## Prerequisites

- [OpenClaw](https://openclaw.dev) installed and configured (`openclaw onboard --mode local` or `openclaw setup`).
- An API key for the Index protocol. Generate one on your agents page at [index.network](https://index.network) (or your community-branded node).
- [Bun](https://bun.sh) — the installer is a Bun script (Node 20+ also works if you swap the shebang).
- Node 20+ with npm/npx available to run the Geo CLI recipes.
- *(Optional)* EdgeOS tokens, if you want live event/attendee recipes to work without per-query prompting:
  - `EDGEOS_API_KEY` — long-lived `eos_live_…` automation key, minted via the EdgeCity onboarding flow (see the "EdgeOS tokens" section above). Unlocks the calendar/RSVPs/venues recipes in `skills/edgeos/SKILL.md`.
  - `EDGEOS_BEARER_TOKEN` — human session JWT obtained via the same email-OTP flow. Unlocks the directory, own-profile, and OpenAPI-spec recipes.

  Both are optional from AgentVillage's perspective. Without them the agent still runs; EdgeOS recipes will just ask the user for the missing token on first use per the SKILL.md instructions.

## Install

From a clone of this repo:

```bash
bun install/install.ts --index-api-key <YOUR_API_KEY>
```

If this AgentVillage runtime is serving the user through Telegram, include their public Telegram handle. The installer stores it in the Index MCP headers so any Telegram-surface interaction can upsert the user's reachable Telegram social without waiting for onboarding:

```bash
bun install/install.ts --index-api-key <YOUR_API_KEY> --telegram-handle handle
```

To target the dev environment (keys generated on `dev.index.network`), pass `--dev`:

```bash
bun install/install.ts --index-api-key <YOUR_DEV_API_KEY> --dev
```

Or override the MCP URL explicitly via `INDEX_MCP_URL=…`. Without either, the installer points at `https://protocol.index.network/mcp` (production).

To wire the optional EdgeOS tokens at the same time, pass them as flags:

```bash
bun install/install.ts \
  --index-api-key <YOUR_API_KEY> \
  --edgeos-api-key eos_live_… \
  --edgeos-bearer-token eyJ…
```

### Overriding the Index cron times

Index background work is installed as Hermes cron jobs: memory signal sync, digest prepare, digest send, negotiation summary, Agent Plaza selfie, evening questions, and the optional token usage audit. Memory signal sync is script-gated: a deterministic local preflight hashes `MEMORY.md` and suppresses the LLM turn when memory has not changed since the last successful sync. Agent Plaza selfie is also script-gated and self-silences unless Plaza has handed Hermes a Telegram-compatible image, opt-in proof, plus Telegram delivery config. To install the jobs at different times (a different timezone, a test window, etc.), pass full 5-field cron expressions. A flag wins over the matching env var; an invalid expression is ignored with a warning and the default is kept.

> **Note:** the former 30-minute `Edge — heartbeat` cron was **retired** — it loaded the full agent context + Index MCP tool surface (~57k input tokens) every 30 minutes and exhausted the per-tenant OpenRouter key budgets fleet-wide (HTTP 402). `reconcileDigestCronJobs` removes any existing heartbeat cron on the next install/update. Accepted-opportunity notifications now surface through the morning digest; see #100 for richer replacements.

```bash
# via flags
bun install/install.ts --index-api-key <YOUR_API_KEY> \
  --digest-prepare-cron "0 3 * * *" \
  --digest-send-cron    "0 9 * * *"

# or via environment
DIGEST_PREPARE_CRON="0 3 * * *" DIGEST_SEND_CRON="0 9 * * *" \
  bun install/install.ts --index-api-key <YOUR_API_KEY>
```

| Cron | Flag | Env var | Default |
|---|---|---|---|
| Memory signal sync | `--digest-signals-cron "<expr>"` | `DIGEST_SIGNALS_CRON` | `0 1 * * *` |
| Prepare pass | `--digest-prepare-cron "<expr>"` | `DIGEST_PREPARE_CRON` | `0 2 * * *` |
| Send pass | `--digest-send-cron "<expr>"` | `DIGEST_SEND_CRON` | `0 8 * * *` |
| Negotiation summary | `--negotiation-summary-cron "<expr>"` | `NEGOTIATION_SUMMARY_CRON` | `0 14 * * *` |
| Agent Plaza selfie | `--agent-plaza-selfie-cron "<expr>"` | `AGENT_PLAZA_SELFIE_CRON` | `0 16 * * *` |
| Evening questions | `--evening-questions-cron "<expr>"` | `EVENING_QUESTIONS_CRON` | `0 19 * * *` |
| Token usage audit | `--token-usage-audit-cron "<expr>"` | `TOKEN_USAGE_AUDIT_CRON` | disabled |

The token usage audit cron is disabled by default. To enable it for an install, pass `--token-usage-audit-cron "0 9 * * *"` or set `TOKEN_USAGE_AUDIT_CRON` to a full 5-field cron expression. To remove an existing managed audit cron, rerun the installer with no audit schedule, pass `--skip-token-usage-audit-cron`, or set `TOKEN_USAGE_AUDIT_CRON=off`.

The installer also caps `model.max_tokens` in Hermes `config.yaml` at `4096` by default so background cron turns do not inherit large provider defaults (for example `65536`). Operators can raise or lower that cap for an install by setting `HERMES_MAX_TOKENS`.

The installer writes any tokens it finds into `$HERMES_HOME/.env`; on the next Hermes restart they become process-env for the agent and inherit into shell tools, so `curl -H "Authorization: Bearer $EDGEOS_API_KEY"` recipes and Geo CLI commands work without further plumbing. `HERMES_HOME` defaults to `~/.hermes`.

The installer:

1. Writes `mcp_servers.index` in `$HERMES_HOME/config.yaml`, pointed at `https://protocol.index.network/mcp` with your API key in `x-api-key`.
2. If `--edgeos-api-key` and/or `--edgeos-bearer-token` are passed, writes each to `$HERMES_HOME/.env` so Hermes exposes them to the agent's subprocesses on its next start.
3. Leaves Geo CLI execution to the skill recipes, which run the public package through `npx`.
4. Sets `channels.telegram.streaming.mode = off` so Hermes doesn't dump per-tool status drafts into your chat.
5. Copies the workspace markdown bundle into `$HERMES_HOME/workspace/`. `USER.md` is preserved on re-install (it holds the lived notes the active skill's bootstrap ritual populated for you); pass `--wipe-user` to overwrite `USER.md` and delete the agent-curated `MEMORY.md`, Hermes' `workspace-state.json` first-run marker, and the local onboarding/welcome/cron-preference markers under `memory/` so the next session re-onboards from scratch.
6. Copies backend skill bundles from `skills/` into `$HERMES_HOME/skills/` so Hermes registers them as workspace skills.
7. Installs the Index cron jobs: a script-gated memory signal sync (`0 1 * * *`), a prepare pass (`0 2 * * *`) that composes the morning brief and stages it as an editable Kanban task, and a send pass (`0 8 * * *`) that delivers the staged brief. It also installs the default Agent Plaza selfie cron (`0 16 * * *`), which self-silences unless a configured Plaza packet includes opt-in proof plus a Telegram-compatible PNG/JPEG/WebP image. The deterministic token usage audit script cron is available as an explicit opt-in and is removed by default from existing tenants on update. (The 30-minute `Edge — heartbeat` cron was retired — see the note under "Overriding the Index cron times" — and is removed from existing tenants on update.) The prepare pass stages each brief as a **blocked** Kanban task; the send pass delivers it only after an operator approves it by unblocking that task (`hermes kanban unblock <id>` or the board's unblock control), so accidental delivery is prevented without pausing the cron. Memory sync wakes the agent only when its deterministic preflight finds meaningful work. The Agent Plaza selfie cron writes operational state/events/media only under `ops/agentvillage/...`, never `memory/`; when `TELEGRAM_BOT_TOKEN` and `TELEGRAM_HOME_CHANNEL` are present, it sends the image through Telegram Bot API `sendPhoto`, stores a small sanitized `lastFollowupContext` for later ordinary chat interpretation, and emits `wakeAgent:false` so Hermes does not duplicate the message. When enabled, the token audit wakes the agent only when local aggregate usage shows a meaningful actionable driver; quiet runs end with `{"wakeAgent":false}` and skip the agent entirely. The end user can't change schedules from chat, but the installer can override the cron times via the flags/env vars above.
8. Restarts the gateway so all config changes take effect.

Send any message in your chat to bring AgentVillage online. AgentVillage has two independent setup gates with different triggers:

- **AgentVillage welcome** — runs on private-DM first message before any other reply/tool work, is owned by `workspace/AGENTS.md` "First-message gates", and is gated by the local durable marker `memory/welcome-state.json`. Hermes sessions can reset daily or after idle time, so the welcome must not key off session freshness. If the marker says `welcomeSent: true`, the agent skips the welcome and answers normally. Normal installer/update runs snapshot this marker, restore it if it is deleted, and repair clobbered content when the previous marker suppressed the welcome; only `--wipe-user` intentionally removes it.
- **Index Network onboarding** — runs only when the user expresses social intent (meeting people, connecting, finding others, being matched), not on unrelated first messages. It is gated on the server-side `onboardingComplete` flag returned by `read_user_contexts()` and owned by `skills/index-network/bootstrap.md`. If triggered and `onboardingComplete` is `false`, the privacy-first ritual runs (ask one data-use consent question covering EdgeOS/event profile data and public lookup → only run internet lookup when an explicit or allowed public social/profile URL is available → draft profile with `preview_user_context`, polling `get_enrichment_run` when a `profileRunId` is returned → show it for approval → save with `confirm_user_context` → capture first signal → capture handle → `complete_onboarding()` → populate `USER.md`).

An admin resetting `onboardingComplete` server-side re-triggers only the Index ritual. Wiping local state via `install/install.ts --wipe-user` resets local markers without touching Index's flag.

## Reset

To tear down AgentVillage and start fresh (leaves Telegram token, OpenRouter key, and gateway config untouched):

```bash
bun install/reset.ts
```

Then re-install:

```bash
bun install/install.ts --index-api-key <YOUR_API_KEY>
```

Pass `--wipe-user` to also remove `USER.md`, `MEMORY.md`, and the entire `memory/` directory — including `agentvillage-state.json`, `welcome-state.json`, daily notes, and any other local memory files — so the next message can run the first-install gates again:

```bash
bun install/reset.ts --wipe-user
```

## How it runs

Time-sensitive and background prompts run as **Hermes/OpenClaw cron jobs**. The morning digest prepare/send prompts and the daily memory signal sync run at their own daily cron times. Cron has its own scheduler and runs isolated sessions, so each tick starts fresh from the workspace files. The memory signal sync cron runs `agentvillage_memory_signal_gate.py` first; unchanged, missing, or empty `MEMORY.md` exits before the model sees the prompt. The Agent Plaza selfie cron runs `agentvillage_agent_plaza_selfie.py` first; when Plaza is not configured, not opted in, or no Telegram-compatible image is available, it emits `wakeAgent:false`. Its operational files are outside model-read memory: `ops/agentvillage/events/agent-plaza-selfie.jsonl`, `ops/agentvillage/state/agent-plaza-selfie.json`, and `ops/agentvillage/media/agent-plaza-selfies/`. When an image is available and the tenant has `TELEGRAM_BOT_TOKEN` plus `TELEGRAM_HOME_CHANNEL`, the script sends the photo directly through Telegram Bot API `sendPhoto`, records non-secret ops telemetry plus sanitized `lastFollowupContext`, and returns `wakeAgent:false` so Hermes does not duplicate the message. URL-sourced Plaza packets cannot reference tenant-local image paths; they must provide base64 image bytes. Follow-up handling happens later in ordinary chat through prompts/instructions, not by parsing replies in the script. The token usage audit is different: when explicitly enabled, it is a script cron, non-LLM by default, with delivery gated by the script's final `wakeAgent` line. It inspects local dashboard session summaries, `cron/jobs.json`, and metadata fallback only when useful; it writes cooldown state to `memory/token-usage-audit.json` and emits sanitized aggregate facts only when it wakes the agent. Cron jobs are installed by `install/install.ts` and restart with the gateway. Future per-backend skills can add their own cron prompts the same way.

> **Retired:** a 30-minute `Edge — heartbeat` cron used to run `skills/index-network/heartbeat.md` for accepted-opportunity notifications, freshness audits, and Telegram-handle reconciliation. It was removed because each tick loaded ~57k input tokens (full agent context + Index MCP tool surface) and, at 48 runs/day/tenant, drained the per-tenant OpenRouter key budgets fleet-wide (HTTP 402). `skills/index-network/heartbeat.md` is kept for reference only and is no longer scheduled. Latency-tolerant background work should be folded into the daily digest, an event-driven push, or a cheap deterministic (`--no-agent`) cron instead — see Edge-City/agentvillage#100.

## Workspace layout

| File | Purpose |
| --- | --- |
| `AGENTS.md` | Canonical session-start instructions plus operating rules. Hosts the dual onboarding gates (skill-side + AgentVillage-side), the cron-schedule trigger, memory contract, opportunity-quality bar, red lines, and group-chat rules. Always injected by OpenClaw. |
| `BOOTSTRAP.md` | OpenClaw convention for the first-run file. AgentVillage ships only a stub pointing to `AGENTS.md` here, because OpenClaw deletes BOOTSTRAP.md after first-run setup — anything stored in it is not durable. |
| `COMMUNITY.md` | Edge Esmeralda context — dates, attendee count, programming format, design principles. The agent reads this when composing welcomes and digests. |
| `SOUL.md` | Voice, banned vocabulary, "never name the plumbing", boundaries, continuity. |
| `IDENTITY.md` | AgentVillage identity — role, context, tone. |
| `USER.md` | Lived notebook — populated by the active skill's bootstrap ritual from the user's onboarding answers. |
| `TOOLS.md` | Cross-backend rules: channel formatting (Discord/WhatsApp/Telegram), URL preservation, Local files index. Per-backend tool families live in the relevant skill. |
| `HEARTBEAT.md` | Generic heartbeat tick rules + the cross-backend `memory-curation` task. Backend-specific tasks live in each active skill's `heartbeat.md`. |
| `skills/index-network/SKILL.md` | Index Network skill bundle entry point. Registered with OpenClaw on install; gates on `mcp.servers.index`. Body points at the bundle's sibling reference files. |
| `skills/edgeos/SKILL.md` | EdgeOS-API skill: events + attendee directory + curated wiki/website/newsletter references. Currently scoped to Edge Esmeralda 2026. Loaded by OpenClaw alongside index-network. Vendored from `Edge-City/agentvillage-skills`. |
| `skills/geo-esmeralda/SKILL.md` | Geo knowledge graph skill: community content, relations, ontology, and attendee-authored writes through the Geo CLI package. |

## Configuration guide

AgentVillage's behaviour is markdown-driven. Almost everything you'd want to change lives in `workspace/` or `skills/<backend>/`. This section maps common customizations to the file that owns them.

**Deploy cycle.** All edits go into this repo. The agent only sees them after `install/install.ts` runs again, since the installer copies `workspace/` into `$HERMES_HOME/workspace/` and `skills/` into `$HERMES_HOME/skills/`. Re-running without `--wipe-user` preserves the attendee's `USER.md`, `MEMORY.md`, and onboarding markers — safe for content/tone edits. The installer also snapshots an existing `memory/welcome-state.json` marker, restores it if a normal update deletes it, and repairs clobbered content when the previous marker suppressed the welcome. Use `--wipe-user` only when you want the next session to re-onboard from scratch. Existing installs must reinstall the package to copy updated privacy-first onboarding markdown into the Hermes/OpenClaw workspace.

### Tone & voice

| You want to… | Edit | Notes |
|---|---|---|
| Tighten or loosen overall voice (more analytical / more playful) | `workspace/SOUL.md` | The "voice" rules apply to every message the agent composes. Voice exemplars in skill bundles inherit from here. |
| Change banned vocabulary (e.g. drop a word, ban a new one) | `workspace/SOUL.md` | Bans propagate to all skill prompts via SOUL.md. |
| Change the canonical look of welcome / digest messages | `skills/index-network/exemplars.md` | These exemplars are the bar the agent imitates. Edit the literal sample messages, not abstract rules. |
| Rename the agent (rebrand for another event) | `workspace/IDENTITY.md` + every `prompts/*.md` and `bootstrap.md` referring to "AgentVillage" | Grep `AgentVillage` under `workspace/` and `skills/`. Also update `COMMUNITY.md` and `package.json` `name` if forking. |
| Add or change emoji conventions | `skills/index-network/exemplars.md` and `skills/edge-esmeralda/prompts/*.md` | Exemplars set the look; the morning greeting is fixed in `prepare.md` / `send.md`. |

### Content

| You want to… | Edit | Notes |
|---|---|---|
| Update community facts (dates, headcount, venue, programming format) | `workspace/COMMUNITY.md` | This is the only authoritative source the agent reads for community context. Don't duplicate the facts into prompts. |
| Change what the morning brief says or how it's structured | `skills/edge-esmeralda/prompts/prepare.md` (prompt-led synthesis), `skills/index-network/scripts/build-daily-brief-context.ts` (structured announcements/calendar/opportunity context), `skills/index-network/scripts/stage-daily-brief.ts` (validation/staging guardrails), and `skills/edge-esmeralda/prompts/send.md` (deliver approved body) | Keep calendar and the evolving user model as the center of the brief; people/community asks are supporting context, not the main frame. |
| Change the welcome message | `workspace/AGENTS.md` "First-message gates" | The welcome is gated by `memory/welcome-state.json` and should run once per install, not once per Hermes session. |
| Change the lived-notebook (`USER.md`) template | `skills/index-network/bootstrap.md` | The bootstrap ritual writes `USER.md`. Editing the file in `workspace/` only affects the empty stub copied in by `--wipe-user`. |
| Change how the agent calls EdgeOS APIs (events, attendees, RSVPs, venues, wiki recipes) | `skills/edgeos/SKILL.md` | This is the hand-edited recipe file. The auto-refreshed reference data under `skills/edgeos/references/` is a different surface — see "Backends & skills" below for the don't-edit-this caveat. |

### Behaviour & gates

| You want to… | Edit | Notes |
|---|---|---|
| Add, remove, or reorder operating rules (memory contract, opportunity quality bar, red lines, group-chat rules) | `workspace/AGENTS.md` | This file is always injected by OpenClaw on every session — durable, unlike `BOOTSTRAP.md`. |
| Add a new first-message gate (e.g. another skill needs onboarding) | `workspace/AGENTS.md` "Active skills" section + the new `skills/<name>/bootstrap.md` | Gates loop over the active-skills registry. Add the skill row first, then point its bootstrap at the trigger condition (server flag, local marker, …). |
| Change the returning-user first-message framing | `workspace/AGENTS.md` "First-message gates" | The digest schedule is fixed (set in `install/install_index.ts`) and not adjustable from chat. |
| ~~Change heartbeat tick behaviour~~ | n/a | The 30-minute `Edge — heartbeat` cron was retired (it drained OpenRouter key budgets fleet-wide). `skills/index-network/heartbeat.md` is kept for reference only and is no longer scheduled — see #100 for replacement approaches. |
| Change how URLs / formatting render per channel (Telegram, WhatsApp, Discord) | `workspace/TOOLS.md` | Cross-backend rule: Telegram is Markdown, not HTML — raw `<…>` tags get escaped. |

### Schedule & cron

Index background work runs as fixed cron prompts — **memory signal sync `0 1 * * *`, prepare `0 2 * * *`, send `0 8 * * *`, Agent Plaza selfie `0 16 * * *`** (host-local) — and the end user can't change those schedules from chat. Memory signal sync has a deterministic `MEMORY.md` hash preflight, so unchanged days do not wake the model. Agent Plaza selfie has a deterministic opt-in/packet/media/Telegram preflight, so unavailable Plaza or missing Telegram config stays silent. The installer can override any time (see "Overriding the Index cron times" under **Install**). The 30-minute heartbeat cron was retired.

| You want to… | Edit | Notes |
|---|---|---|
| Override the Index cron times for one install | `--digest-signals-cron` / `--digest-prepare-cron` / `--digest-send-cron` (or `DIGEST_SIGNALS_CRON` / `DIGEST_PREPARE_CRON` / `DIGEST_SEND_CRON`) | Optional, full 5-field cron expressions. Flag wins over env; invalid values fall back to the default. |
| Change the default Index cron schedule for everyone | `install/install_index.ts` (`DIGEST_CRON_SPECS`) | The installer writes the cron entries from this table. Existing installs pick up changes on the next `install.ts` run. |
| Change a cron prompt without changing the schedule | the matching prompt file (`skills/index-network/heartbeat.md` or `skills/edge-esmeralda/prompts/<name>.md`) | Hermes stores prompt copies in cron jobs. Hosted residents are refreshed by the control-plane post-merge sync, which calls each sidecar's `/update` endpoint and reruns the installer. For non-control-plane installs or recovery, run `HERMES_HOME=<resident-home> bun install/reconcile_digest_crons.ts` after updated skill files are copied. |
| Change the memory-sync preflight | `skills/edge-esmeralda/scripts/memory_signal_gate.py` + `install/install_index.ts` script wiring | The script reads local operational state only and should emit `wakeAgent:false` unless `MEMORY.md` changed. |
| Change the Agent Plaza selfie preflight/follow-up context | `skills/agent-plaza/scripts/agent_plaza_selfie.py` + `skills/agent-plaza/prompts/selfie.md` + `skills/agent-plaza/SKILL.md` + `install/install_index.ts` script wiring | The script reads configured Plaza packets or a local ops handoff, writes only under `ops/agentvillage/...`, stores sanitized `lastFollowupContext` on successful sends, and should emit `wakeAgent:false` when Plaza is unavailable. |
| Enable the token usage audit cron | `--token-usage-audit-cron "<expr>"` or `TOKEN_USAGE_AUDIT_CRON="<expr>"` | Disabled by default. When enabled, quiet runs remain non-LLM; alerts require meaningful usage plus an actionable driver and respect a 72-hour per-driver cooldown. |
| Disable the token usage audit cron | omit `TOKEN_USAGE_AUDIT_CRON`, pass `--skip-token-usage-audit-cron`, or set `TOKEN_USAGE_AUDIT_CRON=off` | The reconciler removes the managed audit cron when no explicit schedule opts in. |

### Backends & skills

| You want to… | Edit | Notes |
|---|---|---|
| Wire a brand-new backend | new `install/install_<name>.ts` (modeled on `install_index.ts` for MCP+cron wiring, `install_edgeos.ts` for env-token wiring, or `install_geo.ts` for CLI runtime guidance) + new `skills/<name>/` bundle with `SKILL.md` + register in `workspace/AGENTS.md` "Active skills" | Add the installer call to `install/install.ts` and include the skill in `EDGE_SKILL_NAMES` so it is copied into the runtime workspace. |
| Extend an existing backend (Index, EdgeOS, Geo) | The matching `install/install_<name>.ts` and `skills/<name>/` bundle | Runtime config (env vars, MCP entries, cron jobs, CLI commands) lives in `install_<name>.ts`; agent-facing instructions live in the skill bundle's `SKILL.md` and siblings. |
| Wire optional env vars an existing backend needs | `install/install_<name>.ts` + the Prerequisites section of this README | The installer writes `env.vars.<NAME>`; the gateway exposes those to the agent's shell tools on next start. `install_edgeos.ts` is the worked example. |
| Change which skills the agent loads | `workspace/AGENTS.md` "Active skills" section | Mark a skill as eager (gates fire at session start) or reactive (only consulted when needed). |
| Update the vendored `edgeos` reference data (events, attendee directory, wiki snapshots) | Don't — it's auto-refreshed from upstream | Upstream CI in `Edge-City/agentvillage-skills` regenerates `skills/edgeos/references/` every 15 minutes; the change propagates through the nested subtree chain. See the monorepo's `CLAUDE.md` for the sync flow. The recipes in `SKILL.md` are hand-edited — see the "Content" section above. |

## Auth

Skills in this repo are public. Each backend gates access with its own per-user credential, wired in by the matching per-backend installer:

- **Index Network (today's wired backend)** — per-user API key returned by `POST /api/networks/:id/signup` (see [Integration API: Authentication](#authentication) above). `install/install_index.ts` writes it into `mcp.servers.index` as the `x-api-key` header.
- **EdgeOS** — per-user tokens issued via OTP through the EdgeOS portal. `install/install_edgeos.ts` writes `EDGEOS_API_KEY` and `EDGEOS_BEARER_TOKEN` into the runtime environment when provided.
- **Geo** — uses the attendee's `EDGEOS_BEARER_TOKEN` and the Geo CLI package. Skill recipes run it through `npx`.

The skill files describe HOW to call each backend's APIs; the per-backend credential is what unlocks them.

## Contributing

Maintained by the Edge City and YoursTruly teams. Direct push access is limited to project collaborators; PRs from the community are welcome and will be reviewed.

## Project links

- Edge Esmeralda 2026: https://edgeesmeralda.com
- Substack post: https://edgeesmeralda2026.substack.com/p/the-agent-village-experiment-at-edge

## License

MIT. See [LICENSE](LICENSE).
