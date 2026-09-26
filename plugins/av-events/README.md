# `av-events` — Agent Village V2 telemetry collector

A Hermes backend plugin that observes the agent and emits envelope-v1 events to the Agent Village
ingest API. It is **off-path by construction**: it fails open, never blocks on the network inside a
hook, and can be switched off per tenant or fleet-wide by environment variable without a redeploy.

Python 3.11, standard library only. No third-party dependencies, no secrets in the repo, and the
only network destinations it will ever contact are `AV_EVENTS_URL` and, for the memory snapshot,
`AV_BACKUP_URL`. That amends spec §7.1's "network calls to AV_EVENTS_URL only" to "network calls
to AV_EVENTS_URL and AV_BACKUP_URL only"; the amendment is owed to spec draft 1.2.

```
plugins/av-events/
  plugin.yaml      manifest (kind: backend)
  __init__.py      register(ctx) and the hook adapters — the only Hermes-aware module
  _collector.py    config, session bookkeeping, buffer flusher, fail-open decorator
  _core.py         env, uuid v7/v5, canonical hashing, secret sanitiser, buffer, HTTP, read-only SQLite
  _intentions.py   which tool calls record an intention, and which one (pure)
  _tools.py        tool.call payload and the tool-name allowlist (pure)
  _messages.py     message.in/out payloads and the punctuation flags (pure)
  _edgeos.py       the curl parser, EdgeOS operations, the action ledger and planner
  _cron.py         cron.run from the executions ledger and usage audit (flusher thread only)
  _backup.py       memory.snapshot: collect, pack and upload the memory files (backup thread only)
  tool_categories.json        frozen seed: tool name -> category (tool_categories_v1)
  edgeos_tool_allowlist.json  frozen seed: EdgeOS operations (edgeos_tool_allowlist_v1)
  cron_job_names.json         frozen seed: the cron names cron.run may carry (cron_job_names_v1)
  tests/           pytest suite; drives a fake ctx, never imports Hermes
```

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AV_EVENTS_TOKEN` | *(unset)* | Per-tenant ingest token. **Unset or blank means the plugin idles**: hooks are registered, nothing is emitted, nothing is buffered, no thread is started. |
| `AV_EVENTS_URL` | *(unset)* | Ingest base URL. Events are POSTed to `{AV_EVENTS_URL}/v1/events`. Empty with a token set is **null-sink mode** (see below). |
| `AV_EVENTS_ENABLED` | `1` | Any of `0`, `false`, `no`, `off` (case-insensitive, whitespace ignored) disables everything. Re-read at every session boundary. |
| `AV_HOOKS_DISABLED` | *(empty)* | Comma-separated hook names to disable individually, e.g. `pre_tool_call,post_tool_call`. Matched case-insensitively, whitespace stripped. Two names are not hooks: `memory_recalled` (the bus subscription) and `cron_run` (the cron tail). |
| `AV_CAPTURE` | `sanitized` | `metadata` \| `sanitized` \| `full`. An unrecognised value falls back to `sanitized`. |
| `TENANT_ID`, `AV_TENANT_ID` | *(unset)* | The tenant id, used for one thing only: `cron.run`'s derived event id (spec §4.3). `TENANT_ID` is what the control plane already sets for `dashboard-auth-edgecity`; `AV_TENANT_ID` overrides it. Unset means `cron.run` gets a uuid v7 (see "Cron capture"). |
| `HERMES_VERSION`, `OVERLAY_REF` | *(unset)* | Optional; populate the envelope fields of the same name. See "What the API does not provide". |
| `AV_BACKUP_URL` | *(unset)* | Base URL of the ingest service's backup route (`…/v1/backup` accepted too). **Process environment only, never `.env`**; https, or http only to `*.railway.internal` or the local machine. **Unset, blank or refused: no memory snapshot, nothing read, no thread.** See "Memory snapshot". |
| `AV_BACKUP_TOKEN` | *(unset)* | The tenant's `backup_write` token (DATA-93). Required with the URL. Redacted like `AV_EVENTS_TOKEN`. |
| `AV_BACKUP_MAX_BYTES` | `33554432` | Most file bytes a snapshot reads (the rest are skipped and the snapshot marked partial) and largest compressed archive it uploads. |
| `AV_BACKUP_MIN_INTERVAL_S` | `300` | Least time between two turn-triggered snapshot passes. A session finalize is not held to it. |
| `AV_BACKUP_GRACE_S` | `90` | Least time between a snapshot request and the pass that covers it, so the background memory review's writes after a turn are included. |

Every variable is read from the process environment first and then from `$HERMES_HOME/.env`, the
same fallback `plugins/dashboard-auth-edgecity` uses. The dotfile is parsed once and memoised on its
mtime, so a missing variable never costs a file open on the agent's hot path.

**A variable present but blank in the process environment is authoritative and does not fall through
to the dotfile.** `AV_EVENTS_TOKEN=""` is how the control plane revokes a tenant; a stale `.env` line
must not be able to undo that. Only a variable that is *absent* falls back.

`$HERMES_HOME` defaults to `~/.hermes` (and `%LOCALAPPDATA%\hermes` on Windows).

### Enabling

The installer (`install/config.ts`, `configureAvEvents`) adds `av-events` to `config.yaml`
`plugins.enabled` on **every** install and update, whether or not a token exists yet. That is safe
because the plugin idles without `AV_EVENTS_TOKEN`, and it is necessary because the control plane
writes the token into `$HERMES_HOME/.env` only after the installer has first run (DATA-160: gating
the enable on the token left the plugin off every hosted tenant). The installer writes no token or
URL into `config.yaml`; it only logs `(no AV_EVENTS_TOKEN yet; the plugin idles until the control
plane writes one)` when neither the process environment nor `.env` has one. Hermes reads
`plugins.enabled` at gateway start, so a newly listed plugin loads after the next restart. To keep it
from collecting, use the kill switches below rather than unlisting it: the next install puts it back.

### Kill switches

`AV_EVENTS_ENABLED` and `AV_HOOKS_DISABLED` are **re-read at session boundaries**, not only at plugin
load. That is what makes spec scenario 26 work in both directions: setting `AV_EVENTS_ENABLED=0`
stops events from the next session, and unsetting it resumes them, with no gateway restart.

The reload fires once per session id the plugin has not seen, plus a 60-second TTL so a single
long-lived session still notices a flip. It is deliberately **not** per hook: a reload is five env
reads and a dotfile stat, and `pre_tool_call` in particular must not pay that (see below).

---

## Capture modes

The ladder is about what leaves the sandbox, not about how much detail is recorded.

| | `metadata` | `sanitized` (default) | `full` |
|---|---|---|---|
| Envelope, counters, token counts, latency, statuses | yes | yes | yes |
| `tools_hash`, `system_prompt_hash` | yes | yes | yes |
| Listed tool names and categories, EdgeOS operation names, `action.*`, `cron.run`, `message.out.silent` | yes | yes | yes |
| `action.*` `edgeos_event_id` | keyed hash | the id | the id |
| Lengths (`system_prompt_length`, `assistant_content_chars`, …) | no | yes | yes |
| Intention `text_hash`, `summary_hash` (plain SHA-256) | yes | yes | yes |
| Profile `user_md_hash` (keyed) | yes | yes | yes |
| Intention `text_length` / `summary_length`; profile `length` | no | yes | yes |
| `tool.call` `args_hash` / `result_hash` (keyed) and `args_length` / `result_length` | no | yes | yes |
| `message.*` `length`, `content_hash` (keyed), `flags` | no | yes | yes |
| Message text, intention text, USER.md text, tool arguments, tool results | never | never | never |
| `prompt.registered` with the tool schemas and system prompt text | no | no | yes |

`tools_hash` and `system_prompt_hash` are present in every mode because they describe the *agent's
configuration*, not the participant. Message text, tool arguments and tool results never leave in
any mode, `full` included: text lives in the archive only (§7.5), and the training export reads it
from there (§8). The intention hashes and the USER.md hash are the participant-derived values
present in every mode, because they are join keys (`core.intention_versions`, `core.tasks`). The
intention hashes stay plain SHA-256, since the Index poller outside the sandbox must compute the same
value; the USER.md hash is **keyed** (below), since a short, templated USER.md is guessable from a
plain SHA-256 and `core.tasks` joins on it only within the tenant. A message or tool-argument hash is
not a join key and is often a hash of a few words — a dictionary lookup away from the words — so it
is keyed too and `metadata` drops it.

`full` differs from `sanitized` in exactly one way: `prompt.registered`.

Per spec §7.1 the mode is set per tenant from consent scope (`full` iff `scope.training`), by the
control plane writing the sandbox environment (`AV_CAPTURE`). Nothing in this plugin decides it,
and `prompt.registered` is emitted in `full` and in no other mode.

**Hashing.** SHA-256 over canonical JSON:
`json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)`. Key order in the input
is irrelevant; any change to a tool's schema changes the hash. Text is encoded as UTF-8 with
`errors="surrogatepass"`, so a lone surrogate hashes instead of raising; well-formed text hashes
exactly as plain UTF-8.

**Keyed hashes.** `message.*` `content_hash`, `tool.call` `args_hash` / `result_hash`,
`profile.updated` `user_md_hash`, and in
`metadata` the EdgeOS event and participant ids on `action.*`, are HMAC-SHA256 under a per-tenant
random key at `$HERMES_HOME/av-events/hash.key` (64 hex characters, mode 0600). The key never leaves
the sandbox, so these digests count and join within a tenant and are useless to anyone else.
**A key, once written, never rotates** (`load_or_create_key`): a missing file is created by linking a
complete temp file into place, and the process that loses that race reads the winner's key, so
concurrent first uses agree. On a filesystem without hard links (`os.link` raising, e.g. `EPERM`) the
key is written in place with `O_CREAT | O_EXCL` and fsynced — still one winner — and a reader that
catches it half-written (empty, or a hex prefix) waits up to 0.5 s for the rest instead of calling it
corrupt. Only a file that reads successfully and is otherwise not 64 hex characters is replaced
(`hash_key_replaced`); any other read error — permissions, I/O — disables keying for now
(`hash_key_unavailable`, retried on the next hook) and never rewrites the file. Without a key the
digests are null — never a plain hash in their place (and `profile.updated` is not emitted at all,
nor recorded, until a key is available). The intention hashes stay plain SHA-256: they are join keys
with a producer outside the sandbox (the Index poller hashes the same Index fields). `reset.ts --wipe-user` stops the gateway, deletes the key with the rest of
`av-events/` (and the memory tool's `memories/USER.md` and `memories/MEMORY.md`), then restarts it. `Buffer.append`
recreates its directory if it disappears under a running process.

**Sanitiser.** Every string that leaves passes a secret-shape filter: Anthropic, OpenRouter and
OpenAI key shapes, `Bearer …`, the Telegram bot-token shape, and the literal value of our own
`AV_EVENTS_TOKEN`. This is a last line of defence behind the capture modes, not the privacy control.

**Tool-name allowlist.** `tool_categories.json` (`tool_categories_v1`) is the frozen seed; `_tools.py`
reads it once at import. `builtin` lists Hermes's own tools by registry name (the `v2026.8.31`
`_HERMES_CORE_TOOLS` set, plus `send_message`, `recall` and `record_intention`); `mcp.<server>` lists
an MCP server's tools, which Hermes registers as `mcp__<server>__<tool>` — so the allowlist is keyed
that way, and a bare `create_intent` from anywhere else is not Index. A listed tool leaves by name and
category; anything else leaves as `tool_name: null`, `tool_category: "other"`, so a third-party MCP
server's tool names never reach ingest. A missing or malformed seed lists nothing (everything
`other`). It moves together with the `agentvillage-data` seed of the same purpose.

---

## Events emitted

All carry `evidence_class: agent_report` — this plugin observes the agent, not the world, and ingest
downgrades anything stronger in any case (spec scenario 4) — **except `action.receipted`**, which
claims `provider_receipt` because it carries a checkable receipt (see "EdgeOS actions").
`event_id` is a uuid v7 (RFC 9562 §5.7, implemented here because the 3.11 stdlib has none) with a
monotonic counter in `rand_a`, so ids sort in emission order — **except `cron.run`**, whose id is
§4.3's derived uuid v5 (see "Cron capture"). Ingest refuses any other v5 from a plugin token.

`occurred_at` is when the thing happened, not when we buffered it: `llm.call` takes the API
request's `started_at` (with `occurred_at_earliest`/`latest` spanning the request), which under a
backlog can differ from `emitted_at` by minutes. Every `marts` time series is built on `occurred_at`.

| Event | Source hook | Payload |
|---|---|---|
| `session.started` | `on_session_start` | `source`, `cron_job_id` (from a `cron_<job>_<stamp>` session id, else null) |
| `session.ended` | `on_session_finalize` | `source`, `message_count`, `tool_call_count`, `input_tokens`, `output_tokens`, `duration_ms`, `cron_job_id`, `actual_cost_usd`, `cost_source`, `estimated_cost_usd`, `cost_status`, plus the hook stats below |
| `message.in` | `pre_llm_call` (`user_message`) | `channel`, `length`, `content_hash`, `flags` {`is_ask`, `is_recommendation`, `sentiment`}, `flags_rule`, `cron_job_id`, `silent` — see "Messages" |
| `message.out` | `post_llm_call` (`assistant_response`) | as above; `silent` is set on a cron run's reply |
| `tool.call` | `post_tool_call` | `tool_name`, `tool_category`, `args_hash`, `result_hash`, `ok`, `status`, `latency_ms`, `receipt`, `error_type`, `operation`, `target_system`, `category_version`, plus `args_length` / `result_length` above `metadata` — see "Tool calls" |
| `action.attempted` / `action.failed` | `post_tool_call` on an EdgeOS RSVP or cancellation | `action_class`, `target_system`, `receipt`, `execution_token_id`, `error`, `reverses_action_id`, `reversal`, `supersedes_action_id`, `operation`, `edgeos_event_id`, `occurrence_start`, `allowlist_version` — see "EdgeOS actions" |
| `action.receipted` | `post_tool_call` on the EdgeOS read that confirms it | as above, with `receipt` {`kind: edgeos_confirming_read`, `id`: participant id} |
| `cron.run` | the cron tail, on the flusher thread | `job_id`, `job_name`, `execution_id`, `status`, `input_tokens`, `output_tokens`, `claimed_at`, `started_at`, `finished_at`, `delivery_outcome` — see "Cron capture" |
| `profile.updated` | `on_session_finalize`, when a USER.md changed | `kind` ∈ `memory_profile`\|`landing_profile`, `user_md_hash`, plus `length` above `metadata` |
| `llm.call` | `pre_api_request` + `post_api_request` | `model`, `provider`, the five token buckets, `latency_ms`, `finish_reason`, `tools_hash`, `system_prompt_hash`, plus lengths above `metadata` |
| `llm.call` (failed) | `pre_api_request` + `api_request_error` | as above with `finish_reason: "error"`, `error_type`, `status_code`, `retryable`, and zeroed token counts |
| `prompt.registered` | `pre_api_request` | `hash`, `kind` ∈ `tools`\|`system_prompt`, `body`. `full` only, once per hash ever |
| `plugin.degraded` | the guard | `hook`, `scope` ∈ `session`\|`process`, `error_count`, `errors_by_hook`, `hermes_version`, `last_error` |
| `plugin.buffer_dropped` | the flusher | `reason`, `count`, `files`, `rejected_files`, `rejected_events`, `oldest_event_at`, `newest_event_at` |
| `intention.captured` | `post_tool_call` on Index `create_intent`, or `record_intention(action="capture")` | `text_hash`, `summary_hash`, `index_intent_id`, `source`, `conditional`, `capture_path`, `index_status`, `parent_session_id`, plus `text_length` / `summary_length` above `metadata` |
| `intention.updated` | `post_tool_call` on Index `update_intent` with a new `description`, or `record_intention` naming an id | as above |
| `intention.withdrawn` | `post_tool_call` on Index `update_intent` to `archived`/`deleted`/`withdrawn`, or `delete_intent`, or `record_intention(action="archive"\|"withdraw"\|"delete")` | as above; both hashes null |
| `memory.recalled` | `recall:memory.recalled` on the plugin event bus (published by `plugins/recall`) | `query_hash`, `hit_count`, `top_score`, `surface`; the hash and score are null in `metadata` — see below |
| `memory.snapshot` | the backup thread, after `on_session_end` (rate-limited) or `on_session_finalize` asked for a snapshot and both uploads succeeded | `bytes`, `file_count`, `content_hash`, `manifest_ref` — exactly `memory.snapshot@1`'s closed key set, the same in every capture mode — see "Memory snapshot" |

`prompt.registered` is content-addressed against a seen-set at `$HERMES_HOME/av-events/seen.json`,
so the same tool schemas register once and never again, across sessions and process restarts. The
hash is recorded **after** the event is buffered, never before: marking it seen first would lose the
body permanently whenever the emit turned out to be inert (no token yet, plugin disabled, unwritable
buffer) while every later `llm.call` still carried the orphaned hash.

`session.ended` carries the per-session hook stats — `hook_calls`, `hook_failures`, `hook_overruns`,
`hook_max_ms`, `slowest_hook`, `degraded`. That is the data source for the guardrails p95 latency
gate; without it the 50 ms budget is measured and then thrown away.

**`session.started` waits for a source.** Most hooks carry no `platform`, so a session opened lazily
by one of them holds `source = None` and defers the event until `on_session_start` (or any hook with
a `platform`) supplies one. Writing `"unknown"` at first sight would latch a value the real
`on_session_start` could no longer correct. If the source never arrives, `session_ended` forces the
pair out with `"unknown"`, so a `session.started`/`session.ended` pair is always well formed.

**`evidence_class` is `agent_report` for everything but `action.receipted`.** Note that spec §4.1
caps several of these types at `platform_record` while scenario 4 requires ingest to downgrade any
class a plugin token claims. The two disagree; this code follows scenario 4, which is the
enforceable one. `action.receipted` claims `provider_receipt` because §4.1's row says "provider_receipt
with receipt" and §2.1 honours it only for a checkable receipt (`action.*` type,
`receipt.kind = edgeos_confirming_read`, a non-empty string `receipt.id`) — which is exactly what the
event carries. `core.actions` still does not treat a plugin's own receipt as corroboration.

### Events from other plugins

An opt-in skill plugin reports through this plugin rather than growing its own buffer and token.
Hermes has a plugin event bus: `ctx.emit(name, payload)` publishes `<plugin>:<name>` (the namespace
is forced to the emitter, so one plugin cannot publish as another), and `ctx.subscribe(event, cb)`
delivers it as `cb(**payload)` on a host-owned worker thread, off the request path
(`hermes_cli/plugins.py` `emit`/`subscribe`/`_dispatch_event`/`_deliver_event` at `82e6c46`, the
last commit before 2026-09-01; by `0.21.3` / 2026.9.14 the last two moved to
`hermes_cli/plugins_dispatch.py`). `register()` subscribes only when `ctx.subscribe` exists.

Each subscription is wrapped in the same `guarded` decorator as the hooks, so the kill switches, the
failure breaker and the hook stats apply to it (`AV_HOOKS_DISABLED=memory_recalled` turns it off).
Its payload is **rebuilt from an allowlist**, never passed through:

| Bus event | Emits | Payload rule |
|---|---|---|
| `recall:memory.recalled` | `memory.recalled` | `query_hash` must be 64 lowercase hex characters (a publisher that sends the query itself is dropped, not hashed here); `hit_count` a non-negative int; `top_score` a finite number or null, rounded to 4 places; `surface` one of `telegram`, `desktop`, `cron`, `other`, `unknown` (anything else becomes `other`). `session_id` becomes the envelope ref. Every other field the publisher sends is discarded. In `metadata` capture `query_hash` and `top_score` are null; `hit_count` and `surface` stay. |

`memory.recalled` is not yet in the spec §4.1 catalogue; ingest quarantines an unknown type rather
than dropping it (§2.1), so the catalogue row and payload schema are owed before its data is usable.

---

## Intention capture

Spec §4.1 (`intention.captured/updated/withdrawn`) and §7.1 ("Intention capture"). An intention
exists only when a tool records it and the tool says it succeeded. The plugin does no
natural-language detection and runs no classifier (categories come from `intention.classified`,
server-side). Capture happens in `post_tool_call`; `pre_tool_call` is untouched (divergence 15).

**Which calls.** Hermes names an MCP tool `mcp__<server>__<tool>` (`tools/mcp_tool.py`,
`MCP_TOOL_NAME_PREFIX`, at `v2026.8.31`), and the installer names the Index server `index`, so the
Index tools arrive as `mcp__index__create_intent` and so on. The bare name is also accepted. A tool
of the same name on any other MCP server is ignored.

| Tool | Event | `intention_id` |
|---|---|---|
| Index `create_intent` | `intention.captured` | Index's intent id, read from the result; no id, no event |
| Index `update_intent` with a `description` | `intention.updated` | the `id` / `intentId` argument |
| Index `update_intent` whose argument status or result status is `archived`\|`deleted`\|`withdrawn` | `intention.withdrawn` | the argument |
| Index `update_intent` changing only the status | nothing | — |
| Index `delete_intent` | `intention.withdrawn` | the argument |
| `record_intention` | see the contract below | the argument, else (on a capture) the result's `intention_id`, else a uuid v7 minted here |

Only a call Hermes reports with status `ok` (or no status) records anything: `error`, `blocked`,
`timeout`, `cancelled` and any other status record nothing. An Index refusal records nothing
either. Index reports "too vague" as `{"success": false, …}` inside the tool's text while Hermes
reports `ok`, so the plugin unwraps the result and checks it: a `success` key, when present, must be
the boolean `true`, and any other value (`"false"`, `null`, `1`) rejects the call. An update or withdrawal that does not name
its intention is dropped.

**Reading an Index create.** The result is unwrapped from Hermes's `{"result": <text>}`, preferring
`structuredContent`. Hermes joins an MCP result's text blocks with `"\n"`, so the text is read line
by line: only a line that starts with `{` (after indentation) is tried, from there on, and the first
one that decodes is the payload. A `{` inside a sentence — "A good signal looks like {…}" — is never
read as a result. The payload must be an object whose `success`, if present, is `true`, and the
intent must be at `data.intent`, `data.intents` holding exactly one item, or `intent` at the top
(a `structuredContent` copy). Anything else — no readable id, several intents, an id on `data`
itself or at the top level — emits nothing. Plugin-minted ids are for `record_intention` only;
an Index create is joined downstream by its `index_intent_id`, so one without it is not captured.
A result over 256 KiB is not parsed at all.

**Source.** In a cron session every intention is `ambient` — the nightly memory-signal sync calls
`create_intent` with no participant in the loop. A cron session is one whose `on_session_start` said
`platform="cron"`, or whose id has Hermes's `cron_<job>_<stamp>` form (`cron/scheduler.py`), or a
subagent that a cron session delegated to, at any depth up to eight (from `subagent_start`).
Outside cron, Index calls are `message`. `record_intention` passes `message`, `onboarding` or `ambient`;
a missing or unknown value is `ambient`, the most restrictive. Hermes gives no session kind for
onboarding, so `onboarding` comes only from `record_intention`'s argument; an Index create during
the bootstrap ritual is `message`.

**Payload.** `text_hash` is SHA-256 over the exact text the agent recorded (Index `description`,
`record_intention` `text`); `summary_hash` the same over Index's `summary` from the result, or over
`record_intention`'s `summary`. Nothing is normalised, so the poller gets the same value when it
hashes the same Index field. `conditional` is null unless `record_intention` sets it. Not in §4.1:
`capture_path` (`index_tool` \| `record_intention`); `index_status`, stripped and case-folded and
limited to `active|archived|deleted|withdrawn|completed|unknown`, with anything else reported as
`other`; and `parent_session_id`, the session that delegated to this one when it is a subagent
(learned from `subagent_start`), else null. `text_length` and `summary_length` count characters
(Python `len`, code points), not bytes. Every key is always present, and null when unknown.

**No intention text in any mode, `full` included.** §7.1 says "with hashes only" and the
measurement catalogue says "text in the archive only". The training export reads text from the
archive (§8), not from events. For intentions, `full` sends exactly what `sanitized` sends.

**Ids.** Every id that goes into the envelope or the payload — `intention_id`, `index_intent_id`,
`tool_call_id` — must match `^[A-Za-z0-9._:-]{1,128}$`. An event whose `intention_id` or
`index_intent_id` does not is not emitted; the drop is counted in memory by field
(`Collector.intention_drops`) and the value is never kept. A `tool_call_id` that does not match is
set to null and the event kept, since Hermes supplies it, not the agent.

**Envelope.** `intention_id` is the funnel id (§4.2). `tool_call_id` is Hermes's. `run_id` is
`task_id` when it differs from the session id, as for `llm.call`. `parent_run_id` is null; the
delegating session is `payload.parent_session_id`. `occurred_at` is when the call returned, and
`occurred_at_earliest` is that time minus the call's `duration_ms`.

**No dedupe on `tool_call_id`.** Hermes fires `post_tool_call` once per execution, and some
providers (llama.cpp) return the same `tool_call_id` for every call, so every successful call
emits. Ingest dedupes on `event_id` (scenario 1): a uuid v7 fixed when the event is buffered, which
a retried flush resends unchanged. A plugin-minted `intention_id` is fixed at the same moment.

**`record_intention` contract.** The tool itself is not in this repository; the plugin only
observes calls to it, whatever the server prefix.

| `action` | `intention_id` argument | Event |
|---|---|---|
| `capture` | absent | `intention.captured`, id from the result's `intention_id`, else minted |
| `capture` | present | `intention.updated` |
| `update`, or absent | present | `intention.updated`, if `text` or `summary` is given; otherwise nothing |
| `archive`, `withdraw`, `delete` | present | `intention.withdrawn` |
| absent, `update`, `archive`, `withdraw`, `delete` | absent | nothing |
| anything else | either | nothing |

Other arguments: `text` (or `description`), `summary`, `source` ∈ `message|onboarding|ambient`,
`conditional`, and `index_intent_id` when the Index copy's id is known. **The tool must return
`intention_id` to the agent** — as `intention_id` at the top of its result or under `data` — because
the agent needs it for every later update or withdrawal, and the plugin cannot hand it back: a
`post_tool_call` observer's return is discarded. An id the plugin mints is recorded in the event and
nowhere else.

---

## Tool calls

Spec §4.1 `tool.call` and §7.1 "Sanitization". One `tool.call` per `post_tool_call`, for every
tool, before any `action.*` or `intention.*` the same call implies.

- **Name.** Only an allowlisted name leaves (see "Tool-name allowlist"); otherwise `tool_name` is
  null and `tool_category` is `other`.
- **Arguments and results.** `args_hash` is the keyed hash (HMAC-SHA256, see "Keyed hashes") of the
  canonical JSON of `args` (the same canonicalisation as `tools_hash`); `result_hash` of the result
  string as Hermes handed it.
  `args_length` / `result_length` count characters of those same strings. In `metadata` all four
  are null or absent. An argument that cannot be serialised hashes to null rather than failing.
- **Status.** Hermes's `status`, case-folded, one of `ok|error|blocked|timeout|cancelled`, `other`
  for anything else, null when absent. `ok` is true for `ok` or no status. `error_type` leaves only
  when it looks like a class name; `error_message` never does.
- **Refs.** `tool_call_id` is Hermes's, nulled if it fails the id pattern; `run_id` as for
  `llm.call`; `occurred_at` is when the call returned and `occurred_at_earliest` that minus
  `duration_ms`.
- **Isolation.** The `tool.call`, the EdgeOS path and intention capture are isolated from one
  another inside the hook: an exception in one is counted against the breaker like any hook
  failure and does not cost the others their events.

## Messages

Spec §4.1 `message.in/out`. `pre_llm_call`'s `user_message` is `message.in`, `post_llm_call`'s
`assistant_response` is `message.out`, once per turn each. Never the text, in any mode.

| Session | `message.in` actor | `channel` |
|---|---|---|
| a conversation | `participant` | the session's `source` (`telegram`, `desktop`, …) |
| cron (`platform="cron"`, a `cron_<job>_<stamp>` id, or a subagent of one) | `system` — the "user message" is the job's prompt | `cron`, with `cron_job_id` |
| a delegated subagent | `agent` — the "user message" is the delegator's goal | `subagent` |

`message.out` is always `actor: agent`. A channel that does not look like a platform name is
reported as `other`. `sender_id` is never read.

`length` (characters) and `content_hash` (the keyed hash of the exact text) are present above
`metadata`. **`silent`** is set only on a cron run's `message.out`: true when the reply is Hermes's
silence marker (`[SILENT]`, `SILENT`, `NO_REPLY`, `NO REPLY` as the whole reply, alone on its first or
last line, or `[SILENT]` opening it — `is_autonomous_silence_response` at `v2026.8.31`), i.e. nothing
was delivered. It is a delivery fact, not content, and rides in every mode; elsewhere it is null.
**`flags` are structural, not semantic** (`flags_rule: message_flags_v1`): `is_ask` is true when the
message, with URLs removed, contains a `?` that ends a sentence. `is_recommendation` and `sentiment`
are always null — detecting them is natural-language classification, which the plugin does not do
(the same stance as intentions: categories come from server-side jobs over archived text). A later
rule is a new `flags_rule`. In `metadata` every flag is null. A non-string message (a multimodal
list) has no length, hash or flags.

## EdgeOS actions

Spec §4.1 `action.attempted/receipted/failed`, §2.1's receipt allowance, measurement catalogue
"Act on intentions (RSVP)".

**How the plugin sees an RSVP.** There is no EdgeOS tool. The `edgeos` skill tells the agent to run
`curl` through Hermes's `terminal` tool (`skills/edgeos/SKILL.md` §6). `edgeos_tool_allowlist.json`
(`edgeos_tool_allowlist_v1`) names the carrier tools (`terminal`), the host (`api.edgeos.world`),
and each operation by method and path. Line continuations (backslash-newline) are joined first —
the skill's own recipes are multi-line, and `tests/test_edgeos_skill_recipes.py` feeds every §6
recipe verbatim. The command is then tokenised as a shell would (`shlex`, with control operators
and newlines split out) and read only when it is unambiguous:

- trailing whitespace is dropped first (a final newline runs nothing);
- **every** http(s) URL in the command — the request target, headers, other options, anything before
  the curl — is on the EdgeOS host, with no userinfo and no port other than `:443`. The one exception
  is a request body: a URL inside the value of `-d`, `--data`, `--data-raw`, `--data-binary` or
  `--json` is content (a `picture_url`), not a place the request goes, so it is not read. `-F` is
  not a body in this sense (`-F x=@file` reads a file);
- exactly one `curl` word, and it starts a command (`echo curl …` and a `for` body are not requests);
- after a **write** (anything but GET) nothing follows it: no `;`, `&&`, `||`, `|`, redirect or new
  line — each could run a second request or rewrite what the agent saw as the response;
- after a **read** (GET) only these may follow, in order: `2>&1`, a `| jq …` pipeline (arguments
  only, no further operator), trailing newlines. A read whose output went through `jq` is labelled
  but **never confirms** an action: its output is what the agent made of the response, and
  `jq '.my_rsvp_status = "registered"'` would otherwise forge a receipt;
- no command substitution (`$(…)`, backticks) anywhere;
- no option that moves the request or drops the host check: `--resolve`, `--connect-to`,
  `-x`/`--proxy` (and the SOCKS/pre-proxy/DoH forms), `-K`/`--config`, `-k`/`--insecure`;
- curl's own arguments give exactly one URL (`--url` or positional; the same URL twice is two), and
  every EdgeOS URL in the command names that same path;
- the method is curl's: `-X`/`--request` wins; else `-G`/`--get` is GET; else `-T` is PUT; else
  `-d`/`--data*`/`--json`/`-F` is POST; else GET. Combined short flags are read the way curl reads
  them (`-sX POST`, `-sXPOST`, `-sSfL`), and an option that takes a value consumes it;
- path parameters are UUIDs.

**Known misses**, all conservative (the call is just a `tool.call`): a body built by command
substitution (`-d "$(cat body.json)"`; the skill does not do this); a curl through `execute_code` or
another tool. Every recipe in the skill's §3, §6, §8 and §9 is recognised
(`tests/test_edgeos_skill_recipes.py`).

Anything else is just a `tool.call`. A recognised call labels its `tool.call` with `operation`
(`edgeos.rsvp`, `edgeos.event_read`, `edgeos.profile_read`, …) and `target_system: "edgeos"`; the
command, its headers (the API key) and the response body never leave.

| Operation | Role | Emits |
|---|---|---|
| `POST …/event-participants/portal/register/{event_id}` | action, `rsvp` | `action.attempted` (fresh uuid v7 `action_id`); plus `action.failed` on the same id when the call failed |
| `POST …/event-participants/portal/cancel-registration/{event_id}` | action, `cancel_rsvp` | as above, with `reversal: true` and `reverses_action_id` = the last RSVP that landed for that occurrence, if known |
| `GET …/events/portal/events/{event_id}` and `GET …/events/portal/events` | confirming read | `action.receipted` for each waiting action the read confirms |
| directory, profile, venues, participants, event writes | read / write | nothing beyond the `tool.call` label |

**Positive evidence only.** An action waits for a confirming read only when EdgeOS answered with the
participant record — a JSON object with a UUID `id`, no `detail`/`error`, and (when it names one)
this event's `event_id`. A gateway error page, an empty body, `{}` or `{"message": …}` is not
evidence the action landed: the attempt is reported and nothing waits on it, so a read that finds
the participant registered some other way (the portal, an earlier RSVP) can never be claimed as this
action's receipt.

**Failure.** Hermes status not `ok` → `error: "tool_<status>"`; a non-zero `curl` exit code →
`exit_nonzero`; a JSON body with `detail`, `error` or `message` and no `id` → `edgeos_error`. Fixed
labels only: EdgeOS's own error text can echo the request. A failed action never waits for a
receipt and is never what a later cancellation reverses.

**Occurrences.** Waiting actions are keyed by EdgeOS event id and occurrence start: the record's
`occurrence_start` (null for a one-off event), normalised to UTC; a record whose `occurrence_start`
is not a timestamp with a zone is reported but waits on nothing. A single-event read confirms the
occurrence named by its `occurrence_start` query parameter (a literal `+` is an offset, not a space);
without one it confirms the one-off action if one is waiting, else the event's only waiting
occurrence, and nothing when two or more are waiting. An item of a list read that belongs to a
recurring series is keyed by its `start_time`. A re-RSVP to an occurrence with an RSVP already waiting **supersedes** it: the new
`action.attempted` carries `supersedes_action_id`, and the earlier attempt is never receipted.

**Confirmation.** A later successful read whose event object carries `my_rsvp_status` confirms a
waiting action: `registered` or `checked_in` confirms an RSVP; `cancelled` confirms a cancellation,
and a null status confirms one only when the plugin saw the RSVP it reverses (otherwise "not
registered" may simply mean "never was"). Anything else, or an object without the key, confirms
nothing and the action keeps waiting. The `action.receipted` event reuses the action's id, carries
`receipt: {kind: "edgeos_confirming_read", id: <participant id>}` — the record the RSVP or
cancellation created, which a checker re-reads with `GET /event-participants/{id}` — and claims
`provider_receipt`. The read's own `tool.call` carries the same `receipt` when it confirmed exactly
one action.

**Ledger.** `$HERMES_HOME/av-events/edgeos_actions.json`, 0600: the waiting actions and, per
occurrence, the last action of each class that landed. It is changed and written only **after** the
events that change it are buffered, so an inert emit never leaves a receipt waiting on an action no
event describes. Every entry is validated on load and a malformed one is dropped (never raised); at
most 256 occurrences; a wait expires after 7 days. The whole ledger runs under the collector lock,
since Hermes can run tool calls concurrently.

**Reversal.** Every event on a cancellation — attempted, failed and receipted — carries
`reversal: true` and `reverses_action_id`; every RSVP event carries `reversal: false` and null.
`core.action_action` links a compensation only on `reversal = true` or differing classes, so both
are always set explicitly. A cancellation of an RSVP the plugin never saw is still `reversal: true`,
with `reverses_action_id: null`.

Actions are emitted in every capture mode: they carry ids and fixed labels, nothing a participant
wrote. In `metadata`, `edgeos_event_id` and the receipt's participant id (on `action.receipted` and
on the read's `tool.call`) are replaced by their keyed hashes: joins within a tenant still work, but
**the receipt is not checkable in `metadata`** — nobody outside the sandbox can re-read a hashed id.
`sanitized` and `full` keep both ids in clear. The event still claims `provider_receipt`, but ingest
stores a receipt whose id is a keyed hash at `agent_report`, not `provider_receipt`: a `metadata`
tenant's RSVPs are recorded as receipted actions without receipt-grade evidence (divergence 31).

## Cron capture

Spec §4.1 `cron.run`, §4.3, §7.1 "Cron capture". Hermes has no cron hook, so the flusher thread —
never a hook — reads what the scheduler writes, once a minute, read-only:

- `$HERMES_HOME/cron/executions.db` (`cron/executions.py`): every execution in a terminal state
  (`completed`, `failed`, `unknown` — immutable once written) that has not been reported. Its
  `error` text is never read. An execution that finished more than 72 hours ago is skipped: ingest
  would clamp it, and on a first run it is history.
- `$HERMES_HOME/cron/usage_audit.jsonl` (`cron/scheduler.py` `_write_usage_audit`): `prompt_tokens`
  / `completion_tokens` become `input_tokens` / `output_tokens`. An audit line has no execution id,
  so it is joined only when it is the **one** line for that job whose `ts` falls inside the
  execution's window (±2 s); otherwise both are null. The last 512 KiB is read, and only when there
  is something to report.
- `$HERMES_HOME/cron/jobs.json`: `job_name`, **only when it is exactly one of the names the
  installer creates**, from the frozen seed `cron_job_names.json` (`cron_job_names_v1`;
  `install/tests/av_events_state.test.ts` fails if it drifts from `DIGEST_CRON_SPECS`). A prefix check
  is not enough: a participant can have the agent schedule a job named `Edge — …` too, and its name
  is then their words. `cron.run` is on the ops allowlist and kept without research consent (spec
  §2.2), so it carries nothing a participant wrote. Every other job has `job_name: null`.
- `delivery_outcome`: Hermes's own `delivery_outcome` column when the ledger has one (`queued`,
  `delivered`, `failed`, `suppressed` — the reply was the silence marker —, `suppressed_acked`,
  `not_configured`; anything else is `other`). **The column does not exist at `v2026.8.31`** (Hermes
  computes the outcome but only hands it to its monitoring), so on the pinned tag it is null; the
  ledger is read with `SELECT *` so a later tag fills it without a plugin change.

Timestamps are Hermes's local-offset ISO strings, normalised to UTC. `occurred_at` is `finished_at`,
`occurred_at_earliest` the start (or claim). `run_id` is `cron:<job_id>:<execution_id>` — Hermes's own
task id for the run, so `cron.run` joins the run's `llm.call` and `tool.call` rows. `actor: system`.

**Event id.** `uuid5(NS_AV, "{tenant_id}|cron|{execution_id}")`, exactly what ingest's
`pluginEventIdProblem` recomputes from the token's tenant (`agentvillage-data/src/ingest/events.ts`);
any other v5 is quarantined. The tenant id comes from `TENANT_ID` / `AV_TENANT_ID`, lower-cased as
ingest lower-cases it (an upper-case UUID in the env gives the same id). With it, a
re-read, a second process tailing the same ledger or a lost cursor all produce the same id and ingest
keeps one row. Without it the id is a uuid v7 and the cursor is the only dedupe. A `TENANT_ID`
that is not a UUID is counted in `Collector.counters["tenant_id_not_uuid"]` and logged once per
process as that counter (never the value): ingest would quarantine every `cron.run` built from it.

**Cursor.** `$HERMES_HOME/av-events/cron_cursor.json` holds the execution ids already reported (the
last 4096; Hermes keeps 1000 terminal rows). An id is added only after its event is buffered, so an
inert emit is retried on the next pass. The tail is off with the plugin, and individually with
`AV_HOOKS_DISABLED=cron_run`; a pass that raises is counted in `Collector.cron_errors` and never
stops the flusher.

## Session close: cost and profile

`on_session_finalize` emits `session.ended` and then, if USER.md changed, `profile.updated` — in that
order, so nothing the profile check does can cost the session its end event.

**Cost.** Hermes keeps per-session cost in `$HERMES_HOME/state.db`, table `sessions`:
`actual_cost_usd`, `estimated_cost_usd`, `cost_status`, `cost_source` (`hermes_state.py`). The plugin
reads that one row read-only with a 50 ms lock timeout and puts the four values on `session.ended`
under the same names. `actual_cost_usd` is §4.1's field and is what `core.cost_facts` sums; Hermes
fills it only when a provider reports a real charge, and **an estimate is never promoted to
actual**. `cost_source` / `cost_status` are Hermes's labels, passed only when they look like labels.
A busy, missing or corrupt database leaves all four null.

**Profile.** Two files, told apart by `kind`: `memory_profile` is `$HERMES_HOME/memories/USER.md`,
what Hermes's memory tool keeps about the user; `landing_profile` is `$HERMES_HOME/USER.md`, what the
landing's enrichment wrote (the control-plane sidecar's `USER_FILE`, and the installer's
`targetWorkspace()`; `~/.hermes/USER.md` when `HERMES_HOME` is the default). Each `profile.updated`
carries `kind`, `user_md_hash` (the keyed hash of the file's bytes) in every mode — `core.tasks` keys
on it within the tenant —
and `length` (characters) above `metadata`. Each is emitted on first sight and whenever its hash
changes; the last hash sent per kind is kept in `$HERMES_HOME/av-events/profile.json` only after the
event is buffered. A file over 1 MiB is not read. **Timing (accepted for v1):** `profile.updated`
fires at session finalize, so a long session collapses many edits into one event, and a gateway
that is killed rather than finalized reports none for that session. **Catalogue:** §4.1 has one `profile.updated` row
with `user_md_hash`, `length`; it needs `kind` added, and `core.tasks.profile_hash` must say which
kind it means (presumably `memory_profile`, the one that evolves during the experiment).

## Memory snapshot (DATA-82)

A Railway sandbox has no volume, so a recreate loses the agent's memory. The archive holds sessions,
not the distillation (`MEMORY.md`) or the daily notes. The plugin backs up those files, and
`install/restore-memory.ts` puts them back on a recreated sandbox before the gateway starts.
Everything here is **off the product path**: a failure anywhere is a counter, never the session's.

**When.** Two triggers, both of which only set a flag and, if no snapshot thread is running, start
one daemon thread (`av-events-backup`):

- **Every turn**: `on_session_end`, which Hermes fires once per user message (divergence 4). This is
  the trigger that keeps the backup current. A gateway's conversations are usually never finalized:
  a Telegram chat just goes quiet.
- **Every session finalize**: `on_session_finalize`, after `session.ended` and `profile.updated`.
  Its pass runs at once: a waiting thread is woken.

**Scheduling.** Every request is covered by a pass that starts at least `AV_BACKUP_GRACE_S`
(default 90 s) after it. Hermes's background memory review writes `memories/MEMORY.md` and
`USER.md` a few seconds after `on_session_end`, and a pass that ran at once would miss those writes
whenever the chat then went quiet. The next pass is due at `max(last pass + AV_BACKUP_MIN_INTERVAL_S
(default 300 s), earliest uncovered request + AV_BACKUP_GRACE_S)`. The *earliest* request fixes the
due time, so a busy chat cannot push the pass back indefinitely. A pass covers every request at
least a grace old. A younger one is owed a trailing pass, so there is always one after the last
turn, including after a finalize's immediate pass. The thread runs until nothing is owed, and there
is never a second thread. An unchanged workspace uploads nothing, so a pass is a read and a hash.

**Exit.** Hermes has no shutdown hook at `0.21.3` (`VALID_HOOKS`). **The gateway exits through
`os._exit`** (`gateway/run.py` `_exit_after_graceful_shutdown`), which runs no `atexit` handler at
all. Gateway shutdown finalizes open sessions (`gateway/run_shutdown.py`), so a pass is requested,
but the daemon thread dies with the process wherever it has got to. In a gateway, then, **the backup
is exactly as current as the last completed turn-triggered pass**, and the grace and interval above
are what bound its lag. The exit drain (`Collector.shutdown`) matters only in a CLI or desktop
process that exits normally. There it joins the snapshot thread for at most 10 s (`EXIT_BUDGET_S`)
before the final event flush. The pass runs on that thread, never the exiting one, so a hung upload
costs the exit 10 s and no more. If a request is pending and no thread is alive, one is started if
the interpreter allows it. Python 3.12+ refuses new threads at shutdown; the snapshot is then
skipped and counted as `backup_exit_skipped`.

**What.** A fixed allowlist relative to `$HERMES_HOME`, never a directory walk:

| Path | Written by |
|---|---|
| `MEMORY.md`, `USER.md` | the workspace: the agent's curated memory, and the profile the landing's enrichment wrote |
| `memories/MEMORY.md`, `memories/USER.md` | Hermes's memory tool (`tools/memory_tool.py`, `get_memory_dir()`) |
| `memory/YYYY-MM-DD.md` | daily notes: `re.fullmatch(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\.md", name)`. ASCII digits only, and the whole name, so no trailing newline. `install/restore-memory.ts` applies the identical rule, and both suites read `tests/vectors/daily_note_names.json`; a name only one side accepted would make every restore of that snapshot refuse |

Never included: `.recall/` (derived data, rebuilt from these files), `av-events/` (this plugin's
state, `hash.key` among it), JSON ledgers (`memory/heartbeat-state.json`, …), non-daily markdown under
`memory/` (drafts such as `digest-outgoing.md`), and any other file. The following are skipped and
counted (`backup_skipped_<reason>`): a symlinked file (`O_NOFOLLOW`), a file under a symlinked
`memory/` or `memories/`, a hard-linked file (`st_nlink > 1`, as recall does), a FIFO or directory
wearing a memory file's name, and a file over 4 MiB.

**Budget.** Collection reads at most `AV_BACKUP_MAX_BYTES` (default 32 MiB) of file bytes. The order is
the four fixed files, then daily notes newest first. Once a file would not fit, nothing more is
read, and every remaining candidate is skipped as `over_budget`, so the oldest notes are the ones
left behind. Any skip makes the snapshot **partial**. The manifest says so (`partial: true`,
`skipped: {count, reasons: {<code>: n}}`: reason codes and counts, never a file name), and so does
restore's output. The event stays the registered closed key set; `backup_skipped` and
`backup_skipped_<reason>` count it in the sandbox.

**How.** The files go into one USTAR `tar.gz`, built deterministically: entries sorted, every tar
field but the path and the bytes zeroed, gzip `mtime=0` and the gzip OS byte pinned to 255. Python
3.12+ may otherwise take the platform's value from zlib. The same files give the same bytes whatever
their mtimes or the clock. The archive's SHA-256 is `content_hash`. It is PUT first, then the
manifest that names it, to `{AV_BACKUP_URL}/v1/backup/<tenant>/<YYYY-MM-DD>/<name>` with
`Authorization: Bearer $AV_BACKUP_TOKEN`:

- `memory.<content_hash>.tar.gz`;
- `manifest.<sha256 of the manifest>.json`: canonical JSON `{schema: "memory_manifest.v1",
  tenant_id, date, created_at, plugin_version, archive: {name, sha256, bytes}, file_count,
  total_bytes, partial, skipped: {count, reasons}, files: [{path, sha256, bytes, mtime_ms}]}`.

Each PUT has a 30 s wall-clock budget, enforced by a watchdog that shuts the socket down. A socket
timeout alone bounds each read, not the request, and a server that trickles a byte a second would
otherwise hold the thread indefinitely. Redirects are not followed.

**The URL.** `AV_BACKUP_URL` is read from the **process environment only**, never the
`$HERMES_HOME/.env` fallback every other variable has. The agent can write that file, and the backup
token goes wherever the URL points. The URL must be https, or plain http only to
`*.railway.internal` or the local machine, with no userinfo, query or fragment. Any other value
disables snapshots and is counted as `backup_url_refused`.

The route stores both under `backup/<tenant>/<date>/` in the archive bucket. That prefix is kept
apart from the research archive's `<tenant>/<date>/`. The route contract (PUT and GET, the
`backup_write` token, idempotency, size cap, withdrawal) is **DATA-93** in `agentvillage-data`. The
tenant is `AV_TENANT_ID` or `TENANT_ID` **exactly as given**, not lower-cased as `cron.run`'s is,
because the route derives the token from that string. A tenant id that cannot be a bucket key
segment disables snapshots.

**Unchanged means nothing.** `$HERMES_HOME/av-events/backup.json` records the last snapshot's
`content_hash`, manifest hash and destination (a hash of URL and tenant, never the URL). A pass whose
archive hashes the same, with the same skips, to the same destination, uploads nothing and emits
nothing. "The same" is the pair `(content_hash, skipped {count, reasons})`. The manifest itself
carries `created_at` and so is never byte-stable. A new file that is skipped (too large, say)
leaves the archive unchanged but makes the snapshot partial, and the latest manifest must say so.
The route keeps what it has accepted. `backup.json` remembers the archive hashes the current
destination has accepted **under the current UTC date's prefix** (the last 64), and such an
archive is never PUT again that day. The same archive with new skips therefore costs one manifest
PUT. The memory is per date because a manifest names an archive in its own date's prefix: restore
fetches from there, and the route answers 409 `archive_missing` otherwise. After UTC midnight, or on
a revert to an earlier day's content, the archive is PUT again under the new date. If the route
still answers the manifest with 409 (a purged prefix, a record the plugin should not have
trusted), the hash is forgotten and the archive and manifest are re-sent at once
(`backup_archive_missing`). A second failure takes the normal backoff.

A workspace with no memory files at all uploads nothing: an empty snapshot would become "latest"
and a recreate would restore nothing over a real backup.

**After a failed restore.** `install/restore-memory.ts` writes `av-events/restore.json` with
`workspace_empty`: whether none of the memory files existed before it ran. Uploads are blocked
(`backup_blocked_by_restore`) only after an `error` on an **empty** workspace. There the sandbox
does not hold the tenant's memory, and a snapshot of what is there would become "latest" over the
real backup. A refusal on a populated workspace blocks nothing: what is there is the memory. The
block lifts 24 hours after the marker's `at` (`backup_block_expired`), or at once when a later
restore succeeds or an operator removes the marker. A marker without a readable `at`, or dated in
the future, counts as expired. **The agent can write this file too**; that only ever affects its
own tenant's backups, and never for more than 24 hours per write.

A `created_at` read back from `backup.json` must be an ISO-8601 UTC timestamp before it can become
an owed event's `occurred_at`; a record that fails any check is ignored.

**The event.** `memory.snapshot` is emitted once both PUTs return 2xx. Its payload is
`{bytes: total of the files' sizes, file_count, content_hash, manifest_ref: "backup/<manifest
sha256>"}`, exactly `memory.snapshot@1`'s closed key set, with `agent_report` and `occurred_at` =
the snapshot's `created_at`. `bytes` is file bytes, not archive bytes, so it is the same quantity
`memory.restored.bytes` reports. The backup does not need `AV_EVENTS_TOKEN`. When the emit is inert
(no token, the plugin off), `backup.json` records `emitted: false`, and a later pass emits the owed
event without uploading again.

**Failure.** Any non-2xx or network error is `backup_upload_failed`, and no snapshot is recorded
as done. Consecutive failures back off exponentially: 5 min, doubling, capped at 6 h
(`BACKOFF_BASE_S`, `BACKOFF_MAX_S`), reset by a success. A 401 holds off at least an hour
(`backup_upload_401`: a wrong or rotated token an operator may fix). A 403 holds off at least
24 hours (`backup_forbidden`): the route refuses a withdrawn tenant (DATA-93). A 403 also clears
`backup.json` (the last upload and the accepted archive hashes), because withdrawal deletes the
tenant's prefix and none of it holds any more. After a re-consent the first pass past the cooldown
uploads whatever is there, archive and manifest, even if the files never changed. A 401 or a 5xx
says nothing about what the route holds and clears nothing. An archive over `AV_BACKUP_MAX_BYTES` is
`backup_too_large`. Any exception is `backup_error`. Each counter is logged once per process as a name and a count, never a path or a
value. The hook breaker never counts a backup failure. **Switches**: unset `AV_BACKUP_URL` (or
the token, or the tenant), `AV_EVENTS_ENABLED=0`, or `AV_HOOKS_DISABLED=memory_snapshot`.

**Restore.** The control plane runs `bun install/restore-memory.ts --tenant <id>` (same
`AV_BACKUP_URL` / `AV_BACKUP_TOKEN`, `HERMES_HOME`) on a recreated sandbox before the gateway starts.
It fetches `GET …/v1/backup/<tenant>/latest` (or `--manifest <date>/manifest.<sha>.json` for an older
one). Before writing anything it verifies the manifest against its key, the archive against the
manifest, and every file's SHA-256, size and path against the allowlist. Any mismatch refuses the
whole restore. It never overwrites a local file newer than the snapshot's copy unless `--force`.
Writing is two-phase. Every file is first staged to a temp name in its own directory, with the
snapshot's mtime. Only when all are staged is each renamed into place. A write error is
`status: "error"`, `reason: "write_failed"`, with the counts of what was renamed; a staging error
renames nothing. The script prints one JSON line (`status`, `snapshot_ref`, `bytes`, `file_count`,
`partial`, …), from which the control plane emits `memory.restored`, and emits nothing itself. It
writes `$HERMES_HOME/av-events/restore.json` (`status` ∈ `restored|none|error`, the manifest key).
`--dry-run` prints `status: "dry_run"` and writes nothing.

**For the control plane:**

- **Do not start the gateway on a restore `error`.** The sandbox then lacks the tenant's memory. On
  an empty workspace the marker stops the plugin from uploading over the real backup for 24 hours,
  but a running agent would start writing new memory on an empty slate. After the 24 hours it would
  upload that slate as "latest"; older snapshots stay in the bucket and `--manifest` restores one.
- Run the restore before anything writes a fresh `USER.md`: a template written after the snapshot
  is "newer" and would be kept.
- `reset.ts --wipe-user` removes `av-events/` (with `backup.json` and `restore.json`) and both
  `memories/` files, so a new user does not inherit the previous user's backup state.

**Consent (draft for Timour, spec 1.2 §2.2-d).** The memory files are the attendee's own data,
kept under operational scope, and withdrawal deletes the tenant's `backup/<tenant>/` prefix. Proposed
line for the consent brief:

> Your agent's memory files are backed up to restore your agent if its sandbox is rebuilt;
> withdrawal deletes them.

---

## Fail-open contract

Implements `launch-guardrails-draft.md` §2 and spec scenario 25.

- **Every hook body is wrapped in one decorator** (`_collector.guarded`). It catches `BaseException`
  — a `MemoryError` from our hook must not take the turn loop either — re-raising only `SystemExit`,
  because swallowing a shutdown would be worse than losing an event.
- **Ten failures in a session** (counted across all hooks) disable the plugin for that session and
  emit exactly one `plugin.degraded` with `scope: session`. Other sessions are unaffected.
  The counter and the degraded flag live on the session, not the collector: a Hermes process
  interleaves sessions freely (subagents, cron, a Telegram conversation), and a shared counter is one
  that unrelated traffic can reset — alternating session ids could otherwise outrun the breaker
  indefinitely.
- **Fifty failures across the process**, regardless of session, disable the plugin entirely and emit
  one `plugin.degraded` with `scope: process`. This is the backstop for churn that no per-session
  breaker can catch, such as every failure landing on a fresh subagent id.
- **`pre_tool_call` does no I/O at all.** Hermes fails *closed* on that hook, so it skips the config
  reload, never opens a session lazily, and never writes to the buffer; a `plugin.degraded` it
  triggers is queued and written by the next hook that is allowed to. An unknown session is simply
  not counted — a missing tool-call count is worth far less than a tool call that never ran.
- **50 ms budget per hook**, measured with `time.perf_counter`. Overruns are *counted, never
  enforced*: aborting a hook halfway is worse for the agent than a slow one. Counts live in
  `collector.overruns`.
- **No network in a hook, ever.** Hooks hash and append a line; a daemon thread does all network
  I/O and the cron tail. The only other file I/O a hook does is bounded and local: at session close,
  one read-only row from `state.db` (50 ms lock timeout) and a read of each USER.md (≤ 1 MiB); on an
  EdgeOS RSVP or its confirming read, one small ledger write; and once per tenant, ever, the creation
  of `hash.key` (then cached in memory). A memory snapshot is only *requested* in a hook (a flag and,
  at most, a thread start); its reads, compression and uploads happen on the backup thread.
  `on_session_end` and `session.ended` only *wake* the flusher. `ingest` being down changes nothing
  the agent can observe (spec scenario 24).
- **Hooks never return a value.** The decorator discards whatever the body returns, so this plugin
  structurally cannot block a tool call, inject context into a user message, or rewrite a response.

### Buffer

Append-only JSONL under `$HERMES_HOME/av-events/buffer/`. Each process appends to its own
`current-<pid>.jsonl`, rotated to a `<epoch_ms>-<pid>-<seq>.jsonl` batch after 50 events or 10
seconds. The name carries the timestamp of the batch's *first* event, so a batch left behind by a
crashed process is self-describing and still recoverable.

A line is encoded before the file is opened, so one that cannot be encoded raises with nothing
written, and the file descriptor is closed exactly once.

Directories are created `0o700` and files `0o600` — this is per-tenant telemetry sitting in the
agent's home directory.

The flusher POSTs each batch to `{AV_EVENTS_URL}/v1/events` with `Authorization: Bearer
$AV_EVENTS_TOKEN` and body `{"events": [...]}`, at most **5 files per pass** so a large backlog
cannot turn one tick into a long blocking walk.

A batch is retried only when retrying could ever work: network failures, 5xx, and 408/425/429. It
backs off exponentially (2 s doubling, capped at 300 s between attempts) until it is **72 hours
old**, at which point it is deleted. Any other 4xx — 400, 401, 403, 413, 422 — is a statement about
this batch or this token that will not change on its own, so the file is moved to
`buffer/rejected/` and never offered again. It is *kept* rather than deleted: a 401 or a 413 is a
misconfiguration a human needs to see, and deleting the evidence would hide it.

Either way one `plugin.buffer_dropped` is emitted on the next successful flush, carrying `reason`
(`expired`, `rejected`, or both), `files` / `count` for expiries and `rejected_files` /
`rejected_events` for refusals.

Shutdown is a daemon thread plus an `atexit` hook that force-rotates and makes one bounded
(5 second) attempt at each pending batch. Anything it cannot send survives on disk.

**Known issue: the gateway never runs that hook.** Hermes's gateway exits through `os._exit`
(`gateway/run.py` `_exit_after_graceful_shutdown`, #53107), which bypasses `atexit`. In a gateway,
the last up-to-10-second batch (`current-<pid>.jsonl`, not yet rotated) and any rotated batch not
yet sent are left on disk, to be sent by the next process on the same disk. On a sandbox recreate
there is no next process on that disk, and they are lost: typically the `session.ended` of the
sessions the shutdown finalized. The flusher's own 1-second tick narrows the window but does not
close it. This predates DATA-82 and is ticketed separately; the memory snapshot does not rely on
`atexit` (see "Memory snapshot").

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
| `post_api_request` | `agent/conversation_loop.py:6993` | `api_request_id`, `usage`, `api_duration`, `finish_reason`, `response_model`, `assistant_content_chars`, `assistant_tool_call_count`, `provider`, `api_mode`, `started_at`, `ended_at` |
| `api_request_error` | `run_agent.py:3130` | `api_request_id`, `error` (`{"type","message"}`), `status_code`, `retryable`, `retry_count`, `api_duration`, `started_at`, `ended_at`. Fired **instead of** `post_api_request` on a terminal failure |
| `pre_tool_call` | `hermes_cli/plugins.py:6636` | `tool_name`, `args`, `session_id`, `task_id`, `turn_id`, `tool_call_id`, `api_request_id` |
| `post_tool_call` | `model_tools.py:1220` | as above plus `result`, `duration_ms`, `status`, `error_type`, `error_message`. `tool_name` is the registry name (`mcp__index__create_intent`). `args` reflects any `modify` directive. `result` is a string, and for an MCP tool it is JSON `{"result": <text>, "structuredContent"?: …}` (`tools/mcp_tool.py`). `status` ∈ `ok`\|`error`\|`blocked`, plus `timeout`\|`cancelled` on an interrupted call. `terminal`'s result is JSON `{"output", "exit_code", "error"}` (`tools/terminal_tool.py`) |
| `subagent_start` | `tools/delegate_tool.py:2197` | `parent_session_id`, `parent_turn_id`, `child_session_id`, `child_role`, `child_goal`. The `child_session_id` → `parent_session_id` pair is kept for intention events' `payload.parent_session_id` |
| `subagent_stop` | `tools/delegate_tool.py:3667` | adds `child_summary`, `child_status`, `tool_call_history`, `duration_ms` |

`usage` on `post_api_request` is `normalize_usage(...)` as a dict (`run_agent.py:2890`) and carries
exactly `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`,
`reasoning_tokens` — the five buckets spec §4.1 asks for, name for name. It carries **no cost**:
Hermes prices a call after the hook, into `state.db` (`agent/conversation_loop.py:4489`).

### Host stores we read

Read-only (`sqlite3` with `mode=ro`), bounded, and "no data" on any failure. Same tag.

| Store | Written by | What we read | When |
|---|---|---|---|
| `$HERMES_HOME/state.db`, `sessions` | `hermes_state.py` `update_token_counts` | `actual_cost_usd`, `estimated_cost_usd`, `cost_status`, `cost_source` for one id | `on_session_finalize` |
| `$HERMES_HOME/memories/USER.md` | `tools/memory_tool.py` | the bytes, for a hash and a length | `on_session_finalize` |
| `$HERMES_HOME/USER.md` | the landing enrichment (control-plane sidecar), the installer | the bytes, for a hash and a length | `on_session_finalize` |
| `$HERMES_HOME/cron/executions.db`, `executions` | `cron/executions.py` | `id`, `job_id`, `status`, `claimed_at`, `started_at`, `finished_at` of terminal rows | flusher thread, every 60 s |
| `$HERMES_HOME/cron/usage_audit.jsonl` | `cron/scheduler.py` `_write_usage_audit` | `ts`, `job_id`, `prompt_tokens`, `completion_tokens` | same |
| `$HERMES_HOME/cron/jobs.json` | `cron/jobs.py` | `id`, `name` | same |

Cron ids at this tag: a session is `cron_<job_id>_<YYYYmmdd>_<HHMMSS>` and its task is
`cron:<job_id>:<execution_id>` (`cron/scheduler.py`); execution ids are `uuid4().hex`.

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
12. **`api_request_error` fires instead of `post_api_request` on a terminal failure**, so a plugin
    that registers only the latter records nothing for a failed call — error rate reads as zero and
    the `pre_api_request` stash for that request leaks. It is registered, and emits `llm.call` with
    `finish_reason: "error"`. Only the exception *class* is reported: Hermes documents
    `error_message` / `error_body` as possibly carrying an unredacted provider dump, which can
    include the prompt that caused the failure.
13. **`task_id` is not a run id on the conversation path** — Hermes sets it to the session id there.
    `run_id` is populated from `task_id` only when the two differ, so per-run aggregates in `marts`
    are not built on a column that merely repeats `session_id`.
14. **Registering `pre_api_request` has a cost.** Both API hooks are gated on `has_hook()`, so
    Hermes builds and sanitises that payload on every API call *only because we registered*. If
    latency becomes a concern, `AV_HOOKS_DISABLED=pre_api_request` turns it off at the cost of
    `tools_hash` / `system_prompt_hash`.
15. **Intention capture is on `post_tool_call`, not `pre_tool_call`.** Spec §7.1 and DATA-27 say
    `pre_tool_call`. That hook fails closed and has no result, so it has no Index intent id and no
    sign of whether Index accepted the intent. See "Intention capture".
16. **MCP tool names are prefixed.** Hermes registers Index's tools as `mcp__index__<tool>`, and the
    intention path matches that form. The tool-category allowlist (`tool_categories.json`) is keyed
    the same way, so a bare `create_intent` is `other`.
17. **`delete_intent` is captured too.** §7.1 names only `create_intent` / `update_intent`. The Index
    tool family also has `delete_intent`, and a deleted intent is the clearest withdrawal there is.
18. **There is no EdgeOS tool.** The plan says "the EdgeOS register call and its confirming read";
    the `edgeos` skill makes both as `curl` through `terminal`. **Resolution:** EdgeOS operations are
    matched on method and path inside a carrier tool's command (see "EdgeOS actions"), and
    `tool.call.payload.operation` carries the EdgeOS operation, since `tool_name` is only ever
    `terminal`. The `agentvillage-data` seed `edgeos_tool_allowlist` (`tool_name, skill, category`)
    and the "navigate the event" measure will have to key on `operation`, not `tool_name`. An agent
    that reaches EdgeOS by `execute_code` or `web_extract` is not seen.
19. **`action.receipted` claims `provider_receipt`.** Every other event is `agent_report`. §4.1's
    action row asks for it and §2.1 honours it only for a checkable receipt, which this is.
20. **The receipt id is the participant id.** EdgeOS's live OpenAPI (`api.edgeos.world/openapi.json`,
    read 2026-09-22) documents `POST …/register/{event_id}` and `…/cancel-registration/{event_id}` as
    returning an `EventParticipantPublic` with its own `id`, which contradicts the Sept 18 finding
    "no documented response body". That record is the positive evidence an action landed, and its
    `id` is the receipt id (`GET /event-participants/{id}` re-reads it). The receipt is still
    attached at the confirming read, as the plan says.
21. **Cost is per session, not per `llm.call`.** `post_api_request` carries no cost (Hermes prices
    after the hook). Cost goes on `session.ended` from `state.db`, as §4.1 lists it there. In practice
    Hermes fills `estimated_cost_usd` (a pricing-table estimate) and rarely `actual_cost_usd`; the
    estimate travels under its own name and is never promoted, so `core.cost_facts` will mostly see
    null and fall back to the OpenRouter key snapshots.
22. **`usage_audit.jsonl` has no execution id.** It is joined to an execution by job id and time
    window, and only when exactly one line matches; `input_tokens` is otherwise null. The same totals
    are recoverable downstream from `llm.call` rows by `run_id = cron:<job>:<execution>`.
23. **`cron.run`'s §4.3 id needs the tenant id**, which a sandbox only knows from `TENANT_ID` (set for
    `dashboard-auth-edgecity`). This assumes `TENANT_ID` is the same string ingest keys the plugin
    token to; if it is not, every `cron.run` quarantines as `event_id_mismatch`. A non-UUID value is
    counted as `tenant_id_not_uuid`. Without it, the event gets a uuid v7, which ingest accepts.
24. **`cron.run.job_name` is null for any job whose name is not exactly an installer name.** §4.1
    requires the key; a participant-authored name must not ride the ops allowlist.
25. **`profile.updated` is at `on_session_finalize`**, not `on_session_end` as the task words it:
    `on_session_end` fires per turn (divergence 4).
26. **`message.in` is not always the participant.** In a cron session it is the job's prompt
    (`actor: system`), in a subagent the delegator's goal (`actor: agent`).
27. **`message.*.flags` are punctuation, not meaning.** `is_ask` follows `message_flags_v1`;
    `is_recommendation` and `sentiment` are always null (see "Messages").
28. **Non-join hashes are keyed.** §7.1 says "hashes"; `message.*` and `tool.call` hashes are
    HMAC-SHA256 under a per-tenant key, so they cannot be reversed by dictionary outside the sandbox
    and cannot be compared across tenants. So is `profile.updated.user_md_hash` (a templated
    USER.md is guessable from a plain SHA-256); only the intention hashes stay plain SHA-256.
29. **Two USER.md files.** §4.1's `profile.updated` assumes one; the landing writes
    `$HERMES_HOME/USER.md` and the memory tool `$HERMES_HOME/memories/USER.md`. Both are reported, with
    `kind`.
30. **`cron.run.delivery_outcome` is null at the pinned tag**: the ledger column arrives in a later
    Hermes.
31. **`metadata` receipts cannot be checked.** The participant id is hashed there. The plugin's
    claim is unchanged (`provider_receipt`); ingest stores a receipt with a hashed id at
    `agent_report`, not `provider_receipt`, so in `metadata` an RSVP is a receipted action without
    receipt-grade evidence.

---

## Not implemented in this milestone

Out of scope, deliberately:

- **Budget** — `run.budget_exceeded`, `AV_RUN_BUDGET_*`, `AV_BUDGET_MODE`. There is no budget hook,
  and see divergence 9 for why the enforce path cannot be `pre_llm_call`.
- **The `record_intention` tool itself** — the overlay skill or tool the agent calls. The plugin
  observes it (see "Intention capture"). Registering it changes the agent's tool list and
  behaviour, which makes it a product change: per `launch-guardrails-draft.md` it starts on the
  dogfood tenants, rate-capped and behind a per-tenant kill switch.
- **`skill.enabled/disabled`**.
- **Ingest registration.** `agentvillage-data` does not yet register payload schemas for
  `tool.call`, `message.in`, `message.out`, `cron.run` or `profile.updated`; until it does, ingest
  quarantines them (lossless, §2.1). The payload keys above are the contract to register.
- Anything server-side: ingest, dbt, pollers, classifiers. For the memory snapshot this means the
  backup route (DATA-93) and the control-plane restore step that runs `install/restore-memory.ts`
  and emits `memory.restored`. Until the route exists, set no `AV_BACKUP_URL`.

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
