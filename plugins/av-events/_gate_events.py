"""ov#357 refute M1 stopgap (b): `gate.unverified@1`, from av-approval's bus event.

av-approval's backstop publishes `av-approval:gate.unverified` once per change of its verdict: a
failure at start, a later failure found on a gated call, and the recovery; and, from
OV-GATE-RECOVERED, one `recovered` (no codes) at every clean gateway start (the gateway process
only), so a box fixed and restarted clears data's alarm then rather than by age. On an rc42+
box an `execute_code` program runs as the gateway's uid and can rewrite the approval shim; the
backstop then blocks gated calls, and this event is how anyone off the box learns of it.

* **Closed allow-list, every field validated** (`FIELDS`): `phase` (start|recheck|recovered),
  `codes` (a sorted list of distinct code names from `CODE_NAMES`, at most `MAX_CODES`; empty
  only for `recovered`, never empty otherwise), `ts` (epoch seconds). A record with a missing or
  extra field, or a field off its rule, is dropped whole and counted as `gate_dropped_<reason>`;
  never raised, and no value is logged. No path, matcher name or file content can pass: a code
  name is one of the fixed strings below.
* **`AV_GATE_EVENTS`**: ON unless set to an "off" spelling (`env_flag_disabled`), unlike the
  inventory and model switches. It is an alarm, it fires only when the gate breaks or recovers,
  and agentvillage-data's ingest accepts an unregistered type into quarantine (202, replayable
  once its schema ships: `src/ingest/events.ts`), so sending before data registers
  `gate.unverified@1` loses nothing and refuses no batch.

Runs inside `guarded` (`gate_events` in `AV_HOOKS_DISABLED` turns it off), actor `system`.
Python 3.11, standard library only.
"""

from __future__ import annotations

from typing import Any, Optional

from ._core import env_flag_disabled

BUS_EVENT = "av-approval:gate.unverified"
TYPE = "gate.unverified"
FLAG = "AV_GATE_EVENTS"
HOOK_NAME = "gate_events"
DROPPED = "gate_dropped_"
REASONS = ("missing_field", "extra_field", "bad_type", "bad_enum", "bad_shape", "bad_range", "switch_off")
PHASES = ("start", "recheck", "recovered")
#: av-approval's GATE_CODE_NAMES, character for character (a test on this side reads the plugin's).
CODE_NAMES = (
    "config-unreadable", "hooks-missing", "hook-missing", "fail-closed-off", "entry-timeout", "consent-missing",
    "allowlist-unusable", "allowlist-lock-unusable", "allowlist-lock-uncreatable", "shim-missing",
    "shim-not-executable", "manifest-missing", "shim-hash-mismatch", "shim-not-vendored",
    "shim-changed-since-start", "url-missing", "check-error", "other",
)
MAX_CODES = len(CODE_NAMES)
#: `ts`, epoch seconds: 2023-11-14 .. 2100-01-01.
TS_RANGE = (1700000000, 4102444800)
FIELD_NAMES = ("phase", "codes", "ts")


def rebuild(record: dict) -> tuple[Optional[dict], Optional[str]]:
    """(payload, None) with exactly FIELD_NAMES in order, or (None, reason). Never raises."""
    if any(key not in FIELD_NAMES for key in record):
        return None, "extra_field"
    if any(key not in record for key in FIELD_NAMES):
        return None, "missing_field"
    phase, codes, ts = record["phase"], record["codes"], record["ts"]
    if type(phase) is not str or type(codes) is not list or type(ts) is not int:
        return None, "bad_type"
    if phase not in PHASES:
        return None, "bad_enum"
    if len(codes) > MAX_CODES:
        return None, "bad_range"
    if any(type(c) is not str for c in codes):
        return None, "bad_type"
    if any(c not in CODE_NAMES for c in codes):
        return None, "bad_enum"
    if codes != sorted(set(codes)) or (phase == "recovered") != (not codes):
        return None, "bad_shape"
    if not TS_RANGE[0] <= ts <= TS_RANGE[1]:
        return None, "bad_range"
    return {"phase": phase, "codes": list(codes), "ts": ts}, None


# `collector` is positional-only: a publisher key named `collector` lands in `record` and drops as
# `extra_field`, instead of a TypeError that would count toward the process breaker.
def on_gate(collector: Any, /, **record: Any) -> None:
    if env_flag_disabled(FLAG):
        collector.count(DROPPED + "switch_off")
        return
    payload, reason = rebuild(record)
    if payload is None:
        collector.count(DROPPED + str(reason))
        return
    collector.emit(TYPE, payload, actor="system")
