"""SEC-6 half 2: the model observer (`_models.py`, av-approval 0.5.0, observe only).

Hermes-free: hook payload shapes, nulling (the contract's vectors and av-events' credential shapes), first-sight
dedupe and its 256 bound, the 24 h heartbeat on a fake clock, list parsing and `allowlist_version`, mode off,
subscribe-once / unsubscribe-on-unload, never-raise with hostile input, the closed payload, PARITY with the
`model_events` section of `plugins/av-events/tests/vectors/plugin_events_contract.json`, and three mutation checks
(dedupe off, nulling off, list parsing off). Hermes-backed (a subprocess; skipped unless `hermes_cli` and
`ruamel.yaml` import, e.g. `PYTHONPATH=<hermes ref>:<ruamel>`): the ref's `_fire_pre_api_request_hook` on the real
`ApiRequestHooksMixin` with a stub agent, an `llm_request` middleware rewriting the id, and `persist_model_selection`
(the `/model --global` writer) seen by the next tick.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from .conftest import PLUGIN_DIR, load_plugin

CONTRACT = json.loads((PLUGIN_DIR.parent / "av-events" / "tests" / "vectors" / "plugin_events_contract.json")
                      .read_text(encoding="utf-8"))["model_events"]
#: Pinned with install/tests/model_allow.test.ts (the installer's union with FALLBACK_MODEL).
LIST = ["openai/gpt-6-luna", "openai/gpt-4o-mini"]
LIST_VERSION = "fda54b54da8b"
LOGGER = "av-approval.models"
#: data#539's `tests/fixtures/model-allowlist-version.v1.json` (agentvillage-data fa754673, blob ad2df959), copied.
DATA_VERSIONS = json.loads((PLUGIN_DIR / "tests" / "vectors" / "model-allowlist-version.v1.json").read_text(encoding="utf-8"))
#: ov#336 (merged at ec921b30): main's `model_events.null` carries the credential-shaped ids; we null all of them.
NULL_VECTORS = CONTRACT["null"]


def _mod():
    plugin = load_plugin()
    return __import__(f"{plugin.__name__}._models", fromlist=["_models"])


class Handle:
    def __init__(self):
        self.active = True

    def dispose(self):
        self.active = False


class Ctx:
    def __init__(self):
        self.hooks, self.emitted, self.unloads = {}, [], []

    def register_hook(self, name, cb):
        self.hooks.setdefault(name, []).append(cb)
        return Handle()

    def emit(self, event, payload=None):
        self.emitted.append((event, payload))

    def on_unload(self, cb):
        self.unloads.append(cb)

    def fire(self, **kwargs):
        return [cb(**kwargs) for cb in self.hooks.get("pre_api_request", [])]


def _cfg(home: Path, default="openai/gpt-4o-mini", **block):
    cfg = {"model": {"default": default, "provider": "openrouter"}}
    if block:
        cfg["av_approval"] = block
    (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    return cfg


@pytest.fixture
def obs(tmp_path, clean_env):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("_HERMES_GATEWAY", "1")
    mod = _mod()
    _cfg(tmp_path, model_allow=LIST)
    ctx = Ctx()
    assert mod.start(ctx) is True
    return mod, tmp_path, ctx


def _models(ctx, event="model.observed"):
    return [p["model"] for e, p in ctx.emitted if e == event]


def contract_drop(event: str, payload: dict):
    """The contract file's verdict, rule by rule: None (accepted) or the reason."""
    rules = CONTRACT["fields"][event]
    if list(payload) != list(rules):
        return "fields"
    for key, rule in rules.items():
        value, kind = payload[key], rule["kind"]
        if value is None:
            if not rule["nullable"]:
                return "bad_type"
        elif kind == "int":
            if type(value) is not int or not rule["range"][0] <= value <= rule["range"][1]:
                return "bad_range"
        elif kind == "bool":
            if type(value) is not bool:
                return "bad_type"
        elif type(value) is not str:
            return "bad_type"
        elif kind == "enum":
            if value not in rule["enum"]:
                return "bad_enum"
        elif len(value) > rule.get("max_length", len(value)) or not __import__("re").fullmatch(rule["regex"], value):
            return "bad_shape"
    return None


