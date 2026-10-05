# `av-events` — Agent Village V2 telemetry collector

A Hermes backend plugin that observes the agent and emits envelope-v1 events to the Agent Village
ingest API. It is **off-path by construction**: it fails open, never blocks on the network inside a
hook, and can be switched off per tenant or fleet-wide by environment variable without a redeploy.

Python 3.11, standard library only. No third-party dependencies, no secrets in the repo, and the
only network destinations it will ever contact are `AV_EVENTS_URL` and, for the memory snapshot,
`AV_BACKUP_URL`. That amends spec §7.1's "network calls to AV_EVENTS_URL only" to "network calls
to AV_EVENTS_URL and AV_BACKUP_URL only"; the amendment is owed to spec draft 1.2. No proxies, no
redirects: the bearer goes only to the configured host (DATA-172). The events poster and the
consent fetch use one urllib opener (`_core.NO_REDIRECT_OPENER`) whose redirect handler follows
nothing and whose proxy handler ignores `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`: the agent can
write `$HERMES_HOME/.env`, Hermes loads it into the environment, and `AV_EVENTS_URL` is plain http
on the private network, so an honoured proxy variable would carry the bearer in clear. The backup
uploader speaks `http.client`, which has no redirect or proxy handling at all.

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
  _consent.py      the consent_status tool: GET /v1/consent and the answer in words (DATA-157)
  _brief_items.py  read-only count of inferred intentions awaiting an answer, for the morning brief (DATA-222, DATA-314); never imported by the plugin
  tool_categories.json        frozen seed: tool name -> category (tool_categories_v3)
  edgeos_tool_allowlist.json  frozen seed: EdgeOS operations (edgeos_tool_allowlist_v1)
  cron_job_names.json         frozen seed: the cron names cron.run may carry (cron_job_names_v1)
  tests/           pytest suite; drives a fake ctx, never imports Hermes
