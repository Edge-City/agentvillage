# `av-events` — Agent Village V2 telemetry collector

A Hermes backend plugin that observes the agent and emits envelope-v1 events to the Agent Village
ingest API. It is **off-path by construction**: it fails open, never blocks on the network inside a
hook, and can be switched off per tenant or fleet-wide by environment variable without a redeploy.

Python 3.11, standard library only. No third-party dependencies, no secrets in the repo, and the
only network destination it will ever contact is `AV_EVENTS_URL`.

```
plugins/av-events/
  plugin.yaml      manifest (kind: backend)
  __init__.py      register(ctx) and the hook adapters — the only Hermes-aware module
  _collector.py    config, session bookkeeping, buffer flusher, fail-open decorator
  _core.py         env, uuid v7, canonical hashing, secret sanitiser, buffer, HTTP
  tests/           pytest suite; drives a fake ctx, never imports Hermes
```

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AV_EVENTS_TOKEN` | *(unset)* | Per-tenant ingest token. **Unset means the plugin idles**: hooks are registered, nothing is emitted, nothing is buffered, no thread is started. |
| `AV_EVENTS_URL` | *(unset)* | Ingest base URL. Events are POSTed to `{AV_EVENTS_URL}/v1/events`. Empty with a token set is **null-sink mode** (see below). |
| `AV_EVENTS_ENABLED` | `1` | `0` disables everything. Re-read at every session boundary. |
| `AV_HOOKS_DISABLED` | *(empty)* | Comma-separated hook names to disable individually, e.g. `pre_tool_call,post_tool_call`. |
| `AV_CAPTURE` | `sanitized` | `metadata` \| `sanitized` \| `full`. An unrecognised value falls back to `sanitized`. |
| `HERMES_VERSION`, `OVERLAY_REF` | *(unset)* | Optional; populate the envelope fields of the same name. See "What the API does not provide". |

Every variable is read from the process environment first and then from `$HERMES_HOME/.env`, the
same fallback `plugins/dashboard-auth-edgecity` uses. The dotfile is parsed once and memoised on its
mtime, so a missing variable never costs a file open on the agent's hot path.

`$HERMES_HOME` defaults to `~/.hermes` (and `%LOCALAPPDATA%\hermes` on Windows).

### Kill switches

`AV_EVENTS_ENABLED` and `AV_HOOKS_DISABLED` are **re-read whenever a session id the plugin has not
seen appears on a hook payload** — not only at plugin load. That is what makes spec scenario 26 work
in both directions: setting `AV_EVENTS_ENABLED=0` stops events from the next session, and unsetting
it resumes them, with no gateway restart. The reload is bounded to once per session id, so the check
on the hot path is a string compare.

---

## Capture modes

The ladder is about what leaves the sandbox, not about how much detail is recorded.

| | `metadata` | `sanitized` (default) | `full` |
|---|---|---|---|
| Envelope, counters, token counts, latency | yes | yes | yes |
| `tools_hash`, `system_prompt_hash` | yes | yes | yes |
| Lengths (`system_prompt_length`, `assistant_content_chars`, …) | no | yes | yes |
| Message text, tool arguments, tool results | never | never | never |
| `prompt.registered` with the tool schemas and system prompt text | no | no | yes |

`tools_hash` and `system_prompt_hash` are present in every mode because they describe the *agent's
configuration*, not the participant. Message text, tool arguments and tool results never leave in
any mode — this milestone does not emit `tool.call` at all.

Per spec §7.1 the mode is set per tenant from consent scope (`full` iff `scope.training`), by the
control plane writing the sandbox environment. Nothing in this plugin decides it.

**Hashing.** SHA-256 over canonical JSON:
`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. Key order in the input
is irrelevant; any change to a tool's schema changes the hash.

**Sanitiser.** Every string that leaves passes a secret-shape filter: Anthropic, OpenRouter and
OpenAI key shapes, `Bearer …`, the Telegram bot-token shape, and the literal value of our own
`AV_EVENTS_TOKEN`. This is a last line of defence behind the capture modes, not the privacy control.

**Tool-name allowlist.** `TOOL_CATEGORIES` in `_core.py` maps known tool names to categories, with
`other` for anything unlisted, so a third-party MCP server's tool names cannot leak through
`sanitized`. It carries a `TODO` to align with the frozen catalogue (spec §4.1 `tool.call`) — it is
a placeholder, not an agreed list.

