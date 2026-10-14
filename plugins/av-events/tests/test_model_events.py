"""SEC-6 half 2: `model.observed@1` / `model.offlist@1` from av-approval's bus events.

av-approval (0.5.0, to come) publishes `av-approval:model.observed` and `av-approval:model.offlist`;
this plugin rebuilds each from a closed allow-list (`_model_events.py`), drops and counts anything
else, and emits only with `AV_MODEL_EVENTS` on. The contract both sides test against is the
`model_events` section of `vectors/plugin_events_contract.json`.
"""

from __future__ import annotations

import copy
import json
import logging
import re
import uuid
from pathlib import Path

import pytest

CONTRACT_PATH = Path(__file__).parent / "vectors" / "plugin_events_contract.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
VECTORS = CONTRACT["model_events"]
BUS = {"model.observed": VECTORS["bus"]["observed"], "model.offlist": VECTORS["bus"]["offlist"]}
OBSERVED = VECTORS["accept"][0]["record"]
SENTINEL = "SENTINEL7f3a"
MODEL_ID = "^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._:-]*$"


@pytest.fixture(autouse=True)
def _switches_unset(monkeypatch):
    monkeypatch.delenv("AV_MODEL_EVENTS", raising=False)
    monkeypatch.delenv("AV_PLUGIN_EVENTS", raising=False)


