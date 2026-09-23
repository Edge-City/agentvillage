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

import math
import re
import time
from typing import Any, Optional

from . import _edgeos
from ._collector import Collector, guarded, hermes_version, overlay_ref
from ._core import (
    PLUGIN_VERSION,
    hash_obj,
    hash_text,
    iso_from_epoch,
    sanitize,
    uuid7,
)
from ._cron import cron_job_id_from
from ._intentions import IntentionCall, classify_tool, valid_id
from ._intentions import plan as plan_intentions
from ._messages import is_silent, message_payload
from ._tools import (
    TOOL_CATEGORIES,
    UNLISTED_TOOL_CATEGORY,
    normalise_status,
    status_ok,
    tool_call_payload,
    tool_category,
)

__version__ = PLUGIN_VERSION

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
    text = kwargs.get("user_message")
    if text:
        state.message_count += 1
        _emit_message(collector, "message.in", text, kwargs)


def _hook_post_llm_call(collector: Collector, **kwargs: Any) -> None:
    state = _session(collector, kwargs)
    if state is None:
        return
    text = kwargs.get("assistant_response")
    if text:
        state.message_count += 1
        _emit_message(collector, "message.out", text, kwargs)


def _emit_message(collector: Collector, event_type: str, text: Any, kwargs: dict) -> None:
    """`message.in` from `pre_llm_call`, `message.out` from `post_llm_call`.

    Hashes, lengths and punctuation flags only (`_messages`). Who sent a
    `message.in` depends on the session: a participant in a conversation, the
    scheduler in a cron run (the "user message" is the job's prompt — a cron
    session is never participant-sourced), and the delegating agent in a
    subagent (its goal). `sender_id` is never read.
    """
    if not collector.config.active:
        return
    refs = _refs(kwargs)
    session_id = refs["session_id"]
    cron = _is_cron_session(collector, session_id)
    subagent = collector.parent_of(session_id) is not None
    if cron:
        channel, sender = "cron", "system"
    elif subagent:
        channel, sender = "subagent", "agent"
    else:
        state = collector.peek_session(session_id)
        channel = (state.source if state is not None else None) or _source_for(kwargs.get("platform")) or "unknown"
        sender = "participant"
    cron_job_id = cron_job_id_from(session_id, kwargs.get("task_id")) if cron else None
    # A cron run's reply is suppressed when it is Hermes's silence marker.
    silent = is_silent(text) if cron and event_type == "message.out" else None
    collector.emit(
        event_type,
        message_payload(text, channel, collector.config.capture, cron_job_id, collector.keyed_hash, silent),
        actor=sender if event_type == "message.in" else "agent",
        model_id=kwargs.get("model") if event_type == "message.out" else None,
        **refs,
    )


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
    """`tool.call`, the EdgeOS `action.*` path, and intention capture (spec §4.1, §7.1).

    Everything tool-shaped is emitted here and not in `pre_tool_call`: that
    hook fails closed and must stay I/O-free, and only this one has the result,
    the status and the duration. `post_tool_call` is a pure observer (Hermes
    discards its return, `model_tools.py` at `v2026.8.31`), so nothing here can
    delay, block or rewrite the tool call.

    Order: `tool.call`, then any `action.*` it implies, then any `intention.*`.
    The three are isolated from each other: a failure in one is counted against
    the breaker like any hook failure and does not cost the others their events.
    """
    _session(collector, kwargs)
    if not collector.config.active:
        return
    _isolated(collector, kwargs, _emit_tool_call, collector, kwargs)
    if classify_tool(kwargs.get("tool_name")) is not None:
        _isolated(collector, kwargs, _capture_intentions, collector, kwargs)


def _isolated(collector: Collector, kwargs: dict, fn, *args: Any) -> None:
    try:
        fn(*args)
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 - same contract as `guarded`
        session_id = kwargs.get("session_id") or kwargs.get("parent_session_id")
        collector.record_failure("post_tool_call", exc, str(session_id) if session_id else None)


