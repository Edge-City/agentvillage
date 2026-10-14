"""`pray`: the agent asks the village's god agents (Odin) for something it needs (PRAYER P3).

The design note is `lanes-float/PRAYER-design.md` §1 (the prayer object), §2
(this tool) and §7 P3. The tool sends one request to the control plane, and a
human admin reviews it there before anything changes. It never grants,
applies or emits anything itself.

**Switch.** Registered only when `AV_PRAY` is `1|true|yes|on` (`_core.TRUTHY`,
the `AV_RECORD_INTENTION` pattern). Unset means the tool is not registered at
all. The control plane's `writeIngestEnv` writes `AV_PRAY=1` only while its own
`PRAYERS_ENABLED=1`, so a box gets the tool at its next env write and gateway
restart. The handler re-reads the switch at every call and answers `disabled`
when it was turned off in the process environment since.

**Arguments.** `{ask: {kind, tier?, model?}, reason}`, a closed object. Before
anything is sent the tool checks what §1 says the control plane checks, so the
agent hears a refusal at once:
- `ask.kind` is `model_tier` or `other`. `ask.tier` is required with
  `model_tier` and absent otherwise, shape `^[a-z][a-z0-9-]{0,23}$`.
  `ask.model` is optional and only with `model_tier`, an OpenRouter id in the
  shape of the control plane's `cp-events.js` `MODEL_ID` (at most 100
  characters). A `null` or blank `tier`/`model` counts as absent. Whether the
  tier is configured, or the tenant is on it already, only the control plane
  knows (`tier_unknown`, `already_on_tier`).
- `reason`: NFC, then trimmed of ECMAScript whitespace (`String.prototype.trim`,
  so the control plane's JavaScript trims the same characters), then 1-600
  code points and at most 8 lines, with no C0 control but `\\n`, no DEL and no
  C1 control. An email address, a phone-like run of 9 or more digits, an
  `@handle` or a `t.me/` link is refused as `reason_contact`.
- Anything else (an unknown key, a wrong type, a bad kind, tier or model) is
  `invalid_body`.
The exact rules and their cases are the contract vector
`tests/vectors/prayer-contract.json`, which the control plane's P2 copies.

**Who may pray.** The resident's direct chat (recall's rule,
`plugins/recall/__init__.py` `DIRECT_CHAT_TYPES` and `SessionView.is_main`: a
one-to-one chat type, or an empty one on the owner's local surface) and the
agent's own scheduled runs (`record_intention`'s lineage rule: a `cron_`
session id or `platform=cron` anywhere up the delegation chain, plus Hermes's
`HERMES_CRON_SESSION=1`). Everything else, a group, a channel, a webhook or a
session whose kind cannot be read, is refused with `group_session` and nothing
is sent. The tool registers the lineage listeners itself, so the cron rule
works with `AV_RECORD_INTENTION` off. The kind travels as
`X-AV-Session-Kind: dm|cron`; it labels the prayer for the reviewer and is
not a credential.

**The wire.** `POST {CONTROL_PLANE_URL}/tenants/{tenant}/prayers` with
`Authorization: Bearer $AV_EVENTS_TOKEN`, the tenant being `AV_TENANT_ID`, else
`TENANT_ID` (a UUID, lower-cased). `CONTROL_PLANE_URL` must be an https origin;
plain http only to a loopback host (tests and local runs). No credentials,
query, fragment or path in it. The body is compact JSON (UTF-8 as is), at most
4 KiB: `{ask, reason, idempotency_key}`, the key a uuid4 minted per call.
Each attempt has a 10 s deadline (8 s per socket operation). Redirects are
refused, never followed, and proxy variables are ignored
(`_core.NO_REDIRECT_OPENER`), so the bearer reaches only the configured host.
A transport failure, an attempt past its deadline, a reply cut short or a 5xx
is retried once, with the same idempotency key, so the control plane answers
the retry with the stored outcome (§1 Idempotency). Nothing else is retried.

**The answer.** `{prayer_id, status, duplicate_open?, review, tell_resident}`
on a 2xx, else `{error, retry_after_s?, message}`. The control plane's codes
pass through (`invalid_body`, `tier_unknown`, `reason_contact`,
`reason_invalid`, `already_on_tier`, `idempotency_mismatch`, `not_live`,
`rate_limited`, `busy`, `unavailable`, `model_tier_config_invalid`). The tool's
own: `disabled`, `group_session`, `not_configured`, `not_enabled` (404: the
control plane has prayers off), `unauthorized` (401), `too_large` (413),
`redirect_refused`, `unreachable`, `bad_answer`, `http_<status>`, `internal`.

**Nothing private leaves.** The tool emits no event. `tool.call` keeps only a
hash of the arguments (`_tools.py`). Log lines carry codes and counts: never
the reason, the token or the tenant id.

Python 3.11, standard library only.
"""

