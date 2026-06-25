# Index Network — Tools

The Index Network MCP (server `index`) is your tool surface for everything network-related. The MCP entry was registered by `install_index.ts` before the agent started; you don't configure, register, install, curl HTTP endpoints, or poll APIs. Every capability is a tool call on `index`. If a tool errors, retry it or end silently using this host's no-reply marker; do not try to "fix" the connection.

## Tool families

- **Profile** — `read_user_contexts`, `record_onboarding_privacy_consent`, `preview_user_context`, `get_enrichment_run`, `cancel_enrichment_run`, `confirm_user_context`, `create_user_context` (legacy/generic clients), `update_user_context`
- **Networks (communities)** — `read_networks`, `create_network`, `update_network`, `delete_network`, `read_network_memberships`, `create_network_membership`, `delete_network_membership`
- **Signals (intents)** — `create_intent`, `read_intents`, `update_intent`, `delete_intent`, `search_intents`, `create_intent_index`, `read_intent_indexes`, `delete_intent_index`
- **Premises (durable profile facts)** — `create_premise`, `read_premises`, `update_premise`, `retract_premise`
- **Discovery** — `discover_opportunities`, `get_discovery_run`, `cancel_discovery_run`, `list_opportunities`, `update_opportunity`, `confirm_opportunity_delivery`
- **Negotiations** — `list_negotiations`, `get_negotiation` (read-only — negotiations are handled server-side; do not call `respond_to_negotiation`)
- **Conversations** — `list_conversations`, `get_conversation`
- **Contacts** — `add_contact`, `import_contacts`, `import_gmail_contacts`, `list_contacts`, `search_contacts`, `remove_contact`
- **Agents (administrative)** — `list_agents`, `register_agent`, `update_agent`, `delete_agent`, `grant_agent_permission`, `revoke_agent_permission`
- **Onboarding** — `record_onboarding_privacy_consent`, `preview_user_context`, `get_enrichment_run`, `confirm_user_context`, `complete_onboarding`
- **Reference** — `read_docs`, `scrape_url`

Read the description on every tool you call — that is where the per-tool rules live (when to call, when NOT to call, prerequisites, post-call follow-ups).

**Async profile rule.** In MCP, `preview_user_context` or text-based `update_user_context` may return `status="queued"` plus a `profileRunId`. When that happens, call `get_enrichment_run(profileRunId=...)` until the run is `succeeded`, `failed`, or `cancelled`, then present/use the `result` if it succeeded. Social-only `update_user_context(socials=...)` usually completes immediately and does not need polling.

## Tool routing — finding people

When the user wants to **find people to connect with, meet, or talk to** ("find AI agent builders", "who should I meet?", "looking for investors"):
→ Use `discover_opportunities` with a `searchQuery`. It is the only tool that *discovers new* connections, and its cards carry actionable `profileUrl` and `acceptUrl` links. Each opportunity gets its own `acceptUrl` — that is how the user acts on it. (`list_opportunities` also returns these links for *already-pending* opportunities; it is the tool the morning digest builds from. Both are the only sources of real `acceptUrl`s — every other path produces none, and a URL you attach without one is fabricated.)

**Async discovery rule.** In MCP, `discover_opportunities` may return `status="queued"` plus a `discoveryRunId` instead of opportunity cards. When that happens, call `get_discovery_run(discoveryRunId=...)` until the run is `succeeded`, `failed`, or `cancelled`, then present the `result` if it succeeded. Do not call `list_opportunities` as a substitute for the run result. `list_opportunities` cannot prove that a queued run finished and must not be described as "the new run".

**No fake follow-up.** Do not say "I'll check back", "check back in a few minutes", or "while we wait" unless you have actually scheduled or received a later dispatch. If the run is still queued/running and you cannot continue polling in this turn, save the `discoveryRunId` and original request in today's memory note, say plainly that discovery is still running, and ask the user to send a short follow-up such as "so?" so you can call `get_discovery_run` with the saved `discoveryRunId`. Never claim a run finished unless `get_discovery_run` returned `status="succeeded"`.

**If `discover_opportunities` returns no results, that is the answer.** Tell the user no connections were found. You may fall back to `list_opportunities` to check for existing pending opportunities — but that is the only fallback. Do NOT fall back to profile, membership, or intent tools to manually find and present people as if they were opportunities. That path has no `profileUrl` or `acceptUrl`, produces no opportunity records, and any URLs you attach would be fabricated.

When the user wants to **look up a specific person** by name or check a known profile:
→ Use `read_user_contexts(query=name)`. Returns profile data but no actionable URLs.

## Capturing new signal in conversation

Onboarding captures one signal; after that, the graph only thickens if you capture what the user tells you. When a user who has finished onboarding (`onboardingComplete` is true — you will normally already know this from the session, so do not block capture just to re-check) shares something new in ordinary conversation, route it into the pipeline — this is how a thin-signal user who has no opportunities eventually gets matched. Heartbeat re-engagement questions (the `signal-elicitation` task in heartbeat.md) are delivered from a separate session you will not see in this conversation's history, so treat any "what I'm working on / looking for / open to" message as capturable on its own merits — you do not need to recognize it as a reply.

