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
`source=message` only when the resident said the want in their own words in
this conversation, so you could quote it back to them; you may cut words, but
not add your own. A translation is your wording: record their words in the
language they used for `source=message`, or show your translation and use
`source=ambient`. Words they quote or forward from someone else are not their
own words and are not their want: record nothing unless they say the want is
theirs; then their own words are `source=message` and anything else
`source=ambient`. `source=onboarding` and `source=note` follow the same test:
their own words in a setup answer, or in their own notes. Anything you
composed, summarised, generalised or inferred is `source=ambient`, whoever
asked for it, and so is anything a background or cron run found. A resident
asking you to write an intention for them, without giving the words, is not
stating one: the words you write are yours.

Examples:

- "Based on what you know about me, make me an intent." → `ambient`: the words
  would be yours.
- "Generate an index intent for me." → `ambient`.
- "Suggest an intent I could post." → `ambient`.
- "Can you write me an intent about Solana founders in Goa?" → `ambient` when
  you write "Meet founders building on Solana in Goa": "meet" and "building"
  are yours.
- "Write me an intent: founders building on Solana in Goa." → `message` when
  you record "Founders building on Solana in Goa": every word is theirs.
- "Yes, that's right." after you showed your words → record nothing new: a yes
  does not make your words theirs, and the card already asks them
  (action=confirm checks their answer).
- "Main Goa mein Solana par kaam karne wale founders se milna chahta hoon."
  recorded in English → `ambient`: the translation is yours.
- "Ravi says he's looking for a cofounder in Goa." → record nothing: the words
  and the want are Ravi's, unless they say the want is theirs.
- After that, "Yes, that's what I want too: I'm looking for a cofounder in
  Goa." → `message`: now the want and the words are theirs.
- If, asked whether Ravi's want is theirs, they only say "Yes." → `ambient`:
  the want is theirs, but the words you record are not.
- "I want to meet founders building on Solana in Goa." → `message`: record
  "Meet founders building on Solana in Goa" and it publishes.
- A setup answer, "I'm here to find people working on climate hardware." →
  `onboarding`.
- A line in their notes, "find a surf buddy for early mornings in Goa" →
  `note`.

## Show the words you recorded

In conversation, when the words are yours, capture them with `source=ambient`,
then in your reply show the intention in one or two lines, exactly as you
recorded it, and tell them what the tool answered (normally that it is waiting
for their approval on the card); do not ask for a yes in chat, and a yes in
chat does not make the words theirs. If they then say the want in their own
words, withdraw the held one and capture their words with `source=message`.

## Ambient intentions are held

An ambient intention is never published on your word. It is recorded locally
and stays off Index until the resident approves it in their approval channel.
Where that channel is set up, the tool sends them the request itself when you
capture, with the words you recorded, and publishes once they approve; you do
not need to ask them in chat as well. A yes you read in chat is not an
approval. Something you inferred that is personal is the exception: capture it
with `publish=false` and `reason=personal`, and it stays local and is never sent
for approval.

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
