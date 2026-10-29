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
- **The built-in USER.md** (review-b L32588): Hermes core puts `memories/USER.md` into every session's
  prompt, and the app's `[Edge City profile, written at setup]` entry there is the raw setup profile
  (Private, L31622). `register()` wraps `agent.system_prompt._memory_parts` once per process: a session
  that is not private gets the USER.md block without that entry (the header and the agent's other entries
  stay; a block left with nothing is dropped; a block holding the entry in a shape it does not know is
  dropped whole). A private session gets it byte for byte. The provider decides only once `initialize` bound the
  session (`session_known()`; before that its `private_session()` says True for tool routing). An agent
  with no initialised provider (a subagent, a review fork) is judged on Hermes's own init facts. `AV_VILLAGE_MEMORY` does not turn it
  off. F1 renders through the same gate (`village_user_gate` on the wrapper), so a group turn is not
  stale; for a filtered session it also reads the prompt as stale while the mark is still in or after its
  USER.md block, or another entry follows the gated block (the gated block can be a prefix of the old one),
  and a gate that raises reads as stale; a group prompt stored before the roll is rebuilt at its next turn where F1 is on (team tenants),
  elsewhere at its next compaction or `/new`.
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