```

---

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `AV_EVENTS_TOKEN` | *(unset)* | Per-tenant ingest token. **Unset or blank means the plugin idles**: hooks are registered, but no event is emitted or buffered and no flusher thread starts; memory backups still run when `AV_BACKUP_URL`, `AV_BACKUP_TOKEN` and the tenant id are set (the control plane sets them only while village consent is in force and `BACKUP_WRITE_MASTER` is configured). |
| `AV_EVENTS_URL` | *(unset)* | Ingest base URL. Events are POSTed to `{AV_EVENTS_URL}/v1/events`; the `consent_status` tool GETs `{AV_EVENTS_URL}/v1/consent`. Empty with a token set is **null-sink mode** (see below). |
| `AV_EVENTS_ENABLED` | `1` | Any of `0`, `false`, `no`, `off` (case-insensitive, whitespace ignored) disables everything. Re-read at every session boundary, and by the flusher before every pass. |
| `AV_HOOKS_DISABLED` | *(empty)* | Comma-separated hook names to disable individually, e.g. `pre_tool_call,post_tool_call`. Matched case-insensitively, whitespace stripped. Three names are not hooks: `memory_recalled` (the bus subscription), `cron_run` (the cron tail) and `consent_status` (the tool, which then answers "could not check"). |
| `AV_TERMINAL_ARGS_FIX` | `1` | Any of `0`, `false`, `no`, `off` turns off the foreground `terminal` argument fix (see "Foreground `terminal` calls (DATA-312)"). **Process environment only**, read on every `pre_tool_call`; a `.env` line reaches it through Hermes's own load at gateway start. Independent of every telemetry switch. |
| `AV_CAPTURE` | `sanitized` | `metadata` \| `sanitized` \| `full`. An unrecognised value falls back to `sanitized`. |
| `TENANT_ID`, `AV_TENANT_ID` | *(unset)* | The tenant id, used for one thing only: `cron.run`'s derived event id (spec §4.3). `TENANT_ID` is what the control plane already sets for `dashboard-auth-edgecity`; `AV_TENANT_ID` overrides it. Unset means `cron.run` gets a uuid v7 derived from the execution (see "Cron capture"). |
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
the enable on the token left the plugin off every hosted tenant). Without a token, no event is
emitted or buffered and no flusher thread starts; memory backups still run when `AV_BACKUP_URL`,
`AV_BACKUP_TOKEN` and the tenant id are set (the control plane sets them only while village consent
is in force and `BACKUP_WRITE_MASTER` is configured). The first roll that lists the plugin turns on
events on every tenant with a token, and backups only where the control plane has configured them.
The installer writes no token or URL into `config.yaml`; it only logs `(no AV_EVENTS_TOKEN yet; the
plugin idles until the control plane writes one)` when neither the process environment nor `.env`
has one, and a `.env` it cannot read falls back to that wording rather than stopping the install.
Hermes reads `plugins.enabled` at gateway start, so a newly listed plugin loads after the next
restart. To keep it from collecting, use the kill switches below rather than unlisting it: the next
install puts it back. The one way to keep it off across updates is to list `av-events` in
`config.yaml` `plugins.disabled`; the installer leaves that entry alone and logs `→ warning:
av-events is in plugins.disabled; Hermes will not load it`. Ops should treat that line as a flag to
review, not an error.

### Kill switches

`AV_EVENTS_ENABLED` and `AV_HOOKS_DISABLED` are **re-read at session boundaries**, not only at plugin
load. That is what makes spec scenario 26 work in both directions: setting `AV_EVENTS_ENABLED=0`
stops events from the next session, and unsetting it resumes them, with no gateway restart. The
flusher also re-reads `AV_EVENTS_ENABLED` at the start of every pass and before every file it sends
(DATA-180), so switching it off stops sending after the batch in flight, even mid-session; when it
has flipped, the flusher
rebuilds the config, so emits and the cron tail stop with it. Batches already on disk stay there
until it is switched back on.

The installer's `AV_EVENTS_TOKEN` log line reads `.env` the way python-dotenv does (`export`, quotes,
comments); the plugin's own fallback reader is stricter, and Hermes loads `.env` into the process
env at gateway start with override, so a stale `.env` token can outlive a blank process-env token
until `.env` is rewritten (the control plane rewrites it on revoke).

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

**Tool-name allowlist.** `tool_categories.json` (`tool_categories_v3`) is the frozen seed; `_tools.py`
reads it once at import. `builtin` lists Hermes's own tools by registry name (the `v2026.8.31`
`_HERMES_CORE_TOOLS` set, plus `send_message`, `recall`, `record_intention` and, under v2's `meta`
category, the plugin's own `consent_status`), and since v3 the Index Hermes plugin's tools
(`index_create_intent` and the rest of `index_*` but `index_open_app`, which opens a link for the human and
stays unlisted), which Hermes registers by bare name; `mcp.<server>`
lists an MCP server's tools, which Hermes registers as `mcp__<server>__<tool>` — so the allowlist is
keyed that way, and a bare `create_intent` is not listed and leaves as `other`. (Intention capture,
below, is a separate rule: it does read a bare `create_intent`, and the plugin's `index_create_intent`
/ `index_update_intent`, as Index writes.) v3 (DATA-261) adds Index
main's MCP tool names (`list_intents`, `get_intent`, `pause_intent`, `resume_intent`,
`archive_intent`, `get_opportunity`, `accept_opportunity`, `reject_opportunity` and the
`*_my_profile` tools) under the category of the old tool each replaces, and keeps every older name. A listed tool leaves by name and
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
§4.3's derived uuid v5, or without a tenant id a v7 derived from the execution (see "Cron capture").
Ingest refuses any other v5 from a plugin token.

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
| `intention.captured` | `post_tool_call` on Index `create_intent` (or the Index plugin's `index_create_intent`), or `record_intention(action="capture")` | `text_hash`, `summary_hash`, `index_intent_id`, `source`, `conditional`, `capture_path`, `index_status`, `parent_session_id`, `publish_refused`, `local_reason`, plus `text_length` / `summary_length` above `metadata` |
| `intention.updated` | `post_tool_call` on Index `update_intent` (or `index_update_intent`) with a new `description`, Index `pause_intent` / `resume_intent` (`index_status` `paused` / `active`, both hashes null, `status_only: true`), or `record_intention` naming an id | as above |
| `intention.withdrawn` | `post_tool_call` on Index `archive_intent` (or the legacy `delete_intent`, or a legacy `update_intent` to `archived`/`deleted`/`withdrawn`), or `record_intention(action="archive"\|"withdraw"\|"delete")` | as above; both hashes null |
| `digest.shared` | the approval poller (or the tool call) after the resident's grant and `approval start` (lane O3) | `digest_id`, `scope`, `text`, `expires_at`, `idempotency_key`, `payload_hash`, `start_seq`, `authorization` — see "Sharing a digest and the weekly vote" |
| `digest.revoked` | `share_digest(action="revoke")` on a shared digest | `digest_id` |
| `vote.cast` | the approval poller after the grant, or `village_vote(action="vote")` under an autonomous policy | `question_id`, `answer`, `idempotency_key`, `payload_hash`, `start_seq`, `authorization` |
| `memory.recalled` | `recall:memory.recalled` on the plugin event bus (published by `plugins/recall`) | `query_hash`, `hit_count`, `top_score`, `surface`; the hash and score are null in `metadata` — see below |
| `memory.snapshot` | the backup thread, after `on_session_end` (rate-limited) or `on_session_finalize` asked for a snapshot and both uploads succeeded | `bytes`, `file_count`, `content_hash`, `manifest_ref` — exactly `memory.snapshot@1`'s closed key set, the same in every capture mode — see "Memory snapshot" |

`prompt.registered` is content-addressed against a seen-set at `$HERMES_HOME/av-events/seen.json`,
so the same tool schemas register once and never again, across sessions and process restarts. The
hash enters the seen-set only when the batch carrying its event got a **202** from ingest (DATA-112).
From the emit until then it is pending in memory, so the process does not register it twice; a batch
that expires drops it from pending, and the next `pre_api_request` registers the body again. Marking
it seen any earlier would lose the body permanently whenever it never landed, while every later
`llm.call` still carried the orphaned hash. A new process re-registers what was still pending when
the old one exited; ingest keeps the first body per hash, so the duplicate is harmless. Two cases are
**not** retried by the same process (an in-memory refused set; the next process tries once more): a
batch refused with a 4xx (quarantined to `buffer/rejected/`), since the same body would be refused
again and take its batch with it; and a body whose envelope would pass 60 KiB, which is never
buffered at all — ingest refuses the whole batch when one envelope passes 64 KiB — and is logged
once as `prompt.oversize bytes=<n>` and counted as `prompt_oversize`. `tools_hash`, `system_prompt_hash` and the
`prompt.registered` hash are all computed over `sanitize(body)`, the bytes that leave, so a body with a
credential shape redacted in it still verifies at the door.

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

Index's own Hermes plugin (`packages/hermes-plugin`; its 16 tools, their REST calls and the two
writers' input schemas are `hermes_plugin` in `tests/vectors/index_intent_contract.json`, copied from
the plugin's `schemas.py` and `tools.py` as fetched 2026-10-04) registers bare `index_*` tools. Two of
them write an intent and are watched (DATA-272, `INDEX_PLUGIN_TOOLS` / `plan_index_plugin` in
`_intentions.py`): `index_create_intent` produces `create_intent`'s events and `index_update_intent`
`update_intent`'s, with `capture_path` `index_tool`. They are read the way the plugin reads them,
not the way the MCP tools are:

- **Arguments.** Only `description`, plus `intentId` for `index_update_intent` — the keys the plugin
  reads. Each is stripped, and a non-string or empty one is absent (the plugin's `_clean_string`),
  so a padded id still joins and a padded description hashes as Index stores it. The plugin drops
  every other key (its schema does not forbid them), so `status`, `networkIds`, and the legacy `id` /
  `intent_id` are never read: a call without `intentId` or `description` records nothing, and a
  bare update can only ever be `intention.updated`, never a withdrawal, whatever it carries or its
  result says. An `intentId` that is not a full id (a prefix Index resolves) is recorded only as the
  full id the result names for it; a result that names none, or another intent, records nothing,
  so a prefix never becomes a join key.
- **Result.** The plugin's own JSON object (Hermes's MCP `{"result": …}` envelope is never unwrapped
  for these names). The plugin answers a non-2xx as an object, with Hermes's status `ok`, so an
  integer `status` of 400 or more, `ok: false`, `success: false` or a truthy `error` (the plugin's
  own reading; an `"error": null` on a success body is not a failure) records nothing; so does a
  result that is not an object.

Hermes registers a plugin tool by bare name only, so `mcp__<any server>__index_create_intent` is not
the plugin and records nothing. The plugin has no pause, resume, archive or delete tool;
`index_read_intents`, `index_list_intent_networks`, `index_add_intent_to_network` and the rest record
no intention (a test derives the writers from the vendored REST calls, so a writer added upstream
fails it once the vector is refreshed). With `record_intention` on, the agent is told never to call
`create_intent` or `index_create_intent` for a new want, and that an intention `record_intention`
did not record may be changed with `update_intent` or `index_update_intent` only to reword the same
want (a different want is a new want, and goes through `record_intention`). A direct call is still
observed, as above, and is neither refused nor rerouted here.

Index's intent tools (DATA-249, verified against `indexnetwork/index` `main`
`services/api/src/lib/mcp/mcp.tools.ts` on 2026-10-02; the overlay's copy of their input schemas is
under `tools` in `tests/vectors/index_intent_contract.json`, and a test holds the observer's names
and the agent-facing text to it)
are `list_intents`, `get_intent`, `create_intent {description, networkIds?, sourceType?, sourceId?}`,
`update_intent {intentId, description?, sourceType?, sourceId?}`, `pause_intent {intentId}`,
`resume_intent {intentId}` and `archive_intent {intentId, confirm: true}`. There is no
`delete_intent`, and `update_intent` takes no status. Index's status is only `active | paused`; an
archive is `archivedAt` set. `intentId` accepts a short id prefix, and the result names the full id.

| Tool | Event | `intention_id` |
|---|---|---|
| Index `create_intent` (or the plugin's `index_create_intent`) | `intention.captured` | Index's intent id, read from the result (`intentId`, or the intent object's `id`); no id, no event |
| Index `update_intent` (or the plugin's `index_update_intent`) with a `description` | `intention.updated` | the `intentId` argument (legacy `id`, MCP name only; stripped for the plugin), or the full id the result names for it |
| Index `update_intent` changing only the source fields | nothing | — |
| Index `pause_intent` / `resume_intent` | `intention.updated`, `index_status` `paused` / `active`, both hashes null, `status_only: true` | as for `update_intent` |
| Index `archive_intent` | `intention.withdrawn`, `index_status` `archived` | as for `update_intent` |
| Legacy, MCP names only (never `index_update_intent`): `delete_intent`, or `update_intent` whose argument status or result status (or `archived: true`) says `archived`\|`deleted`\|`withdrawn` | `intention.withdrawn` (`index_status` `deleted` for `delete_intent`) | as for `update_intent` |
| `record_intention` | see the contract below | the argument, else (on a capture) the result's `intention_id`, else a uuid v7 minted here |

The legacy rows are kept for an Index server still on the older surface: Index main rejects a
`status` argument and has no `delete_intent`, so against it they never fire. A paused intention is
not withdrawn.

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
(a `structuredContent` copy), or be named by `intentId` at the top or on `data` (Index main's
create result: `{intentId, url, networkIds, sourceType, sourceId}`). Anything else — no readable
id, several intents, a bare `id` on `data` itself or at the top level — emits nothing. Plugin-minted ids are for `record_intention` only;
an Index create is joined downstream by its `index_intent_id`, so one without it is not captured.
A result over 256 KiB is not parsed at all.

**Source.** In a cron session every intention is `ambient` — the nightly memory-signal sync calls
`create_intent` with no participant in the loop. A cron session is one whose `on_session_start` said
`platform="cron"`, or whose id has Hermes's `cron_<job>_<stamp>` form (`cron/scheduler.py`), or a
subagent that a cron session delegated to, at any depth up to eight (from `subagent_start`).
Outside cron, Index calls are `message`. `record_intention` passes `message`, `onboarding`, `note` or
`ambient`; a missing or unknown value is the `source` the tool's result names (an update or
withdrawal: the one stored at capture), else `ambient`, the most restrictive. A result that says
`ambient` always wins. Hermes gives no session kind for
onboarding, so `onboarding` comes only from `record_intention`'s argument; an Index create during
the bootstrap ritual is `message`.

**Payload.** `text_hash` is SHA-256 over the exact text the agent recorded (Index `description`,
`record_intention` `text`); `summary_hash` the same over Index's `summary` from the result, or over
`record_intention`'s `summary`. Nothing is normalised, so the poller gets the same value when it
hashes the same Index field. `record_intention` sends its `text` to Index as `description`
unchanged, so a published capture's `text_hash` is the plain SHA-256 (hex) of the UTF-8 bytes
Index received (DATA-249, tested). A REST create with no preparation receipt persists the
description verbatim (`intent.service.ts` `create`), so the poller's hash of the stored payload
should match; the poller counts a mismatch as `text_mismatch` (a dogfood check). Text holding an
unpaired surrogate cannot be encoded as UTF-8, so it could neither reach Index as sent nor hash as
Index would: `record_intention` refuses it (`text_invalid`) on capture and update. Index trims a
description on update (`PATCH /api/intents/{id}`, `.trim()`), so an update's `text_hash` is of the
text as sent, which differs from Index's stored text when it has leading or trailing whitespace. `conditional` is null unless `record_intention` sets it. Not in §4.1:
`capture_path` (`index_tool` \| `record_intention`); `publish_refused` and `local_reason` (below;
null on the `index_tool` path); `index_status`, stripped and case-folded and
limited to `active|paused|archived|deleted|withdrawn|completed|unknown` (`paused` since DATA-249),
with anything else reported as `other`; and `parent_session_id`, the session that delegated to this one when it is a subagent
(learned from `subagent_start`), else null. `text_length` and `summary_length` count characters
(Python `len`, code points), not bytes. Every key is always present, and null when unknown, with
one exception: `status_only: true` (DATA-249) appears only on the `intention.updated` of an Index
`pause_intent` / `resume_intent`, an update of Index's status alone with both hashes null. It is
the key the Index poller sets on its own status-only updates. The data side will treat such an
update as no text version from the data release that carries DATA-248 (in progress); until then
it is stored as sent. It is absent from every other intention event. A pause or resume whose
result says `changed: false` (already paused, already active) emits nothing.

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

**`record_intention` contract.** The overlay's own tool is `_record_intention.py` (DATA-212, below);
the plugin observes calls to any `record_intention`, whatever the server prefix.

| `action` | `intention_id` argument | Event |
|---|---|---|
| `capture` | absent | `intention.captured`, id from the result's `intention_id`, else minted |
| `capture` | present | `intention.updated` |
| `update`, or absent | present | `intention.updated`, if `text` or `summary` is given; otherwise nothing |
| `archive`, `withdraw`, `delete` | present | `intention.withdrawn` |
| absent, `update`, `archive`, `withdraw`, `delete` | absent | nothing |
| anything else | either | nothing |

With no `action` argument the result's `action`, when it names one, is used (the overlay tool
defaults to `capture` and says so). Other arguments: `text` (or `description`), `summary`,
`source` ∈ `message|onboarding|note|ambient`,
`conditional`, and `index_intent_id` when the Index copy's id is known. **The tool must return
`intention_id` to the agent** — as `intention_id` at the top of its result or under `data` — because
the agent needs it for every later update or withdrawal, and the plugin cannot hand it back: a
`post_tool_call` observer's return is discarded. An id the plugin mints is recorded in the event and
nowhere else. From the result the plugin also reads `index_intent_id` (the Index id the tool
published under), `publish_refused` (a code, `^[a-z0-9_]{1,64}$`, else null) and `local_reason`
(`participant_asked` \| `personal`, else null).

### The `record_intention` tool (DATA-212)

**Deploy order.** The data repo's change that adds `note` to `INTENTION_SOURCES` (and the dbt
accepted values) merges and deploys **before** this plugin version: until then a `note` capture
quarantines at ingest.

Registered only when `AV_RECORD_INTENTION` is `1|true|yes|on` (default off). Hermes loads
`$HERMES_HOME/.env` into the process environment at startup, so a change to the switch there takes
effect after a gateway restart, in both directions; the handler's call-time re-read honours only a
change made to `os.environ` itself. One front door: for a new want the agent calls it instead of
Index `create_intent` or the Index plugin's `index_create_intent`; an intention it did not record
may still be changed with `update_intent` / `index_update_intent`, only to reword the same want.
Explicit intents (source message, onboarding or note) are published to Index by
default. The two legitimate reasons an explicit intent stays local: the resident asked, or the
content is personal. The skill `skills/record-intention/SKILL.md` says the same. It is installed on
every tenant with the edge bundles and has no `requires_tools` gate (the tool sits behind Tool
Search, which such a gate would not see); its text, the `workspace/AGENTS.md` routing line and the
`create_intent` passages of `skills/index-network/tools.md` and
`skills/edge-esmeralda/prompts/memory-signals.md` all apply only if `record_intention` is available
(in the tool list, or found with `tool_search` and called through `tool_call`).

| Call | Index | Result / event |
|---|---|---|
| `capture`, source `message`/`onboarding`/`note`, in a session that may publish | `POST /api/intents {description: text, sourceType: "agentvillage"}`, no `sourceId` | `intention_id` = `index_intent_id` = Index's id (corroborated by id, no back-reference needed) |
| same, Index refused, unreachable, or the hourly cap reached | tried, or not when capped | local uuid v7, `publish_refused` = code |
| `capture`, `publish=false`, `reason`, any source, in any session | none | local uuid v7, `local_reason` = reason, never proposed (in a held session `source=ambient`, no `held_*` code) |
| `capture`, source `ambient` | none | local uuid v7, `source=ambient`, held, unless `publish=false` (kept local) |
| `capture`, explicit source, in a held session | none | local uuid v7, `source=ambient`, `publish_refused` `held_cron` or `held_unknown`, unless `publish=false` (kept local) |
| `capture` that would publish, of text already held as ambient (case and whitespace ignored) | none | local uuid v7, `publish_refused="held_ambient_exists"` |
| `update` / `withdraw` of an id it published | `PATCH /api/intents/{id} {description}` / `PATCH /api/intents/{id}/archive` (no body) | `index_intent_id` set; a failed mirror adds `publish_refused` |
| `update` of a published id in a held session | none | `publish_refused` `held_cron` or `held_unknown`, `source=ambient` |
| `withdraw` of a published id in a held session | none | refused (`success: false`, no event): `held_cron` or `held_unknown` |
| `withdraw` of a published id already archived by this tool | none | `intention.withdrawn`, told it was already withdrawn on Index |
| `update` / `withdraw` of an id it recorded locally | none | local only |
| `update` / `withdraw` of an id it has no record of | none | `publish_refused="unknown_id"`, `source=ambient` |
| `confirm`, approval not configured | none | refused: `no_confirmation_channel` (`confirmation_not_wired` when `AV_APPROVAL_URL` is set but `AV_APPROVAL_ENABLED` is not on) |

With `AV_APPROVAL_ENABLED` on and `AV_APPROVAL_URL` set, captures that would publish go through the
resident's approval.md first: see "Through approval.md" below. That changes three rows: an ambient
capture is proposed to the resident (and publishes on their grant), a stated capture is proposed
and publishes in the same call when the policy answers autonomous (with a uuid v7 `intention_id`
and Index's id as `index_intent_id`), and `confirm` works.

**Held sessions.** The tool keeps its own session lineage from its own `on_session_start`,
`pre_api_request` and `subagent_start` listeners, outside the collector's guard (so
`AV_EVENTS_ENABLED=0`, `AV_HOOKS_DISABLED`, a degraded session or an unload never loosen it). It
is an allowlist: a session may publish only when it, or the root of its delegation chain, was seen
on a human-facing platform (Hermes's gateway chat platforms: telegram, discord, whatsapp,
whatsapp_cloud, slack, signal, mattermost, matrix, email, sms, dingtalk, feishu, wecom, weixin,
bluebubbles, qqbot, yuanbao; and `cli`, `tui`, `desktop`). A `cron_` id or `platform=cron` in the
chain is `held_cron`; anything else (`api_server`, `webhook`, `batch`, `acp`, `curator`, `local`,
an empty platform, a plugin platform, an unseen session, a subagent of unknown ancestry) is
`held_unknown`.

**`publish=false` always wins (DATA-311).** An explicit `publish=false` (with its reason) is
honoured for every source and in every lineage: nothing a caller marks do-not-publish is ever
proposed, held for approval or published, whatever the session. A held session still turns the
source into `ambient`, so it cannot pass an inferred want off as a stated one; only the publish
decision is taken first, and `update`, `confirm` (refused `confirm_not_held`) and the approval
poller never turn such a local intention into a proposed one.

**Held withdrawals (refutation B2, provisional ruling; Carter may overturn).** The same test holds
a withdrawal of a *published* intention: archiving on Index cannot be undone, and held sessions
are the ones exposed to injected instructions. In a held session `action=withdraw` of a published
id sends nothing to Index and records nothing; the tool refuses with `held_cron` / `held_unknown`
and tells the agent that withdrawing a published intention needs the resident in a direct chat. A
withdrawal of a local-only intention is unchanged, and so is any withdrawal from a human-platform
session. A successful archive marks the map entry `archived`, so a second withdrawal sends
nothing. [Reversal: mirror withdrawals from any session, as before.]

**Rate cap.** `AV_RECORD_INTENTION_MAX_PUBLISH_PER_HOUR` (default 20) Index create attempts per
rolling hour per tenant, counted across processes in the map under its lock, with the clock read
inside the lock and no writer dropping another's live stamps. Over it: `rate_capped`. A count that
cannot be read: `rate_unavailable`; one that was read but cannot be saved proceeds, and
`rate_count_failed` is logged once per process.

`publish_refused` codes: `no_key`, `url_refused`, `rate_capped`, `rate_unavailable`, `redirect`,
`http_<status>`, `rejected` (Index's 422 `intent_rejected`: too vague, or an edit it would not
accept), `timeout` (ambiguous: Index may have written; see below), `transport` (nothing was
sent), `id_invalid` (a mirror of an id that is not a UUID or hex short id; nothing
sent), `held_cron`, `held_unknown`, `held_ambient_exists`, `unknown_id`. Status mapping
(`status_code`, from Index's `intent.controller.ts`): 422 is `rejected`; 400 (a body we built
wrong), 401, 403 (`invalid_preparation`, or a network-membership refusal: never the resident's
words), 404, 409 (archived), 429 and 503 (`preparation_failed`, retryable, nothing written) are
`http_<status>`: nothing was written; a 3xx is `redirect`. **Ambiguous failures are `timeout`
(refutation B1)**, because Index may already have done the write and `timeout` is the one code
the data side reconciles against a later Index capture of the same text hash: any failure after
the request was sent (`RemoteDisconnected`, `IncompleteRead`, `ConnectionResetError`, a socket
timeout from `getresponse()` or the body read, a cut body); a 2xx whose body is not a JSON object,
is too large, or (on a create) names no `intentId` matching the path-id pattern; any 5xx but 503
(500, 502, 504); and the overall 30 s deadline passing first. Each socket operation is bounded at
25 s, below the deadline, so a connect that never completes fails as `transport` first; when the
deadline does pass, whether the request went out cannot be known (a slow DNS lookup, or a connect
then a slow answer), so the metric gets `timeout`, the safe direction, and the log line
`index_deadline=opening` (no answer had begun, possibly never connected) or `=reading` tells the
operator how far it got. `transport` is only for a failure before anything was sent (connect,
DNS, TLS, a connect timeout; urllib wraps those in `URLError`), logged as
`index_unreachable=<reason>` (`connect_timeout` for a timeout) so a wrong or blackholed host is
visible. A config error found while building or opening the request (`ValueError`,
`http.client.InvalidURL`) is `url_refused`. The tool then tells the agent the result
is unknown and not to retry, never that Index could not take it. Every code on a capture is the
local-capture path; only `rejected` labels the map entry. Before DATA-249, `rpc_error`,
`malformed` and `too_large` came from the MCP client, now removed. Refusals (`success: false`, no event): `disabled`,
`action_invalid`, `text_required`, `source_required`, `source_invalid`, `publish_invalid`,
`reason_required`, `reason_invalid`, `intention_id_unexpected`, `intention_id_required`,
`intention_id_invalid`, `capture_again` (an update of a capture Index rejected),
`no_confirmation_channel`, `confirmation_not_wired`, `internal`, `text_invalid` (an unpaired
surrogate in the text), and `held_cron` / `held_unknown` for a held withdrawal of a published id;
on the approval path also `approval_pending`, `approval_publishing`, `confirm_unknown`,
`confirm_not_held`, `confirm_text_missing`, `resident_declined`, `approval_expired`.

**For the data side.** Reconciliation is the data repo's provisional ruling R11
(`eligibility_v3`). A `publish_refused='rejected'` capture is ineligible (`index_rejected`); the
clarified capture the agent is told to make is its own row, and `action=update` on the rejected one
is refused (`capture_again`), so it never publishes. A `timeout` capture is ineligible
(`index_duplicate_timeout`) only when an Index-side capture from the same tenant with the same
`text_hash` falls between the timed-out call's start and one hour after the capture; the poller is
timed only by Index's `createdAt`. Every other `publish_refused` code stays eligible.

**How the tool reaches Index (DATA-249).** Over Index's REST API, one request per write, with
urllib: `POST /api/intents {description, sourceType: "agentvillage", sourceId?}` (Index's body
schema is strict; we send neither `networkIds`, so the intent is shared in every network the
resident belongs to, nor `preparationReceipt`, so Index prepares the text itself, persists it
verbatim, and answers 422 when it is not ready), `PATCH /api/intents/{id} {description}`, and
`PATCH /api/intents/{id}/archive` with no body. A publish counts only with an `intentId` matching
the path-id pattern (a UUID or a hex short id) in a 2xx body; anything else is `timeout`. `sourceId` is sent only by `publish_intent(text, source_id=...)`, for a held intention
published later; a stated capture sends none (its id is Index's). Not MCP: Index's MCP endpoint
answers 400 "Unsupported protocol version" to every version the plugin could send (`legacy:
'reject'`), and the hand-rolled MCP client is gone. Never a Hermes MCP tool call either, so the
`index_tool` observer never sees it and each call is one event. Headers: `x-api-key`
(`INDEX_API_KEY`), `accept: application/json`, `content-type: application/json` with a body; no
`x-index-surface`. The origin is read at call time: `INDEX_API_URL` (an origin, or `<origin>/api`,
the convention of Index's own Hermes plugin, stripped to the origin); else the origin of
`INDEX_MCP_URL` when it is `https://<host>[:port]/mcp`; else `https://protocol.index.network`. It
must be https (plain http only to `localhost`, `127.0.0.1`, `::1`), with no credentials, no `?`
or `#` and no space or control character anywhere in the string, a host of `[A-Za-z0-9.-]` only
(or a bracketed IPv6 literal), and no other path; the origin is rebuilt from the parsed scheme
and host alone. A configured URL that fails is `url_refused`, never a fallback to production. The
installer reads `INDEX_MCP_URL` only to write `mcp_servers.index.url` into `config.yaml` and writes
neither variable to `$HERMES_HOME/.env`, so a tenant installed against Index's dev server still
writes to production unless `INDEX_API_URL` (or `INDEX_MCP_URL`) is set in the gateway's
environment. An id in a path must be a UUID or a hex short id and is URL-encoded.
No redirects, no proxies. The whole request has a 30 s deadline. `$HERMES_HOME/av-events/intentions.json` (0600, under `flock` on
`intentions.json.lock`) records each id's `{published, source}`, `refused: rejected` for a local
capture Index rejected, `local_reason` for a capture kept local on purpose, a `held_norm_hash` (sha256 of the
case-folded, whitespace-collapsed text, never emitted) for held ambient entries only, replaced on
update and dropped on withdrawal, and the cap's attempt timestamps; a corrupt file is renamed to
`intentions.json.corrupt-<n>` and the map starts empty. Logs carry codes only. The observer reads
the result's `action`, `source`, `index_intent_id` and codes only for the unprefixed overlay tool;
a result that names `index_intent_id` decides it, null included.

