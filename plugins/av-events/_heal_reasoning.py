"""HOT-RASOOL-2: heal a session whose history mixes encrypted reasoning from two providers.

**The bug (CLAIMS L28660).** A luna fallback turn with reasoning on stored OpenRouter
``reasoning_details`` (encrypted, ``format: openai-responses-v1``) on its assistant rows. Hermes
v2026.9.24 replays ``reasoning_details`` verbatim on an OpenRouter route
(``agent/transports/chat_completions.py:258-271`` ``_route_replays_reasoning_details``, kept by
``_sanitize_message`` :375-427), so every later call to the primary (haiku via OpenRouter) is
refused with HTTP 400 "encrypted reasoning or compaction content from multiple providers ... Start
a new conversation". Hermes's classifier knows no such wording (``agent/error_classifier.py:1141-1153``
matches only the OpenAI Responses ``invalid_encrypted_content`` family), so it lands on the 400
default ``format_error`` (``retryable=False, should_fallback=True``) and every turn falls back to luna
("request format rejected"). ov#514 stopped new luna items being written; the stored ones stay.

**What this does (dark: ``AV_HEAL_REASONING_HISTORY``, default off).** Three seams Hermes offers
plugins, no Hermes patch:

1. ``llm_request`` middleware (``hermes_cli/middleware.py``, applied per attempt at
   ``agent/turn_api_request.py:141-154``). It records the attempt's session for step 2 (a
   thread-local: the build, the call and the error handling of one attempt run on one thread,
   ``agent/conversation_loop.py:1415-1445``). For a session already marked, it drops the
   ``reasoning_details`` entries another provider minted from the outgoing copy only: the stored
   history is never touched, so the strip is idempotent and repeats on every call of that session.
2. ``transform_api_error_classification`` (consulted first, ``agent/error_classifier.py:693-713``,
   stage 1 of ``_STAGES`` :950). On exactly this 400 (status 400 and the fixed substring) for a
   session not yet marked, it marks the session and returns ``thinking_signature``: Hermes's own
   one-shot recovery then strips ``reasoning_details`` from that attempt's ``api_messages`` and
   retries the PRIMARY at once (``agent/turn_recovery.py:495-507``, before any fallback,
   ``agent/turn_api_error.py:130-134``). The retry also passes step 1, which now strips.
   The same 400 again on a marked session is not reclassified: Hermes's own ``format_error``
   fallback runs as before (never a loop), and the session is queued for step 3.
3. ``pre_gateway_dispatch``: the next message in a DM whose repair failed starts a fresh session
   through the gateway's own ``/new`` handler, then the resident gets ``RESIDENT_LINE`` once and
   their message is dispatched into the fresh session.

Logging: codes and counts only, never message text or ids (``av-events: heal_reasoning code=...``).

State is per process. A gateway restart forgets the marks, so a still-poisoned session pays one
more 400 and one more in-turn repair: bounded, never a loop.

Python 3.11, standard library only.
"""

from __future__ import annotations

import dataclasses
import logging
import re
import threading
from collections import OrderedDict
from typing import Any, Optional

from ._core import env_flag_on

logger = logging.getLogger("av-events")

#: The on-switch (``1|true|yes|on``; process environment, then ``$HERMES_HOME/.env``). Default off.
SWITCH = "AV_HEAL_REASONING_HISTORY"

#: OpenRouter's wording (CLAIMS L26001), lower-cased. Matched, never stored or logged. The same
#: substring as ov#516's ``_llm_errors.MIXED_PROVIDER_TEXT``; fold into one constant once both land.
MIXED_PROVIDER_TEXT = "encrypted reasoning or compaction content from multiple providers"

#: The reason handed back to Hermes: the one ``FailoverReason`` whose built-in recovery strips
#: ``reasoning_details`` from the attempt and retries the same model at once.
RETRY_REASON = "thinking_signature"

#: Product's line (CLAIMS L28664), sent once per fresh session this module starts. Never per turn.
RESIDENT_LINE = (
    "My last chat got tangled on my side, so I've started a fresh one. Anything from before this "
    "message I may not remember; just tell me again if needed."
)

#: Session marks.
STRIP = "strip"  # repair taken: outgoing requests of this session drop foreign reasoning
FAILED = "failed"  # the 400 came back after the strip: a fresh session on the next DM message

#: Marks kept per process (oldest dropped first). A box has one resident; this only bounds memory.
MAX_SESSIONS = 512

_LOCK = threading.Lock()
_SESSIONS: "OrderedDict[str, str]" = OrderedDict()
_ATTEMPT = threading.local()
#: Code -> count since load. Read by tests and a debugger; never sent anywhere.
COUNTS: dict[str, int] = {}


def enabled() -> bool:
    return env_flag_on(SWITCH)


