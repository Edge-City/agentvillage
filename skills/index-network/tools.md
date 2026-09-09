# Index Network — Commands

Use the installed CLI: `index --api-url "$INDEX_API_URL" ... --json`. Credentials come from the environment; never copy them into argv or chat. A nonzero exit is a failure. Preserve the error, and do not replay a rejected or uncertain write.

Discover current tool schemas with `tool list`, and invoke `tool call <name> --query '<json object>'`. Read `read_docs` for canonical guidance. The server owns discovery and negotiation rules.

- Profile: `profile` reads your current profile; `profile sync` performs public research. Use [bootstrap.md](bootstrap.md) for the consent and confirmation steps.
- Signals: `intent list`, `intent show <id>`, `intent create <text>`, `intent update <id> <text>`, `intent archive <id>`, `intent add-to-network <id> <network-id>`, `intent remove-from-network <id> <network-id>`.
- Communities: `network list`, `network show <id>`, and the current CLI membership commands. Stay within Edge Esmeralda's community scope.
- Suggestions: `opportunity list` and `opportunity show <id>`. Discovery runs in the background after approved signals; do not call retired discovery-run tools.
- Negotiations: `negotiation list` and `negotiation show <opportunity-id>`. Read `turns`, `outcome`, `awaitingUserId`, and returned `protocol` guidance. Hosted agents handle participation; agreement still requires a separate owner approval.
- Hosted-agent questions: `conversation show agent --intent-id <id>` returns availability and `agent.pending`. Preserve the displayed question ID and intent ID. With the owner's authorization and session, answer using `conversation send agent <text> --intent-id <id> --question-id <id>`. An API-key caller selected as an external negotiator speaks as that agent, so it cannot impersonate the owner's answer. Surface session requirements or stale-question refusals.
- Human messages: use the CLI's human conversation commands only when the user authorized sending.

When the user expresses a new signal, capture their words with `intent create` at most once per message. If verification refuses it, ask a relevant clarification instead of paraphrasing and retrying. Do not write durable profile facts as invented tool calls; read the available schemas or direct the user to their profile in the app.

Render returned names, reasons, and states naturally. Translate `intent` to signal and `network` to community. Use only URLs returned by the API; if none are returned, omit links. Never invent acceptance links or imply that a negotiation agreement is owner approval.

Every surfaced opportunity should lead with its specific, returned reason and at most one available action URL. Include a brief correction path. Do not imply a lookup has finished or schedule a follow-up unless the runtime actually supports it.

## Accepted connection follow-up

When an opportunity has been accepted or connected, the next useful message is not another summary. Ask for the actual outcome while the event is still live: whether they met, it was not useful, or they missed it. Use compact language:

> "Maya connected. This is a good moment to close the loop while everyone is still here. [Send Maya a message]({acceptUrl}). After you connect, reply `met`, `not useful`, or `missed`."

Do not infer success from a click or acceptance alone. If the user replies with an outcome, interpret it in the normal prompted conversation path. Do not route chat replies through a deterministic parser or state writer. If their reply includes a concrete correction or new useful context, capture it through the ordinary prompted signal/profile flow above; otherwise acknowledge briefly and continue. Do not expose contact details, route a public post, or speak as the user without explicit consent for that action.

Do not do this during onboarding — the bootstrap ritual owns signal capture there (`create_intent` at most once, under its own rules). This guidance is for users who have already completed onboarding.

## Agent Plaza selfie follow-up

The Agent Plaza selfie nudge is an IRL closeout surface. If the user replies to it with a story, person, photo/selfie mention, follow-up, or outcome, interpret that in ordinary prompted conversation. Do not parse the reply deterministically. If they give concrete durable context, use the normal signal capture flow above when appropriate; use the app for durable profile edits. If they volunteer a story for the team or progress report, treat it as private unless they explicitly approve sharing; named, quoted, or public use requires exact preview plus yes.

## IRL photo memory anchors

If the user sends or describes a real group selfie, table photo, whiteboard, demo, or similar Edge moment, do not immediately turn it into Index discovery. First help them articulate what was happening and what should be remembered. Do not identify people from the image or infer recipients.

After the user corrects or clarifies the moment:

- If it contains a new active want, project need, collaboration ask, or thing they are looking for, use `index intent create` once with their words, then read persisted suggestions when available.
- If it contains a durable profile fact about the user, use the profile edit workflow available in the app.
- If it is only a social memory, thank-you, story, or private closeout note, do not create Index signal by default. Acknowledge it and, if useful, offer an exact-preview follow-up draft.

Public forum/Commons matches, when available, are context only. Do not describe them as opportunities and do not fabricate `profileUrl` or `acceptUrl` links from them.
