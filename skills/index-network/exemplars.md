# Index Network — Voice Exemplars

Canonical user-facing renderings for Edge Esmeralda's Index Network flows. Mimic these exactly when composing the morning brief and greeting drafts. They are the bar for tone, structure, and information density. Edge Esmeralda is the literal community in every example — pull facts from `AGENTS.md` Community context, never invent dates, attendee counts, programming formats, announcements, events, or attendees.

## Good morning brief (fires once daily, 08:00 Pacific time)

Calendar bullets should put EdgeOS `highlighted: true` events first, then fill with one interest-relevant event from the remaining live calendar when useful.

> 🌞 Good morning from Edge Esmeralda. It is Thursday, June 4
>
> Here's what you need to know today:
>
> **Announcements**
> - The organizer team moved tonight's community dinner to the plaza because of the weather window. Same time, different place.
>
> **The calendar today:**
> - 9:00 AM PST — Morning workout at the Plaza. A useful reset before the day gets full.
> - 11:30 AM PST — Longevity Tools Show-and-Tell at Buck Institute. Good fit if you're tracking health, measurement, or translational science.
> - 4:00 PM PST — Governance Lab: Consent in Popup Communities. Relevant to anyone thinking about coordination, resident voice, or collective decisions.
>
> **Potential connections via Index Network:**
> - [Maya]({profileUrl}) — Talk to them about agent memory layers for long-running workflows. Direct overlap with how Index handles persistent context, [say hi]({acceptUrl})
> - [Theo]({profileUrl}) — Researching how information surfaces in decentralized networks. That's the type of thinking that sharpens protocol design, [say hi]({acceptUrl})
>
> **Help your community**
> - [Remi]({profileUrl}) — Looking for a technical co-founder for his regenerative education platform. Needs someone who thinks in systems and has shipped infrastructure. Know someone, [make intro]({acceptUrl}).
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### No verified announcements

When there is no current organizer announcement you can verify, omit the section entirely:

> 🌞 Good morning from Edge Esmeralda. It is Tuesday, June 9
>
> Here's what you need to know today:
>
> **The calendar today:**
> - 10:00 AM PST — AI Agents Breakfast Salon at Hotel Trio. A straightforward place to hear what people are building this week.
> - 2:00 PM PST — Neurotech Open Demos at Buck Institute. Relevant if you're following applied science and human performance.
>
> **Potential connections via Index Network:**
> - [Priya]({profileUrl}) — Building community-owned data infrastructure. Aligned on the ownership layer and complementary on discovery, [say hi]({acceptUrl})
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### Calendar fallback

If the live calendar call fails, ship the people sections and include one plain pointer:

> 🌞 Good morning from Edge Esmeralda. It is Wednesday, June 10
>
> Here's what you need to know today:
>
> **Potential connections via Index Network:**
> - [Ashish]({profileUrl}) — An experienced technologist spanning generative software, AI infrastructure, creative AI design, and deep learning research. Several angles worth exploring, [say hi]({acceptUrl})
>
> I couldn't check the live calendar this morning — ask me what's on today and I'll look it up.
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### Grouped: same person, multiple connections

When `list_opportunities` returns multiple opportunities for the same person, render as a single bullet with multiple conversation entry points:

> 🌞 Good morning from Edge Esmeralda. It is Tuesday, June 16
>
> Here's what you need to know today:
>
> **The calendar today:**
> - 9:30 AM PST — Creative AI Crit at the Studio. Good fit for builders thinking about tools, taste, and new creative workflows.
> - 3:00 PM PST — Spatial Computing Walkthrough at the Plaza. Useful if you want to see concrete demos rather than a panel.
>
> **Potential connections via Index Network:**
> - [Ashish]({profileUrl}) — An experienced technologist spanning [generative software]({acceptUrl1}), [AI infrastructure]({acceptUrl2}), [creative AI design]({acceptUrl3}), and [deep learning research]({acceptUrl4}). Several angles worth exploring.
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

## Greeting drafts (the `&msg=` payload appended to Telegram links)

For `connection` candidates, compose a short personal greeting based on what's in common — 2–4 sentences max, first-person from the user, references something specific from the candidate's bio/profile.

> Hey Jeremiah, Seren Sandikci here. Saw your work with Blitzscaling Ventures and your focus on early-stage AI investments, especially around AI Agents. I'm building in that space too and would love to connect.

For `connector-flow` candidates ("help your community"), the greeting is the user nudging a third party to make an intro:

> Hey Remi, Seren here. Saw you're looking for a technical co-founder for the regenerative education platform. Might have someone in mind who's …

URI-encode the greeting and append it as `&msg=...` (or `?text=...` for `t.me`) on the action URL. The base URL + token portion must remain untouched — only append the message parameter.

## Connector-flow rendering rule

For introducer (`connector-flow`) candidates:

- **DO link the person's name** to `profileUrl` (the Index web profile URL — same shape as direct candidates).
- If the connector-flow card includes a real `acceptUrl`, embed it on the trailing `[make intro]({acceptUrl})` action. If no `acceptUrl` is present, render `make intro` as plain text — never invent the URL.
- Never compose a `&msg=` greeting for `connector-flow` candidates — only for `connection`. Connector accepts trigger an introduction approval, not a direct conversation.
