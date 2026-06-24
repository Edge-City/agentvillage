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
no packet is available, the cron self-silences.

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

> Your agent caught a little Plaza selfie today. Good nudge for the real village too: take a group photo, say goodbye, or follow up with someone you met. No need to send me anything. Reply more, who, done, or skip.

If the user responds, use prompted interpretation rather than deterministic
parsing. Treat minimal replies as hints:

- `more`: explain the nudge in 1-2 short messages and offer concrete IRL closeout
  moves: take a group selfie, say goodbye, follow up on one open thread, or send
  one thank-you.
- `who`: suggest one person or group only if grounded in known recent
  connections, accepted opportunities, memory, user-provided context, or
  `lastFollowupContext.peopleHints`; otherwise ask who they met or want to close
  the loop with.
- `done`: acknowledge briefly. If there may be useful evidence for the team, ask
  for one optional sentence about what happened and say it stays private unless
  they explicitly approve sharing.
- `skip`, `later`, or similar: acknowledge and drop the thread.

Do not make Plaza, Commons, posting, voting, or virtual participation the point.
The point is real connections, optional user-volunteered stories, funnel evidence, and concrete
follow-through. Public posting, voting, contact sharing, or profile projection
requires an exact preview and an explicit yes from the user.

Never print, store, or log bot token values or raw Telegram chat identifiers in
events. Events may record boolean `has_token` / `has_chat` diagnostics only.