### Through approval.md (DATA-212 Lane B)

Rulings R16..R24 and the Lane B contract, against the `propose`, `wait --timeout 0` and `start`
verbs of approval.md PR #569. Code: `_approval.py` (the client and the poller thread, meant to be
shared by `digest.share` and `village.vote` later through `register_pass`) and
`_intent_approval.py` (what an answer means for an intention). Off unless both are set:

| Variable | Meaning |
|---|---|
| `AV_APPROVAL_ENABLED` | `1\|true\|yes\|on` turns the approval path on (the control plane writes it, DATA-233). |
| `AV_APPROVAL_URL` | The daemon: `http://127.0.0.1:<port>` (or `localhost`, `[::1]`), `unix:<absolute socket path>`, or an `https://` origin (the hosted dogfood). No path, no query, nothing else. |
| `AV_APPROVAL_TOKEN_FILE` | The agent credential's file. Else `$HERMES_HOME/approval/agent-token` when it exists, else `AV_APPROVAL_TOKEN`: the shim's order. A token file must be absolute, a regular file owned by this uid, mode 0600; a named file that fails never falls back. |
| `AV_APPROVAL_DAEMON_UID` | The uid that must own the loopback listener or the socket (default 10001). |
| `AV_APPROVAL_POLL_S` | Seconds between poller passes (default 30, at least 5). |
| `AV_APPROVAL_POLLER` | `1` starts the poller thread in any process; `0` never (session-start passes still run). |

**The calls, exactly as the plugin makes them** (`POST /verb/<name>` with `Authorization: Bearer
<agent token>`; an https facade also gets `X-Approval-Authorization`, which Maritime's proxy keeps):

- `propose`: `{"flags": {"--class": "intent.publish.inferred.index", "--key":
  "intent.publish.inferred.index:<intention_id>", "--summary": "Publish to Index an intention your
  agent inferred (intention <intention_id>).", "--payload-json": "{\"text\":\"<the text>\"}",
  "--json": true}}`. A stated capture: class and key `intent.publish.stated.index`, summary
  "Publish to Index an intention you stated (intention <id>).". The summary names no part of the
  text (it is in the daemon's log in cleartext, twice); the payload is compact JSON, UTF-8, at most
  262144 bytes (a larger text is held without a proposal).
- `wait`: `{"positionals": ["<task>"], "flags": {"--timeout": "0", "--json": true}}`; never
  `--withdraw-on-timeout`.
- `start`: `{"positionals": ["<task>"], "flags": {"--action": "<key>", "--payload-json": "<the
  proposed string, byte for byte>", "--json": true}}`.
- `withdraw` (the agent withdrew a pending intention): `{"positionals": ["<task>"], "flags":
  {"--reason": "the agent withdrew the intention", "--json": true}}`.

**Ids.** Every proposed capture gets a uuid v7 `intention_id`: the key's id (so the follower can
parse it back, R21), the tool's returned id, and the `sourceId` Index stores (decision A, amending
R20). A published entry keeps Index's id as `index_intent_id`; update and withdraw mirror to it.