# ---------------------------------------------------------------------------
# The request half
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("request_, kwarg, want", [
    ({"method": "POST", "body": {"model": "x-ai/grok-4"}}, "openai/gpt-4o-mini", "x-ai/grok-4"),
    (None, "openai/gpt-4o-mini", "openai/gpt-4o-mini"),
    ("not a dict", "openai/gpt-4o-mini", "openai/gpt-4o-mini"),
    ({"body": "not a dict"}, "openai/gpt-4o-mini", "openai/gpt-4o-mini"),
    ({"_truncated": True, "original_type": "dict", "preview": "{...}"}, "openai/gpt-4o-mini", "openai/gpt-4o-mini"),
    ({"body": {"model": 7}}, "openai/gpt-4o-mini", None),
    ({"body": {}}, None, None),
    ({"body": {"model": "OpenAI/GPT-4o"}}, None, None),
])
def test_hook_payload_shapes(obs, request_, kwarg, want):
    mod, _home, ctx = obs
    assert ctx.fire(model=kwarg, request=request_, session_id="s-1", provider="openrouter",
                    base_url="https://example.invalid/v1", user_message="hello") == [None]
    assert _models(ctx) == [want]


class Hostile(dict):
    def get(self, *_a):
        raise RuntimeError("boom")


class Weird(str):
    def __hash__(self):
        raise RuntimeError("boom")


def test_never_raises_on_hostile_input_or_a_failing_bus_or_logger(obs, monkeypatch, caplog):
    mod, _home, ctx = obs
    for request_, kwarg in ((Hostile(body={"model": "a/b"}), Weird("a/b")), ({"body": Hostile()}, object()),
                            ({"body": {"model": Weird("c/d")}}, None)):
        assert ctx.fire(model=kwarg, request=request_) == [None]
    with monkeypatch.context() as m:
        m.setattr(ctx, "emit", lambda *a: (_ for _ in ()).throw(RuntimeError("bus down")))
        m.setattr(mod.logger, "log", lambda *a: (_ for _ in ()).throw(RuntimeError("log down")))
        assert ctx.fire(model="e/f", request=None) == [None]
    mod._state()["hot"] = lambda *a: (_ for _ in ()).throw(ValueError("hot path"))
    with caplog.at_level(logging.DEBUG, logger=LOGGER):
        assert ctx.fire(model="g/h", request=None) == [None] and ctx.fire(model="i/j", request=None) == [None]
    errors = [r for r in caplog.records if "observer error" in r.getMessage()]
    assert [(r.levelno, r.getMessage()) for r in errors] == [(logging.DEBUG, "av-approval: model: observer error (ValueError)")]


def check_dedupe(mod, ctx):
    for _ in range(1000):
        ctx.fire(model="openai/gpt-4o-mini", request={"body": {"model": "openai/gpt-4o-mini"}})
    assert _models(ctx) == ["openai/gpt-4o-mini"]
    for i in range(mod.SEEN_MAX):
        ctx.fire(model=f"v/m{i}")
    assert len(mod._state()["seen"]) == mod.SEEN_MAX
    ctx.fire(model="openai/gpt-4o-mini")  # dropped as the oldest: seen again
    ctx.fire(model=f"v/m{mod.SEEN_MAX - 1}")  # still held: not
    assert _models(ctx).count("openai/gpt-4o-mini") == 2 and len(_models(ctx)) == mod.SEEN_MAX + 2


def test_first_sight_dedupe_is_bounded_at_256(obs):
    mod, _home, ctx = obs
    check_dedupe(mod, ctx)


# ---------------------------------------------------------------------------
# Nulling: the contract's vectors and av-events' credential shapes
# ---------------------------------------------------------------------------

def check_nulling(mod):
    for vector in NULL_VECTORS:
        assert mod.serialize(vector["record"]) == vector["emits"], vector["note"]
    for value in ("openai/sk-proj-" + "b" * 16, "sk-or-v1-" + "c" * 20 + "/x", "vendor/123456789:" + "d" * 30):
        assert mod.shape_model(value) is None, value
    assert mod.shape_model("sk-proj-x/y") == "sk-proj-x/y"  # too short for a key shape: kept, as av-events keeps it


def test_nulling_vectors_and_credential_shapes(obs, caplog):
    mod, _home, ctx = obs
    check_nulling(mod)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        ctx.fire(model="openai/sk-proj-" + "b" * 16)
    assert _models(ctx) == [None]
    assert [r.getMessage() for r in caplog.records] == ["av-approval: model: invalid (request, off-list)"]


