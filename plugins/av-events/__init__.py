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

from typing import Any, Optional

from ._collector import Collector, guarded, hermes_version, overlay_ref
from ._core import (
    TOOL_CATEGORIES,
    UNLISTED_TOOL_CATEGORY,
    hash_obj,
    hash_text,
    sanitize,
    tool_category,
)

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
    "on_session_finalize",
)

#: Module-level singleton. `register(ctx)` is called once per process by the
#: Hermes loader (`hermes_cli/plugins.py:5282`).
_COLLECTOR: Optional[Collector] = None


def _collector() -> Optional[Collector]:
    return _COLLECTOR


def _source_for(platform: Any) -> str:
    text = str(platform or "").strip().lower()
    return SOURCE_BY_PLATFORM.get(text, text or "unknown")


def _session(collector: Collector, kwargs: dict) -> Any:
    """Resolve (and lazily open) the session this hook belongs to."""
    session_id = kwargs.get("session_id") or kwargs.get("parent_session_id")
    if not session_id:
        return None
    return collector.session_started(str(session_id), _source_for(kwargs.get("platform")))


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
    collector.session_started(str(session_id), _source_for(kwargs.get("platform")))


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
        }

    refs = {
        "session_id": str(kwargs.get("session_id") or "") or None,
        "turn_id": kwargs.get("turn_id") or None,
        "run_id": kwargs.get("task_id") or None,
    }
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

    collector.emit(
        "llm.call",
        payload,
        session_id=str(kwargs.get("session_id") or "") or None,
        turn_id=kwargs.get("turn_id") or None,
        run_id=kwargs.get("task_id") or None,
        model_id=kwargs.get("model"),
    )


def _hook_pre_tool_call(collector: Collector, **kwargs: Any) -> None:
    """Counter only — and it must stay trivial.

    `pre_tool_call` is the one hook Hermes fails *closed* on: a callback that
    times out or is still running injects a block directive and the tool never
    runs (`hermes_cli/plugins.py:441`, `:3726`). No I/O belongs here, and this
    body must never return a dict — `guarded` discards return values, so it
    cannot accidentally block a tool call.
    """
    state = _session(collector, kwargs)
    if state is None:
        return
    state.tool_call_count += 1


def _hook_post_tool_call(collector: Collector, **kwargs: Any) -> None:
    # `tool.call` events are out of scope for this milestone; the hook is
    # registered now so the wiring and the fail-open path are exercised.
    _session(collector, kwargs)


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
        wrapped = guarded(name, collector_ref)(body)
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
    """
    global _COLLECTOR
    if _COLLECTOR is None:
        _COLLECTOR = Collector()

    for name, callback in build_hooks().items():
        try:
            ctx.register_hook(name, callback)
        except Exception:  # noqa: BLE001 - one bad hook name must not lose the rest
            continue


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
    "hermes_version",
    "overlay_ref",
    "__version__",
]
