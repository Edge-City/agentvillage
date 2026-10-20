"""MM-INFER-VIS: the MoralMod negotiator's model steps as `llm.call` (observe-only, default off).

Why. The MoralMod runtime (the Index plugin's Bun negotiator) asks the resident's own model for
each negotiation step by POSTing to the Index plugin's loopback bridge (`/complete`). At the pinned
`INDEX_PLUGIN_REF` (04d833b8) the bridge runs inside the Hermes gateway process
(`sidecar.py:159-167` starts `bridge.py`'s ThreadingHTTPServer), routes to `speaker.complete`
(`bridge.py:11/49`), and `speaker.complete` (`speaker.py:173-203`) calls
`agent.client.chat.completions.create(**kwargs)` directly on ONE dedicated `AIAgent` that
`speaker._main_agent()` (`:138-170`) builds from the gateway's runtime kwargs and caches in the
module global `_main`. A raw `client.chat.completions.create` fires none of Hermes's
`pre_api_request` / `post_api_request` / `api_request_error` hooks, so those steps never became
`llm.call` and their spend was invisible.

How. `install()` finds the Index plugin's `speaker` module in `sys.modules` (it never imports it):
Hermes imports a directory plugin as `hermes_plugins.<slug>` (`hermes_cli/plugins_loader.py:605-660`
at v2026.9.24), so `index-network`'s is `hermes_plugins.index_network.speaker`, bare for whichever
home claims the slug first and `__home_<digest>` for any other. The name therefore does not say
whose it is: only a speaker whose plugin directory sits beside this av-events (the same
`<home>/plugins`) is wrapped, and any other is counted `negotiator_llm_foreign_home`. It rebinds
`speaker._main_agent` (one module attribute, as `_village_visible` rebinds `_core_tool_names`):
the wrapper calls the plugin's own function, returns its agent unchanged (and lets anything it
raises through unchanged), and before returning wraps that agent's
`client.chat.completions.create` ONCE (a marker attribute on the wrapper). `speaker.complete` reads
`_main_agent` through its module global on every call, so the rebinding takes effect without
touching the bridge (`bridge.py` binds `complete` itself at import, which is why `complete` is not
the seam).

Only the bridge's own client is wrapped. Hermes builds a fresh `openai.OpenAI` for every
`AIAgent` (`agent/agent_runtime_helpers.py:1805-1902`, `create_openai_client`; only the httpx
connection pool is shared), the SDK caches `client.chat` and `.completions` per client instance,
and the wrapper is an instance attribute on that one `Completions` object. The resident's chat
agents are other `AIAgent`s with other clients and are never touched. A client that is not an
`openai` SDK client (a MoA facade, a provider-supplied client) is not wrapped (counted).

What is sent. One `llm.call@1` per `create`, with `caller: "moralmod_negotiator"` (agentvillage-data
already types `caller` on `llm.call@1`, DATA-506: `^[a-z][a-z0-9_]{0,63}$`; every other plugin
`llm.call` sends no `caller`, and null means Hermes's own request path) and `consent_scope`
(`AV_EVENTS_NEGOTIATOR_LLM_SCOPE`, `code.run`'s semantics). Model, provider, the five token buckets
(Hermes's own `normalize_usage`, so they add up like the agent's), the provider's `usage.cost`
when it carries one, OpenRouter's generation id, latency, a closed finish reason, and on failure a
closed error type and the HTTP status. Never the messages, the tools, the completion or any length
of them but the ones `llm.call` already sends above `metadata` (the completion's character and
tool-call counts); `tools_hash` and `system_prompt_hash` are null (the negotiator's system message
embeds the resident's intent, and `llm.call`'s hashes are unkeyed). No session, turn or run id: the
bridge has none, and a null `session_id` keeps the row out of every session, run and trajectory
model downstream (it joins only by tenant and day).

Never at the cost of the step. The original `create` is called with the same arguments and its
result returned (or its exception re-raised) unchanged; inside the create wrapper nothing runs
before it but a clock read. The `_main_agent` wrapper runs before the step too: switch reads, and
with the key switch on a sha256 and, once per key, a local client build (review-b measured +169 us
median per step against a model call of seconds).
Everything after it is `_quiet` (a counter, never the session breaker), local and synchronous like
every av-events emit: one buffered line, no network (the flusher sends). The flag is re-read on
every step, so off stops events at once; the wrap itself is installed only when the flag is on at
plugin load (and the poller that finds the speaker module runs only then). Unload puts the plugin's
function and the client's method back.

The MoralMod key (Carter, CLAIMS L12977). Behind `AV_MORALMOD_OWN_KEY` (default off), with
`MORALMOD_LLM_API_KEY` an OpenRouter key, the same seam builds the bridge's dedicated agent a
client from Hermes's own factory (`agent._create_openai_client`) on a copy of that agent's client
kwargs with only `api_key` replaced (`_apply_key`), so the negotiator's spend lands on that key and
never on the tenant's. The resident's chat client, the agent's stored kwargs and the tenant client
object are untouched; switching off puts the tenant client back. With the switch on the step
runs on the MoralMod key or fails, never on the tenant's (Carter, CLAIMS L13060): a missing or
malformed key, or one the switch cannot apply (not OpenRouter over https, a custom Authorization
header, no factory, the factory failing), raises `MoralmodKeyUnavailable` from `_main_agent`, which
the bridge answers with its 502 as for any step it cannot run (counted `moralmod_key_missing` /
`moralmod_key_failed`); an invalid or exhausted key fails as the SDK error, with no retry on the
tenant's key. The key is registered with the sanitiser at plugin load. `key_source` (`moralmod` |
`tenant`) rides on every negotiator `llm.call`.

Python 3.11, standard library only.
"""

