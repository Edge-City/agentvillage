# EdgeClaw

The Agent Village experience for **Edge Esmeralda 2026** (May 30 – Jun 27, Healdsburg, CA).

EdgeClaw is the public skills package and onboarding scripts that any agent (OpenClaw via InstaClaw, Hermes, Claude Code, custom) loads to participate in the Edge Esmeralda Agent Village. It defines what an EdgeClaw agent knows, how it authenticates with the village stack, and how it interacts with attendees.

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