from __future__ import annotations

import http.client
import json
import logging
import math
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.request
import uuid
from typing import Any, Callable, Optional

from . import _record_intention as _ri
from ._core import NO_REDIRECT_OPENER, env, env_flag_on, is_redirect, register_literal_secret

logger = logging.getLogger("av-events")

TOOL_NAME = "pray"
TOOLSET = "av-events"
SWITCH = "AV_PRAY"
URL_ENV = "CONTROL_PLANE_URL"
TOKEN_ENV = "AV_EVENTS_TOKEN"
PRAYERS_PATH = "/tenants/{tenant}/prayers"
SESSION_KIND_HEADER = "X-AV-Session-Kind"

#: Per attempt; each socket operation is bounded below it.
DEADLINE_S = 10.0
SOCKET_TIMEOUT_S = 8.0
#: One retry, after this pause, with the same idempotency key.
RETRY_PAUSE_S = 1.0
MAX_ATTEMPTS = 2
MAX_BODY_BYTES = 4096
MAX_ANSWER_BYTES = 16 * 1024
MAX_RETRY_AFTER_S = 86_400

ASK_KINDS = ("model_tier", "other")
ASK_KEYS = frozenset({"kind", "tier", "model"})
ARG_KEYS = frozenset({"ask", "reason"})
TIER = re.compile(r"[a-z][a-z0-9-]{0,23}")
#: `cp-events.js` `MODEL_ID` and `MODEL_ID_MAX`.
MODEL_ID = re.compile(r"[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:-]*")
MODEL_ID_MAX = 100
IDEMPOTENCY_KEY = re.compile(r"[0-9a-f-]{36}")
PRAYER_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TENANT = PRAYER_ID

REASON_MAX = 600
REASON_MAX_LINES = 8
#: ECMAScript's WhiteSpace and LineTerminator: what `String.prototype.trim` removes.
JS_TRIM = "\t\n\v\f\r                  　﻿"
#: C0 controls but `\n`, DEL and the C1 controls.
CONTROLS = re.compile(r"[\x00-\x09\x0b-\x1f\x7f-\x9f]")
#: §1's contact net. Cheap, not a guarantee: the reviewer's prompt treats the reason as untrusted.
CONTACT = (
    re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+"),  # an email address
    re.compile(r"\d(?:[ .()-]?\d){8,}"),  # a phone-like run: 9+ digits, one separator at most between two
    re.compile(r"@[A-Za-z0-9_]{2,}"),  # an @handle
    re.compile(r"t\.me/", re.IGNORECASE),  # a Telegram link
)

#: §3's answers the tool passes through, by status.
PASSED_CODES: dict[int, frozenset[str]] = {
    400: frozenset({"invalid_body", "tier_unknown", "reason_contact", "reason_invalid"}),
    409: frozenset({"already_on_tier", "idempotency_mismatch", "not_live"}),
    429: frozenset({"rate_limited", "busy"}),
    503: frozenset({"unavailable", "model_tier_config_invalid"}),
}
DEFAULT_CODES = {400: "invalid_body", 401: "unauthorized", 404: "not_enabled", 409: "conflict", 413: "too_large",
                 429: "rate_limited", 503: "unavailable"}
#: `tenant_prayers.status` (§3).
PRAYER_STATUSES = frozenset({"received", "approved", "denied", "applied", "apply_failed", "expired"})

REVIEW = "a village admin reviews every request; nothing changes until they approve"

