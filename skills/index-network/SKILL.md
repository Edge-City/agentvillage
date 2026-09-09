---
name: index-network
description: Edge Esmeralda's Index Network bundle. Surfaces opportunities, drafts introductions, and prunes stale signals. Read when surfacing opportunities, drafting introductions, onboarding a user who has expressed social intent, or handling anything backed by the Index CLI.
---

# Index Network — Edge Esmeralda

Edge's bundle for surfacing opportunities through Edge Esmeralda's Index Network integration. The Index CLI is the tool surface; this skill carries the Edge-flavored procedural knowledge for using it.

Use `index --api-url "$INDEX_API_URL" ... --json` for every command. The installer sets the API origin and `INDEX_API_KEY` in the environment and provisions CLI 0.24.0. Discover tools with `index tool list`; read current guidance with `index tool call read_docs --query '{}'`. Never replay rejected or uncertain writes.

## When to read each file

- **Any non-trivial tool call** → [tools.md](tools.md). CLI commands and tool schemas, entity model, capturing new signal from conversation, `scrape_url` usage, output translation rules.
- **Composing user-facing opportunity renderings** → [exemplars.md](exemplars.md). Canonical morning-digest voice samples; greeting-draft format for `&msg=`.
- **User expresses social intent** → [bootstrap.md](bootstrap.md). Explicit profile confirmation and first-signal onboarding; gated on server prerequisites and triggered by user intent, not session start.
- **Heartbeat tick** → [heartbeat.md](heartbeat.md). Accepted-opportunity notifications, signal-freshness pruning, and signal-elicitation re-engagement for thin-signal users.

## Handoff

The `read_docs` tool's canonical instructions carry the protocol-level rules (voice, vocabulary, entity model, output translation). Tool descriptions are authoritative; read them before calling. This skill adds only Edge Esmeralda-specific framing on top — never duplicate the protocol's behavioural guidance here.

When this shared skill says to reply silently or use a no-reply marker, use the marker for the host you are running in: Hermes → `[SILENT]`; OpenClaw → `NO_REPLY`; Claude Code → produce no user-facing text if the host supports a silent turn, otherwise stop without commentary.
