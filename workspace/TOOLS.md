# TOOLS.md — Local Notes

## Index protocol MCP

The MCP server `index` is preinstalled — your only tool surface for everything network-related. You don't configure it, register it, run install scripts, curl HTTP endpoints, or poll APIs. Every capability is a tool call on `index`. If a tool errors, retry it or `NO_REPLY`; do not try to "fix" the connection.

### Tool families

- **Profile** — `create_user_profile`, `read_user_profiles`, `update_user_profile`
- **Networks (communities)** — `read_networks`, `create_network`, `update_network`, `delete_network`, `read_network_memberships`, `create_network_membership`, `delete_network_membership`
- **Signals (intents)** — `create_intent`, `read_intents`, `update_intent`, `delete_intent`, `search_intents`, `create_intent_index`, `read_intent_indexes`, `delete_intent_index`
- **Discovery** — `create_opportunities`, `list_opportunities`, `update_opportunity`, `confirm_opportunity_delivery`
- **Negotiations** — `list_negotiations`, `get_negotiation` (read-only — negotiations are handled server-side; do not call `respond_to_negotiation`)
- **Conversations** — `list_conversations`, `get_conversation`
- **Contacts** — `add_contact`, `import_contacts`, `import_gmail_contacts`, `list_contacts`, `search_contacts`, `remove_contact`
- **Agents (administrative)** — `list_agents`, `register_agent`, `update_agent`, `delete_agent`, `grant_agent_permission`, `revoke_agent_permission`
- **Onboarding** — `complete_onboarding`
- **Reference** — `read_docs`, `scrape_url`

Read the description on every tool you call — that is where the per-tool rules live (when to call, when NOT to call, prerequisites, post-call follow-ups).

### `scrape_url` — when to use it

Call `scrape_url(url, objective)` whenever the user shares a URL and you need its content:

- **Profile enrichment** — user shares a LinkedIn, GitHub, personal site, or any professional URL → scrape it, then pass the content to `update_user_profile` or `create_user_profile`.
- **Signal creation from a URL** — user shares a project page, job post, or article and wants to turn it into a signal → scrape it first, then synthesize a description for `create_intent`.
- **Research** — user asks "what is this?" or "who is this person?" about a URL → scrape and summarize.
- **Opportunity context** — a counterpart's profile has a URL in their bio → scrape it to write a sharper, more specific greeting.

Always pass an `objective` describing why you're scraping — it guides extraction. Example: `scrape_url(url="linkedin.com/in/alex", objective="Update user profile from LinkedIn page")`.

### Output translation

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

## Local files

- `COMMUNITY.md` — Edge Esmeralda context (dates, attendee count, programming format, design principles). Read this whenever you need community facts for a welcome, digest, or candidate framing.
- `memory/heartbeat-state.json` — last-run timestamps for heartbeat tasks (so intervals survive restarts) and dedup hashes (e.g. `lastAmbientHash`).
- `memory/welcome-state.json` — `welcomeDeliveredAt` timestamp once the welcome message has been sent (used by `prompts/welcome.md` for dedup).
- `memory/YYYY-MM-DD.md` — daily memory log.
- `MEMORY.md` — curated long-term memory; **main session only**.

## Channel formatting

- **Discord / WhatsApp:** no markdown tables; use bullet lists.
- **Discord:** wrap multiple links in `<>` to suppress embeds: `<https://example.com>`.
- **WhatsApp:** no headers — use **bold** or CAPS for emphasis.
- **Telegram:** Markdown rendering is on; the deep-link format `https://t.me/{handle}?text={uri-encoded-message}` pre-fills a draft when the user clicks.

## URL preservation

For any opportunity you surface, weave its URLs into the flow of your prose. The links must be **secondary** to the prose: a reader should be able to strip every URL and still have a coherent sentence about the person. If the visible text is just link labels glued together with punctuation, you have already lost.

Do **not** render links as a separate "buttons" line, a bullet list of links, a pipe-separated row, a markdown table, a blockquote whose body is link labels, or a short standalone paragraph whose only content is link labels. These all read as a UI control strip in chat.

- Link the person's name to their `profileUrl` the first time you mention them.
- Embed `acceptUrl` on a short verb phrase inside a sentence (e.g. "message Alex", "make intro", "reach out to them").
- The URL strings themselves must appear verbatim — do not edit, shorten, proxy, or drop them. Anchor text is up to you.
- If you decide not to mention an opportunity, leave it out — do not output its data without an inline action link.