#: §2, word for word.
TOOL_DESCRIPTION = (
    "Ask the village's god agents (Odin) for something your agent needs: today, a different model plan. "
    "A human admin reviews every request. Write the reason as a short summary of your resident's need, "
    "in your own words. Never include other people. Tell your resident you asked."
)

TOOL_SCHEMA: dict[str, Any] = {
    "name": TOOL_NAME,
    "description": TOOL_DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "ask": {
                "type": "object",
                "description": "What you ask for.",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": list(ASK_KINDS),
                        "description": "model_tier for a different model plan; other for anything else (a human handles it).",
                    },
                    "tier": {
                        "type": "string",
                        "maxLength": 24,
                        "description": "The plan you ask for, e.g. a lower-case name like 'pro'. Required with model_tier; omit it with other.",
                    },
                    "model": {
                        "type": "string",
                        "maxLength": MODEL_ID_MAX,
                        "description": "Optional, only with model_tier: one OpenRouter model id in that plan, e.g. 'anthropic/claude-sonnet-4.5'.",
                    },
                },
                "required": ["kind"],
                "additionalProperties": False,
            },
            "reason": {
                "type": "string",
                "maxLength": REASON_MAX,
                "description": (
                    "Why, in at most 600 characters and 8 lines: about your own resident's needs only; never name "
                    "or describe other people. No email addresses, phone numbers, @handles or t.me links."
                ),
            },
        },
        "required": ["ask", "reason"],
        "additionalProperties": False,
    },
}

#: What the agent is told for each code. Never the reason, never the token.
_TRY_LATER = "Tell your resident you could not ask right now; try again later."
MESSAGES: dict[str, str] = {
    "disabled": "Asking the god agents is switched off on this agent. Nothing was sent.",
    "group_session": (
        "Not sent: you can ask the god agents only in your private chat with your resident or in your own "
        "scheduled runs, never from a group."
    ),
    "invalid_body": (
        "Not sent: the request is malformed. ask.kind is model_tier (with ask.tier, and optionally ask.model) or "
        "other (with neither); reason is required."
    ),
    "reason_invalid": (
        "Not sent: the reason must be 1-600 characters and at most 8 lines, with no control characters."
    ),
    "reason_contact": (
        "Not sent: the reason holds contact details (an email, a phone number, an @handle or a t.me link). Write "
        "it again about your own resident's need only, with no one's contact details."
    ),
    "tier_unknown": "Not sent: that plan does not exist. Ask for a plan the village offers.",
    "already_on_tier": "Not sent: your agent is on that plan already.",
    "idempotency_mismatch": "Not sent: the request conflicted with an earlier one. Ask again as a new request.",
    "not_live": "Not sent: this agent is not live, so it cannot ask the god agents now.",
    "conflict": "Not sent: the control plane refused the request as a conflict. " + _TRY_LATER,
    "rate_limited": "Not sent: you have asked too often. Wait before asking again; do not retry now.",
    "busy": "Not sent: the god agents are busy. " + _TRY_LATER,
    "unavailable": "Not sent: the god agents cannot be reached right now. " + _TRY_LATER,
    "model_tier_config_invalid": "Not sent: the village's model plans are being reconfigured. " + _TRY_LATER,
    "not_configured": "Asking the god agents is not set up on this agent. Nothing was sent.",
    "not_enabled": "Asking the god agents is not open yet. Nothing was recorded.",
    "unauthorized": "Not sent: this agent's credentials were refused. Do not retry.",
    "too_large": "Not sent: the request is too large. Shorten the reason.",
    "redirect_refused": "Not sent: the control plane answered with a redirect, which is refused. " + _TRY_LATER,
    "unreachable": "Not sent: the control plane could not be reached. " + _TRY_LATER,
    "bad_answer": "Whether the request was recorded is unknown: the answer could not be read. " + _TRY_LATER,
    "internal": "Not sent: something went wrong in the tool. " + _TRY_LATER,
}


def switch_on() -> bool:
    return env_flag_on(SWITCH)


def _error(code: str, retry_after_s: Optional[int] = None) -> dict:
    out: dict[str, Any] = {"error": code}
    if retry_after_s is not None:
        out["retry_after_s"] = retry_after_s
    out["message"] = MESSAGES.get(code) or ("Not sent: the control plane refused the request (" + code + "). " + _TRY_LATER)
    return out


