"""The morning brief's read-only reader of the intention map (DATA-222).

The brief (`skills/index-network/scripts/stage-daily-brief.ts --prepare-context`)
carries two small things about intentions the agent inferred: a reminder of
those still waiting for the resident's answer in their approvals, and a receipt
of those published since the last delivered brief. The map is this plugin's own
file, so the brief script never parses it: it runs this module and reads the
JSON it prints.

**Run as** (from the brief script, with Hermes's interpreter):

    python -I -B $HERMES_HOME/plugins/av-events/_brief_items.py [--now <epoch seconds>]

It prints one JSON object and exits 0, whatever it found:

    {"v": 1, "status": "ok" | "off" | "error", "reason": <code or null>,
     "held": [{"id", "text", "heldSince"}], "heldCount": <int>,
     "published": [{"id", "indexIntentId", "publishedAt", "approvedBy"}]}

- `status: off`: `AV_RECORD_INTENTION` is off (`reason: record_intention_off`)
  or the approval path is not configured (`approval_off`). Both lists empty.
- `status: error`: the map exists but could not be read (`map_unreadable`).
  Both lists empty. The map is never renamed, created or written here.
- `held`: inferred intentions (class `intent.publish.inferred.index`) whose
  proposal is open on the resident's approval daemon (`approval.state`
  `requested`), oldest first, at most `MAX_ITEMS` (`heldCount` is the total).
  `text` is the held text (`approval.payload`), whitespace collapsed, at most
  `SUMMARY_CHARS` characters: the words the resident is shown in the approval
  request itself. `heldSince` is when it was first held (ISO 8601, UTC). An
  intention stays here until the poller records the resident's answer, a
  withdrawal, or the final expiry: the map's state, nothing else.
- `published`: inferred intentions published to Index (`approval.state`
  `published`, `published` true, not archived since) within the last
  `RECEIPT_WINDOW_S`, oldest first, at most `MAX_ITEMS`. `approvedBy` is
  `individual` (the resident's grant, `authorization: grant`) or `rule` (their
  policy, `authorization: policy`). No text: the held text is deleted at
  publish (R16), so the brief looks the words up on Index by `indexIntentId`.
  `publishedAt` is the entry's last change, which for a published entry is the
  publish (a published proposal is final).

Never returned: stated intentions (`intent.publish.stated.index`), entries kept
local (a personal capture has no proposal), entries held before approvals were
on (no text), proposals not yet filed, refused, being started or published, or
ended any other way. Which intentions the brief already listed is the brief's
own bookkeeping (`memory/heartbeat-state.json`), not this module's.

**Switches.** `AV_RECORD_INTENTION`, `AV_APPROVAL_ENABLED` and `AV_APPROVAL_URL`
are read like `_core.env` (the process environment, else `$HERMES_HOME/.env`):
this runs as a child of the cron's terminal, which may not carry the gateway's
environment. That differs on purpose from `_approval` (process environment
only, S2): there it guards a publish; here it only decides whether the brief
mentions what the map already holds.

**No lock.** Every writer replaces the map with `os.replace`, so a reader sees
one whole version or the other; taking the writers' flock would make this
reader create the lock file.

Python 3.11, standard library only. Never prints the map, a key, or a token.
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
import time
from datetime import datetime, timezone
from typing import Any, Optional

from ._approval import ENABLED_ENV as APPROVAL_ENABLED_ENV
from ._approval import TRUTHY as APPROVAL_TRUTHY
from ._approval import URL_ENV as APPROVAL_URL_ENV
from ._core import env
from ._intent_approval import INFERRED_CLASS, approval_of, text_of, valid_shape
from ._intentions import RESTRICTIVE_SOURCE, valid_id
from ._record_intention import ARCHIVED_KEY, SWITCH, TRUTHY, map_path

READER_VERSION = 1
#: The one approval state that means "asked, no answer yet".
HELD_STATE = "requested"
PUBLISHED_STATE = "published"
#: A publish older than this is not receipted (a week of suppressed briefs).
RECEIPT_WINDOW_S = 7 * 86400.0
MAX_ITEMS = 20
SUMMARY_CHARS = 160
APPROVED_BY = {"grant": "individual", "policy": "rule"}


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


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _stamp(value: Any) -> Optional[float]:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def summary(text: str) -> str:
    collapsed = " ".join(text.split())
    if len(collapsed) <= SUMMARY_CHARS:
        return collapsed
    return collapsed[: SUMMARY_CHARS - 1].rstrip() + "…"


def _inferred(intention_id: str, entry: dict) -> Optional[dict]:
    """The entry's proposal when it is a well-formed inferred one, else None."""
    ap = approval_of(entry)
    if ap is None or ap.get("class") != INFERRED_CLASS or not valid_shape(intention_id, ap):
        return None
    if entry.get("source") != RESTRICTIVE_SOURCE:
        return None
    return ap


def collect(entries: dict[str, dict], now: float) -> dict:
    held: list[tuple[float, dict]] = []
    published: list[tuple[float, dict]] = []
    for intention_id, entry in entries.items():
        ap = _inferred(intention_id, entry)
        if ap is None:
            continue
        state = ap.get("state")
        if state == HELD_STATE:
            text = text_of(ap.get("payload"))
            since = _stamp(ap.get("opened_at"))
            if text is None or since is None or not text.strip():
                continue
            held.append((since, {"id": intention_id, "text": summary(text), "heldSince": _iso(since)}))
        elif state == PUBLISHED_STATE:
            if entry.get("published") is not True or entry.get(ARCHIVED_KEY) is True:
                continue
            index_id = entry.get("index_intent_id")
            approved_by = APPROVED_BY.get(ap.get("authorization"))
            at = _stamp(ap.get("updated_at"))
            if not isinstance(index_id, str) or not index_id or approved_by is None or at is None:
                continue
            if now - at > RECEIPT_WINDOW_S:
                continue
            published.append((at, {
                "id": intention_id,
                "indexIntentId": index_id,
                "publishedAt": _iso(at),
                "approvedBy": approved_by,
            }))
    held.sort(key=lambda pair: pair[0])
    published.sort(key=lambda pair: pair[0])
    return {
        "held": [item for _, item in held[:MAX_ITEMS]],
        "heldCount": len(held),
        "published": [item for _, item in published[:MAX_ITEMS]],
    }


def brief_items(now: Optional[float] = None) -> dict:
    """The reader's whole answer (see the module docstring). Never raises."""
    answer: dict[str, Any] = {"v": READER_VERSION, "status": "ok", "reason": None,
                              "held": [], "heldCount": 0, "published": []}
    try:
        on, reason = enabled()
        if not on:
            answer.update(status="off", reason=reason)
            return answer
        answer.update(collect(read_map(), time.time() if now is None else float(now)))
    except MapUnreadable:
        answer.update(status="error", reason="map_unreadable")
    except Exception as exc:  # noqa: BLE001 - the brief goes out without these lines
        answer.update(status="error", reason=f"internal_{type(exc).__name__}", held=[], heldCount=0, published=[])
    return answer


def main(argv: list[str]) -> int:
    now: Optional[float] = None
    if "--now" in argv:
        try:
            now = float(argv[argv.index("--now") + 1])
        except (IndexError, ValueError):
            now = None
    print(json.dumps(brief_items(now), ensure_ascii=False, separators=(",", ":")))
    return 0


__all__ = ["READER_VERSION", "RECEIPT_WINDOW_S", "brief_items", "collect", "enabled", "main", "read_map"]
