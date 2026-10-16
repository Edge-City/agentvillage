"""ov#357 refute M1 stopgap (b): `gate.unverified@1` from av-approval's `av-approval:gate.unverified`.

av-approval's backstop publishes one bus event per change of its verdict (start failure, later failure,
recovery) and one `recovered` at every clean start (OV-GATE-RECOVERED), with code names only; this
plugin rebuilds it from a closed allow-list (`_gate_events.py`) and emits it unless `AV_GATE_EVENTS`
is set off.
"""

from __future__ import annotations

import ast
import uuid
from pathlib import Path

import pytest

BUS = "av-approval:gate.unverified"
OK = {"phase": "recheck", "codes": ["shim-changed-since-start", "shim-not-vendored"], "ts": 1760500000}
#: OV-GATE-RECOVERED: what av-approval publishes at every clean gateway start.
CLEAN_START = {"phase": "recovered", "codes": [], "ts": 1760500000}
SENTINEL = "SENTINEL7f3a"


@pytest.fixture(autouse=True)
def _switch_unset(monkeypatch):
    monkeypatch.delenv("AV_GATE_EVENTS", raising=False)


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    return plugin


def emitted(plugin, av):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] == "gate.unverified"]


def drops(plugin):
    return {k: v for k, v in plugin._COLLECTOR.counters.items() if k.startswith("gate_dropped_")}


def publisher_constants():
    """The publisher's GATE_CODE_NAMES, read from its source (av-approval is another plugin package)."""
    source = (Path(__file__).resolve().parents[2] / "av-approval" / "__init__.py").read_text(encoding="utf-8")
    tree = ast.parse(source)
    names = next(ast.literal_eval(n.value) for n in ast.walk(tree)
                 if isinstance(n, ast.AnnAssign) and getattr(n.target, "id", "") == "GATE_CODE_NAMES")
    event = next(ast.literal_eval(n.value) for n in ast.walk(tree)
                 if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "GATE_EVENT")
    return names, event


def test_subscribed_once_under_its_hook_name(plugin, ctx):
    plugin.register(ctx)
    plugin.register(ctx)
    assert len(ctx.subscriptions[BUS]) == 1
    assert plugin.SUBSCRIPTION_BODIES[BUS] == ("gate_events", plugin._gate_events.on_gate)


def test_publisher_and_bridge_agree(plugin):
    names, event = publisher_constants()
    ge = plugin._gate_events
    assert tuple(names) == ge.CODE_NAMES
    assert "av-approval:" + event == ge.BUS_EVENT == BUS
    assert ge.FIELD_NAMES == ("phase", "codes", "ts") and ge.FLAG == "AV_GATE_EVENTS"


@pytest.mark.parametrize("record", [
    OK,
    {"phase": "start", "codes": ["shim-not-vendored"], "ts": 1760500000},
    {"phase": "recovered", "codes": [], "ts": 1760500000},
    {"phase": "recheck", "codes": ["other"], "ts": 1760500000},
])
def test_on_by_default_and_emitted_as_given(live, ctx, av, record):
    assert live._gate_events.rebuild(dict(record)) == (record, None)
    ctx.publish(BUS, **record)
    (event,) = emitted(live, av)
    assert (event["schema_version"], event["actor"], event["payload"]) == (1, "system", record)
    assert list(event["payload"]) == ["phase", "codes", "ts"]
    assert uuid.UUID(event["event_id"]).version == 7
    assert drops(live) == {}


@pytest.mark.parametrize("record,reason", [
    ({"phase": "recheck", "codes": ["shim-not-vendored"]}, "missing_field"),
    (dict(OK, path="/home/x"), "extra_field"),
    (dict(OK, collector="x"), "extra_field"),
    (dict(OK, phase="later"), "bad_enum"),
    (dict(OK, codes=["hook-missing:terminal"]), "bad_enum"),
    (dict(OK, codes=[SENTINEL]), "bad_enum"),
    (dict(OK, codes="shim-missing"), "bad_type"),
    (dict(OK, codes=[1]), "bad_type"),
    (dict(OK, ts=True), "bad_type"),
    (dict(OK, ts=1.5), "bad_type"),
    (dict(OK, ts=1), "bad_range"),
    (dict(OK, codes=["shim-not-vendored", "shim-changed-since-start"]), "bad_shape"),
    (dict(OK, codes=["other", "other"]), "bad_shape"),
    (dict(OK, codes=[]), "bad_shape"),
    ({"phase": "recovered", "codes": ["other"], "ts": 1760500000}, "bad_shape"),
    (dict(OK, codes=["other"] * 19), "bad_range"),
])
def test_refused_records_drop_whole_and_count(live, ctx, av, caplog, record, reason):
    assert live._gate_events.rebuild(dict(record)) == (None, reason)
    ctx.publish(BUS, **record)
    assert emitted(live, av) == []
    assert drops(live) == {"gate_dropped_" + reason: 1}
    assert live._COLLECTOR.total_failures == 0
    assert SENTINEL not in caplog.text


@pytest.mark.parametrize("record", [OK, CLEAN_START], ids=["recheck", "clean_start"])
@pytest.mark.parametrize("value", ["0", "false", "no", "off", " OFF "])
def test_an_off_spelling_turns_it_off(plugin, ctx, av, monkeypatch, value, record):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_GATE_EVENTS", value)
    plugin.register(ctx)
    ctx.publish(BUS, **record)
    assert emitted(plugin, av) == []
    assert drops(plugin) == {"gate_dropped_switch_off": 1}


def test_each_clean_start_is_its_own_row(live, ctx, av):
    """OV-GATE-RECOVERED: one `recovered` row per clean start, each with its own id; nothing dedupes here
    (data's rule keeps each box's latest row)."""
    second = dict(CLEAN_START, ts=CLEAN_START["ts"] + 600)
    ctx.publish(BUS, **CLEAN_START)
    ctx.publish(BUS, **second)
    rows = emitted(live, av)
    assert [e["payload"] for e in rows] == [CLEAN_START, second]
    assert len({e["event_id"] for e in rows}) == 2
    assert drops(live) == {}
