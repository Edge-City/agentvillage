"""Adaptive polling (CARD-OV; approval L19771 (c): core 0.4.6 has no push). The poller waits MIN_POLL_S (5 s) between
passes while any registered busy probe says a pass has live work (an approval card younger than its TTL waiting for its
tap), and AV_APPROVAL_POLL_S (default 30 s) otherwise. Generic: every pass registers its own probe."""

from __future__ import annotations

import threading

import pytest


@pytest.fixture()
def ap(plugin, av, monkeypatch):
    import sys
    module = sys.modules[f"{av.MODULE_NAME}._approval"]
    monkeypatch.setattr(module, "_BUSY", {})
    return module


def test_no_probe_keeps_the_configured_interval(ap, monkeypatch):
    monkeypatch.delenv("AV_APPROVAL_POLL_S", raising=False)
    assert ap.next_interval() == ap.poll_interval() == ap.DEFAULT_POLL_S == 30.0
    monkeypatch.setenv("AV_APPROVAL_POLL_S", "45")
    assert ap.next_interval() == 45.0


def test_a_busy_probe_switches_to_the_floor_and_back(ap, monkeypatch):
    monkeypatch.delenv("AV_APPROVAL_POLL_S", raising=False)
    state = {"busy": False}
    ap.register_busy("cards", lambda: state["busy"])
    assert ap.next_interval() == 30.0
    state["busy"] = True
    assert ap.next_interval() == ap.MIN_POLL_S == 5.0
    state["busy"] = False
    assert ap.next_interval() == 30.0


def test_any_probe_is_enough_and_a_raising_or_truthy_non_bool_probe_is_not_busy(ap, monkeypatch):
    monkeypatch.delenv("AV_APPROVAL_POLL_S", raising=False)

    def boom() -> bool:
        raise RuntimeError("probe failed")

    ap.register_busy("a", boom)
    ap.register_busy("b", lambda: "yes")  # only True counts
    assert ap.next_interval() == 30.0
    ap.register_busy("c", lambda: True)
    assert ap.next_interval() == 5.0
    ap.register_busy("c", lambda: False)  # re-registering a name replaces its probe
    assert ap.next_interval() == 30.0


def test_the_poller_waits_next_interval(ap, monkeypatch):
    waits: list[float] = []
    done = threading.Event()
    runs: list[int] = []

    def counted(_execute: bool) -> None:
        runs.append(1)
        if len(runs) >= 3:
            done.set()

    monkeypatch.setattr(ap, "_PASSES", {"counted": counted})
    monkeypatch.setattr(ap, "MIN_POLL_S", 0.01)

    def interval() -> float:
        waits.append(1)
        return 0.01

    monkeypatch.setattr(ap, "next_interval", interval)
    try:
        assert ap.ensure_poller() is True
        assert done.wait(5)
    finally:
        ap.stop_poller()
    assert len(waits) >= 2