def test_the_contract_carries_ov336s_credential_shaped_null_vectors():
    shaped = {(v["type"], v["record"]["model"]) for v in NULL_VECTORS}
    sk_proj = "openai/sk-proj-" + "b" * 16
    assert {("model.observed", sk_proj), ("model.observed", "sk-or-v1-" + "c" * 20 + "/x"),
            ("model.offlist", sk_proj)} <= shaped


def test_secret_patterns_are_av_events_patterns_character_for_character():
    spec = importlib.util.spec_from_file_location("av_events_core_probe", PLUGIN_DIR.parent / "av-events" / "_core.py")
    core = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(core)
    mod = _mod()
    assert [(l, p.pattern, p.flags) for l, p in mod._SECRET_PATTERNS] == \
        [(l, p.pattern, p.flags) for l, p in core._SECRET_PATTERNS]
    for value in ("openai/sk-proj-" + "b" * 16, "sk-proj-x/y", "openai/gpt-4o-mini"):
        assert (mod.shape_model(value) is None) == (core.sanitize(value) != value)


# ---------------------------------------------------------------------------
# The local list, the version, the verdict
# ---------------------------------------------------------------------------

def check_list(mod):
    assert mod.parse_allow({}) == (None, None, 0)
    assert mod.parse_allow({"av_approval": {"model_observer": "on"}}) == (None, None, 0)
    assert mod.parse_allow({"av_approval": {"model_allow": None}}) == (None, None, 0)
    assert mod.parse_allow({"av_approval": {"model_allow": "a/b,c/d"}}) == (None, None, 1)
    assert mod.parse_allow({"av_approval": {"model_allow": []}}) == (frozenset({mod.FALLBACK_MODEL}), "e5d076977e95", 0)
    garbage = ["OpenAI/X", 7, None, "nos", "a/" + "b" * 99, "https://x.example/v1", "openai/gpt-4o-mini\n",
               *LIST, LIST[0], ["x/y"]]
    assert mod.parse_allow({"av_approval": {"model_allow": garbage}}) == (frozenset(LIST), LIST_VERSION, 8)
    assert mod.parse_allow({"av_approval": {"model_allow": list(reversed(LIST))}})[1] == LIST_VERSION


def test_list_parsing_and_allowlist_version(obs):
    mod, _home, _ctx = obs
    check_list(mod)
    assert mod.allowlist_version(["openai/gpt-6-luna"]) == "e5d076977e95"


def test_allowlist_version_is_datas_recipe_on_every_fixture_row():
    mod = _mod()
    assert (DATA_VERSIONS["model_id"], DATA_VERSIONS["max_length"]) == (mod.MODEL_ID, mod.MODEL_MAX)
    assert mod.allowlist_version(["anthropic/claude-haiku-5.5", "openai/gpt-6-luna"]) == "edb4be534c03"
    for row in DATA_VERSIONS["vectors"]:
        assert ",".join(sorted(row["ids"])) == row["joined"] and mod.allowlist_version(row["ids"]) == row["version"]
        entries = [e.strip() for e in row["env"].split(",") if e.strip()]  # as the installer writes them
        ids, version, invalid = mod.parse_allow({"av_approval": {"model_allow": entries}})
        assert ids == frozenset(row["ids"]) | {mod.FALLBACK_MODEL} and invalid == row["dropped"], row["note"]
        if mod.FALLBACK_MODEL in row["ids"]:
            assert version == row["version"], row["note"]


def test_the_list_is_capped_at_64_ids_besides_the_fallback():
    mod = _mod()
    vendors = [f"vendor/m{i:02d}" for i in range(70)]
    ids, version, dropped = mod.parse_allow({"av_approval": {"model_allow": vendors}})
    assert ids == frozenset(vendors[:64]) | {mod.FALLBACK_MODEL} and dropped == 6
    assert version == mod.allowlist_version([*vendors[:64], mod.FALLBACK_MODEL]) == "be3a3f29e54d"  # data's 65-id row
    written = sorted([*vendors[:64], mod.FALLBACK_MODEL])  # what the installer writes: kept whole
    assert mod.parse_allow({"av_approval": {"model_allow": written}}) == (frozenset(written), "be3a3f29e54d", 0)


def test_fallback_model_is_the_installers():
    text = (PLUGIN_DIR.parents[1] / "install" / "config.ts").read_text(encoding="utf-8")
    assert f'export const FALLBACK_MODEL = "{_mod().FALLBACK_MODEL}";' in text


