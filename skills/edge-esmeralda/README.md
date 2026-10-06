# Edge Esmeralda 2026 (previous popup) — Agent Skill

> Edge Esmeralda 2026 was an earlier Edge City popup. The current event is Edge City India (Mandrem, Goa, Oct 11 – Nov 1 2026); agents treat this skill as past background only and never present its content as current.

A skill that gives AI agents popup-specific knowledge for Edge Esmeralda 2026: popup constants (popup id, week dates, themes), attendee-directory field semantics, and the curated wiki / website / newsletter knowledge base.

For backend-agnostic EdgeOS API recipes (events, RSVPs, venues, the directory endpoint itself, your own profile), pair this with the sibling `../edgeos/` skill. For Index Network discovery, pair with `../index-network/`.

## For Users (Attendees)

**Download [`SKILL.md`](./SKILL.md)** and add it to your agent's skill/context alongside `../edgeos/SKILL.md`:

- **Claude Code**: copy both files to `~/.claude/skills/edge-esmeralda/SKILL.md` and `~/.claude/skills/edgeos/SKILL.md` respectively.
- **OpenClaw / Hermes / NanoClaw**: add to your agent's skill directory.

Set environment variables when pairing this skill with live API skills. `edge-esmeralda` itself does not read environment variables:
```bash
export EDGEOS_API_KEY="eos_live_..."      # Long-lived automation key for events, RSVPs, venues
export EDGEOS_BEARER_TOKEN="..."          # Human session JWT for directory, own profile
```

## For Maintainers

This repo contains the indexer that keeps the skill's reference content fresh.

### Setup
```bash
bun install
```

### Run indexer
```bash
bun run scripts/index.ts
```

This fetches and preprocesses content from:
- **Notion wiki** (Edge Esmeralda 2026 Wiki) → `references/wiki-content.md`
- **Edge City website** (edgecity.live) → `references/website-content.md`
- **Substack newsletter** (edgeesmeralda2026.substack.com) → `references/newsletter-digest.md`

The committed `references/` are a frozen snapshot from 2026-10-01: the upstream indexer now serves Edge City India, and `Edge-City/agentvillage`'s sync workflow writes only to `../edge-india/references/`. Local runs are only needed if this snapshot has to be regenerated.

### Data Sources

| Source | Type | Auth | Status |
|--------|------|------|--------|
| Notion Wiki | Preprocessed | None (public) | Live |
| Edge City Website | Preprocessed | None | Live |
| Substack Newsletter | Preprocessed | None | Live |

For live EdgeOS API data sources (events, attendees, venues), see the `edgeos` skill's `SKILL.md` and its accompanying recipes.

## When updating `SKILL.md`

- Bump the `version` field in `SKILL.md` frontmatter (semver: patch for content tweaks, minor for new sections, major for breaking the cross-skill contract with `edgeos`/`index-network`).
- Keep additions scoped to popup-specific content. EdgeOS API recipes belong in `../edgeos/`; semantic discovery belongs in `../index-network/`.
- If your update touches an env var the user must set, update the Setup section in this README too.
