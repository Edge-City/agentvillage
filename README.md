# EdgeClaw

The Agent Village experience for **Edge Esmeralda 2026** (May 30 – Jun 27, Healdsburg, CA).

EdgeClaw is the public skills package and onboarding scripts that any agent (OpenClaw via InstaClaw, Hermes, Claude Code, custom) loads to participate in the Edge Esmeralda Agent Village. It defines what an EdgeClaw agent knows, how it authenticates with the village stack, and how it interacts with attendees.

## What you get

Once installed, EdgeClaw:

- **Runs onboarding** the first time you message it (greet → profile lookup → community discovery → first signal → `complete_onboarding` → silent capture of your platform handle).
- **Sends a morning digest at 08:00 host-local time** with the connections worth your attention and the asks where you can help.
- **Surfaces ambient discoveries twice daily at 14:00 and 20:00 host-local** — selective per pass: max 3 direct (you're a party) + 3 introducer (you'd make the intro), quality-bar gated. Anything skipped lands in tomorrow's digest.
- **Notifies you when someone accepts** a connection on your behalf.
- **Curates memory** every few days — distills daily notes into long-term `MEMORY.md`.

EdgeClaw never names the plumbing in chat. You see EdgeClaw and (when relevant) your community.

## Architecture

EdgeClaw plugs into the EdgeOS portal (the identity + spine), with InstaClaw as the recommended runtime for non-technical attendees. Backends the agent calls: Geo (knowledge graph), Index (negotiation + ambient discovery), and EdgeOS APIs (calendar, directory).

See the project hub for the full diagram and decisions.

## What's here

- `skills/` — markdown files describing how the agent calls Edge APIs (calendar, directory, Geo, Index)
- `workspace/IDENTITY.md` — what an EdgeClaw agent knows about itself and the village
- `workspace/` — the full runtime workspace bundle (prompts, soul, heartbeat, community context)
- `onboarding/` — intent-capture flow for new agents (1 to 2 questions during setup)
- `install/` — bootstrap scripts for plugging EdgeClaw into a runtime

## Getting an agent connected

Two paths:

**1. I'm new to agents.** Sign up at `edgecity.live/agentvillage` and pick "Set one up for me." InstaClaw provisions a hosted agent with EdgeClaw preinstalled. ~5 minutes.

**2. I know what I'm doing.** Get your EdgeOS API token from the EdgeOS portal, clone this repo, and plug the skills into your existing agent (Hermes, Claude Code, custom Anthropic API setup). ~3 minutes.

## Integration API

The integration API is for **InstaClaw** and **EdgeOS** — the two systems that provision agents on behalf of attendees. End users do not call this directly.

### Authentication

All requests use the experiment network's **master key** as a bearer token:

```
x-api-key: <masterKey>
```

The master key is issued once when the experiment network is created in the Index Network dashboard and is never re-shown.

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

`mcpServer` is the JSON object to write into the runtime's MCP servers config (standard across Claude Code, OpenClaw, Hermes, and most other MCP-compatible runtimes).

**Idempotency**

Every call with the same email returns the same user but a **fresh API key** — the previous key is revoked. Store the key returned by the latest call. If the integrator retries before delivering the key to the attendee, the retried call's key supersedes the earlier one.

**Errors**

| Code | Reason |
|---|---|
| 400 | Missing or invalid email; oversized field; malformed `socials` array. |
| 401 | Missing `x-api-key` header. |
| 403 | Master key invalid; network not in experiment mode; network deleted. |

### What InstaClaw does after signup

1. Runs the EdgeClaw installer with the returned `apiKey`: `bun packages/edgeclaw/install/install.ts <apiKey>` (or equivalent in the hosted runtime).
2. In a follow-up step, captures the attendee's Telegram handle and binds it to their agent transport — this is entirely InstaClaw-owned and happens outside this endpoint.

### What EdgeOS does after signup

Displays the returned `mcpServer` object to the attendee as a copyable config snippet. The attendee pastes it into their agent's MCP servers config (or runs `bun packages/edgeclaw/install/install.ts <apiKey>` from a clone of this repo).

## Prerequisites