def test_restart_starts_over_boot_rows_are_first_sight_daily_needs_24h_uptime(obs):
    mod, home, ctx = obs
    t0 = 1_760_400_000
    cfg = _cfg(home, model_allow=LIST)
    mod.on_tick(cfg, now=t0)
    ctx.fire(model="openai/gpt-4o-mini")
    mod._reset()  # a gateway restart: no state survives (nothing on disk)
    ctx2 = Ctx()
    assert mod.start(ctx2)
    mod.on_tick(cfg, now=t0 + 3600)  # the boot pass
    ctx2.fire(model="openai/gpt-4o-mini")
    mod.on_tick(cfg, now=t0 + 3600 + mod.DAILY_S - 1)
    mod.on_tick(cfg, now=t0 + 3600 + mod.DAILY_S)
    rows = lambda c: [(p["source"], p["trigger"]) for e, p in c.emitted if e == "model.observed"]
    assert rows(ctx) == [("config_default", "first_sight"), ("request", "first_sight")]
    assert rows(ctx2) == [("config_default", "first_sight"), ("request", "first_sight"), ("config_default", "daily")]


def test_invalid_entries_are_logged_once(tmp_path, clean_env, caplog):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("_HERMES_GATEWAY", "1")
    mod = _mod()
    cfg = _cfg(tmp_path, model_allow=[*LIST, "BAD", 3])
    with caplog.at_level(logging.INFO, logger=LOGGER):
        mod.start(Ctx())
        mod.on_tick(cfg, now=1_760_400_000)
        mod.on_tick(cfg, now=1_760_400_900)
    lines = [r.getMessage() for r in caplog.records]
    assert lines.count("av-approval: model: av_approval.model_allow: 2 entries dropped (invalid or past the 64-id cap)") == 1
    assert "BAD" not in "\n".join(lines)


@pytest.mark.parametrize("block, model, verdict, events", [
    ({"model_allow": LIST}, "openai/gpt-4o-mini", "on-list", ["model.observed"]),
    ({"model_allow": LIST}, "x-ai/grok-4", "off-list", ["model.observed", "model.offlist"]),
    ({}, "x-ai/grok-4", "no-list", ["model.observed"]),
])
def test_verdict_events_and_the_one_log_line(tmp_path, clean_env, caplog, block, model, verdict, events):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("_HERMES_GATEWAY", "1")
    mod = _mod()
    _cfg(tmp_path, **block)
    ctx = Ctx()
    mod.start(ctx)
    with caplog.at_level(logging.DEBUG, logger="av-approval"):
        ctx.fire(model=model, request={"body": {"model": model}}, session_id="s-SENTINEL", user_message="SENTINEL")
    assert [e for e, _ in ctx.emitted] == events
    payloads = [p for _, p in ctx.emitted]
    assert all(contract_drop(e, p) is None for e, p in ctx.emitted)
    assert len({id(p) for p in payloads}) == len(payloads) and all(p == payloads[0] for p in payloads)
    assert payloads[0]["off_list_local"] is {"on-list": False, "off-list": True, "no-list": None}[verdict]
    assert payloads[0]["allowlist_version"] == (LIST_VERSION if block else None)
    assert "SENTINEL" not in json.dumps(payloads) and "example" not in json.dumps(payloads)
    level = logging.WARNING if verdict == "off-list" else logging.INFO
    assert [(r.levelno, r.getMessage()) for r in caplog.records] == [(level, f"av-approval: model: {model} (request, {verdict})")]


# ---------------------------------------------------------------------------
# The config half: the tick, the heartbeat
# ---------------------------------------------------------------------------

