# `village-memory` plugin (D3)

A Hermes **memory provider** (`kind: exclusive`), activated by `memory.provider: village-memory`
(the installer writes it on every run; `install/village_memory.ts`). It is never listed in
`plugins.enabled`. The built-in USER.md / MEMORY.md store stays on beside it.

```
plugins/village-memory/
  plugin.yaml   manifest (kind: exclusive)
  __init__.py   register(ctx) -> ctx.register_memory_provider(VillageMemoryProvider())
  tests/        pytest; one test drives the real Hermes v2026.9.24 discovery when a Hermes tree is present
```

## What it does

| Surface | Behaviour |
|---|---|
| `system_prompt_block()` | `$HERMES_HOME/knowledge/agentvillage/_profile.md` (the control plane is its only writer, see D3-CONTRACT), read fresh at every prompt build, line 1 (the manifest) stripped and its sha checked. |
| `resident_profile()` | The same file read now, with the same caps. |
| `resident_context(query)` | Keyword search over `knowledge/agentvillage/*.md` (`_profile.md` included, other `_`/dot files skipped). A scan, no index, nothing written. Hits are `{ref, snippet, score}`, `ref` = `knowledge/agentvillage/<file>:<lines>`. |
| `prefetch`, `sync_turn`, `on_memory_write` | No-ops. |

## Caps and sessions

- **Private session** (a DM, or no chat type on cli / tui / desktop / local): with `model.context_length`
  of 200,000 or more, the whole profile, at most 80,000 code points. On a smaller or unknown window,
  only the sections before `## Shared on the Context page`, within 8% of the window at 3.5 chars per
  token (25,200 on a 90K box). Both tools.
- **Shared chat, room or cron run**: NO profile block and no tools (lead L32315: the profile holds the
  resident's Private lines with no per-line visibility). A tool called there answers
  `unavailable in group sessions`.
- **The built-in USER.md** (review-b L32588, ov#558 S1/S2, the context seat on N3): Hermes core puts
  `memories/USER.md` into every session's prompt. Two of its entries are Private (`PRIVATE_ENTRY_MARKS`, cp
  memory-entry.js CP_ENTRY_MARKS): the app's raw setup profile `[Edge City profile, written at setup]`
  (L31622) and the control plane's `[God Constitution conversation, kept by the Agent Village control plane]`
  note. The `[Village vote, ...]` note is village data and stays. The gate is ONE block of code, byte-identical
  here and in `av-events/_user_md_gate.py` (a test holds them together), installed by both plugins'
  `register()`, so it never depends on this provider loading:
  - **The seam:** it wraps `agent.system_prompt._memory_parts` once per process. A session that is not
    private gets the USER.md block without the Private entries (the header and the other entries stay; a
    block left with nothing is dropped; a block holding a mark in a shape it does not know is dropped
    whole). A private session gets it byte for byte. The provider decides only once `initialize` bound the
    session (`session_known()`); an agent with no initialised provider is judged on Hermes's own init facts.
  - **Fail closed:** a Hermes without that seam gets the store gate instead: `MemoryStore.format_for_system_prompt`
    leaves the Private entries out of the USER.md block for EVERY session (the DM still has the setup text
    under `_profile.md` "## Setup profile"). One WARNING.
  - **The memory tool** (av-events hooks), outside a private session only: `transform_tool_result` leaves
    Private entries out of every result (`current_entries`, `matches`, `replaced_entry`, `removed_entry`,
    `replaced_entries`, ...), and `pre_tool_call` refuses EVERY USER.md replace or remove, and any write
    holding a mark, with one plain refusal whatever it matches (no membership oracle). A USER.md add with no
    mark still works there, and MEMORY.md is unchanged. A DM keeps Hermes's own tool. "Private" needs
    positive evidence: a direct chat type or an explicit local surface from Hermes's session context, else
    Hermes's own session row for the session id; empty or unknown is not private, and cron never is.
  - **Fingerprints:** an entry this process has seen marked (load_from_disk, the gate, the write check) is
    still Private after its mark is gone: each line of 24 characters or more, by sha256, in memory only.
  - **Release canary:** `scripts/check-user-md-gate.py` (run with Hermes's interpreter and source against
    the box's HERMES_HOME) prints `user_md_gate provider=<seam|snapshot|none> av-events=<...>`; exit 0 only
    when both are `seam`.
  - `AV_VILLAGE_MEMORY` does not turn any of it off. F1 renders USER.md through the same gate
    (`village_user_gate`), and for a filtered session reads the prompt as stale while a Private mark is in or
    after its USER.md block, or another entry follows the gated block.
  - **Limits:** a group prompt stored before the roll keeps the entries until it is rebuilt (its next turn
    where F1 is on, team tenants; elsewhere its next compaction or `/new`: review-b #558 S3, a roll decision).
    Fingerprints do not survive a restart, so a mark stripped in a DM and a restart later leave that text
    unknown to the gate. The agent's own notes and the tags entry's Private-marked lines are not filtered
    here (ov#560).
- A file over 400,000 bytes, a symlink, a hard link, a non-regular file, or one that is not UTF-8
  gives an empty block. Nothing ever raises into Hermes.
- Every output loses Hermes's `INVISIBLE_CHARS`, C0/C1 controls (not tab or newline) and
  `<memory-context>` fence tags. Logs carry codes and counts only.

## Switches

- `AV_VILLAGE_MEMORY=0|false|no|off` (process environment, else `$HERMES_HOME/.env`, read per call):
  empty block, tools unavailable. `is_available()` stays true with no I/O.
- F1 (`av-events/_prompt_refresh.py`, D7) hashes the same file and rebuilds and persists a live
  session's prompt when the profile changes (reason `profile_md`).

## Hermes facts relied on (v2026.9.24)

- Discovery: `plugins/memory/__init__.py:64-71` (the words `MemoryProvider` / `register_memory_provider`
  in the first 8 KB), `:90-136` (user dir `$HERMES_HOME/plugins/<name>/`), `:332-358` (`register(ctx)`).
- The general manager skips `kind: exclusive`: `hermes_cli/plugins_discovery.py:253-257`.
- Activation: `agent/agent_init.py:1298-1331`; init kwargs (`hermes_home`, `platform`, `agent_context`,
  `chat_type`): `:1221-1251, 2303-2306`.
- Block joined uncapped into the volatile tier: `agent/memory_manager.py:432-436`,
  `agent/system_prompt.py:515-540, 776`.
- Tools: schemas read before and after `initialize` (`memory_manager.py:363-405, 112-158`), dispatched
  by the manager (`agent/tool_executor.py:1634-1641`), never deferred by `tool_search`
  (`tools/tool_search.py:149-162`).
- USER.md reaches the prompt only through `agent/system_prompt.py` `_memory_parts` (:515-525), called by
  bare name at :776; the block is `MemoryStore._render_block` (`tools/memory_tool_store.py:20-23`):
  separator, `USER PROFILE (who the user is) [usage]`, separator, entries joined by `\n§\n`.
- Hermes executes every top-level `*.py` of the directory (`plugins/plugin_loader.py:117-125`): keep
  the runtime in `__init__.py`.
