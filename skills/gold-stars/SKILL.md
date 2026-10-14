---
name: gold-stars
description: Help the owner reflect on meaningful interactions, read their allowance, and send gratitude only after an exact recipient/note/visibility preview and real manual approval. Optional curated mini-app; recipient search only, no meeting marks. Personal received-star history stays on the website.
version: 1.1.0
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

## Send only after the exact preview is confirmed

1. Call `village` with `operation: "rolodex.search"` to resolve the intended recipient.
   Ask when ambiguous. Never substitute an Index id or choose the first match.
2. Ask for a note only if useful; an empty note is fine. Use their words, or
   show any proposed wording for review. Use `named` by default for the
   preview, or `anonymous` when requested. The preview must make this clear.
3. Call `gold-stars.prepare` with `attendeeId`, exact `note` and `visibility`.
   It returns a saved `draftId`; no star is spent. Show the returned recipient,
   exact note (or “no note”), visibility and disclosure. For example: “One
   star to Naman. Note: ‘Thanks for the conversation.’ Both names and this
   note will be shared in the village Gold Stars topic. Send it?”
4. End the turn and wait for a new owner reply confirming the exact preview.
   Then call `gold-stars.send` with its `draftId`. The native tool fetches the
   immutable backend preview and requests **manual approval in the approval app**.
   Show `approval_required` honestly; ask the owner to approve there, then retry
   the same draft. A chat reply, model boolean or changed turn is not authority.
   The daemon must grant and start the exact payload before any star is sent.
   A no means cancel the unsent draft with `gold-stars.cancel`. Changed recipient,
   note or visibility needs a fresh preview and approval. Previews expire within
   ten minutes or at the India-day boundary. Never claim success on a refusal.
5. Say sent only for `status: "sent"`. This means recorded in the Rolodex;
   `telegramDelivery: "not_verified"` means don't claim the bot posted it yet.
   A replayed receipt is the original star, not a new one. On an uncertain
   send, call `gold-stars.status` with the **same immutable draft id**. If still
   pending, retry that same draft only with its existing exact approval, while
   valid. Native can reuse an already-started proposal's identical proof; the app
   and CP must still verify the manual grant and current install permission.
   This does not request a new grant or authorize changed preview content.
   Never create a different draft to retry an uncertain send.

The backend enforces three per India day and one per recipient, shared with
the website. Sending doesn't mark a meeting. No bulk sends, scheduled sends,
received-star reads, cancellation of sent stars, or star visibility edits.
Never claim any of those actions happened.

Answer only the relevant part; do not recite every rule on every request.
