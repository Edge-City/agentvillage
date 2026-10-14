"""SEC-6 half 2: the model observer (av-approval 0.5.0). OBSERVE ONLY: it never blocks or rewrites a request.

What it reports is the model id a box actually uses, nothing else (SEC-6 model observer design §1-§3):

- `source=request`: Hermes's `pre_api_request` hook (agent/turn_api_request.py `_fire_pre_api_request_hook`,
  v2026.9.24). It fires AFTER any `llm_request` middleware, so `request["body"]["model"]` is the id on the wire;
  the `model` kwarg (`agent.model`) is read only when the body has none (a body too large for the hook payload
  arrives truncated, without `body`). First sight per distinct id per process: a bounded set of 256 ids, the
  oldest dropped first. The callback is a dict read, a length check, one `re.fullmatch`, one set lookup under
  one short lock, and returns None; only a first sight emits and logs. Every path is in try/except: one DEBUG
  line per error type, never raised, never per request at INFO.
- `source=config_default`: config.yaml `model.default` (or a bare `model` string), read from the dict the SEC-3
  tick already parsed (`_plugins._pass` calls `on_tick(config)`: no second parse, no state.db read). Sent at its
  first sight, on any change (of the id or of the local list), and every 24 h unchanged (`trigger=daily`, the
  heartbeat data's silence rule waits for).

Every observation is `model.observed`; when the LOCAL list (`av_approval.model_allow`) exists and the id is not
on it, `model.offlist` goes next to it with the same fields. The local verdict only picks the log word and
whether `model.offlist` is sent: the box is agent-writable, so the alert is decided by data (DATA-477) against
the control plane's list, and `allowlist_version` (sha256[:12] over the sorted, comma-joined valid ids) shows a
tampered list (design §2).

Payload: exactly the fields of the `model_events` section of
`plugins/av-events/tests/vectors/plugin_events_contract.json`, in its order (`tests/test_model_observer.py` pins
this module to the file). A fresh dict per emit; `model` is null when it is not a string, is longer than 100
characters, misses the cp's `MODEL_ID` (never lower-cased), or is a string av-events' credential `sanitize`
would rewrite (`_SECRET_PATTERNS`, copied from `plugins/av-events/_core.py` and pinned to it by a test).
No prompt text, no session id, no URL, no provider, no key. av-events decides whether anything leaves the box
(`AV_MODEL_EVENTS`).

Log (the one new class): `av-approval: model: <id> (<source>, <on-list|off-list|no-list>)`, INFO, WARNING when
off-list; at a first sight and the daily heartbeat only. `<id>` is printed only when it passed the checks above,
else `invalid`. A local list with entries dropped is logged once: `av-approval: model: av_approval.model_allow:
<n> entries dropped (invalid or past the 64-id cap)`.

Restart: the first-sight set and the 24 h timer live in this process only (no disk state). Every gateway boot
therefore sends `model.observed` `source=config_default, trigger=first_sight` from the boot pass (and
`source=request, trigger=first_sight` at the first request); `trigger=daily` rows come only from a gateway up for
more than 24 h. data's silence rule counts boot rows as heartbeats (data#539): that is the contract.

Mode `av_approval.model_observer: on|off` (default on; a bare YAML `off` reads as false, taken as off): off at
register subscribes nothing and logs nothing; off at a tick silences both halves until it is on again (the
request half resumes only if it was subscribed at register). Gateway process only (`_plugins.gateway_process`).
"""

from __future__ import annotations

import hashlib
import logging
import re
import threading
import time
from collections import OrderedDict
from typing import Any, Mapping, Optional

from . import _plugins

logger = logging.getLogger("av-approval.models")

