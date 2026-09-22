"""`cron.run` from tailing Hermes's cron executions ledger (spec §4.1, §4.3, §7.1).

Hermes fires no hook when a cron job runs (`VALID_HOOKS` at `v2026.8.31` has
none), so the plugin reads what the scheduler already writes:

* `$HERMES_HOME/cron/executions.db` — the durable ledger, one row per
  attempt, `id` (the execution id), `job_id`, `status` ∈
  `claimed|running|completed|failed|unknown`, `claimed_at`, `started_at`,
  `finished_at` (`cron/executions.py`). Terminal states are immutable, so a
  terminal row is reported exactly once.
* `$HERMES_HOME/cron/usage_audit.jsonl` — one line per fire with `job_id`,
  `ts`, `prompt_tokens`, `completion_tokens` (`cron/scheduler.py`
  `_write_usage_audit`). It carries no execution id, so a line is joined to
  an execution only when it is the *one* line for that job inside the
  execution's window.
* `$HERMES_HOME/cron/jobs.json` — for the job's name.

All of it runs on the flusher thread, never in a hook. The stores are opened
read-only.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Callable, Optional

from ._core import MAX_BUFFER_AGE_S, epoch_from_iso, iso_from_text, sqlite_read

#: Statuses a finished execution can hold. Anything else is still running.
TERMINAL_STATUSES = ("completed", "failed", "unknown")

#: The exact names the installer gives its cron jobs, from the frozen seed
#: `cron_job_names.json` (a bun test fails if it drifts from
#: `install/install_index.ts`). Only these names leave: a participant can ask
#: the agent to create a job — even one whose name starts `Edge —` — and its
#: name is then their words. `cron.run` is on the ops allowlist and is kept
#: without research consent (spec §2.2), so it carries nothing a participant
#: wrote.
NAMES_SEED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "cron_job_names.json")


def load_job_name_allowlist(path: str = NAMES_SEED_FILE) -> frozenset:
    try:
        with open(path, encoding="utf-8") as handle:
            seed = json.load(handle)
    except (OSError, ValueError):
        return frozenset()
    names = seed.get("names") if isinstance(seed, dict) else None
    return frozenset(n for n in names if isinstance(n, str)) if isinstance(names, list) else frozenset()


OVERLAY_JOB_NAMES = load_job_name_allowlist()

#: Hermes's `delivery_outcome` vocabulary (`agent/monitoring/cron_health.py`
#: `_KNOWN_DELIVERY_OUTCOMES`, plus `queued` from later tags). The ledger
#: column exists only on Hermes versions after `v2026.8.31`; there it is null.
DELIVERY_OUTCOMES = frozenset({"queued", "delivered", "failed", "suppressed", "suppressed_acked", "not_configured"})

#: Tail of `usage_audit.jsonl` read per pass. A line is ~300 bytes; this is
#: well over a thousand fires.
MAX_AUDIT_BYTES = 512 * 1024

#: Execution ids remembered as already emitted. Hermes keeps at most 1000
#: terminal rows (`MAX_TERMINAL_EXECUTIONS`).
MAX_CURSOR_IDS = 4096

#: Slack either side of an execution's window when matching an audit line.
AUDIT_SLACK_S = 2.0

_ID = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_CRON_SESSION = re.compile(r"^cron_(.+)_\d{8}_\d{6}$")
_CRON_TASK = re.compile(r"^cron:([^:]+):")


def cron_job_id_from(session_id: Any, task_id: Any = None) -> Optional[str]:
    """The cron job a session or run belongs to, or None.

    Hermes names a cron session `cron_<job_id>_<YYYYmmdd>_<HHMMSS>` and its
    task `cron:<job_id>:<execution_id>` (`cron/scheduler.py` at `v2026.8.31`).
    """
    for text, pattern in ((task_id, _CRON_TASK), (session_id, _CRON_SESSION)):
        if isinstance(text, str):
            found = pattern.match(text)
            if found and _ID.match(found.group(1)):
                return found.group(1)
    return None


def read_terminal_executions(db_path: str) -> list[dict]:
    rows = sqlite_read(
        db_path,
        # `SELECT *`: `delivery_outcome` is a later column, and naming it would
        # fail the whole read on the pinned tag. `error` is never looked at.
        "SELECT * FROM executions WHERE status IN ('completed','failed','unknown')",
    )
    return rows or []


def read_usage_audit(path: str, max_bytes: int = MAX_AUDIT_BYTES) -> list[dict]:
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > max_bytes:
                handle.seek(size - max_bytes)
                handle.readline()  # drop the partial first line
            raw = handle.read()
    except OSError:
        return []
    out = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            record = json.loads(line)
        except ValueError:
            continue
        if isinstance(record, dict):
            out.append(record)
    return out


def load_job_names(path: str) -> dict[str, str]:
    try:
        with open(path, encoding="utf-8-sig") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    jobs = data.get("jobs") if isinstance(data, dict) else data
    out: dict[str, str] = {}
    for job in jobs if isinstance(jobs, list) else ():
        if isinstance(job, dict) and isinstance(job.get("id"), str) and isinstance(job.get("name"), str):
            out[job["id"]] = job["name"]
    return out


def reportable_job_name(name: Any, allowlist: frozenset = OVERLAY_JOB_NAMES) -> Optional[str]:
    """The job's name if it is exactly one the installer creates, else None."""
    return name if isinstance(name, str) and name in allowlist else None