def test_tick_first_sight_change_and_daily_heartbeat(obs, caplog):
    mod, home, ctx = obs
    t0 = 1_760_400_000
    cfg = _cfg(home, model_allow=LIST)
    with caplog.at_level(logging.INFO, logger=LOGGER):
        mod.on_tick(cfg, now=t0)
        mod.on_tick(cfg, now=t0 + 900)  # quiet
        changed = _cfg(home, default="x-ai/grok-4", model_allow=LIST)
        mod.on_tick(changed, now=t0 + 1800)
        mod.on_tick(changed, now=t0 + 1800 + mod.DAILY_S - 1)  # quiet
        mod.on_tick(changed, now=t0 + 1800 + mod.DAILY_S)
        mod.on_tick({"model": "x-ai/grok-4", "av_approval": {"model_allow": [*LIST, "x-ai/grok-4"]}},
                    now=t0 + 1800 + mod.DAILY_S + 900)  # a bare string default; a new list is a new sight
        mod.on_tick(None, now=t0 + 3 * mod.DAILY_S)  # unreadable: nothing
    got = [(e, p["model"], p["source"], p["trigger"], p["off_list_local"]) for e, p in ctx.emitted]
    assert got == [
        ("model.observed", "openai/gpt-4o-mini", "config_default", "first_sight", False),
        ("model.observed", "x-ai/grok-4", "config_default", "first_sight", True),
        ("model.offlist", "x-ai/grok-4", "config_default", "first_sight", True),
        ("model.observed", "x-ai/grok-4", "config_default", "daily", True),
        ("model.offlist", "x-ai/grok-4", "config_default", "daily", True),
        ("model.observed", "x-ai/grok-4", "config_default", "first_sight", False),
    ]
    assert all(contract_drop(e, p) is None for e, p in ctx.emitted)
    assert len(caplog.records) == 4


def test_the_sec3_pass_hands_its_parse_to_the_observer(tmp_path, clean_env, monkeypatch):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    plugin = load_plugin()
    plugins = __import__(f"{plugin.__name__}._plugins", fromlist=["_plugins"])
    models = __import__(f"{plugin.__name__}._models", fromlist=["_models"])
    cfg = _cfg(tmp_path, model_allow=LIST)
    seen, reads = [], []
    real = plugins.read_config
    monkeypatch.setattr(plugins, "read_config", lambda home: reads.append(home) or real(home))
    monkeypatch.setattr(models, "on_tick", lambda config, now=None: seen.append((config, now)))
    monkeypatch.setattr(plugins, "bundled_facts", lambda: (_ for _ in ()).throw(RuntimeError("no hermes")))
    plugins._state().update(home=tmp_path, manager=None, expected={})
    assert plugins.run_pass("tick", now=123.0) is None  # the rest of the pass fails here; the observer ran first
    assert seen == [(cfg, 123.0)] and len(reads) == 1


# ---------------------------------------------------------------------------
# Mode, the gateway gate, subscribe once
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text", ["av_approval:\n  model_observer: off\n", "av_approval:\n  model_observer: 'OFF'\n"])
def test_off_subscribes_nothing_and_logs_nothing(tmp_path, clean_env, caplog, text):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("_HERMES_GATEWAY", "1")
    (tmp_path / "config.yaml").write_text("model:\n  default: x-ai/grok-4\n" + text, encoding="utf-8")
    mod = _mod()
    ctx = Ctx()
    with caplog.at_level(logging.DEBUG, logger="av-approval"):
        assert mod.start(ctx) is False
        mod.on_tick(yaml.safe_load((tmp_path / "config.yaml").read_text()), now=1_760_400_000)
    assert ctx.hooks == {} and ctx.emitted == [] and ctx.unloads == [] and caplog.records == []


def test_off_at_a_tick_silences_both_halves_until_on(obs):
    mod, home, ctx = obs
    mod.on_tick(_cfg(home, model_observer=False, model_allow=LIST), now=1_760_400_000)
    ctx.fire(model="x-ai/grok-4")
    assert ctx.emitted == []
    mod.on_tick(_cfg(home, model_observer="on", model_allow=LIST), now=1_760_400_900)
    ctx.fire(model="x-ai/grok-4")
    assert [(p["source"], p["model"]) for e, p in ctx.emitted if e == "model.observed"] == \
        [("config_default", "openai/gpt-4o-mini"), ("request", "x-ai/grok-4")]


def test_outside_the_gateway_nothing_is_subscribed(tmp_path, clean_env, monkeypatch):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes", "chat"])
    ctx = Ctx()
    load_plugin().register(ctx)
    assert "pre_api_request" not in ctx.hooks


def test_subscribed_once_across_register_and_reload_and_dropped_on_unload(obs):
    mod, _home, ctx = obs
    assert mod.start(ctx) and mod.start(Ctx())
    sys.modules.pop(mod.__name__)
    mod2 = _mod()  # Hermes re-imports the plugin on a forced re-discovery
    assert mod2 is not mod and mod2.start(ctx)
    assert len(ctx.hooks["pre_api_request"]) == 1
    handle = mod2._state()["handle"]
    ctx.unloads[0]()
    assert handle.active is False and mod2._state()["handle"] is None
    ctx.fire(model="x-ai/grok-4")
    assert ctx.emitted == []  # an unloaded observer sends nothing
    assert mod2.start(ctx) and len(ctx.hooks["pre_api_request"]) == 2  # Hermes removed the first on unload
    mod2._state()["handle"].dispose()  # Hermes disposed it without our unload callback: subscribe again
    assert mod2.start(ctx) and len(ctx.hooks["pre_api_request"]) == 3