HOOK = "pre_api_request"
OBSERVED = "model.observed"
OFFLIST = "model.offlist"
MODEL_FIELDS = ("model", "source", "trigger", "off_list_local", "allowlist_version", "hermes_version", "ts")
SOURCES = ("request", "config_default", "session_override")
TRIGGERS = ("first_sight", "daily")
#: The cp's MODEL_ID = agentvillage-data's AGENT_MODEL_ID_PATTERN; the length is checked first.
MODEL_ID = r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:-]*$"
MODEL_MAX = 100
VERSION_RE = r"^[0-9a-f]{12}$"
SEEN_MAX = 256
#: install/config.ts FALLBACK_MODEL (pinned by a test): always on the box list, as the installer writes it.
FALLBACK_MODEL = "openai/gpt-6-luna"
#: data#539 N7: at most this many valid ids besides FALLBACK_MODEL (data accepts the union, 65).
ALLOW_MAX = 64
DAILY_S = 24 * 60 * 60

#: av-events `_core._SECRET_PATTERNS`, character for character: a model id one of these finds is nulled here,
#: as av-events nulls it, so both sides agree on what leaves the box (ov#333 refute N3).
_SECRET_PATTERNS = (
    ("anthropic_key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}")),
    ("openrouter_key", re.compile(r"sk-or-(?:v\d+-)?[A-Za-z0-9_\-]{16,}")),
    ("openai_key", re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{16,}")),
    ("telegram_bot_token", re.compile(r"\b\d{6,12}:[A-Za-z0-9_\-]{30,}")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}")),
)

LINE_FMT = "av-approval: model: {id} ({source}, {verdict})"
ALLOW_DROPPED_FMT = "av-approval: model: av_approval.model_allow: {n} entries dropped (invalid or past the 64-id cap)"
ERROR_FMT = "av-approval: model: observer error ({kind})"

_MODEL = re.compile(MODEL_ID)
_ANCHOR = logging.getLogger("av-approval")
_STATE_ATTR = "_av_approval_models"
_LOGGED_ATTR = "_av_approval_models_logged"
_UNSET = object()


# ---------------------------------------------------------------------------
# Pure: the id, the list, the mode, the payload
# ---------------------------------------------------------------------------

def secret_shaped(value: str) -> bool:
    return any(pattern.search(value) for _label, pattern in _SECRET_PATTERNS)


def shape_model(value: Any) -> Optional[str]:
    """The id as sent, or None: a non-string, over 100 characters, not MODEL_ID, or credential-shaped."""
    if type(value) is not str or len(value) > MODEL_MAX or not _MODEL.fullmatch(value) or secret_shaped(value):
        return None
    return value


def wire_model(request: Any, model: Any) -> Any:
    """`request["body"]["model"]` (the id after middleware), else the `model` kwarg. Plain dicts only."""
    if type(request) is dict:
        body = request.get("body")
        if type(body) is dict:
            value = body.get("model")
            if value is not None:
                return value
    return model


def model_default(config: Any) -> Any:
    """config.yaml's `model.default`, or `model` itself when it is a bare string."""
    if not isinstance(config, dict):
        return None
    model = config.get("model")
    return model.get("default") if isinstance(model, dict) else model


def _block(config: Any) -> Any:
    return config.get("av_approval") if isinstance(config, dict) else None


def parse_mode(config: Any) -> str:
    block = _block(config)
    value = block.get("model_observer") if isinstance(block, dict) else None
    if value is False or (isinstance(value, str) and value.strip().lower() == "off"):
        return "off"
    return "on"


def allowlist_version(ids: Any) -> str:
    """data's recipe byte for byte (data#539 `model-allowlist-version.v1.json`): sha256 over the sorted, deduped,
    comma-joined ids, UTF-8, no trailing newline, first 12 lowercase hex."""
    return hashlib.sha256(",".join(sorted(set(ids))).encode("utf-8")).hexdigest()[:12]


