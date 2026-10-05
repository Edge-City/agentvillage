"""The morning brief's read-only count of inferred intentions awaiting an answer.

Carried from DATA-222 (overlay PR #183) into the brief-lite brief (DATA-314):
the brief says "N things are waiting for your yes or no in your approvals"
and nothing more. The map is this plugin's own file, so the brief trigger
(`skills/index-network/scripts/approvals-waiting.ts`) never parses it: it runs
this module with Hermes's interpreter and reads the one JSON line it prints.

**Run as**

    python -I -B $HERMES_HOME/plugins/av-events/_brief_items.py

It prints one JSON object and exits 0, whatever it found:

    {"v": 1, "status": "ok" | "off" | "error", "reason": <code or null>, "heldCount": <int>}

- `off`: `AV_RECORD_INTENTION` is off (`record_intention_off`) or the approval
  path is not configured (`approval_off`). Nothing counted.
- `error`: the map exists but could not be read (`map_unreadable`).
- `heldCount`: inferred intentions (class `intent.publish.inferred.index`,
  source ambient) whose proposal is open on the resident's approval daemon
  (`approval.state` `requested`). A count only: the held text stays in the
  map's `approval.payload` (R16) and is never printed.

The switches are read like `_core.env` (the process environment, else
`$HERMES_HOME/.env`): this runs under a cron pre-run script, which may not
carry the gateway's environment. It only decides whether the brief mentions a
count; it never guards a publish. No lock is taken and nothing is written:
every writer replaces the map with `os.replace`, so a reader sees one whole
version or the other.

Python 3.11, standard library only. Never prints the map, any text, a key or a token.
"""

from __future__ import annotations

if __name__ == "__main__" and not __package__:  # pragma: no cover - exercised through a subprocess
    # Run as a file: load this directory as a package under a private name so
    # the relative imports below resolve to the plugin's own modules.
    import importlib
    import os as _os
    import sys as _sys
    import types as _types

    _pkg = _types.ModuleType("av_events_brief_reader")
    _pkg.__path__ = [_os.path.dirname(_os.path.abspath(__file__))]  # type: ignore[attr-defined]
    _sys.modules[_pkg.__name__] = _pkg
    _sys.exit(importlib.import_module(f"{_pkg.__name__}._brief_items").main(_sys.argv[1:]))

import json
from typing import Any, Optional

from ._approval import ENABLED_ENV as APPROVAL_ENABLED_ENV
from ._approval import TRUTHY as APPROVAL_TRUTHY
from ._approval import URL_ENV as APPROVAL_URL_ENV
from ._core import env
from ._intent_approval import INFERRED_CLASS, approval_of, valid_shape
from ._intentions import RESTRICTIVE_SOURCE, valid_id
from ._record_intention import SWITCH, TRUTHY, map_path

READER_VERSION = 1
#: The one approval state that means "asked, no answer yet".
HELD_STATE = "requested"


def enabled() -> tuple[bool, Optional[str]]:
    """(on, the reason when off)."""
    if env(SWITCH).strip().lower() not in TRUTHY:
        return False, "record_intention_off"
    if env(APPROVAL_ENABLED_ENV).strip().lower() not in APPROVAL_TRUTHY or not env(APPROVAL_URL_ENV).strip():
        return False, "approval_off"
    return True, None


class MapUnreadable(Exception):
    pass


def read_map() -> dict[str, dict]:
    """The map's intentions, read without a lock and never written. A missing
    map is empty; one that cannot be read or parsed raises `MapUnreadable`."""
    try:
        with open(map_path(), encoding="utf-8") as handle:
            raw = handle.read()
    except FileNotFoundError:
        return {}
    except OSError:
        raise MapUnreadable() from None
    try:
        data = json.loads(raw)
    except ValueError:
        raise MapUnreadable() from None
    entries = data.get("intentions") if isinstance(data, dict) else None
    if not isinstance(entries, dict):
        raise MapUnreadable()
    return {k: v for k, v in entries.items() if valid_id(k) and isinstance(v, dict)}


def held_count(entries: dict[str, dict]) -> int:
    """Inferred, ambient intentions whose proposal is open. An entry that
    cannot be read is skipped alone, never the whole count."""
    held = 0
    for intention_id, entry in entries.items():
        try:
            ap = approval_of(entry)
            if ap is None or ap.get("class") != INFERRED_CLASS or not valid_shape(intention_id, ap):
                continue
            if entry.get("source") == RESTRICTIVE_SOURCE and ap.get("state") == HELD_STATE:
                held += 1
        except Exception:  # noqa: BLE001 - one bad entry never blanks the count
            continue
    return held


def brief_items() -> dict:
    """The reader's whole answer (see the module docstring). Never raises."""
    answer: dict[str, Any] = {"v": READER_VERSION, "status": "ok", "reason": None, "heldCount": 0}
    try:
        on, reason = enabled()
        if not on:
            answer.update(status="off", reason=reason)
            return answer
        answer["heldCount"] = held_count(read_map())
    except MapUnreadable:
        answer.update(status="error", reason="map_unreadable", heldCount=0)
    except Exception as exc:  # noqa: BLE001 - the brief goes out without the line
        answer.update(status="error", reason=f"internal_{type(exc).__name__}", heldCount=0)
    return answer


def main(argv: list[str]) -> int:
    del argv
    print(json.dumps(brief_items(), separators=(",", ":")))
    return 0


__all__ = ["READER_VERSION", "brief_items", "enabled", "held_count", "main", "read_map"]
