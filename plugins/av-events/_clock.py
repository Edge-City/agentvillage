"""CLOCK-1: every turn gets the village clock, `Now: Thu 2026-10-15 00:54 IST (12:54 AM)`.

Why: a chat turn carries Hermes's per-message stamp (`[Thu 2026-10-15 00:54:12 IST] ...`), but a
cron run (heartbeat, dreaming, digest, brief, a resident's own job) and a delegated child carry only
the system prompt's date line, never a time of day, and the approval gate refuses `date`. So a
scheduled run could not tell which of today's sessions were already over
(private/handover/lanes-lead/DATE-HOTFIX-2026-10-14.md).

How: `pre_llm_call` (Hermes v2026.9.24 `agent/turn_context.py:745-799`) runs once per turn for every
agent: gateway DM and group turns, cron runs (`platform=cron`) and subagents (`parent_session_id`
set). A `{"context": str}` return is appended to the current user message at API time
(`compose_user_api_content`, :92-102), persisted in the row's `api_content` sidecar and replayed
byte for byte, so the system prompt and the prompt-cache prefix are never touched. This module only
returns text for that hook; it never sees or edits the system prompt.

The line mirrors ov#347's `nowLine` in `skills/edgeos/scripts/events.ts` exactly:
`Now: <Wkd YYYY-MM-DD HH:MM> <zone> (<h:mm AM/PM>)`. The zone is `HERMES_TIMEZONE` (process env,
then `$HERMES_HOME/.env`, as the installer reads it), else Asia/Kolkata; a name the runtime does not
know is Asia/Kolkata. The label is `IST` for Asia/Kolkata and otherwise what `Intl` en-US `short`
prints: the US abbreviations (`EDT`, `PST`, ...), `UTC`, else `GMT+H[:MM]`.

`with_clock_line` sits outside the telemetry guard (like DATA-444 and DATA-312): `AV_EVENTS_ENABLED=0`,
no token, or `pre_llm_call` in `AV_HOOKS_DISABLED` do not stop it. Its one switch is `clock_line`
in `AV_HOOKS_DISABLED`, read like `approvals_reminder` (the collector's config, re-read at session
boundaries; the process env when no collector exists). It never raises: any failure, `SystemExit`
included, is no line and one warning that names the exception class only.

Idempotent per turn: a Now line already in the inbound context (a second wrap, or another return
that carries one) is replaced, not duplicated; a second call for the same session and turn returns
the same bytes; a user message that already ends with this exact line gets no second copy.
Standard library only.
"""

from __future__ import annotations

import logging
import re
import threading
from collections import OrderedDict
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Callable, Optional

from ._core import env

logger = logging.getLogger("av-events")

#: Its name in `AV_HOOKS_DISABLED`.
SWITCH = "clock_line"

#: The village zone when `HERMES_TIMEZONE` is unset, blank or unknown.
DEFAULT_ZONE = "Asia/Kolkata"

#: Asia/Kolkata without tzdata: +05:30 all year (India has no DST).
_IST_FIXED = timezone(timedelta(hours=5, minutes=30), "IST")

#: The abbreviations `Intl.DateTimeFormat("en-US", {timeZoneName: "short"})` prints as such;
#: every other zone prints `GMT+H[:MM]` (or `GMT` at offset zero, `UTC` for UTC itself).
_US_SHORT = frozenset({
    "EST", "EDT", "CST", "CDT", "MST", "MDT", "PST", "PDT", "AKST", "AKDT", "HST", "HDT",
})
_UTC_NAMES = frozenset({"UTC", "Etc/UTC", "Etc/UCT", "UCT", "Etc/Universal", "Universal", "Zulu", "Etc/Zulu"})

#: English weekday abbreviations, independent of the process locale (`%a` is not).
_WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")

#: A line this module wrote: the shape the idempotence check strips before appending.
LINE_RE = re.compile(r"^Now: [A-Z][a-z]{2} \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ \(\d{1,2}:\d{2} [AP]M\)$")

#: Lines given per (session, turn), so a second call in the same turn returns the same bytes.
MAX_TURNS = 512
_TURNS: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_LOCK = threading.Lock()


def _zone(name: str) -> tuple[tzinfo, str]:
    """(tzinfo, zone name) for `name`, else Asia/Kolkata; the fixed +05:30 when tzdata is missing."""
    try:
        from zoneinfo import ZoneInfo
    except Exception:  # noqa: BLE001 - no zoneinfo at all: the village zone, fixed
        return _IST_FIXED, DEFAULT_ZONE
    if name and name != DEFAULT_ZONE:
        try:
            return ZoneInfo(name), name
        except Exception:  # noqa: BLE001 - unknown, malformed or a path: the village zone
            pass
    try:
        return ZoneInfo(DEFAULT_ZONE), DEFAULT_ZONE
    except Exception:  # noqa: BLE001 - tzdata missing
        return _IST_FIXED, DEFAULT_ZONE


def zone_name() -> str:
    """`HERMES_TIMEZONE`, stripped, or "" (process env, then `$HERMES_HOME/.env`)."""
    return env("HERMES_TIMEZONE").strip()


