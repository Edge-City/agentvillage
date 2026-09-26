"""DATA-94: a buffered event survives a gateway stop through `os._exit`.

The Hermes gateway leaves through `os._exit` (`gateway/run.py`
`_exit_after_graceful_shutdown`), which runs no `atexit` handler, so the
plugin's exit flush never runs there. What survives is the JSONL buffer on
disk; these tests hold the plugin to delivering it from the next process.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import textwrap
import time
from pathlib import Path

import pytest

#: Loads the plugin the way Hermes does (conftest `load_plugin`), registers it
#: against a minimal ctx, and exposes `fire`. Written to a file per test.
CHILD_PRELUDE = textwrap.dedent(
    """
    import importlib.util, json, os, sys, time, types

    PLUGIN_DIR = sys.argv[1]
    MODULE_NAME = "hermes_plugins.av_events"
    namespace = types.ModuleType("hermes_plugins")
    namespace.__path__ = []
    namespace.__package__ = "hermes_plugins"
    sys.modules["hermes_plugins"] = namespace
    spec = importlib.util.spec_from_file_location(
        MODULE_NAME, os.path.join(PLUGIN_DIR, "__init__.py"), submodule_search_locations=[PLUGIN_DIR]
    )
    plugin = importlib.util.module_from_spec(spec)
    plugin.__package__ = MODULE_NAME
    plugin.__path__ = [PLUGIN_DIR]
    sys.modules[MODULE_NAME] = plugin
    spec.loader.exec_module(plugin)

    class Ctx:
        def __init__(self):
            self.hooks = {}
        def register_hook(self, name, callback):
            self.hooks.setdefault(name, []).append(callback)
        def fire(self, name, **kwargs):
            for callback in self.hooks.get(name, []):
                callback(**kwargs)

    ctx = Ctx()
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    """
)

#: Process A: two sessions (a chat and a cron run) each finish a turn, well
#: inside the flush interval, then the process dies the way the gateway does.
CHILD_EMIT_THEN_EXIT = CHILD_PRELUDE + textwrap.dedent(
    """
    for session_id, platform in (("sess-chat-1", "telegram"), ("cron_abc123_20260926_101500", "cron")):
        ctx.fire("on_session_start", session_id=session_id, model="m", platform=platform)
        ctx.fire("on_session_end", session_id=session_id, completed=True, interrupted=False,
                 model="m", platform=platform)
    root = collector.config.buffer_dir
    ids = []
    for name in sorted(os.listdir(root)):
        if name.endswith(".jsonl"):
            with open(os.path.join(root, name), encoding="utf-8") as handle:
                ids += [json.loads(line)["event_id"] for line in handle if line.strip()]
    print(json.dumps({"pid": os.getpid(), "ids": ids, "files": sorted(os.listdir(root))}), flush=True)
    os._exit(0)
    """
)

#: Process B: the gateway comes back. It registers the plugin and nothing else
#: happens: no session, no hook. It waits to be killed.
CHILD_REGISTER_AND_IDLE = CHILD_PRELUDE + textwrap.dedent(
    """
    print("registered", flush=True)
    time.sleep(30)
    os._exit(0)
    """
)


def _child_env(home: Path, url: str) -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith("AV_") and k not in ("TENANT_ID",)}
    env.update(
        {
            "HERMES_HOME": str(home),
            "AV_EVENTS_TOKEN": "test-token",
            "AV_EVENTS_URL": url,
            "PYTHONDONTWRITEBYTECODE": "1",
        }
    )
    return env


def _run_child(script: str, path: Path, av, env: dict, *, wait: bool = True):
    path.write_text(script, encoding="utf-8")
    args = [sys.executable, str(path), str(av.PLUGIN_DIR)]
    if wait:
        return subprocess.run(args, env=env, capture_output=True, text=True, timeout=30)
    return subprocess.Popen(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def _wait_for(predicate, timeout: float = 10.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return predicate()


# --------------------------------------------------------------------------
# The real thing: os._exit in one process, delivery from the next
# --------------------------------------------------------------------------


def test_events_buffered_before_os_exit_are_delivered_by_the_next_process(home, av, tmp_path):
    with av.StubIngest() as ingest:
        env = _child_env(home, ingest.url)
        first = _run_child(CHILD_EMIT_THEN_EXIT, tmp_path / "a.py", av, env)
        assert first.returncode == 0, first.stderr[-2000:]
        report = json.loads(first.stdout.strip().splitlines()[-1])
        ids = report["ids"]
        # Both sessions' events, cron included, sit in the dead process's
        # current file: nothing was rotated, nothing was sent, and os._exit
        # ran no atexit flush.
        assert len(ids) == 2, report
        batches = [name for name in report["files"] if name.endswith(".jsonl")]
        assert batches == [f"current-{report['pid']}.jsonl"], report
        assert ingest.request_count == 0

        second = _run_child(CHILD_REGISTER_AND_IDLE, tmp_path / "b.py", av, env, wait=False)
        try:
            delivered = _wait_for(lambda: len(ingest.received) >= len(ids), timeout=10.0)
            time.sleep(1.5)  # a second tick must not send it again
        finally:
            second.kill()
            second.communicate(timeout=10)
        assert delivered, "the dead process's buffered events were never delivered"
        received = [event["event_id"] for event in ingest.received]
        assert sorted(received) == sorted(ids)
        assert len(received) == len(set(received)), "delivered more than once"
        root = home / "av-events" / "buffer"
        assert [p.name for p in root.iterdir() if p.name.endswith(".jsonl")] == []


# --------------------------------------------------------------------------
# In-process: adoption rules, truncated lines, idempotency
# --------------------------------------------------------------------------


def _modules(plugin):
    return sys.modules[f"{plugin.__name__}._core"], sys.modules[f"{plugin.__name__}._collector"]


def make_collector(plugin, monkeypatch, *, url="", token="test-token"):
    monkeypatch.setenv("AV_EVENTS_TOKEN", token)
    if url:
        monkeypatch.setenv("AV_EVENTS_URL", url)
    _, collector_mod = _modules(plugin)
    collector = collector_mod.Collector()
    collector._ensure_buffer()
    return collector


def dead_pid() -> int:
    """The pid of a process that has exited and been reaped."""
    done = subprocess.run([sys.executable, "-c", "import os; print(os.getpid())"], capture_output=True, text=True)
    return int(done.stdout.strip())


def jsonl_names(root) -> list[str]:
    return sorted(name for name in os.listdir(root) if name.endswith(".jsonl"))


def event_lines(collector, count: int, text: str = "plain") -> list[bytes]:
    lines = []
    for index in range(count):
        event = collector.envelope(
            "session.started", {"source": "telegram", "note": f"{text}-{index}"}, session_id="s-old"
        )
        lines.append((json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8"))
    return lines


def write_leftover(root, pid: int, lines: list[bytes], *, tail: bytes = b"", lock: bool = False) -> Path:
    path = Path(root) / f"current-{pid}.jsonl"
    path.write_bytes(b"".join(lines) + tail)
    if lock:
        # The lock file a dead owner leaves behind: present, held by nobody.
        (Path(root) / f"current-{pid}.lock").write_bytes(b"")
    return path


def test_a_truncated_last_line_is_dropped_counted_and_logged_once(plugin, monkeypatch, home, av, caplog):
    caplog.set_level("WARNING", logger="av-events")
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = collector.config.buffer_dir
        good = event_lines(collector, 2, text="héllo")
        # The third line was being written when the process died: cut inside
        # the two-byte "é", so it is not even valid UTF-8.
        third = event_lines(collector, 1, text="héllo")[0]
        cut = third.index("é".encode("utf-8")) + 1
        write_leftover(root, dead_pid(), good, tail=third[:cut], lock=True)

        collector.tick()  # must not raise

        assert [e["payload"]["note"] for e in ingest.received] == ["héllo-0", "héllo-1"]
        assert collector.counters.get("buffer_unreadable_line") == 1
        assert jsonl_names(root) == []
        lines = [r.getMessage() for r in caplog.records if "buffer_unreadable_line" in r.getMessage()]
        assert lines == ["av-events: buffer_unreadable_line=1"]
        assert not any("héllo" in r.getMessage() for r in caplog.records), "event text reached a log line"


def test_a_file_cut_inside_a_multibyte_character_reads_without_raising(plugin, home, tmp_path):
    core, _ = _modules(plugin)
    path = tmp_path / "cut.jsonl"
    path.write_bytes(b'{"event_id":"a","note":"ok"}\n{"event_id":"b","note":"h\xc3')
    events, unreadable = core.Buffer.read_events_counted(str(path))
    assert [e["event_id"] for e in events] == ["a"]
    assert unreadable == 1


def test_a_replayed_file_is_a_dedup_safe_repeat(plugin, monkeypatch, home, av):
    """A process can die after ingest accepted a batch and before it unlinked
    the file. The next process sends the same bytes again; ingest keeps one row
    per `event_id` (`ON CONFLICT (event_id) DO NOTHING`, `src/ingest/events.ts`
    in agentvillage-data), so the repeat must carry the identical ids."""
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = collector.config.buffer_dir
        lines = event_lines(collector, 3)
        write_leftover(root, dead_pid(), lines)  # no lock file: a pre-DATA-94 writer

        collector.tick()
        collector.tick()
        assert ingest.request_count == 1, "a delivered file was sent again by the same process"

        # The crash between POST and unlink, replayed by the next process.
        write_leftover(root, dead_pid(), lines)
        _, collector_mod = _modules(plugin)
        again = collector_mod.Collector()
        again._ensure_buffer()
        again.tick()

        assert ingest.request_count == 2
        first, second = ingest.batches
        assert first == second
        stored = {e["event_id"]: e for e in ingest.received}  # what ingest's dedup keeps
        assert len(stored) == 3


def test_a_leftover_file_with_this_process_pid_is_moved_aside_before_the_first_append(plugin, monkeypatch, home, av):
    """A container restart hands the gateway the pid it had before. Appending
    to the dead process's file would glue the first new event onto its
    half-written last line and lose both."""
    root = home / "av-events" / "buffer"
    root.mkdir(parents=True)
    with av.StubIngest() as ingest:
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        monkeypatch.setenv("AV_EVENTS_URL", ingest.url)
        _, collector_mod = _modules(plugin)
        old = event_lines(collector_mod.Collector(), 1)
        write_leftover(root, os.getpid(), old, tail=b'{"event_id":"half-writ')

        collector = collector_mod.Collector()
        collector._ensure_buffer()
        names = jsonl_names(root)
        assert len(names) == 1 and names[0].endswith(f"-{os.getpid()}-orphan.jsonl"), names

        collector._stop.set()  # this test ticks by hand; keep the flusher thread out
        new = collector.emit("session.started", {"source": "telegram"}, session_id="s-new")
        current = root / f"current-{os.getpid()}.jsonl"
        assert [json.loads(line)["event_id"] for line in current.read_text().splitlines()] == [new["event_id"]]

        collector.nudge_flush(force=True)
        collector.tick()
        received = [e["event_id"] for e in ingest.received]
        assert received == [json.loads(old[0])["event_id"], new["event_id"]]
        assert collector.counters.get("buffer_unreadable_line") == 1


def test_a_live_owners_current_file_is_left_alone(plugin, monkeypatch, home, av):
    import fcntl

    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = collector.config.buffer_dir
        pid = dead_pid()  # the pid does not matter while its lock is held
        write_leftover(root, pid, event_lines(collector, 2), lock=True)
        holder = open(Path(root) / f"current-{pid}.lock", "rb")
        try:
            fcntl.flock(holder.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            collector.tick()
            assert jsonl_names(root) == [f"current-{pid}.jsonl"]
            assert ingest.request_count == 0
        finally:
            holder.close()  # the owner dies; the kernel drops its lock
        collector._orphans_at = None  # due for the next scan
        collector.tick()
        assert len(ingest.received) == 2
        assert not (Path(root) / f"current-{pid}.lock").exists()


def test_without_a_lock_file_a_live_pid_is_trusted_until_its_file_goes_stale(plugin, monkeypatch, home, av):
    core, _ = _modules(plugin)
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = collector.config.buffer_dir
        live = os.getppid()  # alive, and not this process
        path = write_leftover(root, live, event_lines(collector, 1))
        collector.tick()
        assert ingest.request_count == 0
        stale = time.time() - core.ORPHAN_STALE_S - 5
        os.utime(path, (stale, stale))
        collector._orphans_at = None
        collector.tick()
        assert len(ingest.received) == 1


def test_without_working_flock_ownership_falls_back_to_pid_and_age(plugin, monkeypatch, home, av):
    """A filesystem that refuses `flock` (ENOLCK) must not strand every
    leftover file as 'held'."""
    import errno
    import types

    core, collector_mod = _modules(plugin)

    def refuse(fd, op):
        raise OSError(errno.ENOLCK, "no locks here")

    monkeypatch.setattr(core, "fcntl", types.SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=refuse))
    root = home / "av-events" / "buffer"
    root.mkdir(parents=True)
    with av.StubIngest() as ingest:
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        monkeypatch.setenv("AV_EVENTS_URL", ingest.url)
        lines = event_lines(collector_mod.Collector(), 3)
        write_leftover(root, os.getpid(), [lines[0]], lock=True)
        write_leftover(root, dead_pid(), [lines[1]], lock=True)
        live = os.getppid()
        write_leftover(root, live, [lines[2]], lock=True)

        collector = collector_mod.Collector()
        collector._ensure_buffer()
        collector.tick()

        assert sorted(e["event_id"] for e in ingest.received) == sorted(json.loads(l)["event_id"] for l in lines[:2])
        assert jsonl_names(root) == [f"current-{live}.jsonl"]


def test_a_dead_owners_lock_with_nothing_left_behind_is_tidied(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    root = Path(collector.config.buffer_dir)
    gone = dead_pid()
    (root / f"current-{gone}.lock").write_bytes(b"")
    collector.tick()
    assert not (root / f"current-{gone}.lock").exists()
    assert (root / f"current-{os.getpid()}.lock").exists(), "this process's own lock was touched"


def test_replay_preserves_file_order(plugin, monkeypatch, home, av):
    """The dead process's rotated batch, then its current file, then anything
    newer: the order the events were written in."""
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = Path(collector.config.buffer_dir)
        pid = dead_pid()
        now_ms = int(time.time() * 1000)
        rotated, orphan, newer = (event_lines(collector, 1, text=t)[0] for t in ("rotated", "orphan", "newer"))
        (root / f"{now_ms - 30000:013d}-{pid}-0001.jsonl").write_bytes(rotated)
        write_leftover(root, pid, [orphan], lock=True)
        (root / f"{now_ms + 30000:013d}-{pid + 1}-0001.jsonl").write_bytes(newer)
        # The orphan is named for its first event's `emitted_at`, which is
        # "now": between the other two.
        collector.tick()
        assert [batch[0]["payload"]["note"] for batch in ingest.batches] == ["rotated-0", "orphan-0", "newer-0"]


def test_a_rejected_orphan_goes_to_the_existing_quarantine(plugin, monkeypatch, home, av):
    with av.StubIngest(statuses=[400]) as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = Path(collector.config.buffer_dir)
        write_leftover(root, dead_pid(), event_lines(collector, 1), lock=True)
        collector.tick()
        assert ingest.received == []
        assert jsonl_names(root) == []
        assert len([p for p in (root / "rejected").iterdir() if p.name.endswith("-orphan.jsonl")]) == 1


# --------------------------------------------------------------------------
# Plugin load, hook nudges, fail-open
# --------------------------------------------------------------------------


def test_register_starts_the_flusher_only_when_something_was_left_behind(plugin, ctx, monkeypatch, home, av):
    with av.StubIngest() as ingest:
        monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
        monkeypatch.setenv("AV_EVENTS_URL", ingest.url)
        root = home / "av-events" / "buffer"
        root.mkdir(parents=True)
        _, collector_mod = _modules(plugin)
        write_leftover(root, dead_pid(), event_lines(collector_mod.Collector(), 1), lock=True)
        plugin.register(ctx)
        collector = plugin._COLLECTOR
        assert collector._thread is not None and collector._thread.daemon
        assert _wait_for(lambda: len(ingest.received) == 1, timeout=5.0)


def test_register_without_a_token_touches_nothing(plugin, ctx, home):
    plugin.register(ctx)
    assert plugin._COLLECTOR._thread is None
    assert not (home / "av-events").exists()


@pytest.fixture()
def held_flusher(plugin, ctx, monkeypatch):
    """Registered and active, with the flusher unable to run, so what a hook
    does is visible and nothing is sent behind its back."""
    import threading

    calls: list[str] = []
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_URL", "http://127.0.0.1:9")
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    collector._stop.set()  # a flusher thread started now exits at once

    def sender(url, token, events):
        calls.append(threading.current_thread().name)
        raise AssertionError("a hook reached the network")

    collector.sender = sender
    return collector, calls


def test_finalize_rotates_the_batch_and_wakes_the_flusher_without_sending(held_flusher, ctx):
    collector, calls = held_flusher
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    ctx.fire("on_session_end", session_id="s1")
    root = collector.config.buffer_dir
    # A turn end still batches: the flush interval is unchanged.
    assert jsonl_names(root) == [f"current-{os.getpid()}.jsonl"]
    collector._wake.clear()
    ctx.fire("on_session_finalize", session_id="s1", platform="gateway", reason="shutdown")
    names = jsonl_names(root)
    assert names and not any(n.startswith("current-") for n in names)
    assert collector._wake.is_set()
    assert calls == []


def test_finalize_of_a_session_this_process_never_saw_still_nudges(held_flusher, ctx):
    collector, calls = held_flusher
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    ctx.fire("on_session_end", session_id="s1")
    collector._wake.clear()
    ctx.fire("on_session_finalize", session_id="from-before-the-restart", platform="gateway", reason="shutdown")
    ctx.fire("on_session_finalize")  # no id at all
    assert not any(n.startswith("current-") for n in jsonl_names(collector.config.buffer_dir))
    assert collector._wake.is_set()
    assert calls == []


def _drive_every_hook(ctx):
    ctx.fire("on_session_start", session_id="s1", model="m", platform="telegram")
    ctx.fire("pre_llm_call", session_id="s1", turn_id="t0", user_message="hi")
    ctx.fire("pre_api_request", session_id="s1", turn_id="t0", api_request_id="r0")
    ctx.fire("post_api_request", session_id="s1", turn_id="t0", api_request_id="r0")
    ctx.fire("api_request_error", session_id="s1", turn_id="t0", api_request_id="r1")
    ctx.fire("pre_tool_call", session_id="s1", tool_name="shell")
    ctx.fire("post_tool_call", session_id="s1", tool_name="shell")
    ctx.fire("post_llm_call", session_id="s1", turn_id="t0", assistant_response="ok")
    ctx.fire("on_stream_end", session_id="s1")
    ctx.fire("subagent_start", parent_session_id="s1", child_session_id="s2")
    ctx.fire("subagent_stop", parent_session_id="s1", child_session_id="s2")
    ctx.fire("on_session_end", session_id="s1")
    ctx.fire("on_session_finalize", session_id="s1", platform="gateway", reason="shutdown")
    ctx.fire("on_session_finalize")


@pytest.mark.parametrize("how", ["parent_is_a_file", "buffer_dir_read_only"])
def test_an_unwritable_buffer_costs_no_hook_an_exception(plugin, ctx, monkeypatch, home, how):
    if how == "buffer_dir_read_only" and hasattr(os, "geteuid") and os.geteuid() == 0:
        pytest.skip("root ignores directory permissions")
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_URL", "http://127.0.0.1:9")
    root = home / "av-events" / "buffer"
    if how == "parent_is_a_file":
        (home / "av-events").write_text("not a directory")
    else:
        root.mkdir(parents=True)
        write_leftover(root, dead_pid(), [b'{"event_id":"x"}\n'])
        root.chmod(0o500)
    try:
        plugin.register(ctx)  # recover_on_load included
        collector = plugin._COLLECTOR
        collector._stop.set()
        _drive_every_hook(ctx)
        collector.tick()
        collector.shutdown()
    finally:
        if root.is_dir():
            root.chmod(0o700)
