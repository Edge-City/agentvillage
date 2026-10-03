---
name: index-network
description: Edge City India's Index Network bundle. Surfaces opportunities, drafts introductions, and prunes stale signals. Read when surfacing opportunities, drafting introductions, when the user wants to meet people, or handling anything backed by the Index Network MCP (server `index`).
metadata:
  openclaw:
    requires:
      config:
        - mcp.servers.index
---

# Index Network — Edge City India

Edge's bundle for surfacing opportunities through Edge City India's Index Network integration. The Index Network MCP (server `index`) is the tool surface; this skill carries the Edge-flavored procedural knowledge for using it.

## When to read each file

- **Any non-trivial tool call** → [tools.md](tools.md). MCP tool families, entity model, capturing new signal from conversation, output translation rules.
- **Composing user-facing opportunity renderings** → [exemplars.md](exemplars.md). Canonical morning-digest voice samples.

Read `get_my_profile` only to use the profile that already exists. Call `update_my_profile` only when they explicitly correct a field. A new want and a question about who is waiting both follow [tools.md](tools.md). The welcome in `AGENTS.md` is a separate first-message greeting. Do not send it again from here.

## Handoff

The MCP server's own instructions carry the protocol-level rules (voice, vocabulary, entity model, output translation). Tool descriptions are authoritative; read them before calling. This skill adds only Edge City India-specific framing on top — never duplicate the MCP's behavioural guidance here.

When this shared skill says to reply silently or use a no-reply marker, use the marker for the host you are running in: Hermes → `[SILENT]`; OpenClaw → `NO_REPLY`; Claude Code → produce no user-facing text if the host supports a silent turn, otherwise stop without commentary.