def _emit_tool_call(collector: Collector, kwargs: dict) -> None:
    refs = _refs(kwargs)
    tool_call_id = _tool_call_id(kwargs)
    occurred_at, earliest = _call_window(kwargs)
    payload = tool_call_payload(
        kwargs.get("tool_name"),
        kwargs.get("args"),
        kwargs.get("result"),
        kwargs.get("status"),
        kwargs.get("duration_ms"),
        kwargs.get("error_type"),
        collector.config.capture,
        collector.keyed_hash,
    )
    window = dict(occurred_at=occurred_at, occurred_at_earliest=earliest, occurred_at_latest=occurred_at)
    matched = _edgeos_match(kwargs, payload)
    if matched is None or matched[0].role not in ("action", "confirming_read"):
        collector.emit("tool.call", payload, tool_call_id=tool_call_id, **window, **refs)
        return
    # Hermes can run tool calls concurrently, and the EdgeOS ledger is shared
    # state: plan, emit and record under one lock.
    with collector._lock:
        planned: list = []
        try:
            planned = _edgeos_plan(collector, kwargs, payload, matched)
        except SystemExit:
            raise
        except BaseException as exc:  # noqa: BLE001 - the tool.call itself still goes out
            collector.record_failure("post_tool_call", exc, refs["session_id"])
            payload["receipt"] = None
        collector.emit("tool.call", payload, tool_call_id=tool_call_id, **window, **refs)
        changed = False
        for item in planned:
            event = collector.emit(
                item.event_type,
                item.payload,
                action_id=item.action_id,
                tool_call_id=tool_call_id,
                evidence_class=item.evidence_class,
                **window,
                **refs,
            )
            # The ledger records an action only once its event is buffered, so
            # an inert emit can never leave a receipt waiting on an action no
            # event describes.
            if event is not None and item.apply is not None:
                item.apply()
                changed = True
        if changed:
            collector.save_edgeos_ledger()


def _tool_call_id(kwargs: dict) -> Optional[str]:
    """Hermes supplies `tool_call_id`, not the agent: one that fails the id
    pattern is nulled and the event kept."""
    raw = kwargs.get("tool_call_id")
    value = str(raw) if raw not in (None, "") else None
    return value if value is not None and valid_id(value) else None


def _call_window(kwargs: dict) -> tuple[Optional[str], Optional[str]]:
    """(`occurred_at`, `occurred_at_earliest`): the call's end, and its end
    minus Hermes's `duration_ms`. The hook fires as the call returns."""
    ended = time.time()
    duration = kwargs.get("duration_ms")
    started = (
        ended - float(duration) / 1000.0
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and duration > 0
        else ended
    )
    return iso_from_epoch(ended), iso_from_epoch(started)


def _edgeos_match(kwargs: dict, tool_payload: dict) -> Optional[tuple]:
    """(operation, path params, call) for a recognised EdgeOS call, labelling its
    `tool.call`; None for anything else."""
    call = _edgeos.http_call(kwargs.get("tool_name"), kwargs.get("args"))
    matched = _edgeos.match_operation(call) if call is not None else None
    if matched is None:
        return None
    op, params = matched
    tool_payload["operation"] = op.operation
    tool_payload["target_system"] = _edgeos.TARGET_SYSTEM
    return op, params, call


def _edgeos_plan(collector: Collector, kwargs: dict, tool_payload: dict, matched: tuple) -> list:
    """The `action.*` events one EdgeOS call implies (`_edgeos.plan`).

    An RSVP or a cancellation is `action.attempted` with a fresh action id,
    plus `action.failed` when the call failed; it waits for a confirming read
    only when EdgeOS answered with the participant record. A read whose
    `my_rsvp_status` agrees with a waiting action is `action.receipted` on that
    action's id, with receipt `{kind: edgeos_confirming_read, id: <participant
    id>}` — the one event this plugin claims `provider_receipt` for, which
    ingest honours only because the receipt is checkable (§2.1). In
    `metadata` the EdgeOS event id and the receipt's participant id are
    replaced by their HMACs under the tenant key.
    """
    op, params, call = matched
    status = normalise_status(kwargs.get("status"))
    exit_code, body = _edgeos.terminal_outcome(kwargs.get("result"))
    planned = _edgeos.plan(
        op, params, call, ok=status_ok(status), status=status, exit_code=exit_code, body=body,
        ledger=collector.edgeos_ledger(), mint=uuid7,
    )
    if collector.config.capture == "metadata":
        # EdgeOS ids are the attendee's footprint across the popup; `metadata`
        # keeps them in the sandbox. The receipt then cannot be checked, which
        # is the price of the mode.
        for item in planned:
            item.payload["edgeos_event_id"] = collector.keyed_hash(item.payload["edgeos_event_id"])
            receipt = item.payload.get("receipt")
            if isinstance(receipt, dict) and isinstance(receipt.get("id"), str):
                receipt["id"] = collector.keyed_hash(receipt["id"])
    # After the metadata step, so the tool.call never carries a clear id the
    # action event does not.
    receipts = [item.payload["receipt"] for item in planned if item.event_type == "action.receipted"]
    if len(receipts) == 1:
        tool_payload["receipt"] = dict(receipts[0])
    return planned


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


