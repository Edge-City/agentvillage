# Edge City India 2026 — Village Knowledge Skill

Public village knowledge for the current event, Edge City India (Mandrem, North Goa, Oct 11 – Nov 1 2026): housing, arrival, check-in, meals, venues, families, tickets, residencies and programming background, answered from the official wiki, Substack guides and website with source links and dates. The agent-facing file is [`SKILL.md`](./SKILL.md) (skill name `edge-india-2026`).

Live data stays with the existing skills: today's events, RSVPs and cancellations come from `../edgeos/`, people and intros from `../index-network/`. `../edge-esmeralda/` is the previous popup and is never used for India.

## What's here

| Path | What | Edited by |
|---|---|---|
| `SKILL.md` | Routing, answer rules, topic → document table | hand |
| `references/` | The generated reference tree: `index.md`, `manifest.json`, `wiki-content.md`, `website-content.md`, `newsletter/*.md`, `residencies/*.md`, `website/about.md`, plus `SNAPSHOT.json` (upstream commit and date, when it was copied, each file's sha256) | `scripts/sync-india-references.ts` only |
| `scripts/refs.ts` | What the agent runs: `status`, `list`, `search <words>`, `read <path> [--section …]` | hand |
| `scripts/tests/` | `bun test skills/edge-india/scripts/tests` (also run by `.github/workflows/test.yml`) | hand |

## Where the content comes from

`aromeoes/edge-agent-skill` generates the references. Its indexer reads an allowlist of public sources only (the India wiki, the Substack and the website) and excludes housing sheets, forms, portals and Telegram history. Content changes belong there; this repo only copies its output.

## How fresh is it: the full path

| Step | Cadence | What can go wrong | How you see it |
|---|---|---|---|
| 1. Organizers edit the wiki, Substack or website | any time | | |
| 2. Upstream indexer regenerates `references/` and commits | every 15 min, best effort; commits only on change | a source blocks the runner or the run fails; the last good files stay | upstream Actions tab; `content_last_changed_upstream` per document |
| 3. `.github/workflows/sync-edge-india-references.yml` here copies a complete, India-scoped tree to `references/` on `main` | every 15 min; commits only on change | an incomplete or non-India tree is refused and the last snapshot stays | this repo's Actions tab (a red run); `SNAPSHOT.json` |
| 4. A resident's agent gets the snapshot | at the next tag and roll (`docs/deployment.md`) | nothing changes on running agents until a roll | `refs.ts status` (`copy_taken`) |
| 5. Optional live refresh on the agent | at most every `AV_INDIA_REFS_TTL_MINUTES` (30) when `AV_INDIA_REFS_LIVE=1` | offline, timeout or a bad hash keeps the last copy on disk, and the output says the refresh failed | `refs.ts status` (`last_refresh_*`) |

Without step 5, a resident's knowledge is exactly the snapshot of their agent's release tag. The agent always sees `copy_taken` and a STALE marker after `AV_INDIA_REFS_STALE_HOURS` (24) so it can say "as of" and link the source.

**Status on 2026-10-05:** the upstream indexer has failed every run since 2026-10-01 14:07 UTC (a Substack 403 is being diagnosed upstream), so its content, and this snapshot, date from 2026-09-30/10-01. Wiki edits made since (for example check-in and lunch details) are not in it until upstream runs again.

### Live refresh (opt-in)

`refs.ts` reads the mirror at `https://raw.githubusercontent.com/Edge-City/agentvillage/main/skills/edge-india/references` (override `AV_INDIA_REFS_BASE_URL`; only https on raw.githubusercontent.com is accepted). It fetches `SNAPSHOT.json`, downloads only the files whose sha256 changed, verifies each, and swaps the set into `$HERMES_HOME/cache/edge-india/current/` only when all of them verified. It reads whichever complete copy is newer, installed or cached. No new service, database or credential; the request is a public GET with a 5 second timeout.

Because the mirror is `main`, live refresh lets reference text change between release tags. That is the decision left to the release owner (below).

## Environment

| Variable | Default | Effect |
|---|---|---|
| `AV_INDIA_REFS_LIVE` | unset (off) | `1` turns on the live refresh above |
| `AV_INDIA_REFS_TTL_MINUTES` | 30 | minimum time between refresh attempts |
| `AV_INDIA_REFS_TIMEOUT_MS` | 5000 | per-request timeout |
| `AV_INDIA_REFS_STALE_HOURS` | 24 | copy age after which output is marked STALE |
| `AV_INDIA_REFS_BASE_URL` | the `main` mirror | another raw.githubusercontent.com path, e.g. a branch for a canary |

## Open decision

Whether hosted residents run with `AV_INDIA_REFS_LIVE=1`. Off (the default): reference text changes only at a roll, so research data ties to a tag, but residents can be a release behind the wiki. On: residents follow `main` within about an hour of an upstream change, and `refs.ts status` / each `read` header record which snapshot was read. Suggested path: on for the canary tenants first, then all.

## Maintainer commands

```bash
# Re-sync by hand from a local upstream checkout (the workflow does this on a schedule)
bun scripts/sync-india-references.ts --source ../edge-agent-skill --source-commit "$(git -C ../edge-agent-skill rev-parse HEAD)"

bun skills/edge-india/scripts/refs.ts status
bun skills/edge-india/scripts/refs.ts search housing riva
bun skills/edge-india/scripts/refs.ts read newsletter/housing-for-edge-city-india.md --section riva
```

When `SKILL.md` changes, bump its `version` and the four plugin manifests together (`../README.md`, "Contributing").
