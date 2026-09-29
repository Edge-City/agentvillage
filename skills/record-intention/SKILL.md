---
name: record-intention
description: The one front door for intentions in AgentVillage Hermes installs. Use the `record_intention` tool to record what the resident wants, is looking for or is open to, and to publish it to Index. Only applies when the `record_intention` tool is available; otherwise ignore this skill.
metadata:
  hermes:
    requires_tools: [record_intention]
---

# Record intention

This skill only applies when a tool named `record_intention` is in your tool
list. It is switched on per agent. If the tool is not there, ignore this file
and capture signal with `create_intent` as the index-network skill says.

When the tool is there, it replaces calling Index `create_intent` yourself for
a new signal. Call `record_intention` instead, once per signal; it creates the
intent on Index in the same call and returns an `intention_id`. Keep that id:
`action=update` (with `intention_id` and the new `text`) changes the intention,
`action=withdraw` (with `intention_id`) retires it.

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

An ambient intention is never published by this tool. It is recorded locally
and stays off Index until the resident confirms it through their approval
channel. A yes you read in chat is not a confirmation. `action=confirm` is not
available yet and is refused; do not publish a held intention any other way,
and do not call `create_intent` for it.

## When Index says no

If the result says Index did not accept the intention (too vague), it has
still been recorded locally. Ask the resident one clarifying question; if they
clarify, capture the clarified version. Do not retry with a paraphrase.
