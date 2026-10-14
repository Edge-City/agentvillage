"""ov#333 refute S1: `guarded` reads the hook's `session_id` / `parent_session_id` before its own
`try`, and `hook_allowed` -> `peek_session` uses it as a dict key. A bus publisher sending an
unhashable value there (a list, a dict) raised `TypeError` out of the wrapper, so the body's own
validation never ran and no counter moved. Only a string names a session now; anything else is
treated as no session, and the body drops the record as it would any other bad field."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

VECTORS = json.loads((Path(__file__).parent / "vectors" / "plugin_events_contract.json").read_text(encoding="utf-8"))
INVENTORY = next(v["record"] for v in VECTORS["accept"] if v["type"] == "plugin.inventory")
OBSERVED = next(v["record"] for v in VECTORS["model_events"]["accept"] if v["type"] == "model.observed")
CASES = [
    (VECTORS["bus"]["inventory"], INVENTORY, "plugin_dropped_extra_field"),
    (VECTORS["model_events"]["bus"]["observed"], OBSERVED, "model_dropped_extra_field"),
]


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "1")
    monkeypatch.setenv("AV_MODEL_EVENTS", "1")
    plugin.register(ctx)
    return plugin


class _NoHash(str):
    """A str subclass that cannot be a dict key: `isinstance(x, str)` passes, `hash(x)` raises."""

    __hash__ = None  # type: ignore[assignment]


class _NoBool:
    """An object whose truth test raises (a numpy array does this)."""

    def __bool__(self):
        raise ValueError("ambiguous")


RAISED_ON_MAIN = [["s1"], {"id": "s1"}, {"s1"}, _NoHash("s1"), _NoBool()]
HASHABLE_NON_STR = [7, 1.5, True, b"s1"]


@pytest.mark.parametrize("bad", RAISED_ON_MAIN)
@pytest.mark.parametrize("key", ["session_id", "parent_session_id"])
@pytest.mark.parametrize("bus, record, counter", CASES)
def test_a_value_that_raised_out_of_guarded_is_now_dropped_by_the_body(live, ctx, av, bad, key, bus, record, counter):
    ctx.publish(bus, **dict(record, **{key: bad}))  # TypeError / ValueError out of `guarded` before
    assert live._COLLECTOR.counters.get(counter) == 1
    assert [e for e in av.read_buffer(live._COLLECTOR) if e["event_type"] in ("plugin.inventory", "model.observed")] == []


@pytest.mark.parametrize("bad", HASHABLE_NON_STR)
@pytest.mark.parametrize("key", ["session_id", "parent_session_id"])
@pytest.mark.parametrize("bus, record, counter", CASES)
def test_a_hashable_non_str_value_counts_as_no_session_and_the_body_drops_the_record(live, ctx, av, bad, key, bus, record, counter):
    ctx.publish(bus, **dict(record, **{key: bad}))  # never raised; now also never names a session
    assert live._COLLECTOR.counters.get(counter) == 1
    assert bad not in live._COLLECTOR._config_seen
    assert [e for e in av.read_buffer(live._COLLECTOR) if e["event_type"] in ("plugin.inventory", "model.observed")] == []


def test_a_non_str_session_id_falls_back_to_a_str_parent(live, ctx):
    ctx.publish(VECTORS["bus"]["inventory"], **dict(INVENTORY, session_id=["s1"], parent_session_id="p1"))
    assert live._COLLECTOR.counters.get("plugin_dropped_extra_field") == 1
    assert "p1" in live._COLLECTOR._config_seen


@pytest.mark.parametrize("bus, record, counter", CASES)
def test_a_string_session_id_still_names_the_session_and_the_record_drops_as_before(live, ctx, bus, record, counter):
    ctx.publish(bus, **dict(record, session_id="s1"))
    assert live._COLLECTOR.counters.get(counter) == 1
    # The string still reached `begin` (which tracks it for the config reload); nothing creates a session here.
    assert "s1" in live._COLLECTOR._config_seen


def test_a_valid_record_with_no_session_key_still_emits(live, ctx, av):
    ctx.publish(VECTORS["bus"]["inventory"], **INVENTORY)
    assert [e["event_type"] for e in av.read_buffer(live._COLLECTOR) if e["event_type"] == "plugin.inventory"] == ["plugin.inventory"]