---

## Events emitted

All carry `evidence_class: agent_report` — this plugin observes the agent, not the world, and ingest
downgrades anything stronger in any case (spec scenario 4). `event_id` is a uuid v7 (RFC 9562 §5.7,
implemented here because the 3.11 stdlib has none) with a monotonic counter in `rand_a`, so ids sort
in emission order.

| Event | Source hook | Payload |
|---|---|---|
| `session.started` | `on_session_start` | `source`, `cron_job_id?` |
| `session.ended` | `on_session_finalize` | `source`, `message_count`, `tool_call_count`, `input_tokens`, `output_tokens`, `duration_ms` |
| `llm.call` | `pre_api_request` + `post_api_request` | `model`, `provider`, the five token buckets, `latency_ms`, `finish_reason`, `tools_hash`, `system_prompt_hash`, plus lengths above `metadata` |
| `prompt.registered` | `pre_api_request` | `hash`, `kind` ∈ `tools`\|`system_prompt`, `body`. `full` only, once per hash ever |
| `plugin.degraded` | the guard | `hook`, `error_count`, `errors_by_hook`, `hermes_version`, `last_error` (sanitised) |
| `plugin.buffer_dropped` | the flusher | `count`, `files`, `oldest_event_at`, `newest_event_at` |

`prompt.registered` is content-addressed against a seen-set at `$HERMES_HOME/av-events/seen.json`,
so the same tool schemas register once and never again, across sessions and process restarts.

---

## Fail-open contract

Implements `launch-guardrails-draft.md` §2 and spec scenario 25.

- **Every hook body is wrapped in one decorator** (`_collector.guarded`). It catches `BaseException`
  — a `MemoryError` from our hook must not take the turn loop either — re-raising only `SystemExit`,
  because swallowing a shutdown would be worse than losing an event.
- **Ten failures in a session** (counted across all hooks) disable the plugin for that session and
  emit exactly one `plugin.degraded`. A new session id re-arms it.
- **50 ms budget per hook**, measured with `time.perf_counter`. Overruns are *counted, never
  enforced*: aborting a hook halfway is worse for the agent than a slow one. Counts live in
  `collector.overruns`.
- **No network in a hook, ever.** Hooks hash and append a line; a daemon thread does all I/O.
  `on_session_end` and `session.ended` only *wake* the flusher. `ingest` being down changes nothing
  the agent can observe (spec scenario 24).
- **Hooks never return a value.** The decorator discards whatever the body returns, so this plugin
  structurally cannot block a tool call, inject context into a user message, or rewrite a response.

### Buffer

Append-only JSONL under `$HERMES_HOME/av-events/buffer/`. Each process appends to its own
`current-<pid>.jsonl`, rotated to a `<epoch_ms>-<pid>-<seq>.jsonl` batch after 50 events or 10
seconds. The name carries the timestamp of the batch's *first* event, so a batch left behind by a
crashed process is self-describing and still recoverable.

The flusher POSTs each batch to `{AV_EVENTS_URL}/v1/events` with `Authorization: Bearer
$AV_EVENTS_TOKEN` and body `{"events": [...]}`. A batch that fails backs off exponentially (2 s
doubling, capped at 300 s between attempts) and is retried until it is **72 hours old**, at which
point it is dropped and one `plugin.buffer_dropped` is emitted on the next successful flush.

Shutdown is a daemon thread plus an `atexit` hook that force-rotates and makes one bounded
(5 second) attempt at each pending batch. Anything it cannot send survives on disk.

**Null-sink mode** (`AV_EVENTS_TOKEN` set, `AV_EVENTS_URL` empty): events are written to the buffer
and never sent, so the plugin can run on a dogfood tenant before ingest exists. In this mode batches
are also never aged out — there is no destination to retry against, so dropping them would only
destroy the evidence. *Known limitation: the buffer grows unbounded in null-sink mode; it needs a
size cap or a periodic sweep before a long dogfood run.*

---

## Hermes API at v2026.8.31

Verified against `NousResearch/hermes-agent` at tag `v2026.8.31` (commit `29112be`,
`hermes_cli.__version__ == "0.21.0"`, `__release_date__ == "2026.8.31"`). The tag exists; no
substitution was needed. Paths below are relative to that tree.