@pytest.fixture()
def live(plugin, ctx, monkeypatch):
    """A registered plugin with a token and the switch on."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_MODEL_EVENTS", "1")
    plugin.register(ctx)
    return plugin


def publish(ctx, event_type, record):
    ctx.publish(BUS[event_type], **record)


def emitted(plugin, av):
    return [e for e in av.read_buffer(plugin._COLLECTOR) if e["event_type"] in BUS]


def drops(plugin):
    return {k: v for k, v in plugin._COLLECTOR.counters.items() if k.startswith("model_dropped_")}


# --------------------------------------------------------------------------
# The module is the contract file
# --------------------------------------------------------------------------


def test_the_module_rules_are_the_contract_section(plugin):
    me = plugin._model_events
    assert me.FIELDS == VECTORS["fields"]
    assert (me.OBSERVED_BUS_EVENT, me.OFFLIST_BUS_EVENT) == (VECTORS["bus"]["observed"], VECTORS["bus"]["offlist"])
    assert {t: v["bus"] for t, v in VECTORS["types"].items()} == {"model.observed": me.OBSERVED_BUS_EVENT, "model.offlist": me.OFFLIST_BUS_EVENT}
    assert all(v["version"] == 1 and v["actor"] == "system" for v in VECTORS["types"].values())
    assert list(me.REASONS) == VECTORS["drop_reasons"] == CONTRACT["drop_reasons"]  # the plugin events' set
    assert me.FLAG == VECTORS["switch"]["env"] == "AV_MODEL_EVENTS"
    assert me.HOOK_NAME == VECTORS["hook"] and me.DROPPED == VECTORS["counter_prefix"]


def test_field_order_and_shared_shapes(plugin):
    me = plugin._model_events
    order = ["model", "source", "trigger", "off_list_local", "allowlist_version", "hermes_version", "ts"]
    for event_type in BUS:
        assert list(VECTORS["fields"][event_type]) == order == list(me.FIELD_NAMES)
    assert VECTORS["fields"]["model.observed"] == VECTORS["fields"]["model.offlist"]
    rules = VECTORS["fields"]["model.observed"]
    assert rules["model"]["regex"] == MODEL_ID and rules["model"]["max_length"] == 100
    # SEC-3 §8.1's hermes_version, reused character for character.
    assert rules["hermes_version"] == CONTRACT["fields"]["plugin.inventory"]["hermes_version"]
    assert rules["hermes_version"]["regex"] == plugin._plugin_events.HERMES_VERSION
    assert rules["ts"]["range"] == [1700000000, 4102444800]
    assert rules["source"]["enum"] == ["request", "config_default", "session_override"]
    assert rules["trigger"]["enum"] == ["first_sight", "daily"]


def test_the_sec3_keys_are_untouched_and_model_events_is_its_own_section():
    """av-approval's SEC-3 parity test compares `bus`, `types` and runs every top-level accept vector
    through its plugin serializer; none of those may mention a model type."""
    assert set(CONTRACT["bus"]) == {"inventory", "unknown"}
    assert set(CONTRACT["types"]) == {"plugin.inventory", "plugin.unknown"}
    assert set(CONTRACT["fields"]) == {"plugin.inventory", "plugin.unknown"}
    assert {v["type"] for v in CONTRACT["accept"] + CONTRACT["refuse"]} == {"plugin.inventory", "plugin.unknown"}
    assert list(CONTRACT)[-1] == "model_events"


def test_every_vector_names_its_outcome_and_counter():
    for v in VECTORS["accept"]:
        assert (v["outcome"], v["counter"]) == ("accept", None) and v["emits"] == v["record"]
    for v in VECTORS["null"]:
        assert (v["outcome"], v["counter"]) == ("null", None)
        changed = [k for k in v["record"] if v["record"][k] != v["emits"][k]]
        assert len(changed) == 1 and v["emits"][changed[0]] is None and isinstance(v["record"][changed[0]], str)
    for v in VECTORS["refuse"]:
        assert v["outcome"] == "drop" and v["reason"] in VECTORS["drop_reasons"]
        assert v["counter"] == "model_dropped_" + v["reason"]


def test_every_field_has_a_refusal_vector():
    for event_type, fields in VECTORS["fields"].items():
        refused = {k for v in VECTORS["refuse"] if v["type"] == "model.observed" for k in fields if v["record"].get(k, ...) != OBSERVED.get(k)}
        assert refused == set(fields), event_type
    assert any(v["type"] == "model.offlist" for v in VECTORS["refuse"])


def test_the_brief_vectors_are_all_present():
    notes = {v["note"] for key in ("accept", "null", "refuse") for v in VECTORS[key]}
    models = [v["record"]["model"] for v in VECTORS["accept"] if v["type"] == "model.observed"]
    assert "openai/gpt-4o-mini" in models and any(m and m.endswith(":free") for m in models) and None in models
    assert any(v["record"]["off_list_local"] is None for v in VECTORS["accept"])
    assert any(v["record"]["trigger"] == "daily" for v in VECTORS["accept"])
    nulled = [v["record"]["model"] for v in VECTORS["null"]]
    assert "OpenAI/GPT-4o" in nulled and "gpt-4o-mini" in nulled and "openai/gpt-4o-mini\n" in nulled
    assert any(len(m) == 101 for m in nulled) and any(m.startswith("https://") for m in nulled)
    for note in ("ts a bool", "ts a float", "allowlist_version 11 hex", "off_list_local an int", "source outside its set",
                 "trigger outside its set", "an extra field (provider)", "missing ts"):
        assert note in notes, note


# --------------------------------------------------------------------------
# Subscriptions
# --------------------------------------------------------------------------


def test_both_bus_names_are_subscribed_exactly_once(plugin, ctx):
    plugin.register(ctx)
    plugin.register(ctx)  # idempotent
    for name in BUS.values():
        assert len(ctx.subscriptions[name]) == 1
    assert set(ctx.subscriptions) == set(plugin.SUBSCRIPTION_BODIES)
    assert plugin.SUBSCRIPTION_BODIES[BUS["model.observed"]] == ("model_events", plugin._model_events.on_observed)
    assert plugin.SUBSCRIPTION_BODIES[BUS["model.offlist"]] == ("model_events", plugin._model_events.on_offlist)


# --------------------------------------------------------------------------
# Every vector through `_deliver` (the bus) and `rebuild`
# --------------------------------------------------------------------------


@pytest.mark.parametrize("vector", VECTORS["accept"] + VECTORS["null"], ids=lambda v: f'{v["type"]}:{v["outcome"]}:{v["note"]}')
def test_accept_and_null_vectors(live, ctx, av, vector):
    me = live._model_events
    assert me.rebuild(vector["type"], dict(vector["record"])) == (vector["emits"], None)
    publish(ctx, vector["type"], vector["record"])
    (event,) = emitted(live, av)
    assert event["event_type"] == vector["type"]
    assert event["schema_version"] == 1
    assert event["actor"] == "system"
    assert event["payload"] == vector["emits"]
    assert list(event["payload"]) == list(VECTORS["fields"][vector["type"]])
    assert type(event["payload"]["ts"]) is int
    assert uuid.UUID(event["event_id"]).version == 7
    assert drops(live) == {}


@pytest.mark.parametrize("vector", VECTORS["refuse"], ids=lambda v: f'{v["type"]}:{v["note"]}')
def test_refuse_vectors_drop_the_whole_record_and_count_it(live, ctx, av, vector):
    assert live._model_events.rebuild(vector["type"], dict(vector["record"])) == (None, vector["reason"])
    publish(ctx, vector["type"], vector["record"])
    assert emitted(live, av) == []
    assert drops(live) == {vector["counter"]: 1}
    assert live._COLLECTOR.total_failures == 0  # dropped, never raised


def test_the_offlist_type_carries_the_same_fields(live, ctx, av):
    record = dict(OBSERVED, off_list_local=True, model="x-ai/grok-4")
    publish(ctx, "model.observed", record)
    publish(ctx, "model.offlist", record)
    observed, offlist = emitted(live, av)
    assert (observed["event_type"], offlist["event_type"]) == ("model.observed", "model.offlist")
    assert observed["payload"] == offlist["payload"] == record
    assert list(offlist["payload"]) == list(live._model_events.FIELD_NAMES)
    assert observed["event_id"] != offlist["event_id"]


# --------------------------------------------------------------------------
# The switch
# --------------------------------------------------------------------------


def test_switch_off_by_default_counts_and_emits_nothing(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    publish(ctx, "model.observed", OBSERVED)
    publish(ctx, "model.offlist", OBSERVED)
    publish(ctx, "model.observed", dict(OBSERVED, base_url="https://x"))  # off wins over shape
    assert emitted(plugin, av) == []
    assert drops(plugin) == {"model_dropped_switch_off": 3}


def test_the_plugin_events_switch_does_not_turn_it_on(plugin, ctx, monkeypatch, av):
    """AV_MODEL_EVENTS is separate from AV_PLUGIN_EVENTS, both ways."""
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "1")
    plugin.register(ctx)
    publish(ctx, "model.observed", OBSERVED)
    assert emitted(plugin, av) == [] and drops(plugin) == {"model_dropped_switch_off": 1}
    monkeypatch.setenv("AV_MODEL_EVENTS", "1")
    monkeypatch.setenv("AV_PLUGIN_EVENTS", "0")
    publish(ctx, "model.observed", OBSERVED)
    assert len(emitted(plugin, av)) == 1
    assert "plugin_dropped_switch_off" not in plugin._COLLECTOR.counters


def test_the_switch_is_read_per_emit(live, ctx, monkeypatch, av):
    publish(ctx, "model.observed", OBSERVED)
    monkeypatch.setenv("AV_MODEL_EVENTS", "off")
    publish(ctx, "model.observed", OBSERVED)
    monkeypatch.delenv("AV_MODEL_EVENTS")
    publish(ctx, "model.offlist", OBSERVED)
    monkeypatch.setenv("AV_MODEL_EVENTS", " Yes ")
    publish(ctx, "model.offlist", OBSERVED)
    assert len(emitted(live, av)) == 2
    assert drops(live) == {"model_dropped_switch_off": 2}


@pytest.mark.parametrize("value,on", [("1", True), ("TRUE", True), ("yes", True), ("on", True), ("0", False), ("2", False), ("", False), ("enabled", False)])
def test_switch_spellings(live, ctx, monkeypatch, av, value, on):
    monkeypatch.setenv("AV_MODEL_EVENTS", value)
    publish(ctx, "model.observed", OBSERVED)
    assert len(emitted(live, av)) == (1 if on else 0)


def test_the_switch_spellings_are_the_contract(plugin):
    assert VECTORS["switch"] == {"env": "AV_MODEL_EVENTS", "on": ["1", "true", "yes", "on"], "default": "off", "read": "per emit"}
    core = __import__(f"{plugin.__name__}._core", fromlist=["_core"])
    assert set(VECTORS["switch"]["on"]) == core.TRUTHY


def test_switch_off_is_counted_without_a_log_line(plugin, ctx, monkeypatch, caplog):
    collector_module = __import__(f"{plugin.__name__}._collector", fromlist=["_collector"])
    monkeypatch.setattr(collector_module, "_LOGGED_COUNTERS", set())
    assert "model_dropped_switch_off" in collector_module._QUIET_COUNTERS
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    plugin.register(ctx)
    with caplog.at_level(logging.DEBUG):
        publish(ctx, "model.observed", OBSERVED)
        publish(ctx, "model.offlist", OBSERVED)
        monkeypatch.setenv("AV_MODEL_EVENTS", "1")
        publish(ctx, "model.observed", dict(OBSERVED, ts=True))
        publish(ctx, "model.observed", dict(OBSERVED, ts=True))
    assert drops(plugin) == {"model_dropped_switch_off": 2, "model_dropped_bad_type": 2}
    lines = [r.getMessage() for r in caplog.records if "model_dropped" in r.getMessage()]
    assert lines == ["av-events: model_dropped_bad_type=1"]


def test_off_with_the_hook_kill_switch(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_MODEL_EVENTS", "1")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "model_events")
    plugin.register(ctx)
    publish(ctx, "model.observed", OBSERVED)
    publish(ctx, "model.offlist", OBSERVED)
    assert emitted(plugin, av) == [] and drops(plugin) == {}


def test_the_plugin_events_kill_switch_leaves_model_events_on(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_EVENTS_TOKEN", "test-token")
    monkeypatch.setenv("AV_MODEL_EVENTS", "1")
    monkeypatch.setenv("AV_HOOKS_DISABLED", "plugin_events")
    plugin.register(ctx)
    publish(ctx, "model.observed", OBSERVED)
    assert len(emitted(plugin, av)) == 1


def test_idle_without_a_token(plugin, ctx, monkeypatch, av):
    monkeypatch.setenv("AV_MODEL_EVENTS", "1")
    plugin.register(ctx)
    publish(ctx, "model.observed", OBSERVED)
    assert emitted(plugin, av) == []


# --------------------------------------------------------------------------
# Publisher rules (SEC-3 §8 / §8.1): sanitize, no value logged, fresh id, fresh dict
# --------------------------------------------------------------------------


@pytest.mark.parametrize("model", ["sk-proj-" + "a" * 16 + "/y", "openai/sk-proj-" + "b" * 16, "sk-or-v1-" + "c" * 20 + "/x", "vendor/123456789:" + "d" * 30])
@pytest.mark.parametrize("event_type", ["model.observed", "model.offlist"])
def test_a_model_sanitize_would_rewrite_is_nulled_not_redacted(live, ctx, av, model, event_type):
    """A secret-shaped model id passes MODEL_ID, but `Collector.emit` would redact it and data would
    then quarantine the event; it is sent as null instead."""
    assert re.fullmatch(MODEL_ID, model)
    assert live._model_events.sanitize(model) != model
    assert live._model_events.rebuild(event_type, dict(OBSERVED, model=model))[0]["model"] is None
    publish(ctx, event_type, dict(OBSERVED, model=model))
    (event,) = emitted(live, av)
    assert event["payload"]["model"] is None
    assert "redacted" not in json.dumps(event["payload"])
    assert drops(live) == {}


def test_a_short_sk_lookalike_is_not_a_secret_and_is_kept(live, ctx, av):
    """`sk-proj-x/y` is regex-valid and `sanitize` leaves it alone (its key shapes need 16 or more
    characters), so it is sent as it came; the null rule is only for what `sanitize` would rewrite."""
    assert live._model_events.sanitize("sk-proj-x/y") == "sk-proj-x/y"
    publish(ctx, "model.observed", dict(OBSERVED, model="sk-proj-x/y"))
    (event,) = emitted(live, av)
    assert event["payload"]["model"] == "sk-proj-x/y"


def test_a_non_nullable_value_sanitize_would_rewrite_drops_as_bad_shape(live, ctx, av, monkeypatch):
    me = live._model_events
    real = me.sanitize
    monkeypatch.setattr(me, "sanitize", lambda v: "[redacted:x]" if v == OBSERVED["source"] else real(v))
    publish(ctx, "model.observed", OBSERVED)
    assert emitted(live, av) == []
    assert drops(live) == {"model_dropped_bad_shape": 1}


def test_length_is_checked_before_the_regex(live, monkeypatch):
    me = live._model_events
    seen = []

    class Spy:
        def __init__(self, inner):
            self.inner = inner

        def fullmatch(self, value):
            seen.append(len(value))
            return self.inner.fullmatch(value)

    monkeypatch.setitem(me._PATTERNS, ("model.observed", "model"), Spy(me._PATTERNS[("model.observed", "model")]))
    assert me.rebuild("model.observed", dict(OBSERVED, model="a/" + "b" * 1_000_000))[0]["model"] is None
    assert me.rebuild("model.observed", dict(OBSERVED, model="a/" + "b" * 98))[0]["model"] == "a/" + "b" * 98
    assert seen == [100]


def test_model_is_never_lower_cased(live):
    payload, _ = live._model_events.rebuild("model.observed", dict(OBSERVED, model="Openai/gpt-4o"))
    assert payload["model"] is None


@pytest.mark.parametrize("model", [f"https://{SENTINEL}.example/v1?key=1", f"/home/hermes/{SENTINEL}", "a/" + "b" * 1_000_000 + SENTINEL, f"{SENTINEL}/x", f"openai/{SENTINEL}\n"])
def test_a_hostile_model_is_nulled_and_leaks_nowhere(live, ctx, av, caplog, model):
    caplog.set_level(logging.DEBUG)
    publish(ctx, "model.observed", dict(OBSERVED, model=model))
    (event,) = emitted(live, av)
    assert event["payload"]["model"] is None
    blob = json.dumps([event, live._COLLECTOR.counters]) + caplog.text
    assert SENTINEL not in blob and SENTINEL.lower() not in blob


@pytest.mark.parametrize("extra", [{"base_url": f"https://{SENTINEL}.example/v1"}, {"prompt": SENTINEL}, {"api_key": "sk-or-v1-" + SENTINEL * 3}, {"model": [SENTINEL]}])
def test_hostile_fields_drop_the_record_and_leak_nowhere(live, ctx, av, caplog, extra):
    caplog.set_level(logging.DEBUG)
    publish(ctx, "model.observed", dict(OBSERVED, **extra))
    assert emitted(live, av) == []
    blob = json.dumps([av.read_buffer(live._COLLECTOR), live._COLLECTOR.counters]) + caplog.text
    assert SENTINEL not in blob


def test_no_value_is_logged(live, ctx, caplog):
    """Every refuse vector, plus a sentinel model that is accepted: the log carries counter names
    and counts only, never a value."""
    caplog.set_level(logging.DEBUG)
    for vector in VECTORS["refuse"]:
        publish(ctx, vector["type"], vector["record"])
    publish(ctx, "model.observed", dict(OBSERVED, model=f"vendor/{SENTINEL.lower()}"))
    publish(ctx, "model.observed", dict(OBSERVED, model=f"Vendor/{SENTINEL}"))
    lines = [r.getMessage() for r in caplog.records if "model_" in r.getMessage()]
    assert lines and all(re.fullmatch(r"av-events: model_dropped_[a-z_]+=\d+", line) for line in lines)
    assert SENTINEL not in caplog.text and SENTINEL.lower() not in caplog.text


def test_a_fresh_id_per_emit(live, ctx, av):
    for _ in range(3):
        publish(ctx, "model.observed", OBSERVED)
    publish(ctx, "model.offlist", OBSERVED)
    ids = [e["event_id"] for e in emitted(live, av)]
    assert len(set(ids)) == 4 and all(uuid.UUID(i).version == 7 for i in ids)


def test_a_fresh_dict_per_emit_never_mutated_after_emit(live, ctx, monkeypatch):
    sent = []
    real = live._COLLECTOR.emit

    def spy(event_type, payload, **refs):
        sent.append((payload, copy.deepcopy(payload), dict(refs)))
        return real(event_type, payload, **refs)

    monkeypatch.setattr(live._COLLECTOR, "emit", spy)
    record = dict(OBSERVED)
    publish(ctx, "model.observed", record)
    publish(ctx, "model.observed", record)
    publish(ctx, "model.offlist", dict(OBSERVED, model="OpenAI/GPT-4o"))
    assert len(sent) == 3
    assert len({id(p) for p, _, _ in sent}) == 3  # a fresh dict each time
    assert all(p is not record for p, _, _ in sent)
    assert all(p == snapshot for p, snapshot, _ in sent)  # nothing touched them after emit
    assert record == OBSERVED  # nor the publisher's record
    assert all(refs == {"actor": "system"} for _, _, refs in sent)  # no derived id, no session ref


def test_a_str_subclass_is_not_a_string(live, ctx, av):
    class Sneaky(str):
        pass

    publish(ctx, "model.observed", dict(OBSERVED, model=Sneaky("openai/gpt-4o-mini")))
    publish(ctx, "model.observed", dict(OBSERVED, source=Sneaky("request")))
    assert drops(live) == {"model_dropped_bad_type": 2}


def test_an_int_subclass_and_a_bool_ts_drop(live):
    me = live._model_events

    class Sneaky(int):
        pass

    assert me.rebuild("model.observed", dict(OBSERVED, ts=Sneaky(1760400000))) == (None, "bad_type")
    assert me.rebuild("model.observed", dict(OBSERVED, ts=False)) == (None, "bad_type")
    assert me.rebuild("model.observed", dict(OBSERVED, off_list_local=1.0)) == (None, "bad_type")


@pytest.mark.parametrize("event_type", ["model.observed", "model.offlist"])
def test_a_collector_key_drops_as_extra_field_and_never_raises(live, ctx, av, event_type):
    publish(ctx, event_type, dict(OBSERVED, collector="x"))
    assert emitted(live, av) == []
    assert drops(live) == {"model_dropped_extra_field": 1}
    assert live._COLLECTOR.total_failures == 0


def test_a_raising_collector_never_propagates(live, ctx, monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError(f"buffer exploded {SENTINEL}")

    monkeypatch.setattr(live._COLLECTOR, "emit", boom)
    publish(ctx, "model.observed", OBSERVED)  # FakeCtx does not swallow; the guard must
    publish(ctx, "model.offlist", OBSERVED)
    assert live._COLLECTOR.total_failures == 2


def test_the_rule_tables_are_separate_objects(plugin):
    me = plugin._model_events
    assert me.FIELDS["model.observed"] is not me.FIELDS["model.offlist"]
    assert me.FIELDS["model.observed"]["model"] is not me.FIELDS["model.offlist"]["model"]