**Where the held text lives (R16).** In the map entry's `approval.payload`
(`$HERMES_HOME/av-events/intentions.json`, 0600, under its flock), from capture until the proposal
ends. It is deleted on publish, on Index's 422, on an ambiguous or failed publish, on the
resident's rejection, on the agent's withdrawal, on a start whose confirmation was lost, and on the
final expiry. A proposal core refuses (`class-not-agent-requestable` and kin) keeps it so a
`confirm` after a policy change can file it again. The held string is its own RFC 8785 form, so its
plain SHA-256 is core's `payload_hash`: the plugin records the hash core answers at `propose`,
refuses the proposal when it differs, and before it starts or publishes checks that the held bytes
still hash to it (if not, it proposes again, and core refuses other bytes for the key). What is
published is `json.loads(payload)["text"]`, the very string `start` was given.

**What authorizes a publish, and nothing else does.** The map is never authority; it says only
what to ask the daemon next. A publish happens only in the same call that (1) read the authority
for that key from the daemon: `wait --timeout 0` exit 0 with `status: granted` for a manual class,
or, for a class the policy clears, the `propose` answer `decision: autonomous|supervised` with no
execution yet (a rule approval writes no grant, so there is no `wait` to read); (2) claimed the
entry with one compare-and-set (`requested|cleared → starting`, a claim id); (3) read the same
authority from the daemon again after the claim; (4) got `start` back ok with `authorization` equal
to the expected one (`grant` or `policy`); (5) moved the entry `starting → publishing` under the
claim. Any other `wait` answer is not a grant: exit 0 with any other status (`nothing-to-wait-for`,
`executed`), 1 (rejected, revoked, withdrawn, `not-registered`), 3 (expired), 6 (pending), 7
(void), anything else.

