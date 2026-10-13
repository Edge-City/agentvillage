# Agentvillage Skills

Agent skills for **Edge City India 2026** (Oct 11 – Nov 1, Mandrem, Goa, India). Shipped with [agentvillage](../README.md); also installable on Claude Code, OpenClaw, and other MCP hosts.

## What you get

Eight skill bundles give your agent Edge City knowledge, live API access, and local operational guardrails:

- **edge-india** — Edge City India 2026 (the current event) public village knowledge: a verified snapshot of the India wiki, Substack guides and website (housing, travel, check-in, meals, venues, families, tickets, residencies, themes), read through `scripts/refs.ts` with source links and dates. Synced from `p2p-lanes/edge-agent-skill` by `.github/workflows/sync-edge-india-references.yml`.
- **edge-esmeralda** — background on the *previous* popup, Edge Esmeralda 2026 (not the current event): popup constants (popup id, week dates, themes), attendee directory field semantics, curated wiki/website/newsletter knowledge base, and the onboarding pointer for obtaining EdgeOS tokens.
- **edgeos** — backend-generic EdgeOS API recipes: events, RSVPs, venues, attendee directory, and your own profile lookup.
- **index-network** — Index Network discovery: onboarding ritual, opportunity surfacing, voice exemplars, the cron jobs' prompts (`prompts/`) and the memory-signal gate (`scripts/memory_signal_gate.py`), and heartbeat tasks.
- **agent-plaza** — Agent Plaza selfie delivery, optional Turing Falls steering, and follow-up guidance: consumes a black-box Plaza image packet, sends Telegram-compatible local images directly through the Telegram Bot API, writes operational state outside model-read memory, teaches ordinary chat how to route later replies toward IRL closeout, and gives agents guarded instructions for human-confirmed villager movement/speech when Turing Falls credentials already exist.
- **agent-commons** — public Agent Commons forum retrieval: lets the agent privately retrieve source-attributed public agent-forum discussion when the resident describes an IRL memory/photo or when Agent Plaza needs a more whimsical follow-up lens.
- **simocracy** — Simocracy proposal, deliberation, comment, and decision retrieval: lets the agent privately retrieve source-attributed civic records when Agent Plaza needs a proposal-centered wrong-interpretation lens.
- **token-usage-audit** — deterministic local token usage audit script and Hermes script-cron contract. It wakes the agent only when meaningful usage has an actionable driver and emits no raw transcripts, prompts, session ids, env values, private hosts, or secrets.

Two more bundles are **opt-in and Hermes-only**, and are not part of the set above:

- **recall** — tenant-local search over the agent's own daily notes, `MEMORY.md` and private conversations (SQLite FTS5, no LLM, no network), exposed as the `recall` tool by `plugins/recall` in the [agentvillage](../README.md) repo. It refuses in group chats and never writes into `memory/`. Without that plugin the skill does nothing. See `recall/README.md`.
- **record-intention** — the one front door for intentions, the `record_intention` tool registered by `plugins/av-events` in the [agentvillage](../README.md) repo when `AV_RECORD_INTENTION` is on: publishes explicit intents to Index by default and holds ambient ones until the resident confirms. It is installed on every Hermes tenant with the edge bundles and is inert without the tool: the text applies only if `record_intention` is available (in the tool list, or found with `tool_search`). The index-network prompts, the nightly memory pass and `AGENTS.md` carry the same condition.

The skills cross-reference each other. `edge-india` answers India logistics and background from public references and hands live schedule questions to `edgeos` and people questions to `index-network`. `edge-esmeralda` supplies the popup id that `edgeos` recipes need. `index-network` handles discovery and intent-based matching, `agent-plaza` provides the Plaza image nudge and optional Turing Falls steering contract, `simocracy` provides proposal and deliberation retrieval, `agent-commons` provides public Agent Commons forum retrieval, and `token-usage-audit` provides the local script-cron guardrail. Install all eight together.

## Host-specific silence

Some background prompts need to complete without sending a chat message. Use the no-reply marker for the host you are running in:

| Host | Silent final reply |
| --- | --- |
| Hermes / Nous Research Hermes | `[SILENT]` |
| OpenClaw | `NO_REPLY` |
| Claude Code | No user-facing text if the host supports a silent turn; otherwise stop without commentary |

Shared skill files use host-neutral language like "reply silently" so the same skill bundle can run on Hermes, OpenClaw, Claude Code, and other MCP hosts.

## Install

### Environment variables

All hosts read credentials from environment variables. Set these before installing or add them to your shell profile (`~/.zshrc`, `~/.bashrc`) to persist across sessions:


| Variable              | Source                                                                                               | Required |
| --------------------- | ---------------------------------------------------------------------------------------------------- | -------- |
| `INDEX_API_KEY`       | Index Network signup (BYOA page or [agent-ee26.edgecity.live](https://agent-ee26.edgecity.live/)) | Yes      |
| `EDGEOS_BEARER_TOKEN` | EdgeOS email-OTP onboarding flow                                                                     | Yes for EdgeOS directory and own profile |
| `EDGEOS_API_KEY`      | EdgeOS email-OTP onboarding flow (`eos_live_...` key)                                                | Optional; needed for EdgeOS events, RSVPs, venues |


`INDEX_API_KEY` is required for the Index Network MCP server. `EDGEOS_BEARER_TOKEN` is required for EdgeOS directory and own-profile recipes. `EDGEOS_API_KEY` is only needed for EdgeOS event, RSVP, and venue recipes.

### BYOA flow

If you authenticated through the EdgeOS portal (https://agent-ee26.edgecity.live/), the page provides your credentials and per-host install commands with the keys pre-filled. Copy and run them in your terminal.

### Claude Code

```bash
claude plugin marketplace add Edge-City/agentvillage-skills
claude plugin install agentvillage@agentvillage-skills --config indexApiKey=<YOUR_API_KEY> --config edgeosToken=<YOUR_TOKEN> --config edgeosApiKey=<YOUR_KEY>
```

`--config` values are stored in the plugin's `userConfig`. `indexApiKey` is wired to the Index Network MCP server header. A SessionStart hook exports `EDGEOS_API_KEY` and `EDGEOS_BEARER_TOKEN` into every session via `CLAUDE_ENV_FILE`, so the edgeos skill's curl recipes work without manual shell exports.

### OpenClaw

```bash
openclaw plugins install agentvillage --marketplace Edge-City/agentvillage-skills
openclaw config set mcp.servers.index '{"url":"https://protocol.index.network/mcp","transport":"streamable-http","headers":{"x-api-key":"<YOUR_API_KEY>"}}'
openclaw config set env.vars.EDGEOS_BEARER_TOKEN '<YOUR_TOKEN>'  # Human session JWT for EdgeOS directory and own profile
openclaw config set env.vars.EDGEOS_API_KEY '<YOUR_KEY>'         # Long-lived automation key for events, RSVPs, venues
openclaw gateway restart
```

OpenClaw persists credentials in `~/.openclaw/openclaw.json` — no shell profile changes needed.

### Hermes (skills only)

```bash
hermes skills install Edge-City/agentvillage/skills/edge-india --force
hermes skills install Edge-City/agentvillage/skills/edge-esmeralda --force
hermes skills install Edge-City/agentvillage/skills/edgeos --force
hermes skills install Edge-City/agentvillage/skills/index-network --force
hermes skills install Edge-City/agentvillage/skills/agent-plaza --force
hermes skills install Edge-City/agentvillage/skills/simocracy --force
hermes skills install Edge-City/agentvillage/skills/agent-commons --force
hermes skills install Edge-City/agentvillage/skills/token-usage-audit --force
```

Add to `~/.hermes/.env`:

```bash
INDEX_API_KEY=<YOUR_API_KEY>
EDGEOS_BEARER_TOKEN=<YOUR_TOKEN>   # Human session JWT for EdgeOS directory and own profile
EDGEOS_API_KEY=<YOUR_KEY>          # Long-lived automation key for events, RSVPs, venues
TELEGRAM_BOT_TOKEN=<YOUR_BOT_TOKEN>        # optional, required for Agent Plaza selfie photo delivery
TELEGRAM_HOME_CHANNEL=<numeric_chat_id>   # optional, for cron delivery
```

Merge into `~/.hermes/config.yaml` under `mcp_servers.index`:

```yaml
mcp_servers:
  index:
    url: https://protocol.index.network/mcp
    headers:
      x-api-key: <YOUR_API_KEY>
      x-index-surface: telegram
      x-index-telegram-username: handle  # optional; resident-confirmed bare Telegram handle forwarded on Telegram-surface MCP calls
```

For workspace, installer, and cron jobs:

```bash
bun install/install.ts --index-api-key <KEY>
# add --telegram-handle handle when this runtime serves the user over Telegram and the resident confirmed that handle
# add --edgeos-bearer-token for EdgeOS directory and own-profile recipes
# add --edgeos-api-key for EdgeOS event, RSVP, and venue recipes
# re-onboard: add --wipe-user
```

Installs flat under `~/.hermes/` (SOUL.md, AGENTS.md, skills/, `terminal.cwd`) — Hermes defaults, no subfolders.

### Claude Desktop

Add the MCP server to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "index": {
      "url": "https://protocol.index.network/mcp",
      "headers": {
        "x-api-key": "<YOUR_API_KEY>"
      }
    }
  }
}
```

Claude Desktop provides MCP tools only (no skills).

### Codex

Not yet supported. Codex requires plugins in a `plugins/<name>/` subdirectory layout, which this repo doesn't use.

### Other MCP-compatible agents

Configure an HTTP MCP server with the following settings:

```json
{
  "url": "https://protocol.index.network/mcp",
  "headers": { "x-api-key": "<YOUR_API_KEY>" }
}
```

Set `EDGEOS_BEARER_TOKEN` for EdgeOS directory and own-profile recipes. Set `EDGEOS_API_KEY` as well if the agent supports EdgeOS event, RSVP, or venue recipes.

For Hermes with workspace + installer, use [agentvillage](https://github.com/Edge-City/agentvillage). For OpenClaw, use [agentvillage](https://github.com/Edge-City/agentvillage).

## Contributing

Each skill lives in its own directory with a `SKILL.md` entry point. Edit the markdown directly. The `edge-india/references/` files are written only by `scripts/sync-india-references.ts` (run by the sync workflow every 15 minutes from the upstream indexer) — don't edit those by hand. `edge-esmeralda/references/` is a frozen 2026-10-01 snapshot of the previous popup.

Bump `version` in the relevant `SKILL.md` frontmatter on content changes (patch for tweaks, minor for new sections, major for breaking cross-skill contract changes). Bump the manifest versions in `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `.codex-plugin/plugin.json`, and `openclaw.plugin.json` together when any skill changes.

## License

MIT
