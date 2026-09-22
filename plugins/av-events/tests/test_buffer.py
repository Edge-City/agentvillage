"""Buffer, flush, retry, drop-after-72h and null sink (spec scenarios 16 and 24)."""

from __future__ import annotations

import json
import os
import time

SESSION = "sess-buf"


def emit_n(collector, count, event_type="session.started"):
    for index in range(count):
        collector.emit(event_type, {"n": index}, session_id=SESSION)


def buffer_files(collector):
    root = collector.config.buffer_dir
    return sorted(name for name in os.listdir(root) if name.endswith(".jsonl"))


def ready_files(collector):
    return [name for name in buffer_files(collector) if not name.startswith("current-")]


def make_collector(plugin, monkeypatch, *, url="", token="test-token", **env):
    monkeypatch.setenv("AV_EVENTS_TOKEN", token)
    if url:
        monkeypatch.setenv("AV_EVENTS_URL", url)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    collector_mod = __import__("sys").modules[f"{plugin.__name__}._collector"]
    collector = collector_mod.Collector()
    collector._ensure_buffer()
    return collector


# --------------------------------------------------------------------------
# Rotation
# --------------------------------------------------------------------------


def test_events_land_in_an_append_only_jsonl_file(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    emit_n(collector, 3)
    root = home / "av-events" / "buffer"
    current = list(root.glob("current-*.jsonl"))
    assert len(current) == 1
    lines = current[0].read_text(encoding="utf-8").strip().splitlines()
    assert len(lines) == 3
    assert json.loads(lines[0])["event_type"] == "session.started"


def test_fifty_events_rotate_a_batch(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    emit_n(collector, 49)
    assert ready_files(collector) == []
    emit_n(collector, 1)
    assert len(ready_files(collector)) == 1
    # The current file is empty again and a new batch starts clean.
    assert collector.buffer.pending_count == 0


def test_the_ten_second_deadline_rotates_a_partial_batch(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    emit_n(collector, 3)
    assert ready_files(collector) == []
    # Backdate the batch's start rather than sleeping ten seconds.
    collector.buffer._started_ms -= 11_000
    collector.buffer.rotate_if_due()
    assert len(ready_files(collector)) == 1


def test_a_rotated_file_is_named_for_its_first_event(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    before = int(time.time() * 1000)
    emit_n(collector, 50)
    name = ready_files(collector)[0]
    started = int(name.split("-", 1)[0])
    assert before <= started <= int(time.time() * 1000)


# --------------------------------------------------------------------------
# Flush to a real HTTP stub
# --------------------------------------------------------------------------


def test_flush_posts_the_batch_to_v1_events(plugin, monkeypatch, home, av):
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        emit_n(collector, 50)
        collector.tick()

        assert ingest.paths == ["/v1/events"]
        assert ingest.auth_headers == ["Bearer test-token"]
        assert len(ingest.received) == 50
        assert ingest.received[0]["event_type"] == "session.started"
        # Sent files are removed, so nothing is delivered twice.
        assert ready_files(collector) == []


def test_a_trailing_slash_on_the_url_does_not_double_up(plugin, monkeypatch, home, av):
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url + "/")
        emit_n(collector, 50)
        collector.tick()
        assert ingest.paths == ["/v1/events"]


def test_a_503_is_retried_not_dropped(plugin, monkeypatch, home, av):
    with av.StubIngest(statuses=[503]) as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        emit_n(collector, 50)

        collector.tick()
        assert ingest.request_count == 1
        assert len(ready_files(collector)) == 1, "a failed batch stays on disk"

        # Backoff is in force, so an immediate tick does not hammer the server.
        collector.tick()
        assert ingest.request_count == 1

        # Once the backoff expires the same batch goes again, and lands.
        name = ready_files(collector)[0]
        collector._backoff[name] = (0.0, 1)
        collector.tick()
        assert ingest.request_count == 2
        assert len(ingest.received) == 50
        assert ready_files(collector) == []


def test_backoff_grows_exponentially_and_is_capped(plugin, monkeypatch, home, av):
    core = __import__("sys").modules[f"{plugin.__name__}._core"]
    with av.StubIngest(statuses=[503] * 12) as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        emit_n(collector, 50)
        delays = []
        for _ in range(8):
            name = ready_files(collector)[0]
            next_at, attempts = collector._backoff.get(name, (0.0, 0))
            collector._backoff[name] = (0.0, attempts)
            collector.tick()
            new_at, _ = collector._backoff[name]
            delays.append(round(new_at - time.time()))
        assert delays[0] < delays[1] < delays[2]
        assert max(delays) <= core.BACKOFF_MAX_S


def test_a_connection_refused_is_not_an_exception(plugin, monkeypatch, home, av):
    """Scenario 24: the research layer is simply gone."""
    collector = make_collector(plugin, monkeypatch, url="http://127.0.0.1:9")
    emit_n(collector, 50)
    collector.tick()  # must not raise
    assert len(ready_files(collector)) == 1
    assert collector.total_failures == 0


# --------------------------------------------------------------------------
# Drop after 72 h
# --------------------------------------------------------------------------


def test_a_batch_older_than_72h_is_dropped_and_reported(plugin, monkeypatch, home, av):
    core = __import__("sys").modules[f"{plugin.__name__}._core"]
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        emit_n(collector, 50)
        stale = ready_files(collector)[0]
        root = collector.config.buffer_dir
        events = [json.loads(line) for line in open(os.path.join(root, stale), encoding="utf-8")]
        oldest = min(e["emitted_at"] for e in events)
        newest = max(e["emitted_at"] for e in events)

        # Rename the batch to a start time beyond the cap.
        expired_ms = int((time.time() - core.MAX_BUFFER_AGE_S - 60) * 1000)
        os.rename(
            os.path.join(root, stale),
            os.path.join(root, f"{expired_ms:013d}-1-0001.jsonl"),
        )

        collector.tick()
        assert ready_files(collector) == [], "the expired batch is gone"
        assert ingest.request_count == 0, "an expired batch is never sent"
        assert collector._dropped["count"] == 50

        # The report rides out on the next batch that does land.
        emit_n(collector, 50)
        collector.tick()
        dropped = [e for e in ingest.received if e["event_type"] == "plugin.buffer_dropped"]
        assert len(dropped) == 0, "it is buffered now, sent on the following flush"
        collector.buffer.rotate_if_due(force=True)
        collector.tick()
        dropped = [e for e in ingest.received if e["event_type"] == "plugin.buffer_dropped"]
        assert len(dropped) == 1
        payload = dropped[0]["payload"]
        assert payload["count"] == 50
        assert payload["files"] == 1
        assert payload["oldest_event_at"] == oldest
        assert payload["newest_event_at"] == newest


def test_only_one_drop_report_covers_several_expired_batches(plugin, monkeypatch, home, av):
    core = __import__("sys").modules[f"{plugin.__name__}._core"]
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        root = collector.config.buffer_dir
        expired_ms = int((time.time() - core.MAX_BUFFER_AGE_S - 60) * 1000)
        for index in range(3):
            before = set(ready_files(collector))
            emit_n(collector, 50)
            fresh = (set(ready_files(collector)) - before).pop()
            os.rename(
                os.path.join(root, fresh),
                os.path.join(root, f"{expired_ms + index:013d}-1-9{index:03d}.jsonl"),
            )
        assert len(ready_files(collector)) == 3

        # One tick drops all three and reports them on the same pass, because
        # the report only needs *a* successful flush and this one has it.
        emit_n(collector, 50)
        collector.tick()
        assert ready_files(collector) == []
        assert collector._dropped == {}

        collector.buffer.rotate_if_due(force=True)
        collector.tick()
        dropped = [e for e in ingest.received if e["event_type"] == "plugin.buffer_dropped"]
        assert len(dropped) == 1
        assert dropped[0]["payload"]["count"] == 150
        assert dropped[0]["payload"]["files"] == 3


# --------------------------------------------------------------------------
# Null sink
# --------------------------------------------------------------------------


def test_null_sink_buffers_and_makes_no_http_call(plugin, monkeypatch, home, av):
    """Token set, no URL: run on a dogfood tenant before ingest exists."""
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch)  # no AV_EVENTS_URL
        assert collector.config.null_sink is True
        emit_n(collector, 120)
        collector.tick()
        collector.tick()
        assert ingest.request_count == 0
        # Everything is still on disk, nothing was deleted.
        total = sum(
            len(open(os.path.join(collector.config.buffer_dir, name), encoding="utf-8").read().splitlines())
            for name in buffer_files(collector)
        )
        assert total == 120


def test_null_sink_never_ages_a_batch_out(plugin, monkeypatch, home):
    core = __import__("sys").modules[f"{plugin.__name__}._core"]
    collector = make_collector(plugin, monkeypatch)
    emit_n(collector, 50)
    root = collector.config.buffer_dir
    expired_ms = int((time.time() - core.MAX_BUFFER_AGE_S - 60) * 1000)
    os.rename(
        os.path.join(root, ready_files(collector)[0]),
        os.path.join(root, f"{expired_ms:013d}-1-0001.jsonl"),
    )
    collector.tick()
    assert len(ready_files(collector)) == 1, "there is no destination to retry against"
    assert collector._dropped == {}


# --------------------------------------------------------------------------
# Threading and shutdown
# --------------------------------------------------------------------------


def test_the_flusher_is_a_daemon_thread_started_lazily(plugin, ctx, monkeypatch, home):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    collector = plugin._COLLECTOR
    assert collector._thread is None, "no thread until there is something to send"
    ctx.fire("on_session_start", session_id=SESSION, model="m", platform="cli")
    assert collector._thread is not None
    assert collector._thread.daemon is True


def test_shutdown_flushes_what_it_can(plugin, monkeypatch, home, av):
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        emit_n(collector, 5)  # below the rotation threshold
        assert ready_files(collector) == []
        collector.shutdown()
        assert len(ingest.received) == 5


def test_shutdown_is_safe_with_nothing_buffered(plugin, monkeypatch, home):
    collector = make_collector(plugin, monkeypatch)
    collector.shutdown()
    collector.shutdown()


def test_a_corrupt_line_does_not_poison_a_batch(plugin, monkeypatch, home, av):
    with av.StubIngest() as ingest:
        collector = make_collector(plugin, monkeypatch, url=ingest.url)
        emit_n(collector, 50)
        path = os.path.join(collector.config.buffer_dir, ready_files(collector)[0])
        with open(path, "a", encoding="utf-8") as handle:
            handle.write("{not json at all\n")
        collector.tick()
        assert len(ingest.received) == 50
        assert ready_files(collector) == []