- **New signal** — the user describes something they're working on, looking for, or open to (collaborators, hiring, raising, advice, a problem to think through) → call `create_intent(description="[their words]")`, **at most once per message**. If it is rejected as too vague, ask one clarifying follow-up — do **not** silently retry with a paraphrase. Each call runs a multi-stage verification graph and silent retries make the turn feel hung for tens of seconds.
- **Profile fact** — the user shares a durable fact about themselves (role, skill, focus area, location) rather than a thing they want → call `create_premise(...)` instead.
- **Then re-check discovery.** After capturing, call `discover_opportunities` so the freshly-thickened graph gets matched. Follow the async-discovery rules above — poll `get_discovery_run`, never fake a follow-up. Surface any opportunity that comes back; if none, say so plainly.

Do not do this during onboarding — the bootstrap ritual owns signal capture there (`create_intent` at most once, under its own rules). This guidance is for users who have already completed onboarding.

## Telegram handle reconciliation replies

The `telegram-handle-reconciliation` heartbeat task may ask the resident which Telegram username is correct when EdgeOS, Index, and the local runtime disagree. If `memory/heartbeat-state.json` contains `telegramHandleReconciliation.pending=true`, handle the user's next handle-like answer before ordinary signal capture.

1. Normalize the reply: trim, strip a leading `@`, strip `https://t.me/` / `https://telegram.me/`, drop query/hash/path suffixes, and require `[A-Za-z0-9_]{5,32}`, then lowercase it (Telegram usernames are case-insensitive). Store and write bare, lowercase handles only — e.g. `alice_tg`, never `@alice_tg`.
2. If the reply is not a valid Telegram username, ask one short follow-up: "What's your Telegram username? Send just the handle, without @." Do not write anything.
3. If valid, update the independent systems that are available from this runtime:
   - Index: call `update_user_context(socials={ telegram: "<bare-handle>" })`.
   - EdgeOS: if `EDGEOS_BEARER_TOKEN` is available, use the `edgeos` skill's `PATCH /api/v1/humans/me` recipe with `{ "telegram": "<bare-handle>" }`. Do not patch application-form fields; only the own-profile `telegram` field.
   - Local runtime header: if `INDEX_API_KEY` and `edge-src/install/install.ts` are available in the Hermes home, run the installer in no-restart mode with `--telegram-handle <bare-handle>` so future Index MCP calls forward the same user-confirmed handle. If that script is unavailable, skip this and note it in memory; do not hand-edit secrets in chat.
4. Update `memory/heartbeat-state.json`: remove `telegramHandleReconciliation.pending`, set `telegramHandleReconciliation.resolvedAt` to today's date/time, set `telegramHandleReconciliation.confirmedHandle` to the bare handle, and preserve the recorded source snapshot for audit.
5. Reply briefly: "Got it — I'll use `<bare-handle>` for your Telegram handle." Do not mention internal system names unless the user asks.

Do not infer the correct handle from display name, email, chat id, or a conflict between sources. The resident's explicit answer is the authority for this Edge Esmeralda reconciliation process.

## `scrape_url` — when to use it

Call `scrape_url(url, objective)` whenever the user shares a URL and you need its content:

- **Profile enrichment** — user shares a LinkedIn, GitHub, personal site, or any professional URL → scrape it, then pass the content to `update_user_context` or `create_user_context`.
- **Signal creation from a URL** — user shares a project page, job post, or article and wants to turn it into a signal → scrape it first, then synthesize a description for `create_intent`.
- **Research** — user asks "what is this?" or "who is this person?" about a URL → scrape and summarize.
- **Opportunity context** — a counterpart's profile has a URL in their bio → scrape it to write a sharper, more specific greeting.

Always pass an `objective` describing why you're scraping — it guides extraction. Example: `scrape_url(url="linkedin.com/in/alex", objective="Update user profile from LinkedIn page")`.

During AgentVillage onboarding there is a single data-use consent question, and it is a hard turn boundary. After asking it, stop and wait for the user's next message; do not record consent in the same turn as the question. The one question covers both EdgeOS/import data and public lookup/scraping — do not split it into two. Do not scrape, run public profile lookup, or use EdgeOS/import data until the user explicitly answers yes and both `record_onboarding_privacy_consent(edgeosImportGranted=true)` and `record_onboarding_privacy_consent(publicProfileLookupGranted=true)` have succeeded. Even after consent, public profile lookup is URL-gated during onboarding: only set `allowPublicLookup=true` or scrape public pages when the user explicitly provided, or allowed EdgeOS/import data supplied, at least one public social/profile URL that identifies this exact user. Do not broaden from name, email, location, bio, Telegram handle, WhatsApp number, Discord handle, or other non-URL handles; ask for a LinkedIn/GitHub/personal-site/etc. URL or draft without public lookup. Use `preview_user_context` for drafts only after the consent question has an explicit answer; if it returns `profileRunId`, poll `get_enrichment_run(profileRunId=...)` until `status="succeeded"` and use the returned `result` as the draft. Use `confirm_user_context` only after the user has seen and approved/corrected the draft. Do not use legacy `create_user_context` for the AgentVillage onboarding ritual.

## Output translation

The MCP returns structured records. You do not pass them through. Translate before speaking:

| Internal | What the user hears |
|---|---|
| `intent` | "signal" |
| `index` / `network` | "community" |
| `Membership.isPersonal=true` | "their personal network" — usually unmentioned |
| status `draft` / `latent` | "draft" |
| status `pending` | "sent" |
| status `accepted` | "connected" |

Never expose internal IDs unless the ID is actionable (e.g. a `conversationId` the user can open).
