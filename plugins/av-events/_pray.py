"""Shared helpers of the av-events control-plane tools (`ask_village`, `ask_odin`, `search_village`,
`query_village`, `code_run`), kept in this module when the `pray` tool was retired (lead RULING
L42776: `ask_odin` supersedes it; the control plane removes `AV_PRAY` from every box). No tool lives
here any more and nothing reads `AV_PRAY`.

**Who is speaking (`session_kind`, fail closed).** Only two cases are allowed, each positively
identified; everything else (a group, a channel, a webhook, an empty, unknown or unreadable chat type,
an exception) is None, and the calling tool refuses with `group_session` and sends nothing:
- `dm`: the task's bound chat type is a direct chat (recall's `DIRECT_CHAT_TYPES`,
  `plugins/recall/__init__.py`; unlike recall, an empty chat type on a local surface is refused);
- `cron`: the agent's own scheduled run (`record_intention`'s lineage rule: a `cron_` session id or
  `platform=cron` up the delegation chain, plus Hermes's `HERMES_CRON_SESSION=1`) whose whole delivery
  spec is the resident's Telegram DM (`cron_delivers_privately`: platform `telegram` and chat id equal
  to `TELEGRAM_HOME_CHANNEL`, a positive id; approval@edge's ruling, CLAIMS L6599).
A tool that uses the rule registers the lineage listeners (`register_lineage`), so the cron rule works
with `AV_RECORD_INTENTION` off. The kind travels as `X-AV-Session-Kind: dm|cron`.

**The control plane's origin (`cp_origin`).** https on a `CP_HOSTS` host, pinned exactly as
directory.ts pins it (port 443, no credentials, query, fragment or path); plain http only to a
loopback host (tests and local runs).

Also here: `Attempt` (one request's outcome), `_header`, the contact net `CONTACT`, `invisible`,
`JS_TRIM` and the tenant id pattern `TENANT`.

Python 3.11, standard library only.
"""

from __future__ import annotations

import os
import re
import unicodedata
import urllib.parse
from typing import Any, Callable, Optional

from . import _record_intention as _ri
from ._core import env

#: The control plane's origin, as the control plane writes it into the box's .env.
URL_ENV = "CONTROL_PLANE_URL"
SESSION_KIND_HEADER = "X-AV-Session-Kind"
#: directory.ts `CP_HOSTS` (skills/edgeos/scripts/directory.ts): the only hosts a box credential is sent to
#: over https, exact hostname, port 443 or none. Plain http only to a loopback host (tests, local runs).
CP_HOSTS = frozenset({"control-plane-production-606c.up.railway.app"})
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
#: A tenant id: a lower-case UUID.
TENANT = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


#: ECMAScript's WhiteSpace and LineTerminator: what `String.prototype.trim` removes.
JS_TRIM = "\t\n\v\f\r                  　﻿"
#: The contact net (an email, a phone-like run, an @handle, a t.me link). Cheap, not a guarantee.
CONTACT = (
    re.compile(r"[^\s@]+@[^\s@]+\.[^\s@]+"),  # an email address
    re.compile(r"\d(?:[ .()-]?\d){8,}"),  # a phone-like run: 9+ digits, one separator at most between two
    re.compile(r"@[A-Za-z0-9_]{2,}"),  # an @handle
    re.compile(r"t\.me/", re.IGNORECASE),  # a Telegram link
)

#: Invisible characters that can hide or reorder text (ov#341 refute S2, N4): every format (Cf, which
#: holds the bidi controls, the zero-width characters, U+00AD, U+180E and the Unicode tag characters
#: U+E0001, U+E0020-E007F), private-use, surrogate and unassigned code point, every control but `\n`,
#: the variation selectors U+FE00-FE0F and U+E0100-E01EF, U+034F, the Hangul fillers, and U+2028/U+2029.
_VARIATION_SELECTORS = ((0xFE00, 0xFE0F), (0xE0100, 0xE01EF))
_ALSO_INVISIBLE = frozenset({0x034F, 0x115F, 0x1160, 0x180B, 0x180C, 0x180D, 0x180F, 0x2800, 0x3164, 0xFFA0,
                             0x2028, 0x2029})


def invisible(ch: str) -> bool:
    """A character that renders as nothing (or reorders what is around it), `\n` excepted."""
    if ch == "\n":
        return False
    code = ord(ch)
    if code in _ALSO_INVISIBLE or any(lo <= code <= hi for lo, hi in _VARIATION_SELECTORS):
        return True
    return unicodedata.category(ch) in ("Cc", "Cf", "Co", "Cs", "Cn")


