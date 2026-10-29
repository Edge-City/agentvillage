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

import logging
import math
import os
import re
import time
from typing import Any, Callable, Optional

from . import _approval, _approvals_reminder, _edgeos, _edgeos_guard, _inference_run, _intent_approval, _outcome_ask, _share_vote, _terminal_args
from ._ask_village import register_ask_village_tool
from ._ask_odin import register_ask_odin_tool
from ._search_village import register_search_village_tool
from ._query_village import register_query_village_tool
from ._pray import register_pray_tool
from ._collector import Collector, guarded, hermes_version, overlay_ref
from ._clock import with_clock_line
from . import _miniapp_epoch
from . import _skill_change_note
from . import _prompt_refresh
from . import _user_md_gate
from . import _village_visible
from ._consent import TOOL_NAME as CONSENT_TOOL_NAME
from ._consent import register_consent_tool
from ._record_intention import HUMAN_PLATFORMS, register_record_intention_tool
from ._core import (
    env_flag_on,
    PLUGIN_VERSION,
    hash_obj,
    hash_text,
    iso_from_epoch,
    sanitize,
    strip_capability_urls,
    uuid7,
)
from ._cron import cron_job_id_from
# DATA-470 family, on its own line so it merges beside other lanes' imports.
from . import _card_events
# SEC-3, on its own line for the same reason.
from . import _plugin_events
# SEC-6 half 2, on its own line for the same reason.
from . import _model_events
# ov#357 M1 stopgap (b), on its own line for the same reason.
from . import _gate_events
# P10-P1 code.run@1, on its own line for the same reason.
from . import _code_run
# MM-INFER-VIS, on its own line for the same reason.
from . import _negotiator_llm
# B-169b, on its own line for the same reason.
from . import _skill_label
from ._intentions import IntentionCall, classify_tool, valid_id
from ._intentions import plan as plan_intentions
from ._messages import is_injected_turn, is_silent, message_payload
from ._tools import (
    TOOL_CATEGORIES,
    UNLISTED_TOOL_CATEGORY,
    normalise_status,
    status_ok,
    tool_call_payload,
    tool_category,
)

__version__ = PLUGIN_VERSION

logger = logging.getLogger("av-events")

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
#: Cleared by `_on_unload`: once Hermes has unloaded the plugin its hooks are
#: gone, and the next `register()` must wire them again (DATA-183).
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
        _outcome_guarded(collector, kwargs, "pre_llm_call", _outcome_note_answer, collector, kwargs, text)


def _hook_post_llm_call(collector: Collector, **kwargs: Any) -> None:
    state = _session(collector, kwargs)
    if state is None:
        return
    text = kwargs.get("assistant_response")
    if text:
        state.message_count += 1
        _emit_message(collector, "message.out", text, kwargs)
        _outcome_guarded(collector, kwargs, "post_llm_call", _outcome_arm, collector, kwargs, text)


# --------------------------------------------------------------------------
# The evening outcome ask (DATA-42, `_outcome_ask`). Its own name in
# `AV_HOOKS_DISABLED` (`outcome_ask`) turns all of it off; a failure here
# never costs the turn's `message.*` event, which is already buffered.
# --------------------------------------------------------------------------

#: The name `AV_HOOKS_DISABLED` takes to turn off the outcome ask (arming, answers and its tick).
OUTCOME_ASK_SWITCH = "outcome_ask"


def _outcome_guarded(collector: Collector, kwargs: dict, hook: str, fn, *args: Any) -> None:
    if not collector.config.active or OUTCOME_ASK_SWITCH in collector.config.disabled_hooks:
        return
    # Superseded by the suggestion rating cards (plugins/av-rate, `_rating_cards`): the text ask
    # arms and parses only with AV_OUTCOME_TEXT_ASK on, for one release, then goes.
    if not env_flag_on(_outcome_ask.TEXT_ASK_SWITCH):
        return
    try:
        fn(*args)
    except SystemExit:
        raise
    except BaseException as exc:  # noqa: BLE001 - same contract as `guarded`
        session_id = kwargs.get("session_id") or kwargs.get("parent_session_id")
        collector.record_failure(hook, exc, str(session_id) if session_id else None)


def _outcome_arm(collector: Collector, kwargs: dict, text: Any) -> None:
    """A cron session's reply: arm the evening job's staged ask. Cron sessions
    only, handled explicitly: any other session never arms."""
    session_id = str(kwargs.get("session_id") or "") or None
    if not _is_cron_session(collector, session_id):
        return
    code = _outcome_ask.arm(
        collector.config.state_dir,
        collector.config.home,
        session_id=session_id,
        task_id=kwargs.get("task_id"),
        reply=text,
        hasher=collector.keyed_hash,
        capture=collector.config.capture,
        now=time.time(),
    )
    if code:
        logger.info("av-events: outcome_ask %s", code)


_CHAT_TYPE_READER: Any = None


def _session_chat_type() -> str:
    """The turn's chat type (`dm`, `group`, `channel`, `thread`), from Hermes's
    session context (`gateway/session_context.py` `HERMES_SESSION_CHAT_TYPE`),
    else the process environment; empty when neither says."""
    global _CHAT_TYPE_READER
    if _CHAT_TYPE_READER is None:
        try:
            from gateway.session_context import get_session_env  # type: ignore[import-not-found]

            _CHAT_TYPE_READER = get_session_env
        except Exception:  # noqa: BLE001 - not running inside a Hermes gateway
            _CHAT_TYPE_READER = lambda name, default="": os.environ.get(name, default)  # noqa: E731
    try:
        return str(_CHAT_TYPE_READER("HERMES_SESSION_CHAT_TYPE", "") or "").strip().lower()
    except Exception:  # noqa: BLE001
        return ""