def _log(code: str, **counts: int) -> None:
    with _LOCK:
        COUNTS[code] = COUNTS.get(code, 0) + 1
    extra = "".join(f" {name}={int(value)}" for name, value in sorted(counts.items()))
    logger.info("av-events: heal_reasoning code=%s%s", code, extra)


def _mark(session_id: str, state: str) -> None:
    with _LOCK:
        _SESSIONS[session_id] = state
        _SESSIONS.move_to_end(session_id)
        while len(_SESSIONS) > MAX_SESSIONS:
            _SESSIONS.popitem(last=False)


def session_state(session_id: str) -> Optional[str]:
    with _LOCK:
        return _SESSIONS.get(session_id)


def _pop_failed(session_id: str) -> bool:
    with _LOCK:
        if _SESSIONS.get(session_id) != FAILED:
            return False
        del _SESSIONS[session_id]
        return True


def _has_failed() -> bool:
    with _LOCK:
        return FAILED in _SESSIONS.values()


def reset_state() -> None:
    """Forget every mark and count (tests)."""
    with _LOCK:
        _SESSIONS.clear()
        COUNTS.clear()
    _ATTEMPT.__dict__.clear()


# ---------------------------------------------------------------------------
# Which reasoning entries are foreign
# ---------------------------------------------------------------------------

_ALNUM = re.compile(r"[^a-z0-9]")


def _vendor_of_model(model: Any) -> str:
    """``anthropic/claude-haiku-4.5`` -> ``anthropic``; ``x-ai/grok`` -> ``xai``; no slash -> ''."""
    text = str(model or "").strip().lower()
    if "/" not in text:
        return ""
    return _ALNUM.sub("", text.split("/", 1)[0])


def _vendor_of_format(fmt: Any) -> str:
    """OpenRouter ``format``: ``openai-responses-v1`` -> ``openai``, ``xai-responses-v1`` -> ``xai``."""
    if not isinstance(fmt, str) or not fmt.strip():
        return ""
    head = fmt.strip().lower().split("-", 1)[0]
    vendor = _ALNUM.sub("", head)
    return "" if vendor == "unknown" else vendor


def _is_opaque(entry: dict) -> bool:
    """An entry only its issuer can read: encrypted or compaction types, or a signature/blob."""
    kind = str(entry.get("type") or "").lower()
    if "encrypted" in kind or "compaction" in kind:
        return True
    return any(isinstance(entry.get(k), str) and entry.get(k) for k in ("signature", "data", "encrypted_content"))


def is_foreign(entry: Any, vendor: str) -> bool:
    """True when ``entry`` (one ``reasoning_details`` item) was not minted by ``vendor``'s models.

    An entry naming another vendor's format goes (any type). An opaque entry with no format, or any
    opaque entry when the current vendor is unknown, goes too: in a marked session the provider has
    already refused the mix, and an unreadable blob of unknown origin is the likely cause. Plain text
    with no format stays.
    """
    if not isinstance(entry, dict):
        return False
    fmt_vendor = _vendor_of_format(entry.get("format"))
    if fmt_vendor and vendor:
        return fmt_vendor != vendor
    return _is_opaque(entry)


def strip_foreign(messages: Any, model: Any) -> tuple[Any, int, int]:
    """``(messages', items, rows)``: assistant rows without the entries another provider minted.

    Pure. Returns the input list itself (and zero counts) when nothing is foreign; otherwise a new
    list whose changed rows are new dicts (``reasoning_details`` dropped when it ends up empty).
    """
    if not isinstance(messages, list):
        return messages, 0, 0
    vendor = _vendor_of_model(model)
    out: Optional[list] = None
    items = rows = 0
    for index, msg in enumerate(messages):
        if not isinstance(msg, dict) or msg.get("role") != "assistant":
            continue
        details = msg.get("reasoning_details")
        if not isinstance(details, list) or not details:
            continue
        kept = [d for d in details if not is_foreign(d, vendor)]
        if len(kept) == len(details):
            continue
        if out is None:
            out = list(messages)
        row = {k: v for k, v in msg.items() if k != "reasoning_details"}
        if kept:
            row["reasoning_details"] = kept
        out[index] = row
        items += len(details) - len(kept)
        rows += 1
    return (messages if out is None else out), items, rows


# ---------------------------------------------------------------------------
# Hermes seams
# ---------------------------------------------------------------------------


def llm_request_middleware(**kwargs: Any) -> Optional[dict]:
    """``llm_request`` middleware: note the attempt's session; strip foreign reasoning in a marked one."""
    if not enabled():
        return None
    session_id = str(kwargs.get("session_id") or "")
    _ATTEMPT.session_id = session_id
    _ATTEMPT.model = str(kwargs.get("model") or "")
    if not session_id or session_state(session_id) is None:
        return None
    request = kwargs.get("request")
    if not isinstance(request, dict):
        return None
    messages, items, rows = strip_foreign(request.get("messages"), kwargs.get("model"))
    if not items:
        return None
    _log("strip", items=items, rows=rows)
    return {
        "request": {**request, "messages": messages},
        "source": "av-events",
        "name": "heal_reasoning",
        "reason": "foreign_reasoning_stripped",
    }


