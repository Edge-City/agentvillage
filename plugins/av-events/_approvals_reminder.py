"""DATA-444 overlay half: one "Connect approvals" reminder while the welcome's button is unstarted.

The control plane's welcome carries an inline "Connect approvals" button (the
approvals bot's Start link) while the tenant's approvals bot is not paired
(cp#162). Only the control plane knows whether the resident pressed Start, so
it leaves one hermes-owned file on the box (b1's contract):

    $HERMES_HOME/memory/approvals-pairing.json   (0600, temp + rename)

- after the first welcome sent with the button: `{"started":false,"button":"sent","at":"<ISO>"}`;
- on every relay bind, an EXISTING file is overwritten with `{"started":true,"at":"<ISO>"}`
  (nothing is created when it is absent);
- `reset --wipe-user` and a recreate drop it with `memory/`.

The rule here: remind only when the file parses to an object whose `started`
is exactly `false`, whose `button` is exactly `"sent"`, and whose `at` is a
timezone-aware ISO time under `WINDOW_S` old (a time more than
`FUTURE_SKEW_S` ahead of this clock is no reminder). Anything else (missing,
unreadable, too large, not JSON, nested too deep to parse, wrong types,
`started:true`) is no reminder, and nothing here raises. This module never
writes the file.

Once per session: an in-process, bounded set of session ids. A gateway restart
inside the window may remind once more in a session; the window bounds that.

Which sessions may be reminded (a human's Telegram DM, root only) is the
caller's decision (`__init__._approvals_reminder_for`); this module only reads
the file and remembers who was reminded. Standard library only.
"""

from __future__ import annotations

import json
import os
import stat
import threading
import time
from collections import OrderedDict
from datetime import datetime
from typing import Any, Optional

from ._core import hermes_home

#: The control plane's file, relative to `$HERMES_HOME`.
PAIRING_FILE = os.path.join("memory", "approvals-pairing.json")

#: The `pre_llm_call` context Hermes appends to the resident's message on the
#: reminding turn (v2026.9.24 `agent/turn_context.py:745-797`). It does not stay
#: in that turn: Hermes stamps the sent bytes into the user row's `api_content`
#: (`turn_context.py:884-922`), persists them to SessionDB
#: (`agent/session_persistence.py:194-198`) and replays them on every later turn
#: of the session to keep the prompt cache byte-stable (`turn_context.py:1255-1262`);
#: a compaction summary may carry it further. It is appended raw, with no label
#: (`compose_user_api_content`), so the text labels itself as a note that is not
#: the resident's words, and scopes the instruction to the one reply.
REMINDER = (
    "[Agent Village note, not from the resident] "
    "In this reply only, add one line at the end: "
    "One more step: tap Connect approvals above to finish setting up approvals."
)

#: How long after the welcome's `at` the reminder may still be given.
WINDOW_S = 30 * 60
#: How far ahead of this clock an `at` may be and still count (clock skew).
FUTURE_SKEW_S = 5 * 60
#: The control plane writes a few dozen bytes; anything larger is not its file.
MAX_FILE_BYTES = 4096
#: Sessions remembered as reminded; the oldest fall off first.
MAX_REMINDED = 4096

_LOCK = threading.Lock()
_REMINDED: "OrderedDict[str, None]" = OrderedDict()


def pairing_path(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), PAIRING_FILE)


def read_pairing(path: str) -> Any:
    """The parsed file, or None when it is missing, not a regular file (a FIFO
    is opened non-blocking, so it never waits for a writer), too large,
    unreadable, not JSON or nested too deep to parse. Never raises."""
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        fd = os.open(path, flags)
    except OSError:
        return None
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            return None
        raw = os.read(fd, MAX_FILE_BYTES + 1)
        if len(raw) > MAX_FILE_BYTES:
            return None
        return json.loads(raw.decode("utf-8"))
    except (OSError, ValueError, RecursionError):
        return None
    finally:
        try:
            os.close(fd)
        except OSError:
            pass


def _epoch(value: Any) -> Optional[float]:
    """A timezone-aware ISO 8601 time as epoch seconds; None otherwise."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text[-1:] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    try:
        return parsed.timestamp()
    except (OverflowError, OSError, ValueError):
        return None


def unstarted(record: Any, now: float) -> bool:
    """True only for `started` exactly false, `button` exactly "sent" and a
    fresh `at` (under `WINDOW_S` old, at most `FUTURE_SKEW_S` ahead)."""
    if not isinstance(record, dict):
        return False
    if record.get("started") is not False:
        return False
    if record.get("button") != "sent":
        return False
    at = _epoch(record.get("at"))
    if at is None:
        return False
    age = now - at
    if age < -FUTURE_SKEW_S:
        return False
    return age < WINDOW_S


def reminder_for(session_id: str, *, now: Optional[float] = None, home: Optional[str] = None) -> Optional[str]:
    """`REMINDER` the first time a session asks while the file says unstarted;
    None otherwise, and None for every later ask in that session."""
    sid = str(session_id or "").strip()
    if not sid:
        return None
    with _LOCK:
        if sid in _REMINDED:
            return None
    record = read_pairing(pairing_path(home))
    if not unstarted(record, time.time() if now is None else now):
        return None
    with _LOCK:
        if sid in _REMINDED:
            return None
        _REMINDED[sid] = None
        while len(_REMINDED) > MAX_REMINDED:
            _REMINDED.popitem(last=False)
    return REMINDER


def compose(result: Any, reminder: str) -> Any:
    """The hook's other return first, then the reminder, as one `{"context": ...}`.

    Hermes reads a `pre_llm_call` return as `{"context": str}` or a non-empty
    str and ignores anything else, so another shape loses nothing it would use.
    A dict's other keys are kept.
    """
    if isinstance(result, dict):
        merged = dict(result)
        existing = result.get("context")
        merged["context"] = f"{existing}\n\n{reminder}" if existing else reminder
        return merged
    if isinstance(result, str) and result.strip():
        return {"context": f"{result}\n\n{reminder}"}
    return {"context": reminder}


def reset() -> None:
    """Forget every reminded session (tests)."""
    with _LOCK:
        _REMINDED.clear()


__all__ = [
    "FUTURE_SKEW_S",
    "MAX_FILE_BYTES",
    "MAX_REMINDED",
    "PAIRING_FILE",
    "REMINDER",
    "WINDOW_S",
    "compose",
    "pairing_path",
    "read_pairing",
    "reminder_for",
    "reset",
    "unstarted",
]
