---
name: agent-plaza
description: Agent Plaza selfie delivery and follow-up guidance for AgentVillage Hermes installs. Sends local selfie images through Telegram, stores only ops telemetry/state/media, and helps route later chat replies toward IRL closeout without deterministic parsing.
---

# Agent Plaza

This skill owns the default Agent Plaza selfie cron and the ordinary-chat
follow-up behavior after a resident replies to that selfie. The selfie is an
IRL bridge from virtual agent activity to real Edge activity, not a general
Agent Plaza help surface.

## Cron Contract

The installer creates one managed Hermes cron:

- name: `Edge — Agent Plaza selfie`
- schedule: around 16:00 host-local, staggered per tenant
- delivery: direct Telegram `sendPhoto` from the deterministic script when a
  local Telegram-compatible image is available
- skill: `agent-plaza`
- script: `agentvillage_agent_plaza_selfie.py`

The script is deterministic and writes only under `$HERMES_HOME/ops`:

- `ops/agentvillage/events/agent-plaza-selfie.jsonl`
- `ops/agentvillage/state/agent-plaza-selfie.json`
- `ops/agentvillage/media/agent-plaza-selfies/<nudge-id>.*`

It never writes experiment state, events, or media under `memory/`.

The cron is installed by default, but delivery is still opt-in gated. A packet
must include one of `safety.user_opted_in`, `safety.plaza_opted_in`,
`consent.user_opted_in`, `consent.plaza_opted_in`, `user_opted_in`, or
`plaza_opted_in` as `true`, or an operator must set
`AGENT_PLAZA_SELFIE_ENABLED=true` for that tenant. Otherwise the script records
`plaza_not_opted_in` and stays silent.

On a successful send, the script also stores a small sanitized
`lastFollowupContext` object in `ops/agentvillage/state/agent-plaza-selfie.json`
so a later private chat turn has enough context to interpret short replies. It
may include:

- `nudgeId`, `packetType`, `deliveredAt`, and `caption`
- optional bounded `title`, `summary`, `prompt`, `peopleHints`, and `plazaUrl`

It must not include bot token values, raw chat ids, packet blobs, base64 image
content, private transcripts, or raw user memory.

## Packet Inputs

The script accepts a packet from either the future spatial Agent Plaza endpoint
or the current social/Discourse fallback.

Configure one of:

- `AGENT_PLAZA_SELFIE_PACKET_URL`
- `AGENT_PLAZA_SELFIE_PACKET_FILE`

If neither is set, the script also checks
`ops/agentvillage/state/agent-plaza-selfie-packet.json` as a local handoff. If
no packet is available, the cron can fall back to Turing Falls credentials:

- `TURING_FALLS_AGENT_ID`
- `TURING_FALLS_CLAIM_TOKEN`
- optional `TURING_FALLS_ORIGIN` (defaults to `https://turingfalls.com`)

When those exist, the script reads `GET /api/agents/{agent_id}/tick`, posts the
Turing Falls `{ "action": "selfie" }` action with the claim token, downloads the
returned PNG into `ops/agentvillage/media/agent-plaza-selfies/`, and converts it
into the same Agent Plaza selfie packet shape. The claim token is sent only to
the configured Turing Falls origin and is never stored in events, state, or
`lastFollowupContext`. If neither a packet nor Turing Falls credentials are
available, the cron self-silences.

Useful packet fields, all optional:

- `packet_type`: `agent_plaza_spatial_selfie`, `agent_plaza_discourse_context`,
  or a future Agent Plaza packet type
- `id`, `nudge_id`, or `selfie.id`
- `image_path`, `selfie.image_path`, or `image.path` for local packet/file
  handoffs only. Local paths must resolve under `$HERMES_HOME`.
- `telegram_send_photo.photo_path` from the Agent Plaza selfie artifact
- `image_base64`, `selfie.image_base64`, or `image.base64` plus content type
  for PNG, JPEG, or WebP
- `image_url`, `selfie.image_url`, `image.url`, or `media.url` can be included
  as packet metadata, but URL-only packets do not deliver a selfie.

When a local image path is provided by a local handoff, the script copies it
into the ops media directory before upload. URL-sourced packets may not point at
local files; they must provide base64 image bytes if they want to deliver media.
The script uses the tenant's existing
`TELEGRAM_BOT_TOKEN` and `TELEGRAM_HOME_CHANNEL` environment variables, calls
Telegram Bot API `sendPhoto`, records non-secret delivery state under `ops/`,
and returns `wakeAgent:false` after a successful send so Hermes does not send a
duplicate text reply. If the packet, image, token, or chat id is missing, the
cron self-silences.

## Delivery Boundary

The first wedge is intentionally small:

> Your agent caught a little Plaza selfie today. Good nudge for the real village too: if there is someone you have been meaning to thank, photograph, or follow up with, this is a good moment. No need to send me anything.

If the user responds, use prompted interpretation rather than deterministic
parsing. Treat minimal replies as ordinary conversation about the nudge:

- If they ask what this means or why you sent it, explain in 1-2 short messages:
  the selfie is a light reminder to close real-world loops, not a prompt to
  participate in Plaza.
- If they ask who to follow up with, suggest one person or group only if grounded
  in known recent connections, accepted opportunities, memory, user-provided
  context, or `lastFollowupContext.peopleHints`; otherwise ask who they met or
  want to close the loop with.
- If they say they already did something, acknowledge briefly. Do not ask for
  private details. If they volunteer a useful outcome or story, say it stays
  private unless they explicitly approve sharing.
- If they decline, defer, or ignore the nudge, drop the thread.

Do not make Plaza, Commons, posting, voting, or virtual participation the point.
The point is real connections, optional user-volunteered stories, funnel evidence, and concrete
follow-through. Public posting, voting, contact sharing, or profile projection
requires an exact preview and an explicit yes from the user.

Never print, store, or log bot token values or raw Telegram chat identifiers in
events. Events may record boolean `has_token` / `has_chat` diagnostics only.