def _outcome_note_answer(collector: Collector, kwargs: dict, text: Any) -> None:
    """The resident's own message in their Telegram DM may answer the open
    ask. Never a cron run (its "user message" is the job's prompt), a
    subagent's goal, a turn Hermes injected, another platform, a group, or
    a chat whose type Hermes does not say. Nothing in `metadata` capture: the
    value is derived from the content."""
    if collector.config.capture == "metadata":
        return
    session_id = str(kwargs.get("session_id") or "") or None
    if not session_id or _is_cron_session(collector, session_id) or collector.parent_of(session_id) is not None:
        return
    if is_injected_turn(text, kwargs.get("conversation_history")):
        return
    state = collector.peek_session(session_id)
    source = (state.source if state is not None else None) or _source_for(kwargs.get("platform"))
    if source != "telegram" or _session_chat_type() != "dm":
        return
    code = _outcome_ask.note_answer(
        collector.config.state_dir,
        text=text,
        session_id=session_id,
        turn_id=kwargs.get("turn_id"),
        now=time.time(),
        hasher=collector.keyed_hash,
    )
    if code:
        logger.info("av-events: outcome_ask %s", code)


def _emit_message(collector: Collector, event_type: str, text: Any, kwargs: dict) -> None:
    """`message.in` from `pre_llm_call`, `message.out` from `post_llm_call`.

    Hashes, lengths and punctuation flags only (`_messages`). Who sent a
    `message.in` depends on the session: a participant in a conversation, the
    scheduler in a cron run (the "user message" is the job's prompt — a cron
    session is never participant-sourced), and the delegating agent in a
    subagent (its goal). In a conversation, a turn Hermes injected itself — a
    notification, a `/loop` or `/goal` wakeup, the restart resume turn, a
    plugin's injection, the CLI handoff, the heartbeat — is `system` too, on
    the session's own channel (DATA-109). `sender_id` is never read.
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
        injected = event_type == "message.in" and is_injected_turn(text, kwargs.get("conversation_history"))
        sender = "system" if injected else "participant"
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

    prompt_text = system_prompt if isinstance(system_prompt, str) else None
    # DATA-112: hash the bytes that leave. `emit` sanitises the
    # `prompt.registered` body, so a hash over the raw schemas or prompt would
    # name a body ingest never receives and cannot verify.
    sent_tools = sanitize(tools) if tools else None
    sent_prompt = sanitize(prompt_text) if prompt_text else None
    tools_hash = hash_obj(sent_tools) if sent_tools else None
    system_prompt_hash = hash_text(sent_prompt) if sent_prompt else None

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
        collector.register_prompt("tools", tools_hash, sent_tools, **refs)
    if system_prompt_hash:
        collector.register_prompt("system_prompt", system_prompt_hash, sent_prompt, **refs)


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

    This body only counts. The DATA-312 `terminal` argument fix that rides the
    same Hermes hook is `with_terminal_args_fix`, outside the telemetry guard.
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

    Order: `tool.call`, then any `action.*` it implies, then (P10-P1) an
    `execute_code` call's `code.run`, then any `intention.*`. They are isolated
    from each other: a failure in one is counted against the breaker like any
    hook failure and does not cost the others their events. `code.run` alone is
    isolated *uncounted* (`_quiet`): it is an optional add-on, and no failure of
    it may trip the session breaker that would silence `tool.call`.
    """
    _session(collector, kwargs)
    if not collector.config.active:
        return
    _isolated(collector, kwargs, _emit_tool_call, collector, kwargs)
    if kwargs.get("tool_name") == _code_run.TOOL_NAME:
        _quiet(collector, CODE_RUN_FAILED, _emit_code_run, collector, kwargs)
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


#: P10-P1: the counter a failed `code.run` bumps instead of the breaker.
CODE_RUN_FAILED = "code_run_failed"


def _quiet(collector: Collector, counter: str, fn, *args: Any) -> None:
    """`_isolated` without the breaker: a failure bumps `counter` (logged once per
    process as a name and a count, never the exception's text) and is otherwise
    dropped. For an optional event that must never cost the others theirs."""
    try:
        fn(*args)
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - counted, never re-raised
        try:
            collector.count(counter)
        except Exception:  # noqa: BLE001 - a counter must not raise either
            pass


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
    if matched is None:
        # B-169b: a shipped skill's script run, only where EdgeOS wrote no label.
        _skill_match(kwargs, payload)
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