# ---- Validation (§1, client side) ------------------------------------------


def _absent(value: Any) -> bool:
    return value is None or (isinstance(value, str) and not value.strip())


def normalize_reason(raw: Any) -> tuple[Optional[str], Optional[str]]:
    """`(reason, None)` as it is sent, or `(None, code)`."""
    if not isinstance(raw, str):
        return None, "invalid_body"
    if any("\ud800" <= ch <= "\udfff" for ch in raw):  # a lone surrogate cannot be sent as UTF-8
        return None, "reason_invalid"
    text = unicodedata.normalize("NFC", raw).strip(JS_TRIM)
    if not 1 <= len(text) <= REASON_MAX:
        return None, "reason_invalid"
    if CONTROLS.search(text) or text.count("\n") + 1 > REASON_MAX_LINES:
        return None, "reason_invalid"
    if any(pattern.search(text) for pattern in CONTACT):
        return None, "reason_contact"
    return text, None


def validate(args: Any) -> tuple[Optional[dict], Optional[str]]:
    """`({ask, reason}, None)` ready to send, or `(None, code)`. The checks of §1 the box can make."""
    if not isinstance(args, dict) or set(args) - ARG_KEYS:
        return None, "invalid_body"
    raw_ask = args.get("ask")
    if not isinstance(raw_ask, dict) or set(raw_ask) - ASK_KEYS:
        return None, "invalid_body"
    kind = raw_ask.get("kind")
    if kind not in ASK_KINDS:
        return None, "invalid_body"
    ask: dict[str, str] = {"kind": kind}
    tier, model = raw_ask.get("tier"), raw_ask.get("model")
    if kind == "model_tier":
        if not isinstance(tier, str) or not TIER.fullmatch(tier):
            return None, "invalid_body"
        ask["tier"] = tier
        if not _absent(model):
            if not isinstance(model, str) or len(model) > MODEL_ID_MAX or not MODEL_ID.fullmatch(model):
                return None, "invalid_body"
            ask["model"] = model
    elif not _absent(tier) or not _absent(model):
        return None, "invalid_body"
    reason, code = normalize_reason(args.get("reason"))
    if code is not None:
        return None, code
    return {"ask": ask, "reason": reason}, None


def request_body(prayer: dict, idempotency_key: str) -> bytes:
    """The bytes sent: compact JSON, UTF-8 as is (a non-ASCII reason stays within 4 KiB)."""
    obj = {"ask": prayer["ask"], "reason": prayer["reason"], "idempotency_key": idempotency_key}
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


# ---- Who is speaking (§2 session rule) --------------------------------------

#: recall's `DIRECT_CHAT_TYPES` and `LOCAL_SURFACES` (plugins/recall/__init__.py).
DIRECT_CHAT_TYPES = frozenset({"dm", "private", "direct", "c2c"})
LOCAL_SURFACES = frozenset({"cli", "tui", "desktop", "local"})


def _session_module():
    try:
        from gateway import session_context as sc  # noqa: PLC0415 - absent outside Hermes
    except Exception:  # noqa: BLE001
        return None
    return sc


def _session_value(name: str) -> Optional[str]:
    """recall's reader: the task-local session value when bound (even ""), the
    process environment in a process that never bound a session (CLI), and None
    when this process binds sessions but this task has none (unknowable)."""
    sc = _session_module()
    if sc is None:
        return os.environ.get(name, "")
    try:
        var = sc._VAR_MAP.get(name)  # noqa: SLF001 - the bridge recall and tools/environments/local.py use
        if var is not None:
            value = var.get()
            if value is not sc._UNSET:  # noqa: SLF001
                return "" if value is None else str(value)
            if sc.session_context_engaged():
                return None
        return os.environ.get(name, "")
    except Exception:  # noqa: BLE001 - private API drifted; use the public reader
        try:
            return sc.get_session_env(name, "")
        except Exception:  # noqa: BLE001
            return None


