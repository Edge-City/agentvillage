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

*Draft; Timour reviews this text before it is shown to attendees.*

The index is built from notes and conversations already in the attendee's
sandbox, is stored in that sandbox, and is read only by the attendee's own
agent. When the agent searches it, the snippets it gets back become part of
the agent's context for that turn, exactly as `MEMORY.md` already does every
session: they go to the same language model, under the same terms, and to
nothing else. The tool itself sends nothing anywhere else.

Beyond that, one thing leaves the sandbox, under the tenant's existing
telemetry consent: one event per search, `memory.recalled`, through the
`av-events` plugin, carrying a keyed hash of the query, the number of hits, the
top score and which surface the search came from — never the query, a snippet,
or a reference (in `metadata` capture, only the count and the surface). It is
not sent at all when that plugin is off.

The research archive excludes recall results: every result the tool returns
starts with the marker line `[recall]`, and the archive's redaction step drops
any tool message from the `recall` tool or starting with that marker. That step
is part of the archive's message-body capture (DATA-32), which is not built
yet; the requirement is recorded there.

## What it never does

- Never runs outside the owner's main session. The main session is a
  one-to-one chat (`dm`), or a session with no chat type on the owner's own
  machine (CLI, TUI, desktop). Everywhere else — group chats, scheduled cron
  runs (Hermes cron binds no chat type and delivers to the chat the job was
  created in, which may be a group), API-server turns, webhooks, anything
  unrecognised — the tool returns
  `{"status": "unavailable", "reason": "unavailable in group sessions"}` with no
  data, before the index is touched.
- Never writes under `memory/`. The index lives at `$HERMES_HOME/.recall/`, and
  the tool's result text must not be copied into notes (the skill tells the
  agent so): search results written into memory would come back as future
  search results.
- Never indexes drafts, ledgers or linked files. Only `memory/YYYY-MM-DD.md` is
  read from `memory/`; the legacy `digest-outgoing.md` draft and the JSON state
  files are skipped, as is any symlinked or hard-linked file. Cron sessions
  (which hold the morning-brief drafts), group chats, subagent runs and tool
  output are excluded from the session side.
- Never indexes a previous occupant's conversations. `--wipe-user` writes
  `.recall/epoch`, and no session message older than it is indexed (Hermes keeps
  `state.db` across a wipe).
- Never calls a model or the network, and never receives credentials: the
  search process gets a short allowlist (`PATH`, `HOME`, `TZ`, locale,
  `HERMES_HOME`, the recall path overrides and the resolved session facts), and
  the query is passed on stdin so it does not show up in a process listing.
- Never runs by default. It is opt-in per tenant (below) and nothing in the core
  loop depends on it. An opt-in failure in the installer is counted and logged,
  never fatal.

## Opt-in install

Hosted tenants: set `AV_RECALL_ENABLED=1` in the tenant's `.env`. The installer
runs on every container boot and on the sidecar's `/update`, and reads the flag
from the environment or, when it is absent there, from `$HERMES_HOME/.env`.
Only `1`, `true`, `yes` or `on` (any case) opts in; then it

1. stages this skill into `$HERMES_HOME/skills/recall/` (without tests or
   fixtures), and
2. adds `recall` to `plugins.enabled` in `config.yaml`.

Any other non-blank value (`0`, `off`, `disabled`, a typo) opts out: the plugin
is removed from `plugins.enabled`, the skill is removed, and the index under
`$HERMES_HOME/.recall/` is deleted (derived data only; the notes themselves
are untouched; the `epoch` marker stays). Unset or blank means no choice, and
the installer changes nothing.

Self-hosted Hermes: run the installer with `AV_RECALL_ENABLED=1`, or copy
`skills/recall/` to `~/.hermes/skills/recall/`, copy `plugins/recall/` to
`~/.hermes/plugins/recall/`, and run `hermes plugins enable recall`. Bun must be
on the gateway's `PATH` (it already is in hosted sandboxes).

At runtime the same variable is a kill switch: once the plugin is loaded,
unset means on, and a set value other than `1|true|yes|on` makes the tool
answer `unavailable` from the next call, without a restart.

## Rollback

Either set `AV_RECALL_ENABLED=0` in the tenant's `.env` and run `/update`, or
run `bun install/reset.ts` (which also removes every other AgentVillage piece).
Either way the plugin leaves `plugins.enabled`, the skill is removed, and the
index and its hash key are deleted. No other state changes: notes,
`MEMORY.md`, sessions and every other plugin are untouched; the `epoch` marker,
if any, stays. `reset.ts --wipe-user` writes a fresh epoch.

## How it fits together

| Piece | Where | Does |
|---|---|---|
| Indexer and search | `skills/recall/scripts/recall.ts` (Bun, `bun:sqlite`) | Builds and queries the FTS5 index. CLI: `rebuild`, `query`. Applies the main-session rule itself from the session variables Hermes exports to terminal commands, so a terminal call cannot bypass it. |
| Hermes tool | `plugins/recall/` (Python) | Registers `recall` with `ctx.register_tool`, applies the main-session rule from the gateway's per-task session context, runs the CLI, prefixes the result with `[recall]`, publishes `memory.recalled`, and triggers a background rebuild on `on_session_finalize`. |
| Telemetry | `plugins/av-events/` | Subscribes to `recall:memory.recalled` on the Hermes plugin event bus and rebuilds the payload from four allowlisted fields. |

