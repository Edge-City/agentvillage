# `recall` — tenant-local memory recall (opt-in)

A search tool for the agent's own memory. It indexes, inside the attendee's
sandbox:

- daily notes, `memory/YYYY-MM-DD.md`
- long-term memory, `MEMORY.md`
- the owner's private conversations in the local Hermes session store
  (`$HERMES_HOME/state.db`, opened read-only)

and exposes one Hermes tool, `recall(query, since?)`, that returns dated
snippets with file and line references. SQLite FTS5 with BM25 ranking: no LLM,
no embeddings, no network, deterministic ordering. It is milestone 2 of the
retrieval proposal (backlog task DATA-83).

## Consent statement

**All data stays in the attendee's sandbox.** The index is built from files and
conversations that are already in the sandbox, is stored in the sandbox, and is
read only by the attendee's own agent. Nothing is uploaded, synced, or shared.
The only thing that leaves is one telemetry event per search, `memory.recalled`,
which carries a keyed hash of the query, the number of hits, the top score, and
which surface the search came from, and never the query, a snippet, or a
reference. That event goes through the existing `av-events` plugin under the
tenant's existing telemetry consent, and is not sent at all when that plugin is
off.

## What it never does

- Never runs in a group or shared chat. There the tool returns
  `{"status": "unavailable", "reason": "unavailable in group sessions"}` with no
  data, before the index is touched. `MEMORY.md` never loads in group sessions,
  and this tool keeps it that way. An unrecognised chat type counts as shared.
- Never writes under `memory/`. The index lives at `$HERMES_HOME/.recall/`, and
  the tool's result text must not be copied into notes (the skill tells the
  agent so): search results written into memory would come back as future
  search results.
- Never indexes drafts or ledgers. Only `memory/YYYY-MM-DD.md` is read from
  `memory/`; the legacy `digest-outgoing.md` draft and the JSON state files are
  skipped. Cron sessions (which hold the morning-brief drafts), group chats,
  subagent runs and tool output are excluded from the session side.
- Never calls a model or the network, and never receives credentials: the
  search process gets a short allowlist (`PATH`, `HOME`, `TZ`, locale,
  `HERMES_HOME`, the recall path overrides and the resolved chat type), and the
  query is passed on stdin so it does not show up in a process listing.
- Never runs by default. It is opt-in per tenant (below) and nothing in the core
  loop depends on it.

## Opt-in install

Hosted tenants: set `AV_RECALL_ENABLED=1` in the tenant's `.env`. The installer
runs on every container boot, and when it sees the flag it

1. stages this skill into `$HERMES_HOME/skills/recall/` (without tests or
   fixtures), and
2. adds `recall` to `plugins.enabled` in `config.yaml`.

`AV_RECALL_ENABLED=0` undoes both and deletes `$HERMES_HOME/.recall/` (the index
and its hash key: derived data only, the notes themselves are untouched). Unset
means not opted in, and the installer changes nothing.

Self-hosted Hermes: run the installer with `AV_RECALL_ENABLED=1`, or copy
`skills/recall/` to `~/.hermes/skills/recall/`, copy `plugins/recall/` to
`~/.hermes/plugins/recall/`, and run `hermes plugins enable recall`. Bun must be
on the gateway's `PATH` (it already is in hosted sandboxes).

`AV_RECALL_ENABLED=0` in the gateway's environment also works as a runtime kill
switch: the tool answers `unavailable` from the next call, without a restart.

`bun install/reset.ts` removes the skill; `--wipe-user` also removes the index.

## How it fits together

| Piece | Where | Does |
|---|---|---|
| Indexer and search | `skills/recall/scripts/recall.ts` (Bun, `bun:sqlite`) | Builds and queries the FTS5 index. CLI: `rebuild`, `query`. Refuses `query` itself in a group session (the chat type Hermes exports to terminal commands), so a terminal call cannot bypass the guard. |
| Hermes tool | `plugins/recall/` (Python) | Registers `recall` with `ctx.register_tool`, applies the group-session guard from the gateway's per-task session context, runs the CLI, publishes `memory.recalled`, and triggers a background rebuild on `on_session_finalize`. |
| Telemetry | `plugins/av-events/` | Subscribes to `recall:memory.recalled` on the Hermes plugin event bus and rebuilds the payload from four allowlisted fields. |

