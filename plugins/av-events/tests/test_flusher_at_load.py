"""DATA-362: the flusher, and with it the cron tail, starts at plugin load.

A resident whose cron runs all stay silent (every pre-run gate answers
`wakeAgent: false`) never fires a hook. When the flusher started only at the
first emitted event, such a gateway never ran `cron_tick`, wrote no
`cron_cursor.json` and emitted no `cron.run`, and the tenant read as dead in
`core.scheduled_job_runs`. These tests hold plugin load to starting it in the
one process that takes the cron tail lock, every other active process to a
standby thread that sends nothing until it has an event or the lock, and to
everything that stayed true: no thread without a token, with a null sink or
with the plugin off; one thread however the start is reached; one `cron.run`
per execution.
"""

from __future__ import annotations


import hashlib
import sqlite3
import sys
import threading
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest

fcntl = pytest.importorskip("fcntl")

#: The namespace `agentvillage-data/src/ids.ts` pins (as in `test_cron_run.py`).
NS_AV = uuid.UUID("6d1f2d4e-6a6b-5c29-9b3a-0f0f9b1d4a11")
TENANT = "48de9369-0000-4000-8000-000000000000"
JOB = "ab12cd34ef56"

#: The `executions` table as `cron/executions.py` creates it at `v2026.8.31`.
SCHEMA = """CREATE TABLE executions (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, source TEXT NOT NULL, process_id TEXT NOT NULL,
    pid INTEGER NOT NULL, process_started_at INTEGER,
    status TEXT NOT NULL CHECK(status IN ('claimed','running','completed','failed','unknown')),
    claimed_at TEXT NOT NULL, started_at TEXT, finished_at TEXT, error TEXT)"""


def X(label: str) -> str:
    """A readable label in Hermes's execution-id shape, `uuid4().hex`."""
    return hashlib.md5(label.encode()).hexdigest()


def stamp(seconds_ago: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds_ago)).isoformat()


def ledger(home, *executions: str) -> None:
    """`cron/executions.db` holding one completed run per id, as a silent
    (suppressed) cron run leaves it: the row is written, no hook fires."""
    cron = home / "cron"
    cron.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(cron / "executions.db") as conn:
        exists = conn.execute("SELECT name FROM sqlite_master WHERE name = 'executions'").fetchone()
        if not exists:
            conn.execute(SCHEMA)
        for execution_id in executions:
            conn.execute(
                "INSERT INTO executions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                (execution_id, JOB, "tick", "p", 1, None, "completed", stamp(92), stamp(91), stamp(60), None),
            )


def modules(plugin):
    return sys.modules[f"{plugin.__name__}._collector"], sys.modules[f"{plugin.__name__}._core"]


@pytest.fixture()
def fast(plugin, monkeypatch):
    """The flusher's loop at test speed: a tick every 10 ms, the cron tail on
    every tick. Read at run time, so patching before `register` is enough."""
    collector_mod, _ = modules(plugin)
    monkeypatch.setattr(collector_mod, "TICK_INTERVAL_S", 0.01)
    monkeypatch.setattr(collector_mod, "CRON_POLL_INTERVAL_S", 0.0)
    return collector_mod


def active_env(monkeypatch, url="http://127.0.0.1:9"):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_URL", url)
    monkeypatch.setenv("TENANT_ID", TENANT)


def cron_runs(av, collector):
    return [e for e in av.read_buffer(collector) if e["event_type"] == "cron.run"]