from __future__ import annotations

import functools
import hashlib
import logging
import math
import os
import re
import sys
import threading
import time
import weakref
from typing import Any, Callable, Optional
from urllib.parse import urlparse

from ._code_run import SCOPE_ALL, SCOPE_RESEARCH, SCOPES
from ._core import env, env_flag_on, iso_from_epoch, register_literal_secret

logger = logging.getLogger("av-events")

TYPE = "llm.call"
FLAG = "AV_EVENTS_NEGOTIATOR_LLM"
SCOPE_ENV = "AV_EVENTS_NEGOTIATOR_LLM_SCOPE"
CALLER = "moralmod_negotiator"
#: Its name in `AV_HOOKS_DISABLED` (it is not a Hermes hook).
HOOK_NAME = "negotiator_llm"

#: Counters (`Collector.count`: a name and a count, logged once per process, never a value).
FAILED = "negotiator_llm_failed"
NO_SEAM = "negotiator_llm_no_seam"
CLIENT_UNSUPPORTED = "negotiator_llm_client_unsupported"
#: A speaker module that cannot be proven to be this av-events' own home's (S1).
FOREIGN_HOME = "negotiator_llm_foreign_home"

#: The own-key switch (Carter, CLAIMS L12977: a significant new cost must not land on the tenant's
#: key). With `AV_MORALMOD_OWN_KEY` on and `MORALMOD_LLM_API_KEY` an OpenRouter key, the bridge's
#: dedicated agent gets a client built by Hermes's own factory from its own client kwargs with only
#: the key replaced. Never the resident's chat client.
OWN_KEY_FLAG = "AV_MORALMOD_OWN_KEY"
OWN_KEY_ENV = "MORALMOD_LLM_API_KEY"
KEY_MORALMOD = "moralmod"
KEY_TENANT = "tenant"
KEY_SOURCES = (KEY_MORALMOD, KEY_TENANT)
KEY_MISSING = "moralmod_key_missing"
KEY_UNSUPPORTED = "moralmod_key_unsupported"
KEY_FAILED = "moralmod_key_failed"
#: An OpenRouter key's shape, as long as the sanitiser's `openrouter_key` pattern needs (16+ after
#: `sk-or-`, `_core._SECRET_PATTERNS`); anything else in the variable counts as missing.
_OWN_KEY_SHAPE = re.compile(r"sk-or-[A-Za-z0-9_-]{16,256}")
OPENROUTER_HOST = "openrouter.ai"
_KEY_MARK = "__av_moralmod_key__"
_TENANT_CLIENT = "__av_tenant_client__"

#: The Index plugin as Hermes imports it (`INDEX_PLUGIN = "index-network"`, install_index_plugin.ts).
NS_PARENT = "hermes_plugins"
OWN_SLUG = "av_events"
INDEX_SLUG = "index_network"
SPEAKER = "speaker"
WRAPPED_NAME = "_main_agent"
#: Both must be callables on the speaker module, or the plugin revision moved: a counted no-op.
REQUIRED = (WRAPPED_NAME, "complete")

#: Poller: every FAST_S for the first FAST_TRIES passes (the Index plugin loads after av-events,
#: discovery is sorted by directory name), then every SLOW_S (a reloaded Index plugin is a new module).
FAST_S = 2.0
FAST_TRIES = 150
SLOW_S = 30.0

#: The payload's keys in order. Always present; the two `ABOVE_METADATA` keys only above `metadata`.
KEYS = (
    "model",
    "provider",
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "reasoning_tokens",
    "latency_ms",
    "finish_reason",
    "tools_hash",
    "system_prompt_hash",
    "api_mode",
    "response_model",
    "tool_count",
    "message_count",
    "cost_usd",
    "generation_id",
    "error_type",
    "status_code",
    "caller",
    "key_source",
    "consent_scope",
)
ABOVE_METADATA = ("assistant_content_chars", "assistant_tool_call_count")