A Hermes skill is markdown and cannot register a callable tool: only a plugin
can (`PluginContext.register_tool` in `hermes_cli/plugins.py`). Hence a small
plugin next to the skill.

### Index

- `$HERMES_HOME/.recall/index.sqlite` (directory `0700`, file `0600`), WAL,
  `secure_delete` on, FTS5 `secure-delete` on, and an `optimize` merge after any
  removal, so deleted notes and sessions do not linger in free pages.
- Text is cut into chunks of consecutive non-blank lines (split at headings and
  every 12 lines). Tokeniser: `porter unicode61 remove_diacritics 2`.
- Dates: a daily note's date comes from its filename; a `MEMORY.md` chunk takes
  the first `YYYY-MM-DD` in its text or heading, else the file's modification
  date (`date_source: mtime`); a message takes its timestamp's local date.
- Incremental: a file whose mtime and size are unchanged is skipped on a stat; a
  touched file whose SHA-256 is unchanged is not re-chunked; a session is
  re-indexed only when its message count, last message id or total length
  changes. Removed files and sessions are purged.
- Rebuild runs (1) at the start of every `query`, so results are never stale and
  a restored or recreated sandbox rebuilds on first use; (2) in the background
  when a Hermes session finalises (single-flight, at most every 30 s); (3) on
  demand: `bun skills/recall/scripts/recall.ts rebuild`. A restore path that
  wants a warm index can run (3) after putting files back.
- The index is derived: if the file is not a usable database it is discarded
  and rebuilt.

### Search

Query words are lowercased and quoted (FTS5 operators in user text are inert).
All words are tried first (`match: "all"`), then any word (`match: "any"`).
Ordering is BM25, then date (newest first), then ref, then line. `hit_count` is
every matching chunk; `hits` is the top 8. `score` is `-bm25`, higher is better.

### `memory.recalled`

Published after each successful search (including zero hits; refusals and
errors publish nothing):

| Field | Value |
|---|---|
| `query_hash` | HMAC-SHA256 of the normalised query under a per-tenant random key at `.recall/query-hash.key`. Stable within a tenant, so repeat queries can be counted; not reversible by dictionary, unlike a bare SHA-256 of a short query. |
| `hit_count` | total matching chunks |
| `top_score` | score of the best hit, or `null` |
| `surface` | `telegram` \| `desktop` \| `cron` \| `other` \| `unknown` |

`session_id` travels as the envelope ref, not in the payload. The event type is
new: the ingest catalogue needs a row and a payload schema for it (until then
ingest quarantines it rather than dropping it, per the spec's additive-only
rule).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AV_RECALL_ENABLED` | unset | Installer: `1` opts in, `0` opts out. Runtime: `0` disables the tool. |
| `AV_RECALL_SCRIPT` | `$HERMES_HOME/skills/recall/scripts/recall.ts` | CLI location. |
| `AV_RECALL_BUN` | `bun` on `PATH` | Bun binary. |
| `AV_RECALL_INDEX` | `.recall/index.sqlite` | Index path, relative to `$HERMES_HOME`. Refused if it resolves under `memory/`. |
| `AV_RECALL_STATE_DB` | `state.db` | Hermes session store, relative to `$HERMES_HOME`. |

## Known limits

- Keyword search only: synonyms and paraphrases miss. Milestone 3 (embeddings)
  is gated on the miss rate these events measure.
- The session side depends on Hermes's `sessions`/`messages` schema
  (`chat_type`, `source`, `role`, `content`, `timestamp`); if a Hermes upgrade
  drops one of those columns the session side switches itself off and purges
  what it had, and markdown search keeps working.
- "Main session" is read as "not a shared chat": a DM, a local CLI/desktop
  session, or a cron run for the owner. A DM from someone other than the owner
  (a paired second user) is still a DM.
- Hermes's built-in `session_search` also searches past sessions, without this
  tool's group-session guard; that is Hermes's own surface and outside this
  skill.

## Tests

```
bun test skills/recall install/tests/install_recall.test.ts
python3 -m pytest plugins/recall plugins/av-events
```

The fixture workspace is `scripts/tests/fixtures/workspace/`: a `MEMORY.md`,
three dated daily notes, a draft and a JSON ledger that must never be indexed.