### Loading

- Manifest parser: `hermes_cli/plugins.py:4763`. Valid `kind` values are
  `{standalone, backend, exclusive, platform, model-provider}` (`hermes_cli/plugins.py:683`), so
  `kind: backend` is correct. There is **no** `entrypoint`, `config` or `permissions` field; the
  config surface is `config_schema:` and the permission surface is `capabilities:`.
- **`hooks:` in a manifest is inert.** Only `provides_hooks` is parsed (`plugins.py:4831`), and
  nothing reads either at runtime — hooks are live purely via `ctx.register_hook()`. The list in our
  `plugin.yaml` is documentation.
- Directory plugins are loaded by `PluginManager._load_directory_module`
  (`hermes_cli/plugins.py:5447`): `importlib.util.spec_from_file_location(name, <dir>/__init__.py,
  submodule_search_locations=[<dir>])`, with `__path__` and `__package__` set, under a mangled name
  in a synthetic namespace package — `av-events` → `hermes_plugins.av_events`
  (`_directory_module_name`, `plugins.py:5424`). `__init__.py` is mandatory. **Relative imports
  inside the plugin work** because `__path__` is set, which is why `_core.py` and `_collector.py`
  are separate modules here. `plugins/disk-cleanup/` is the in-tree precedent for a hyphenated
  directory doing exactly this.
- `register(ctx)` is called with one positional argument, **synchronously, and never awaited**
  (`plugins.py:5282`). An `async def register` would silently register nothing. `ctx` is a concrete
  `hermes_cli.plugins.PluginContext` (`plugins.py:1458`).

### Hook registration

`ctx.register_hook(hook_name, callback)` (`plugins.py:3387`) is the only API — no `ctx.on(...)`, no
decorators. An unknown name warns but is still stored. `VALID_HOOKS` (`plugins.py:163`) holds 36
names; all eight the spec names exist, plus `on_session_start`, `on_session_finalize`,
`pre_api_request` and `post_api_request`.

### Dispatch

- **Synchronous and inline on the request path.** `invoke_hook` calls `callback(**kwargs)` in the
  caller's thread and the call site blocks on the result (`plugins.py:5564`). The exceptions are the
  `on_stream_*` / `on_interim_message` family, which are enqueued to a consumer thread
  (`agent/plugin_stream_hooks.py:122`).
- **Hooks are plain sync callables.** There is no `isawaitable` handling; an `async def` hook returns
  an un-awaited coroutine.
- **Kwargs are filtered by signature** (`plugins.py:5537`): a callback receives the complete payload
  only if it declares a `**kwargs` parameter, otherwise just the names it lists. Every hook here
  takes `**kwargs`, and `build_hooks()` deletes `__wrapped__` from the wrapper so `inspect.signature`
  sees the wrapper's own signature rather than following through `functools.wraps`.
- **Exceptions are already isolated**: each callback is individually wrapped and logged at WARNING
  (`plugins.py:5694`), and nearly every fire site wraps `invoke_hook` again. Spec §10 assumed the
  plugin must guarantee this itself; it does anyway, and the tests assert it against a fake `ctx`
  that deliberately does *not* swallow.
- **Timeouts.** Hot-path hooks are bounded by `plugins.hook_callback_timeout` (default 30 s) and run
  on an abandoned-on-timeout daemon thread (`_HOOK_TIMEOUT_BOUNDED_HOOKS`, `plugins.py:428`).
  **`pre_tool_call` fails *closed***: a callback that times out or is still running injects a block
  directive and the tool never runs (`_HOOK_TIMEOUT_FAIL_CLOSED_HOOKS`, `plugins.py:441`;
  `_pre_tool_call_timeout_block`, `plugins.py:3726`). Our `pre_tool_call` body is a single counter
  increment for exactly this reason. `subagent_stop` always runs on the caller thread.

### Payloads we depend on