def _engaged() -> bool:
    sc = _session_module()
    if sc is None:
        return False
    try:
        return bool(sc.session_context_engaged())
    except Exception:  # noqa: BLE001 - unknowable: assume a gateway
        return True


def _norm(value: Optional[str]) -> Optional[str]:
    return None if value is None else value.strip().lower()


def session_kind(session_id: Any) -> Optional[str]:
    """`cron`, `dm`, or None (refused: a group, a channel, anything else, or unknowable)."""
    sid = session_id.strip() if isinstance(session_id, str) else ""
    chat_type = _norm(_session_value("HERMES_SESSION_CHAT_TYPE"))
    cron_flag = _norm(_session_value("HERMES_CRON_SESSION"))
    raw_idents = [os.environ.get("HERMES_PLATFORM", ""), _session_value("HERMES_SESSION_PLATFORM"),
                  _session_value("HERMES_SESSION_SOURCE")]
    idents = [v for v in (_norm(i) for i in raw_idents) if v]
    bound_id = _session_value("HERMES_SESSION_ID") or ""
    try:
        lineage = _ri.held_reason(sid) if sid else None
    except Exception:  # noqa: BLE001 - unsure is not cron
        lineage = None
    if (lineage == "cron" or cron_flag == "1" or "cron" in idents
            or any(s.startswith("cron_") for s in (sid, bound_id))):
        return "cron"
    if chat_type is None or any(v is None for v in raw_idents):
        return None
    if chat_type in DIRECT_CHAT_TYPES:
        return "dm"
    if chat_type != "":
        return None
    if not idents:
        return None if _engaged() else "dm"
    return "dm" if all(ident in LOCAL_SURFACES for ident in idents) else None


# ---- The wire (§2) ----------------------------------------------------------

#: Tests replace these: the opener (anything with `.open(request, timeout=...)`),
#: how long the caller waits on an attempt, the pause before the retry, and the key.
_OPENER: Any = NO_REDIRECT_OPENER


def _join(worker: threading.Thread, deadline: float) -> None:
    worker.join(deadline)


_sleep: Callable[[float], None] = time.sleep
_new_key: Callable[[], str] = lambda: str(uuid.uuid4())  # noqa: E731


def endpoint() -> tuple[Optional[str], Optional[str], Optional[str]]:
    """`(url, token, None)`, or `(None, None, "not_configured")`."""
    origin = _ri._origin(env(URL_ENV).strip(), ("", "/"))  # noqa: SLF001 - one origin rule for the plugin
    token = env(TOKEN_ENV)
    tenant = (env("AV_TENANT_ID") or env("TENANT_ID")).strip().lower()
    if origin is None or not token or not TENANT.fullmatch(tenant):
        return None, None, "not_configured"
    return origin + PRAYERS_PATH.format(tenant=tenant), token, None


class Attempt:
    """One attempt's outcome: `status` and `body` when the control plane answered,
    else `failure` (`transport`, `deadline`, `cut`, `url_refused`)."""

    __slots__ = ("status", "body", "retry_after", "failure")

    def __init__(self, status: Optional[int] = None, body: Optional[dict] = None,
                 retry_after: Optional[str] = None, failure: Optional[str] = None) -> None:
        self.status = status
        self.body = body
        self.retry_after = retry_after
        self.failure = failure

    @property
    def retryable(self) -> bool:
        if self.failure is not None:
            return self.failure != "url_refused"
        return self.status is not None and self.status >= 500


def _parse(raw: bytes) -> Optional[dict]:
    if len(raw) > MAX_ANSWER_BYTES:
        return None
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw.strip() else {}
    except (UnicodeDecodeError, ValueError):
        return None
    return parsed if isinstance(parsed, dict) else None


def _header(headers: Any, name: str) -> Optional[str]:
    try:
        value = headers.get(name) if headers is not None else None
    except Exception:  # noqa: BLE001
        return None
    return value if isinstance(value, str) else None


