"""`cron.run` from tailing Hermes's cron executions ledger (spec §4.1, §4.3, §7.1)."""

from __future__ import annotations

import hashlib
import json
import sqlite3
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

#: The namespace `agentvillage-data/src/ids.ts` pins. Written out here rather
#: than imported, so a change to the plugin's constant fails this test.
NS_AV = uuid.UUID("6d1f2d4e-6a6b-5c29-9b3a-0f0f9b1d4a11")
TENANT = "tenant-0b7d"
JOB = "ab12cd34ef56"
JOB2 = "0123456789ab"


def X(label: str) -> str:
    """A readable label in Hermes's execution-id shape, `uuid4().hex` (DATA-92)."""
    return hashlib.md5(label.encode()).hexdigest()
IST = timezone(timedelta(hours=5, minutes=30))

#: The `executions` table as `cron/executions.py` creates it at `v2026.8.31`.
SCHEMA = """CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL,
    pid INTEGER NOT NULL, process_started_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('claimed','running','completed','failed','unknown')),
    claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT)"""


def stamp(seconds_ago: float) -> str:
    """How Hermes writes it: `hermes_time.now().isoformat()`, local offset and all."""
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).astimezone(IST).isoformat()


class CronHome:
    def __init__(self, home):
        self.dir = home / "cron"
        self.dir.mkdir(parents=True, exist_ok=True)
        self.db = self.dir / "executions.db"
        with sqlite3.connect(self.db) as conn:
            conn.execute(SCHEMA)

    def execution(self, execution_id, *, job=JOB, status="completed", ago=60.0, duration=30.0,
                  error="Traceback: the prompt for Alice failed"):
        with sqlite3.connect(self.db) as conn:
            conn.execute(
                "INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (execution_id, job, "tick", "p", 1, None, status, stamp(ago + duration + 1),
                 stamp(ago + duration), stamp(ago) if status in ("completed", "failed", "unknown") else None,
                 error if status != "completed" else None),
            )

    def jobs(self, **names):
        (self.dir / "jobs.json").write_text(json.dumps({"jobs": [{"id": k, "name": v} for k, v in names.items()]}))

    def installed(self, *ids):
        """What `install/install_index.ts` records for the jobs it created."""
        state = self.dir.parent / "av-events"
        state.mkdir(exist_ok=True)
        (state / "installed_jobs.json").write_text(json.dumps({"ids": list(ids)}))

    def audit(self, *, job=JOB, ago=61.0, prompt=1200, completion=80):
        ts = (datetime.now(timezone.utc) - timedelta(seconds=ago)).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"
        line = {"ts": ts, "job_id": job, "fire_id": uuid.uuid4().hex, "prompt_tokens": prompt,
                "completion_tokens": completion, "total_tokens": prompt + completion,
                "response_silent": False, "deliver_target": "telegram:123456789", "model": "m",
                "duration_ms": 30000, "error": None}
        with open(self.dir / "usage_audit.jsonl", "a", encoding="utf-8") as handle:
            handle.write(json.dumps(line) + "\n")


@pytest.fixture()
def cron(home):
    return CronHome(home)


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", TENANT)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    return plugin


def runs(av, plugin):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "cron.run"]


def test_a_finished_execution_is_one_cron_run_with_the_derived_id(live, cron, av):
    execution = uuid.uuid4().hex
    cron.execution(execution)
    cron.jobs(**{JOB: "Edge — daily digest"})
    cron.installed(JOB)
    cron.audit()
    assert live._COLLECTOR.cron_tick() == 1
    events = runs(av, live)
    assert len(events) == 1
    event = events[0]
    assert event["event_id"] == str(uuid.uuid5(NS_AV, f"{TENANT}|cron|{execution}"))
    assert uuid.UUID(event["event_id"]).version == 5
    payload = event["payload"]
    for key in ("job_id", "job_name", "execution_id", "status", "input_tokens", "started_at", "finished_at"):
        assert key in payload, key
    assert payload["job_id"] == JOB
    assert payload["job_name"] == "Edge — daily digest"
    assert payload["execution_id"] == execution
    assert payload["status"] == "completed"
    assert payload["input_tokens"] == 1200
    assert payload["output_tokens"] == 80
    assert payload["finished_at"].endswith("Z") and payload["started_at"] < payload["finished_at"]
    assert event["occurred_at"] == payload["finished_at"]
    assert event["occurred_at_earliest"] == payload["started_at"]
    assert event["run_id"] == f"cron:{JOB}:{execution}"
    assert event["actor"] == "system"
    assert event["session_id"] is None


