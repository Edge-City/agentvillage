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
- **Shared chat or cron run**: the reduced block (no Context page files), no tools. A tool called
  there answers `unavailable in group sessions`.
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
- Hermes executes every top-level `*.py` of the directory (`plugins/plugin_loader.py:117-125`): keep
  the runtime in `__init__.py`.
