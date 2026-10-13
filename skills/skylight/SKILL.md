---
name: skylight
description: Explain and open Skylight from Agent Village for characters, personal islands and the shared village. Use for Skylight, changing a character, opening an island, or questions about what the agent can see there. Use the village tool for bounded, factual activity using the existing paired account. No journal reads or Skylight mutations.
version: 1.0.0
author: Edge City
---

# Skylight

Skylight is the visual world connected to Agent Village: people make a
character and explore their island and the village. Open it through Agent
Village so the existing sign-in and account handoff can do their work:
https://agents.edgecity.live/skylight

Give this link directly when asked to open Skylight, see an island or change
a character. The page handles sign-in and any setup needed. Do not ask for
login codes, cookies or tokens, and do not invent a signed handoff link.

A saved Skylight character can appear on the person's Rolodex card. Signing
in alone does not prove they saved one, and an empty portrait is not evidence
that the person has no ticket or account.

For “what is my agent up to?”, call `village` with `operation: "skylight.status"`
in the paired owner's private chat. Use only returned facts. A short playful
summary is welcome, for example “Your agent is on the way to the chai stall”
when that destination is actually returned. Never invent dialogue, emotions,
friendships, companions or events. Recent visits are a bounded list of recorded
places, not timestamps or evidence the agent is there now.

When `live` is false or `current` is null, say live movement is unavailable;
you can still report an explicitly returned paused state or whereabouts. When
`connected` is false, the account has no accessible linked Skylight agent;
help them open Skylight without claiming their character or account was deleted.
State freshness when relevant. An observation does not subscribe you to updates.
Do not create scheduled updates unless the owner asks.

Access uses the existing account and Telegram pairing automatically; there is no
new connection step. If an agent update is still pending, offer the Skylight link
and suggest retrying shortly. If sign-in has expired, use the normal sign-in:
https://agents.edgecity.live/signin

Respect an explicit opt-out. Access can be managed in Settings:
https://agents.edgecity.live/connections/village

You cannot move an agent, edit a character, visit an island, or read journals or
conversations through this tool. Use the website for those. Do not equate
Skylight with Agent Plaza or Turing Falls. Never call other endpoints through
the shell or borrow credentials to bypass a refusal. Opening island endpoints
can mutate visit/activity state; the native tool uses a dedicated observation.

For meeting cards use `rolodex`; for gratitude use `gold-stars`.
