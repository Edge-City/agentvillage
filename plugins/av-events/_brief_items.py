"""The morning brief's read-only reader of the intention map (DATA-222).

The brief (`skills/index-network/scripts/stage-daily-brief.ts --prepare-context`)
carries two small things about intentions the agent inferred: a count of those
still waiting for the resident's answer in their approvals, and a receipt of
those published since a delivered brief last listed them. The map is this
plugin's own file, so the brief script never parses it: it runs this module and
reads the JSON it prints.

**Run as** (from the brief script, with Hermes's interpreter):

    python -I -B $HERMES_HOME/plugins/av-events/_brief_items.py [--exclude-stdin] [--now <epoch seconds>]

With `--exclude-stdin` it first reads a JSON array of intention ids from stdin:
the ids a delivered brief already receipted, left out before the cap. It prints
one JSON object and exits 0, whatever it found:

    {"v": 2, "status": "ok" | "off" | "error", "reason": <code or null>,
     "heldCount": <int>,
     "published": [{"id", "indexIntentId", "publishedAt", "approvedBy"}],
     "publishedCount": <int>, "skipped": <int>}

- `status: off`: `AV_RECORD_INTENTION` is off (`reason: record_intention_off`)
  or the approval path is not configured (`approval_off`). Nothing counted.
- `status: error`: the map exists but could not be read (`map_unreadable`).
  Nothing counted. The map is never renamed, created or written here.
- `heldCount`: inferred intentions (class `intent.publish.inferred.index`,
  source ambient) whose proposal is open on the resident's approval daemon
  (`approval.state` `requested`). **A count only**: the held text stays in the
  map's `approval.payload` (R16), never in the brief.
- `published`: inferred intentions published to Index (`approval.state`
  `published` and `published` true, not archived since) within the last
  `RECEIPT_WINDOW_S` (14 days) and not in the excluded ids, oldest first, at
  most `MAX_ITEMS` (`publishedCount` is the total). `approvedBy` is
  `individual` (`authorization: grant`), `rule` (`authorization: policy`), or
  null when the entry does not say. No text: R16 deletes it at publish, so the
  brief looks the words up on Index by `indexIntentId`. `publishedAt` is the
  entry's last change, which for a published entry is the publish (a published
  proposal is final).
- `skipped`: entries that could not be read (a bad timestamp, a wrong type);
  each is skipped alone, never the whole answer.

Never counted or returned: stated intentions (`intent.publish.stated.index`),
entries kept local (a personal capture has no proposal), entries held before
approvals were on, proposals not yet filed, refused, cleared, being started or
published, or ended any other way.

**Switches.** `AV_RECORD_INTENTION`, `AV_APPROVAL_ENABLED` and `AV_APPROVAL_URL`
are read like `_core.env` (the process environment, else `$HERMES_HOME/.env`):
this runs as a child of the cron's terminal, which may not carry the gateway's
environment. That differs on purpose from `_approval` (process environment
only, S2): there it guards a publish; here it only decides whether the brief
mentions what the map already holds.

**No lock.** Every writer replaces the map with `os.replace`, so a reader sees
one whole version or the other; taking the writers' flock would make this
reader create the lock file.

Python 3.11, standard library only. Never prints the map, any text, a key, or a token.
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
import math
import re
import sys
import time
from datetime import datetime, timezone
from typing import Any, Iterable, Optional

from ._approval import ENABLED_ENV as APPROVAL_ENABLED_ENV
from ._approval import TRUTHY as APPROVAL_TRUTHY
from ._approval import URL_ENV as APPROVAL_URL_ENV
from ._core import env
from ._intent_approval import INFERRED_CLASS, approval_of, valid_shape
from ._intentions import RESTRICTIVE_SOURCE, valid_id
from ._record_intention import ARCHIVED_KEY, SWITCH, TRUTHY, map_path

READER_VERSION = 2
#: The one approval state that means "asked, no answer yet".
HELD_STATE = "requested"
PUBLISHED_STATE = "published"
#: A publish stays eligible for a receipt until a delivered brief carried it
#: or this long has passed (two weeks of failed briefs). The brief keeps its
#: receipt log longer than this (`RECEIPT_KEEP_DAYS` in intention-brief.ts).
RECEIPT_WINDOW_S = 14 * 86400.0
MAX_ITEMS = 20
APPROVED_BY = {"grant": "individual", "policy": "rule"}
#: 2001-09-09 .. 2100-01-01: anything outside is not a time this map wrote.
MIN_STAMP = 1e9
MAX_STAMP = 4102444800.0
#: The ids the brief's marker grammar accepts (`<!-- digest-receipt:id=ID -->`).
BRIEF_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


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
    stamp = float(value)
    if not math.isfinite(stamp) or not MIN_STAMP <= stamp <= MAX_STAMP:
        return None
    return stamp


def _inferred(intention_id: str, entry: dict) -> Optional[dict]:
    """The entry's proposal when it is a well-formed inferred one, else None."""
    ap = approval_of(entry)
    if ap is None or ap.get("class") != INFERRED_CLASS or not valid_shape(intention_id, ap):
        return None
    if entry.get("source") != RESTRICTIVE_SOURCE:
        return None
    return ap


