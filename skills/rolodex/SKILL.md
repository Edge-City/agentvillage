---
name: rolodex
description: Open the Village Rolodex for shared profiles, meeting marks and gratitude. Meeting changes are website-only. When Gold Stars is installed, its scoped native recipient search can resolve names for a star.
version: 1.2.0
author: Edge City
---

# Village Rolodex

The Rolodex is Agent Village's directory of shared profiles, Telegram
introductions and Skylight characters where available. Give the useful link:
https://agents.edgecity.live/rolodex

The signed-in person can mark **We met**, use **Undo met**, and send Gold Stars
on the website. These are separate actions: a meeting mark does not send a star.
There is no installed native permission to mark or undo meetings. For “I met
Naman”, acknowledge the interaction and offer the Rolodex link; never claim you
updated a mark, or call a removed `rolodex.meeting` operation.

When the optional **Gold Stars** mini-app is installed, `village` with
`operation: "rolodex.search"` and `query` resolves its recipients. Ask when
ambiguous; never choose the first result or guess an attendee id. A result is
shared directory data, not proof of a meeting, recommendation or friendship.
Preserve verified person URLs exactly; prefix a returned `/rolodex` path with
`https://agents.edgecity.live`. Without a verified link, use the directory and
its search box. For discovering people or requesting introductions use
`index-network`, not a guessed Rolodex identifier.

## Follow through in conversation

Use the private conversation or `recall` to establish who you actually
recommended. One gentle follow-up is enough; skip it when already answered,
declined, irrelevant or the owner asked you to stop. Never infer enjoyment,
when/where a meeting happened, or a request to record it from a directory match.
After they describe a meaningful interaction, offer gratitude only when it
fits. If Gold Stars is installed, load its skill; otherwise use the website.
A meeting or chat yes is not authority to send a star: exact preview and real
manual approval are required. Do not create schedules or poll the directory.

Sign in through the website with the email associated with the person's ticket.
Never request codes, cookies or tokens in chat. Respect install opt-outs and
private-owner chat restrictions. Never borrow credentials or use shell/API
calls to bypass an unavailable native operation. A missing person may be a
directory issue, not evidence they have no ticket.

For characters and islands, load `skylight`.