**States** (`approval.state`; each step a compare-and-set under the map's flock): `unfiled` →
`propose` → `requested`, `cleared`, `rejected`, `refused`, or `start_unconfirmed` (core says the
key already executed). `requested` → `wait 0` → on a grant, claim / re-read / start / publish;
`rejected` and `withdrawn` (final); `unfiled` again on `expired` (the same bytes re-proposed at most
twice, then `expired`, final), on `void`, and on `not-registered`; `start_unconfirmed` on
`nothing-to-wait-for` (a spent grant: a start whose confirmation was lost, never published).
`cleared` → claim / re-propose / start / publish. Publishing ends `published`, `index_rejected`
(422, labels the entry `refused: rejected`), `ambiguous` (Index may have written), or
`index_failed` (nothing reached Index twice in the same call; a later call would hold no `start`).
A `starting` claim older than 120 s is released to where it came from and the daemon is asked
again. A `publishing` entry older than twice Index's deadline (60 s) is a process that died inside
the Index call: `ambiguous`, never sent again.

**No duplicate publish, no publish of a withdrawn intention.** Only the holder of the claim starts
and publishes; the claim is taken before the authority is re-read; the agent's withdraw is refused
(`approval_publishing`) while an entry is `starting` or `publishing`; a crash inside the Index call
ends in `ambiguous` (`publish_refused: timeout`, reconciled by `sourceId` and text hash), never a
second create.

**Stale grants.** A grant pinned to a policy that has since been re-attested reads `void` from
`wait` (exit 7) or is refused `policy-drift` by `start`; both re-propose the same bytes, which core
files as a new question under the new policy. Nothing publishes on the old grant.

**The poller.** One daemon thread per process, started when the process is the gateway: at plugin
load when the command line is `hermes gateway run` (or `start`), or at the first `on_session_start`
on a gateway platform (any platform but `cli`, `tui`, `desktop`, `acp`, `subagent`, `local`; `cron`
counts, the scheduler runs in the gateway). Every other `on_session_start` (a CLI chat, a dashboard)
runs one pass in a short-lived thread: the resume. A pass advances every live proposal once (at most
50), skipping one a capture call is still advancing itself (90 s grace). Passes are serialised in
the process and across processes (`flock` on `approval-pass.lock`, non-blocking). The thread catches
everything and never ends on its own; it dies with the gateway (`os._exit`), all state is on disk,
and the next process resumes it. A dead thread is replaced at the next session start. Plugin unload
stops it.

**Events.** A publish (or Index's refusal) inside the capture call is in the tool result, and the
observer emits the one `intention.captured` (with `index_intent_id`, `approved_by`,
`approval_state`). A later one (the poller, or `confirm`) is emitted by the plugin as
`intention.updated` with `index_intent_id`, `approved_by` (`individual` for a human's grant, `rule`
for the policy, from `start`'s `authorization`), `approval_state`, and the `text_hash` of the exact
string sent to Index. `approved_by` and `approval_state` are present only on this path. `confirm`'s
own result records nothing.

**`confirm`.** The same steps, nothing else: it asks the daemon for the resident's answer and
publishes only on a grant read as above. A manual class with no grant is refused
`awaiting_resident`. Other refusals: `confirm_unknown`, `confirm_not_held` (recorded locally on
purpose, or withdrawn), `confirm_text_missing` (held before approvals were on: capture it again),
`resident_declined`, `approval_expired`, `publish_failed` (`index_failed` or `start_unconfirmed`),
`rule_needs_capture` (a policy-cleared proposal its capture call could not execute),
`capture_again`. `update` of an intention whose proposal is open is refused `approval_pending`;
`withdraw` ends the proposal (and withdraws a pending question on the daemon).

**Who may execute what.** A start the policy clears (`cleared`) is executed only by the capture
call itself, which has the class in memory; the poller and `confirm` publish only on a human grant,
and a `cleared` entry they meet ends `not_published` (so a stated capture that could not reach the
daemon in its own call is not published later; capture it again). Before every propose and start
the map's class must be one of the two and its key exactly `<class>:<intention_id>`, else the entry
ends `invalid`; the `sourceId` is the key's own id. `AV_APPROVAL_ENABLED`, `AV_APPROVAL_URL` and
`AV_APPROVAL_DAEMON_UID` are read from the process environment only, never from the live-reloaded
`.env`. Plugin registration outside `hermes gateway run` starts nothing, and the one-shot resume
pass a non-gateway session start runs proposes and reads answers but stops before `start`.
`wait` exit codes count only with their status (1 with `rejected`/`revoked`/`withdrawn`, 3 with
`expired`, 7 with `void`); anything else is transient. `withdraw` ends any proposal not being started
or published, a refused one included; `update` of a refused one ends it (`superseded`); neither can
be reopened.

**Codes this path adds.** `publish_refused` on a stated capture: `approval_pending`,
`approval_unavailable`, `approval_refused`. `approval_state`: `requested`, `cleared`, `starting`,
`publishing`, `published`, `rejected`, `withdrawn`, `refused`, `index_rejected`, `ambiguous`,
`index_failed`, `start_unconfirmed`, `expired`, `not_published`, `invalid`, `superseded`, `unfiled` (the daemon could not be reached;
retried), `unavailable` (nothing could be held). Map codes: `payload_hash_mismatch`,
`authorization_mismatch`, `claim_abandoned`, `map_invalid`, `rule_needs_capture`. Client codes in the logs: `url_missing`, `url_refused`,
`token_missing`, `token_malformed`, `token_file_*`, `facade_listener_foreign`, `unauthorized`,
`http_<status>`, `transport`, `timeout`, `bad_answer`.

### Sharing a digest and the weekly vote (lane O3)

Two more resident-approved actions on the same approval client and poller. Code:
`_share_vote.py` (registered on Lane B's poller through `_approval.register_pass("share_vote", ...)`)
and `_village_question.py` (where the weekly question is read). The contract is the data repo's
`docs/spec-addenda.md` "digest.* and vote.cast" and the closed schemas `digest.shared@1`,
`digest.revoked@1` and `vote.cast@1`; `tests/vectors/share_vote_contract.json` is a copy of their
field lists, the approval link's known-answer vectors and the text rule's cases.

| Variable | Meaning |
|---|---|
| `AV_DIGEST_SHARE` | `1\|true\|yes\|on` registers `share_digest`. Process environment only. |
| `AV_VILLAGE_VOTE` | `1\|true\|yes\|on` registers `village_vote`. Process environment only. |
| `AV_TENANT_ID`, `TENANT_ID` | The tenant the ingest token belongs to (process environment only), lower-cased and required to be a UUID as the collector requires: the vote's key names it. Anything else refuses the vote (`tenant_unknown`). |

Both are off by default, and neither tool is registered without approval configured
(`AV_APPROVAL_ENABLED` and `AV_APPROVAL_URL`); off, no tool is registered and the pass does
nothing. Switching one off later stops its pass too (pending proposals wait on disk).

**Nothing is proposed that would go nowhere.** Before it asks the resident, each tool refuses
when no event could be sent (no token, the plugin switched off, or a null sink, which buffers and
never sends: `not_available_no_events`) or when ingest's `GET /v1/consent` (the read
`consent_status` makes) says the tenant is not in the research, whose events the worker drops
(`not_available_no_consent`). When consent cannot be read, the tool proceeds, and every answer
says only that the event was handed to the event queue: delivery is never claimed.

**Deploy order.** Ingest must be released with the three schemas (data repo #188) before any
agent emits these events; an ingest without them quarantines every one. The resident's policy
must also name the classes (`digest.share` and `village.vote`, manual, `agent_may_request: true`,
as the control plane's resident template does); a policy without them refuses the proposal
(`class-not-agent-requestable`) and nothing is sent.

**`share_digest`.** `action=share` (`text`, `scope` `village` or `service:<name>`, optional
`expires_in_hours` 1..167, ASCII digits only) mints `digest_id = str(uuid4())` and proposes, in class `digest.share`
with key `digest.share:<digest_id>`, exactly `{digest_id, scope, text, expires_at}` as RFC 8785 JSON
(the bytes the resident is shown). `expires_at` is at most 7 days less an hour after the plugin's
clock (the door refuses one more than 7 days after it receives the event). The summary names the
scope, the expiry and the id, never the text. Text the door would refuse (more than 500 code
points, no letter or digit, a control, a bidi override, an invisible, private-use, noncharacter or
tag character) or that the sanitiser would change (a credential shape) is refused at the tool. At
most five shares wait for the resident at once. A share the policy clears without asking the
resident is never started (`not_shared`: a share admits only `grant`). `action=revoke`
(`digest_id`), on the resident's instruction, emits `digest.revoked@1` (`{digest_id}`, no approval:
the policy rows name no revoke class) once per share, or, before the resident answered, withdraws
the question and sends nothing. Nothing else revokes: an expiry needs no event, and an executed
share has no withdrawal on the daemon. A revocation needs no approval because it only reduces
exposure (accepted in writing): the agent can therefore revoke, or by writing the map pre-revoke,
any digest id of its own tenant; the data side keys a revocation on the token's tenant, so no
other resident is reachable. It is sent at most once per digest id per process, and only for an
entry this module marked sent (`emitted` with its event id, start seq and `grant`), which the map
can still forge. `action=status` reads where it stands.

**`village_vote`.** `action=question` reads the open question (id, text, options as keys with
their labels, close).
`action=vote` (`question_id`, `answer` one option key, optional one-line `rationale`) proposes, in
class `village.vote` with key `village.vote:<question_id>:<tenant_id>`, exactly
`{question_id, answer}`; the rationale goes in the summary, never the payload. A question takes one
answer (approval.md binds a key to its first bytes). Before a vote is proposed and again before
it is started, the provider is asked, never the map: the vote's question must be the open one, its
answer one of that question's option keys, and the question not closed by the provider's own
close time. Otherwise the entry ends (`closed` with `question_unavailable` or `question_closed`,
`invalid` with `answer_not_an_option`), a pending question is withdrawn, and nothing is sent; under
the shipped provider no vote is ever proposed. The resident's prompt is built from the provider:
the question's text and the chosen option's label as one clean bounded line (controls, format and
bidi characters dropped), or a plain statement that no text or label is available beside the
option key; the rationale follows, cleaned again and labelled as the agent's note, and is dropped
(the prompt still goes) when it fails cleaning or quotes a share this agent still holds. The tool
refuses such a rationale (`rationale_invalid`, `rationale_quotes_share`: 24 consecutive
characters of a held share's text, or all of a shorter one of at least 12, compared after NFKD
with format and combining marks dropped, case and spacing folded; a share already sent no longer
has its text here). A rationale holding any format character (zero-width, joiner, bidi) is refused
(`rationale_invisible`), blank-rendering fillers are dropped and every kind of whitespace becomes
one space, and one that repeats any of the prompt's own fixed phrases (taken from the builder's
constants, punctuation ignored) is refused (`rationale_imitates_prompt`). The summary is at most
4096 UTF-8 bytes by construction (the agent's note is cut first, then the question's text, never
the answer line), and a key over 1024 bytes is never proposed (`key_too_long`): approval.md's
`propose` limits. A question whose close is not a finite number is not a question. One function
(`display_line`) defines a prompt line for the provider's text and the rationale alike (every
whitespace character, CR, LF, VT, FF, U+0085, U+2028 and U+2029 included, becomes one space;
hidden characters and blank fillers are dropped); a rationale holding a hidden character is
refused rather than filtered, one mixing Latin with look-alike letters of another script is refused
(`rationale_mixed_script`), and the rationale that is checked is exactly the one sent.

**How the prompt is rendered, and the rationale's character set.** approval.md's Telegram channel
sends the summary with `parse_mode: "HTML"`, escaping `&`, `<` and `>` in every interpolated value,
as one row under its "claimed, not verified" heading; the control plane's relay forwards
`parse_mode` unchanged. So HTML cannot be injected; what remains is a line break (none survives
`display_line`), text Telegram turns into an entity by itself (links, bare domains, mentions, tags,
commands, phone numbers), and letters that read as the prompt's own words. The rationale is
therefore held to a conservative set (`rationale_charset`): letters, digits and marks of Latin
(only letters that decompose to an ASCII letter: accents yes, small capitals and other look-alike
Latin no), Devanagari, Bengali, Gurmukhi, Gujarati, Oriya, Tamil, Telugu, Kannada, Malayalam,
Sinhala, CJK, Hiragana, Katakana and Hangul; no compatibility forms (full-width, mathematical,
ligatures); plain spaces; and only `. , ; ! ? ' " ( ) -`, curly quotes and dashes, the
ideographic comma and full stop and the danda as punctuation: no colon (nothing reads as a new
field), no `<>&@#/\*_[]{}|~`, backtick, `$`, `%`, `+`, `=`, `^`, no symbols or emoji, no period
inside a word. Digits are ASCII 0-9 only (another script's zero draws like an o), at most eight in
the whole rationale, and digit groups joined only by spaces, hyphens or brackets may hold at most
six (a grouped phone number Telegram may link). One script per word: every letter and mark in a
word (a run between spaces and allowed punctuation) is of one script, ASCII digits beside any;
Japanese kanji and kana, the long vowel mark and Korean hangul count as one family, Latin mixes
with nothing, and at most three marks sit on a letter. Compared folds drop spacing marks too.

The rules are one positive grammar, checked in one pass on the final string (after
`display_line`, which changes nothing a second time): a rationale is words separated by a space or
an allowed punctuation mark (nothing else ends a word); a word is letters of one script family,
each letter positively identified (its Unicode name starts with an accepted script, so modifier,
superscript, subscript, enclosed, squared and other qualified forms are not), each followed by at
most three marks of the same family (a mark never starts a word or follows a digit), with ASCII
digits anywhere. Digit runs are measured across every boundary (`555, 1234` and `123–45678` are
one number). CJK numeral ideographs are letters, not digits. Only an exact `str` is read. The
prompt-phrase check removes all punctuation and spaces before comparing, so a phrase split by an
apostrophe, a quote, a hyphen or a dropped filler is still caught.

These rules refuse some ordinary text (accepted): a sentence that happens to contain one of the
prompt's fixed phrases, `e.g.`, a decimal such as `3.5`, other CJK and Indic punctuation, any
right-to-left, Cyrillic or Greek note. A refused rationale never blocks the vote: the tool tells
the agent which rule to rephrase for, and a stored rationale that fails is dropped and the
proposal goes out without it. The rules make an honest agent's note safe to show; a hostile agent
holding the approval token can call the daemon directly with any summary, so the resident's
protection is that the trusted question and answer always come first and the payload they approve
is exactly what is sent. Cyrillic, Greek and other scripts that draw like Latin, and right-to-left
scripts, are outside it. The trusted part always comes first; the note follows on the same line
after the plugin's fixed label, which the rationale may not repeat. The share prompt carries only
plugin values and the service name (ASCII `[a-z0-9_-]`, quoted as a value); never the text. Folding
(NFKD, marks dropped, case-folded) is used only to compare, never on anything sent: the share text
and the vote answer are proposed, started and emitted as written, and question ids and option keys
are compared exactly. A vote the resident set autonomous is cast inside the tool call (`authorization:
policy`); the poller casts only on a human grant. `action=withdraw` withdraws an unanswered vote;
a cast vote cannot be withdrawn.

**The weekly question is not available yet.** The contract's source is `ods.questions`, which is
not built, and no other source exists (no control-plane route, variable, installer file or event).
`_village_question.current_question()` is the one seam; its shipped implementation raises
`question_source_not_built`, so `village_vote` refuses every question and vote with
`question_unavailable` (`reason: question_source_not_built`) until a provider replaces it.

**What authorizes an event.** The map (`$HERMES_HOME/av-events/share-vote.json`, 0600, under its
flock) is never authority: the agent can write it. An event is emitted only by the one call that
read the grant from the daemon for that key (`wait --timeout 0`, exit 0, `granted`; for a policy
vote, `propose`'s own answer inside the tool call), claimed the entry, read the authority again,
and got `start` ok for exactly those bytes, naming this key, class and task, with the expected
`authorization` and a `seq`. The event is built from the very string that call sent to `start`,
and its `payload_hash` is that string's SHA-256 (also checked against `propose`'s answer); the map
is re-read twice before the send, and if the held bytes, the recorded hash, the key or the claim
changed, nothing is sent (`payload_tampered`). An `emitting` entry the pass meets is never sent
from there (`emit_unconfirmed` once stale). No grant, a rejection, a revocation, a withdrawal, an
expiry (not re-asked), a daemon that is down or unverified, or a refused start: no event. A `void`
re-proposes the same bytes (at most ten times), as for intentions. The held text is dropped when
the proposal ends; a shared digest keeps its id, scope and expiry for a revocation.

**Accepted limits.** The agent runs as the plugin's uid: it can write the event spool directly,
and an agent that can start a Hermes process controls that process's environment (Hermes loads
`.env` with override at startup), so the switches and `AV_APPROVAL_URL` too, and could point the
plugin at a listener of its own. The defence for both is the data side's: the ODS writer resolves
every share and vote against the approval follower's own rows, which this sandbox does not write.
The plugin reads its switches from the process environment only, so writing `.env` does not turn
them on in a process already running; that is all it shows.

**The events.** After `start`, on the tenant's plugin token, actor `agent`, no session, envelope
`decision_id` null, `agent_report`; `event_id` a uuid v7 derived from the start time, the key and
`start_seq`:

- `digest.shared`: `digest_id`, `scope`, `text`, `expires_at`, `idempotency_key` (SHA-256 of the
  key), `payload_hash`, `start_seq`, `authorization` (`grant`);
- `vote.cast`: `question_id`, `answer`, `idempotency_key`, `payload_hash`, `start_seq`,
  `authorization` (`grant` or `policy`);
- `digest.revoked`: `digest_id`.

No `decision_id` and no `policy_version` in any payload: the plugin cannot know either (the ODS
writer resolves the decision from the follower's rows). The text travels in `digest.shared` in
every capture mode: the share is the resident's approved act, not telemetry. The worker keeps
them for research-consenting tenants only, which is why the tools ask ingest first.

**Codes.** Tool refusals: `disabled`, `approval_not_configured`, `text_required`, `text_too_long`,
`text_invalid`, `text_no_letter_or_digit`, `text_sanitized`, `scope_invalid`, `expires_invalid`,
`not_available_no_events`, `not_available_no_consent`, `rationale_quotes_share`,
`rationale_invisible`, `rationale_imitates_prompt`, `rationale_mixed_script`, `rationale_charset`,
`too_many_pending`, `digest_id_required`, `digest_unknown`, `share_in_flight`, `revoke_failed`,
`tenant_unknown`, `question_unavailable`, `question_id_required`, `question_not_open`,
`question_closed`, `answer_invalid`, `rationale_invalid`, `vote_already_proposed`, `vote_unknown`,
`vote_in_flight`, `vote_already_cast`. States: `unfiled`, `requested`, `cleared`, `starting`,
`emitting`, `emitted`, `revoked`, `rejected`, `withdrawn`, `expired`, `refused`,
`start_unconfirmed`, `lapsed`, `closed`, `not_shared`, `not_cast`, `invalid`, `emit_refused`,
`emit_failed`, `emit_unconfirmed`, `revoke_lapsed`. Entry codes include `question_unavailable`,
`question_closed`, `answer_not_an_option`, `payload_unencodable`, `payload_tampered`,
`start_answer_mismatch` and `authorization_mismatch`. Log lines carry these codes only, never the
text, the rationale or an answer.

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

## Foreground `terminal` calls (DATA-312)

**Why.** The fleet model (`openai/gpt-6-luna`, since 2026-10-02) fills every parameter of Hermes's
`terminal` tool on every call, e.g. `{"command": "...", "background": false, "timeout": 20,
"workdir": "", "pty": false, "notify": false, "heartbeat": 60}`; the schema's `minimum: 60` makes its
`heartbeat` filler truthy, and Hermes v0.21.5 (2026.9.24) rejects a foreground call with a truthy
`notify`, `watch_patterns`, `notify_on_complete` or `heartbeat` before running anything
(`tools/terminal_tool.py:1441-1453` at that tag), so the model retried the identical call four times
and fell back to `execute_code`.

**What the hook does.** The plugin's `pre_tool_call` (`with_terminal_args_fix` around the telemetry
counter; the rule is `_terminal_args.py`) returns `{"action": "modify", "args": {...}}` when, and
only when, the tool name is exactly `terminal`, `args` is a dict, `background` is not truthy **as
the handler will see it**, and at least one of `notify`, `heartbeat`, `notify_on_complete`,
`watch_patterns` is truthy as the handler will see it, or `notify` is present but neither a bool
nor a list (the handler's later "notify must be true/false" rejection, e.g. `0`, `""`, `"maybe"`).
"As the handler will see it" means after Hermes's schema coercion (`tools/arg_coercion.py`
`coerce_tool_args`), which runs *before* the hook on the `model_tools.handle_function_call` path
(`model_tools.py:888`) and *after* it on the agent loop (the hook fires on the parsed arguments,
then `handle_function_call(skip_pre_tool_call_hook=True)` coerces). The rule mirrors exactly the two
coercions that can change these keys: `background` (schema boolean) becomes a bool only from a
string that strips and lower-cases to `"true"` or `"false"` (so `"false"` is a foreground call,
while `"0"`, `"no"` and `"off"` stay truthy strings, i.e. background); `heartbeat` (schema integer)
becomes an int only from a string that parses as a finite integral number (`"60"` -> 60, `" 0 "` ->
0, `"0.5"` stays a string). `notify` (an `anyOf` with no `type`), `notify_on_complete` and
`watch_patterns` (not in the schema) are never coerced. On already-coerced arguments the mirror is
the identity, so both paths reach the same decision. The directive carries **only** the offending
keys, set to `notify: false`, `heartbeat: 0`, `notify_on_complete: false`, `watch_patterns: null`:
each is falsy for the foreground check and passes the handler's type checks (`heartbeat` must be a
non-bool int >= 0; `notify` a bool or list), and none is a string, so coercion after the hook leaves
them alone. A modify directive cannot delete a key, so "off" is a value. `command`,
`workdir`, `timeout`, `pty` and `background` are never touched; a background call is never touched;
no other tool is touched. `pty: true` on a foreground call is still the handler's own error, and
`workdir: ""` is already "no workdir" there (every use is a truthiness test: `terminal_tool.py:846`,
`:1208`, `terminal_tool_guards.py:41`, `terminal_tool_result.py:223`). The rule is pure (no I/O, no
clock), cannot raise (any internal error returns `None`, which is what this hook returned before),
and logs one DEBUG line on the `av-events` logger naming the keys it switched off, never a value or
the command. If the telemetry part of the hook ever returns a directive, that directive wins.

It is not telemetry, so it sits outside the telemetry guard: it runs with no token, with
`AV_EVENTS_ENABLED=0`, with `pre_tool_call` in `AV_HOOKS_DISABLED` and in a degraded session. Nothing
new reaches the event stream. One visible effect: `tool.call`'s `args_hash` / `args_length` for such
a call describe the modified arguments, because Hermes hands `post_tool_call` the modified args.

**How Hermes applies it** (v2026.9.24, the deployed release; on main `118984d7` of 2026-09-20 the
merge is the same, but a raising callback is skipped rather than blocking and the first `approve`
returns at once):

- Every `pre_tool_call` callback is called with the **same original `args`**, in registration order
  (directory plugins sorted by name, then the config shell hooks, which gateway startup registers
  after plugin discovery). No callback sees another's modification.
- The results are folded once (`hermes_cli/plugins.py:1854-1906`): each `modify` shallow-merges its
  `args` into one accumulated dict built from the original args (`:1881-1888`); the first valid
  `block` returns at once, carrying whatever modifications came before it (`:1897`); an `approve` is
  held until the whole list is scanned, so a later block still wins and later modifies still merge
  (`:1903`). Order therefore cannot change the outcome for this fix: a block blocks, otherwise the
  merged args run.
- The modified args are what the tool runs with and what `post_tool_call` receives, on all three
  paths that fire the hook: `model_tools.py:778-783` (`function_args` replaced; the `_emit` closure
  at `:896-900` reads the rebound name), `agent/tool_executor.py:651-663` and `:694-696` (the agent
  loop: `ref.args`/`state.args`, then `prepare_current_terminal(ref)` at `:718` snapshots the
  modified args, which `validate_prepared_terminal` compares against inside the handler), and
  `agent/agent_runtime_helpers.py:2347-2358`. The assistant message in the transcript keeps the
  model's original arguments; only dispatch and the hooks after it see the modified ones.
- A callback that **raises** is turned into a block (`plugins_dispatch.py:240-242`,
  `_policy_error_block_directive` at `:59`); one that **times out** (`plugins.hook_callback_timeout`,
  default 30 s, `:153`) or is still running blocks too (`:229-234`), and a timed-out callback is
  then skipped, and so blocks, for 60 s. That is why the rule cannot raise and does no I/O.

**The approval gate.** `plugins/av-approval` only raises (a block) on a gated tool while the gate is
unverified; the approval.md shim is a config shell hook. Both are `pre_tool_call` callbacks and
both judge the **original** arguments, never this plugin's modification (see above). So the fix
cannot change what a resident approves: the verdict binds the command and `workdir` the model sent,
which are exactly what runs; the only difference is that notification behaviour is removed from a
call that Hermes would otherwise refuse to run at all. Corollary: a gate that refuses a call for
its arguments (the shim's "absolute `workdir` required" rule, with the model's `workdir: ""`) still
refuses it, and no `modify` here could change that, because the gate never sees the modification.

**Which processes.** Chat turns run in the gateway process (`gateway run`). Cron turns also run in
the gateway process: the in-process ticker (`gateway/run.py:4865-4869`) builds an `AIAgent`
(`cron/scheduler.py:2411`) on its own thread, because an external worker is used only under a
systemd-managed gateway (`tools/process_registry.py:405-411`: not Linux, or no `INVOCATION_ID`,
means in process). Under systemd the worker is `python -m cron.scheduler --external-worker-file`,
and `invoke_hook` discovers plugins lazily there (`hermes_cli/plugins.py:1730`), so the fix loads in
that process as well. Either way it needs `av-events` in `plugins.enabled`, which the installer
writes.

**Kill switch.** `AV_TERMINAL_ARGS_FIX=0` (or `false`, `no`, `off`) turns it off; default on. It is
read from the process environment on every call (a dict lookup, no `.env` stat in a fail-closed
hook); Hermes loads `$HERMES_HOME/.env` into the process environment at gateway start, so a `.env`
change takes effect at the next restart.

**Verify on a canary.** After the roll, on the canary's next scheduled script job (or a chat turn
that runs a script), the `tool.call` event for `terminal` has `status: ok` and a duration in
seconds, not an error in a few milliseconds; the tool result in `~/.hermes/state.db` (`messages`,
role `tool`) is the script's output, not "notify/heartbeat only apply to background commands". With
DEBUG logging on, the gateway log shows `av-events: terminal_args neutralised=heartbeat`.