def _send(url: str, token: str, data: bytes, kind: str) -> Attempt:
    """One POST. Never raises; no failure carries the URL, the token or the body."""
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {token}",
        SESSION_KIND_HEADER: kind,
    }
    try:
        request = urllib.request.Request(url, data=data, headers=headers, method="POST")
    except ValueError:
        return Attempt(failure="url_refused")
    try:
        response = _OPENER.open(request, timeout=SOCKET_TIMEOUT_S)
    except urllib.error.HTTPError as exc:
        try:
            raw = exc.read(MAX_ANSWER_BYTES + 1) or b""
        except Exception:  # noqa: BLE001
            raw = b""
        return Attempt(int(getattr(exc, "code", 0) or 0), _parse(raw), _header(getattr(exc, "headers", None), "Retry-After"))
    except urllib.error.URLError:
        return Attempt(failure="transport")
    except (ValueError, http.client.InvalidURL):
        return Attempt(failure="url_refused")
    except Exception:  # noqa: BLE001 - after the send: the retry's same key makes it safe
        return Attempt(failure="cut")
    try:
        with response:
            status = int(getattr(response, "status", 0) or 0)
            raw = response.read(MAX_ANSWER_BYTES + 1)
            retry_after = _header(getattr(response, "headers", None), "Retry-After")
    except Exception:  # noqa: BLE001
        return Attempt(failure="cut")
    return Attempt(status, _parse(raw), retry_after)


def _attempt(url: str, token: str, data: bytes, kind: str) -> Attempt:
    """`_send` under the attempt's deadline, on a worker thread."""
    box: list[Attempt] = []

    def run() -> None:
        try:
            box.append(_send(url, token, data, kind))
        except BaseException:  # noqa: BLE001
            box.append(Attempt(failure="transport"))

    worker = threading.Thread(target=run, name="av-events-pray", daemon=True)
    worker.start()
    _join(worker, DEADLINE_S)
    if worker.is_alive() or not box:
        return Attempt(failure="deadline")
    return box[0]


def post_prayer(url: str, token: str, data: bytes, kind: str) -> tuple[Attempt, int]:
    """At most two attempts with the same bytes (and so the same idempotency key)."""
    attempts = 0
    while True:
        attempts += 1
        result = _attempt(url, token, data, kind)
        if attempts >= MAX_ATTEMPTS or not result.retryable:
            return result, attempts
        _sleep(RETRY_PAUSE_S)


def _retry_after(attempt: Attempt) -> Optional[int]:
    candidates: list[Any] = []
    if attempt.body is not None:
        candidates += [attempt.body.get("retry_after_s"), attempt.body.get("retry_after")]
    if attempt.retry_after is not None and attempt.retry_after.strip().isdigit():
        candidates.append(int(attempt.retry_after.strip()))
    for value in candidates:
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            continue
        return max(1, min(MAX_RETRY_AFTER_S, math.ceil(value)))
    return None


def answer(attempt: Attempt) -> dict:
    """The tool's answer for the last attempt."""
    if attempt.failure is not None:
        return _error("not_configured" if attempt.failure == "url_refused" else "unreachable")
    status = attempt.status or 0
    body = attempt.body
    if 200 <= status < 300:
        prayer_id = body.get("prayer_id") if body is not None else None
        if not isinstance(prayer_id, str) or not PRAYER_ID.fullmatch(prayer_id):
            return _error("bad_answer")
        state = body.get("status")
        out: dict[str, Any] = {"prayer_id": prayer_id, "status": state if state in PRAYER_STATUSES else "received"}
        if body.get("duplicate_open") is True:
            out["duplicate_open"] = True
        out["review"] = REVIEW
        out["tell_resident"] = True
        return out
    if is_redirect(status):
        return _error("redirect_refused")
    sent = body.get("error") if body is not None else None
    code = sent if isinstance(sent, str) and sent in PASSED_CODES.get(status, frozenset()) else None
    if code is None:
        code = DEFAULT_CODES.get(status) or ("unavailable" if status >= 500 else f"http_{status}")
    return _error(code, _retry_after(attempt) if status in (429, 503) else None)


