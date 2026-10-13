"""The memory signal sync's run record, its caps, and `intention.inference_run@1`.

"Edge — memory signal sync" (01:00 IST, `install/install_index.ts`) is the one
path to an inferred (ambient) intent. Its preflight gate
(`skills/index-network/scripts/memory_signal_gate.py`) appends one record per
run to `$HERMES_HOME/av-events/memory_signal_runs.json` (counts and codes, under
`flock` on `memory_signal_runs.json.lock`): a run it stopped carries its
`exit_branch`; a run it woke carries none yet. This module completes a woken
run's record from what this plugin sees itself, and reports every run:

* `list_intents` in that cron session (the prompt's first tool step) sets
  `intents_listed` and `existing_intents` (the active intents in Index's answer);
* `record_intention` in that session first checks the caps here
  (`cap_refusal`): Index's intents listed in this run; at most one capture per
  run and per village night; none while an inferred approval card is open;
  never the text of a declined one again; never a want on a topic the resident
  declined twice (DREAM-1: `_core.topic_stopped` over the declined word sets the
  gate keeps in this file; a decline no longer pauses every other topic). A
  capture it lets through is noted on the record (`recorded_intent_id`, and the
  text, kept on the box only so a declined one is never proposed again);
* the model writes its outcome to `memory/heartbeat-state.json`
  (`memorySignals.lastOutcome`: `runId`, `exit`, `candidatesConsidered`);
* the flusher's cron tail (`Collector.cron_tick`), when the run's execution is
  terminal, completes the record and, with AV_INFERENCE_RUN_EVENTS on, emits
  `intention.inference_run@1` (DATA-470 ambient contract): one per run, gated
  runs included, with a v7 event id derived from the execution, so every
  plugin-loading process derives the same one.

The event carries no text: ids, codes, counts, the model name and tokens.

**Release order.** Ingest quarantines an unknown event type, so the flag stays
off until the data release that registers `intention.inference_run@1` is live;
then the overlay flag goes on. The record and the caps work with the flag off.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
from typing import Any, Callable, Optional

try:  # POSIX; without it the file is guarded by the in-process lock only.
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

from ._core import (DIR_MODE, FILE_MODE, derived_uuid7, env_flag_on, epoch_from_iso, fold_declined_topics, iso_from_epoch,
                    iso_from_text, loose_key, topic_stopped, topic_words)
from ._cron import INSTALLED_JOBS_FILE, load_installed_job_ids, load_job_names, match_audit, read_usage_audit

#: The installer's name for the job (`install/install_index.ts`, `cron_job_names.json`).
JOB_NAME = "Edge — memory signal sync"
#: The contract's `job` value for it.
JOB = "memory_signal_sync"
EVENT_TYPE = "intention.inference_run"
#: Off until the data release registering the type is live (the door first).
FLAG = "AV_INFERENCE_RUN_EVENTS"
#: `AV_HOOKS_DISABLED` name that stops the event (the record is still kept).
HOOK_NAME = "inference_run"

RUNS_FILE = os.path.join("av-events", "memory_signal_runs.json")
INPUTS_FILE = os.path.join("memory", "memory-signal-inputs.md")
STATE_FILE = os.path.join("memory", "heartbeat-state.json")
INTENTIONS_MAP = os.path.join("av-events", "intentions.json")
MAX_RUN_RECORDS = 30

EXIT_BRANCHES = (
    "gated_no_change", "no_candidate", "candidate_already_covered", "candidate_previously_declined",
    "capped", "recorded", "tool_unavailable", "error",
)
#: Tool refusals inside a woken run that are caps (the contract's `capped`: not a model judgement).
#: `recently_declined` is no longer refused (DREAM-1 dropped the 3-day pause); it stays here only so
#: a record a run refused with it before the roll still reads as `capped`.
CAP_REFUSALS = frozenset({"nightly_limit_reached", "inferred_card_open", "recently_declined"})
#: Tool refusals of a candidate the resident declined: the exact text (`previously_declined`), or a
#: topic declined twice (`topic_declined`, DREAM-1). Both are the contract's existing
#: `candidate_previously_declined`: no new exit branch, no new code on the event.
DECLINED_REFUSALS = frozenset({"previously_declined", "topic_declined"})
#: What the model may report in `memorySignals.lastOutcome.exit`.
MODEL_EXITS = frozenset({"no_candidate", "candidate_already_covered", "candidate_previously_declined",
                         "recorded", "tool_unavailable", "error"})
#: `intention.captured.origin` (additive, nullable).
ORIGINS = ("memory_signal_sync", "context_goal", "chat", "other")

INFERRED_CLASS = "intent.publish.inferred.index"
LIVE_STATES = frozenset({"unfiled", "requested", "cleared", "starting", "publishing"})
DECLINED_STATE = "rejected"
#: A woken run whose record is older than this is not "current" for a tool call.
CURRENT_RUN_MAX_AGE_S = 3 * 3600
#: Slack around an execution's window when matching the gate's record to it.
MATCH_SLACK_S = 5.0
MAX_CANDIDATES = 100

MODEL_PATTERN = re.compile(r"^[a-z0-9][a-z0-9./:_-]{0,63}$")
#: `error_code`: a CLOSED list (contract change 11 Oct 23:5xZ). These rows are kept for every
#: tenant, so the field is never a free string or an exception message; the detail stays local
#: (the run record's `gate_reason`, and a code-only log line).
ERROR_CODES = frozenset({"tool_unavailable", "model_error", "model_timeout", "io_error", "state_write_failed", "unknown"})
UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

_LOCK = threading.Lock()


def flag_on() -> bool:
    """The plugin's one switch reader (`_core.env_flag_on`), as every other av-events switch."""
    return env_flag_on(FLAG)


