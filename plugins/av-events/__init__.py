"""av-events — Agent Village V2 telemetry collector for Hermes.

Observes the agent and emits envelope-v1 events (spec §3) to the Agent Village
ingest API. Everything it does is additive to the product path: it fails open,
never blocks on the network inside a hook, and switches off per tenant by env
without a redeploy (`launch-guardrails-draft.md` §2).

This module is the only one that knows anything about Hermes. `_core` holds the
stdlib primitives and `_collector` the state machine, so the test suite can
drive the whole collector with a fake `ctx`.

Python 3.11, standard library only. See README.md.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from ._collector import Collector, guarded, hermes_version, overlay_ref
from ._core import (
    TOOL_CATEGORIES,
    UNLISTED_TOOL_CATEGORY,
    hash_obj,
    hash_text,
    iso_from_epoch,
    sanitize,
    tool_category,
    uuid7,
)
from ._intentions import IntentionCall, classify_tool, valid_id
from ._intentions import plan as plan_intentions

__version__ = "0.1.0"

#: Hermes reports a `platform`; the catalogue (spec §4.1 `session.*`) wants a
#: `source`. Anything unrecognised passes through as-is rather than being
#: forced into a bucket that would misreport the condition.
SOURCE_BY_PLATFORM = {
    "telegram": "telegram",
    "cli": "desktop",
    "tui": "desktop",
    "desktop": "desktop",
    "acp": "desktop",
    "cron": "cron",
    "": "unknown",
}

#: Cap on in-flight `pre_api_request` stashes per session. An API request whose
#: response never arrives (timeout, failover) would otherwise leak a dict entry
#: for the life of the session.
MAX_PENDING_LLM = 32

#: Hooks this plugin registers. Spec §7.1 names the first eight; the last three
#: are additions this milestone needs and are argued in README.md:
#:   - `on_session_start`   — the only place `session.started` can come from.
#:   - `pre_api_request`    — the only hook carrying the tools schema and the
#:                            resolved system prompt.
#:   - `post_api_request`   — the only hook carrying token usage and latency.
#:   - `on_session_finalize` — `on_session_end` fires once per *turn*, so the
#:                            real session close is here.
SPEC_HOOKS = (
    "pre_llm_call",
    "post_llm_call",
    "pre_tool_call",
    "post_tool_call",
    "on_session_end",
    "subagent_start",
    "subagent_stop",
    "on_stream_end",
)

EXTRA_HOOKS = (
    "on_session_start",
    "pre_api_request",
    "post_api_request",
    "api_request_error",
    "on_session_finalize",
)

#: Hooks Hermes fails *closed* on: a callback that times out or is still
#: running injects a block directive and the tool never runs
#: (`hermes_cli/plugins.py:441`). Their bodies do no I/O whatsoever — no config
#: reload, no lazy session open, no buffer write — so they cannot stall a tool.
QUIET_HOOKS = frozenset({"pre_tool_call"})

#: Module-level singleton. `register(ctx)` is called once per process by the
#: Hermes loader (`hermes_cli/plugins.py:5282`).
_COLLECTOR: Optional[Collector] = None

#: Guards against a double `register()` appending a second copy of every hook.
_REGISTERED = False


def _collector() -> Optional[Collector]:
    return _COLLECTOR


def _source_for(platform: Any) -> Optional[str]:
    """Map Hermes's `platform` to the catalogue's `source`, or None if absent.

    None rather than "unknown": most hooks carry no `platform`, and writing
    "unknown" on the first of them would latch a wrong source that the later
    `on_session_start` could not correct.
    """
    text = str(platform or "").strip().lower()
    if not text:
        return None
    return SOURCE_BY_PLATFORM.get(text, text)


def _session(collector: Collector, kwargs: dict) -> Any:
    """Resolve (and lazily open) the session this hook belongs to."""
    session_id = kwargs.get("session_id") or kwargs.get("parent_session_id")
    if not session_id:
        return None
    return collector.open_session(str(session_id), _source_for(kwargs.get("platform")))


def _refs(kwargs: dict) -> dict:
    """Envelope refs shared by the API-request hooks.

    `run_id` is Hermes's `task_id`, but only when it actually names a distinct
    run: Hermes sets `task_id` to the session id on the plain conversation path,
    and a `run_id` that merely repeats `session_id` is noise that would make
    per-run aggregates in `marts` wrong.
    """
    session_id = str(kwargs.get("session_id") or "") or None
    task_id = kwargs.get("task_id") or None
    return {
        "session_id": session_id,
        "turn_id": kwargs.get("turn_id") or None,
        "run_id": task_id if task_id and task_id != session_id else None,
    }


# --------------------------------------------------------------------------
# Hook bodies
#
# Each takes the collector first (supplied by `guarded`) and then the hook's
# keyword payload. They declare `**kwargs` deliberately: Hermes inspects the
# callback signature and passes the *complete* payload only to callbacks with a
# VAR_KEYWORD parameter (`hermes_cli/plugins.py:5537`), so a narrow signature
# would silently stop receiving fields as the payload grows.
# --------------------------------------------------------------------------


def _hook_on_session_start(collector: Collector, **kwargs: Any) -> None:
    session_id = kwargs.get("session_id")
    if not session_id:
        return
    # The one hook that reliably carries `platform`, so this is usually where a
    # deferred `session.started` finally gets its source and goes out.
    collector.open_session(str(session_id), _source_for(kwargs.get("platform")))


def _hook_pre_llm_call(collector: Collector, **kwargs: Any) -> None:
    state = _session(collector, kwargs)
    if state is None:
        return
    if kwargs.get("user_message"):
        state.message_count += 1


def _hook_post_llm_call(collector: Collector, **kwargs: Any) -> None:
    state = _session(collector, kwargs)
    if state is None:
        return
    if kwargs.get("assistant_response"):
        state.message_count += 1


def _hook_pre_api_request(collector: Collector, **kwargs: Any) -> None:
    """Hash the tool schemas and the system prompt; stash for `post_api_request`.

    Hashing only. The bodies themselves leave the process exactly once per
    distinct hash, and only in `full` capture.
    """
    state = _session(collector, kwargs)
    if state is None:
        return
    request = kwargs.get("request")
    body = request.get("body") if isinstance(request, dict) else None
    tools = body.get("tools") if isinstance(body, dict) else None
    system_prompt = kwargs.get("system_prompt")

    tools_hash = hash_obj(tools) if tools else None
    prompt_text = system_prompt if isinstance(system_prompt, str) else None
    system_prompt_hash = hash_text(prompt_text) if prompt_text else None

    request_id = str(kwargs.get("api_request_id") or "")
    if request_id:
        if len(state.pending_llm) >= MAX_PENDING_LLM:
            state.pending_llm.pop(next(iter(state.pending_llm)), None)
        state.pending_llm[request_id] = {
            "tools_hash": tools_hash,
            "system_prompt_hash": system_prompt_hash,
            "tool_count": kwargs.get("tool_count"),
            "approx_input_tokens": kwargs.get("approx_input_tokens"),
            "system_prompt_length": len(prompt_text) if prompt_text else 0,
            "turn_id": kwargs.get("turn_id") or None,
            "task_id": kwargs.get("task_id") or None,
            "started_at": kwargs.get("started_at"),
        }

    refs = _refs(kwargs)
    # `full` capture only; content-addressed, so this is a no-op after the
    # first session that saw these bytes.
    if tools_hash:
        collector.register_prompt("tools", tools_hash, tools, **refs)
    if system_prompt_hash:
        collector.register_prompt("system_prompt", system_prompt_hash, prompt_text, **refs)


def _hook_post_api_request(collector: Collector, **kwargs: Any) -> None:
    """Emit `llm.call`. This is the only hook carrying usage and latency."""
    state = _session(collector, kwargs)
    if state is None:
        return
    request_id = str(kwargs.get("api_request_id") or "")
    stashed = state.pending_llm.pop(request_id, {}) if request_id else {}

    usage = kwargs.get("usage") if isinstance(kwargs.get("usage"), dict) else {}
    input_tokens = int(usage.get("input_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or 0)
    state.input_tokens += input_tokens
    state.output_tokens += output_tokens

    duration = kwargs.get("api_duration")
    payload: dict[str, Any] = {
        "model": kwargs.get("model"),
        "provider": kwargs.get("provider"),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cache_read_tokens": int(usage.get("cache_read_tokens") or 0),
        "cache_write_tokens": int(usage.get("cache_write_tokens") or 0),
        "reasoning_tokens": int(usage.get("reasoning_tokens") or 0),
        "latency_ms": int(float(duration) * 1000) if isinstance(duration, (int, float)) else None,
        "finish_reason": kwargs.get("finish_reason"),
        "tools_hash": stashed.get("tools_hash"),
        "system_prompt_hash": stashed.get("system_prompt_hash"),
        "api_request_id": request_id or None,
        "api_mode": kwargs.get("api_mode"),
        "response_model": kwargs.get("response_model"),
        "tool_count": stashed.get("tool_count"),
        "message_count": kwargs.get("message_count"),
        "api_call_count": kwargs.get("api_call_count"),
    }
    if collector.config.capture != "metadata":
        # Lengths, never bodies.
        payload["system_prompt_length"] = stashed.get("system_prompt_length")
        payload["assistant_content_chars"] = kwargs.get("assistant_content_chars")
        payload["assistant_tool_call_count"] = kwargs.get("assistant_tool_call_count")
        payload["approx_input_tokens"] = stashed.get("approx_input_tokens")

    _emit_llm_call(collector, payload, stashed, kwargs)


def _hook_api_request_error(collector: Collector, **kwargs: Any) -> None:
    """A terminal API failure. Hermes fires this *instead of* `post_api_request`.

    Without it every failed call is an `llm.call` that never arrives, so error
    rate looks like zero and the stash for that request leaks until evicted.
    """
    state = _session(collector, kwargs)
    if state is None:
        return
    request_id = str(kwargs.get("api_request_id") or "")
    stashed = state.pending_llm.pop(request_id, {}) if request_id else {}

    error = kwargs.get("error") if isinstance(kwargs.get("error"), dict) else {}
    duration = kwargs.get("api_duration")
    payload: dict[str, Any] = {
        "model": kwargs.get("model"),
        "provider": kwargs.get("provider"),
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "reasoning_tokens": 0,
        "latency_ms": int(float(duration) * 1000) if isinstance(duration, (int, float)) else None,
        "finish_reason": "error",
        # Class name only. Hermes documents `error_message` / `error_body` as
        # possibly carrying an unredacted provider dump, which can include the
        # prompt that caused the failure.
        "error_type": str(error.get("type") or kwargs.get("error_type") or "") or None,
        "status_code": kwargs.get("status_code"),
        "retryable": kwargs.get("retryable"),
        "tools_hash": stashed.get("tools_hash"),
        "system_prompt_hash": stashed.get("system_prompt_hash"),
        "api_request_id": request_id or None,
        "api_mode": kwargs.get("api_mode"),
        "tool_count": stashed.get("tool_count"),
        "api_call_count": kwargs.get("api_call_count"),
    }
    if collector.config.capture != "metadata":
        payload["system_prompt_length"] = stashed.get("system_prompt_length")
        payload["approx_input_tokens"] = stashed.get("approx_input_tokens")

    _emit_llm_call(collector, payload, stashed, kwargs)


def _emit_llm_call(collector: Collector, payload: dict, stashed: dict, kwargs: dict) -> None:
    """Emit `llm.call`, stamped with the API request's own window.

    `occurred_at` is when the request happened, not when we got round to
    buffering it — under a backlog those differ by minutes, and `occurred_at` is
    what every `marts` time series is built on.
    """
    started_at = stashed.get("started_at") or kwargs.get("started_at")
    occurred_at = iso_from_epoch(started_at)
    ended_at = iso_from_epoch(kwargs.get("ended_at"))
    collector.emit(
        "llm.call",
        payload,
        occurred_at=occurred_at,
        occurred_at_earliest=occurred_at,
        occurred_at_latest=ended_at,
        model_id=kwargs.get("model"),
        **_refs(kwargs),
    )


def _hook_pre_tool_call(collector: Collector, **kwargs: Any) -> None:
    """Counter only, against an already-open session. No I/O of any kind.

    `pre_tool_call` is the one hook Hermes fails *closed* on: a callback that
    times out or is still running injects a block directive and the tool never
    runs (`hermes_cli/plugins.py:441`, `:3726`). So this body must not open a
    session lazily (a buffer write, a thread spawn and an `atexit.register`),
    and `guarded` marks it quiet so it skips the config reload too. An unknown
    session is simply not counted — a tool call is worth less than a tool call
    that never happened.
    """
    state = collector.peek_session(kwargs.get("session_id"))
    if state is None:
        return
    state.tool_call_count += 1


def _hook_post_tool_call(collector: Collector, **kwargs: Any) -> None:
    """Intention capture (spec §7.1). `tool.call` itself is not emitted yet.

    Intentions are captured here and not in `pre_tool_call`, although §7.1
    names the latter: `pre_tool_call` fails closed and must stay I/O-free, and
    only this hook has the result — the Index intent id, and whether Index
    accepted the intent at all. `post_tool_call` is a pure observer (Hermes
    discards its return, `model_tools.py` at `v2026.8.31`), so nothing here can
    delay, block or rewrite the tool call.
    """
    state = _session(collector, kwargs)
    if classify_tool(kwargs.get("tool_name")) is None:
        return
    _capture_intentions(collector, state, kwargs)


def _intention_payload(call: IntentionCall, capture: str, parent_session_id: Optional[str]) -> dict:
    """§4.1 payload. Hashes and lengths only: intention text never leaves.

    `text_hash` / `summary_hash` are present in every mode — they are the
    required keys `core.intention_versions` is built on. Lengths follow the
    capture ladder and are omitted in `metadata`; they count characters (code
    points), not bytes. No mode, `full` included, carries the text itself: it
    lives in the archive only (measurement catalogue §A; §7.1 "with hashes
    only").
    """
    payload: dict[str, Any] = {
        "text_hash": hash_text(call.text) if call.text else None,
        "summary_hash": hash_text(call.summary) if call.summary else None,
        "index_intent_id": call.index_intent_id,
        "source": call.source,
        "conditional": call.conditional,
        # Not in §4.1.
        "capture_path": call.capture_path,
        "index_status": call.index_status,
        "parent_session_id": parent_session_id,
    }
    if capture != "metadata":
        payload["text_length"] = len(call.text) if call.text else None
        payload["summary_length"] = len(call.summary) if call.summary else None
    return payload


def _is_cron_session(state: Any, session_id: Optional[str]) -> bool:
    """A cron run: `platform="cron"`, or Hermes's `cron_<job>_<stamp>` session id.

    Both come from `cron/scheduler.py` at `v2026.8.31`. The id prefix covers a
    run whose `on_session_start` this process never saw.
    """
    if state is not None and getattr(state, "source", None) == "cron":
        return True
    return bool(session_id) and str(session_id).startswith("cron_")


def _capture_intentions(collector: Collector, state: Any, kwargs: dict) -> None:
    """Emit one `intention.*` per intention the tool call recorded.

    No dedupe on `tool_call_id`: Hermes fires `post_tool_call` once per
    execution, and some providers reuse one `tool_call_id` for every call, so
    a filter on it would drop real intentions. Ingest dedupes on `event_id`.
    """
    refs = _refs(kwargs)
    calls = plan_intentions(
        kwargs.get("tool_name"),
        kwargs.get("args"),
        kwargs.get("result"),
        kwargs.get("status"),
        cron=_is_cron_session(state, refs["session_id"]),
    )
    if not calls:
        return

    raw_call_id = kwargs.get("tool_call_id")
    tool_call_id = str(raw_call_id) if raw_call_id not in (None, "") else None
    if tool_call_id is not None and not valid_id(tool_call_id):
        collector.count_intention_drop("tool_call_id", len(calls))
        return

    # The call's own window: Hermes reports `duration_ms` and we fire at its end.
    ended = time.time()
    duration = kwargs.get("duration_ms")
    started = ended - float(duration) / 1000.0 if isinstance(duration, (int, float)) and duration > 0 else ended
    occurred_at = iso_from_epoch(ended)

    capture = collector.config.capture
    parent_session_id = collector.parent_of(refs["session_id"])
    for call in calls:
        if call.intention_id is None:
            # Plugin-minted id for a `record_intention` capture nobody named (§4.2).
            call.intention_id = uuid7()
        if not valid_id(call.intention_id):
            collector.count_intention_drop("intention_id")
            continue
        if call.index_intent_id is not None and not valid_id(call.index_intent_id):
            collector.count_intention_drop("index_intent_id")
            continue
        collector.emit(
            call.event_type,
            _intention_payload(call, capture, parent_session_id),
            occurred_at=occurred_at,
            occurred_at_earliest=iso_from_epoch(started),
            occurred_at_latest=occurred_at,
            tool_call_id=tool_call_id,
            intention_id=call.intention_id,
            **refs,
        )


def _hook_on_session_end(collector: Collector, **kwargs: Any) -> None:
    """Turn boundary, not session end.

    Despite the name this fires at the end of every `run_conversation` call —
    once per user message (`agent/turn_finalizer.py:828`). So it nudges the
    flusher and nothing more; `session.ended` comes from `on_session_finalize`.
    """
    _session(collector, kwargs)
    collector.nudge_flush()


def _hook_on_session_finalize(collector: Collector, **kwargs: Any) -> None:
    session_id = kwargs.get("session_id")
    if not session_id:
        return
    collector.session_ended(str(session_id))


def _hook_subagent_start(collector: Collector, **kwargs: Any) -> None:
    _session(collector, kwargs)
    # Lineage for intention events' `payload.parent_session_id`.
    collector.note_parent(kwargs.get("child_session_id"), kwargs.get("parent_session_id"))


def _hook_subagent_stop(collector: Collector, **kwargs: Any) -> None:
    _session(collector, kwargs)


def _hook_on_stream_end(collector: Collector, **kwargs: Any) -> None:
    _session(collector, kwargs)


HOOK_BODIES = {
    "on_session_start": _hook_on_session_start,
    "pre_llm_call": _hook_pre_llm_call,
    "post_llm_call": _hook_post_llm_call,
    "pre_api_request": _hook_pre_api_request,
    "post_api_request": _hook_post_api_request,
    "api_request_error": _hook_api_request_error,
    "pre_tool_call": _hook_pre_tool_call,
    "post_tool_call": _hook_post_tool_call,
    "on_session_end": _hook_on_session_end,
    "on_session_finalize": _hook_on_session_finalize,
    "subagent_start": _hook_subagent_start,
    "subagent_stop": _hook_subagent_stop,
    "on_stream_end": _hook_on_stream_end,
}


def build_hooks(collector_ref=_collector) -> dict:
    """Wrap every hook body in the fail-open guard. One decorator, no exceptions."""
    hooks = {}
    for name, body in HOOK_BODIES.items():
        wrapped = guarded(name, collector_ref, quiet=name in QUIET_HOOKS)(body)
        # Hermes decides what to pass by inspecting the callback signature, and
        # `inspect.signature` follows `__wrapped__` through `functools.wraps`.
        # Drop it so it sees the wrapper's own `(*args, **kwargs)`.
        try:
            del wrapped.__wrapped__
        except AttributeError:
            pass
        hooks[name] = wrapped
    return hooks


def register(ctx) -> None:
    """Hermes plugin entrypoint. Synchronous; the loader never awaits it.

    Hooks are registered unconditionally, including when the plugin is disabled
    or has no token. The kill switches are re-read at every session start, so a
    tenant that gets its env fixed mid-process starts reporting on its next
    session without a restart, and a tenant that never gets a token runs a set
    of hooks that do nothing.

    Idempotent. Hermes loads a plugin once per process, but a profile switch or
    a `force=True` reload can call `register()` again on a module that is still
    in `sys.modules` — and registering twice appends a second callback to every
    hook list, which doubles every event and every counter.
    """
    global _COLLECTOR, _REGISTERED
    if _REGISTERED:
        return
    if _COLLECTOR is None:
        _COLLECTOR = Collector()

    for name, callback in build_hooks().items():
        try:
            ctx.register_hook(name, callback)
        except Exception:  # noqa: BLE001 - one bad hook name must not lose the rest
            continue
    _REGISTERED = True


__all__ = [
    "register",
    "build_hooks",
    "Collector",
    "SPEC_HOOKS",
    "EXTRA_HOOKS",
    "HOOK_BODIES",
    "SOURCE_BY_PLATFORM",
    "TOOL_CATEGORIES",
    "UNLISTED_TOOL_CATEGORY",
    "tool_category",
    "sanitize",
    "hash_obj",
    "hash_text",
    "plan_intentions",
    "hermes_version",
    "overlay_ref",
    "__version__",
]
