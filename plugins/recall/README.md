# `recall` plugin

The Hermes side of the opt-in `recall` skill (DATA-83). What it is, what it never does, the consent
statement and the install steps are in [`skills/recall/README.md`](../../skills/recall/README.md);
this file records the Hermes API it relies on.

```
plugins/recall/
  plugin.yaml   manifest (kind: standalone, provides_tools: [recall])
  __init__.py   register(ctx): the tool, the group-session guard, the rebuild hook, the event
  tests/        pytest; drives a fake ctx and the real Bun CLI, never imports Hermes
```

## Hermes API used

Read in the Hermes tree at `0.21.3` (2026.9.14) and checked against the last commit before
2026-09-01 (`82e6c46`, the tree `plugins/av-events` was verified on). Paths are relative to it.

- **Only a plugin can add a callable tool.** A skill is markdown (plus scripts the agent runs through
  the terminal); `PluginContext.register_skill` registers read-only skill text, not tools.
  `PluginContext.register_tool(name, toolset, schema, handler, check_fn=None, requires_env=None,
  is_async=False, description="", emoji="", override=False)` (`hermes_cli/plugins.py`) puts the tool
  in `tools.registry`. It refuses to shadow an existing tool name without `override=True` (which
  needs operator consent); `recall` shadows nothing.
- **Schema** is `{"name", "description", "parameters": <JSON Schema>}`, the same shape as built-in
  tools (e.g. `tools/session_search_tool.py`).
- **Dispatch** is `handler(args, **kwargs)` with `task_id`, `session_id` and `user_task`
  (`model_tools.py` `_execute_tool` → `tools/registry.py` `dispatch`). The handler must return a
  string (or the multimodal envelope); exceptions are caught by the registry and turned into an
  error result. This handler returns JSON text and never raises.
- **Exposure.** A plugin's toolset is on by default for every platform unless the operator removed
  it (`hermes_cli/tools_config.py` `_enabled_plugin_toolsets`), so the tool is visible in group chats
  too. That is why the handler, not tool visibility, is the guard.
- **Session context.** The gateway binds per-task `ContextVar`s (`gateway/session_context.py`),
  including `HERMES_SESSION_CHAT_TYPE` (`dm`, `group`, `forum`, `channel`, `thread`, …; Telegram
  maps `private` to `dm` and `supergroup` to `group`/`forum` in
  `plugins/platforms/telegram/adapter.py`). The handler reads them the way
  `tools/environments/local.py` `_inject_session_context_env` does: a bound value wins, and in a
  process that has bound sessions an unbound task is treated as unknown and refused, because the
  `os.environ` mirror may belong to another concurrent session. The same bridge exports these
  variables to terminal commands, which is what lets the Bun CLI refuse on its own.
- **Loading.** User plugins load only when listed in `plugins.enabled`
  (`hermes_cli/plugins_discovery.py`); the installer adds `recall` only for opted-in tenants.
- **Hooks.** `on_session_finalize` is a session-boundary hook (`hermes_cli/lifecycle.py`); the
  callback only starts a daemon thread, so it returns immediately.
- **Event bus.** `ctx.emit("memory.recalled", payload)` publishes `recall:memory.recalled`
  (namespace forced to this plugin's key, which is the manifest `name` for a flat plugin
  directory, `hermes_cli/plugins_manifest.py` `parse_manifest_file`). `av-events` subscribes. With
  no subscriber the emit is a no-op.
