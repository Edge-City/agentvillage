"""SEC-3: `plugin.inventory@1` and `plugin.unknown@1`, from av-approval's bus events.

av-approval (`plugins/av-approval`, approval's area) runs a plugin inventory at load, on each later
discovery pass and on a 15-minute tick, and publishes what it found on the plugin event bus as
`av-approval:plugin.inventory` (one per pass) and `av-approval:plugin.unknown` (one per unknown
plugin key per state). It sends fields only. This module turns them into events (SEC-3 design
§2(b) seam 4 and §4.1; the lead's ruling of 13 Oct 09:41Z; intro's three changes of 09:43Z; the
round-2 changes from the ov#317 refute and from data's and approval's contract reads):

* **Closed allow-list, every field validated** (`FIELDS`, the same rules as
  `tests/vectors/plugin_events_contract.json`, which av-approval's parity test reads too). A record
  with a missing or extra field, or a field not matching its rule, is dropped WHOLE and counted as
  `plugin_dropped_<reason>` (`REASONS`); never raised, never partly emitted, never hashed, and no
  value is ever logged. Two exceptions, so that an unknown plugin is still reported:
  - a string `name`, `install_host` or `hermes_version` that does not match its shape (a URL, a
    path, upper case, a port, a word in a version) is sent as null (`mismatch: "null"`);
  - `tools` and `hooks` above 1000 are sent as 1000 (`above: "clamp"`): a plugin cannot hide by
    registering 1001 hooks. A negative count, and any count of the inventory above 10000, still drop.
  A non-string where a string belongs is still `bad_type`.
* **Nothing `sanitize` would rewrite.** `Collector.emit` runs `_core.sanitize` over the payload
  after this module; a valid-shaped value such as a plugin key `sk-proj-…` would leave as
  `[redacted:…]`, which fails data's schema and quarantines the event. So `rebuild` checks every
  string it keeps: if `sanitize` would change it, a nullable field is sent as null and any other
  field drops the record as `bad_shape`.
* **`plugin.unknown`'s id is derived here**: a v7 over the tenant's keyed hash (`Collector.keyed_hash`,
  HMAC-SHA256 under `hash.key`) of
  `av-events|plugin.unknown|<name_hash>|<revision or "">|<state>|<action>|<source>`, so a re-send
  is one row at ingest, while a changed outcome (`none` then `unloaded_unlisted` or
  `unlist_failed`) or source is a new row. No field in the tuple can hold `|` (hex, hex or empty,
  and three enums). Keyed, because ingest's `event_id` is unique across tenants: a plain derivation
  would let two tenants with the same plugin collide, and let one box claim another's id ahead of
  time.
* **Duplicates, by design and bounded:** `plugin.inventory` takes a fresh id per emit, so every
  pass is its own row (two processes that both run discovery send two). `plugin.unknown` takes a
  fresh id when the tenant key is missing (an unreadable state dir), and a new derived id once
  after `hash.key` is replaced (rotation, a corrupt key, a rebuilt box). Data's alert reads
  "latest" or "any", so neither breaks it.
* **`AV_PLUGIN_EVENTS`** (`1|true|yes|on`, the plugin's one switch reader) is read on every
  delivery, default off: off drops and counts `switch_off`, without a log line (`_QUIET_COUNTERS`
  in `_collector.py`). Off until the data release registering both types is live (ingest
  quarantines an unknown type).

Both run inside `guarded` (`plugin_events` in `AV_HOOKS_DISABLED` turns them off), actor `system`.
`collector` is positional-only in both bodies, so a publisher key named `collector` is an extra
field, not a TypeError. Python 3.11, standard library only.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ._core import derived_uuid7, env_flag_on, sanitize

INVENTORY_BUS_EVENT = "av-approval:plugin.inventory"
UNKNOWN_BUS_EVENT = "av-approval:plugin.unknown"
INVENTORY_TYPE = "plugin.inventory"
UNKNOWN_TYPE = "plugin.unknown"
#: Off until the data release that registers both types is live.
FLAG = "AV_PLUGIN_EVENTS"
#: The subscriptions' name in `AV_HOOKS_DISABLED` and the hook stats.
HOOK_NAME = "plugin_events"
DROPPED = "plugin_dropped_"
REASONS = ("missing_field", "extra_field", "bad_type", "bad_enum", "bad_shape", "bad_range", "switch_off")
ID_PREFIX = "av-events|plugin.unknown"

#: A plugin key: lower case, at most one `/` (a bundled `category/name`), no `..`, at most 64.
NAME = r"^(?=[a-z0-9._/-]{1,64}$)(?!.*[.][.])[a-z0-9][a-z0-9._-]*(?:/[a-z0-9][a-z0-9._-]*)?$"
#: agentvillage-data's `hermesVersion` (`src/schemas/index.ts`, DATA-106 F5), character for
#: character: a release with PEP 440 pre/post/dev parts and a setuptools_scm local part, or a bare
#: 7..40 hex commit. No segment can hold a word.
HERMES_SEGMENT = r"(?:g[0-9a-f]{7,40}|d[0-9]{8}|rc[0-9]{1,4}|dev[0-9]{1,6}|post[0-9]{1,4}|[0-9]{1,8})"
HERMES_VERSION = (
    r"^(?:v?[0-9]{1,6}(?:\.[0-9]{1,6}){1,3}(?:(?:a|b|rc)[0-9]{1,4})?(?:\.post[0-9]{1,4})?(?:\.dev[0-9]{1,6})?"
    r"(?:[-+]" + HERMES_SEGMENT + r"(?:\." + HERMES_SEGMENT + r"){0,3})?|[0-9a-f]{7,40})$"
)


def _enum(*values: str) -> dict:
    return {"kind": "enum", "enum": list(values), "nullable": False}


def _count(hi: int, above: str = "drop") -> dict:
    return {"kind": "int", "range": [0, hi], "nullable": False, "above": above}


def _regex(pattern: str, nullable: bool = False, mismatch: str = "drop") -> dict:
    return {"kind": "regex", "regex": pattern, "nullable": nullable, "mismatch": mismatch}


#: Event type -> field -> rule, in payload order (SEC-3 design §4.1, as amended in round 2).
FIELDS: dict[str, dict[str, dict]] = {
    INVENTORY_TYPE: {
        "trigger": _enum("boot", "loaded", "tick", "daily"),
        "mode": _enum("report", "quarantine", "off"),
        "expected_loaded": _count(10000),
        "expected_missing": _count(10000),
        "bundled_loaded": _count(10000),
        "unknown_count": _count(10000),
        "allowed_count": _count(10000),
        "expected_set_version": _regex(r"^[0-9a-f]{12}$"),
        "hermes_version": _regex(HERMES_VERSION, nullable=True, mismatch="null"),
    },
    UNKNOWN_TYPE: {
        "name": _regex(NAME, nullable=True, mismatch="null"),
        "name_hash": _regex(r"^[0-9a-f]{16,64}$"),
        "source": _enum("user", "project", "entrypoint", "bundled_path_mismatch"),
        "state": _enum("loaded", "enabled_not_loaded", "dir_only", "overrides_bundled"),
        # The host alone, lower case: no scheme, port or path (§4.1 "else null").
        "install_host": _regex(r"^[a-z0-9.-]{1,253}$", nullable=True, mismatch="null"),
        "revision": _regex(r"^[0-9a-f]{40}$", nullable=True),
        "pinned": {"kind": "bool", "nullable": True},
        "tools": _count(1000, above="clamp"),
        "hooks": _count(1000, above="clamp"),
        "action": _enum("none", "unlisted", "unloaded_unlisted", "unlist_failed"),
    },
}
_PATTERNS = {(t, k): re.compile(r["regex"]) for t, rules in FIELDS.items() for k, r in rules.items() if r["kind"] == "regex"}


def rebuild(event_type: str, record: dict) -> tuple[Optional[dict], Optional[str]]:
    """(payload, None) with exactly FIELDS[event_type] in order, or (None, reason). Never raises
    on any value: types are checked (`type() is`, so no bool for int and no str subclass) before
    anything else touches a value, and `sanitize` only ever sees a short string that already
    matched its enum or shape."""
    rules = FIELDS[event_type]
    if any(key not in rules for key in record):
        return None, "extra_field"
    if any(key not in record for key in rules):
        return None, "missing_field"
    payload: dict[str, Any] = {}
    for key, rule in rules.items():
        value, kind = record[key], rule["kind"]
        if value is None:
            if not rule["nullable"]:
                return None, "bad_type"
        elif kind == "int":
            if type(value) is not int:
                return None, "bad_type"
            low, high = rule["range"]
            if value < low:
                return None, "bad_range"
            if value > high:
                if rule["above"] != "clamp":
                    return None, "bad_range"
                value = high
        elif kind == "bool":
            if type(value) is not bool:
                return None, "bad_type"
        elif type(value) is not str:
            return None, "bad_type"
        elif kind == "enum":
            if value not in rule["enum"]:
                return None, "bad_enum"
        elif not _PATTERNS[(event_type, key)].fullmatch(value):
            if rule["mismatch"] != "null":
                return None, "bad_shape"
            value = None
        if type(value) is str and sanitize(value) != value:
            # `Collector.emit` would redact it, and data would quarantine the redaction.
            if not rule["nullable"]:
                return None, "bad_shape"
            value = None
        payload[key] = value
    return payload, None


def unknown_event_id(collector: Any, payload: dict) -> Optional[str]:
    """The derived v7 for a `plugin.unknown` payload, or None (a fresh id) without the tenant key."""
    material = "|".join((ID_PREFIX, payload["name_hash"], payload["revision"] or "", payload["state"], payload["action"], payload["source"]))
    keyed = collector.keyed_hash(material)
    return derived_uuid7(0, keyed) if keyed else None


def _deliver(event_type: str, collector: Any, record: dict) -> None:
    if not env_flag_on(FLAG):
        collector.count(DROPPED + "switch_off")
        return
    payload, reason = rebuild(event_type, record)
    if payload is None:
        collector.count(DROPPED + str(reason))
        return
    refs: dict[str, Any] = {"actor": "system"}
    if event_type == UNKNOWN_TYPE:
        event_id = unknown_event_id(collector, payload)
        if event_id:
            refs["event_id"] = event_id
    collector.emit(event_type, payload, **refs)


# `collector` is positional-only: a publisher key named `collector` lands in `record` and drops as
# `extra_field`, instead of a TypeError that would count toward the process breaker.
def on_inventory(collector: Any, /, **record: Any) -> None:
    _deliver(INVENTORY_TYPE, collector, record)


def on_unknown(collector: Any, /, **record: Any) -> None:
    _deliver(UNKNOWN_TYPE, collector, record)


__all__ = ["DROPPED", "FIELDS", "FLAG", "HERMES_VERSION", "HOOK_NAME", "INVENTORY_BUS_EVENT", "REASONS", "UNKNOWN_BUS_EVENT", "on_inventory", "on_unknown", "rebuild", "unknown_event_id"]
