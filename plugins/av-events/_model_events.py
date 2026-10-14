"""SEC-6 half 2: `model.observed@1` and `model.offlist@1`, from av-approval's bus events.

av-approval 0.5.0 (`plugins/av-approval`, approval's area; not yet written) observes the model id a
box actually sends (the `pre_api_request` wire body, and config.yaml's `model.default` on its
15-minute tick) and publishes it on the plugin event bus as `av-approval:model.observed`, plus
`av-approval:model.offlist` next to every observation its LOCAL allow-list calls off-list. It sends
fields only. This module turns them into events (SEC-6 model observer design §3, approval's lane of
14 Oct; the same publisher rules as SEC-3's `_plugin_events.py`, which this module copies rule for
rule):

* **Closed allow-list, every field validated** (`FIELDS`, the same rules as the `model_events`
  section of `tests/vectors/plugin_events_contract.json`, which av-approval's parity test reads
  too). A record with a missing or extra field, or a field not matching its rule, is dropped WHOLE
  and counted as `model_dropped_<reason>` (`REASONS`, the plugin events' set); never raised, never
  partly emitted, never hashed, and no value is ever logged. One exception, so that a box running an
  unrecognised model is still reported: a string `model` longer than 100 characters (checked
  first, before the regex) or not matching the cp's model id shape (`MODEL_ID`: upper case, no
  slash, a URL, a trailing newline) is sent as null, never lower-cased and never dropped; a
  `hermes_version` outside data's shape is sent as null too. A non-string where a string belongs is
  still `bad_type`; an `allowlist_version` that is not 12 lowercase hex drops the record.
* **Nothing `sanitize` would rewrite.** `Collector.emit` runs `_core.sanitize` over the payload
  after this module; a regex-valid model id such as `openai/sk-proj-<16 or more>` would leave as
  `openai/[redacted:openai_key]`, which fails data's schema and quarantines the event. So `rebuild`
  checks every string it keeps: if `sanitize` would change it, a nullable field is sent as null and
  any other field drops the record as `bad_shape`.
* **A fresh id per emit** (as `plugin.inventory`): each observation is its own row. av-approval
  dedupes per process (first sight) and data dedupes the alert (tenant, model, reason) for 24 h, so
  a re-send or two processes sending the same id are bounded duplicates by design.
* **`AV_MODEL_EVENTS`** (`1|true|yes|on`, the plugin's one switch reader `env_flag_on`) is read on
  every delivery, default off, separate from `AV_PLUGIN_EVENTS`: off drops and counts
  `model_dropped_switch_off`, without a log line (`_QUIET_COUNTERS` in `_collector.py`). Off until
  data's DATA-477 release registering both types is live (ingest quarantines an unknown type).

Both run inside `guarded` (`model_events` in `AV_HOOKS_DISABLED` turns them off), actor `system`.
`collector` is positional-only in both bodies, so a publisher key named `collector` is an extra
field, not a TypeError. Python 3.11, standard library only.
"""

from __future__ import annotations

import re
from typing import Any, Optional

from ._core import env_flag_on, sanitize
from ._plugin_events import HERMES_VERSION, REASONS

OBSERVED_BUS_EVENT = "av-approval:model.observed"
OFFLIST_BUS_EVENT = "av-approval:model.offlist"
OBSERVED_TYPE = "model.observed"
OFFLIST_TYPE = "model.offlist"
#: Off until data's DATA-477 release that registers both types is live.
FLAG = "AV_MODEL_EVENTS"
#: The subscriptions' name in `AV_HOOKS_DISABLED` and the hook stats.
HOOK_NAME = "model_events"
DROPPED = "model_dropped_"

#: The cp's `MODEL_ID` = agentvillage-data's `AGENT_MODEL_ID_PATTERN`: `vendor/model`, lower case,
#: an optional `:variant` (`:free`) in the model part. Never lower-cased here: `OpenAI/GPT-4o` is null.
MODEL_ID = r"^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:-]*$"
#: Longest model id kept; checked before the regex, so a long string is never scanned.
MODEL_MAX_LENGTH = 100
#: `ts`, epoch seconds: 2023-11-14 .. 2100-01-01.
TS_RANGE = [1700000000, 4102444800]

#: Payload order, both types (SEC-6 design §3).
FIELD_NAMES = ("model", "source", "trigger", "off_list_local", "allowlist_version", "hermes_version", "ts")


def _rules() -> dict[str, dict]:
    """A fresh rule table per type, so a test or caller that edits one never edits the other."""
    return {
        "model": {"kind": "regex", "regex": MODEL_ID, "nullable": True, "mismatch": "null", "max_length": MODEL_MAX_LENGTH},
        "source": {"kind": "enum", "enum": ["request", "config_default", "session_override"], "nullable": False},
        "trigger": {"kind": "enum", "enum": ["first_sight", "daily"], "nullable": False},
        "off_list_local": {"kind": "bool", "nullable": True},
        "allowlist_version": {"kind": "regex", "regex": r"^[0-9a-f]{12}$", "nullable": True, "mismatch": "drop"},
        "hermes_version": {"kind": "regex", "regex": HERMES_VERSION, "nullable": True, "mismatch": "null"},
        "ts": {"kind": "int", "range": list(TS_RANGE), "nullable": False, "above": "drop"},
    }


#: Event type -> field -> rule, in payload order. Both types carry the same closed fields.
FIELDS: dict[str, dict[str, dict]] = {OBSERVED_TYPE: _rules(), OFFLIST_TYPE: _rules()}
_PATTERNS = {(t, k): re.compile(r["regex"]) for t, rules in FIELDS.items() for k, r in rules.items() if r["kind"] == "regex"}


def rebuild(event_type: str, record: dict) -> tuple[Optional[dict], Optional[str]]:
    """(payload, None) with exactly FIELDS[event_type] in order, or (None, reason). Never raises
    on any value: types are checked (`type() is`, so no bool for int and no str subclass) before
    anything else touches a value; a string's length is checked before its regex; and `sanitize`
    only ever sees a short string that already matched its enum or shape."""
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
            if value < low or value > high:
                return None, "bad_range"
        elif kind == "bool":
            if type(value) is not bool:
                return None, "bad_type"
        elif type(value) is not str:
            return None, "bad_type"
        elif kind == "enum":
            if value not in rule["enum"]:
                return None, "bad_enum"
        elif len(value) > rule.get("max_length", len(value)) or not _PATTERNS[(event_type, key)].fullmatch(value):
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


def _deliver(event_type: str, collector: Any, record: dict) -> None:
    if not env_flag_on(FLAG):
        collector.count(DROPPED + "switch_off")
        return
    payload, reason = rebuild(event_type, record)
    if payload is None:
        collector.count(DROPPED + str(reason))
        return
    # No event_id: `Collector.envelope` gives a fresh uuid v7 per emit.
    collector.emit(event_type, payload, actor="system")


# `collector` is positional-only: a publisher key named `collector` lands in `record` and drops as
# `extra_field`, instead of a TypeError that would count toward the process breaker.
def on_observed(collector: Any, /, **record: Any) -> None:
    _deliver(OBSERVED_TYPE, collector, record)


def on_offlist(collector: Any, /, **record: Any) -> None:
    _deliver(OFFLIST_TYPE, collector, record)


__all__ = [
    "DROPPED", "FIELDS", "FIELD_NAMES", "FLAG", "HOOK_NAME", "MODEL_ID", "MODEL_MAX_LENGTH", "OBSERVED_BUS_EVENT",
    "OFFLIST_BUS_EVENT", "REASONS", "TS_RANGE", "on_observed", "on_offlist", "rebuild",
]