def is_mixed_provider_400(status_code: Any, message: Any) -> bool:
    """Exactly this refusal: HTTP 400 and OpenRouter's fixed wording."""
    if status_code != 400 or isinstance(status_code, bool):
        return False
    return isinstance(message, str) and MIXED_PROVIDER_TEXT in message.lower()


def classify_api_error(**kwargs: Any) -> Optional[dict]:
    """``transform_api_error_classification``: one in-turn repair per session, then Hermes as before."""
    if not enabled():
        return None
    if not is_mixed_provider_400(kwargs.get("status_code"), kwargs.get("error_message")):
        return None
    session_id = str(getattr(_ATTEMPT, "session_id", "") or "")
    if not session_id or getattr(_ATTEMPT, "model", "") != str(kwargs.get("model") or ""):
        # No attempt of ours on this thread (or another model's): leave it to Hermes.
        _log("no_session")
        return None
    state = session_state(session_id)
    if state is None:
        _mark(session_id, STRIP)
        _log("repair")
        return {
            "reason": RETRY_REASON,
            "retryable": False,
            "should_fallback": True,
            "message": "mixed-provider reasoning history: foreign reasoning stripped, primary retried once",
        }
    if state == STRIP:
        _mark(session_id, FAILED)
        _log("repair_failed")
    else:
        _log("still_failed")
    return None


async def pre_gateway_dispatch(**kwargs: Any) -> None:
    """The next DM message of a session whose repair failed: a fresh session, one line, then dispatch.

    Uses the gateway's own ``/new`` handler, so the agent cache, run generation, Telegram topic binding
    and session hooks move exactly as a resident's ``/new`` would. Always returns None (dispatch goes on).
    """
    if not enabled() or not _has_failed():
        return None
    event = kwargs.get("event")
    gateway = kwargs.get("gateway")
    store = kwargs.get("session_store")
    source = getattr(event, "source", None)
    if event is None or gateway is None or store is None or source is None:
        return None
    if str(getattr(source, "chat_type", "") or "") != "dm":
        return None
    try:
        key_for = getattr(gateway, "_session_key_for_source", None)
        peek = getattr(store, "peek_session_id", None)
        reset = getattr(gateway, "_handle_reset_command", None)
        adapter_for = getattr(gateway, "_delivery_adapter_for", None)
        if not (callable(key_for) and callable(peek) and callable(reset) and callable(adapter_for)):
            _log("fresh_session_unavailable")
            return None
        session_id = peek(key_for(source))
        if not session_id or not _pop_failed(str(session_id)):
            return None
        text = getattr(event, "text", "")
        if isinstance(text, str) and text.lstrip().startswith("/"):
            # The resident's own command (``/new`` included) goes through untouched.
            _log("fresh_session_skipped_command")
            return None
        await reset(dataclasses.replace(event, text="/new"))
        adapter = adapter_for(source)
        if adapter is not None:
            await adapter.send(source.chat_id, RESIDENT_LINE)
        _log("fresh_session")
    except Exception:  # noqa: BLE001 - never break dispatch; the code is the whole report
        _log("fresh_session_error")
    return None


def register(ctx: Any) -> bool:
    """Wire the three seams when ``AV_HEAL_REASONING_HISTORY`` is on (av-events' ``register()``
    guard keeps this to once per load). Off: nothing is registered, so Hermes also skips the request
    deep copy it makes only while some ``llm_request`` middleware exists. The switch is re-read in
    every callback, so turning it off in the process environment makes them no-ops at once.
    """
    if not enabled():
        return False
    register_middleware = getattr(ctx, "register_middleware", None)
    if not callable(register_middleware):
        _log("no_middleware_seam")
        return False
    register_middleware("llm_request", llm_request_middleware)
    ctx.register_hook("transform_api_error_classification", classify_api_error)
    ctx.register_hook("pre_gateway_dispatch", pre_gateway_dispatch)
    _log("registered")
    return True


__all__ = [
    "COUNTS",
    "FAILED",
    "MIXED_PROVIDER_TEXT",
    "RESIDENT_LINE",
    "RETRY_REASON",
    "STRIP",
    "SWITCH",
    "classify_api_error",
    "is_foreign",
    "is_mixed_provider_400",
    "llm_request_middleware",
    "pre_gateway_dispatch",
    "register",
    "reset_state",
    "session_state",
    "strip_foreign",
]