def _int(value: Any, cap: Optional[int] = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return 0
    return min(value, cap) if cap is not None else value


# ---- Which job ---------------------------------------------------------------


def is_memory_signal_job(home: str, job_id: Optional[str]) -> bool:
    """The installer's memory signal sync job: an installed id whose name is JOB_NAME."""
    if not job_id:
        return False
    if job_id not in load_installed_job_ids(os.path.join(home, INSTALLED_JOBS_FILE)):
        return False
    return load_job_names(os.path.join(home, "cron", "jobs.json")).get(job_id) == JOB_NAME


# ---- The run records -------------------------------------------------------------


class _Locked:
    """The in-process lock plus `flock` on `memory_signal_runs.json.lock`, which the gate takes too."""

    def __init__(self, home: str) -> None:
        self.path = os.path.join(home, RUNS_FILE + ".lock")
        self.fd: Optional[int] = None

    def __enter__(self) -> "_Locked":
        _LOCK.acquire()
        try:
            os.makedirs(os.path.dirname(self.path), mode=DIR_MODE, exist_ok=True)
            self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, FILE_MODE)
            if fcntl is not None:
                fcntl.flock(self.fd, fcntl.LOCK_EX)
        except BaseException:
            self._release()
            raise
        return self

    def _release(self) -> None:
        try:
            if self.fd is not None:
                if fcntl is not None:
                    fcntl.flock(self.fd, fcntl.LOCK_UN)
                os.close(self.fd)
        finally:
            self.fd = None
            _LOCK.release()

    def __exit__(self, *exc: Any) -> None:
        self._release()


def _read_json(path: str) -> Any:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def load_runs(home: str) -> list[dict]:
    data = _read_json(os.path.join(home, RUNS_FILE))
    runs = data.get("runs") if isinstance(data, dict) else None
    return [r for r in runs if isinstance(r, dict)] if isinstance(runs, list) else []