def _emit_code_run(collector: Collector, kwargs: dict) -> None:
    """P10-P1 `code.run@1` for one outer `execute_code` call (`_code_run`).

    Off unless `AV_EVENTS_CODE_RUN` is on: off, nothing is built. The envelope
    carries the ids `tool.call` carries for the same call and no other, and a
    window computed the same way (`_call_window`).
    Observe-only: it runs after the tool returned, and anything it raises is
    `_quiet`'s (a counter, never the session breaker), never the tool call's
    or `tool.call`'s.
    """
    if not _code_run.flag_on():
        return
    payload = _code_run.code_run_payload(
        kwargs.get("args"),
        kwargs.get("result"),
        kwargs.get("status"),
        kwargs.get("error_type"),
        collector.config.capture,
        collector.keyed_hash,
        _code_run.scope(),
        _code_run.gated_hosts(),
    )
    occurred_at, earliest = _call_window(kwargs)
    collector.emit(
        _code_run.TYPE,
        payload,
        tool_call_id=_tool_call_id(kwargs),
        occurred_at=occurred_at,
        occurred_at_earliest=earliest,
        occurred_at_latest=occurred_at,
        **_refs(kwargs),
    )


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


def _skill_match(kwargs: dict, tool_payload: dict) -> None:
    """B-169b: label a `terminal` run of a shipped skill's script
    (`_skill_label`): `target_system` `skill`, `operation` the skill's name or
    `other`. Called only when `_edgeos_match` labelled nothing, so an EdgeOS
    script verb keeps its `edgeos` label."""
    label = _skill_label.skill_label(kwargs.get("tool_name"), kwargs.get("args"))
    if label is not None:
        tool_payload["target_system"], tool_payload["operation"] = label


def _edgeos_plan(collector: Collector, kwargs: dict, tool_payload: dict, matched: tuple) -> list:
    """The `action.*` events one EdgeOS call implies (`_edgeos.plan`).

    An RSVP or a cancellation is `action.attempted` with a fresh action id,
    plus `action.failed` when the call failed; it waits for a confirming read
    only when EdgeOS answered with the participant record. A read whose
    `my_rsvp_status` agrees with a waiting action is `action.receipted` on that
    action's id, with receipt `{kind: edgeos_confirming_read, id: <participant
    id>}` — the one event this plugin claims `provider_receipt` for, which
    ingest would honour if the receipt were checkable (§2.1). The receipt's
    participant id is replaced by its HMAC under the tenant key in every
    capture mode (DATA-308), and in `metadata` the EdgeOS event id is too.
    """
    op, params, call = matched
    status = normalise_status(kwargs.get("status"))
    exit_code, body = _edgeos.terminal_outcome(kwargs.get("result"))
    planned = _edgeos.plan(
        op, params, call, ok=status_ok(status), status=status, exit_code=exit_code, body=body,
        ledger=collector.edgeos_ledger(), mint=uuid7,
    )
    for item in planned:
        # DATA-308, every mode: a participant record is one person's RSVP, and
        # EdgeOS resolves its id to that person (`GET /event-participants/{id}`).
        # Whoever reads the event downstream does not hold that mapping, so the
        # id leaves only as its keyed hash, the same value `metadata` always
        # sent (null without a key). The receipt then cannot be checked
        # outside the sandbox in any mode (README divergence 31).
        receipt = item.payload.get("receipt")
        if isinstance(receipt, dict) and isinstance(receipt.get("id"), str):
            receipt["id"] = collector.keyed_hash(receipt["id"])
        if collector.config.capture == "metadata":
            # An EdgeOS event id names an event, not who went; but the set of
            # them is the attendee's footprint across the popup, and
            # `metadata` keeps that in the sandbox.
            item.payload["edgeos_event_id"] = collector.keyed_hash(item.payload["edgeos_event_id"])
    # After the keying step, so the tool.call never carries a clear id the
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
        # DATA-212, `record_intention` only (null on every other path): why a
        # capture the tool meant to publish stayed local (a code), and why one
        # was kept local on purpose (`participant_asked` | `personal`).
        "publish_refused": call.publish_refused,
        "local_reason": call.local_reason,
    }
    if call.status_only:
        # DATA-249: Index `pause_intent` / `resume_intent`, an update of the
        # status alone (both hashes null); and (DREAM-1) every approval-path
        # update, which restates the held text unchanged. Same key as the Index
        # poller's status-only updates; present only on those events.
        payload["status_only"] = True
    # DATA-212 Lane B: present only on a `record_intention` event that went
    # through approval.md. `approved_by` = `individual` (a human's grant) or
    # `rule` (the resident's policy); `approval_state` = the proposal's state.
    if call.approved_by is not None:
        payload["approved_by"] = call.approved_by
    if call.approval_state is not None:
        payload["approval_state"] = call.approval_state
    if call.confirmed_in_chat is not None:
        payload["confirmed_in_chat"] = call.confirmed_in_chat
    # DATA-470: additive and nullable on `intention.captured` only.
    if call.event_type == "intention.captured":
        payload["origin"] = call.origin
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


#: `session.source` values where a person speaks to the agent (R10's platforms; cli, tui and
#: desktop arrive as `desktop`).
CHAT_SOURCES = HUMAN_PLATFORMS | {"desktop"}


def _origin(collector: Collector, session_id: Optional[str], task_id: Any, cron: bool) -> str:
    """DATA-470 `intention.captured.origin`: the memory signal sync's run, a chat with the
    resident, or anything else. From the session's lineage, never from the model."""
    current, root = session_id, session_id
    for _ in range(MAX_LINEAGE_DEPTH):
        if not current:
            break
        root = current
        if str(current).startswith("cron_"):
            break
        current = collector.parent_of(current)
    if cron:
        job = cron_job_id_from(root, task_id)
        return "memory_signal_sync" if _inference_run.is_memory_signal_job(collector.config.home, job) else "other"
    state = collector.peek_session(root)
    return "chat" if state is not None and state.source in CHAT_SOURCES else "other"