**Fallback.** The DATA-312 prompt text (call `terminal` with the command only; see the root
README) stays: it is what remains when this plugin is absent, disabled or switched off.

## Messages

Spec §4.1 `message.in/out`. `pre_llm_call`'s `user_message` is `message.in`, `post_llm_call`'s
`assistant_response` is `message.out`, once per turn each. Never the text, in any mode.

| Session | `message.in` actor | `channel` |
|---|---|---|
| a conversation | `participant` | the session's `source` (`telegram`, `desktop`, …) |
| a conversation, on a turn Hermes injected itself (below) | `system` | the session's `source` |
| cron (`platform="cron"`, a `cron_<job>_<stamp>` id, or a subagent of one) | `system` — the "user message" is the job's prompt | `cron`, with `cron_job_id` |
| a delegated subagent | `agent` — the "user message" is the delegator's goal | `subagent` |

`message.out` is always `actor: agent`. A channel that does not look like a platform name is
reported as `other`. `sender_id` is never read.

**Injected turns (DATA-109).** The gateway runs its own synthetic turns through the normal agent turn
in the participant's session, and `pre_llm_call` hands their text over as `user_message` with no
flag: process watch and completion notifications and async-delegation results
(`gateway/run_notifications.py`, `gateway/wake.py`), `/loop` wakeups and the heartbeat, `/goal`
continuations (`gateway/run_goals.py`), plugin injections (`gateway/run_inbound.py`), the
CLI-to-channel handoff and the restart auto-resume turn (`gateway/run_startup.py`, `gateway/run.py`).
Their `message.in` is `actor: system`, on the session's own channel; the payload is unchanged
(`message.in@1` is closed, and the envelope's `actor` already has `system`). Two signals, checked
against Hermes `main` at `118984d7a0`:

- Hermes stamps the turn's user dict with `display_kind = "internal_notification"` for every
  `MessageEvent(internal=True)` and for the heartbeat (`display_kind_for_event`), and that dict is the
  last item of `pre_llm_call`'s `conversation_history`. Only that last item is read, only when it is a
  `user` row, and only its `display_kind`: an earlier injected row never marks a later human turn.
- The `/goal` continuation is not internal, so it carries no mark and is known by the header Hermes
  writes at the start of it, `[Continuing toward your standing goal`. That is the only header matched.
  Every other kind is known by the mark alone, so a participant message that opens with a pasted
  `[IMPORTANT: Background process …` or `[System note: …` stays `participant`.

At `v2026.8.31` (`29112be`) the same mark exists: `agent/turn_context.py` stamps
`persist_user_display_kind` on the user dict, and `gateway/run.py` sets it to `internal_notification`
for every `internal` event (the heartbeat's mark came later). The Hermes tenants run is not pinned in
this repository or the release manifest (the control plane sets the image), so a tenant on a Hermes older
than the mark reports every injected turn but the `/goal` continuation as `participant`.

A real message sent while a resume is pending stays `participant`: Hermes prepends the recovery note
for the model but hands the hook the user's clean words. A cron run is unchanged (its prompt was
always `system`, channel `cron`, with its job id; the scheduler binds `HERMES_CRON_SESSION=1` for the
same runs whose ids are `cron_<job>_<stamp>`), and a subagent's goal stays `agent`.

**Known misses** (documented, not fixed):

- On a Hermes without the mark, every injected kind but the `/goal` continuation stays `participant`
  (above).
- In Hermes's `queue` busy mode (`/busy queue`), a participant message debounced into a pending
  internal wake or a pending `/goal` continuation is merged into that turn, and the turn leaves as
  `system`. Hermes itself shows that row as a notice, not a user bubble.
- Replays of an at-least-once notification are still separate events; they are `system` now.

**Attention.** `marts.attention_proxy` (rule `attention_messages_v1`) already counts only
`actor = 'participant'`. From the deploy of this plugin change onward, injected turns therefore leave
v1's participant count; before it they were in it. The data side bumps the rule to
`attention_messages_v2`, dated at that deploy, and the mart's own doc lines that say injected turns
count as the participant become stale with it.

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
and each operation by method and path. Line continuations (backslash-newline) are removed first,
as the shell removes them (joined with nothing; not inside single quotes) — the skill's own recipes
are multi-line, and `tests/test_edgeos_skill_recipes.py` feeds every recipe in the skill verbatim.
The command is then tokenised as a shell would (`shlex`, with control operators and newlines split
out) and read only when it is unambiguous (DATA-269: a receipt only for the command that actually
ran; when in doubt the call is just a `tool.call`):

- leading and trailing whitespace is dropped first (a final newline runs nothing);
- **the curl is the whole command**: its first word is `curl` (not a path to one) and nothing comes
  before it — no `cd`, assignment, `export`/`unset`, other command or here-document;
- the base is named only as the recipes name it: `$EDGEOS_API_BASE`, `${EDGEOS_API_BASE}`, or
  `${EDGEOS_API_BASE:-<default>}` with `<default>` exactly `https://api.edgeos.world/api/v1`. It is
  expanded from the plugin's own `EDGEOS_API_BASE`, which must be an https URL on an allowlisted
  host (a dev tunnel gets no labels); unset, only the `:-` form names a host. Any other `$`
  outside single quotes — another variable, `:=`/`:+`/`:?`, `$'…'` — is refused, except
  `$EDGEOS_API_KEY` / `$EDGEOS_BEARER_TOKEN` inside double quotes. So are unquoted braces and glob
  characters, `#`, and a carriage return. A shell environment that differs from the plugin's (an
  earlier `export`, a `~/.curlrc`, a proxy variable) is outside what the plugin can see;