def _save_runs(home: str, runs: list[dict]) -> None:
    """Under the lock. Every other key of the gate-owned file (its committed `pointers`) is kept."""
    path = os.path.join(home, RUNS_FILE)
    doc = _read_json(path)
    doc = doc if isinstance(doc, dict) else {}
    doc["v"] = 1
    doc["runs"] = runs[-MAX_RUN_RECORDS:]
    fd, tmp = tempfile.mkstemp(prefix=".memory_signal_runs.", dir=os.path.dirname(path))
    try:
        os.fchmod(fd, FILE_MODE)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(doc, handle, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _started(run: dict) -> Optional[float]:
    return epoch_from_iso(iso_from_text(run.get("started_at")))


def _is_current(run: dict, now: float) -> bool:
    started = _started(run)
    return (run.get("woke") is True and not run.get("finished_at") and started is not None
            and 0 <= now - started <= CURRENT_RUN_MAX_AGE_S)


def current_run(home: str, now: float) -> Optional[dict]:
    """The woken run still in progress (the newest), or None."""
    for run in reversed(load_runs(home)):
        if _is_current(run, now):
            return run
    return None


def update_current_run(home: str, change: Callable[[dict], None], now: float) -> Optional[dict]:
    """Apply `change` to the current run's record under the lock; the record after, or None."""
    with _Locked(home):
        runs = load_runs(home)
        for run in reversed(runs):
            if _is_current(run, now):
                change(run)
                _save_runs(home, runs)
                return dict(run)
    return None


def active_intent_count(payload: Any) -> Optional[int]:
    """Active intents (neither archived nor paused) in a `list_intents` answer, or None if it names none."""
    if not isinstance(payload, dict):
        return None
    rows = payload.get("intents")
    if rows is None and isinstance(payload.get("data"), dict):
        rows = payload["data"].get("intents")
    if not isinstance(rows, list):
        return None
    return sum(
        1 for row in rows
        if isinstance(row, dict) and row.get("status") not in ("archived", "paused") and not row.get("archivedAt")
    )


def note_listed(home: str, count: Optional[int], now: float) -> Optional[dict]:
    """`list_intents` answered in the current run: the step order is kept, and the count noted."""
    def change(run: dict) -> None:
        run["intents_listed"] = True
        if count is not None:
            run["existing_intents"] = count

    return update_current_run(home, change, now)


def note_refused(home: str, code: str, now: float) -> Optional[dict]:
    """S4: the first refusal in a run ends the pass; later captures in the run are refused with it."""
    def change(run: dict) -> None:
        run.setdefault("refusal", code)

    return update_current_run(home, change, now)


# `loose_key` is `_core.loose_key`: one function, shared with the memory signal gate.


def note_recorded(home: str, intention_id: str, text: str, now: float) -> Optional[dict]:
    def change(run: dict) -> None:
        run["recorded_intent_id"] = intention_id
        run["recorded_text"] = text
        run["recorded_at"] = iso_from_epoch(now)

    return update_current_run(home, change, now)


# ---- The caps (record_intention in this pass) -----------------------------------------


def _inferred(entries: dict[str, dict]) -> dict[str, tuple[dict, dict]]:
    out = {}
    for intention_id, entry in entries.items():
        approval = entry.get("approval") if isinstance(entry, dict) else None
        if isinstance(approval, dict) and approval.get("class") == INFERRED_CLASS:
            out[intention_id] = (entry, approval)
    return out


def cap_refusal(home: str, now: float, entries: dict[str, dict], norm_hash: Optional[str],
                norm_hash_v2: Optional[str] = None, text: Optional[str] = None) -> Optional[str]:
    """Why this pass may not capture now (a code), or None. `entries` is the plugin's map."""
    run = current_run(home, now)
    if run is None:
        return "no_gate_run"
    if isinstance(run.get("refusal"), str):
        # The first refusal ended this pass.
        return run["refusal"]
    if run.get("intents_listed") is not True:
        return "intents_not_listed"
    if run.get("recorded_intent_id"):
        return "pass_limit_reached"
    night = run.get("village_date")
    for other in load_runs(home):
        if other.get("run_id") != run.get("run_id") and other.get("recorded_intent_id") and other.get("village_date") == night:
            return "nightly_limit_reached"
    inferred = _inferred(entries)
    if any(approval.get("state") in LIVE_STATES for _, approval in inferred.values()):
        return "inferred_card_open"
    for entry, approval in inferred.values():
        if approval.get("state") != DECLINED_STATE:
            continue
        if (norm_hash and entry.get("held_norm_hash") == norm_hash) or (
                norm_hash_v2 and entry.get("held_norm_hash_v2") == norm_hash_v2):
            return "previously_declined"
    declined_at = {i: approval.get("updated_at") for i, (_, approval) in inferred.items()
                   if approval.get("state") == DECLINED_STATE}
    runs = load_runs(home)
    key = loose_key(text)
    if key:
        for other in runs:
            if other.get("recorded_intent_id") in declined_at and loose_key(other.get("recorded_text")) == key:
                return "previously_declined"
    # DREAM-1: a topic declined twice. The word sets the gate kept, plus any decline it has not folded yet.
    if topic_stopped(topic_words(text), fold_declined_topics(_declined_topics(home), runs, declined_at)):
        return "topic_declined"
    return None


def _declined_topics(home: str) -> Any:
    """The gate's `declined_topics` in `memory_signal_runs.json` (read only here; the gate writes it)."""
    data = _read_json(os.path.join(home, RUNS_FILE))
    return data.get("declined_topics") if isinstance(data, dict) else None


# ---- The event ----------------------------------------------------------------------


def _outcome(home: str, run_id: Any) -> Optional[dict]:
    state = _read_json(os.path.join(home, STATE_FILE))
    signals = state.get("memorySignals") if isinstance(state, dict) else None
    outcome = signals.get("lastOutcome") if isinstance(signals, dict) else None
    if isinstance(outcome, dict) and run_id and outcome.get("runId") == run_id:
        return outcome
    return None


def last_known(home: str) -> dict:
    """S3: the counters a run that could not compute its own reports: the newest gate record's,
    else the gate's `memorySignals.lastSignal`, else 0 (never known); intents from the newest list."""
    out = {"memory_bytes": 0, "resident_messages_since_last_run": 0, "stated_goals": 0, "prior_declines": 0,
           "existing_intents": 0}
    state = _read_json(os.path.join(home, STATE_FILE))
    signals = state.get("memorySignals") if isinstance(state, dict) else None
    last = signals.get("lastSignal") if isinstance(signals, dict) else None
    if isinstance(last, dict):
        for key, field in (("memoryBytes", "memory_bytes"), ("substantiveMessages", "resident_messages_since_last_run"),
                           ("statedGoals", "stated_goals"), ("priorDeclines", "prior_declines")):
            out[field] = _int(last.get(key))
    runs = load_runs(home)
    for run in reversed(runs):
        if run.get("exit_branch") != "error" or run.get("gate_reason") not in ("gate_failed",):
            for field in ("memory_bytes", "resident_messages_since_last_run", "stated_goals", "prior_declines"):
                out[field] = _int(run.get(field))
            break
    for run in reversed(runs):
        if isinstance(run.get("existing_intents"), int) and not isinstance(run.get("existing_intents"), bool):
            out["existing_intents"] = _int(run.get("existing_intents"))
            break
    return out


def _model(audit: Optional[dict]) -> str:
    value = str((audit or {}).get("model") or "").strip().lower()
    return value if MODEL_PATTERN.match(value) else "unknown"


def _code(value: Any) -> str:
    return value if isinstance(value, str) and value in ERROR_CODES else "unknown"


def _failed_run_code(execution: dict, audit: Optional[dict]) -> str:
    """A woken run whose execution did not complete: a timeout or another model failure, read
    from Hermes's audit line locally (its text never leaves); `unknown` when Hermes cannot say."""
    if execution.get("status") == "unknown":
        return "unknown"
    error = str((audit or {}).get("error") or "").lower()
    if "timeout" in error or "timed out" in error or "deadline" in error:
        return "model_timeout"
    return "model_error"


def _match(runs: list[dict], earliest: Optional[float], latest: Optional[float]) -> Optional[dict]:
    if earliest is None or latest is None:
        return None
    hits = [r for r in runs if (s := _started(r)) is not None and earliest - MATCH_SLACK_S <= s <= latest + MATCH_SLACK_S]
    return hits[-1] if hits else None


def build(run: Optional[dict], execution: dict, audit: Optional[dict], outcome: Optional[dict],
          known: Optional[dict] = None) -> dict:
    """The closed `intention.inference_run@1` payload for one execution of the job.

    `run` is the gate's record (None when the gate left none), `execution` the
    `cron.run` payload, `audit` its usage line, `outcome` the model's
    `memorySignals.lastOutcome` for this run.
    """
    finished = execution.get("finished_at")
    started = (run or {}).get("started_at") or execution.get("started_at") or execution.get("claimed_at") or finished
    woke = bool(run and run.get("woke") is True)
    recorded_id = (run or {}).get("recorded_intent_id")
    recorded_id = recorded_id if isinstance(recorded_id, str) and UUID_PATTERN.match(recorded_id) else None
    considered = _int((outcome or {}).get("candidatesConsidered"), MAX_CANDIDATES) if woke else 0
    error_code: Optional[str] = None
    if run is None:
        # The gate left no record: it never ran, or died before writing one.
        exit_branch, error_code = "error", "unknown"
    elif not woke:
        exit_branch = run.get("exit_branch") if run.get("exit_branch") in EXIT_BRANCHES else "error"
        if exit_branch in ("error", "tool_unavailable"):
            error_code = _code(run.get("error_code"))
    elif recorded_id is not None:
        exit_branch, considered = "recorded", max(considered, 1)
    elif run.get("refusal") in CAP_REFUSALS:
        # The tool stopped the pass on a cap (a race the gate did not see): a cap, not a judgement.
        exit_branch = "capped"
    elif run.get("refusal") in DECLINED_REFUSALS:
        exit_branch = "candidate_previously_declined"
    elif run.get("refusal") == "caps_unknown":
        exit_branch, error_code = "error", "io_error"
    elif execution.get("status") != "completed":
        exit_branch, error_code = "error", _failed_run_code(execution, audit)
    else:
        said = (outcome or {}).get("exit")
        if said in ("no_candidate", "candidate_already_covered", "candidate_previously_declined"):
            exit_branch = said
        elif said == "tool_unavailable":
            exit_branch, error_code = "tool_unavailable", "tool_unavailable"
        elif said in ("error", "recorded"):
            # The model's own error, or a record the tool never confirmed.
            exit_branch, error_code = "error", "unknown"
        else:
            # A completed run that never wrote its outcome to the state file.
            exit_branch, error_code = "error", "state_write_failed"
    run_id = str((run or {}).get("run_id") or "")
    if not UUID_PATTERN.match(run_id):
        # No gate record (or a malformed one): a v7 derived from the execution, the same in every process.
        stamp = epoch_from_iso(iso_from_text(started))
        run_id = derived_uuid7(int(stamp * 1000) if stamp is not None else 0, f"av-events|inference_run_id|{execution.get('execution_id')}")
    counts = run if run is not None else (known or {})
    return {
        "run_id": run_id,
        "job": JOB,
        "started_at": iso_from_text(started),
        "finished_at": iso_from_text(finished),
        "exit_branch": exit_branch,
        "memory_bytes": _int(counts.get("memory_bytes")),
        "resident_messages_since_last_run": _int(counts.get("resident_messages_since_last_run")),
        "stated_goals": _int(counts.get("stated_goals")),
        "existing_intents": _int(counts.get("existing_intents")) if counts.get("existing_intents") is not None
        else _int((known or {}).get("existing_intents")),
        "prior_declines": _int(counts.get("prior_declines")),
        "candidates_considered": considered,
        "recorded_intent_id": recorded_id if exit_branch == "recorded" else None,
        "model": _model(audit) if woke else "none",
        "input_tokens": _int(execution.get("input_tokens")) if woke else 0,
        "output_tokens": _int(execution.get("output_tokens")) if woke else 0,
        "error_code": error_code,
    }


def failure_payload(execution: dict, home: Optional[str] = None) -> dict:
    """The event for a run whose record could not be completed (an unexpected exception):
    `error` / `unknown`, ids, times and zeros only. Never the exception or its message."""
    stamp = epoch_from_iso(iso_from_text(execution.get("started_at") or execution.get("claimed_at") or execution.get("finished_at")))
    finished = iso_from_text(execution.get("finished_at"))
    try:
        known = last_known(home) if home else {}
    except Exception:  # noqa: BLE001 - the report must still go out
        known = {}
    return {
        "run_id": derived_uuid7(int(stamp * 1000) if stamp is not None else 0,
                                f"av-events|inference_run_id|{execution.get('execution_id')}"),
        "job": JOB,
        "started_at": iso_from_text(execution.get("started_at") or execution.get("claimed_at")) or finished,
        "finished_at": finished,
        "exit_branch": "error",
        "memory_bytes": _int(known.get("memory_bytes")),
        "resident_messages_since_last_run": _int(known.get("resident_messages_since_last_run")),
        "stated_goals": _int(known.get("stated_goals")),
        "existing_intents": _int(known.get("existing_intents")),
        "prior_declines": _int(known.get("prior_declines")),
        "candidates_considered": 0,
        "recorded_intent_id": None,
        "model": "unknown",
        "input_tokens": _int(execution.get("input_tokens")),
        "output_tokens": _int(execution.get("output_tokens")),
        "error_code": "unknown",
    }


def event_id(execution: dict) -> str:
    """A v7 derived from the execution (ingest takes a plugin v5 for `cron.run` only)."""
    stamp = epoch_from_iso(execution.get("finished_at") or execution.get("started_at") or execution.get("claimed_at"))
    return derived_uuid7(int(stamp * 1000) if stamp is not None else 0, f"av-events|inference_run|{execution.get('execution_id')}")


def finalize(home: str, execution: dict) -> dict:
    """Complete the run's record for a terminal execution and return the event payload.

    The record gets its `finished_at` and `exit_branch`, and the model's inputs
    file is removed: resident text never outlives the run. Idempotent: a second
    process reading the same files builds the same payload.
    """
    earliest = epoch_from_iso(execution.get("claimed_at") or execution.get("started_at"))
    latest = epoch_from_iso(execution.get("finished_at"))
    with _Locked(home):
        runs = load_runs(home)
        run = _match(runs, earliest, latest)
        snapshot = dict(run) if run is not None else None
        outcome = _outcome(home, (snapshot or {}).get("run_id"))
        audits = read_usage_audit(os.path.join(home, "cron", "usage_audit.jsonl")) if snapshot and snapshot.get("woke") else []
        audit = match_audit(execution.get("job_id") or "", earliest, latest, audits) if audits else None
        known = last_known(home) if snapshot is None or snapshot.get("existing_intents") is None else None
        payload = build(snapshot, execution, audit, outcome, known)
        if run is not None and not run.get("finished_at"):
            run["finished_at"] = payload["finished_at"]
            run["exit_branch"] = payload["exit_branch"]
            run["error_code"] = payload["error_code"]
            run["candidates_considered"] = payload["candidates_considered"]
            _save_runs(home, runs)
    try:
        os.unlink(os.path.join(home, INPUTS_FILE))
    except OSError:
        pass
    return payload


__all__ = [
    "DECLINED_REFUSALS",
    "EVENT_TYPE",
    "EXIT_BRANCHES",
    "FLAG",
    "HOOK_NAME",
    "JOB",
    "JOB_NAME",
    "ORIGINS",
    "RUNS_FILE",
    "active_intent_count",
    "build",
    "cap_refusal",
    "current_run",
    "event_id",
    "failure_payload",
    "finalize",
    "flag_on",
    "fold_declined_topics",
    "is_memory_signal_job",
    "last_known",
    "load_runs",
    "loose_key",
    "note_listed",
    "note_refused",
    "note_recorded",
    "topic_stopped",
]