# ---- Who is speaking (the session rule) ------------------------------------

#: recall's `DIRECT_CHAT_TYPES` (plugins/recall/__init__.py). Unlike recall, an empty chat type on a
#: local surface is not accepted: only a positively bound direct chat is (fail closed).
DIRECT_CHAT_TYPES = frozenset({"dm", "private", "direct", "c2c"})


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


#: A Telegram private chat's id is the user's id, positive; a group's or a channel's is negative.
_TELEGRAM_DM_CHAT = re.compile(r"[1-9][0-9]{0,19}")


#: The resident's Telegram DM: the control plane writes the resident's own Telegram user id here
#: (`telegram-home.js`, after the pairing is approved), which is also their private chat's id.
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"


def _text_or_none(value: Any) -> Optional[str]:
    """A session value as stripped lower-case text, or None for anything that is not a string."""
    return value.strip().lower() if isinstance(value, str) else None


#: Hermes's cron task id, `cron:{job_id}:{execution_id}` (`cron/scheduler.py:2302`), handed to every
#: tool handler as `task_id` (`model_tools.py:825`, `tools/registry.py` dispatch).
CRON_TASK = re.compile(r"cron:([A-Za-z0-9][A-Za-z0-9_.-]{0,127}):[A-Za-z0-9_.-]{1,128}")


def _hermes_cron() -> tuple[Callable[[str], Any], Callable[..., Any]]:
    """Hermes's own job loader and delivery resolver (v2026.9.24: `cron/jobs.py:1860` `get_job`,
    `cron/scheduler_delivery.py:1071` `_resolve_delivery_targets`). Tests replace this. Absent or
    renamed in another Hermes: the import or attribute error refuses."""
    from cron import jobs, scheduler_delivery  # noqa: PLC0415 - Hermes, in-process on a box

    return jobs.get_job, scheduler_delivery._resolve_delivery_targets  # noqa: SLF001


def cron_delivery_targets(task_id: Any) -> Optional[list[tuple[str, str, str]]]:
    """Every target the job of this cron run delivers to, through BOTH lanes, resolved the way Hermes
    resolves them when it delivers (`_resolve_delivery_targets(job)` for the response, and
    `(job, for_failure=True)` for failure notices: `failure_deliver`, else `deliver`;
    `scheduler_delivery.py:1060-1103`): the comma-separated spec split, `all`/`origin`/home tokens
    expanded, deduplicated by (platform, chat id, thread id) as Hermes does (`:1093-1096`). Hermes
    publishes only the FIRST of them in `HERMES_CRON_AUTO_DELIVER_*` (`:1106-1109`,
    `scheduler.py:2343-2349`) but `_deliver_result` sends to all (`:1906-1915`), so the full list is
    what counts (ov#341 recheck S1). None when anything cannot be read: no cron task id, no job, a
    resolver that fails or answers something else."""
    match = CRON_TASK.fullmatch(task_id) if isinstance(task_id, str) else None
    if match is None:
        return None
    get_job, resolve = _hermes_cron()
    job = get_job(match.group(1))
    if not isinstance(job, dict):
        return None
    targets: set[tuple[str, str, str]] = set()
    for for_failure in (False, True):
        lane = resolve(job, for_failure=for_failure)
        if not isinstance(lane, list):
            return None
        for target in lane:
            if not isinstance(target, dict) or not isinstance(target.get("platform"), str):
                return None
            thread = target.get("thread_id")
            targets.add((target["platform"].strip().lower(), str(target.get("chat_id")).strip(),
                         "" if thread is None else str(thread).strip()))
    return sorted(targets)


def cron_delivers_privately(task_id: Any = None) -> bool:
    """approval@edge's ruling (CLAIMS L6599, ov#341 refute S3 and recheck S1), FAIL CLOSED: a cron run
    may use these tools only when its job's FULL delivery spec, both lanes, resolves to exactly one
    target and that target is the resident's own Telegram DM (`TELEGRAM_HOME_CHANNEL`, a positive
    id, no thread), and the target Hermes published for this run is that same DM. A duplicate of the
    home DM in the spec is allowed: Hermes deduplicates it and delivers once. Every other case is
    False: more than one target, none (local delivery), another DM, a group or channel, another
    platform, an unparseable or unreadable spec, no cron task id, an exception."""
    try:
        home = _text_or_none(env(HOME_CHANNEL_ENV))
        if home is None or _TELEGRAM_DM_CHAT.fullmatch(home) is None:
            return False
        platform = _text_or_none(_session_value("HERMES_CRON_AUTO_DELIVER_PLATFORM"))
        chat = _text_or_none(_session_value("HERMES_CRON_AUTO_DELIVER_CHAT_ID"))
        targets = cron_delivery_targets(task_id)
        # THE allow condition, and the only one:
        return targets == [("telegram", home, "")] and platform == "telegram" and chat == home
    except Exception:  # noqa: BLE001 - unreadable is refused
        return False