- [OpenClaw](https://openclaw.dev) installed and configured (`openclaw onboard --mode local` or `openclaw setup`).
- An API key for the Index protocol. Generate one on your agents page at [index.network](https://index.network) (or your community-branded node).
- [Bun](https://bun.sh) — the installer is a Bun script (Node 20+ also works if you swap the shebang).

## Install

From a clone of this repo:

```bash
bun packages/edgeclaw/install/install.ts <YOUR_API_KEY>
# or
API_KEY=<YOUR_API_KEY> bun packages/edgeclaw/install/install.ts
```

The installer:

1. Writes `mcp.servers.index` in `~/.openclaw/openclaw.json`, pointed at `https://protocol.index.network/mcp` with your API key in `x-api-key`.
2. Sets `channels.telegram.streaming.mode = off` so OpenClaw doesn't dump per-tool status drafts into your chat.
3. Copies the workspace markdown bundle into `~/.openclaw/workspace/`.
4. Installs three cron jobs: daily digest (`0 8 * * *`), ambient discovery afternoon (`0 14 * * *`), ambient discovery evening (`0 20 * * *`).
5. Restarts the gateway so all config changes take effect.

Send any message in your chat to bring EdgeClaw online:

- **Not yet onboarded**: the agent calls `read_user_profiles()` at session start, sees `onboardingComplete: false`, and runs `BOOTSTRAP.md` — which delivers the welcome at the end of the ritual.
- **Already onboarded** (e.g. you reinstalled or migrated machines): the agent skips `BOOTSTRAP.md` and chats normally. The next ambient pass (14:00 / 20:00) or daily digest (08:00) picks you back up.
- **Onboarding got reset server-side**: the next session sees `onboardingComplete: false` and re-runs `BOOTSTRAP.md` from the still-staged file (it's *not* deleted at the end of onboarding, by design).

## Reset

To tear down EdgeClaw and start fresh (leaves Telegram token, OpenRouter key, and gateway config untouched):

```bash
bun packages/edgeclaw/install/reset.ts
```

Then re-install:

```bash
bun packages/edgeclaw/install/install.ts <YOUR_API_KEY>
```

Pass `--wipe-user` to also remove `USER.md` and the `memory/` directory:

```bash
bun packages/edgeclaw/install/reset.ts --wipe-user
```

## How it runs

Time-sensitive work (the daily digest) runs as an **OpenClaw cron job**, not a heartbeat task — cron has its own scheduler and runs in isolated sessions with `--light-context` so each tick is cheap. The cron jobs are installed by `install/install.ts` and restart with the gateway.

The remaining ambient/accepted/freshness/memory work stays on the heartbeat tick because 30-minute latency is acceptable for those flows.

## Workspace layout

| File | Purpose |
| --- | --- |
| `BOOTSTRAP.md` | First-run ritual: greet, run onboarding, capture platform handle, welcome. **Not** deleted at the end — the server's `onboardingComplete` flag is the source of truth, so the file stays around in case onboarding ever needs to be re-run. |
| `AGENTS.md` | Operating instructions + canonical voice exemplars (welcome, morning digest, ambient update, greeting drafts). The first-run gate checks `onboardingComplete` from `read_user_profiles()`, not local file state. |
| `COMMUNITY.md` | Edge Esmeralda context — dates, attendee count, programming format, design principles. The agent reads this when composing welcomes and digests. |
| `SOUL.md` | Voice, banned vocabulary, "never name the plumbing", boundaries, continuity. |
| `IDENTITY.md` | EdgeClaw identity — role, context, tone. |
| `USER.md` | Lived notebook — populated by `BOOTSTRAP.md` from the user's onboarding answers. |
| `TOOLS.md` | MCP endpoint, full tool family list, output translation table, channel formatting, URL preservation rule. |
| `HEARTBEAT.md` | Background tasks that run on the OpenClaw heartbeat tick: accepted opportunities, signal freshness, memory curation. |
| `prompts/welcome.md` | Self-contained prompt for the welcome pass — used by `BOOTSTRAP.md` Step 6. Self-dedupes via `memory/welcome-state.json` and gates on server-side `onboardingComplete`. |
| `prompts/digest.md` | Self-contained prompt for the daily 08:00 digest cron. |
| `prompts/ambient.md` | Self-contained prompt for the 14:00 + 20:00 ambient discovery crons. Selective: max 3 direct + 3 introducer per dispatch, dedup via `memory/heartbeat-state.json:lastAmbientHash`. |

## Auth

Skills in this repo are public. Access to actual village data is gated by per-user EdgeOS API tokens (issued via OTP through the EdgeOS portal). The skill files describe HOW to call the APIs; the token is what unlocks them.

## Contributing

Maintained by the Edge City and YoursTruly teams. Direct push access is limited to project collaborators; PRs from the community are welcome and will be reviewed.

## Project links

- Edge Esmeralda 2026: https://edgeesmeralda.com
- Substack post: https://edgeesmeralda2026.substack.com/p/the-agent-village-experiment-at-edge

## License

MIT. See [LICENSE](../../LICENSE) at the repo root.