#: How far up a chain of delegated subagents to look for a cron ancestor.
MAX_LINEAGE_DEPTH = 8


def _is_cron_session(collector: Collector, session_id: Optional[str]) -> bool:
    """A cron run, or a subagent a cron run delegated to (at any depth).

    A session is a cron run when its `on_session_start` said `platform="cron"`
    or its id has Hermes's `cron_<job>_<stamp>` form (`cron/scheduler.py` at
    `v2026.8.31`); the id prefix covers a run whose start this process never
    saw. Parents come from `subagent_start`.
    """
    current = session_id
    for _ in range(MAX_LINEAGE_DEPTH):
        if not current:
            return False
        state = collector.peek_session(current)
        if state is not None and state.source == "cron":
            return True
        if str(current).startswith("cron_"):
            return True
        current = collector.parent_of(current)
    return False


def _capture_intentions(collector: Collector, kwargs: dict) -> None:
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
        cron=_is_cron_session(collector, refs["session_id"]),
    )
    if not calls:
        return

    tool_call_id = _tool_call_id(kwargs)
    # The call's own window: Hermes reports `duration_ms` and we fire at its end.
    occurred_at, earliest = _call_window(kwargs)

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
            occurred_at_earliest=earliest,
            occurred_at_latest=occurred_at,
            tool_call_id=tool_call_id,
            intention_id=call.intention_id,
            **refs,
        )


def _hook_on_session_end(collector: Collector, **kwargs: Any) -> None:
    """Turn boundary, not session end.

    Despite the name this fires at the end of every `run_conversation` call —
    once per user message (`agent/turn_finalizer.py:828`). So it nudges the
    flusher and asks for a (rate-limited) memory snapshot, nothing more;
    `session.ended` comes from `on_session_finalize`.
    """
    _session(collector, kwargs)
    collector.nudge_flush()
    # Once per turn, so a gateway whose sessions are never finalized (the
    # common case: a Telegram conversation just goes quiet) still backs up.
    # Rate-limited to one pass per `AV_BACKUP_MIN_INTERVAL_S`; an unchanged
    # workspace uploads nothing, so a pass is a read and a hash.
    collector.request_snapshot()


def _hook_on_session_finalize(collector: Collector, **kwargs: Any) -> None:
    """The real session close: `session.ended` with Hermes's cost figures for
    the session, then `profile.updated` if USER.md changed, then a request for
    a memory snapshot. In that order, so nothing the profile check or the
    snapshot does can cost the session its end event.

    The snapshot request only sets a flag and starts (or wakes) a daemon
    thread: the files are read, packed and uploaded there, never here. A
    finalize's request skips the turn-end rate limit. Hermes has no shutdown
    hook at `0.21.3`; gateway shutdown finalizes open sessions, which lands
    here, and the exit drain joins that thread for a bounded time
    (`Collector.shutdown`). The turn-end requests are what keep the backup
    current; this is the last chance, not the mechanism."""
    session_id = kwargs.get("session_id")
    if not session_id:
        return
    session_id = str(session_id)
    state = collector.peek_session(session_id)
    cost = collector.read_session_cost(session_id) if state is not None and not state.ended else {}
    collector.session_ended(session_id, **cost)
    collector.check_profile(session_id)
    collector.request_snapshot(urgent=True)


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