| Hook | Fire site | Kwargs used here |
|---|---|---|
| `on_session_start` | `agent/conversation_loop.py:1099` | `session_id`, `model`, `platform` — **only these three** |
| `on_session_end` | `agent/turn_finalizer.py:832` | `session_id`, `task_id`, `turn_id`, `completed`, `failed`, `interrupted`, `turn_exit_reason`, `model`, `platform` |
| `pre_llm_call` | `agent/turn_context.py:1379` | `session_id`, `task_id`, `turn_id`, `user_message`, `conversation_history`, `is_first_turn`, `model`, `platform`, `parent_session_id`, `sender_id` |
| `post_llm_call` | `agent/turn_finalizer.py:630` | `session_id`, `task_id`, `turn_id`, `user_message`, `assistant_response`, `conversation_history`, `model`, `platform` |
| `pre_api_request` | `agent/conversation_loop.py:3185` | `api_request_id`, `system_prompt`, `request` (`{"method","body"}`), `tool_count`, `approx_input_tokens`, `model`, `provider`, `api_mode`, `message_count`, `max_tokens`, `started_at` |
| `post_api_request` | `agent/conversation_loop.py:6993` | `api_request_id`, `usage`, `api_duration`, `finish_reason`, `response_model`, `assistant_content_chars`, `assistant_tool_call_count`, `provider`, `api_mode` |
| `pre_tool_call` | `hermes_cli/plugins.py:6636` | `tool_name`, `args`, `session_id`, `task_id`, `turn_id`, `tool_call_id`, `api_request_id` |
| `post_tool_call` | `model_tools.py:1220` | as above plus `result`, `duration_ms`, `status`, `error_type`, `error_message` |
| `subagent_start` | `tools/delegate_tool.py:2197` | `parent_session_id`, `parent_turn_id`, `child_session_id`, `child_role`, `child_goal` |
| `subagent_stop` | `tools/delegate_tool.py:3667` | adds `child_summary`, `child_status`, `tool_call_history`, `duration_ms` |

`usage` on `post_api_request` is `normalize_usage(...)` as a dict (`run_agent.py:2890`) and carries
exactly `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens` — the five buckets spec §4.1 asks for, name for name.

Every payload also gets `telemetry_schema_version="hermes.observer.v1"` injected (`plugins.py:5627`).

### Return values

There is no generic abort; each call site interprets its own hook's returns.

- `pre_tool_call` **can** block a tool (`{"action":"block","message":…}`), escalate to human approval
  (`"approve"`), or shallow-merge `args` (`"modify"`) — `plugins.py:6648`.
- `pre_llm_call` can only **append context to the user message** (`{"context": "..."}` or a bare
  string, all returns joined). It cannot abort the call and cannot rewrite messages or the system
  prompt — the hook exists precisely to keep the system prompt byte-stable for prompt caching
  (`plugins.py:5586`, `agent/turn_context.py:1408`).
- `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_*`, `subagent_*` and
  `on_stream_*` are **pure observers**; their returns are discarded.
- Mutating the outbound provider payload requires **middleware**, not a hook:
  `ctx.register_middleware("llm_request", cb)` returning `{"request": {...}}`
  (`hermes_cli/middleware.py:77`).

---

## Where the spec's assumptions did not match the API

These are the divergences this milestone had to resolve. Each one is a decision to review.

1. **`pre_llm_call` does not carry the tools schema or the system prompt.** Spec §7.1 says to hash
   both there. It receives neither (`agent/turn_context.py:1379`). They are on `pre_api_request`:
   `system_prompt` explicitly, and the full schema list inside `request["body"]["tools"]`
   (`run_agent.py:3063`). **Resolution:** `llm.call` is built from `pre_api_request` +
   `post_api_request`, correlated by `api_request_id`, and `pre_api_request` is registered although
   the spec does not name it.
2. **`post_llm_call` has no token counts.** Spec §4.1 requires `input_tokens`, `output_tokens`,
   `cache_*`, `reasoning_tokens`, `latency_ms`, `finish_reason` on `llm.call`. `post_llm_call`
   carries none of them; `post_api_request` carries all of them. **Resolution:** as above.
3. **`pre_llm_call` fires once per *turn*; `pre_api_request` fires once per *API request*.** A turn
   with a tool loop makes several API calls. `llm.call` is therefore per API request, which is what
   the catalogue's per-call fields imply, but it means `llm.call` count ≠ turn count. Worth
   confirming with research before the funnel is built on it.
4. **`on_session_end` fires once per turn, not once per session** — it runs at the end of every
   `run_conversation` call (`agent/turn_finalizer.py:828`), despite the name. Emitting
   `session.ended` there would produce one per user message. **Resolution:** `session.ended` is
   emitted from `on_session_finalize`, and `on_session_end` only nudges the flusher. This is the
   divergence most likely to bite a later milestone.
