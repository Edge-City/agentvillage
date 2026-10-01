# Index Network — Voice Exemplars

Canonical user-facing renderings for Edge City India's people-finding flows. Mimic these exactly when composing the morning brief and greeting drafts. They are the bar for tone, structure, and information density. Edge City India (Mandrem, Goa, October 11 – November 1, 2026) is the literal community in every example — pull facts from `AGENTS.md` Community context, never invent dates, attendee counts, programming formats, announcements, events, venues, or attendees. Calendar lines below are `{placeholders}`: fill them only from the live calendar context, never with example or Edge Esmeralda content.

People opportunities come first when they have a truthful reason and a real action. Lead with the reason, offer one action, and leave a correction path. Do not describe backend activity, advertise virtual worlds, or turn the brief into a broad digest.

## Good morning brief (fires once daily, 08:00 village time, IST)

Calendar bullets should put EdgeOS `highlighted: true` events first, then fill with one interest-relevant event from the remaining live calendar when useful.

> 🌞 Good morning from Edge City India. It is Thursday, October 15
>
> Here's what you need to know today:
>
> **Announcements**
> - {Verbatim organizer announcement from the context.}
>
> **The calendar today:**
> - {timeLocal} IST — {Highlighted event title} at {venue}. {One line on why it fits this user.}
> - {timeLocal} IST — {Interest-relevant event title} at {venue}. {One line on why it fits this user.}
>
> **People worth a real hello**
> - [Maya]({profileUrl}) — Strong reason to meet: both of you are working on long-running agent memory, but from different angles. [Say hi]({acceptUrl}).
> - [Theo]({profileUrl}) — The useful overlap is information surfacing in decentralized networks; that could sharpen how you think about protocol design. [Say hi]({acceptUrl}).
>
> If any of these reads are off, reply with what I should correct.
>
> **Help your community**
> - [Remi]({profileUrl}) — Looking for a technical co-founder for his regenerative education platform. Needs someone who thinks in systems and has shipped infrastructure. Know someone, [make intro]({acceptUrl}).
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### No verified announcements

When there is no current organizer announcement you can verify, omit the section entirely:

> 🌞 Good morning from Edge City India. It is Monday, October 19
>
> Here's what you need to know today:
>
> **The calendar today:**
> - {timeLocal} IST — {Event title} at {venue}. {One line on why it fits this user.}
>
> **People worth a real hello**
> - [Priya]({profileUrl}) — Strong reason to meet: both of you are circling community-owned data infrastructure, with complementary angles on ownership and discovery. [Say hi]({acceptUrl}).
>
> If this read is off, reply with what I should correct.
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### Calendar fallback

If the live calendar is unavailable (call failed, or no Edge City India calendar is configured yet), ship the people sections and include one plain pointer:

> 🌞 Good morning from Edge City India. It is Tuesday, October 20
>
> Here's what you need to know today:
>
> **People worth a real hello**
> - [Ashish]({profileUrl}) — Strong reason to meet: his work spans generative software, AI infrastructure, creative AI design, and deep learning research, which gives you several concrete angles for a first conversation. [Say hi]({acceptUrl}).
>
> If this read is off, reply with what I should correct.
>
> I don't have today's Edge City India schedule this morning — the Edge City portal or the organisers will have what's on.
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### Grouped: same person, multiple connections

When `list_opportunities` returns multiple opportunities for the same person, render as a single bullet with multiple conversation entry points:

> 🌞 Good morning from Edge City India. It is Monday, October 26
>
> Here's what you need to know today:
>
> **The calendar today:**
> - {timeLocal} IST — {Event title} at {venue}. {One line on why it fits this user.}
>
> **People worth a real hello**
> - [Ashish]({profileUrl}) — Strong reason to meet: his work spans [generative software]({acceptUrl1}), [AI infrastructure]({acceptUrl2}), [creative AI design]({acceptUrl3}), and [deep learning research]({acceptUrl4}); pick the angle that is most real for you.
>
> If this read is off, reply with what I should correct.
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