def test_register_runs_the_observer_after_the_inventory(obs, monkeypatch):
    mod, _home, _ctx = obs
    mod._reset()
    plugin = sys.modules[mod.__name__.rsplit(".", 1)[0]]
    order = []
    monkeypatch.setattr(plugin, "start_inventory", lambda c: order.append("inventory"))
    real = plugin.start_model_observer
    monkeypatch.setattr(plugin, "start_model_observer", lambda c: order.append("models") or real(c))
    ctx = Ctx()
    plugin.register(ctx)
    assert order == ["inventory", "models"] and len(ctx.hooks["pre_api_request"]) == 1


# ---------------------------------------------------------------------------
# Fix round 1 S1: the tick runs for the observer when the inventory is off
# ---------------------------------------------------------------------------

class Manager:
    def __init__(self):
        self.listeners = []

    def on_plugin_loaded(self, cb):
        self.listeners.append(cb)
        return lambda: self.listeners.remove(cb) if cb in self.listeners else None

    def fire(self):
        for cb in list(self.listeners):
            cb([])


def _sec3_box(tmp_path, clean_env, **block):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("_HERMES_GATEWAY", "1")
    plugin = load_plugin()
    plugins = __import__(f"{plugin.__name__}._plugins", fromlist=["_plugins"])
    models = __import__(f"{plugin.__name__}._models", fromlist=["_models"])
    _cfg(tmp_path, **block)
    return plugins, models


def check_decoupled(plugins, models, tmp_path):
    """unknown_plugins off, observer on: the boot row, a model.default change and the daily row still go out."""
    ctx, manager = Ctx(), Manager()
    models.start(ctx)
    assert plugins.start(ctx, manager_factory=lambda: manager) is True and len(manager.listeners) == 1
    manager.fire()  # the boot sweep
    t0 = int(__import__("time").time())
    plugins.run_pass("tick", now=t0 + 900)  # quiet
    _cfg(tmp_path, default="x-ai/grok-4", unknown_plugins="off", model_allow=LIST)
    plugins.run_pass("tick", now=t0 + 1800)
    plugins.run_pass("tick", now=t0 + 1800 + models.DAILY_S)
    got = [(p["model"], p["source"], p["trigger"]) for e, p in ctx.emitted if e == "model.observed"]
    assert got == [("openai/gpt-4o-mini", "config_default", "first_sight"), ("x-ai/grok-4", "config_default", "first_sight"),
                   ("x-ai/grok-4", "config_default", "daily")]
    assert not [e for e, _ in ctx.emitted if e.startswith("plugin.")]  # no inventory


def test_unknown_plugins_off_no_longer_silences_the_observer(tmp_path, clean_env):
    plugins, models = _sec3_box(tmp_path, clean_env, unknown_plugins="off", model_allow=LIST)
    check_decoupled(plugins, models, tmp_path)


def test_both_off_start_no_listener_and_no_thread(tmp_path, clean_env):
    plugins, models = _sec3_box(tmp_path, clean_env, unknown_plugins=False, model_observer=False)
    manager = Manager()
    assert models.start(Ctx()) is False and plugins.start(Ctx(), manager_factory=lambda: manager) is False
    assert manager.listeners == [] and "thread" not in plugins._state()


def test_mutation_tick_gated_on_unknown_plugins_only_is_caught(tmp_path, clean_env, monkeypatch):
    plugins, models = _sec3_box(tmp_path, clean_env, unknown_plugins="off", model_allow=LIST)
    monkeypatch.setattr(plugins, "_tick_wanted", lambda mode, cfg: mode != "off")
    with pytest.raises(AssertionError):
        check_decoupled(plugins, models, tmp_path)


# ---------------------------------------------------------------------------
# Parity with the contract file (the `model_events` section, ov#333)
# ---------------------------------------------------------------------------

