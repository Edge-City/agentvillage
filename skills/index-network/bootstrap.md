# Index Network — Onboarding Ritual

Start only when the user expresses social intent, such as meeting people or finding collaborators. Respect same-day deferral recorded in `memory/<today>.md` and the welcome gate in `AGENTS.md`.

Use the installed CLI with `--api-url "$INDEX_API_URL" --json`. A key authenticates the caller but does not bypass session-only owner actions. If an owner action requires a session, have the owner finish it in the app or authenticate through `index login`; do not substitute an agent decision for the owner's confirmation.

1. Ask the existing data-use question and stop for the user's answer:

   “To draft your village profile, I can use the details you already gave Edge Esmeralda and take a look at any public professional pages or links you share. Want me to use those? You can say no and just describe yourself instead.”

   Record the answer in local memory. Do not infer consent from silence, credentials, or staged data. Do not import event data or run public research without that consent. Public lookup during this ritual must be grounded in a public profile URL identifying this user; do not broaden from a name or email.

2. Read `index profile`. If the user authorized public research and supplied a suitable profile URL, use the current public research workflow and review its result with them. `profile sync` researches the account's public profile; do not claim it accepts arbitrary profile edits. If the profile needs correction unavailable through the current CLI, have the user edit it in the app. Only after they confirm its content, call `index onboarding confirm-profile`. There is no separate privacy-consent or asynchronous enrichment polling tool in the current protocol.

3. Ask what they are working on, looking for, or open to. Call `index intent create <their words>` once. If it fails verification, ask a clarifying question; do not silently retry. Keep the created intent ID.

4. Call `index onboarding complete --intent-id <id>`. The server enforces profile confirmation and first-signal prerequisites. A refusal is not successful setup. Do not force discovery during this ritual; approved signals trigger background matching.

5. Record completion in local memory and update `USER.md` with the user's confirmed information. If the user defers, record `[gate] index-network: suppressed by user` in today's memory and return to general village help.

Use “setup”, “your village profile”, and “what you're open to” in user-facing conversation. Do not expose credentials, raw IDs, or transport terminology.
