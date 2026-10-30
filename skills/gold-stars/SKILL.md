---
name: gold-stars
description: Help the owner reflect on meaningful interactions, read their allowance, and send gratitude when the owner asks, after resolving the exact recipient; an approval card only when the owner's own settings ask first. Optional curated mini-app; its install also carries the owner's meeting marks (see `rolodex`) and Skylight status (see `skylight`). Personal received-star history stays on the website.
version: 1.1.2
author: Edge City
---

# Gold Stars

Gold Stars are tokens of gratitude in the Village Rolodex. Open:
https://agents.edgecity.live/rolodex#gold-stars

The owner can send from this paired private Telegram conversation, or open
the website, find the person's card and tap **Send star**. Use the website
when the native tool is unavailable; never bypass it with shell/API calls.

- Each person gets **three stars per day**, at most **one per recipient per day**.
- Unused stars expire at **midnight Asia/Kolkata (India time)**; the new day has
  three stars. This is a calendar-day allowance, not a rolling 24-hour window.
- By default, the gratitude bot posts both names and the note to the village's
  Gold Stars Telegram topic.
- **Send anonymously** hides both names and the note in that topic. It still
  posts anonymous gratitude. The recipient sees the sender and note privately
  in the Rolodex, and admins can identify the sender and recipient. Do not
  describe anonymous as hidden from the recipient, admins, or the Telegram feed.

The person's remaining allowance and received stars are live account data.
For remaining allowance, call `village` with `operation: "gold-stars.quota"` in
the paired owner's private chat. Quote the returned remaining count, day and
reset time. This tool cannot read received stars or messages. If unavailable,
link to the Rolodex; never assume all three remain. The owner must install Gold
Stars in Mini-apps; the control plane stages this skill and provisions scoped
access for the paired agent. An expired sign-in needs the usual
https://agents.edgecity.live/signin. Never ask for credentials in chat.

## Reflection and gratitude

After a relevant meeting follow-up, or when the owner wants to reflect on
their day, ask one gentle question such as “Who made your day brighter?” or
“Was there a moment you'd like to thank them for?” They can thank someone
for a talk, yoga, a conversation, a shared sunset or something said online;
no Rolodex meeting mark is required. Offer a star only when it fits their
answer. Never infer that a meeting was meaningful, pressure them to use their
allowance, repeatedly ask after a decline, or rank people by stars.

Check current quota before suggesting a specific number of stars remains.
If none remain, they can still reflect; don't offer to spend one now. Remember
a star already sent in this conversation instead of prompting for it again.
Their answer to “Was it meaningful?” is not authorization to publish gratitude.

Use the existing evening reflection conversation when they reply. This skill
does not create another schedule, change message preferences, or read private
account data from cron. Scheduled messages use their own script output and
prompt; this live conversation begins with the owner's reply.

## Send when the owner asks

1. Call `village` with `operation: "rolodex.search"` to resolve the intended recipient.
   Ask only when ambiguous. Never substitute an Index id or choose the first match.
2. Use the owner's words for the note; an empty note is fine. Use `named` by
   default, or `anonymous` when requested.
3. Call `gold-stars.prepare` with `attendeeId`, exact `note` and `visibility`.
   It returns a saved `draftId`; no star is spent.
4. When the owner asked to send (“send a star to Naman: thanks for the talk”),
   call `gold-stars.send` with the returned `draftId` in the SAME turn. No
   preview round, no options list, no “reply yes”. If the owner only wondered
   about thanking someone, or the recipient is unclear, show the recipient,
   exact note (or “no note”) and visibility once and send on their yes.
5. Before sending a named star whose note is not thanks, add one short line:
   “Heads up: this posts publicly in Gold Stars with your name.” Nothing else
   comes before the send.
6. The native tool checks the immutable backend preview with the approval gate,
   and the exact payload is authorized and started before any star is sent. If
   the send answers `approval_required`, the owner's own settings ask first: say a card is waiting in the approvals bot,
   then retry the SAME draftId after they approve; never prepare a new preview
   to retry. A chat reply or model boolean is not that approval. In that
   approval-waiting message, include a separate line:
   `Open approvals chat: https://t.me/AgentVillageApprovalsBot`
   Otherwise never mention approval or the approvals bot.
7. A no means cancel the unsent draft with `gold-stars.cancel`. A changed
   recipient, note or visibility needs a fresh prepare. Previews expire within
   an hour or at the India-day boundary. Never claim success on a refusal.
8. After `status: "sent"`, say the star is recorded for the recipient and the
   Gold Stars topic post follows. Never say it posted:
   `telegramDelivery: "not_verified"` means the post is not confirmed yet.
   A replayed receipt is the original star, not a new one. On an uncertain
   send, call `gold-stars.status` with the **same immutable draft id**. If still
   pending, retry that same draft only with its existing exact approval, while
   valid. Native can reuse an already-started proposal's identical proof; the app
   and CP must still verify the grant or policy start and current install
   permission. This does not request a new grant or authorize changed preview
   content. Never create a different draft to retry an uncertain send.

The backend enforces three per India day and one per recipient, shared with
the website. Sending doesn't mark a meeting. No bulk sends, scheduled sends,
received-star reads, cancellation of sent stars, or star visibility edits.
Never claim any of those actions happened.

Answer only the relevant part; do not recite every rule on every request.
