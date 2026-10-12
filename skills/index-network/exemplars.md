# Index Network — Voice Exemplars

Canonical user-facing renderings for Edge City India's people-finding flows. Mimic these exactly when composing an opportunity reply or an introduction drop. They are the bar for tone, structure, and information density. Edge City India (Mandrem, Goa, October 11 – November 1, 2026) is the literal community in every example — pull facts from `AGENTS.md` Community context, never invent dates, attendee counts, programming formats, announcements, events, venues, or attendees. Calendar lines below are `{placeholders}`: fill them only from the live calendar context, never with example or Edge Esmeralda content.

Direct conversations come first. Each card names its topic in at most six words taken from Index's `headline` (never its `summary`, never a URL, a handle or a number), or leaves the topic out when the headline reads like a request, an instruction or an address to anyone, and carries one message link. Do not describe backend activity, advertise virtual worlds, or turn the brief into a broad digest.

## Good morning brief (fires once daily, 08:00 village time, IST)

Since DATA-314 the scheduled brief itself (prompts/brief.md) names waiting people in plain text and closes its people part with one `Connections:` line; it carries no per-person link. The cards below are the voice for chat replies and introduction drops, where each pending card carries its own `acceptUrl`. The scheduled brief also puts one blank line between calendar events and gives the Agent Village front page once, on one `Agent Village:` line near the end.

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
>
> - {timeLocal} IST — {Interest-relevant event title} at {venue}. {One line on why it fits this user.}
>
> **3 conversations await you**
> Tapping a link opens Agent Village, where one tap accepts; once you have both accepted, it opens Telegram with them.
> - [Maya]({userUrl}) — waiting to hear from you about {topic}, [message Maya]({acceptUrl}).
> - [Theo]({userUrl}) — waiting to hear from you about {topic}, [message Theo]({acceptUrl}).
> - [Priya]({userUrl}) — waiting to hear from you about {topic}, [message Priya]({acceptUrl}).
>
> **Help your community**
> - [Remi]({userUrl}) — asked for an introduction about {topic}. Know anyone, make intro
>
> Agent Village: https://agents.edgecity.live
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
> **1 conversation awaits you**
> Tapping the link opens Agent Village, where one tap accepts; once you have both accepted, it opens Telegram with them.
> - [Priya]({userUrl}) — waiting to hear from you about {topic}, [message Priya]({acceptUrl}).
>
> Agent Village: https://agents.edgecity.live
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### Calendar fallback

If the live calendar is unavailable (call failed, or no Edge City India calendar is configured yet), ship the people sections and include one plain pointer:

> 🌞 Good morning from Edge City India. It is Tuesday, October 20
>
> Here's what you need to know today:
>
> **1 conversation awaits you**
> Tapping the link opens Agent Village, where one tap accepts; once you have both accepted, it opens Telegram with them.
> - [Ashish]({userUrl}) — waiting to hear from you about {topic}, [message Ashish]({acceptUrl}).
>
> I don't have today's Edge City India schedule this morning — the Edge City portal or the organisers will have what's on.
>
> Agent Village: https://agents.edgecity.live
>
> That's it for now. You can always ask me for more detail, or any other questions you have!

### Same person, more than one opportunity

One bullet per opportunity, each with its own `acceptUrl`. Do not merge several opportunities into one bullet. They still count toward the three.

## Asked in chat: "any intros?" (list_opportunities, two pending and one negotiating)

The tool's lead line is the roster: names linked to their profiles, no message link. The reply keeps those profile links and adds, for every pending introduction (not a community ask), in the resident's own private chat, the message link copied from that card's `acceptUrl` in the JSON below the lead line. A `negotiating` card gets no message link yet. The reply never promises the link for a later turn and never labels a link "Profile".

> **2 conversations await you**
> Tapping a link opens Agent Village, where one tap accepts; once you have both accepted, it opens Telegram with them.
> - [Adam]({userUrl}) — waiting to hear from you about {topic}, [message Adam]({acceptUrl}).
> - [Paul]({userUrl}) — waiting to hear from you about {topic}, [message Paul]({acceptUrl}).
>
> Still in motion: [Lena]({userUrl}) — your agents are still talking; nothing for you to do yet.

## Connector-flow rendering rule

For introducer (`connector-flow`) candidates:

- **DO link the person's name** to `userUrl` (`https://agents.edgecity.live/rolodex?person=<userId>`).
- The trailing `make intro` is plain text, not a hyperlink.
- Do not put a connect redirect or an `&msg=` greeting on these cards.