def test_parity_bus_types_fields_switch_and_reasons():
    mod = _mod()
    assert CONTRACT["bus"] == {"observed": "av-approval:" + mod.OBSERVED, "offlist": "av-approval:" + mod.OFFLIST}
    assert {t: (v["bus"], v["actor"], v["version"]) for t, v in CONTRACT["types"].items()} == {
        mod.OBSERVED: ("av-approval:model.observed", "system", 1), mod.OFFLIST: ("av-approval:model.offlist", "system", 1)}
    plugins = __import__(mod.__name__.rsplit(".", 1)[0] + "._plugins", fromlist=["_plugins"])
    for event in (mod.OBSERVED, mod.OFFLIST):
        rules = CONTRACT["fields"][event]
        assert tuple(rules) == mod.MODEL_FIELDS
        assert (rules["model"]["regex"], rules["model"]["max_length"], rules["model"]["mismatch"]) == \
            (mod.MODEL_ID, mod.MODEL_MAX, "null")
        assert tuple(rules["source"]["enum"]) == mod.SOURCES and tuple(rules["trigger"]["enum"]) == mod.TRIGGERS
        assert rules["allowlist_version"]["regex"] == mod.VERSION_RE
        assert rules["hermes_version"]["regex"] == plugins.HERMES_VERSION_RE
        assert rules["ts"]["kind"] == "int" and rules["off_list_local"]["kind"] == "bool"
    assert CONTRACT["switch"] == {"env": "AV_MODEL_EVENTS", "on": ["1", "true", "yes", "on"], "default": "off",
                                  "read": "per emit"}
    assert CONTRACT["drop_reasons"] == ["missing_field", "extra_field", "bad_type", "bad_enum", "bad_shape",
                                        "bad_range", "switch_off"]


@pytest.mark.parametrize("vector", CONTRACT["accept"] + NULL_VECTORS,
                         ids=[f"{v['outcome']}: {v['note']}" for v in CONTRACT["accept"] + NULL_VECTORS])
def test_parity_every_accept_and_null_vector_through_our_serializer(vector):
    mod = _mod()
    out = mod.serialize(vector["record"])
    assert out == vector["emits"] and list(out) == list(vector["emits"])
    assert contract_drop(vector["type"], out) is None


# ---------------------------------------------------------------------------
# Mutation checks: each switched-off check must fail a check above
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("mutation", ["dedupe off", "nulling off", "list parsing off"])
def test_mutation_is_caught(tmp_path, clean_env, monkeypatch, mutation):
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setenv("_HERMES_GATEWAY", "1")
    mod = _mod()
    _cfg(tmp_path, model_allow=LIST)
    if mutation == "dedupe off":
        monkeypatch.setattr(mod, "_first_sight", lambda *a: True)
    elif mutation == "nulling off":
        monkeypatch.setattr(mod, "shape_model", lambda v: v)
    else:
        monkeypatch.setattr(mod, "parse_allow", lambda cfg: (frozenset(((cfg or {}).get("av_approval") or {})
                                                                       .get("model_allow") or []), LIST_VERSION, 0))
    failed = []
    for name, check in (("dedupe", lambda: check_dedupe(mod, (mod.start(ctx := Ctx()), ctx)[1])),
                        ("nulling", lambda: check_nulling(mod)), ("list", lambda: check_list(mod))):
        mod._reset()
        try:
            check()
        except (AssertionError, TypeError):
            failed.append(name)
    assert mutation.split(" ")[0] in failed, f"{mutation}: its check did not fail ({failed})"


# ---------------------------------------------------------------------------
# Hermes-backed: a real PluginManager, the ref's pre_api_request dispatch, /model --global
# ---------------------------------------------------------------------------

_HAVE_HERMES = bool(importlib.util.find_spec("hermes_cli")) and bool(importlib.util.find_spec("ruamel"))