FINISH_REASONS = ("stop", "length", "tool_calls", "content_filter", "function_call")
FINISH_ERROR = "error"
FINISH_OTHER = "other"
#: Exception class names sent as themselves (the openai SDK's, then a few builtins); any other is `other`.
ERROR_TYPES = (
    "APIError",
    "APIStatusError",
    "APIConnectionError",
    "APITimeoutError",
    "APIResponseValidationError",
    "BadRequestError",
    "AuthenticationError",
    "PermissionDeniedError",
    "NotFoundError",
    "ConflictError",
    "UnprocessableEntityError",
    "RateLimitError",
    "InternalServerError",
    "LengthFinishReasonError",
    "ContentFilterFinishReasonError",
    "TimeoutError",
    "ConnectionError",
    "OSError",
    "RuntimeError",
    "ValueError",
    "TypeError",
)
ERROR_OTHER = "other"

#: Shapes, applied with `fullmatch` only.
_MODEL_SHAPE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}")
_PROVIDER_SHAPE = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")
_API_MODE_SHAPE = re.compile(r"[a-z][a-z0-9_]{0,63}")
#: agentvillage-data's `GENERATION_ID_PATTERN` (src/schemas/llm-call.ts).
_GENERATION_ID_SHAPE = re.compile(r"gen-[0-9A-Za-z-]{1,124}")
#: data's `LLM_CALL_COST_USD_MAX`.
COST_USD_MAX = 100.0
TOKENS_MAX = 9_007_199_254_740_991

_MARK = "__av_negotiator_llm__"
_TOKEN = object()

# --------------------------------------------------------------------------
# Switches
# --------------------------------------------------------------------------


def flag_on() -> bool:
    """`AV_EVENTS_NEGOTIATOR_LLM`: `_core.env_flag_on`, as every av-events on-switch. Default off."""
    return env_flag_on(FLAG)


_SCOPE_LOCK = threading.Lock()
#: How many reads found the scope variable set to something unrecognised (this process).
SCOPE_UNRECOGNISED = [0]


def scope() -> str:
    """`AV_EVENTS_NEGOTIATOR_LLM_SCOPE`, `AV_EVENTS_CODE_RUN_SCOPE`'s semantics on a sibling
    variable: unset or blank `all` (spend is an ops question, the lead's code.run default); exactly
    `all` or `research_consented` itself; any other set value fails NARROW to `research_consented`,
    with one WARNING per process naming the variable and a count, never its value."""
    value = env(SCOPE_ENV).strip()
    if not value:
        return SCOPE_ALL
    if value in SCOPES:
        return value
    with _SCOPE_LOCK:
        SCOPE_UNRECOGNISED[0] += 1
        first = SCOPE_UNRECOGNISED[0] == 1
    if first:
        logger.warning("av-events: %s unrecognised=1, read as %s", SCOPE_ENV, SCOPE_RESEARCH)
    return SCOPE_RESEARCH


# --------------------------------------------------------------------------
# The payload (pure)
# --------------------------------------------------------------------------


def _shaped(value: Any, shape: "re.Pattern[str]") -> Optional[str]:
    return value if isinstance(value, str) and shape.fullmatch(value) else None