def _capture_intentions(collector: Collector, kwargs: dict) -> None:
    """Emit one `intention.*` per intention the tool call recorded.

    No dedupe on `tool_call_id`: Hermes fires `post_tool_call` once per
    execution, and some providers reuse one `tool_call_id` for every call, so
    a filter on it would drop real intentions. Ingest dedupes on `event_id`.
    """
    refs = _refs(kwargs)
    cron = _is_cron_session(collector, refs["session_id"])
    calls = plan_intentions(
        kwargs.get("tool_name"),
        kwargs.get("args"),
        kwargs.get("result"),
        kwargs.get("status"),
        cron=cron,
    )
    if not calls:
        return
    if any(call.event_type == "intention.captured" for call in calls):
        origin = _origin(collector, refs["session_id"], kwargs.get("task_id"), cron)
        for call in calls:
            if call.event_type == "intention.captured":
                call.origin = origin

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


def _emit_intention_update(
    *,
    intention_id: str,
    text: Optional[str],
    source: Optional[str],
    index_intent_id: Optional[str],
    publish_refused: Optional[str],
    approved_by: Optional[str],
    approval_state: Optional[str],
) -> None:
    """DATA-212 Lane B (R20): a held intention published through approval.md
    after its capture call (by the poller or a `confirm`), or refused by Index
    then, or (DREAM-1) declined by the resident on the card (`approval_state`
    `rejected`, no `index_intent_id`). One `intention.updated` with `index_intent_id`: the alias the data
    side registers, the poller's `sourceId` read corroborating it. Its
    `text_hash` is the plain SHA-256 of the exact string sent to Index.
    Every one of these restates the held text unchanged (the capture's
    hash), so each says `status_only: true` (DATA-248: a row in the version
    history, never a text version; with an Index id, data's publish-claim
    shape). Telemetry only: inert when the collector is, and never the
    publish's record (the daemon's log is)."""
    collector = _COLLECTOR
    if collector is None or not collector.config.active:
        return
    if not valid_id(intention_id) or (index_intent_id is not None and not valid_id(index_intent_id)):
        return
    call = IntentionCall(
        "intention.updated",
        intention_id=intention_id,
        index_intent_id=index_intent_id,
        text=text,
        source=source if source in ("message", "onboarding", "note", "ambient") else "ambient",
        capture_path="record_intention",
        publish_refused=publish_refused,
        status_only=True,
        approved_by=approved_by,
        approval_state=approval_state,
    )
    now = iso_from_epoch(time.time())
    collector.emit(
        call.event_type,
        _intention_payload(call, collector.config.capture, None),
        occurred_at=now,
        occurred_at_earliest=now,
        occurred_at_latest=now,
        intention_id=intention_id,
    )


def _emit_share_vote(event_type: str, payload: dict, *, event_id: str, occurred_at: Optional[str]) -> bool:
    """Lane O3: `digest.shared`, `vote.cast` or `digest.revoked`, after the
    resident's grant and `approval start` (or the resident's revocation). The
    event id is fixed by the caller before this runs, so a resend after a
    crash is the same row at ingest. True when the event was buffered."""
    collector = _COLLECTOR
    if collector is None or collector.plugin_disabled or not collector.config.active or collector.config.null_sink:
        return False
    event = collector.emit(event_type, payload, event_id=event_id, occurred_at=occurred_at,
                           occurred_at_earliest=occurred_at, occurred_at_latest=occurred_at)
    return event is not None


def _emit_card_event(event_type: str, payload: dict, *, event_id: str, occurred_at: Optional[str],
                     intention_id: Optional[str] = None) -> bool:
    """`approval.card_requested` / `approval.card_resolved` (`_card_events.py`,
    behind `AV_APPROVAL_CARD_EVENTS`). The event id is derived from the card by
    the caller, so a re-send after a crash is the same row at ingest. True when
    the event was buffered (a null sink buffers too, as every other event)."""
    collector = _COLLECTOR
    if collector is None or collector.plugin_disabled or not collector.config.active:
        return False
    event = collector.emit(event_type, payload, event_id=event_id, occurred_at=occurred_at,
                           occurred_at_earliest=occurred_at, occurred_at_latest=occurred_at,
                           intention_id=intention_id)
    return event is not None


