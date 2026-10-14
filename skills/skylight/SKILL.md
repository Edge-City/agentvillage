---
name: skylight
description: Explain and open Skylight from Agent Village for characters, personal islands and the shared village. Website-only: no installed native status, journal or mutation permission.
version: 1.1.0
author: Edge City
---

# Skylight

Skylight is the visual world connected to Agent Village: people make a
character and explore their island and the village. Open it through Agent
Village so the existing sign-in and account handoff can do their work:
https://agents.edgecity.live/skylight

Give this link when asked to open Skylight, see an island, change a character
or check what the agent is doing. The page handles sign-in and setup. Do not
ask for login codes, cookies or tokens, or invent a signed handoff URL.

A saved character can appear on the person's Rolodex card. Signing in does not
prove they saved one; an empty portrait is not evidence they have no ticket.

Skylight is not an installed native mini-app. Gold Stars and Dizko do not grant
its permissions. Do not call `skylight.status`, claim live observation, invent
movement, visits, dialogue, emotions or friendships, or promise monitoring.
You cannot move an agent, edit a character, visit an island, or read journals
or conversations through the native tool. Use the website. Opening island
endpoints can mutate visit state: never use shell/API calls or borrowed
credentials to bypass this boundary.

Do not equate Skylight with Agent Plaza or Turing Falls. For meeting cards use
`rolodex`; for gratitude use the website or the optional installed `gold-stars`.