def test_the_id_matches_the_ingest_formula_for_every_execution(live, cron, av):
    ids = [uuid.uuid4().hex for _ in range(3)]
    for n, execution in enumerate(ids):
        cron.execution(execution, ago=60 + n * 100)
    live._COLLECTOR.cron_tick()
    got = {e["payload"]["execution_id"]: e["event_id"] for e in runs(av, live)}
    assert got == {x: str(uuid.uuid5(NS_AV, f"{TENANT}|cron|{x}")) for x in ids}


def test_without_a_tenant_id_the_event_id_is_a_v7(plugin, ctx, monkeypatch, cron, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    cron.execution(uuid.uuid4().hex)
    plugin._COLLECTOR.cron_tick()
    assert uuid.UUID(runs(av, plugin)[0]["event_id"]).version == 7


def _second_collector(plugin):
    """Another plugin-loading process on the same `$HERMES_HOME` (the
    dashboard beside the gateway): its own collector and cursor, one ledger."""
    import sys

    collector = sys.modules[f"{plugin.__name__}._collector"].Collector()
    collector._stop.set()  # ticked by hand
    return collector


def test_without_a_tenant_id_two_processes_derive_the_same_id(plugin, ctx, monkeypatch, cron, av):
    """DATA-185: every plugin-loading process ticks the cron tail, and each
    reads the cursor once. The dashboard, started before the run finished,
    reports it again after the gateway has; ingest must see one event_id."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.delenv("TENANT_ID", raising=False)
    monkeypatch.delenv("AV_TENANT_ID", raising=False)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    gateway, dashboard = plugin._COLLECTOR, _second_collector(plugin)
    assert gateway.config.tenant_id == "" and dashboard.config.tenant_id == ""
    assert dashboard.cron_tick() == 0  # its cursor is loaded now, and never re-read
    execution = X("exec-dup")
    cron.execution(execution)
    assert gateway.cron_tick() == 1
    assert dashboard.cron_tick() == 1  # the duplicate the cursor cannot stop
    # One buffer directory, both processes' files: read it once.
    ids = [e["event_id"] for e in av.read_buffer(gateway) if e["event_type"] == "cron.run"]
    assert len(ids) == 2 and len(set(ids)) == 1, ids
    assert uuid.UUID(ids[0]).version == 7  # the only kind ingest takes without the tenant


def test_the_tenantless_id_is_a_v7_timed_by_the_finish_and_keyed_by_the_execution(plugin):
    import sys

    core = sys.modules[f"{plugin.__name__}._core"]
    first = core.cron_run_event_id_without_tenant(X("a"), 1_790_000_000_123)
    assert first == core.cron_run_event_id_without_tenant(X("a"), 1_790_000_000_123)
    assert first != core.cron_run_event_id_without_tenant(X("b"), 1_790_000_000_123)
    parsed = uuid.UUID(first)
    assert parsed.version == 7 and parsed.variant == uuid.RFC_4122
    assert int.from_bytes(parsed.bytes[:6], "big") == 1_790_000_000_123


def test_av_tenant_id_overrides_tenant_id(plugin, ctx, monkeypatch, cron, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", "wrong")
    monkeypatch.setenv("AV_TENANT_ID", TENANT)
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    execution = uuid.uuid4().hex
    cron.execution(execution)
    plugin._COLLECTOR.cron_tick()
    assert runs(av, plugin)[0]["event_id"] == str(uuid.uuid5(NS_AV, f"{TENANT}|cron|{execution}"))


def test_an_execution_is_reported_once_across_ticks_and_restarts(live, cron, av, ctx):
    cron.execution(X("exec-1"))
    assert live._COLLECTOR.cron_tick() == 1
    assert live._COLLECTOR.cron_tick() == 0
    cron.execution(X("exec-2"))
    assert live._COLLECTOR.cron_tick() == 1

    module = av.load_plugin()
    module._COLLECTOR = None
    module._REGISTERED = False
    ctx2 = type(ctx)()
    module.register(ctx2)
    try:
        ctx2.fire("on_session_start", session_id="s2", model="m", platform="telegram")
        assert module._COLLECTOR.cron_tick() == 0
    finally:
        module._COLLECTOR = None
        module._REGISTERED = False
    assert sorted(e["payload"]["execution_id"] for e in runs(av, live)) == sorted([X("exec-1"), X("exec-2")])


def test_running_and_claimed_executions_wait(live, cron, av):
    cron.execution(X("exec-run"), status="running")
    cron.execution(X("exec-claim"), status="claimed")
    assert live._COLLECTOR.cron_tick() == 0


@pytest.mark.parametrize("status", ["failed", "unknown"])
def test_failed_and_unknown_are_reported_without_their_error_text(live, cron, av, status):
    cron.execution(X("exec-f"), status=status)
    live._COLLECTOR.cron_tick()
    event = runs(av, live)[0]
    assert event["payload"]["status"] == status
    assert "Traceback" not in json.dumps(event) and "Alice" not in json.dumps(event)


def test_history_older_than_72_hours_is_not_reported(live, cron, av):
    cron.execution(X("exec-old"), ago=73 * 3600)
    cron.execution(X("exec-new"), ago=60)
    live._COLLECTOR.cron_tick()
    assert [e["payload"]["execution_id"] for e in runs(av, live)] == [X("exec-new")]


def test_a_participant_named_job_does_not_leave_by_name(live, cron, av):
    cron.execution(X("exec-1"), job=JOB2)
    cron.jobs(**{JOB2: "remind me to call my sister about the divorce"})
    cron.installed(JOB, JOB2)
    live._COLLECTOR.cron_tick()
    event = runs(av, live)[0]
    assert event["payload"]["job_name"] is None
    assert "sister" not in json.dumps(av.read_buffer(live._COLLECTOR))


def test_a_participant_job_with_an_installer_name_reports_no_name(live, cron, av):
    """DATA-92 AC #1: the name is on the allowlist, the job id is not the installer's."""
    cron.execution(X("installer"), job=JOB)
    cron.execution(X("participant"), job=JOB2)
    cron.jobs(**{JOB: "Edge — daily digest", JOB2: "Edge — daily digest"})
    cron.installed(JOB)
    live._COLLECTOR.cron_tick()
    names = {e["payload"]["job_id"]: e["payload"]["job_name"] for e in runs(av, live)}
    assert names == {JOB: "Edge — daily digest", JOB2: None}


def test_without_the_installer_record_no_name_leaves(live, cron, av):
    cron.execution(X("exec-1"))
    cron.jobs(**{JOB: "Edge — daily digest"})
    live._COLLECTOR.cron_tick()
    assert runs(av, live)[0]["payload"]["job_name"] is None


@pytest.mark.parametrize("job,execution", [
    ("job1", X("exec-1")),              # a hand-edited jobs.json id
    ("AB12CD34EF56", X("exec-1")),      # upper case: not what ingest takes
    ("ab12cd34ef5", X("exec-1")),       # 11 hex
    (JOB, "exec-1"),                    # an execution id of the wrong shape
    (JOB, X("exec-1")[:31]),
])
def test_a_non_hex_id_yields_no_cron_run(live, cron, av, job, execution):
    """DATA-92 AC #2: ingest would quarantine it, so it is not sent."""
    cron.execution(execution, job=job)
    cron.jobs(**{job: "Edge — daily digest"})
    cron.installed(JOB)
    assert live._COLLECTOR.cron_tick() == 0
    assert runs(av, live) == []


def test_an_ambiguous_audit_match_reports_no_tokens(live, cron, av):
    cron.execution(X("exec-1"))
    cron.audit(ago=61)
    cron.audit(ago=70)
    live._COLLECTOR.cron_tick()
    payload = runs(av, live)[0]["payload"]
    assert payload["input_tokens"] is None and payload["output_tokens"] is None


def test_an_audit_line_for_another_job_or_time_is_not_joined(live, cron, av):
    cron.execution(X("exec-1"))
    cron.audit(job="other-job", ago=61)
    cron.audit(ago=3600)
    live._COLLECTOR.cron_tick()
    assert runs(av, live)[0]["payload"]["input_tokens"] is None


def test_no_ledger_means_nothing(live, av, home):
    assert live._COLLECTOR.cron_tick() == 0
    assert runs(av, live) == []


def test_a_corrupt_ledger_fails_open(live, av, home):
    (home / "cron").mkdir()
    (home / "cron" / "executions.db").write_bytes(b"this is not a database")
    assert live._COLLECTOR.cron_tick() == 0
    assert runs(av, live) == []


def test_a_tail_that_raises_is_counted_not_propagated(live, cron, av, monkeypatch):
    collector_module = __import__(f"{live.__name__}._collector", fromlist=["_collector"])
    monkeypatch.setattr(collector_module, "pending_runs", lambda *a, **k: 1 / 0)
    assert live._COLLECTOR.cron_tick() == 0
    assert live._COLLECTOR.cron_errors == 1


def test_no_token_means_no_cron_runs_and_no_cursor(plugin, ctx, cron, av, home):
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    cron.execution(X("exec-1"))
    assert plugin._COLLECTOR.cron_tick() == 0
    assert not (home / "av-events" / "cron_cursor.json").exists()


def test_an_inert_emit_does_not_advance_the_cursor(live, cron, av, monkeypatch):
    cron.execution(X("exec-1"))
    collector = live._COLLECTOR
    real_emit = collector.emit
    inert = {"on": True}
    monkeypatch.setattr(collector, "emit", lambda *a, **k: None if inert["on"] else real_emit(*a, **k))
    assert collector.cron_tick() == 0
    inert["on"] = False
    assert collector.cron_tick() == 1


def test_cron_run_can_be_switched_off(plugin, ctx, monkeypatch, cron, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "cron_run")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    cron.execution(X("exec-1"))
    assert plugin._COLLECTOR.cron_tick() == 0


def test_the_flusher_loop_runs_the_tail(live, cron, av, monkeypatch):
    collector_module = __import__(f"{live.__name__}._collector", fromlist=["_collector"])
    monkeypatch.setattr(collector_module, "CRON_POLL_INTERVAL_S", 0.0)
    monkeypatch.setattr(collector_module, "TICK_INTERVAL_S", 0.01)
    cron.execution(X("exec-loop"))
    collector = live._COLLECTOR
    collector._ensure_thread()
    deadline = time.time() + 5
    while time.time() < deadline and not runs(av, live):
        time.sleep(0.05)
    assert [e["payload"]["execution_id"] for e in runs(av, live)] == [X("exec-loop")]


@pytest.mark.parametrize("session,task,expected", [
    ("cron_ab12cd34ef56_20260922_140000", None, "ab12cd34ef56"),
    ("sess-1", f"cron:ab12cd34ef56:{'0' * 32}", "ab12cd34ef56"),
    # DATA-92: ingest takes 12 lower-case hex only; any other shape is no job.
    ("cron_job_with_underscores_20260922_140000", None, None),
    ("sess-1", "cron:job9:exec", None),
    ("cron_AB12CD34EF56_20260922_140000", None, None),
    ("sess-1", "task-1", None),
    ("cron_", None, None),
])
def test_cron_job_id_from_session_and_task(plugin, session, task, expected):
    cron_module = __import__(f"{plugin.__name__}._cron", fromlist=["_cron"])
    assert cron_module.cron_job_id_from(session, task) == expected


def test_session_events_of_a_cron_session_carry_the_job(live, ctx, av):
    session = f"cron_{JOB}_20260922_140000"
    ctx.fire("on_session_start", session_id=session, model="m", platform="cron")
    ctx.fire("on_session_finalize", session_id=session)
    events = [e for e in av.read_buffer(live._COLLECTOR) if e["session_id"] == session]
    assert {e["event_type"]: e["payload"]["cron_job_id"] for e in events} == {
        "session.started": JOB, "session.ended": JOB,
    }