def _share_vote_emitter_ready() -> bool:
    """An event emitted now would be sent: the collector is on with a token
    and a URL (a null sink buffers and never sends)."""
    collector = _COLLECTOR
    return (collector is not None and not collector.plugin_disabled and bool(collector.config.active)
            and not collector.config.null_sink)


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
    finalize's pass runs at once, with a trailing pass after the grace.

    Shutdown: Hermes has no shutdown hook at `0.21.3`, and the **gateway exits
    through `os._exit`** (`gateway/run.py` `_exit_after_graceful_shutdown`),
    which runs no `atexit` handler. Gateway shutdown finalizes the sessions
    that had a turn running when it began (`gateway/run_shutdown.py`
    `_finalize_shutdown_agents`, reason `shutdown`), which lands here, but the
    daemon threads then die with the process wherever they have got to. The
    exit drain (`Collector.shutdown`) only runs in a CLI or desktop process
    that exits normally. The turn-end passes (`on_session_end`) are what keep
    the backup current in a gateway.

    Events: the last step force-rotates the buffer and wakes the flusher
    (DATA-94), so the rest of Hermes's teardown is a window in which this
    session's close can still leave. Whatever misses it stays on disk and is
    sent by the next process (`Collector.recover_on_load`)."""
    session_id = kwargs.get("session_id")
    if session_id:
        session_id = str(session_id)
        state = collector.peek_session(session_id)
        cost = collector.read_session_cost(session_id) if state is not None and not state.ended else {}
        collector.session_ended(session_id, **cost)
        collector.check_profile(session_id)
        collector.request_snapshot(urgent=True)
    # Also for a session this process never saw (finalized after a restart)
    # or one without an id: a finalize is the only sign Hermes gives before a
    # stop, and a nudge costs a rename and an Event.set().
    collector.nudge_flush(force=True)


def _hook_subagent_start(collector: Collector, **kwargs: Any) -> None:
    _session(collector, kwargs)
    # Lineage for intention events' `payload.parent_session_id`.
    collector.note_parent(kwargs.get("child_session_id"), kwargs.get("parent_session_id"))


def _hook_subagent_stop(collector: Collector, **kwargs: Any) -> None:
    _session(collector, kwargs)


def _hook_on_stream_end(collector: Collector, **kwargs: Any) -> None:
    _session(collector, kwargs)


#: Hooks registered outside HOOK_BODIES because they return a value Hermes uses: the USER.md gate's
#: memory-result filter (`_user_md_gate.transform_memory_result`, review-b #558 S2).
GATE_HOOKS = ("transform_tool_result",)

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
    # SEC-3: av-approval's plugin inventory, behind AV_PLUGIN_EVENTS (default off), `_plugin_events`.
    _plugin_events.INVENTORY_BUS_EVENT: (_plugin_events.HOOK_NAME, _plugin_events.on_inventory),
    _plugin_events.UNKNOWN_BUS_EVENT: (_plugin_events.HOOK_NAME, _plugin_events.on_unknown),
    # SEC-6 half 2: av-approval's model observer, behind AV_MODEL_EVENTS (default off), `_model_events`.
    _model_events.OBSERVED_BUS_EVENT: (_model_events.HOOK_NAME, _model_events.on_observed),
    _model_events.OFFLIST_BUS_EVENT: (_model_events.HOOK_NAME, _model_events.on_offlist),
    # ov#357 M1 stopgap (b): av-approval's gate verdict changes, behind AV_GATE_EVENTS (default ON), `_gate_events`.
    _gate_events.BUS_EVENT: (_gate_events.HOOK_NAME, _gate_events.on_gate),
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


def with_terminal_args_fix(telemetry: Callable) -> Callable:
    """`pre_tool_call` = the telemetry counter, the EDGEOS-CURL-GUARD refusal, then the DATA-312 fix.

    The guard (`_edgeos_guard`) blocks a `terminal`/`execute_code` call that hand-writes an HTTP call
    to EdgeOS's directory or `/humans/me`; its block wins over any other return. Its own kill
    switch is `AV_EDGEOS_CURL_GUARD`, and like the fix it ignores every telemetry switch.

    The counter (`guarded`) returns None today; if it ever returns a directive,
    that directive wins and the fix adds nothing. Otherwise the fix may return
    one `modify` directive for a foreground `terminal` call (`_terminal_args`).

    The fix sits outside `guarded` on purpose: it is not telemetry. It runs
    with `AV_EVENTS_ENABLED=0`, with no token, with `pre_tool_call` in
    `AV_HOOKS_DISABLED`, and in a degraded session; only `AV_TERMINAL_ARGS_FIX`
    switches it off. It cannot raise (`safe_directive`), and the one log line
    names the keys it switched off, never a value or the command.
    """

    def pre_tool_call(*args: Any, **kwargs: Any) -> Any:
        result = telemetry(*args, **kwargs)
        # EDGEOS-CURL-GUARD (BUG 1, 14 Oct): a hand-written curl to EdgeOS's directory or
        # /humans/me is refused with the script to run instead. A block beats anything else.
        guard = _edgeos_guard.safe_directive(kwargs.get("tool_name"), kwargs.get("args"))
        if guard is not None:
            try:
                logger.info("av-events: edgeos_curl_guard refused tool=%s", kwargs.get("tool_name"))
            except BaseException:  # noqa: BLE001 - a log line must not cost the refusal
                pass
            return guard
        # USER.md GATE (review-b #558 S2 fold): outside a private session the memory tool may not touch a
        # Private USER.md entry or add or remove its mark. A block beats anything but the EdgeOS guard.
        memory_block = _user_md_gate.memory_write_directive(kwargs.get("tool_name"), kwargs.get("args"),
                                                           kwargs.get("session_id"))
        if memory_block is not None:
            try:
                logger.info("av-events: user_md_gate refused a memory write outside a private session")
            except BaseException:  # noqa: BLE001 - a log line must not cost the refusal
                pass
            return memory_block
        if result is not None:
            return result
        fix = _terminal_args.safe_directive(kwargs.get("tool_name"), kwargs.get("args"))
        if fix is not None:
            try:
                logger.debug("av-events: terminal_args neutralised=%s", ",".join(fix["args"]))
            except BaseException:  # noqa: BLE001 - a log line must not cost the fix
                pass
        return fix

    pre_tool_call.av_hook_name = getattr(telemetry, "av_hook_name", "pre_tool_call")  # type: ignore[attr-defined]
    return pre_tool_call


#: The name `AV_HOOKS_DISABLED` takes to turn off the DATA-444 reminder, read
#: like the outcome ask's `OUTCOME_ASK_SWITCH` (re-read at session boundaries).
APPROVALS_REMINDER_SWITCH = "approvals_reminder"


def _approvals_reminder_for(kwargs: dict, collector: Optional[Collector]) -> Optional[str]:
    """DATA-444: the Connect-approvals reminder for this turn, or None.

    None whenever `approvals_reminder` is in `AV_HOOKS_DISABLED`. Otherwise
    only a human's own message in the root session of their Telegram DM: the
    outcome ask's gate (`_outcome_note_answer`) without its capture test. Never
    a cron run (`platform=cron`, a `cron_` id, or a cron ancestor), a subagent
    (`parent_session_id` from Hermes or `subagent_start`), a turn Hermes
    injected, another platform, a group, or a chat whose type Hermes does not
    say. The platform must be Telegram both in this hook's payload and in what
    the collector saw, when it saw anything. Then `_approvals_reminder` reads
    the control plane's file and remembers the session."""
    if collector is not None and APPROVALS_REMINDER_SWITCH in collector.config.disabled_hooks:
        return None
    session_id = str(kwargs.get("session_id") or "").strip()
    if not session_id or session_id.startswith("cron_"):
        return None
    if str(kwargs.get("parent_session_id") or "").strip():
        return None
    text = kwargs.get("user_message")
    if not text or is_injected_turn(text, kwargs.get("conversation_history")):
        return None
    if _source_for(kwargs.get("platform")) != "telegram":
        return None
    if collector is not None:
        if _is_cron_session(collector, session_id) or collector.parent_of(session_id) is not None:
            return None
        state = collector.peek_session(session_id)
        if state is not None and state.source not in (None, "telegram"):
            return None
    if _session_chat_type() != "dm":
        return None
    return _approvals_reminder.reminder_for(session_id)