def parse_allow(config: Any) -> tuple[Optional[frozenset], Optional[str], int]:
    """(ids, version, dropped count). An absent key (or no `av_approval` block) is NO list: (None, None, 0); a
    value that is not a list is no list too, counted as one dropped entry. Entries are kept only when they are
    strings of at most 100 characters matching MODEL_ID; duplicates count once; at most ALLOW_MAX (64) ids other
    than FALLBACK_MODEL are kept, in list order (the installer writes at most 64 of the cp's ids plus the fallback,
    so its list is never cut here). The ids are then the union with FALLBACK_MODEL (a hand-written list gets it
    too), and the version is data's over that union (data#539: up to 65 ids)."""
    block = _block(config)
    raw = block.get("model_allow") if isinstance(block, dict) else None
    if raw is None:
        return None, None, 0
    if not isinstance(raw, list):
        return None, None, 1
    valid = [v for v in raw if type(v) is str and len(v) <= MODEL_MAX and _MODEL.fullmatch(v)]
    others = list(dict.fromkeys(v for v in valid if v != FALLBACK_MODEL))
    ids = frozenset(others[:ALLOW_MAX]) | {FALLBACK_MODEL}
    dropped = (len(raw) - len(valid)) + max(len(others) - ALLOW_MAX, 0)
    return ids, allowlist_version(ids), dropped


def _bool(value: Any) -> Optional[bool]:
    return value if type(value) is bool else None


def _shape(regex: str, value: Any) -> Optional[str]:
    return value if type(value) is str and re.fullmatch(regex, value) else None


def serialize(values: Mapping[str, Any]) -> dict:
    """A FRESH dict with exactly the contract's fields, in its order (both types carry the same fields)."""
    return {
        "model": shape_model(values.get("model")),
        "source": values.get("source"),
        "trigger": values.get("trigger"),
        "off_list_local": _bool(values.get("off_list_local")),
        "allowlist_version": _shape(VERSION_RE, values.get("allowlist_version")),
        "hermes_version": _shape(_plugins.HERMES_VERSION_RE, values.get("hermes_version")),
        "ts": values.get("ts") if type(values.get("ts")) is int else int(time.time()),
    }


# ---------------------------------------------------------------------------
# Process state (on the `av-approval` logger, which outlives a module reload)
# ---------------------------------------------------------------------------

def _state() -> dict:
    state = getattr(_ANCHOR, _STATE_ATTR, None)
    if not isinstance(state, dict):
        state = {"lock": threading.Lock(), "seen": OrderedDict(), "list": (None, None), "on": False,
                 "started": False, "handle": None, "default_key": _UNSET, "daily_at": 0.0}
        setattr(_ANCHOR, _STATE_ATTR, state)
    return state


def _log(level: int, line: str) -> None:
    try:
        logger.log(level, line)
    except Exception:  # noqa: BLE001
        pass


def _log_once(key: str, line: str, level: int = logging.WARNING) -> None:
    logged = getattr(_ANCHOR, _LOGGED_ATTR, None)
    if not isinstance(logged, set):
        logged = set()
        setattr(_ANCHOR, _LOGGED_ATTR, logged)
    if key not in logged:
        logged.add(key)
        _log(level, line)


def _debug(exc: BaseException) -> None:
    try:
        kind = type(exc).__name__
        _log_once("error:" + kind, ERROR_FMT.format(kind=kind), logging.DEBUG)
    except Exception:  # noqa: BLE001
        pass


def _first_sight(state: dict, key: Any) -> bool:
    """True once per key per process; the set holds at most SEEN_MAX keys, the oldest dropped first."""
    with state["lock"]:
        seen = state["seen"]
        if key in seen:
            return False
        seen[key] = None
        while len(seen) > SEEN_MAX:
            seen.popitem(last=False)
        return True


def _refresh_list(state: dict, config: Any) -> None:
    ids, version, invalid = parse_allow(config)
    if invalid:
        _log_once(f"allow-dropped:{version}:{invalid}", ALLOW_DROPPED_FMT.format(n=invalid))
    with state["lock"]:
        if state["list"] != (ids, version):
            state["list"] = (ids, version)
            state["seen"].clear()  # a new list: every id is judged again


def _emit(state: dict, event: str, values: Mapping[str, Any]) -> None:
    try:
        state["ctx"].emit(event, serialize(values))
    except Exception as exc:  # noqa: BLE001 - a bus that cannot take it changes nothing here
        _debug(exc)