- **every** http(s) URL in the command — the request target, headers, other options, anything before
  the curl — is on the EdgeOS host, with no userinfo and no port other than `:443`. The one exception
  is a request body: a URL inside the value of `-d`, `--data`, `--data-raw`, `--data-binary` or
  `--json` is content (a `picture_url`), not a place the request goes, so it is not read. `-F` is
  not a body in this sense (`-F x=@file` reads a file);
- exactly one `curl` word (`echo curl …` and a `for` body are not requests);
- after a **write** (anything but GET) nothing follows it: no `;`, `&&`, `||`, `|`, redirect or new
  line — each could run a second request or rewrite what the agent saw as the response;
- after a **read** (GET) only these may follow, in order: `2>&1`, a `| jq …` pipeline (arguments
  only, no further operator), trailing newlines. A read whose output went through `jq` is labelled
  but **never confirms** an action: its output is what the agent made of the response, and
  `jq '.my_rsvp_status = "registered"'` would otherwise forge a receipt;
- no command substitution (`$(…)`, backticks) anywhere;
- no option that moves the request or drops the host check: `--resolve`, `--connect-to`,
  `-x`/`--proxy` (and the SOCKS/pre-proxy/DoH forms), `-K`/`--config`, `-k`/`--insecure`,
  `--unix-socket`, `--dns-servers`, `--cacert`/`--capath`; none that changes what the request is or
  builds its URL: `-I`/`--head`, `--variable`, `--expand-*`, `-G` with data; no `--name=value`
  (curl has no such form and sends nothing);
- options that divert the body or add to stdout (`-o`, `-O`, `-w`, `-D`, `-i`, `-v`, `--trace*`,
  `--stderr`, `--libcurl`) keep the label, but the output is treated like a `jq` read's: it never
  confirms, and an RSVP with them waits on nothing;
- curl's own arguments give exactly one URL (`--url` or positional; the same URL twice is two), and
  every EdgeOS URL in the command names that same path;
- the method is curl's: `-X`/`--request` wins, and must be written as one of `GET`, `POST`,
  `PATCH`, `PUT`, `DELETE` (curl sends `-X post` as written); else `-G`/`--get` is GET; else `-T` is PUT; else
  `-d`/`--data*`/`--json`/`-F` is POST; else GET. Combined short flags are read the way curl reads
  them (`-sX POST`, `-sXPOST`, `-sSfL`), and an option that takes a value consumes it;
- the URL has no whitespace or control character; path parameters are UUIDs (full match).

**Known misses**, all conservative (the call is just a `tool.call`): a body built by command
substitution (`-d "$(cat body.json)"`; the skill does not do this); a curl through `execute_code` or
another tool; a `cd … &&` or other prefix before the curl. Every recipe in the skill is recognised
(`tests/test_edgeos_skill_recipes.py`, which reads them from the skill by heading).

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
  is then their words. Nor is an exact name (DATA-92): the participant can ask for a job named
  exactly `Edge — daily digest`, so the name is reported only when the job id is also one the
  installer recorded in `$HERMES_HOME/av-events/installed_jobs.json` (`{"ids": [...]}`, rewritten by
  `install/install_index.ts` on every install and update with the ids of the crons it created or
  manages). No record, no names: a tenant installed before the record existed reports `job_name:
  null` until its next install. `cron.run` is on the ops allowlist and kept without research consent
  (spec §2.2), so it carries nothing a participant wrote. Every other job has `job_name: null`.
- **A missing or stale record drops installer runs, not only their names.** The worker keeps a
  `cron.run` from a tenant without research consent only when it names an installer job; one with
  `job_name: null` is dropped as `cron_participant_job` (`agentvillage-data`
  `src/worker/consent.ts`). So while `installed_jobs.json` is missing or stale — a tenant not yet
  re-installed since this change, an install run with `--skip-crons`, no `hermes` CLI when the
  installer ran, or an exception before `writeInstalledJobIds` — the installer's own cron runs from a
  non-consenting tenant are lost to the ops record, not merely unnamed. Production closes the window
  because the tenant container's `start-tenant.sh` runs `install.ts` on every boot, which rewrites the
  record; a tenant whose install never reaches the cron step keeps losing them until one does.
- **Id shapes.** Ingest takes a job id of 12 lower-case hex (`uuid4().hex[:12]`) and an execution id
  of 32 (`uuid4().hex`). An execution whose ids are any other shape (a hand-edited `jobs.json`)
  yields no `cron.run`, and a cron session whose job id is another shape still reports its
  `message.*` and `session.*` as cron, with `cron_job_id: null`; otherwise ingest would quarantine
  every one of them.
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
keeps one row. **Without it the id is still derived (DATA-185)**: a uuid v7 whose timestamp is the
execution's `finished_at` (else its start, else its claim) and whose 74 random bits are the first
bits of SHA-256 over `av-events|cron|<execution_id>` (`_core.cron_run_event_id_without_tenant`).
Ingest takes any v7 from a plugin token, so the same execution gets the same id from every process.
That matters because the tail runs in every process that loads the plugin with a token — the
gateway, `hermes dashboard`, a CLI — and each reads the cursor once: a dashboard started before a
run finished reports it again after the gateway has, and a random v7 would store it twice. The
control plane sets `TENANT_ID` in the sandbox's environment when it creates the sandbox, so every
process in it inherits the same value. Two processes of which only one has it would still disagree
(v5 against v7), so the derived v7 covers a tenant id that is missing everywhere, not one missing
from a single process. A `TENANT_ID`
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
all. Gateway shutdown finalizes the sessions that had a turn running (`gateway/run_shutdown.py`),
so a pass is requested for those,
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
says nothing about what the route holds and clears nothing. A 3xx is never followed (the uploader
speaks `http.client`, which does not redirect) and is a failure like any other, also counted as
`backup_redirect_refused`. An archive over `AV_BACKUP_MAX_BYTES` is
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

## Asking about consent (DATA-157)

The plugin registers one tool, `consent_status` (toolset `av-events`, no parameters), so the agent
can answer "am I in the research?" and "is my data used for training?" from the record instead of
guessing. It is a **read**: one `GET {AV_EVENTS_URL}/v1/consent` with `Authorization: Bearer
{AV_EVENTS_TOKEN}`, no query string and no body; ingest answers for the token's own tenant only
(agentvillage-data `src/ingest/consent.ts`, whose module comment is the contract). The tool writes
nothing, buffers nothing and emits no event of its own. Consent is changed only on the Research
participation panel on the Agent Village landing page; the tool never offers to change it.

**What the agent should do.** When the person asks whether they are in the research or the training
data, or about their research consent, call `consent_status` (no arguments) and answer from what
it returns. If it is not in the model's tool list, it is reached through Hermes's tool-search bridge:
`tool_search` finds it and `tool_call` with `name: consent_status` calls it (see **Hermes** below).
For a change, point them at the Research participation panel on the Agent Village landing page.
Never state a research status without the tool; if the tool itself answers that it could not
check, say so and point at the panel.

What it answers, by the row ingest returns (dates are UTC days):

| Row | Answer |
|---|---|
| `null` | No research choice is on record for this agent. To take part or decline, use the Research participation panel on the Agent Village landing page. |
| `granted` | You are in the research: you opted in on *accepted_at* under research brief *brief_version*. You also agreed (or: did not agree) to your data being used for training. To change this, use the panel. |
| `declined` | You are not in the research: you declined on *accepted_at*, and your data is not used for training. (If a deletion is pending: your data is deleted on *date* unless you opt back in.) To take part, use the panel. |
| `withdrawn`, `withdrawn_at` < `accepted_at` | Your opt-in at *accepted_at* came too close to your withdrawal at *withdrawn_at* to count, so you are not in the research, and your data is not used for training. Your data is deleted on *withdrawal_pending_until* unless you opt back in: turn the Research participation panel off and on again. |
| `withdrawn`, deletion pending | You are not in the research: you withdrew on *withdrawn_at*, and your data is not used for training. Your data is deleted on *withdrawal_pending_until* unless you opt back in from the panel. |
| `withdrawn`, nothing pending | You are not in the research: you withdrew on *withdrawn_at*, and your data is not used for training. No deletion of your research data is pending: it has already been carried out, or none was scheduled. To opt back in, use the panel. |
| anything else | I could not check your research status right now. The Research participation panel on the landing page shows it. |

"Anything else" is no token, no URL, `AV_EVENTS_ENABLED` off or `consent_status` in
`AV_HOOKS_DISABLED`, any status but 200 (401, 403, 429, 503, a redirect, which is refused so the
bearer never follows it), a network error, the deadline, or a body that does not hold the
contract's eight keys with their types and agree with itself (`research` exactly when `granted`,
`training` only with `research`, nothing pending while `research`, a `withdrawn_at` in `withdrawn`),
or whose `brief_version` is not ingest's own shape (`^[A-Za-z0-9._:-]{1,128}$`; the model reads that
string, so nothing else may reach it). Dates must be zoned ISO 8601 that convert to UTC. It is
**never** reported as "not in the research". "You are in the research" is said only when `research` is true.

**Time.** One overall deadline of 8 seconds covers DNS, connect, headers and body together; each
socket operation also has its own 5-second timeout. urllib's timeout is per operation only, so on its
own a server dripping a byte every few seconds, or a slow DNS answer, could hold the turn for as long
as it liked. The GET therefore runs on a daemon thread that the tool waits on for at most the
deadline; past it the answer is "could not check" and the thread is abandoned. A socket stuck that
way lingers until its per-operation timeout fires, or, for a slow drip that keeps each read under
the timeout, until the server stops sending, the 64 KiB body cap is reached, or the process exits (a
looped caller adds about seven such threads a minute, so this is not an exhaustion path). That is the fail-open
trade: the turn is never held longer than the deadline, at the cost of a stray thread.

The URL and token are read as the collector reads them: process environment first, then
`$HERMES_HOME/.env`, and a variable present but blank in the process environment is authoritative (a
revoked token is "could not check", not a stale `.env` token). Log lines are codes only
(`av-events: consent_status unavailable=http_503`, `... failed=RuntimeError`,
`... skipped=no_register_tool`, `... register_failed=PermissionError`); never the URL, the token or
anything from the row.

A `consent_status` call still passes through the `post_tool_call` hook like any tool. Since
`tool_categories_v2` it is listed in `tool_categories.json` with category `meta` (the plugin's own
introspection tools; v1 left it unlisted, so it counted as `other` with a null name), so its
`tool.call` carries `tool_name: "consent_status"` and `tool_category: "meta"`, and it records no
intention.

**Hermes.** `ctx.register_tool(name, toolset, schema, handler, ..., description=...)`
(`hermes_cli/plugins.py:460`); the handler is called as `handler(args, **kwargs)` and must return a
string (`tools/registry.py`, `dispatch` and `_normalize_handler_result`). A plugin toolset is
offered to the model on every platform unless it is default-off or the operator saved a toolset list
that leaves it out (`hermes_cli/tools_config.py`, `_enabled_plugin_toolsets`), so no `config.yaml`
line is needed. On a Hermes with `tools.tool_search.enabled` at its default `"auto"`, a plugin
tool is deferrable (`tools/tool_search.py`, `is_deferrable_tool_name`) and the bridge activates
whenever any deferrable tool exists (`should_activate`), so the tool is deferred: the model's list carries the bridge
(`tool_search`, `tool_describe`, `tool_call`) instead of `consent_status`, and a direct call answers
that the tool does not exist. The tool is then reached as `tool_search` → `tool_call` with `name:
consent_status` and empty arguments (the bridge validates arguments against the schema, which has
none, hence "Takes no arguments" in the description). Tenants already reach their curated deferred
tools this way, so this is relied on rather than configured around. No test here covers the bridge;
it is a dogfood check. A Hermes without `ctx.register_tool` gets one log line and no tool; every hook is
registered either way, and a `register_tool` that raises costs the tool, never the hooks.

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
  Its one return value is the DATA-312 `modify` directive for a foreground `terminal` call (see
  "Foreground `terminal` calls"), built by a pure function that cannot raise.