def delivery_outcome(value: Any) -> Optional[str]:
    if not isinstance(value, str) or not value.strip():
        return None
    value = value.strip().lower()
    return value if value in DELIVERY_OUTCOMES else "other"


def _count(value: Any) -> Optional[int]:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        return None
    return value


def match_audit(job_id: str, earliest: Optional[float], latest: Optional[float], audits: list[dict]) -> Optional[dict]:
    """The single audit line for this job inside the window, or None."""
    if earliest is None or latest is None:
        return None
    hits = []
    for record in audits:
        if record.get("job_id") != job_id:
            continue
        stamp = epoch_from_iso(iso_from_text(record.get("ts")))
        if stamp is not None and earliest - AUDIT_SLACK_S <= stamp <= latest + AUDIT_SLACK_S:
            hits.append(record)
    return hits[0] if len(hits) == 1 else None


def cron_payload(row: dict, job_names: dict[str, str], audits: list[dict]) -> Optional[dict]:
    """§4.1 `cron.run`: `job_id`, `job_name`, `execution_id`, `status`,
    `input_tokens?`, `started_at`, `finished_at`. Every key always present.

    Not in §4.1: `output_tokens` (from the same audit line as `input_tokens`),
    `claimed_at`, and `delivery_outcome` (Hermes's enum; `suppressed` is a
    run whose reply was the silence marker). The execution's `error` text is
    never read.
    """
    execution_id, job_id, status = row.get("id"), row.get("job_id"), row.get("status")
    if not (isinstance(execution_id, str) and _ID.match(execution_id)):
        return None
    if not (isinstance(job_id, str) and _ID.match(job_id)) or status not in TERMINAL_STATUSES:
        return None
    claimed = iso_from_text(row.get("claimed_at"))
    started = iso_from_text(row.get("started_at"))
    finished = iso_from_text(row.get("finished_at"))
    audit = match_audit(job_id, epoch_from_iso(started or claimed), epoch_from_iso(finished), audits)
    return {
        "job_id": job_id,
        "job_name": reportable_job_name(job_names.get(job_id)),
        "execution_id": execution_id,
        "status": status,
        "input_tokens": _count(audit.get("prompt_tokens")) if audit else None,
        "output_tokens": _count(audit.get("completion_tokens")) if audit else None,
        "claimed_at": claimed,
        "started_at": started,
        "finished_at": finished,
        "delivery_outcome": delivery_outcome(row.get("delivery_outcome")),
    }


class CronCursor:
    """Execution ids already emitted, persisted under `$HERMES_HOME/av-events/`."""

    def __init__(self, path: str) -> None:
        self.path = path
        self.ids: dict[str, None] = {}
        self.loaded = False

    def load(self, read_json: Callable[[str], Any]) -> None:
        if self.loaded:
            return
        self.loaded = True
        data = read_json(self.path)
        emitted = data.get("emitted") if isinstance(data, dict) else None
        for item in emitted if isinstance(emitted, list) else ():
            if isinstance(item, str):
                self.ids[item] = None

    def add(self, execution_id: str) -> None:
        self.ids.pop(execution_id, None)
        self.ids[execution_id] = None
        while len(self.ids) > MAX_CURSOR_IDS:
            self.ids.pop(next(iter(self.ids)))

    def snapshot(self) -> dict:
        return {"emitted": list(self.ids)}


def pending_runs(home: str, cursor: CronCursor, now: float) -> list[dict]:
    """Payloads for terminal executions not yet emitted, oldest first.

    An execution that finished more than 72 hours ago is skipped: ingest would
    clamp its `occurred_at` anyway (§2.1), and on a first run it is history,
    not news.
    """
    cron_dir = os.path.join(home, "cron")
    rows = [r for r in read_terminal_executions(os.path.join(cron_dir, "executions.db")) if r.get("id") not in cursor.ids]
    fresh = []
    for row in rows:
        finished = epoch_from_iso(iso_from_text(row.get("finished_at")))
        if finished is not None and now - finished > MAX_BUFFER_AGE_S:
            continue
        fresh.append(row)
    if not fresh:
        return []
    job_names = load_job_names(os.path.join(cron_dir, "jobs.json"))
    audits = read_usage_audit(os.path.join(cron_dir, "usage_audit.jsonl"))
    payloads = [p for p in (cron_payload(row, job_names, audits) for row in fresh) if p is not None]
    payloads.sort(key=lambda p: (p["finished_at"] or "", p["execution_id"]))
    return payloads


__all__ = [
    "CronCursor",
    "DELIVERY_OUTCOMES",
    "OVERLAY_JOB_NAMES",
    "delivery_outcome",
    "load_job_name_allowlist",
    "TERMINAL_STATUSES",
    "cron_job_id_from",
    "cron_payload",
    "load_job_names",
    "match_audit",
    "pending_runs",
    "read_terminal_executions",
    "read_usage_audit",
    "reportable_job_name",
]