def _published_item(intention_id: str, entry: dict, ap: dict, now: float) -> Optional[tuple[float, dict]]:
    if entry.get("published") is not True or entry.get(ARCHIVED_KEY) is True:
        return None
    index_id = entry.get("index_intent_id")
    at = _stamp(ap.get("updated_at"))
    if not BRIEF_ID.fullmatch(intention_id) or not isinstance(index_id, str) or not BRIEF_ID.fullmatch(index_id) or at is None:
        return None
    if now - at > RECEIPT_WINDOW_S:
        return None
    return at, {
        "id": intention_id,
        "indexIntentId": index_id,
        "publishedAt": _iso(at),
        "approvedBy": APPROVED_BY.get(ap.get("authorization")),
    }


def collect(entries: dict[str, dict], now: float, exclude: Iterable[str] = ()) -> dict:
    excluded = set(exclude)
    held = 0
    skipped = 0
    published: list[tuple[float, str, dict]] = []
    for intention_id, entry in entries.items():
        try:
            ap = _inferred(intention_id, entry)
            if ap is None:
                continue
            state = ap.get("state")
            if state == HELD_STATE:
                held += 1
            elif state == PUBLISHED_STATE and intention_id not in excluded:
                item = _published_item(intention_id, entry, ap, now)
                if item is not None:
                    published.append((item[0], intention_id, item[1]))
        except Exception:  # noqa: BLE001 - one bad entry never blanks the answer
            skipped += 1
    published.sort(key=lambda row: (row[0], row[1]))
    return {
        "heldCount": held,
        "published": [item for _, _, item in published[:MAX_ITEMS]],
        "publishedCount": len(published),
        "skipped": skipped,
    }


def brief_items(now: Optional[float] = None, exclude: Iterable[str] = ()) -> dict:
    """The reader's whole answer (see the module docstring). Never raises."""
    answer: dict[str, Any] = {"v": READER_VERSION, "status": "ok", "reason": None,
                              "heldCount": 0, "published": [], "publishedCount": 0, "skipped": 0}
    try:
        on, reason = enabled()
        if not on:
            answer.update(status="off", reason=reason)
            return answer
        answer.update(collect(read_map(), time.time() if now is None else float(now), exclude))
    except MapUnreadable:
        answer.update(status="error", reason="map_unreadable")
    except Exception as exc:  # noqa: BLE001 - the brief goes out without these lines
        answer.update(status="error", reason=f"internal_{type(exc).__name__}", heldCount=0, published=[],
                      publishedCount=0)
    return answer


def _excluded_from(raw: str) -> list[str]:
    try:
        value = json.loads(raw) if raw.strip() else []
    except ValueError:
        return []
    return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []


def main(argv: list[str]) -> int:
    now: Optional[float] = None
    if "--now" in argv:
        try:
            now = float(argv[argv.index("--now") + 1])
        except (IndexError, ValueError):
            now = None
    exclude: list[str] = []
    if "--exclude-stdin" in argv:
        try:
            exclude = _excluded_from(sys.stdin.read(1 << 20))
        except Exception:  # noqa: BLE001
            exclude = []
    print(json.dumps(brief_items(now, exclude), ensure_ascii=False, separators=(",", ":")))
    return 0


__all__ = ["MAX_ITEMS", "READER_VERSION", "RECEIPT_WINDOW_S", "brief_items", "collect", "enabled", "main", "read_map"]