def _observe(state: dict, model: Optional[str], source: str, trigger: str, now: Optional[float] = None) -> None:
    ids, version = state["list"]
    off = None if ids is None else model not in ids
    values = {"model": model, "source": source, "trigger": trigger, "off_list_local": off,
              "allowlist_version": version, "hermes_version": state.get("hermes_version"),
              "ts": int(time.time() if now is None else now)}
    _emit(state, OBSERVED, values)
    if off is True:
        _emit(state, OFFLIST, values)
    verdict = "no-list" if off is None else ("off-list" if off else "on-list")
    _log(logging.WARNING if off else logging.INFO,
         LINE_FMT.format(id=model or "invalid", source=source, verdict=verdict))


# ---------------------------------------------------------------------------
# The two halves
# ---------------------------------------------------------------------------

def observe_request(model: Any, request: Any) -> None:
    state = _state()
    shaped = shape_model(wire_model(request, model))
    if _first_sight(state, shaped):
        _observe(state, shaped, "request", "first_sight")


def _on_pre_api_request(model: Any = None, request: Any = None, **_kwargs: Any) -> None:
    """The one `pre_api_request` callback: runs the current module's half (a reload swaps `hot`). Returns None."""
    try:
        state = getattr(_ANCHOR, _STATE_ATTR, None)
        if type(state) is dict and state.get("on") and state.get("started"):
            hot = state.get("hot")
            if hot is not None:
                hot(model, request)
    except Exception as exc:  # noqa: BLE001 - the turn must never see this plugin
        _debug(exc)
    return None


def on_tick(config: Any, now: Optional[float] = None) -> None:
    """From the SEC-3 pass (boot, loaded, tick), with the config dict it parsed (None when unreadable)."""
    try:
        state = _state()
        if not state.get("started"):
            return
        if parse_mode(config) == "off":
            state["on"] = False
            return
        state["on"] = True
        if not isinstance(config, dict):
            return  # unreadable this pass: nothing to read; a lasting gap shows as silence at data
        _refresh_list(state, config)
        now = time.time() if now is None else now
        model = shape_model(model_default(config))
        key = (model, state["list"][1])
        if state["default_key"] != key:
            trigger = "first_sight"
        elif now - state["daily_at"] >= DAILY_S:
            trigger = "daily"
        else:
            return
        state["default_key"], state["daily_at"] = key, now
        _observe(state, model, "config_default", trigger, now)
    except Exception as exc:  # noqa: BLE001
        _debug(exc)


def _subscribed(state: dict) -> bool:
    handle = state.get("handle")
    return handle is not None and getattr(handle, "active", True) is not False


def _on_unload() -> None:
    state = _state()
    with state["lock"]:
        handle, state["handle"], state["started"], state["on"] = state.get("handle"), None, False, False
    try:
        if handle is not None and hasattr(handle, "dispose"):
            handle.dispose()
    except Exception as exc:  # noqa: BLE001
        _debug(exc)


def start(ctx: Any) -> bool:
    """From `register()`: subscribe `pre_api_request` once per process (a re-register keeps the one subscription;
    an unload drops it). Gateway process only. Never raises; logs nothing."""
    try:
        if not _plugins.gateway_process():
            return False
        cfg, readable = _plugins.read_config(_plugins.hermes_home())
        cfg = cfg if readable else None
        state = _state()
        on = parse_mode(cfg) == "on"
        with state["lock"]:
            state.update(ctx=ctx, started=True, on=on, hot=observe_request, hermes_version=_plugins.hermes_version())
        if not on:
            return False
        if cfg is not None:
            _refresh_list(state, cfg)
        if not _subscribed(state):
            state["handle"] = ctx.register_hook(HOOK, _on_pre_api_request) or True
            try:
                ctx.on_unload(_on_unload)
            except Exception:  # noqa: BLE001 - no unload hook: the subscription lasts the process
                pass
        return True
    except Exception as exc:  # noqa: BLE001 - must never break Hermes's plugin loading
        _debug(exc)
        return False


def _reset() -> None:
    """Tests: drop the subscription and every once-per-process mark."""
    for attr in (_STATE_ATTR, _LOGGED_ATTR):
        if hasattr(_ANCHOR, attr):
            delattr(_ANCHOR, attr)