def with_approvals_reminder(telemetry: Callable, collector_ref=_collector) -> Callable:
    """`pre_llm_call` = the telemetry body, then the DATA-444 reminder.

    The telemetry (`guarded`) returns None today. Whatever it returns is kept
    and comes first; the reminder is appended after it (`_approvals_reminder.compose`).

    Like the DATA-312 fix, the reminder sits outside `guarded`: it is not
    telemetry, so `AV_EVENTS_ENABLED=0`, no token or `pre_llm_call` in
    `AV_HOOKS_DISABLED` does not stop it. Its switches are the control plane's
    file and its own name, `approvals_reminder`, in `AV_HOOKS_DISABLED`.
    Like DATA-312's `safe_directive`, the reminder never raises into the turn:
    any failure, `SystemExit` included, is no reminder. One info line says a
    reminder was given, with nothing about the session or the file.
    """

    def pre_llm_call(*args: Any, **kwargs: Any) -> Any:
        result = telemetry(*args, **kwargs)
        try:
            reminder = _approvals_reminder_for(kwargs, collector_ref())
        except BaseException:  # noqa: BLE001 - a reminder never costs the turn
            reminder = None
        if not reminder:
            return result
        try:
            composed = _approvals_reminder.compose(result, reminder)
        except BaseException:  # noqa: BLE001
            return result
        try:
            logger.info("av-events: approvals_reminder given")
        except BaseException:  # noqa: BLE001 - a log line must not cost the reminder
            pass
        return composed

    pre_llm_call.av_hook_name = getattr(telemetry, "av_hook_name", "pre_llm_call")  # type: ignore[attr-defined]
    return pre_llm_call


def with_skill_change_note(inner: Callable) -> Callable:
    """`pre_llm_call` = the inner chain, then SKILL-CHANGE-NOTE's one note (`_skill_change_note.py`),
    staged only by this turn's MINIAPP-PICKUP rebuild of this session's prompt, and given only in a
    private chat (a group, channel or thread chat drops it). Appended after
    whatever the chain returns (`_approvals_reminder.compose`). Outside `guarded` like the reminder:
    it is not telemetry. Never raises into the turn; one info line, with the session and apps left out."""

    def pre_llm_call(*args: Any, **kwargs: Any) -> Any:
        result = inner(*args, **kwargs)
        try:
            note = _skill_change_note.take(kwargs.get("session_id"))
            # Only an owner's private chat (or one whose type Hermes does not say); taken either way.
            if note and not _skill_change_note.gives_note(_session_chat_type()):
                note = None
        except BaseException:  # noqa: BLE001 - a note never costs the turn
            note = None
        if not note:
            return result
        try:
            composed = _approvals_reminder.compose(result, note)
        except BaseException:  # noqa: BLE001
            return result
        try:
            logger.info("av-events: skill_change_note given")
        except BaseException:  # noqa: BLE001 - a log line must not cost the note
            pass
        return composed

    pre_llm_call.av_hook_name = getattr(inner, "av_hook_name", "pre_llm_call")  # type: ignore[attr-defined]
    return pre_llm_call


