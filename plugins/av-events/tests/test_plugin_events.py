"""SEC-3: `plugin.inventory@1` / `plugin.unknown@1` from av-approval's bus events.

av-approval publishes `av-approval:plugin.inventory` and `av-approval:plugin.unknown`; this plugin
rebuilds each from a closed allow-list (`_plugin_events.py`), drops and counts anything else, and
emits only with `AV_PLUGIN_EVENTS` on. The contract both sides test against is
`vectors/plugin_events_contract.json`.
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from pathlib import Path

import pytest

VECTORS = json.loads((Path(__file__).parent / "vectors" / "plugin_events_contract.json").read_text(encoding="utf-8"))
BUS = {"plugin.inventory": VECTORS["bus"]["inventory"], "plugin.unknown": VECTORS["bus"]["unknown"]}
INVENTORY = next(v["record"] for v in VECTORS["accept"] if v["type"] == "plugin.inventory")
UNKNOWN = next(v["record"] for v in VECTORS["accept"] if v["type"] == "plugin.unknown")
SENTINEL = "SENTINEL7f3a"


@pytest.fixture(autouse=True)
def _switch_unset(monkeypatch):
    monkeypatch.delenv("AV_PLUGIN_EVENTS", raising=False)


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    """A registered plugin with a token and the switch on."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "1")
    plugin.register(ctx)
    return plugin


def publish(ctx, event_type, record):
    ctx.publish(BUS[event_type], **record)


def emitted(plugin, av):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] in BUS]


def drops(plugin):
    return {k: v for k, v in plugin._COLLECTOR.counters.items() if k.startswith("plugin_dropped_")}


def test_the_module_rules_are_the_contract_file(plugin):
    pe = plugin._plugin_events
    assert pe.FIELDS == VECTORS["fields"]
    assert (pe.INVENTORY_BUS_EVENT, pe.UNKNOWN_BUS_EVENT) == (VECTORS["bus"]["inventory"], VECTORS["bus"]["unknown"])
    assert list(pe.REASONS) == VECTORS["drop_reasons"]
    assert pe.FLAG == VECTORS["switch"]["env"]


def test_every_field_has_a_refusal_vector():
    for event_type, fields in VECTORS["fields"].items():
        refused = {k for v in VECTORS["refuse"] if v["type"] == event_type for k in fields if v["record"].get(k, ...) != INVENTORY.get(k, UNKNOWN.get(k))}
        assert refused == set(fields), event_type


def test_both_bus_names_are_subscribed_exactly_once(plugin, ctx):
    plugin.register(ctx)
    plugin.register(ctx)  # idempotent
    for name in BUS.values():
        assert len(ctx.subscriptions[name]) == 1
    assert set(ctx.subscriptions) == set(plugin.SUBSCRIPTION_BODIES)


def test_a_ctx_without_subscribe_is_tolerated(plugin):
    class HooksOnly:
        def register_hook(self, name, callback):
            pass

    plugin.register(HooksOnly())
    assert plugin._REGISTERED


@pytest.mark.parametrize("vector", VECTORS["accept"], ids=lambda v: v["note"])
def test_accept_vectors(live, ctx, av, vector):
    publish(ctx, vector["type"], vector["record"])
    (event,) = emitted(live, av)
    assert event["event_type"] == vector["type"]
    assert event["schema_version"] == 1
    assert event["actor"] == "system"
    assert event["payload"] == vector["emits"]
    assert list(event["payload"]) == list(VECTORS["fields"][vector["type"]])
    assert drops(live) == {}


@pytest.mark.parametrize("vector", VECTORS["refuse"], ids=lambda v: f'{v["type"]}:{v["note"]}')
def test_refuse_vectors_drop_the_whole_record_and_count_it(live, ctx, av, vector):
    publish(ctx, vector["type"], vector["record"])
    assert emitted(live, av) == []
    assert drops(live) == {f'plugin_dropped_{vector["reason"]}': 1}
    assert live._COLLECTOR.total_failures == 0  # dropped, never raised


def test_switch_off_by_default_counts_and_emits_nothing(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    publish(ctx, "plugin.inventory", INVENTORY)
    publish(ctx, "plugin.unknown", UNKNOWN)
    publish(ctx, "plugin.unknown", dict(UNKNOWN, url="https://x"))  # off wins over shape
    assert emitted(plugin, av) == []
    assert drops(plugin) == {"plugin_dropped_switch_off": 3}


def test_the_switch_is_read_per_emit(live, ctx, monkeypatch, av):
    publish(ctx, "plugin.inventory", INVENTORY)
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "off")
    publish(ctx, "plugin.inventory", INVENTORY)
    monkeypatch.delenv("AV_PLUGIN_EVENTS")
    publish(ctx, "plugin.inventory", INVENTORY)
    monkeypatch.setenv("AV_PLUGIN_EVENTS", " Yes ")
    publish(ctx, "plugin.inventory", INVENTORY)
    assert len(emitted(live, av)) == 2
    assert drops(live) == {"plugin_dropped_switch_off": 2}


@pytest.mark.parametrize("value,on", [("1", True), ("TRUE", True), ("on", True), ("0", False), ("2", False), ("", False), ("enabled", False)])
def test_switch_spellings(live, ctx, monkeypatch, av, value, on):
    monkeypatch.setenv("AV_PLUGIN_EVENTS", value)
    publish(ctx, "plugin.inventory", INVENTORY)
    assert len(emitted(live, av)) == (1 if on else 0)