def wait_for(predicate, timeout=5.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


def flushers_of(collector):
    """Live threads running this collector's `_loop`."""
    out = []
    for thread in threading.enumerate():
        target = getattr(thread, "_target", None)
        if thread.is_alive() and getattr(target, "__self__", None) is collector:
            out.append(thread)
    return out


def hold_tail_lock(home):
    """What another live process that loaded the plugin first holds."""
    path = home / "av-events" / "cron_tail.lock"
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = open(path, "a+b")
    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    return handle


# --------------------------------------------------------------------------
# AC #1: a quiet gateway still reports its scheduled runs
# --------------------------------------------------------------------------


def test_load_starts_the_flusher_and_the_tail_with_no_hook_ever_fired(plugin, ctx, monkeypatch, home, av, fast):
    active_env(monkeypatch)
    ledger(home, X("silent-1"), X("silent-2"))
    plugin.register(ctx)  # and nothing else: no hook is fired in this test
    collector = plugin._COLLECTOR
    assert collector._thread is not None and collector._thread.daemon is True
    assert wait_for(lambda: len(cron_runs(av, collector)) == 2)
    events = cron_runs(av, collector)
    assert sorted(e["payload"]["execution_id"] for e in events) == sorted([X("silent-1"), X("silent-2")])
    assert {e["event_id"] for e in events} == {
        str(uuid.uuid5(NS_AV, f"{TENANT}|cron|{X('silent-1')}")),
        str(uuid.uuid5(NS_AV, f"{TENANT}|cron|{X('silent-2')}")),
    }
    assert (home / "av-events" / "cron_cursor.json").exists()
    assert collector.sessions == {}, "no hook ran"
    assert [e["event_type"] for e in av.read_buffer(collector)] == ["cron.run", "cron.run"]


def test_a_quiet_gateways_cron_run_reaches_ingest(plugin, ctx, monkeypatch, home, av, fast):
    _, core = modules(plugin)
    monkeypatch.setattr(core, "FLUSH_INTERVAL_S", 0.0)  # rotate on the next tick
    ledger(home, X("silent-1"))
    with av.StubIngest() as ingest:
        active_env(monkeypatch, url=ingest.url)
        plugin.register(ctx)
        assert wait_for(lambda: [e["event_type"] for e in ingest.received] == ["cron.run"])
        assert ingest.received[0]["payload"]["execution_id"] == X("silent-1")
        assert ingest.auth_headers[0] == "Bearer test-token"


def test_a_run_that_finishes_after_load_is_reported_too(plugin, ctx, monkeypatch, home, av, fast):
    active_env(monkeypatch)
    ledger(home)
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    assert collector._thread is not None
    ledger(home, X("later"))
    assert wait_for(lambda: [e["payload"]["execution_id"] for e in cron_runs(av, collector)] == [X("later")])


# --------------------------------------------------------------------------
# AC #2: idle tenants stay threadless; the start is idempotent
# --------------------------------------------------------------------------


def test_no_token_starts_no_thread_even_with_runs_to_report(plugin, ctx, monkeypatch, home, av, fast):
    ledger(home, X("silent-1"))
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    assert collector.config.idle is True
    assert collector._thread is None
    assert flushers_of(collector) == []
    assert not (home / "av-events").exists(), "no buffer, no lock, no cursor"


def test_a_null_sink_starts_no_thread_at_load(plugin, ctx, monkeypatch, home, fast):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")  # and no URL
    ledger(home, X("silent-1"))
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    assert collector.config.null_sink is True
    assert collector._thread is None
    assert not (home / "av-events" / "cron_tail.lock").exists()


def test_the_plugin_switched_off_starts_no_thread(plugin, ctx, monkeypatch, home, fast):
    active_env(monkeypatch)
    monkeypatch.setenv("AV_EVENTS_ENABLED", "0")
    ledger(home, X("silent-1"))
    plugin.register(ctx)
    assert plugin._COLLECTOR._thread is None
    assert not (home / "av-events").exists()


def test_an_event_after_the_load_start_reuses_the_one_flusher(plugin, ctx, monkeypatch, home, av, fast):
    active_env(monkeypatch)
    ledger(home, X("silent-1"))
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    first = collector._thread
    assert first is not None
    assert wait_for(lambda: len(cron_runs(av, collector)) == 1)
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    collector._ensure_thread()
    assert collector._thread is first
    assert flushers_of(collector) == [first]
    # The tail already reported the run: another pass, from the thread or
    # called here, finds it in the cursor.
    assert collector.cron_tick() == 0
    time.sleep(0.1)  # several more loop passes
    types = [e["event_type"] for e in av.read_buffer(collector)]
    assert types.count("cron.run") == 1
    assert types.count("session.started") == 1


def test_racing_starts_make_one_thread(plugin, monkeypatch, home, fast):
    active_env(monkeypatch)
    collector_mod, _ = modules(plugin)
    collector = collector_mod.Collector()
    collector._ensure_buffer()
    barrier = threading.Barrier(16)

    def start():
        barrier.wait()
        collector._ensure_thread()

    racers = [threading.Thread(target=start) for _ in range(16)]
    try:
        for racer in racers:
            racer.start()
        for racer in racers:
            racer.join(5)
        assert len(flushers_of(collector)) == 1
    finally:
        collector.retire()


# --------------------------------------------------------------------------
# One tail per $HERMES_HOME at load (the DATA-94 rule for a second process)
# --------------------------------------------------------------------------


def test_a_process_beside_the_tail_holder_waits_on_standby(plugin, ctx, monkeypatch, home, av, fast):
    active_env(monkeypatch)
    ledger(home, X("silent-1"))
    held = hold_tail_lock(home)
    try:
        plugin.register(ctx)
        collector = plugin._COLLECTOR
        standby = collector._thread
        assert standby is not None and standby.daemon is True
        assert not collector._flushing, "a second flusher started beside the cron tail holder"
        assert not collector._atexit_registered, "an exit flush registered on standby"
        assert collector._tail_lock is None
        time.sleep(0.2)  # many standby passes
        assert cron_runs(av, collector) == [], "the standby thread tailed cron"
        assert not collector._flushing
        # Its own first event makes the same thread the flusher, as before.
        ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
        assert collector._thread is standby and collector._flushing
        assert collector._atexit_registered
        assert flushers_of(collector) == [standby]
        assert wait_for(lambda: len(cron_runs(av, collector)) == 1)
    finally:
        held.close()


def test_the_tail_passes_to_a_standby_process_when_its_holder_goes(plugin, ctx, monkeypatch, home, av, fast):
    active_env(monkeypatch)
    ledger(home, X("silent-1"))
    held = hold_tail_lock(home)
    try:
        plugin.register(ctx)
        collector = plugin._COLLECTOR
        standby = collector._thread
        assert not collector._flushing
    finally:
        held.close()  # the holder exits, a CLI that overlapped a gateway restart
    assert wait_for(lambda: collector._flushing and collector._tail_lock is not None)
    assert collector._thread is standby
    assert wait_for(lambda: [e["payload"]["execution_id"] for e in cron_runs(av, collector)] == [X("silent-1")])
    assert collector.sessions == {}, "no hook ran"


def test_a_refused_token_hands_the_tail_lock_on(plugin, ctx, monkeypatch, home, av, fast):
    _, core = modules(plugin)
    monkeypatch.setattr(core, "FLUSH_INTERVAL_S", 0.0)
    ledger(home, X("silent-1"))
    with av.StubIngest(statuses=[401]) as ingest:
        active_env(monkeypatch, url=ingest.url)
        plugin.register(ctx)
        collector = plugin._COLLECTOR
        assert collector._tail_lock is not None
        assert wait_for(lambda: ingest.request_count >= 1 and collector._tail_lock is None)
        assert collector.counters.get("ingest_auth_rejected") == 1
        assert collector._flushing, "it keeps its own flusher and its backoff"
        hold_tail_lock(home).close()  # free for a process whose token works


def test_the_tail_passes_to_the_next_collector_after_an_unload(plugin, ctx, monkeypatch, home, fast):
    active_env(monkeypatch)
    plugin.register(ctx)
    first = plugin._COLLECTOR
    assert first._thread is not None and first._tail_lock is not None
    plugin._on_unload()
    assert first._tail_lock is None
    plugin.register(ctx)
    second = plugin._COLLECTOR
    assert second is not first
    assert second._thread is not None and second._tail_lock is not None


def test_without_flock_every_active_process_tails(plugin, ctx, monkeypatch, home, fast):
    """No locking here (no `fcntl`, a filesystem without `flock`): reporting
    wins, and ingest keeps one row per derived `cron.run` id."""
    active_env(monkeypatch)
    collector_mod, _ = modules(plugin)
    monkeypatch.setattr(collector_mod, "fcntl", None)
    plugin.register(ctx)
    assert plugin._COLLECTOR._thread is not None and plugin._COLLECTOR._flushing


def test_a_held_lock_never_blocks_the_load(plugin, ctx, monkeypatch, home, fast):
    active_env(monkeypatch)
    held = hold_tail_lock(home)
    try:
        started = time.monotonic()
        plugin.register(ctx)
        assert time.monotonic() - started < 1.0
    finally:
        held.close()