def build_hooks(collector_ref=_collector) -> dict:
    """Wrap every hook body in the fail-open guard. One decorator, no exceptions.

    `pre_tool_call` is then wrapped once more by `with_terminal_args_fix`
    (DATA-312), which is the only thing in this plugin that returns a directive,
    and `pre_llm_call` by `with_clock_line` (CLOCK-1, the Now line on every turn)
    inside `with_approvals_reminder` (DATA-444), the two things that return context.
    `post_tool_call` gets `with_memory_write_ack` (F1 PROMPT REFRESH), which returns nothing.
    """
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
        if name == "pre_tool_call":
            wrapped = with_terminal_args_fix(wrapped)
        elif name == "post_tool_call":
            # F1 PROMPT REFRESH (`_prompt_refresh.py`): the agent's own memory write is acknowledged,
            # so it does not refresh the session's system prompt; outside `guarded`.
            wrapped = _prompt_refresh.with_memory_write_ack(wrapped)
        elif name == "pre_llm_call":
            # CLOCK-1 (`_clock.py`): the Now line on every turn, cron and subagents included,
            # between the telemetry return and the DATA-444 reminder; outside `guarded`.
            # SKILL-CHANGE-NOTE (`_skill_change_note.py`): after them, on a mini-app change's rebuild turn only.
            wrapped = with_skill_change_note(
                with_approvals_reminder(with_clock_line(wrapped, collector_ref), collector_ref))
        hooks[name] = wrapped
    return hooks


def _on_unload() -> None:
    """`ctx.on_unload` callback: Hermes has dropped every hook we registered.

    `discover_and_load(force=True)` calls `unload()` (which runs this and
    clears the hook lists) and then `register()` again. A loader that reuses
    this module rather than re-importing it would otherwise find `_REGISTERED`
    still set and leave the plugin loaded with no hooks.

    The collector is retired (its threads told to stop, no join) and
    forgotten: the Hermes in use re-imports the plugin on a force reload, and
    an old collector left running flushed the same buffer beside the new one,
    posting every event twice. A re-register on this module builds a fresh one.
    """
    global _COLLECTOR, _REGISTERED
    _REGISTERED = False
    # F1: Hermes's own build_turn_context goes back with the hooks (the memory acknowledgement is one).
    _prompt_refresh.uninstall()
    _miniapp_epoch.unregister()
    # R-DEON: Hermes's own tool_search core-name check goes back too.
    _village_visible.uninstall()
    # MM-INFER-VIS: the Index plugin's speaker._main_agent and the bridge client's create go back too.
    _negotiator_llm.stop()
    # Lane B: the approval poller stops with the plugin (its pending state is on disk).
    try:
        _approval.stop_poller()
        _intent_approval.set_emitter(None)
        _card_events.set_emitter(None)
        _share_vote.set_emitter(None, None)
    except Exception:  # noqa: BLE001 - an unload must never fail on us
        pass
    collector, _COLLECTOR = _COLLECTOR, None
    if collector is not None:
        try:
            collector.retire()
        except Exception:  # noqa: BLE001 - an unload must never fail on us
            pass