def _label(local: datetime, name: str) -> str:
    """events.ts `zoneLabel`: `IST` for Asia/Kolkata, else `Intl` en-US `short`."""
    if name == DEFAULT_ZONE:
        return "IST"
    if name in _UTC_NAMES:
        return "UTC"
    abbr = local.tzname() or ""
    if abbr in _US_SHORT:
        return abbr
    offset = local.utcoffset() or timedelta(0)
    minutes = int(offset.total_seconds() // 60)
    if minutes == 0:
        return "GMT"
    sign = "+" if minutes > 0 else "-"
    hours, rest = divmod(abs(minutes), 60)
    return f"GMT{sign}{hours}" + (f":{rest:02d}" if rest else "")


def now_line(now: Optional[datetime] = None, zone: Optional[str] = None) -> str:
    """`Now: Thu 2026-10-15 00:54 IST (12:54 AM)` for `now` (default: this instant) in `zone`
    (default: `HERMES_TIMEZONE`, else Asia/Kolkata). A naive `now` is taken as UTC."""
    tz, name = _zone(zone_name() if zone is None else zone.strip())
    moment = datetime.now(timezone.utc) if now is None else now
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    local = moment.astimezone(tz)
    hour12 = local.hour % 12 or 12
    meridiem = "AM" if local.hour < 12 else "PM"
    return (
        f"Now: {_WEEKDAYS[local.weekday()]} {local.year:04d}-{local.month:02d}-{local.day:02d} {local.hour:02d}:{local.minute:02d} {_label(local, name)} "
        f"({hour12}:{local.minute:02d} {meridiem})"
    )


def disabled(collector: Any) -> bool:
    """True when `clock_line` is in `AV_HOOKS_DISABLED`: the collector's parse when there is one
    (re-read at session boundaries, like `approvals_reminder`), else the same parse of the env."""
    hooks = None
    if collector is not None:
        hooks = getattr(getattr(collector, "config", None), "disabled_hooks", None)
    if hooks is None:
        hooks = frozenset(part.strip().lower() for part in env("AV_HOOKS_DISABLED").split(",") if part.strip())
    return SWITCH in hooks


def _strip_lines(text: str) -> str:
    """`text` without any line this module wrote, and without the blank lines that framed them."""
    kept = [line for line in text.split("\n") if not LINE_RE.match(line)]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(kept)).strip("\n")


def compose(result: Any, line: str) -> Any:
    """The hook's other return first, then `line`, as one `{"context": ...}`; a Now line already in
    that return is replaced, not duplicated. A dict's other keys are kept (as `_approvals_reminder.compose`)."""
    if isinstance(result, dict):
        merged = dict(result)
        existing = result.get("context")
        existing = _strip_lines(existing) if isinstance(existing, str) else existing
        merged["context"] = f"{existing}\n\n{line}" if existing else line
        return merged
    if isinstance(result, str) and result.strip():
        rest = _strip_lines(result)
        return {"context": f"{rest}\n\n{line}" if rest.strip() else line}
    return {"context": line}


def line_for(kwargs: dict, collector: Any, *, now: Optional[datetime] = None) -> Optional[str]:
    """The line for this turn, or None (switched off, or the user message already ends with it).

    Every turn type gets it: DM, group, cron, subagent, injected. A second call for the same
    (session_id, turn_id) returns the line the first one gave."""
    if disabled(collector):
        return None
    session_id = str(kwargs.get("session_id") or "")
    turn_id = str(kwargs.get("turn_id") or "")
    key = (session_id, turn_id) if session_id and turn_id else None
    line = None
    if key is not None:
        with _LOCK:
            line = _TURNS.get(key)
    if line is None:
        line = now_line(now)
        if key is not None:
            with _LOCK:
                line = _TURNS.setdefault(key, line)
                while len(_TURNS) > MAX_TURNS:
                    _TURNS.popitem(last=False)
    text = kwargs.get("user_message")
    if isinstance(text, str) and text.rstrip().endswith(line):
        return None
    return line


def with_clock_line(telemetry: Callable, collector_ref: Callable[[], Any]) -> Callable:
    """`pre_llm_call` = the telemetry body (`guarded`), then the CLOCK-1 Now line.

    Outside the telemetry guard; never raises. Wrap it inside `with_approvals_reminder` so the
    order is telemetry, Now line, DATA-444 reminder."""

    def pre_llm_call(*args: Any, **kwargs: Any) -> Any:
        result = telemetry(*args, **kwargs)
        try:
            line = line_for(kwargs, collector_ref())
            if not line:
                return result
            return compose(result, line)
        except BaseException as exc:  # noqa: BLE001 - the clock never costs the turn
            try:
                logger.warning("av-events: clock_line failed (%s)", type(exc).__name__)
            except BaseException:  # noqa: BLE001 - a log line must not cost the turn
                pass
            return result

    pre_llm_call.av_hook_name = getattr(telemetry, "av_hook_name", "pre_llm_call")  # type: ignore[attr-defined]
    return pre_llm_call


def reset() -> None:
    """Forget every remembered turn (tests)."""
    with _LOCK:
        _TURNS.clear()


__all__ = [
    "DEFAULT_ZONE",
    "LINE_RE",
    "MAX_TURNS",
    "SWITCH",
    "compose",
    "disabled",
    "line_for",
    "now_line",
    "reset",
    "with_clock_line",
    "zone_name",
]
