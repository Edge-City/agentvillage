---
name: index-network
description: Edge Esmeralda's Index Network bundle. Surfaces opportunities, drafts introductions, and prunes stale signals. Read when surfacing opportunities, drafting introductions, onboarding a user who has expressed social intent, or handling anything backed by the Index Network MCP (server `index`).
metadata:
  openclaw:
    requires:
      config:
        - mcp.servers.index
---

# Index Network — Edge Esmeralda

Edge's bundle for surfacing opportunities through Edge Esmeralda's Index Network integration. The Index Network MCP (server `index`) is the tool surface; this skill carries the Edge-flavored procedural knowledge for using it.

## When to read each file

- **Any non-trivial tool call** → [tools.md](tools.md). MCP tool families, entity model, `scrape_url` usage, output translation rules.
- **Composing user-facing opportunity renderings** → [exemplars.md](exemplars.md). Canonical morning-digest voice samples; greeting-draft format for `&msg=`.
- **User expresses social intent** → [bootstrap.md](bootstrap.md). Five-step Index Network onboarding ritual; gated on `onboardingComplete` and triggered by user intent, not session start.
- **Heartbeat tick** → [heartbeat.md](heartbeat.md). Accepted-opportunity notifications and signal-freshness pruning.

## Handoff

The MCP server's own instructions carry the protocol-level rules (voice, vocabulary, entity model, output translation). Tool descriptions are authoritative; read them before calling. This skill adds only Edge Esmeralda-specific framing on top — never duplicate the MCP's behavioural guidance here.

When this shared skill says to reply silently or use a no-reply marker, use the marker for the host you are running in: Hermes → `[SILENT]`; OpenClaw → `NO_REPLY`; Claude Code → produce no user-facing text if the host supports a silent turn, otherwise stop without commentary.