A Hermes skill is markdown and cannot register a callable tool: only a plugin
can (`PluginContext.register_tool` in `hermes_cli/plugins.py`). Hence a small
plugin next to the skill.

The Hermes version a hosted tenant runs comes from the `agentvillage-base`
sandbox checkpoint, not from `EDGE_HERMES_REF` (which pins this overlay repo).
Everything here was verified against two Hermes trees: `82e6c46`, the last
commit before 2026-09-01 (the tree `plugins/av-events` was verified on), and
`0.21.3` / 2026.9.14 (`118984d`). At `0.21.3` both plugins were also loaded
through the real `PluginManager` and exercised end to end.

### Index

- `$HERMES_HOME/.recall/index.sqlite` (directory `0700`, file `0600`), WAL.
- Text is cut into chunks of consecutive non-blank lines (split at headings and
  every 12 lines). Tokeniser: `porter unicode61 remove_diacritics 2`.
- Dates: a daily note's date comes from its filename; a `MEMORY.md` chunk takes
  the first `YYYY-MM-DD` in its text or heading, else the file's modification
  date (`date_source: mtime`); a message takes its timestamp's local date.
- Incremental: a file whose mtime and size are unchanged is skipped on a stat; a
  touched file whose SHA-256 is unchanged is not re-chunked. A session that only
  grew has its new messages appended; one whose earlier messages changed
  (rewind, compaction) is re-indexed whole. Removed files and sessions are
  purged first, on every pass.
- Rebuild runs (1) at the start of every `query`, capped at 3 s — past the cap
  the query answers from the index as it stands and says `partial: true` (the
  flag reaches the model, never the event); (2) in the background when a Hermes
  session finalises (single-flight, at most every 30 s); (3) on demand:
  `bun skills/recall/scripts/recall.ts rebuild`. A restored or recreated
  sandbox rebuilds on first use; a restore path that wants a warm index can
  run (3).
- Scrubbing: the background rebuild runs with `secure_delete` on and merges FTS
  segments after any removal, so removed text leaves the file. The query path
  skips that to stay fast and records that a scrub is owed; the next background
  rebuild then also runs `VACUUM` and truncates the WAL.
- The index is derived: if the file is not a usable database it is discarded
  and rebuilt. Opening a new index retries with backoff when another process
  holds the first-creation lock.

### Search

Query words are lowercased and quoted (FTS5 operators in user text are inert).
All words are tried first (`match: "all"`), then any word (`match: "any"`).
Ordering is BM25, then date (newest first), then ref, then line. `hit_count` is
every matching chunk; `hits` is the top 8. `score` is `-bm25`, higher is better.

### Tool result

```
[recall]
{"status": "ok", "match": "all", "since": null, "hit_count": 2, "top_score": 2.35, "partial": false,
 "hits": [{"date": "2026-09-20", "date_source": "filename", "kind": "daily_note",
           "ref": "memory/2026-09-20.md:3-4", "snippet": "…", "score": 2.35}, …]}
```

**The first line, `[recall]`, is the archive redaction key.** Every result
starts with it, refusals and errors included. The research archive's redaction
step (DATA-32) drops tool messages whose tool is `recall` or whose content
starts with that line. Do not change it without changing that step.

### `memory.recalled`

Published after each successful search (including zero hits; refusals and
errors publish nothing):

| Field | Value |
|---|---|
| `query_hash` | HMAC-SHA256 of the normalised query (the same terms the search uses) under a per-tenant random key at `.recall/query-hash.key` (64 hex characters, written atomically, mode `0600`; a malformed key is regenerated and counted). Stable within a tenant, so repeat queries can be counted; not reversible by dictionary, unlike a bare SHA-256 of a short query. `null` in `metadata` capture. |
| `hit_count` | total matching chunks |
| `top_score` | score of the best hit, or `null`; `null` in `metadata` capture |
| `surface` | `telegram` \| `desktop` \| `cron` \| `other` \| `unknown` |

`session_id` travels as the envelope ref, not in the payload. The event type is
new: the ingest catalogue needs a row and a payload schema for it (until then
ingest quarantines it rather than dropping it, per the spec's additive-only
rule).

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AV_RECALL_ENABLED` | unset | Installer: `1\|true\|yes\|on` opts in, any other non-blank value opts out, unset changes nothing (read from `$HERMES_HOME/.env` when absent from the environment). Runtime: unset is on; any other value but `1\|true\|yes\|on` disables the tool. |
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
- Cron runs are refused even when the job was created in the owner's DM: the
  session carries no reliable record of where it will deliver.
- A DM from someone other than the owner (a paired second user) is still a DM.
- The refusal is a guarantee of this tool, not isolation: in a group chat the
  agent can still read `MEMORY.md` through its file tools, as it can today.
  Hermes's built-in `session_search` also searches past sessions without this
  guard; that is Hermes's own surface.
- A same-size edit within the same millisecond as the previous index pass is
  not noticed until the file changes again (mtime and size fast path).

## Tests

```
bun test skills/recall install/tests/install_recall.test.ts
python3 -m pytest plugins/recall plugins/av-events
```

The fixture workspace is `scripts/tests/fixtures/workspace/`: a `MEMORY.md`,
three dated daily notes, a draft and a JSON ledger that must never be indexed.
The large-store test builds 20,000 messages in 200 sessions. The plugin suite
runs one test against the real Hermes `gateway.session_context` when the Hermes
source is at `~/.hermes/hermes-agent` or `$HERMES_AGENT_SRC`, and skips it
otherwise.