def pray_answer(args: Any, session_id: Any) -> tuple[dict, dict]:
    """The tool's answer, and the facts its one log line carries (codes only)."""
    facts: dict[str, Any] = {"kind": "-", "session": "-", "http": "-", "attempts": 0}
    if not switch_on():
        return _error("disabled"), facts
    if isinstance(args, dict) and isinstance(args.get("ask"), dict) and args["ask"].get("kind") in ASK_KINDS:
        facts["kind"] = args["ask"]["kind"]
    kind = session_kind(session_id)
    if kind is None:
        return _error("group_session"), facts
    facts["session"] = kind
    prayer, code = validate(args)
    if code is not None:
        return _error(code), facts
    url, token, code = endpoint()
    if code is not None:
        return _error(code), facts
    register_literal_secret(token)
    key = _new_key()
    if not IDEMPOTENCY_KEY.fullmatch(key):
        return _error("internal"), facts
    data = request_body(prayer, key)
    if len(data) > MAX_BODY_BYTES:
        return _error("too_large"), facts
    attempt, attempts = post_prayer(url, token, data, kind)
    facts["attempts"] = attempts
    facts["http"] = attempt.status if attempt.status is not None else (attempt.failure or "-")
    return answer(attempt), facts


def make_handler() -> Callable[..., str]:
    def pray_handler(args: Any = None, **kwargs: Any) -> str:
        try:
            result, facts = pray_answer(args, kwargs.get("session_id"))
        except SystemExit:
            raise
        except BaseException as exc:  # noqa: BLE001 - fail open
            try:
                logger.warning("av-events: pray failed=%s", type(exc).__name__)
            except Exception:  # noqa: BLE001
                pass
            return json.dumps(_error("internal"))
        try:
            logger.info("av-events: pray result=%s kind=%s session=%s http=%s attempts=%d",
                        result.get("error") or result.get("status"), facts["kind"], facts["session"],
                        facts["http"], facts["attempts"])
        except Exception:  # noqa: BLE001
            pass
        return json.dumps(result, ensure_ascii=False)

    return pray_handler


#: The lineage listeners the cron rule reads (`_record_intention.LINEAGE_HOOKS`
#: without its DATA-470 `post_tool_call` one). Registering them again when
#: record_intention is on only records the same platform and parent twice.
LINEAGE_HOOK_NAMES = ("on_session_start", "pre_api_request", "subagent_start")


def register_pray_tool(ctx: Any) -> bool:
    """Register `pray` and its lineage listeners when `AV_PRAY` is on. True when registered."""
    if not switch_on():
        logger.debug("av-events: pray skipped=switch_off")
        return False
    register_tool = getattr(ctx, "register_tool", None)
    if not callable(register_tool):
        logger.info("av-events: pray skipped=no_register_tool")
        return False
    handler = make_handler()
    try:
        try:
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=handler,
                          description=TOOL_DESCRIPTION)
        except TypeError:
            register_tool(name=TOOL_NAME, toolset=TOOLSET, schema=TOOL_SCHEMA, handler=handler)
    except Exception as exc:  # noqa: BLE001
        logger.warning("av-events: pray register_failed=%s", type(exc).__name__)
        return False
    register_lineage(ctx)
    logger.info("av-events: pray registered")
    return True


def register_lineage(ctx: Any) -> None:
    """The lineage listeners `session_kind`'s cron rule reads. `pray`, `ask_village` and
    record_intention may each register them: a second copy only records the same platform
    and parent again."""
    register_hook = getattr(ctx, "register_hook", None)
    if not callable(register_hook):
        return
    for name in LINEAGE_HOOK_NAMES:
        try:
            register_hook(name, _ri.LINEAGE_HOOKS[name])
        except Exception:  # noqa: BLE001 - a missing listener only refuses more cron runs as groups
            continue


__all__ = [
    "ASK_KINDS",
    "CONTACT",
    "DEADLINE_S",
    "MAX_ATTEMPTS",
    "MAX_BODY_BYTES",
    "MESSAGES",
    "PRAYERS_PATH",
    "REVIEW",
    "SESSION_KIND_HEADER",
    "SWITCH",
    "TOOLSET",
    "TOOL_DESCRIPTION",
    "TOOL_NAME",
    "TOOL_SCHEMA",
    "answer",
    "endpoint",
    "make_handler",
    "normalize_reason",
    "post_prayer",
    "pray_answer",
    "register_lineage",
    "register_pray_tool",
    "request_body",
    "session_kind",
    "switch_on",
    "validate",
]
