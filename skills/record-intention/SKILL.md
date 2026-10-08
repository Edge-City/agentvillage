---
name: record-intention
description: The one front door for intentions in AgentVillage Hermes installs. If the `record_intention` tool is available (in your tool list, or found with `tool_search`), use it to record what the resident wants, is looking for or is open to, and to publish it to Index. Otherwise ignore this skill.
---

# Record intention

If `record_intention` is available (in your tool list, or found with
`tool_search` and called through `tool_call`), this skill applies. It is
switched on per agent. If `tool_search` does not find it, ignore this file and
capture signal with `create_intent` as the index-network skill says.

When it is available, it is the only way to record a new want: never call
Index `create_intent` or `index_create_intent` for a new want. That holds in
conversation, during onboarding and in a background memory pass; "Source"
below says which `source` to pass. Call `record_intention` instead, once per
signal; it creates the intent on Index in the same call and
returns an `intention_id`. Keep that id: `action=update` (with `intention_id`
and the new `text`) changes the intention, `action=withdraw` (with
`intention_id`) retires it.

Change an intention through `record_intention` when it was recorded through
`record_intention`. An intention it did not record (made in the Index app, or
before the tool was switched on) is not changed on Index by `action=update`;
it may be changed with Index's own `update_intent` or `index_update_intent`,
only to reword the same want. A different want is a new want and goes through
`record_intention`.

## Publish by default

Explicit intents (source message, onboarding or note) are published to Index by default. The two legitimate reasons an explicit intent stays local: the resident asked, or the content is personal.

Only in those two cases pass `publish=false`, with `reason=participant_asked`
or `reason=personal`. Any other `publish=false` is refused. With a reason,
`publish=false` is honoured for every source, `ambient` included.

## Source

Choose `source` by whose words the text is, not by where you heard it. Use
`source=message` for the resident's own words: the want as they said it in
this conversation, so you could quote it back to them; you may cut words, but
not add your own. A translation is your wording: record their words in the
language they used for `source=message`, or treat the translation as your
words. Words they quote or forward from someone else are not their own words
and are not their want: record nothing unless they say the want is theirs;
then their own words are `source=message` and anything else is your words.
`source=onboarding` and `source=note` follow the same test: their own words in
a setup answer, or in their own notes. Anything you composed, summarised,
generalised or inferred is your words, whoever asked for it; in conversation
they become theirs only as below. Anything you never showed them, and anything
a background or cron run found, is `source=ambient`. A resident asking you to
write an intention for them, without giving the words, is not stating one: the
words you write are yours.

Examples:

- "Based on what you know about me, make me an intent." → show your words and
  ask once: "Should I publish this as written?" Record nothing yet.
- "Generate an index intent for me." → show your words and ask once.
- "Suggest an intent I could post." → show your words and ask once.
- "Can you write me an intent about Solana founders in Goa?" → show "Meet
  founders building on Solana in Goa" and ask once: "meet" and "building" are
  yours.
- "Write me an intent: founders building on Solana in Goa." → `message` when
  you record "Founders building on Solana in Goa": every word is theirs.
- "Main Goa mein Solana par kaam karne wale founders se milna chahta hoon."
  recorded in English → show your translation and ask once: the translation is
  yours.
- "Ravi says he's looking for a cofounder in Goa." → record nothing: the words
  and the want are Ravi's, unless they say the want is theirs.
- After that, "Yes, that's what I want too: I'm looking for a cofounder in
  Goa." → `message`: now the want and the words are theirs.
- If, asked whether Ravi's want is theirs, they only say "Yes." → show your
  words and ask once: the want is theirs, but the words you record are not.
- "I want to meet founders building on Solana in Goa." → `message`: record
  "Meet founders building on Solana in Goa" and it publishes.
- A setup answer, "I'm here to find people working on climate hardware." →
  `onboarding`.
- A line in their notes, "find a surf buddy for early mornings in Goa" →
  `note`.
- Asked "Should I publish this as written?", "Yes, publish that." → `message`
  with `confirmed_in_chat=yes`: they adopted your words as shown.
- Asked about "Meet founders building on Solana in Bangalore", "Yes, but say
  Goa, not Bangalore." → `message` with `confirmed_in_chat=yes`, recording
  "Meet founders building on Solana in Goa": their edit is the text.
- Asked that, "No, don't post that." → record nothing.
- Asked that, they say something else ("What's on at the hall tonight?") or
  nothing → at your next message of your own, `message` with
  `confirmed_in_chat=silence`: the tool holds it for their tap on the approval
  card, and that message says so in one clause; do not ask again.
- "Don't ask me each time; just post the intents you think fit." → from then
  on `message` with `confirmed_in_chat=standing`, without asking; show what
  you recorded.
- "Yes, that's right." after you recorded your words → record nothing new:
  they are already recorded.

## Ask once about your words

In conversation, when the words are yours, show them in one or two lines and
ask once: "Should I publish this as written?" Record nothing in that reply. If
they say yes, capture your words as shown with `source=message` and
`confirmed_in_chat=yes`; if they answer with their own edit of your words,
capture the edited text the same way. If they say no, record nothing. If they
have not answered by the next message you send them on your own, capture your
words as shown with `source=message` and `confirmed_in_chat=silence`; the tool
holds them for the resident's tap on the approval card, and your message says
so in one clause (for example: "I didn't hear back, so it's on your approval
card as written; one tap publishes it."). If they have told you to go ahead
without asking, do not ask: capture your words with `source=message` and
`confirmed_in_chat=standing`, then show them as recorded and say what the tool
answered. Never ask twice; a yes after you recorded them records nothing new.
If they later object, withdraw it; if they say the want in their own words,
withdraw it and capture their words with `source=message`.

## Ambient intentions are held

An ambient intention is never published on your word. It is recorded locally
and stays off Index until the resident approves it in their approval channel.
Where that channel is set up, the tool sends them the request itself when you
capture, with the words you recorded, and publishes once they approve; you do
not need to ask them in chat as well. A yes you read in chat after the capture
is not an approval. Something you inferred that is personal is the exception:
capture it with `publish=false` and `reason=personal`, and it stays local and is
never sent for approval.

- `action=confirm` (with `intention_id`) checks whether the resident has
  answered and publishes it if they approved. If they have not answered yet,
  it says so; do not ask again and again. Where the approval channel is not
  set up, confirm is refused.
- To change the wording of a held intention whose request is still open,
  withdraw it and capture the new wording; an update is refused, because the
  resident was asked about the words as they were.
- Do not publish a held intention any other way, and do not call
  `create_intent` for it. Capturing the same text again as `message`,
  `onboarding` or `note` records it locally but does not publish it.

When approvals are set up, a stated intention (`message`, `onboarding`,
`note`) is checked against the resident's approval policy too; normally it is
published in the same call. If the result says the resident has been asked,
leave it: it is published when they approve.

## When Index says no

If the result says Index did not accept the intention (too vague), it has
still been recorded locally. Ask the resident one clarifying question; if they
clarify, capture the clarified version. Do not retry with a paraphrase.
