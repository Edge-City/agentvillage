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
conversation (`source=message`), during onboarding (`source=onboarding`), and
in a background memory pass (`source=ambient`). Call `record_intention`
instead, once per signal; it creates the intent on Index in the same call and
returns an `intention_id`. Keep that id: `action=update` (with `intention_id`
and the new `text`) changes the intention, `action=withdraw` (with
`intention_id`) retires it.

Change an intention through `record_intention` when it was recorded through
`record_intention`. An intention it did not record (made in the Index app, or
before the tool was switched on) is not changed on Index by `action=update`,
and may be changed with Index's own `update_intent` or `index_update_intent`.

## Publish by default

Explicit intents (source message, onboarding or note) are published to Index by default. The two legitimate reasons an explicit intent stays local: the resident asked, or the content is personal.

Only in those two cases pass `publish=false`, with `reason=participant_asked`
or `reason=personal`. Any other `publish=false` is refused.

## Source

- `message`: the resident told you in conversation.
- `onboarding`: they answered it during setup.
- `note`: their own words, captured in their notes.
- `ambient`: you inferred it, from conversation or notes they did not write as
  a request, or a background or cron run found it.

## Ambient intentions are held

An ambient intention is never published on your word. It is recorded locally
and stays off Index until the resident approves it in their approval channel.
Where that channel is set up, the tool sends them the request itself when you
capture, with the words you recorded, and publishes once they approve; you do
not need to ask them in chat as well. A yes you read in chat is not an
approval.

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
