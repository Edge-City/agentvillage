"""DATA-28 refutation fixes outside the EdgeOS path: H2, M1, M2, M4, M5 and two surviving mutants."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import sqlite3
import stat
import time
import uuid
from datetime import datetime, timezone

import pytest

TENANT = "8c3d1f2e-4a5b-4c6d-9e7f-0a1b2c3d4e5f"


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    ctx.fire("on_session_start", session_id="s", model="m", platform="telegram")
    return plugin


def of_type(av, plugin, event_type):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == event_type]


def make_executions(home, rows, *, with_delivery=True):
    cron = home / "cron"
    cron.mkdir(exist_ok=True)
    columns = "id TEXT, job_id TEXT, status TEXT, claimed_at TEXT, started_at TEXT, finished_at TEXT, error TEXT"
    if with_delivery:
        columns += ", delivery_outcome TEXT"
    with sqlite3.connect(cron / "executions.db") as conn:
        conn.execute(f"CREATE TABLE executions ({columns})")
        for row in rows:
            conn.execute(f"INSERT INTO executions VALUES ({','.join('?' * len(row))})", row)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------
# H2 — job names from an exact allowlist
# --------------------------------------------------------------------------


@pytest.mark.parametrize("name,expected", [
    ("Edge — daily digest", "Edge — daily digest"),
    ("Edge — memory signal sync", "Edge — memory signal sync"),
    ("Edge — remind Alice about her diagnosis", None),  # prefix spoof
    ("Edge — daily digest ", None),
    ("edge — daily digest", None),
    ("remind me to call my sister", None),
])
def test_only_exact_installer_job_names_leave(live, av, home, name, expected):
    now = now_iso()
    make_executions(home, [("e1", "job1", "completed", now, now, now, None, "delivered")])
    (home / "cron" / "jobs.json").write_text(json.dumps({"jobs": [{"id": "job1", "name": name}]}))
    live._COLLECTOR.cron_tick()
    assert of_type(av, live, "cron.run")[0]["payload"]["job_name"] == expected


def test_the_job_name_seed_loads(plugin):
    cron = __import__(f"{plugin.__name__}._cron", fromlist=["_cron"])
    names = cron.load_job_name_allowlist()
    assert "Edge — daily digest" in names and len(names) == 8
    assert cron.load_job_name_allowlist("/nonexistent.json") == frozenset()


# --------------------------------------------------------------------------
# M2 — delivery outcome and silent replies
# --------------------------------------------------------------------------


@pytest.mark.parametrize("outcome,expected", [
    ("delivered", "delivered"), ("suppressed", "suppressed"), ("suppressed_acked", "suppressed_acked"),
    ("not_configured", "not_configured"), ("failed", "failed"), ("queued", "queued"),
    ("Sent to Alice", "other"), (None, None),
])
def test_cron_run_carries_hermes_delivery_outcome(live, av, home, outcome, expected):
    now = now_iso()
    make_executions(home, [("e1", "job1", "completed", now, now, now, None, outcome)])
    live._COLLECTOR.cron_tick()
    payload = of_type(av, live, "cron.run")[0]["payload"]
    assert payload["delivery_outcome"] == expected
    assert "Alice" not in json.dumps(payload)


def test_a_ledger_without_the_delivery_column_still_reads(live, av, home):
    """`delivery_outcome` is not a column at `v2026.8.31`."""
    now = now_iso()
    make_executions(home, [("e1", "job1", "completed", now, now, now, None)], with_delivery=False)
    assert live._COLLECTOR.cron_tick() == 1
    assert of_type(av, live, "cron.run")[0]["payload"]["delivery_outcome"] is None


def test_a_timestamp_without_a_timezone_is_dropped(live, av, home):
    naive = datetime.now().replace(tzinfo=None).isoformat()
    make_executions(home, [("e1", "job1", "completed", naive, naive, naive, None, None)])
    live._COLLECTOR.cron_tick()
    payload = of_type(av, live, "cron.run")[0]["payload"]
    assert payload["claimed_at"] is None and payload["started_at"] is None and payload["finished_at"] is None


@pytest.mark.parametrize("reply,silent", [
    ("[SILENT]", True),
    ("  [silent]  ", True),
    ("NO_REPLY", True),
    ("2 deals filtered\n\n[SILENT]", True),
    ("[SILENT] No changes detected", True),
    ("I considered staying [SILENT] but here is the summary.", False),
    ("Silent retry succeeded", False),
    ("Here is your digest.", False),
])
def test_a_cron_reply_says_whether_it_was_suppressed(live, ctx, av, reply, silent):
    session = "cron_job1_20260922_140000"
    ctx.fire("on_session_start", session_id=session, model="m", platform="cron")
    ctx.fire("post_llm_call", session_id=session, turn_id="t0", assistant_response=reply)
    out = [e for e in of_type(av, live, "message.out") if e["session_id"] == session][0]
    assert out["payload"]["silent"] is silent


def test_silent_is_null_outside_cron_and_on_message_in(live, ctx, av):
    ctx.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="[SILENT]")
    ctx.fire("post_llm_call", session_id="s", turn_id="t0", assistant_response="[SILENT]")
    assert [e["payload"]["silent"] for e in of_type(av, live, "message.in") + of_type(av, live, "message.out")] \
        == [None, None]


@pytest.mark.parametrize("mode", ["metadata", "sanitized", "full"])
def test_silent_rides_in_every_mode(plugin, ctx, monkeypatch, av, mode):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_CAPTURE", mode)
    plugin.register(ctx)
    session = "cron_job1_20260922_140000"
    ctx.fire("post_llm_call", session_id=session, turn_id="t0", assistant_response="[SILENT]")
    assert of_type(av, plugin, "message.out")[0]["payload"]["silent"] is True


# --------------------------------------------------------------------------
# M1 — both profiles, by kind
# --------------------------------------------------------------------------


def close(ctx, session):
    ctx.fire("on_session_start", session_id=session, model="m", platform="telegram")
    ctx.fire("on_session_finalize", session_id=session)


def test_both_profiles_are_reported_by_kind(live, ctx, av, home):
    (home / "memories").mkdir()
    (home / "memories" / "USER.md").write_text("memory profile\n")
    (home / "USER.md").write_text("landing profile\n")
    close(ctx, "s1")
    events = {e["payload"]["kind"]: e["payload"] for e in of_type(av, live, "profile.updated")}
    assert events["memory_profile"]["user_md_hash"] == hashlib.sha256(b"memory profile\n").hexdigest()
    assert events["landing_profile"]["user_md_hash"] == hashlib.sha256(b"landing profile\n").hexdigest()
    close(ctx, "s2")
    assert len(of_type(av, live, "profile.updated")) == 2
    (home / "USER.md").write_text("landing profile, enriched\n")
    close(ctx, "s3")
    kinds = [e["payload"]["kind"] for e in of_type(av, live, "profile.updated")]
    assert kinds[-1] == "landing_profile" and len(kinds) == 3


def test_the_first_profile_state_layout_is_migrated(live, ctx, av, home):
    (home / "memories").mkdir()
    (home / "memories" / "USER.md").write_text("memory profile\n")
    (home / "av-events").mkdir(exist_ok=True)
    (home / "av-events" / "profile.json").write_text(
        json.dumps({"user_md_hash": hashlib.sha256(b"memory profile\n").hexdigest()}))
    close(ctx, "s1")
    assert of_type(av, live, "profile.updated") == []


# --------------------------------------------------------------------------
# M4 — the tenant hash key
# --------------------------------------------------------------------------


def test_the_hash_key_is_64_hex_0600_and_stable(live, ctx, av, home):
    ctx.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="hi")
    path = home / "av-events" / "hash.key"
    key = path.read_text().strip()
    assert len(key) == 64 and int(key, 16) >= 0
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    first = of_type(av, live, "message.in")[0]["payload"]["content_hash"]
    live._COLLECTOR._hash_key = None  # as after a restart
    ctx.fire("pre_llm_call", session_id="s", turn_id="t1", user_message="hi")
    assert of_type(av, live, "message.in")[1]["payload"]["content_hash"] == first
    assert path.read_text().strip() == key


def test_a_malformed_key_is_replaced(live, ctx, av, home):
    (home / "av-events").mkdir(exist_ok=True)
    (home / "av-events" / "hash.key").write_text("not-a-key")
    ctx.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="hi")
    assert len((home / "av-events" / "hash.key").read_text().strip()) == 64
    assert of_type(av, live, "message.in")[0]["payload"]["content_hash"]


def _race_worker(module_name, directory, barrier, out):
    import sys as _sys

    collector_module = _sys.modules[f"{module_name}._collector"]
    barrier.wait()
    key = collector_module.load_or_create_key(directory)
    out.put(key.hex() if key else None)


def test_the_first_use_race_agrees_on_one_key(plugin, tmp_path):
    """Eight processes, all first users of the key, at once — a hundred times."""
    import multiprocessing

    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    context = multiprocessing.get_context("fork")
    for trial in range(100):
        directory = str(tmp_path / f"t{trial}" / "av-events")
        barrier = context.Barrier(8)
        out = context.Queue()
        workers = [context.Process(target=_race_worker, args=(plugin.__name__, directory, barrier, out))
                   for _ in range(8)]
        for worker in workers:
            worker.start()
        keys = {out.get(timeout=10) for _ in workers}
        for worker in workers:
            worker.join(timeout=10)
        on_disk = (tmp_path / f"t{trial}" / "av-events" / "hash.key").read_text().strip()
        assert keys == {on_disk}, (trial, keys)
        assert collector_module.load_or_create_key(directory).hex() == on_disk
        leftovers = [p.name for p in (tmp_path / f"t{trial}" / "av-events").iterdir() if p.name != "hash.key"]
        assert leftovers == [], leftovers


def _no_hard_links(*args, **kwargs):
    import errno

    raise PermissionError(errno.EPERM, "Operation not permitted")


def test_without_hard_links_the_key_is_created_once(plugin, tmp_path, monkeypatch):
    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    monkeypatch.setattr(os, "link", _no_hard_links)
    directory = tmp_path / "av-events"
    counters: dict = {}
    first = collector_module.load_or_create_key(str(directory), counters)
    assert first is not None and counters == {"hash_key_generated": 1}
    assert stat.S_IMODE(os.stat(directory / "hash.key").st_mode) == 0o600
    assert [p.name for p in directory.iterdir()] == ["hash.key"]
    for _ in range(3):
        assert collector_module.load_or_create_key(str(directory), counters) == first
    assert counters == {"hash_key_generated": 1}


def test_without_hard_links_the_first_use_race_still_agrees(plugin, tmp_path, monkeypatch):
    import multiprocessing

    monkeypatch.setattr(os, "link", _no_hard_links)  # inherited by the forked workers
    context = multiprocessing.get_context("fork")
    for trial in range(100):
        directory = str(tmp_path / f"t{trial}" / "av-events")
        barrier = context.Barrier(8)
        out = context.Queue()
        workers = [context.Process(target=_race_worker, args=(plugin.__name__, directory, barrier, out))
                   for _ in range(8)]
        for worker in workers:
            worker.start()
        keys = {out.get(timeout=10) for _ in workers}
        for worker in workers:
            worker.join(timeout=10)
        on_disk = (tmp_path / f"t{trial}" / "av-events" / "hash.key").read_text().strip()
        assert keys == {on_disk}, (trial, keys)


def test_a_key_caught_half_written_is_waited_for_not_replaced(plugin, tmp_path):
    import threading

    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    directory = tmp_path / "av-events"
    directory.mkdir()
    key = "cd" * 32
    (directory / "hash.key").write_text(key[:10])

    def finish():
        time.sleep(0.05)
        (directory / "hash.key").write_text(key)

    writer = threading.Thread(target=finish)
    writer.start()
    counters: dict = {}
    assert collector_module.load_or_create_key(str(directory), counters) == bytes.fromhex(key)
    writer.join()
    assert counters == {}


def test_a_transient_read_error_does_not_rotate_the_key(live, ctx, av, home, monkeypatch):
    import builtins

    ctx.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="hi")
    path = home / "av-events" / "hash.key"
    key = path.read_text()
    first = of_type(av, live, "message.in")[0]["payload"]["content_hash"]

    real_open = builtins.open
    failures = {"left": 1}

    def flaky_open(file, *args, **kwargs):
        if str(file) == str(path) and failures["left"]:
            failures["left"] -= 1
            raise PermissionError("transient")
        return real_open(file, *args, **kwargs)

    live._COLLECTOR._hash_key = None  # as in a fresh process
    monkeypatch.setattr(builtins, "open", flaky_open)
    ctx.fire("pre_llm_call", session_id="s", turn_id="t1", user_message="hi")
    assert path.read_text() == key  # not rotated
    assert of_type(av, live, "message.in")[1]["payload"]["content_hash"] is None
    assert live._COLLECTOR.counters["hash_key_unavailable"] == 1
    ctx.fire("pre_llm_call", session_id="s", turn_id="t2", user_message="hi")
    assert of_type(av, live, "message.in")[2]["payload"]["content_hash"] == first
    assert path.read_text() == key


def test_an_unmakeable_key_directory_disables_keying(plugin, tmp_path):
    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    blocker = tmp_path / "file"
    blocker.write_text("not a directory")
    counters: dict = {}
    assert collector_module.load_or_create_key(str(blocker / "av-events"), counters) is None
    assert counters == {}


def test_a_valid_key_is_never_rewritten(plugin, tmp_path):
    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    directory = tmp_path / "av-events"
    directory.mkdir()
    (directory / "hash.key").write_text("ab" * 32 + "\n")
    before = os.stat(directory / "hash.key").st_ino
    counters: dict = {}
    for _ in range(5):
        assert collector_module.load_or_create_key(str(directory), counters) == bytes.fromhex("ab" * 32)
    assert os.stat(directory / "hash.key").st_ino == before
    assert counters == {}


def test_the_buffer_recreates_a_deleted_directory(live, ctx, av, home):
    import shutil

    ctx.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="hi")
    shutil.rmtree(home / "av-events")
    ctx.fire("pre_llm_call", session_id="s", turn_id="t1", user_message="again")
    assert live._COLLECTOR.total_failures == 0
    assert of_type(av, live, "message.in")
    assert stat.S_IMODE(os.stat(home / "av-events" / "buffer").st_mode) == 0o700


def test_without_a_key_nothing_keyed_is_emitted(live, ctx, av, monkeypatch):
    monkeypatch.setattr(live._COLLECTOR, "hash_key", lambda: None)
    ctx.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="hi")
    ctx.fire("post_tool_call", session_id="s", tool_name="terminal", args={"command": "ls"}, result="x", status="ok")
    assert of_type(av, live, "message.in")[0]["payload"]["content_hash"] is None
    payload = of_type(av, live, "tool.call")[0]["payload"]
    assert payload["args_hash"] is None and payload["result_hash"] is None


def test_intention_hashes_stay_plain_sha256(live, ctx, av):
    ctx.fire("post_tool_call", session_id="s", tool_name="record_intention",
             args={"action": "capture", "text": "find a cofounder"}, result="{}", status="ok")
    payload = of_type(av, live, "intention.captured")[0]["payload"]
    assert payload["text_hash"] == hashlib.sha256(b"find a cofounder").hexdigest()


def test_two_tenants_hash_the_same_text_differently(plugin, ctx, monkeypatch, av, tmp_path):
    digests = []
    for name in ("a", "b"):
        home = tmp_path / name
        home.mkdir()
        monkeypatch.setenv("HERMES_HOME", str(home))
        module = av.load_plugin()
        module._COLLECTOR = None
        module._REGISTERED = False
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        c = type(ctx)()
        module.register(c)
        c.fire("pre_llm_call", session_id="s", turn_id="t0", user_message="yes")
        digests.append(of_type(av, module, "message.in")[0]["payload"]["content_hash"])
        module._COLLECTOR = None
    assert digests[0] != digests[1]


# --------------------------------------------------------------------------
# M5 — a TENANT_ID that is not a UUID
# --------------------------------------------------------------------------


def test_a_non_uuid_tenant_id_is_counted_and_logged_once(plugin, ctx, monkeypatch, caplog):
    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    monkeypatch.setattr(collector_module, "_LOGGED_COUNTERS", set())
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", "tenant-secret-slug")
    with caplog.at_level(logging.WARNING, logger="av-events"):
        plugin.register(ctx)
        plugin._COLLECTOR.reload_config()
        plugin._COLLECTOR.reload_config()
    assert plugin._COLLECTOR.counters["tenant_id_not_uuid"] == 3
    warnings = [r.getMessage() for r in caplog.records if "tenant_id_not_uuid" in r.getMessage()]
    assert len(warnings) == 1
    assert "tenant-secret-slug" not in caplog.text


def test_a_uuid_tenant_id_is_not_counted(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("TENANT_ID", TENANT)
    plugin.register(ctx)
    assert "tenant_id_not_uuid" not in plugin._COLLECTOR.counters


# --------------------------------------------------------------------------
# Surviving mutant — the state.db lock timeout
# --------------------------------------------------------------------------


def test_a_locked_state_db_costs_the_session_its_cost_not_the_hook_its_budget(live, ctx, av, home):
    with sqlite3.connect(home / "state.db") as conn:
        conn.execute("CREATE TABLE sessions (id TEXT, actual_cost_usd REAL, estimated_cost_usd REAL, "
                     "cost_status TEXT, cost_source TEXT)")
        conn.execute("INSERT INTO sessions VALUES ('s', 0.5, 0.5, 'actual', 'x')")
    holder = sqlite3.connect(home / "state.db", isolation_level=None)
    holder.execute("BEGIN EXCLUSIVE")
    try:
        started = time.perf_counter()
        ctx.fire("on_session_finalize", session_id="s")
        elapsed = time.perf_counter() - started
    finally:
        holder.execute("ROLLBACK")
        holder.close()
    assert elapsed < 1.0
    assert of_type(av, live, "session.ended")[0]["payload"]["actual_cost_usd"] is None


def test_uuid_helper_sanity():
    assert uuid.UUID(TENANT).version == 4