def register(ctx) -> None:
    """Hermes plugin entrypoint. Synchronous; the loader never awaits it.

    Hooks are registered unconditionally, including when the plugin is disabled
    or has no token. The kill switches are re-read at every session start, so a
    tenant that gets its env fixed mid-process starts reporting on its next
    session without a restart, and a tenant that never gets a token runs a set
    of hooks that do nothing.

    It also registers one read-only tool, `consent_status` (`_consent.py`),
    when `ctx.register_tool` exists, and — only when `AV_RECORD_INTENTION` is
    on — `record_intention` (`_record_intention.py`, DATA-212); and, behind
    `AV_DIGEST_SHARE` / `AV_VILLAGE_VOTE`, `share_digest` and `village_vote`
    (`_share_vote.py`, lane O3); and, behind `AV_PRAY`, `pray` (`_pray.py`,
    PRAYER P3), and behind `AV_ASK_VILLAGE`, `ask_village` (`_ask_village.py`), and behind
    `AV_SEARCH_VILLAGE`, `search_village` (`_search_village.py`) and `query_village`
    (`_query_village.py`). Those and village-bridge's `village` are kept out of Hermes's
    `tool_search` bridge (`_village_visible.py`, R-DEON). Behind `AV_ASK_ODIN`, `ask_odin`
    (`_ask_odin.py`, ODIN-ASK), kept out of the bridge the same way (ODIN-ASK-VISIBLE).

    Idempotent. Hermes loads a plugin once per process, but a profile switch or
    a `force=True` reload can call `register()` again on a module that is still
    in `sys.modules` — and registering twice appends a second callback to every
    hook list, which doubles every event and every counter. An unload clears the
    guard (`_on_unload`), so a register after it wires the hooks again.
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
    # The one tool (DATA-157): a read of this tenant's research consent. After
    # the hooks, and guarded inside, so a Hermes without `register_tool` (or
    # one that refuses it) still gets every hook.
    register_consent_tool(ctx)
    # DATA-212: the intention front door, behind its per-tenant switch. It
    # registers its own session-lineage listeners, outside the collector's
    # guard, so the cron gate never depends on telemetry being on. Lane B: a
    # publish the approval poller (or a confirm) makes later is emitted here.
    register_record_intention_tool(ctx, emit=_emit_intention_update)
    # DATA-470 family: approval card events, inert unless AV_APPROVAL_CARD_EVENTS is on.
    _card_events.set_emitter(_emit_card_event)
    # Lane O3: `share_digest` and `village_vote`, each behind its own switch
    # (`AV_DIGEST_SHARE`, `AV_VILLAGE_VOTE`) and inert without approval.md.
    try:
        _share_vote.register_share_vote_tools(ctx, emit=_emit_share_vote, ready=_share_vote_emitter_ready)
    except Exception:  # noqa: BLE001 - the tools are optional; the hooks are not
        pass
    # PRAYER P3: `pray`, one request to the control plane for an admin to review,
    # behind `AV_PRAY` (unset: not registered). Not routed through the approval gate.
    try:
        register_pray_tool(ctx)
    except Exception:  # noqa: BLE001 - the tools are optional; the hooks are not
        pass
    # ASK-VILLAGE (D): `ask_village`, one question about the main group to the control plane,
    # behind `AV_ASK_VILLAGE` (unset: not registered). Not routed through the approval gate.
    try:
        register_ask_village_tool(ctx)
    except Exception:  # noqa: BLE001 - the tools are optional; the hooks are not
        pass
    # ODIN-ASK (phase 1b): `ask_odin`, one question to ODIN, the village's constitution agent, through the
    # control plane, beside `ask_village` on its wire, behind `AV_ASK_ODIN` (unset: not registered). Not
    # routed through the approval gate.
    try:
        register_ask_odin_tool(ctx)
    except Exception:  # noqa: BLE001 - the tools are optional; the hooks are not
        pass
    # VILLAGE SEARCH: `search_village`, scrubbed group messages matching words, next to `ask_village`,
    # behind `AV_SEARCH_VILLAGE` (unset: not registered). Not routed through the approval gate.
    try:
        register_search_village_tool(ctx)
    except Exception:  # noqa: BLE001 - the tools are optional; the hooks are not
        pass
    # VILLAGE QUERY: `query_village`, one read-only SQL SELECT run by the app over the same scrubbed rows,
    # on the same switch as `search_village`. Not routed through the approval gate.
    try:
        register_query_village_tool(ctx)
    except Exception:  # noqa: BLE001 - the tools are optional; the hooks are not
        pass
    # USER.md GATE (review-b #558 S1, S2): the same idempotent gate village-memory installs, so the
    # built-in USER.md never carries the Private entries outside a private session even when the provider
    # never loads; and the memory tool's results leave them out there too (`_user_md_gate.py`).
    try:
        _user_md_gate.install_user_md_gate()
    except Exception:  # noqa: BLE001 - the gate fails closed inside; never cost the hooks
        pass
    try:
        ctx.register_hook("transform_tool_result", _user_md_gate.transform_memory_result)
    except Exception:  # noqa: BLE001 - a Hermes without the hook
        pass
    # F1 PROMPT REFRESH: wrap Hermes's build_turn_context (one module attribute, as av-display wraps
    # a display method) so a long session's system prompt follows USER.md / MEMORY.md / AGENTS.md.
    # Behind AV_PROMPT_REFRESH (default: team tenants only); a missing seam is one log line.
    try:
        _prompt_refresh.install(_collector)
    except Exception:  # noqa: BLE001 - the refresh is optional; the hooks are not
        pass
    # MINIAPP-PICKUP (v2.1.5): the installed-apps stamp each new prompt carries (`_miniapp_epoch.py`),
    # which the same wrapper checks so an open chat picks up an install or removal without /new.
    # Behind AV_MINIAPP_REFRESH (default on); a Hermes without plugin prompt sections is one log line.
    try:
        _miniapp_epoch.register_section(ctx)
    except Exception:  # noqa: BLE001 - optional; the hooks are not
        pass
    # R-DEON: the village tools (ask_village, search_village, query_village, village) and
    # av-elicit's elicitation_record (GC-ELICIT) stay in the model's tool list when Hermes's
    # tool_search defers plugin tools (`_village_visible.py`).
    # Behind AV_VILLAGE_TOOLS_VISIBLE (default on); a missing seam is one log line.
    try:
        _village_visible.install()
    except Exception:  # noqa: BLE001 - the visibility is optional; the hooks are not
        pass
    # MM-INFER-VIS: the MoralMod negotiator's model steps (the Index plugin's loopback bridge calls
    # the model on its own client, outside Hermes's API hooks) as llm.call, behind
    # AV_EVENTS_NEGOTIATOR_LLM (default off), and the MoralMod key for that bridge client only, behind
    # AV_MORALMOD_OWN_KEY (default off). `_negotiator_llm.py`; a missing seam is a counted no-op, a
    # failure is `_quiet`'s counter.
    try:
        _negotiator_llm.start(_collector, __name__, _quiet)
    except Exception:  # noqa: BLE001 - the observer is optional; the hooks are not
        pass
    # DATA-183: hear about the unload that clears the hooks. Optional in the
    # API (probe, fail open): without it register() behaves as before.
    on_unload = getattr(ctx, "on_unload", None)
    if callable(on_unload):
        try:
            on_unload(_on_unload)
        except Exception:  # noqa: BLE001
            pass
    # DATA-94: a gateway stop leaves its last batch on disk (`os._exit` runs
    # no atexit flush). Start sending it now, not at the first new event.
    # Local file operations only; the network is the flusher thread's.
    _COLLECTOR.recover_on_load()
    _REGISTERED = True


__all__ = [
    "register",
    "CONSENT_TOOL_NAME",
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
    "strip_capability_urls",
    "hash_obj",
    "hash_text",
    "plan_intentions",
    "hermes_version",
    "overlay_ref",
    "__version__",
]