- **50 ms budget per hook**, measured with `time.perf_counter`. Overruns are *counted, never
  enforced*: aborting a hook halfway is worse for the agent than a slow one. Counts live in
  `collector.overruns`.
- **No network in a hook, ever.** Hooks hash and append a line; a daemon thread does all network
  I/O and the cron tail. The only other file I/O a hook does is bounded and local: at session close,
  one read-only row from `state.db` (50 ms lock timeout) and a read of each USER.md (≤ 1 MiB); on an
  EdgeOS RSVP or its confirming read, one small ledger write; and once per tenant, ever, the creation
  of `hash.key` (then cached in memory). A memory snapshot is only *requested* in a hook (a flag and,
  at most, a thread start); its reads, compression and uploads happen on the backup thread.
  `on_session_end`, `on_session_finalize` and `session.ended` only *wake* the flusher (the finalize
  also renames the current batch into the queue). Plugin load is not a hook, but it is held to the
  same rule: with a token, `register` opens the buffer, may rename a leftover file and may start the
  flusher, and none of that raises or touches the network. `ingest` being down changes nothing
  the agent can observe (spec scenario 24).
- **Hooks never return a value.** The decorator discards whatever the body returns, so this plugin
  structurally cannot block a tool call, inject context into a user message, or rewrite a response.
- **The one tool fails open too.** `consent_status` does network I/O, synchronously, because the model
  asked for it and is waiting: at most one GET, bounded by an 8-second overall deadline (see **Time**
  above; a stuck socket is abandoned on a daemon thread, not waited for). Any exception inside it
  becomes the could-not-check answer and one log line naming the exception's class; only
  `SystemExit` passes.

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

A batch is retried only when retrying could ever work: network failures, 5xx, 408/425/429, and a
3xx. A redirect is refused, never followed, so the bearer stays with `AV_EVENTS_URL`'s host; ingest
never redirects, so a 3xx is a fault in front of it (a proxy, a moved domain), not a verdict on the
batch, and quarantining the batch would lose good evidence. It logs `ingest_redirect_refused` once
per process (a name and a count, never the URL or the `Location`). Spec §7.1 (draft 1.2, clean)
now names 3xx in the retry set and the no-proxy, no-redirect rule (DATA-172). It
backs off exponentially (2 s doubling, capped at 300 s between attempts) until it is **72 hours
old**, at which point it is deleted. Any other 4xx except 401 (so 400, 403, 413, 422) is a
statement about this batch that will not change on its own, so the file is moved to
`buffer/rejected/` and never offered again. It is *kept* rather than deleted: a 403 or a 413 is a
misconfiguration a human needs to see, and deleting the evidence would hide it. Ingest answers 403
for `tenant_mismatch`, `source_mismatch` and `token_class_forbidden`, all verdicts on the batch; left
in the queue, a batch like that would hold up the batches behind it for 72 hours.

**401 refuses this process's token, not the batch** (DATA-94). More than one process can load the
plugin against the same buffer: `hermes dashboard` outlives a gateway-only restart and keeps the
token it was started with, while the gateway beside it has the new one. So the file stays where it
is for a process whose token works. This process logs `ingest_auth_rejected` once (a name and a
count), stops sending for 10 minutes (`AUTH_BACKOFF_S`), then re-reads its config and tries again.
The re-read does not rescue a stale process: every `hermes` process loads `$HERMES_HOME/.env` into
its environment at import (`load_hermes_dotenv(override=True)`), and the process environment wins
over the file, so a stale dashboard stays stale until it restarts. It tries once every 10 minutes
and leaves the batches to the gateway. The 72-hour limit still bounds a batch whose token is really
gone.

Either way one `plugin.buffer_dropped` is emitted on the next successful flush, carrying `reason`
(`expired`, `rejected`, or both), `files` / `count` for expiries and `rejected_files` /
`rejected_events` for refusals.

Shutdown is a daemon thread plus an `atexit` hook that force-rotates and makes one bounded
(5 second) attempt at each pending batch. Anything it cannot send survives on disk. That hook runs
only in a process that exits normally (a CLI or desktop session); the gateway never runs it, which
the next section covers.

A line that cannot be read back (a process killed halfway through writing it, even inside a
multi-byte character) is dropped when its batch leaves the queue and counted as
`buffer_unreadable_line`, logged once per process as the name and a count. The rest of the batch is
sent.

### What happens at a gateway stop

Hermes stops the gateway in `gateway/run_shutdown.py` `_stop_impl`. It drains running work (chat
turns for `restart_drain_timeout`, 0 s by default; cron runs on their own budget), interrupts what
is left, fires `on_session_finalize` with reason `shutdown` for each session that had a turn running
when the stop began, and disconnects the adapters. Then `gateway/run.py`
`_exit_after_graceful_shutdown` leaves through `os._exit` (#53107), which runs no `atexit` handler.
No other plugin hook fires on the way. `VALID_HOOKS` has no shutdown hook. `agent_loop_stopped` fires
only for `/stop` and for a `/new` that interrupts a running turn (`gateway/run_agent_cache.py`
`_interrupt_and_clear_session`), never for a stop. The `on_session_end` the teardown triggers is the
memory provider's, not the plugin hook (checked against Hermes `main` of 2026-09-20). So:

**No hook fires on shutdown as such (DATA-182, re-checked against Hermes `main` at `118984d7a0`,
2026-09-27).** What a plugin can hear, by path:

| Path | `agent_loop_stopped` | `on_session_finalize` | Anything else |
|---|---|---|---|
| `/stop` on a running turn (gateway, or the TUI/desktop stop) | yes, `reason` = the stop reason | no | — |
| `/new` or `/reset` on a running turn | yes, then the reset | yes, from the reset | `on_session_reset` for the new id |
| gateway stop, session with a turn running when the stop began | **no**: the stop interrupts through `request_hard_interrupt`, not `_interrupt_and_clear_session` | yes, `reason="shutdown"`, `platform="gateway"` | — |
| gateway stop, idle session (the usual Telegram chat) | no | no | — |
| process exit | no | no | no `atexit` (`os._exit`), no `on_unload` (that runs only on a forced plugin reload) |

There is no fire site on the shutdown path a plugin can register for, and firing `agent_loop_stopped`
there is a Hermes change, not a plugin one. The plugin does not register `agent_loop_stopped` at
all: the "nudge on stop" it needs is already on `on_session_finalize`, which force-rotates and wakes
the flusher, and that covers the "turn running" stop row. The idle sessions and the exit itself are
covered by recovery on the next load (below), not by any hook.

- **Everything the plugin buffered survives on disk**: rotated batches not yet sent, and
  `current-<pid>.jsonl`, the last batch of up to 10 seconds or 50 events. The only thing lost is a
  line the process was halfway through writing when it died (counted, as above).
- **A finalize gives that session a head start.** The `on_session_finalize` hook ends by
  force-rotating the buffer and waking the flusher, never sending itself. The rest of Hermes's
  teardown is then a window in which the dying process may still send that session's close. This
  is a head start, not a guarantee.
- **The next process on the same `$HERMES_HOME` delivers the rest.** At plugin load (`register`),
  with a token set and the plugin enabled, it opens its buffer and, if anything is waiting, starts
  the flusher at once instead of at the first new event (on a quiet chat that can be hours after a
  restart). "Waiting" means a non-empty rotated batch, or a non-empty current file whose owner is
  gone. A live process's current file is not waiting: it is that process's to send, so a second
  process loading the plugin beside a running gateway starts no flusher for it. The flusher's first tick adopts each dead process's `current-<pid>.jsonl`, renaming it
  `<first-event-ms>-<pid>-orphan.jsonl` so it sorts in the order it was written, and sends it on its
  normal pass. That is typically a second or two after the gateway comes back, under the usual
  retry, 72-hour and `rejected/` rules. Cron runs are not special-cased: their events are in the
  same files.
- **Delivery is at least once.** A process can die after ingest accepted a batch and before it
  deleted the file, and the next process then sends the same bytes again. Ingest keeps one row per
  `event_id` (`ON CONFLICT (event_id) DO NOTHING`, `agentvillage-data` `src/ingest/events.ts`), so
  the repeat is counted as a duplicate, not stored twice.
- **A sandbox recreated on a fresh disk has no next process on that disk.** What the old one had
  buffered is lost, except whatever the finalize head start got out.
- **Without a token, or with `AV_EVENTS_ENABLED=0`**, leftover files wait on disk until the plugin
  is active again.
- **Any process that loads the plugin can do the sending.** A CLI process that loads the plugin
  while batches are waiting sends them, and may spend up to about 15 s on its exit flush (the 5 s
  budget, plus one request's 10 s timeout already in flight when it runs out).

How a dead process's file is recognised: each process holds an `flock` on `current-<pid>.lock` for
as long as its buffer exists. The kernel releases it however the process ends, `os._exit` and
SIGKILL included, so a lock another process can take means its owner is gone, even when a restarted
container has given that pid to something else. A container usually gives the gateway the same pid
on every start, so a new process that finds a leftover file with its own pid moves that file aside
before its first append. A new event then never lands behind a half-written line. With no lock to
probe (a file written before DATA-94, or a filesystem without `flock`), a file is adopted once its
pid no longer exists, or once it has gone 5 minutes without a write (`ORPHAN_STALE_S`; a live
writer rotates within about 10 s). The flusher looks for such files on its first tick and every 60
seconds after that. Everything at load and in the scan is a local rename; only the flusher thread
touches the network.

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
  increment for exactly this reason. (From DATA-312 it also returns the `terminal` `modify` directive, still
  without I/O; at v2026.9.24 a *raising* `pre_tool_call` callback blocks too.) `subagent_stop` always runs on the caller thread.

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
    intention path matches that form (and the bare name). The tool-category allowlist
    (`tool_categories.json`) is keyed the same way, so a bare `create_intent` is `other`. Index's
    own Hermes plugin registers its tools by bare name (`index_create_intent`, …): the allowlist
    lists them under `builtin` (v3), and the intention path reads the two intent writes only by
    bare name (DATA-272).
17. **Pause, resume and archive are captured too.** §7.1 names only `create_intent` /
    `update_intent`. Index main (DATA-249) also has `pause_intent`, `resume_intent` and
    `archive_intent`, and an archive is the clearest withdrawal there is. `delete_intent`, from an
    older Index surface, is kept as a legacy alias of `archive_intent`.
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
    counted as `tenant_id_not_uuid`. Without it, the event gets a uuid v7 derived from the execution
(DATA-185), which ingest accepts and dedupes like the v5.
24. **`cron.run.job_name` is null for any job whose name is not exactly an installer name, or whose
    id the installer did not record.** §4.1 requires the key; a participant-authored name must not
    ride the ops allowlist.
25. **`profile.updated` is at `on_session_finalize`**, not `on_session_end` as the task words it:
    `on_session_end` fires per turn (divergence 4).
26. **`message.in` is not always the participant.** In a cron session it is the job's prompt
    (`actor: system`), in a subagent the delegator's goal (`actor: agent`), and on a turn Hermes
    injected into a conversation it is Hermes (`actor: system`, DATA-109; see "Messages").
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
- **`record_intention` without approval.md** — `action=confirm` is refused unless
  `AV_APPROVAL_ENABLED` and `AV_APPROVAL_URL` are set (DATA-212 Lane B). The post-cap sweep and
  replay stay DATA-213.
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