def test_unknown_id_is_derived_and_stable_across_resends(live, ctx, av):
    publish(ctx, "plugin.unknown", UNKNOWN)
    publish(ctx, "plugin.unknown", dict(UNKNOWN, tools=4, action="unlisted"))  # same key, revision, state
    publish(ctx, "plugin.unknown", dict(UNKNOWN, state="enabled_not_loaded"))
    publish(ctx, "plugin.unknown", dict(UNKNOWN, revision=None))
    publish(ctx, "plugin.unknown", dict(UNKNOWN, name_hash="b" * 16))
    ids = [e["event_id"] for e in emitted(live, av)]
    assert ids[0] == ids[1]
    assert len(set(ids)) == 4
    assert all(uuid.UUID(i).version == 7 for i in ids)
    pe = live._plugin_events
    material = "|".join(("av-events|plugin.unknown", UNKNOWN["name_hash"], UNKNOWN["revision"], UNKNOWN["state"]))
    assert ids[0] == pe.derived_uuid7(0, live._COLLECTOR.keyed_hash(material))


def test_unknown_id_differs_per_tenant_key(live, ctx, av):
    publish(ctx, "plugin.unknown", UNKNOWN)
    first = emitted(live, av)[0]["event_id"]
    live._COLLECTOR._hash_key = b"another tenant's key"
    publish(ctx, "plugin.unknown", UNKNOWN)
    assert emitted(live, av)[1]["event_id"] != first


def test_unknown_without_a_hash_key_gets_a_fresh_id(live, ctx, av, monkeypatch):
    monkeypatch.setattr(live._COLLECTOR, "keyed_hash", lambda text: None)
    publish(ctx, "plugin.unknown", UNKNOWN)
    publish(ctx, "plugin.unknown", UNKNOWN)
    ids = [e["event_id"] for e in emitted(live, av)]
    assert len(set(ids)) == 2 and all(uuid.UUID(i).version == 7 for i in ids)


def test_inventory_id_is_fresh_per_emit(live, ctx, av):
    publish(ctx, "plugin.inventory", INVENTORY)
    publish(ctx, "plugin.inventory", INVENTORY)
    ids = [e["event_id"] for e in emitted(live, av)]
    assert len(set(ids)) == 2


@pytest.mark.parametrize("name", [f"https://{SENTINEL}.example/p?sig=1", f"/home/hermes/{SENTINEL}", f"home/{SENTINEL.lower()}/.ssh/key", "a" * 1_000_000 + SENTINEL])
def test_a_path_or_url_shaped_name_is_nulled_and_leaks_nowhere(live, ctx, av, caplog, name):
    caplog.set_level(logging.DEBUG)
    publish(ctx, "plugin.unknown", dict(UNKNOWN, name=name))
    (event,) = emitted(live, av)
    assert event["payload"]["name"] is None
    blob = json.dumps([event, live._COLLECTOR.counters]) + caplog.text
    assert SENTINEL not in blob and SENTINEL.lower() not in blob


@pytest.mark.parametrize("extra", [{"url": f"https://github.com/{SENTINEL}/x"}, {"path": f"/home/{SENTINEL}"}, {"tool_names": [SENTINEL]}, {"install_host": f"{SENTINEL}.example/x"}])
def test_hostile_fields_drop_the_record_and_leak_nowhere(live, ctx, av, caplog, extra):
    caplog.set_level(logging.DEBUG)
    publish(ctx, "plugin.unknown", dict(UNKNOWN, **extra))
    assert emitted(live, av) == []
    blob = json.dumps([av.read_buffer(live._COLLECTOR), live._COLLECTOR.counters]) + caplog.text
    assert SENTINEL not in blob


def test_logs_carry_codes_and_counts_only(live, ctx, caplog):
    caplog.set_level(logging.DEBUG)
    for vector in VECTORS["refuse"]:
        publish(ctx, vector["type"], vector["record"])
    lines = [r.getMessage() for r in caplog.records if "plugin_" in r.getMessage()]
    assert lines and all(re.fullmatch(r"av-events: plugin_dropped_[a-z_]+=\d+", line) for line in lines)


def test_a_str_subclass_is_not_a_string(live, ctx, av):
    class Sneaky(str):
        pass

    publish(ctx, "plugin.unknown", dict(UNKNOWN, state=Sneaky("loaded")))
    assert drops(live) == {"plugin_dropped_bad_type": 1}


def test_a_raising_collector_never_propagates(live, ctx, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError(f"buffer exploded {SENTINEL}")

    monkeypatch.setattr(live._COLLECTOR, "emit", boom)
    publish(ctx, "plugin.unknown", UNKNOWN)  # FakeCtx does not swallow; the guard must
    publish(ctx, "plugin.inventory", INVENTORY)
    assert live._COLLECTOR.total_failures == 2


def test_off_with_the_hook_kill_switch(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "1")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "plugin_events")
    plugin.register(ctx)
    publish(ctx, "plugin.inventory", INVENTORY)
    publish(ctx, "plugin.unknown", UNKNOWN)
    assert emitted(plugin, av) == [] and drops(plugin) == {}


def test_idle_without_a_token(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "1")
    plugin.register(ctx)
    publish(ctx, "plugin.unknown", UNKNOWN)
    assert emitted(plugin, av) == []