_RUN = r'''
import json, logging, os, shutil, sys
home, plugin_dir = sys.argv[1:3]
os.environ["HERMES_HOME"] = home
import yaml
shutil.copytree(plugin_dir, os.path.join(home, "plugins", "av-approval"), ignore=shutil.ignore_patterns("tests", "__pycache__"))
with open(os.path.join(home, "config.yaml"), "w") as fh:
    yaml.safe_dump({"model": {"default": "openai/gpt-4o-mini", "provider": "openrouter"},
                    "plugins": {"enabled": ["av-approval"]},
                    "av_approval": {"model_allow": ["openai/gpt-6-luna", "openai/gpt-4o-mini"]}}, fh)
lines = []
class Keep(logging.Handler):
    def emit(self, record):
        lines.append(record.getMessage())
logging.getLogger("av-approval.models").addHandler(Keep())
logging.getLogger("av-approval.models").setLevel(logging.INFO)
from hermes_cli.plugins import get_plugin_manager
manager = get_plugin_manager()
seen = []
real = manager._dispatch_event
def spy(event, payload):
    if event.startswith("av-approval:model."):
        seen.append([event, dict(payload)])
    return real(event, payload)
manager._dispatch_event = spy
manager.discover_and_load()  # boot: the SEC-3 pass hands its parse to the observer
from agent.api_request_hooks import ApiRequestHooksMixin
from agent.turn_api_request import _fire_pre_api_request_hook
from hermes_cli.middleware import apply_llm_request_middleware
class StubAgent(ApiRequestHooksMixin):
    session_id, platform, model, provider = "s-SENTINEL", "telegram", "openai/gpt-4o-mini", "openrouter"
    base_url, api_mode, tools, max_tokens = "https://SENTINEL.example/v1", "chat_completions", [], 64
agent = StubAgent()
def fire(kwargs):
    _fire_pre_api_request_hook(agent, kwargs, kwargs["messages"], [], messages=kwargs["messages"],
        original_user_message="SENTINEL prompt", approx_tokens=1, total_chars=1, retry_count=0, api_call_count=1,
        api_request_id="r-SENTINEL", api_start_time=0.0, effective_task_id="t-SENTINEL", turn_id="u-SENTINEL")
kwargs = {"model": "openai/gpt-4o-mini", "messages": [{"role": "user", "content": "SENTINEL prompt"}]}
fire(dict(kwargs)); fire(dict(kwargs))
def rewrite(request=None, **_kw):
    return {"request": dict(request, model="x-ai/grok-4"), "reason": "test"}
manager._middleware.setdefault("llm_request", []).append(rewrite)
fire(apply_llm_request_middleware(dict(kwargs), model=agent.model).payload)
from hermes_cli.model_switch import ModelSwitchResult, persist_model_selection
persist_model_selection(ModelSwitchResult(success=True, new_model="deepseek/deepseek-chat-v3.1:free",
                                          target_provider="openrouter", is_global=True))
state = logging.getLogger("av-approval")._av_approval_plugins
state["run"]("tick")
print("\n" + json.dumps({"events": seen, "lines": lines, "hooks": len(manager._hooks.get("pre_api_request", []))}))
'''


@pytest.mark.skipif(not _HAVE_HERMES, reason="needs hermes_cli and ruamel.yaml on PYTHONPATH")
def test_hermes_request_dispatch_middleware_and_model_global(tmp_path):
    home = tmp_path / ".hermes"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AV_", "HERMES_"))}
    env.update(PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home), _HERMES_GATEWAY="1")
    out = subprocess.run([sys.executable, "-c", _RUN, str(home), str(PLUGIN_DIR)], capture_output=True, text=True,
                         env=env, timeout=600, cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr[-3000:]
    result = json.loads(out.stdout.strip().splitlines()[-1])
    assert result["hooks"] == 1
    got = [(e.split(":", 1)[1], p["model"], p["source"], p["trigger"], p["off_list_local"]) for e, p in result["events"]]
    assert got == [
        ("model.observed", "openai/gpt-4o-mini", "config_default", "first_sight", False),
        ("model.observed", "openai/gpt-4o-mini", "request", "first_sight", False),  # twice fired, once sent
        ("model.observed", "x-ai/grok-4", "request", "first_sight", True),  # the wire id, after middleware
        ("model.offlist", "x-ai/grok-4", "request", "first_sight", True),
        ("model.observed", "deepseek/deepseek-chat-v3.1:free", "config_default", "first_sight", True),
        ("model.offlist", "deepseek/deepseek-chat-v3.1:free", "config_default", "first_sight", True),
    ]
    for event, payload in result["events"]:
        assert contract_drop(event.split(":", 1)[1], payload) is None, payload
        assert payload["allowlist_version"] == LIST_VERSION and payload["hermes_version"] is not None
    assert "SENTINEL" not in json.dumps(result["events"])
    assert result["lines"] == [
        "av-approval: model: openai/gpt-4o-mini (config_default, on-list)",
        "av-approval: model: openai/gpt-4o-mini (request, on-list)",
        "av-approval: model: x-ai/grok-4 (request, off-list)",
        "av-approval: model: deepseek/deepseek-chat-v3.1:free (config_default, off-list)",
    ]
