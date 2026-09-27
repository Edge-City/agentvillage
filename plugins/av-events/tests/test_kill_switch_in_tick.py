"""DATA-180: the kill switch is honoured by a flusher that is already running.

`AV_EVENTS_ENABLED` was read when the config was built (plugin load, a new
session, the 60 s TTL), so a flusher already ticking kept sending after it was
switched off. `tick()` now re-reads it before every pass.
"""

from __future__ import annotations

import sys
import time


def make(plugin, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_EVENTS_URL", "http://127.0.0.1:9")
    core = sys.modules[f"{plugin.__name__}._core"]
    collector = sys.modules[f"{plugin.__name__}._collector"].Collector()
    collector._ensure_buffer()
    sent: list[list[dict]] = []

    def sender(url, token, events):
        sent.append(events)
        return core.SendResult(True, 202)

    collector.sender = sender
    return collector, sent


def queue_batch(collector, n=3):
    for index in range(n):
        collector.emit("session.started", {"n": index}, session_id="s")
    collector.buffer.rotate_if_due(force=True)


def test_switching_off_stops_the_next_tick_sending(plugin, monkeypatch):
    collector, sent = make(plugin, monkeypatch)
    queue_batch(collector)
    assert collector.config.enabled

    monkeypatch.setenv("AV_EVENTS_ENABLED", "false")
    collector.tick()
    assert sent == [], "a switched-off flusher sends nothing"
    assert not collector.config.enabled, "and the switch now holds for emit too"
    assert collector.emit("session.started", {"n": 9}, session_id="s") is None

    # Back on: the queued batch goes out on the next pass, without a reload.
    monkeypatch.setenv("AV_EVENTS_ENABLED", "1")
    collector.tick()
    assert len(sent) == 1 and len(sent[0]) == 3


def test_a_running_flusher_stops_within_one_tick_interval(plugin, monkeypatch):
    core = sys.modules[f"{plugin.__name__}._core"]
    collector, sent = make(plugin, monkeypatch)
    try:
        queue_batch(collector)
        collector._ensure_thread()
        deadline = time.time() + 5
        while time.time() < deadline and not sent:
            time.sleep(0.05)
        assert len(sent) == 1, "the flusher is running and sending"

        monkeypatch.setenv("AV_EVENTS_ENABLED", "off")
        # Anything in flight on the pass that was already running may finish;
        # after one full interval, nothing more leaves.
        time.sleep(core.TICK_INTERVAL_S + 0.2)
        before = len(sent)
        # A batch written by a caller that has not yet seen the switch.
        collector.buffer.append(collector.envelope("session.started", {"n": 1}, session_id="s"))
        collector.buffer.rotate_if_due(force=True)
        collector._wake.set()
        time.sleep(core.TICK_INTERVAL_S * 2 + 0.2)
        assert len(sent) == before
    finally:
        collector._stop.set()
        collector._wake.set()


def test_a_flip_mid_pass_stops_before_the_next_file(plugin, monkeypatch):
    """The switch is read before every file of the backlog, not once a pass:
    the file in flight when it flips finishes, and no other is sent."""
    collector, sent = make(plugin, monkeypatch)
    core = sys.modules[f"{plugin.__name__}._core"]
    for _ in range(core.MAX_FILES_PER_TICK):
        queue_batch(collector)

    def sender(url, token, events):
        sent.append(events)
        monkeypatch.setenv("AV_EVENTS_ENABLED", "false")
        return core.SendResult(True, 202)

    collector.sender = sender
    collector.tick()
    assert len(sent) == 1, "only the file in flight when the switch flipped"