5. **`on_session_start` is not in spec §7.1 but is required.** It is the only fire site for a new
   session (`agent/conversation_loop.py:1095`) and it does **not** re-fire on continuation.
   `session.started` also has a lazy fallback: the first hook to see an unknown session id opens it.
6. **`on_session_start` carries only `session_id`, `model`, `platform`.** There is no `source`. The
   catalogue's `source` (`telegram`\|`cron`\|`desktop`\|`negotiation`) is mapped from `platform` via
   `SOURCE_BY_PLATFORM`; `cli`/`tui` → `desktop`, and anything unrecognised passes through as-is
   rather than being forced into a bucket. **`negotiation` has no platform to map from** — it will
   need another signal.
7. **There is no overlay identifier at runtime.** Spec §3 has `overlay_ref` on every envelope; the
   word "overlay" in the Hermes tree means only managed-config merge, personality overlays and TUI
   overlays. **Resolution:** read from `OVERLAY_REF` in the environment, else `null`. The installer
   should start setting it.
8. **`hermes_version` is `hermes_cli.__version__`** (`"0.21.0"`), not the release date `"2026.8.31"`
   people quote. There is no `hermes_constants.VERSION`. We prefer `$HERMES_VERSION` if set so the
   control plane can pin the string it wants, else the import, else `null`.
9. **A plugin hook cannot abort an LLM call** — spec §10 carried this as an open verification item.
   Confirmed: `pre_llm_call` can only inject context. The budget abort therefore cannot be a plugin
   hook; it must be `pre_tool_call` (which *can* block, but only a tool, not an API call), a shell
   hook, or `llm_request` middleware. Out of scope for this milestone, but the answer is now known.
10. **Hermes already isolates throwing hooks** — the other §10 verification item. It does
    (`plugins.py:5694`), catching `Exception` but not `BaseException`. The plugin guarantees it
    independently, as the spec assumed it would have to.
11. **`request["body"]` is Hermes's sanitised view**, not the raw request: strings are truncated at
    8000 chars, sequences at 200 items, depth 8, with an overall 50000-char cap
    (`run_agent.py:2907`). So `tools_hash` is a hash of *that view*. It is deterministic and stable
    across turns, so comparisons hold, but it is not the hash of the bytes sent to the provider. If
    the exact outbound payload is ever needed, `llm_request` middleware is the surface.
12. **Registering `pre_api_request` has a cost.** Both API hooks are gated on `has_hook()`, so
    Hermes builds and sanitises that payload on every API call *only because we registered*. If
    latency becomes a concern, `AV_HOOKS_DISABLED=pre_api_request` turns it off at the cost of
    `tools_hash` / `system_prompt_hash`.

---

## Not implemented in this milestone

Out of scope, deliberately:

- **Cron capture** — `cron.run` by tailing `$HERMES_HOME/cron/usage_audit.jsonl` and the executions
  store. Note there is **no cron hook** in `VALID_HOOKS` at all; a tail is the only route.
- **Budget** — `run.budget_exceeded`, `AV_RUN_BUDGET_*`, `AV_BUDGET_MODE`. There is no budget hook
  either, and see divergence 9 for why the enforce path cannot be `pre_llm_call`.
- **Intention capture** — `intention.captured/updated/withdrawn` from Index `create_intent` /
  `update_intent` and the `record_intention` skill.
- **`tool.call` events** — `pre_tool_call` / `post_tool_call` are registered and counted, but emit
  nothing. Requires the frozen tool-category allowlist first.
- **`message.in/out`, `profile.updated`, `skill.enabled/disabled`**.
- Anything server-side: ingest, dbt, pollers, classifiers.

---

## Tests

```
python3 -m pytest plugins/av-events
```

The suite drives a fake `ctx` and never imports Hermes. It loads the plugin through the same
`spec_from_file_location` + `submodule_search_locations` path the Hermes loader uses, so the
hyphenated directory name and the relative imports are themselves under test.

Note the repo-root `pytest.ini`: pytest 8's `Package.setup()` imports a collected package's
`__init__.py` unconditionally, and this plugin's relative imports only resolve when the module name
is derived from the repo root — hence rootdir there and `--import-mode=importlib`.