def session_kind(session_id: Any, task_id: Any = None) -> Optional[str]:
    """`dm`, `cron`, or None (refused), FAIL CLOSED for every tool that uses it: any exception,
    unknown, missing, empty or unexpected value is None. Allowed only:
    - `cron`: a session positively seen as the agent's own scheduled run (a `cron_` id, or
      `platform=cron`, up its delegation chain, or Hermes's `HERMES_CRON_SESSION=1`) AND
      `cron_delivers_privately(task_id)` (its job's whole delivery spec is the home DM alone);
    - `dm`: a session whose bound chat type is positively a direct chat (`DIRECT_CHAT_TYPES`).
    An empty chat type (a local CLI, an unbound task) is refused."""
    try:
        return _session_kind(session_id, task_id)
    except Exception:  # noqa: BLE001 - unreadable is refused
        return None


def _session_kind(session_id: Any, task_id: Any) -> Optional[str]:
    sid = session_id.strip() if isinstance(session_id, str) else ""
    bound_id = _session_value("HERMES_SESSION_ID")
    idents = [_text_or_none(os.environ.get("HERMES_PLATFORM")), _text_or_none(_session_value("HERMES_SESSION_PLATFORM")),
              _text_or_none(_session_value("HERMES_SESSION_SOURCE"))]
    try:
        lineage = _ri.held_reason(sid) if sid else None
    except Exception:  # noqa: BLE001 - lineage unread: cron is still detected by the other signals
        lineage = None
    if (lineage == "cron" or _text_or_none(_session_value("HERMES_CRON_SESSION")) == "1" or "cron" in idents
            or sid.startswith("cron_") or (isinstance(bound_id, str) and bound_id.startswith("cron_"))):
        return "cron" if cron_delivers_privately(task_id) is True else None
    if _text_or_none(_session_value("HERMES_SESSION_CHAT_TYPE")) in DIRECT_CHAT_TYPES:
        return "dm"
    return None


# ---- The control plane's origin, and one request's outcome -------------------------


def cp_origin(raw: str) -> Optional[str]:
    """directory.ts `controlPlaneBase`: https on a `CP_HOSTS` host, port 443 or none, no userinfo, no path
    beyond `/`, no query or fragment. Plus plain http to a loopback host (tests, local runs)."""
    if not raw or "?" in raw or "#" in raw or any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in raw):
        return None
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return None
    if not host or parts.username is not None or parts.password is not None or parts.path not in ("", "/"):
        return None
    if parts.scheme == "https" and host in CP_HOSTS and port in (None, 443):
        return f"https://{host}"
    if parts.scheme == "http" and host in LOOPBACK_HOSTS:
        return f"http://{parts.netloc}"
    return None


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


def _header(headers: Any, name: str) -> Optional[str]:
    try:
        value = headers.get(name) if headers is not None else None
    except Exception:  # noqa: BLE001
        return None
    return value if isinstance(value, str) else None


#: The lineage listeners the cron rule reads (`_record_intention.LINEAGE_HOOKS`
#: without its DATA-470 `post_tool_call` one). Registering them again when
#: record_intention is on only records the same platform and parent twice.
LINEAGE_HOOK_NAMES = ("on_session_start", "pre_api_request", "subagent_start")


def register_lineage(ctx: Any) -> None:
    """The lineage listeners `session_kind`'s cron rule reads. Each tool that uses the rule and
    record_intention may register them: a second copy only records the same platform and parent
    again."""
    register_hook = getattr(ctx, "register_hook", None)
    if not callable(register_hook):
        return
    for name in LINEAGE_HOOK_NAMES:
        try:
            register_hook(name, _ri.LINEAGE_HOOKS[name])
        except Exception:  # noqa: BLE001 - a missing listener only refuses more cron runs as groups
            continue


__all__ = [
    "CONTACT",
    "CP_HOSTS",
    "JS_TRIM",
    "SESSION_KIND_HEADER",
    "TENANT",
    "URL_ENV",
    "Attempt",
    "cp_origin",
    "cron_delivers_privately",
    "cron_delivery_targets",
    "invisible",
    "register_lineage",
    "session_kind",
]