def _count(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return 0
    if isinstance(value, float) and not math.isfinite(value):
        return 0
    return max(0, min(int(value), TOKENS_MAX))


def _first(*values: Any) -> Any:
    return next((v for v in values if v not in (None, 0)), 0)


def _buckets(usage: Any, provider: Optional[str], api_mode: Optional[str]) -> dict:
    """The five buckets as `post_api_request` reports them: Hermes's own `normalize_usage`
    (`agent/usage_pricing.py`) when it imports, else the Chat Completions shape read here."""
    if not usage:
        return dict.fromkeys(("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                              "reasoning_tokens"), 0)
    try:
        from agent.usage_pricing import normalize_usage  # Hermes, already loaded in the gateway

        cu = normalize_usage(usage, provider=provider, api_mode=api_mode)
        return {
            "input_tokens": _count(cu.input_tokens),
            "output_tokens": _count(cu.output_tokens),
            "cache_read_tokens": _count(cu.cache_read_tokens),
            "cache_write_tokens": _count(cu.cache_write_tokens),
            "reasoning_tokens": _count(cu.reasoning_tokens),
        }
    except Exception:  # noqa: BLE001 - not under Hermes, or its shape moved: read the chat shape
        pass
    prompt_details = getattr(usage, "prompt_tokens_details", None)
    completion_details = getattr(usage, "completion_tokens_details", None)
    prompt_total = _count(getattr(usage, "prompt_tokens", None))
    cache_read = _count(getattr(prompt_details, "cached_tokens", None))
    cache_write = _count(_first(getattr(prompt_details, "cache_write_tokens", None),
                                getattr(usage, "cache_creation_input_tokens", None)))
    return {
        "input_tokens": max(0, prompt_total - cache_read - cache_write),
        "output_tokens": _count(getattr(usage, "completion_tokens", None)),
        "cache_read_tokens": cache_read,
        "cache_write_tokens": cache_write,
        "reasoning_tokens": _count(getattr(completion_details, "reasoning_tokens", None)),
    }


def _cost(usage: Any) -> Optional[float]:
    """OpenRouter's `usage.cost` (USD) when the response carries it: finite, 0..100, else null."""
    value = getattr(usage, "cost", None) if usage is not None else None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    value = float(value)
    return value if math.isfinite(value) and 0.0 <= value <= COST_USD_MAX else None


def _finish_reason(response: Any) -> Optional[str]:
    choices = getattr(response, "choices", None)
    if not isinstance(choices, (list, tuple)) or not choices:
        return None
    reason = getattr(choices[0], "finish_reason", None)
    if reason is None:
        return None
    return reason if isinstance(reason, str) and reason in FINISH_REASONS else FINISH_OTHER


def _assistant_counts(response: Any) -> tuple[int, int]:
    """(`assistant_content_chars`, `assistant_tool_call_count`) as Hermes computes them for
    `post_api_request` (`len(content or "")`, `len(tool_calls or [])`). Lengths only."""
    choices = getattr(response, "choices", None)
    if not isinstance(choices, (list, tuple)) or not choices:
        return 0, 0
    message = getattr(choices[0], "message", None)
    content = getattr(message, "content", None)
    tool_calls = getattr(message, "tool_calls", None)
    return (len(content) if isinstance(content, str) else 0,
            len(tool_calls) if isinstance(tool_calls, (list, tuple)) else 0)


def _error_type(error: BaseException) -> str:
    name = type(error).__name__
    return name if name in ERROR_TYPES else ERROR_OTHER


def _status_code(error: BaseException) -> Optional[int]:
    value = getattr(error, "status_code", None)
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value if 100 <= value <= 599 else None


def _length(value: Any) -> Optional[int]:
    return len(value) if isinstance(value, (list, tuple)) else None


def negotiator_llm_payload(
    *,
    model: Any,
    provider: Any,
    api_mode: Any,
    request: dict,
    response: Any = None,
    error: Optional[BaseException] = None,
    latency_ms: Optional[int],
    capture: str,
    consent_scope: str,
    key_source: str = KEY_TENANT,
) -> dict:
    """The `llm.call` payload for one negotiator step. `request` is the `create` keyword arguments;
    only `len(messages)` and `len(tools)` are read from it, never a message or a tool."""
    tools = request.get("tools")
    payload: dict[str, Any] = {
        "model": _shaped(model, _MODEL_SHAPE),
        "provider": _shaped(provider, _PROVIDER_SHAPE),
    }
    if error is None:
        usage = getattr(response, "usage", None)
        payload.update(_buckets(usage, payload["provider"], _shaped(api_mode, _API_MODE_SHAPE)))
    else:
        usage = None
        payload.update(dict.fromkeys(("input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
                                      "reasoning_tokens"), 0))
    payload.update({
        "latency_ms": latency_ms,
        "finish_reason": FINISH_ERROR if error is not None else _finish_reason(response),
        # Not computed: the negotiator's system message embeds the resident's intent, and these are unkeyed.
        "tools_hash": None,
        "system_prompt_hash": None,
        "api_mode": _shaped(api_mode, _API_MODE_SHAPE),
        "response_model": _shaped(getattr(response, "model", None), _MODEL_SHAPE) if error is None else None,
        "tool_count": _length(tools) if tools is not None else 0,
        "message_count": _length(request.get("messages")),
        "cost_usd": _cost(usage),
        "generation_id": _shaped(getattr(response, "id", None), _GENERATION_ID_SHAPE) if error is None else None,
        "error_type": _error_type(error) if error is not None else None,
        "status_code": _status_code(error) if error is not None else None,
        "caller": CALLER,
        # Whose OpenRouter key paid: the MoralMod key (`AV_MORALMOD_OWN_KEY`) or the tenant's own.
        "key_source": key_source if key_source in KEY_SOURCES else KEY_TENANT,
        "consent_scope": consent_scope if consent_scope in SCOPES else SCOPE_RESEARCH,
    })
    if capture != "metadata":
        # Lengths, never bodies, exactly as `llm.call` sends them above `metadata`.
        chars, calls = _assistant_counts(response) if error is None else (0, 0)
        payload["assistant_content_chars"] = chars
        payload["assistant_tool_call_count"] = calls
    return payload


# --------------------------------------------------------------------------
# The wrap
# --------------------------------------------------------------------------


class _State:
    """This module's install: the collector accessor, the `_quiet` isolator, the poller."""

    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.collector_ref: Optional[Callable[[], Any]] = None
        self.quiet: Optional[Callable[..., None]] = None
        self.package: str = f"{NS_PARENT}.{OWN_SLUG}"
        self.stop = threading.Event()
        self.poller: Optional[threading.Thread] = None
        self.wrapped_completions: "weakref.WeakSet[Any]" = weakref.WeakSet()
        self.speakers: "weakref.WeakSet[Any]" = weakref.WeakSet()
        self.keyed_agents: "weakref.WeakSet[Any]" = weakref.WeakSet()
        self.no_seam_seen: set = set()


_STATE = _State()


def _collector() -> Any:
    ref = _STATE.collector_ref
    return ref() if ref is not None else None


def _isolated(counter: str, fn: Callable, *args: Any) -> None:
    """`_quiet` (`__init__.py`): a failure bumps `counter`, never the session breaker."""
    collector = _collector()
    quiet = _STATE.quiet
    if collector is None or quiet is None:
        return
    quiet(collector, counter, fn, *args)


def _count_once(counter: str, key: Any) -> None:
    with _STATE.lock:
        if key in _STATE.no_seam_seen:
            return
        _STATE.no_seam_seen.add(key)
    collector = _collector()
    if collector is not None:
        try:
            collector.count(counter)
        except Exception:  # noqa: BLE001 - a counter must not raise
            pass


def _observe(provider: Any, api_mode: Any, key_source: str, kwargs: dict, response: Any,
             error: Optional[BaseException], started: float, elapsed_s: float) -> None:
    """Build and buffer one `llm.call`. Runs inside `_quiet`, after the step has its result."""
    collector = _collector()
    if collector is None or not flag_on():
        return
    try:
        collector.begin(None)  # the kill switches' TTL re-read, as `guarded` does for a hook
    except Exception:  # noqa: BLE001
        pass
    if not collector.hook_allowed(HOOK_NAME, None) or not collector.config.active:
        return
    model = kwargs.get("model")
    payload = negotiator_llm_payload(
        model=model,
        provider=provider,
        api_mode=api_mode,
        request=kwargs,
        response=response,
        error=error,
        latency_ms=max(0, int(elapsed_s * 1000)),
        capture=collector.config.capture,
        consent_scope=scope(),
        key_source=key_source,
    )
    occurred_at = iso_from_epoch(started)
    collector.emit(
        TYPE,
        payload,
        occurred_at=occurred_at,
        occurred_at_earliest=occurred_at,
        occurred_at_latest=iso_from_epoch(started + elapsed_s),
        model_id=payload["model"],
        # The bridge has no Hermes session, turn or run: all three stay null (see the module docstring).
        session_id=None,
        turn_id=None,
        run_id=None,
    )


def _wrap_create(original: Callable, provider: Any, api_mode: Any, key_source: str,
                 restore_by_delete: bool) -> Callable:
    @functools.wraps(original)
    def create(*args: Any, **kwargs: Any) -> Any:
        started = time.time()
        clock = time.perf_counter()
        try:
            response = original(*args, **kwargs)
        except BaseException as error:
            if isinstance(error, Exception):
                _isolated(FAILED, _observe, provider, api_mode, key_source, kwargs, None, error, started,
                          time.perf_counter() - clock)
            raise
        _isolated(FAILED, _observe, provider, api_mode, key_source, kwargs, response, None, started,
                  time.perf_counter() - clock)
        return response

    setattr(create, _MARK, _TOKEN)
    create.av_restore_by_delete = restore_by_delete  # type: ignore[attr-defined]
    return create


def _is_openai_client(client: Any) -> bool:
    return str(getattr(type(client), "__module__", "") or "").split(".", 1)[0] == "openai"


def _wrap_completions_of(client: Any, provider: Any, api_mode: Any) -> None:
    """Wrap `client.chat.completions.create` once (an instance attribute on that one object)."""
    if client is None:
        return
    if not _is_openai_client(client):
        _count_once(CLIENT_UNSUPPORTED, ("client", type(client)))
        return
    completions = getattr(getattr(client, "chat", None), "completions", None)
    current = getattr(completions, "create", None)
    if completions is None or not callable(current):
        _count_once(CLIENT_UNSUPPORTED, ("create", type(client)))
        return
    with _STATE.lock:
        current = getattr(completions, "create", None)
        mark = getattr(current, _MARK, None)
        if mark is _TOKEN:
            return
        # A reloaded av-events re-wraps the SDK's method, never its predecessor's wrapper.
        original = getattr(current, "__wrapped__", None) if mark is not None else current
        if not callable(original):
            _count_once(CLIENT_UNSUPPORTED, ("create", type(client)))
            return
        restore_by_delete = (
            getattr(current, "av_restore_by_delete", True) if mark is not None
            else "create" not in getattr(completions, "__dict__", {})
        )
        key_source = KEY_MORALMOD if getattr(client, _KEY_MARK, None) else KEY_TENANT
        wrapper = _wrap_create(original, provider, api_mode, key_source, restore_by_delete)
        setattr(completions, "create", wrapper)
        if getattr(completions, "create", None) is not wrapper:
            # A property or a fresh object per access: the wrap would not hold.
            _count_once(CLIENT_UNSUPPORTED, ("hold", type(client)))
            return
        try:
            _STATE.wrapped_completions.add(completions)
        except TypeError:
            pass


def _wrap_client(agent: Any) -> None:
    """Wrap `agent.client.chat.completions.create` once. Flag off: nothing (a live kill switch:
    an already-wrapped client then passes straight through `_observe`'s flag check)."""
    if not flag_on():
        return
    _wrap_completions_of(getattr(agent, "client", None), getattr(agent, "provider", None),
                         getattr(agent, "api_mode", None))


# --------------------------------------------------------------------------
# The MoralMod key
# --------------------------------------------------------------------------


class MoralmodKeyUnavailable(RuntimeError):
    """`AV_MORALMOD_OWN_KEY` is on and the bridge's client could not be put on the MoralMod key.

    Raised from the `_main_agent` wrapper, inside `speaker.complete`, so the step fails the way
    the bridge already fails a step it cannot run (`_main_agent` raising "Hermes has no gateway
    model configured."): `bridge.py` answers 502 with this text, which names no key. Never the
    tenant's key instead (Carter, CLAIMS L13060)."""


KEY_UNAVAILABLE_TEXT = "The MoralMod key is not available for this step."

#: Serialises the key switch, so two first steps build one client between them.
_KEY_LOCK = threading.Lock()


def own_key_on() -> bool:
    """`AV_MORALMOD_OWN_KEY`: `_core.env_flag_on`, default off."""
    return env_flag_on(OWN_KEY_FLAG)


def _own_key() -> Optional[str]:
    """`MORALMOD_LLM_API_KEY` (process environment, then `$HERMES_HOME/.env`, as every av-events
    variable), when it is an OpenRouter key. Registered with the sanitiser; never logged."""
    value = env(OWN_KEY_ENV).strip()
    if not value or not _OWN_KEY_SHAPE.fullmatch(value):
        return None
    register_literal_secret(value)
    return value


def register_key_at_load() -> None:
    """Plugin load: register a MoralMod key that is present with the sanitiser now, whatever the
    switches say, so no event can carry it even before the first bridge step. Never raises."""
    try:
        _own_key()
    except Exception:  # noqa: BLE001 - a broken .env never stops the load
        pass


def _base_url_ok(base_url: Any) -> bool:
    """`https://openrouter.ai` or a subdomain of it, nothing else (never plain http)."""
    try:
        parsed = urlparse(str(base_url or ""))
        host = (parsed.hostname or "").lower()
    except ValueError:
        return False
    return parsed.scheme == "https" and (host == OPENROUTER_HOST or host.endswith("." + OPENROUTER_HOST))


def _headers_carry_auth(kwargs: dict) -> bool:
    """A custom `Authorization` (or `X-Api-Key`) header would beat the swapped key in the SDK."""
    headers = kwargs.get("default_headers")
    if not isinstance(headers, dict):
        return False
    return any(str(name).strip().lower() in ("authorization", "x-api-key") for name in headers)


def _bump(counter: str) -> None:
    collector = _collector()
    if collector is not None:
        try:
            collector.count(counter)
        except Exception:  # noqa: BLE001 - a counter must not raise
            pass


def _apply_own_key(agent: Any) -> Optional[str]:
    """Put the bridge's dedicated agent on the MoralMod key. None when it is on it now, else the
    counter that says why not (the caller fails the step).

    A client from Hermes's own factory (`agent._create_openai_client`, the path every primary
    client takes) on a copy of the agent's own client kwargs with `api_key` replaced: same base
    URL, headers, timeout, model and provider; built once per key (a sha256 fingerprint on the
    client, never the key). The agent's `_client_kwargs`, `api_key` and the tenant's client object
    are left as they are; the tenant client is kept on the new one, so switching off puts it back.
    With metering on, the new client is wrapped before any step can see it."""
    with _KEY_LOCK:
        client = getattr(agent, "client", None)
        if client is None:
            return KEY_FAILED
        fingerprint = getattr(client, _KEY_MARK, None)
        tenant_client = getattr(client, _TENANT_CLIENT, None) if fingerprint else client
        key = _own_key()
        if key is None:
            return KEY_MISSING
        digest = hashlib.sha256(key.encode("utf-8")).hexdigest()
        if fingerprint == digest:
            return None
        kwargs = getattr(agent, "_client_kwargs", None)
        factory = getattr(agent, "_create_openai_client", None)
        if (
            not isinstance(kwargs, dict)
            or not callable(factory)
            or not _is_openai_client(tenant_client)
            or not _base_url_ok(kwargs.get("base_url") or getattr(agent, "base_url", None))
            or _headers_carry_auth(kwargs)
        ):
            return KEY_UNSUPPORTED
        fresh = factory(dict(kwargs, api_key=key), reason="av_moralmod_own_key", shared=True)
        if not _is_openai_client(fresh) or getattr(fresh, "api_key", None) != key:
            return KEY_UNSUPPORTED
        setattr(fresh, _KEY_MARK, digest)
        setattr(fresh, _TENANT_CLIENT, tenant_client)
        if flag_on():
            _isolated(FAILED, _wrap_completions_of, fresh, getattr(agent, "provider", None),
                      getattr(agent, "api_mode", None))
        agent.client = fresh
        try:
            _STATE.keyed_agents.add(agent)
        except TypeError:
            pass
        return None


def _require_own_key(agent: Any) -> None:
    """Switch on: the step runs on the MoralMod key or fails. Missing or off its shape:
    `moralmod_key_missing`; anything else (not OpenRouter over https, a header that would beat the
    key, no factory, the factory raising or returning something else): `moralmod_key_failed`
    (and `moralmod_key_unsupported` for the shapes this module refuses). Never the tenant's key."""
    try:
        reason = _apply_own_key(agent)
    except Exception:  # noqa: BLE001 - counted, and the step fails below, outside this handler
        reason = KEY_FAILED
    if reason is None:
        return
    if reason == KEY_UNSUPPORTED:
        _bump(KEY_UNSUPPORTED)
        reason = KEY_FAILED
    _bump(reason)
    # Raised here, outside any handler, so the factory's exception (whose text could hold the key)
    # is never chained onto the step's.
    raise MoralmodKeyUnavailable(KEY_UNAVAILABLE_TEXT)


def _revert_key(agent: Any) -> None:
    """Switch off: a bridge agent on the MoralMod client gets its tenant client back."""
    client = getattr(agent, "client", None)
    tenant_client = getattr(client, _TENANT_CLIENT, None) if getattr(client, _KEY_MARK, None) else None
    if tenant_client is not None:
        with _KEY_LOCK:
            if getattr(agent, "client", None) is client:
                agent.client = tenant_client


def _own_key_switch() -> bool:
    try:
        return own_key_on()
    except Exception:  # noqa: BLE001 - an unreadable switch is today's behaviour
        return False


def _wrap_main_agent(original: Callable) -> Callable:
    @functools.wraps(original)
    def _main_agent(*args: Any, **kwargs: Any) -> Any:
        agent = original(*args, **kwargs)  # its result and its exceptions, unchanged
        if _own_key_switch():
            _require_own_key(agent)  # the MoralMod key, or the step fails
        else:
            _isolated(KEY_FAILED, _revert_key, agent)
        _isolated(FAILED, _wrap_client, agent)
        return agent

    setattr(_main_agent, _MARK, _TOKEN)
    return _main_agent


# --------------------------------------------------------------------------
# Finding the Index plugin of THIS home
# --------------------------------------------------------------------------

#: Hermes's names for the Index plugin's speaker: bare for the first home that claims the slug,
#: `__home_<digest>` for any other (`_directory_module_name`, plugins_loader.py:605-614). The name
#: alone does not say which home a module is, so the lookup compares where the plugin lives.
_SPEAKER_NAME = re.compile(rf"{NS_PARENT}\.{INDEX_SLUG}(?:__home_[0-9a-f]{{12}})?\.{SPEAKER}")


def _plugins_root(path: Any) -> Optional[str]:
    """`<home>/plugins` for a file at `<home>/plugins/<plugin>/<file>.py`, resolved."""
    if not isinstance(path, str) or not path:
        return None
    try:
        return os.path.realpath(os.path.dirname(os.path.dirname(os.path.abspath(path))))
    except (OSError, ValueError):
        return None


def own_plugins_root() -> Optional[str]:
    """Where this av-events is installed (`$HERMES_HOME/plugins`, install.ts). Not `$HERMES_HOME`
    from the environment: in a multi-home gateway that is one value for every home."""
    return _plugins_root(__file__)


def find_speaker() -> Any:
    """The loaded Index plugin speaker of this av-events' own home, or None. A speaker module
    whose plugin directory is not beside this av-events (another home's, or one without a
    `__file__`, which cannot be proven ours) is never wrapped: counted once per module as
    `negotiator_llm_foreign_home`."""
    own = own_plugins_root()
    found = None
    for name, module in list(sys.modules.items()):
        if module is None or not _SPEAKER_NAME.fullmatch(name):
            continue
        root = _plugins_root(getattr(module, "__file__", None))
        if own is not None and root == own:
            found = found or module
        else:
            _count_once(FOREIGN_HOME, ("foreign", id(module)))
    return found


def install() -> bool:
    """Wrap this home's loaded Index plugin `speaker._main_agent`. True when it is wrapped now.
    Absent (not loaded yet, or not on this box) is False and uncounted; a speaker without
    `_main_agent` and `complete` (the plugin revision moved) is False and counted once per
    module. Never imports."""
    if not (flag_on() or own_key_on()) or _STATE.collector_ref is None:
        return False
    module = find_speaker()
    if module is None:
        return False
    if not all(callable(getattr(module, name, None)) for name in REQUIRED):
        _count_once(NO_SEAM, ("speaker", id(module)))
        return False
    with _STATE.lock:
        current = getattr(module, WRAPPED_NAME)
        mark = getattr(current, _MARK, None)
        if mark is _TOKEN:
            return True
        original = getattr(current, "__wrapped__", None) if mark is not None else current
        if not callable(original):
            _count_once(NO_SEAM, ("speaker", id(module)))
            return False
        setattr(module, WRAPPED_NAME, _wrap_main_agent(original))
        try:
            _STATE.speakers.add(module)
        except TypeError:
            pass
    logger.info("av-events: negotiator_llm installed")
    return True


def _poll(stop_event: threading.Event) -> None:
    passes = 0
    while not stop_event.wait(FAST_S if passes < FAST_TRIES else SLOW_S):
        passes += 1
        try:
            install()
        except Exception:  # noqa: BLE001 - the poller never dies, never raises
            pass


def start(collector_ref: Callable[[], Any], package: str, quiet: Callable[..., None]) -> bool:
    """`register()`. The MoralMod key, when present, is registered with the sanitiser first,
    whatever the switches say. Then off unless `AV_EVENTS_NEGOTIATOR_LLM` or `AV_MORALMOD_OWN_KEY`
    is on now: a switch armed later takes a gateway restart (the control plane restarts the gateway
    when it writes the key). On: try once, then a daemon poller finds the Index plugin when it
    loads after av-events. Idempotent."""
    register_key_at_load()
    if not (flag_on() or own_key_on()):
        return False
    with _STATE.lock:
        _STATE.collector_ref = collector_ref
        _STATE.quiet = quiet
        _STATE.package = package or _STATE.package
        try:
            install()
        except Exception:  # noqa: BLE001
            pass
        if _STATE.poller is None or not _STATE.poller.is_alive():
            _STATE.stop = threading.Event()
            poller = threading.Thread(target=_poll, args=(_STATE.stop,), name="av-events-negotiator-llm", daemon=True)
            _STATE.poller = poller
            poller.start()
    return True


def stop() -> None:
    """Plugin unload: stop the poller, put the plugin's function and each client's method back.
    The bridge agent's tenant client goes back only when the key switch is off: with it on, the
    agent keeps its MoralMod client (never the tenant's key), and a reloaded av-events adopts it
    (same fingerprint). Only ever removes this module's wrappers. Never raises."""
    try:
        with _STATE.lock:
            _STATE.stop.set()
            _STATE.poller = None
            for module in list(_STATE.speakers):
                current = getattr(module, WRAPPED_NAME, None)
                if getattr(current, _MARK, None) is _TOKEN:
                    setattr(module, WRAPPED_NAME, current.__wrapped__)
            _STATE.speakers = weakref.WeakSet()
            if not _own_key_switch():
                for keyed in list(_STATE.keyed_agents):
                    _revert_key(keyed)
            _STATE.keyed_agents = weakref.WeakSet()
            for completions in list(_STATE.wrapped_completions):
                current = getattr(completions, "create", None)
                if getattr(current, _MARK, None) is not _TOKEN:
                    continue
                if getattr(current, "av_restore_by_delete", True):
                    try:
                        delattr(completions, "create")
                        continue
                    except AttributeError:
                        pass
                setattr(completions, "create", current.__wrapped__)
            _STATE.wrapped_completions = weakref.WeakSet()
            _STATE.collector_ref = None
            _STATE.quiet = None
            _STATE.no_seam_seen = set()
    except Exception:  # noqa: BLE001 - an unload never fails on us
        pass


__all__ = [
    "CALLER",
    "FLAG",
    "HOOK_NAME",
    "KEYS",
    "ABOVE_METADATA",
    "SCOPE_ENV",
    "TYPE",
    "MoralmodKeyUnavailable",
    "flag_on",
    "own_key_on",
    "OWN_KEY_FLAG",
    "OWN_KEY_ENV",
    "KEY_SOURCES",
    "find_speaker",
    "install",
    "negotiator_llm_payload",
    "own_plugins_root",
    "register_key_at_load",
    "scope",
    "start",
    "stop",
]