# --------------------------------------------------------------------------
# Events published by other Agent Village plugins
#
# Hermes has a plugin event bus: `ctx.emit(name, payload)` publishes
# `<plugin>:<name>` (the namespace is forced to the emitter), and
# `ctx.subscribe("<plugin>:<name>", cb)` delivers it as `cb(**payload)` on a
# host-owned worker thread, off the request path (`hermes_cli/plugins.py`
# `emit`/`subscribe`/`_dispatch_event` at 82e6c46; the dispatcher moved to
# `hermes_cli/plugins_dispatch.py` by 0.21.3). That
# is how an opt-in skill plugin reaches the envelope and the buffer without
# importing this module. Each subscription rebuilds its payload from an
# explicit allowlist: whatever else the publisher sends is dropped.
# --------------------------------------------------------------------------

#: Published by `plugins/recall` after a successful `recall` tool call.
MEMORY_RECALLED_BUS_EVENT = "recall:memory.recalled"
MEMORY_RECALLED_SURFACES = frozenset({"telegram", "desktop", "cron", "other", "unknown"})
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


def memory_recalled_payload(kwargs: dict) -> Optional[dict]:
    """The only four fields `memory.recalled` may carry, or None if malformed.

    `query_hash` must be a 64-char lowercase hex digest, so a publisher that
    passes the query itself (or anything else) is refused outright rather than
    hashed or truncated here.
    """
    query_hash = kwargs.get("query_hash")
    if not isinstance(query_hash, str) or not _HEX64.match(query_hash):
        return None
    hit_count = kwargs.get("hit_count")
    if isinstance(hit_count, bool) or not isinstance(hit_count, int) or hit_count < 0:
        return None
    top_score = kwargs.get("top_score")
    if top_score is not None:
        if isinstance(top_score, bool) or not isinstance(top_score, (int, float)) or not math.isfinite(top_score):
            return None
        top_score = round(float(top_score), 4)
    surface = kwargs.get("surface")
    if surface not in MEMORY_RECALLED_SURFACES:
        surface = "other"
    return {
        "query_hash": query_hash,
        "hit_count": hit_count,
        "top_score": top_score,
        "surface": surface,
    }


def _on_memory_recalled(collector: Collector, **kwargs: Any) -> None:
    payload = memory_recalled_payload(kwargs)
    if payload is None:
        return
    if collector.config.capture == "metadata":
        # Counts and surface only: the hash and the score both describe the
        # query's content, which `metadata` keeps in the sandbox.
        payload["query_hash"] = None
        payload["top_score"] = None
    session_id = kwargs.get("session_id")
    collector.emit("memory.recalled", payload, session_id=str(session_id) if session_id else None)


#: Bus event -> (stats/kill-switch name for `guarded`, body).
#: `AV_HOOKS_DISABLED=memory_recalled` turns this one off like any hook.
SUBSCRIPTION_BODIES = {
    MEMORY_RECALLED_BUS_EVENT: ("memory_recalled", _on_memory_recalled),
}


def build_subscriptions(collector_ref=_collector) -> dict:
    """Wrap every bus subscriber in the same fail-open guard as the hooks."""
    subscriptions = {}
    for event, (name, body) in SUBSCRIPTION_BODIES.items():
        wrapped = guarded(name, collector_ref)(body)
        try:
            del wrapped.__wrapped__
        except AttributeError:
            pass
        subscriptions[event] = wrapped
    return subscriptions


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
    # The plugin event bus is optional: a Hermes without it simply never
    # delivers events from other plugins.
    subscribe = getattr(ctx, "subscribe", None)
    if callable(subscribe):
        for event, callback in build_subscriptions().items():
            try:
                subscribe(event, callback)
            except Exception:  # noqa: BLE001
                continue
    _REGISTERED = True


__all__ = [
    "register",
    "build_hooks",
    "build_subscriptions",
    "memory_recalled_payload",
    "MEMORY_RECALLED_BUS_EVENT",
    "SUBSCRIPTION_BODIES",
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
