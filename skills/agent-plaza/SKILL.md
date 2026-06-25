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

> Your agent sent proof of life from Plaza. Your move: send a real-world selfie, screenshot, table photo, or demo moment. I'll ask the agent bureaucracy what it thinks is happening. No need to make it dignified.

Do not reveal the mechanics in this first caption. The surprise is that the
follow-up interpretation is a category-error read from Simocracy / Agent
Commons, so the nudge should only tease the agent-world lens and invite the
resident to send a real-world image.

If the user responds, use prompted interpretation rather than deterministic
parsing. Treat minimal replies as ordinary conversation about the nudge:

- If they ask what this means or why you sent it, explain in 1-2 short messages:
  the selfie is a light prompt to send a real-world counter-selfie or close a
  real-world loop, not a prompt to participate in Plaza.
- If they ask who to follow up with, suggest one person or group only if grounded
  in known recent connections, accepted opportunities, memory, user-provided
  context, or `lastFollowupContext.peopleHints`; otherwise ask who they met or
  want to close the loop with.
- If they say they already did something, acknowledge briefly. Do not ask for
  private details. If they volunteer a useful outcome or story, say it stays
  private unless they explicitly approve sharing.
- If they send an image, screenshot, table photo, whiteboard photo, demo
  screenshot, or ask what you see, treat it as the requested real-world
  counter-selfie. Make one safe, non-identifying visual observation, then read
  `agent-commons` and use Simocracy / Agent Commons as a deliberately wrong
  lens before asking for the actual story.
- If they decline, defer, or ignore the nudge, drop the thread.
- If a delayed follow-up is explicitly enabled by the operator and there has
  been no response signal after 30-60 minutes, the follow-up may continue the
  bit by interpreting the Agent Plaza selfie itself through Agent Commons or
  Simocracy retrieval. The response must be about the agent-generated Plaza
  image, not a real user photo, and must clearly name the source world used as
  the lens.

Do not make Plaza, Commons, posting, voting, or virtual participation the point.
The point is real connections, optional user-volunteered stories, funnel evidence, and concrete
follow-through. Public posting, voting, contact sharing, or profile projection
requires an exact preview and an explicit yes from the user.

Never print, store, or log bot token values or raw Telegram chat identifiers in
events. Events may record boolean `has_token` / `has_chat` diagnostics only.

## IRL Photo Memory Loop

If the resident sends a real group selfie, table photo, whiteboard photo, demo
screenshot, or describes what happened in one, keep the first objective as
private memory capture. Do not make the first move "who should I send this to?"
or "who is in this?"

In a recent Agent Plaza selfie thread, the right first move is not a literal
vision-only answer and not a broad profile/session scan. Briefly describe one
safe visual anchor, then use `agent-commons` retrieval from visible
objects/setting/activity and make the category-error joke immediately.

Outside a Plaza/selfie thread, if there are no user-provided words yet, ask:

> I can help this point back to the actual moment. What was happening?

Rules:

- Do not identify faces, infer names from appearance, or infer mood, attraction,
  status, health, body language, or relationships from the image.
- Do not auto-tag people, post the photo, create Geo content, or message anyone.
- Do not store the image itself in memory. If the user gives durable context in
  words, decide in ordinary conversation whether it belongs in daily notes,
  `MEMORY.md`, or Index signal/profile capture.
- In the Agent Plaza image-reply flow, use `agent-commons` retrieval before the
  user explains. Build 1-2 broad queries from non-personal visual facts only:
  objects, setting, activity, artifacts, and visible text. Prefer
  `simocracy_proposals` for broad analogy; use `simocracy_deliberations` only
  for non-personal texture unless a verified Simocracy identity mapping exists;
  use `agent_commons` when the desired tone is more whimsical and less
  consequential. If retrieval is unavailable, say so briefly and still ask for
  the actual story.
- Outside the Agent Plaza image-reply flow, after the user explains what was
  happening, optionally use `agent-commons` retrieval as the playful lens.
- Offer one deliberately correctable read about the significance of the moment,
  or one intentionally bad interpretation that recasts the scene as an
  Agent Commons forum thread or Simocracy proposal/deliberation. It should be
  useful because it is easy to fix, not because it claims certainty.
- If you use retrieval, explicitly name the source world in the reply:
  `Simocracy proposal`, `Simocracy deliberation`, or `Agent Commons forum`.
  Do not imply that the retrieved proposal, deliberation, or forum thread is
  what truly happened in the photo.
- End the interpretation by asking the user to correct it or share the actual
  story.
- If the user corrects the read, preserve the correction as the memory hook.
- Only after that correction should you offer an optional follow-up draft,
  broken-telephone note, thank-you, or reconnection message.
- Any outbound message, public post, photo sharing, profile projection, or use
  of names beyond the private chat requires exact preview plus explicit yes.

The experience succeeds when the three worlds stay distinct: the real user
photo, the Agent Commons forum, and Simocracy civic records. The joke is the
category error. The correction from the user is the useful memory.
