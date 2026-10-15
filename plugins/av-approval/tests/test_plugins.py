"""SEC-3 PR 1: the plugin inventory and the unknown-plugin quarantine (`_plugins.py`).

Hermes-free: the classification table, mode parsing, the allow-list binding, the closed payload, the
listener's subscribe-once / unsubscribe-on-unload, quarantine actions, the hash key, PARITY with the
contract file av-events reads (`plugins/av-events/tests/vectors/plugin_events_contract.json`), and the
three mutation checks. Hermes-backed (a subprocess against a real Hermes; skipped unless `hermes_cli`
and `ruamel.yaml` import, e.g. `PYTHONPATH=<hermes ref>:<ruamel>`): runs 1-3 of design §4.2 with a
`git init` fixture plugin `fixture-echo` registering the tool `fixture_echo`.
"""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

from .conftest import PLUGIN_DIR, load_plugin

CONTRACT_PATH = PLUGIN_DIR.parent / "av-events" / "tests" / "vectors" / "plugin_events_contract.json"
CONTRACT = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
REF = json.loads((PLUGIN_DIR / "expected_plugins.json").read_text(encoding="utf-8"))["index"]["ref"]
OTHER = "1" * 40


@pytest.fixture
def gateway(monkeypatch):
    """Opt-in: this process is the gateway (Hermes's marker). Tests of the gate itself do not use it."""
    monkeypatch.setenv("_HERMES_GATEWAY", "1")


def _not_the_gateway(monkeypatch):
    monkeypatch.delenv("_HERMES_GATEWAY", raising=False)
    monkeypatch.setattr(sys, "argv", ["hermes", "chat"])


def _mod():
    plugin = load_plugin()
    return __import__(f"{plugin.__name__}._plugins", fromlist=["_plugins"])


def _contract_drop(event: str, payload: dict):
    """The contract's verdict on a payload, rule by rule from the file: None (accepted) or the drop reason."""
    rules = CONTRACT["fields"][event]
    if list(payload) != list(rules):
        return "fields"
    for key, rule in rules.items():
        value, kind = payload[key], rule["kind"]
        if value is None:
            if not rule["nullable"]:
                return f"{key}:null"
        elif kind == "int":
            if type(value) is not int or value < rule["range"][0] or (value > rule["range"][1] and rule["above"] != "clamp"):
                return f"{key}:int"
        elif kind == "bool":
            if type(value) is not bool:
                return f"{key}:bool"
        elif type(value) is not str:
            return f"{key}:type"
        elif kind == "enum" and value not in rule["enum"]:
            return f"{key}:enum"
        elif kind == "regex" and not re.fullmatch(rule["regex"], value):
            return f"{key}:shape"
    return None


# ---------------------------------------------------------------------------
# A Hermes-free world: records as `gather` builds them
# ---------------------------------------------------------------------------

def _world(tmp_path):
    bundled = tmp_path / "hermes" / "plugins"
    (bundled / "web" / "ddgs").mkdir(parents=True, exist_ok=True)
    (bundled / "disk-cleanup").mkdir(parents=True, exist_ok=True)
    user = tmp_path / "home" / "plugins"
    return bundled, user, frozenset({"web/ddgs", "disk-cleanup", "spotify"})


def _rec(key, path, *, source="user", loaded=True, name=None, dashboard_only=False, tools=0, hooks=0):
    return {"key": key, "name": name or key, "source": source, "path": str(path), "loaded": loaded,
            "tools": tools, "hooks": hooks, "dashboard_only": dashboard_only}


#: (id, record builder (bundled, user) -> record, metadata, allow, enabled, disabled, expected outcome)
#: An outcome is `expected`, `bundled`, `allowed`, or (`unknown`, source, state).
CASES = [
    ("overlay", lambda b, u: _rec("av-events", u / "av-events"), {}, (), (), (), "expected"),
    ("dashboard-only overlay dir", lambda b, u: _rec("edgecity-village", u / "edgecity-village", loaded=False,
                                                     dashboard_only=True), {}, (), (), (), "expected"),
    ("impostor: overlay key from another dir", lambda b, u: _rec("av-events", u / "zzz"), {}, (), (), (),
     ("unknown", "user", "loaded")),
    ("overlay name installed from git", lambda b, u: _rec("av-display", u / "av-display"),
     {"av-display": {"source": "https://evil.example/x.git", "revision": OTHER, "pinned": False}}, (), (), (),
     ("unknown", "user", "loaded")),
    ("index pinned at the ref", lambda b, u: _rec("index-network", u / "index-network"),
     {"index-network": {"source": "https://github.com/indexnetwork/hermes-plugin.git", "revision": REF,
                        "pinned": True}}, (), (), (), "expected"),
    ("index at another revision", lambda b, u: _rec("index-network", u / "index-network"),
     {"index-network": {"source": "https://github.com/indexnetwork/hermes-plugin.git", "revision": OTHER,
                        "pinned": True}}, (), (), (), ("unknown", "user", "loaded")),
    ("index at the ref, unpinned", lambda b, u: _rec("index-network", u / "index-network"),
     {"index-network": {"source": "x", "revision": REF, "pinned": False}}, (), (), (), ("unknown", "user", "loaded")),
    ("bundled under hermes", lambda b, u: _rec("web/ddgs", b / "web" / "ddgs", source="bundled", name="web-ddgs"),
     {}, (), (), (), "bundled"),
    ("bundled via an env-pointed dir", lambda b, u: _rec("web/ddgs", u.parent / "elsewhere" / "web" / "ddgs",
                                                         source="bundled", name="web-ddgs"),
     {}, (), (), (), ("unknown", "bundled_path_mismatch", "loaded")),
    ("user override of a bundled key", lambda b, u: _rec("disk-cleanup", u / "disk-cleanup", loaded=False), {}, (),
     (), (), ("unknown", "user", "overrides_bundled")),
    ("project plugin", lambda b, u: _rec("proj", u / "proj", source="project"), {}, (), (), (),
     ("unknown", "project", "loaded")),
    ("entrypoint plugin", lambda b, u: _rec("ep", u / "ep", source="entrypoint"), {}, (), (), (),
     ("unknown", "entrypoint", "loaded")),
    ("enabled, not loaded", lambda b, u: _rec("fixture-echo", u / "fixture-echo", loaded=False), {}, (),
     ("fixture-echo",), (), ("unknown", "user", "enabled_not_loaded")),
    ("dir only", lambda b, u: _rec("fixture-echo", u / "fixture-echo", loaded=False), {}, (), (), (),
     ("unknown", "user", "dir_only")),
    ("enabled and disabled", lambda b, u: _rec("fixture-echo", u / "fixture-echo", loaded=False), {}, (),
     ("fixture-echo",), ("fixture-echo",), ("unknown", "user", "dir_only")),
    ("allowed at its revision", lambda b, u: _rec("fixture-echo", u / "fixture-echo"),
     {"fixture-echo": {"source": "file:///r", "revision": OTHER, "pinned": False}},
     (("fixture-echo", OTHER),), (), (), "allowed"),
    ("allowed at another revision", lambda b, u: _rec("fixture-echo", u / "fixture-echo"),
     {"fixture-echo": {"source": "file:///r", "revision": "2" * 40, "pinned": False}},
     (("fixture-echo", OTHER),), (), (), ("unknown", "user", "loaded")),
    ("allowed by revision, no metadata", lambda b, u: _rec("fixture-echo", u / "fixture-echo"), {},
     (("fixture-echo", OTHER),), (), (), ("unknown", "user", "loaded")),
    ("local allowed, no metadata", lambda b, u: _rec("dropped", u / "dropped"), {}, (("dropped", "local"),), (), (),
     "allowed"),
    ("local does not cover a git install", lambda b, u: _rec("dropped", u / "dropped"),
     {"dropped": {"source": "file:///r", "revision": OTHER}}, (("dropped", "local"),), (), (),
     ("unknown", "user", "loaded")),
]


def _check_case(mod, tmp_path, case):
    _id, build, metadata, allow, enabled, disabled, outcome = case
    bundled, user, keys = _world(tmp_path)
    inv = mod.classify([build(bundled, user)], expected=mod.load_expected(), metadata=metadata, allow=allow,
                       bundled_root=bundled, bundled_keys=keys, enabled=frozenset(enabled),
                       disabled=frozenset(disabled))
    if outcome == "expected":
        assert inv["unknown_count"] == 0 and inv["allowed_count"] == 0 and inv["expected_loaded"] == 1, _id
    elif outcome == "bundled":
        assert inv["unknown_count"] == 0 and inv["bundled_loaded"] == 1, _id
    elif outcome == "allowed":
        assert inv["unknown_count"] == 0 and inv["allowed_count"] == 1, _id
    else:
        assert inv["unknown_count"] == 1, _id
        entry = inv["unknown"][0]
        assert ("unknown", entry["source"], entry["state"]) == outcome, _id


@pytest.mark.parametrize("case", CASES, ids=[c[0] for c in CASES])
def test_classification_table(tmp_path, case):
    _check_case(_mod(), tmp_path, case)


def test_a_healthy_box_counts_everything_expected_and_nothing_missing(tmp_path):
    mod = _mod()
    bundled, user, keys = _world(tmp_path)
    expected = mod.load_expected()
    # Conditional plugins (recall, and village-bridge from rc41) are present but not loaded here.
    records = [_rec(n, user / n, dashboard_only=(n == "edgecity-village"),
                    loaded=(n != "edgecity-village" and n not in expected["conditional"]))
               for n in expected["overlay"]]
    records.append(_rec("web/ddgs", bundled / "web" / "ddgs", source="bundled"))
    inv = mod.classify(records, expected=expected, metadata={}, bundled_root=bundled, bundled_keys=keys)
    required = set(expected["overlay"]) - set(expected["conditional"])
    assert (inv["expected_loaded"], inv["expected_missing"], inv["bundled_loaded"], inv["unknown_count"]) == (
        len(required), 0, 1, 0)
    inv = mod.classify([r for r in records if r["key"] != "av-display"], expected=expected, metadata={},
                       bundled_root=bundled, bundled_keys=keys)
    assert inv["expected_missing"] == 1


def test_a_dir_without_init_is_missing_except_the_dashboard_only_plugin(tmp_path):
    mod = _mod()
    bundled, user, keys = _world(tmp_path)
    expected = mod.load_expected()
    records = [_rec(n, user / n, loaded=n not in ("edgecity-village", "av-events"),
                    dashboard_only=n in ("edgecity-village", "av-events")) for n in expected["overlay"]]
    inv = mod.classify(records, expected=expected, metadata={}, bundled_root=bundled, bundled_keys=keys)
    assert (inv["expected_missing"], inv["unknown_count"]) == (1, 0)  # av-events staged without __init__.py
    # DASHBOARD_ONLY is exactly the overlay plugins the source tree ships without an agent half.
    tree = sorted(n for n in expected["overlay"] if not (PLUGIN_DIR.parent / n / "__init__.py").exists())
    assert tree == sorted(mod.DASHBOARD_ONLY)


def test_expected_set_file_is_derived_sorted_and_versioned():
    mod = _mod()
    data = mod.load_expected()
    assert list(data) == ["expected_set_version", "overlay", "index", "conditional"]
    assert data["overlay"] == sorted(data["overlay"]) and data["conditional"] == sorted(data["conditional"])
    assert data["expected_set_version"] == mod.set_version(data) and re.fullmatch(mod.SET_VERSION_RE,
                                                                                    data["expected_set_version"])
    assert {"recall", data["index"]["name"]} <= set(data["conditional"]) <= set(data["overlay"]) | {data["index"]["name"]}
    assert "av-approval" in data["overlay"]


def test_a_tampered_expected_set_does_not_run(tmp_path, clean_env, caplog, gateway):
    mod = _mod()
    bad = json.loads(mod.EXPECTED_PATH.read_text(encoding="utf-8"))
    bad["overlay"].append("fixture-echo")
    path = tmp_path / "expected.json"
    path.write_text(json.dumps(bad), encoding="utf-8")
    with pytest.raises(ValueError):
        mod.load_expected(path)
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    clean_env.setattr(mod, "EXPECTED_PATH", path)
    clean_env.setattr(mod, "load_expected", lambda p=path: (_ for _ in ()).throw(ValueError("tampered")))
    with caplog.at_level(logging.WARNING, logger="av-approval.plugins"):
        assert mod.start(FakeBusCtx(), manager_factory=FakeManager) is False
        assert mod.start(FakeBusCtx(), manager_factory=FakeManager) is False
    assert [r.getMessage() for r in caplog.records] == [mod.NOT_RUNNING_LINE]


# ---------------------------------------------------------------------------
# Mode and allow-list parsing
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("text,mode,understood", [
    (None, "report", True),
    ("model: {default: m}\n", "report", True),
    ("av_approval: {custody: false}\n", "report", True),
    ("av_approval: {unknown_plugins: report}\n", "report", True),
    ("av_approval: {unknown_plugins: quarantine}\n", "quarantine", True),
    ("av_approval: {unknown_plugins: ' Quarantine '}\n", "quarantine", True),
    ("av_approval: {unknown_plugins: 'off'}\n", "off", True),
    ("av_approval: {unknown_plugins: off}\n", "off", True),  # YAML 1.1 reads a bare off as false
    ("av_approval: {unknown_plugins: on}\n", "report", False),
    ("av_approval: {unknown_plugins: bogus}\n", "report", False),
    ("av_approval: {unknown_plugins: 3}\n", "report", False),
    ("av_approval: words\n", "report", False),
    ("av_approval: [unclosed\n", "report", False),
    ("- a list\n", "report", False),
])
def test_mode_parsing_fails_safe_to_report(tmp_path, text, mode, understood):
    mod = _mod()
    if text is not None:
        (tmp_path / "config.yaml").write_text(text, encoding="utf-8")
    cfg, readable = mod.read_config(tmp_path)
    assert mod.parse_mode(cfg if readable else None) == (mode, understood)


def test_a_mode_it_does_not_understand_is_logged_once_and_runs_as_report(tmp_path, clean_env, caplog, gateway):
    mod = _mod()
    (tmp_path / "config.yaml").write_text("av_approval: {unknown_plugins: bogus-SENTINEL}\n", encoding="utf-8")
    clean_env.setenv("HERMES_HOME", str(tmp_path))
    manager = FakeManager()
    with caplog.at_level(logging.WARNING, logger="av-approval.plugins"):
        assert mod.start(FakeBusCtx(), manager_factory=lambda: manager)
        assert mod.start(FakeBusCtx(), manager_factory=lambda: manager)
    assert [r.getMessage() for r in caplog.records] == [mod.MODE_LINE]
    assert "SENTINEL" not in caplog.text and len(manager.listeners) == 1


def test_allow_list_parsing_keeps_only_bound_entries():
    mod = _mod()
    cfg = {"av_approval": {"plugins_allow": [
        {"name": "a", "revision": OTHER.upper()}, {"name": "b", "revision": "local"}, {"name": "c"},
        {"name": "d", "revision": "abc"}, {"revision": OTHER}, "e", {"name": "f", "revision": " " + OTHER + " "}]}}
    assert mod.parse_allow(cfg) == (("a", OTHER), ("b", "local"), ("f", OTHER))
    assert mod.parse_allow({}) == () and mod.parse_allow(None) == () and mod.parse_allow({"av_approval": 1}) == ()


# ---------------------------------------------------------------------------
# Fakes for the listener, the pass and the bus
# ---------------------------------------------------------------------------

class FakeBusCtx:
    def __init__(self):
        self.emitted: list = []
        self.unloads: list = []

    def emit(self, event, payload=None):
        self.emitted.append((event, payload))
        return 1

    def on_unload(self, callback):
        self.unloads.append(callback)


class _Manifest:
    def __init__(self, key, source, path):
        self.name, self.key, self.source, self.path = key, key, source, str(path)


class _Loaded:
    def __init__(self, key, source, path, enabled=True, tools=0):
        self.manifest = _Manifest(key, source, path)
        self.enabled, self.error, self.deferred, self.tools = enabled, None, False, tools


class FakeManager:
    def __init__(self, plugins=()):
        self.listeners: list = []
        self._plugins = {p.manifest.key: p for p in plugins}
        self.unloaded: list = []

    def on_plugin_loaded(self, callback):
        self.listeners.append(callback)
        return lambda: self.listeners.remove(callback) if callback in self.listeners else None

    def list_plugins(self):
        return [{"key": k, "tools": p.tools, "hooks": 1} for k, p in self._plugins.items()]

    def unload(self, key):
        self.unloaded.append(key)
        return self._plugins.pop(key, None) is not None

    def fire(self):
        for cb in list(self.listeners):
            cb([{"name": "x", "key": "x", "activated_now": [], "deferred": []}])


@pytest.fixture
def box(tmp_path, clean_env, monkeypatch, gateway):
    """A HERMES_HOME with the overlay staged, a fake manager holding it plus a loaded unknown plugin."""
    mod = _mod()
    home = tmp_path / ".hermes"
    bundled, _user, keys = _world(tmp_path)
    plugins = []
    for name in mod.load_expected()["overlay"]:
        (home / "plugins" / name).mkdir(parents=True)
        if name != "edgecity-village":
            (home / "plugins" / name / "__init__.py").write_text("", encoding="utf-8")
            plugins.append(_Loaded(name, "user", home / "plugins" / name))
    (home / "plugins" / "fixture-echo").mkdir()
    plugins.append(_Loaded("fixture-echo", "user", home / "plugins" / "fixture-echo", tools=1))
    (home / "plugins" / ".install-metadata.json").write_text(json.dumps({"fixture-echo": {
        "source": "https://user:tok-SENTINEL@git.example.com/SENTINEL-path/fixture.git", "revision": OTHER,
        "pinned": False}}), encoding="utf-8")
    clean_env.setenv("HERMES_HOME", str(home))
    manager = FakeManager(plugins)
    unlisted: list = []
    monkeypatch.setattr(mod, "bundled_facts", lambda: (bundled, keys))
    monkeypatch.setattr(mod, "unlist", lambda key: unlisted.append(key) or True)

    def scan(home_dir):  # Hermes's scanner, flat: the key is the manifest's name, else the directory's
        found = []
        for p in sorted((home_dir / "plugins").iterdir()):
            if p.is_dir():
                manifest = yaml.safe_load((p / "plugin.yaml").read_text()) if (p / "plugin.yaml").exists() else {}
                found.append(_Manifest(manifest.get("name", p.name), "user", p))
        return found

    monkeypatch.setattr(mod, "scan_user", scan)
    yield mod, home, manager, unlisted


def _set_mode(home: Path, mode: str, **extra):
    cfg = {"plugins": {"enabled": ["av-approval"]}, "av_approval": {"unknown_plugins": mode, **extra}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")


def _events(ctx, bare):
    return [p for e, p in ctx.emitted if e == bare]


# ---------------------------------------------------------------------------
# The listener: subscribe once, unsubscribe on unload, never act inside register
# ---------------------------------------------------------------------------

def test_subscribed_once_across_register_and_reload_and_unsubscribed_on_unload(box):
    mod, home, manager, _ = box
    ctx = FakeBusCtx()
    assert mod.start(ctx, manager_factory=lambda: manager)
    thread = mod._state()["thread"]
    assert mod.start(FakeBusCtx(), manager_factory=lambda: manager)
    sys.modules.pop(mod.__name__)
    mod2 = _mod()  # Hermes re-imports the plugin on a forced re-discovery
    assert mod2 is not mod and mod2.start(FakeBusCtx(), manager_factory=lambda: manager)
    assert len(manager.listeners) == 1 and mod2._state()["thread"] is thread and thread.is_alive()
    ctx.unloads[0]()  # Hermes's unload runs the on_unload callback
    assert manager.listeners == [] and mod2._state()["active"] is False
    assert mod2.start(FakeBusCtx(), manager_factory=lambda: manager) and len(manager.listeners) == 1


def test_register_subscribes_and_never_unloads_the_listener_does(box, monkeypatch):
    mod, home, manager, unlisted = box
    _set_mode(home, "quarantine")
    plugin = sys.modules[mod.__name__.rsplit(".", 1)[0]]
    monkeypatch.setattr(mod, "_default_manager", lambda: manager)
    ctx = FakeBusCtx()
    plugin.register(ctx)
    assert len(manager.listeners) == 1 and manager.unloaded == [] and unlisted == [] and ctx.emitted == []
    manager.fire()
    assert manager.unloaded == ["fixture-echo"] and unlisted == ["fixture-echo"]
    (inventory,) = _events(ctx, "plugin.inventory")
    assert inventory["trigger"] == "boot" and inventory["mode"] == "quarantine"


def test_off_subscribes_nothing_and_sends_nothing(box):
    mod, home, manager, _ = box
    _set_mode(home, "off", model_observer="off")  # SEC-6 fix round 1 S1: the observer on keeps the tick
    ctx = FakeBusCtx()
    assert mod.start(ctx, manager_factory=lambda: manager) is False
    assert manager.listeners == [] and "thread" not in mod._state() and ctx.unloads == []


def test_observer_off_leaves_the_inventory_as_it_was(box):
    mod, home, manager, _ = box
    _set_mode(home, "report", model_observer="off")
    models = __import__(mod.__name__.rsplit(".", 1)[0] + "._models", fromlist=["_models"])
    ctx = FakeBusCtx()
    assert models.start(ctx) is False and mod.start(ctx, manager_factory=lambda: manager)
    manager.fire()
    assert [e for e, _ in ctx.emitted] == ["plugin.inventory", "plugin.unknown"]


def test_outside_the_gateway_process_nothing_runs_and_nothing_is_logged(box, caplog, monkeypatch):
    mod, home, manager, _ = box
    _not_the_gateway(monkeypatch)
    with caplog.at_level(logging.DEBUG, logger="av-approval.plugins"):
        assert mod.start(FakeBusCtx(), manager_factory=lambda: manager) is False
    assert manager.listeners == [] and "thread" not in mod._state() and caplog.records == []


def test_the_gateway_argv_alone_runs_the_inventory(box, monkeypatch):
    # `hermes gateway run` discovers plugins BEFORE gateway/run.py sets the marker (recheck M1).
    mod, home, manager, _ = box
    _not_the_gateway(monkeypatch)
    monkeypatch.setattr(sys, "argv", ["/usr/bin/python3", "-m", "hermes_cli.main", "gateway", "run"])
    assert mod.start(FakeBusCtx(), manager_factory=lambda: manager) is True and len(manager.listeners) == 1


@pytest.mark.parametrize("argv,gateway", [
    (["hermes", "gateway", "run"], True),
    (["hermes", "gateway", "start"], True),
    (["hermes", "gateway"], True),
    (["hermes", "-p", "alt", "gateway", "run"], True),
    (["python", "-m", "hermes_cli.main", "gateway", "run"], True),
    (["/x/hermes_cli/main.py", "gateway", "run", "--replace"], True),
    (["hermes", "gateway", "stop"], False),
    (["hermes", "gateway", "status"], False),
    (["hermes", "chat"], False),
    (["hermes", "dashboard"], False),
    (["hermes"], False),
    (["hermes", "plugins", "install", "gateway"], True),  # av-events' rule, mirrored: a trailing bare `gateway`
    ([], False),
])
def test_gateway_argv_predicate(argv, gateway):
    assert _mod().gateway_argv(argv) is gateway


def test_a_tick_during_a_discovery_sweep_is_skipped_and_publishes_nothing(box):
    import threading

    mod, home, manager, _ = box
    manager._discovery_lock = threading.RLock()
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    held, release = threading.Event(), threading.Event()

    def sweep():  # another thread inside discover_and_load(force=True)
        with manager._discovery_lock:
            held.set()
            release.wait(5)

    t = threading.Thread(target=sweep)
    t.start()
    held.wait(5)
    try:
        assert mod.run_pass("tick") is None and ctx.emitted == []
    finally:
        release.set()
        t.join(5)
    assert mod.run_pass("tick")["trigger"] == "boot" and len(_events(ctx, "plugin.inventory")) == 1
    assert manager._discovery_lock.acquire(blocking=False)  # the tick released it
    manager._discovery_lock.release()


def test_a_manager_that_cannot_subscribe_says_not_running_once(box, caplog):
    mod, home, manager, _ = box

    def broken():
        raise RuntimeError("no on_plugin_loaded")

    with caplog.at_level(logging.WARNING, logger="av-approval.plugins"):
        assert mod.start(FakeBusCtx(), manager_factory=broken) is False
        assert mod.start(FakeBusCtx(), manager_factory=broken) is False
    assert [r.getMessage() for r in caplog.records] == [mod.NOT_RUNNING_LINE]


def test_register_never_raises_and_a_ctx_without_on_unload_still_subscribes(box, monkeypatch):
    mod, home, manager, _ = box
    plugin = sys.modules[mod.__name__.rsplit(".", 1)[0]]
    monkeypatch.setattr(mod, "_default_manager", lambda: manager)

    class NoUnload:
        def emit(self, *a, **k):
            raise RuntimeError("bus down")

    plugin.register(NoUnload())
    assert len(manager.listeners) == 1
    manager.fire()  # an emit that raises changes nothing
    monkeypatch.setattr(mod, "start", lambda ctx: 1 / 0)
    assert plugin.start_inventory(NoUnload()) is False


# ---------------------------------------------------------------------------
# The pass: report is inert, quarantine acts, events once, triggers
# ---------------------------------------------------------------------------

def test_report_mode_sends_and_logs_but_changes_nothing(box, caplog):
    mod, home, manager, unlisted = box
    _set_mode(home, "report")
    before = (home / "config.yaml").read_bytes()
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    with caplog.at_level(logging.INFO, logger="av-approval.plugins"):
        manager.fire()
    assert manager.unloaded == [] and unlisted == [] and (home / "config.yaml").read_bytes() == before
    (inventory,) = _events(ctx, "plugin.inventory")
    # Nine from rc42: the overlay staged in full, village-bridge included (MINI-APPS re-cut), av-vote added.
    assert inventory == {"trigger": "boot", "mode": "report", "expected_loaded": 9, "expected_missing": 0,
                         "bundled_loaded": 0, "unknown_count": 1, "allowed_count": 0,
                         "expected_set_version": mod.load_expected()["expected_set_version"],
                         "hermes_version": inventory["hermes_version"]}
    (unknown,) = _events(ctx, "plugin.unknown")
    assert (unknown["name"], unknown["state"], unknown["action"], unknown["install_host"], unknown["tools"]) == (
        "fixture-echo", "loaded", "none", "git.example.com", 1)
    assert [r.getMessage() for r in caplog.records] == [
        "av-approval: plugins: 9 expected, 0 bundled, 1 unknown (mode report)"]


def test_quarantine_unloads_and_unlists_and_reports_each_outcome_once(box):
    mod, home, manager, unlisted = box
    _set_mode(home, "quarantine", plugins_allow=[{"name": "fixture-echo", "revision": "2" * 40}])
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    manager.fire()
    assert manager.unloaded == ["fixture-echo"] and unlisted == ["fixture-echo"]
    assert [(u["state"], u["action"]) for u in _events(ctx, "plugin.unknown")] == [("loaded", "unloaded_unlisted")]
    mod.run_pass("tick")  # now a dir only, unlisted again (Hermes answers unchanged)
    mod.run_pass("tick")
    assert [(u["state"], u["action"]) for u in _events(ctx, "plugin.unknown")] == [
        ("loaded", "unloaded_unlisted"), ("dir_only", "unlisted")]
    assert [p["trigger"] for p in _events(ctx, "plugin.inventory")] == ["boot", "tick"]


def test_unlist_failures_and_protected_keys_are_unlist_failed(box, monkeypatch):
    mod, home, manager, unlisted = box
    _set_mode(home, "quarantine")
    (home / "plugins" / "zzz").mkdir()  # an impostor claiming av-events, the winner in Hermes's sort
    (home / "plugins" / "zzz" / "plugin.yaml").write_text("name: av-events\n", encoding="utf-8")
    manager._plugins["av-events"] = _Loaded("av-events", "user", home / "plugins" / "zzz")
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    monkeypatch.setattr(mod, "unlist", lambda key: unlisted.append(key) or key != "fixture-echo")
    manager.fire()
    outcomes = {u["name"]: u["action"] for u in _events(ctx, "plugin.unknown")}
    assert outcomes == {"av-events": "unlist_failed", "fixture-echo": "unlist_failed"}
    assert sorted(manager.unloaded) == ["av-events", "fixture-echo"] and unlisted == ["fixture-echo"]


@pytest.mark.parametrize("unload_ok,unlist_ok,action,line", [
    (True, True, "unloaded_unlisted", None),
    (True, False, "unlist_failed", "UNLOADED_NOT_UNLISTED_LINE"),
    (False, True, "unlisted", "UNLOAD_FAILED_LINE"),
    (False, False, "unlist_failed", None),
])
def test_quarantine_labels_say_what_happened(box, monkeypatch, caplog, unload_ok, unlist_ok, action, line):
    mod, home, manager, unlisted = box
    _set_mode(home, "quarantine")
    real_unload = manager.unload
    monkeypatch.setattr(manager, "unload", lambda key: real_unload(key) and unload_ok)
    monkeypatch.setattr(mod, "unlist", lambda key: unlisted.append(key) or unlist_ok)
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    with caplog.at_level(logging.WARNING, logger="av-approval.plugins"):
        manager.fire()
    (unknown,) = _events(ctx, "plugin.unknown")
    assert (unknown["state"], unknown["action"]) == ("loaded", action)
    quarantine_lines = [r.getMessage() for r in caplog.records if "quarantine:" in r.getMessage()]
    assert quarantine_lines == ([getattr(mod, line)] if line else [])
    assert "fixture-echo" not in caplog.text


def test_an_impostor_sharing_an_allow_listed_key_does_not_unlist_it(box, monkeypatch, caplog):
    mod, home, manager, unlisted = box
    _set_mode(home, "quarantine", plugins_allow=[{"name": "fixture-echo", "revision": OTHER}])
    (home / "plugins" / "zzz").mkdir()  # same key, another dir, no metadata: not the allowed revision
    (home / "plugins" / "zzz" / "plugin.yaml").write_text("name: fixture-echo\n", encoding="utf-8")
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    with caplog.at_level(logging.WARNING, logger="av-approval.plugins"):
        manager.fire()
    assert unlisted == [] and manager.unloaded == []
    assert [(u["name"], u["state"], u["action"]) for u in _events(ctx, "plugin.unknown")] == [
        ("fixture-echo", "dir_only", "unlist_failed")]
    assert _events(ctx, "plugin.inventory")[0]["allowed_count"] == 1
    assert mod.PROTECTED_LINE in [r.getMessage() for r in caplog.records]


def test_tick_sends_only_on_change_and_daily_every_24h(box, caplog):
    mod, home, manager, _ = box
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    with caplog.at_level(logging.INFO, logger="av-approval.plugins"):
        assert mod.run_pass("tick", now=1000.0)["trigger"] == "boot"
        assert mod.run_pass("tick", now=1900.0)["trigger"] == "tick"
        del manager._plugins["fixture-echo"]  # the plugin is no longer loaded: a change
        mod.run_pass("tick", now=2800.0)
        assert mod.run_pass("tick", now=1000.0 + mod.DAILY_S)["trigger"] == "daily"
    assert [p["trigger"] for p in _events(ctx, "plugin.inventory")] == ["boot", "tick", "daily"]
    assert len([r for r in caplog.records if r.getMessage().startswith("av-approval: plugins: ")]) == 2


def test_hermes_seams_failing_change_nothing(box, monkeypatch):
    mod, home, manager, _ = box
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    monkeypatch.setattr(mod, "bundled_facts", lambda: 1 / 0)
    assert mod.run_pass("loaded") is None and ctx.emitted == []


# ---------------------------------------------------------------------------
# The closed payload
# ---------------------------------------------------------------------------

def test_no_path_url_or_text_reaches_any_field(box):
    mod, home, manager, _ = box
    for key in ("Fixture_SENTINEL", "plain-sentinel"):
        (home / "plugins" / key).mkdir()
        manager._plugins[key] = _Loaded(key, "user", home / "plugins" / key, tools=3)
    ctx = FakeBusCtx()
    mod.start(ctx, manager_factory=lambda: manager)
    manager.fire()
    unknown = _events(ctx, "plugin.unknown")
    assert {u["name"] for u in unknown} == {None, "plain-sentinel", "fixture-echo"}
    for event, payload in ctx.emitted:
        assert _contract_drop(event, payload) is None, (event, payload)
        for field, value in payload.items():
            if field != "name":
                assert "sentinel" not in str(value).lower() and "/" not in str(value), (field, value)
    hashes = {u["name_hash"] for u in unknown}
    assert len(hashes) == 3 and all(re.fullmatch(r"[0-9a-f]{64}", h) for h in hashes)


def test_serialize_is_closed_fresh_and_typed():
    mod = _mod()
    values = {"trigger": "tick", "mode": "report", "expected_loaded": 10001, "expected_missing": -1,
              "bundled_loaded": True, "unknown_count": 2.0, "allowed_count": 0, "expected_set_version": "0" * 12,
              "hermes_version": "0.21.5", "path": "/etc", "tools": ["x"]}
    a, b = mod.serialize(mod.INVENTORY, values), mod.serialize(mod.INVENTORY, values)
    assert a == b and a is not b and list(a) == list(mod.INVENTORY_FIELDS)
    assert (a["expected_loaded"], a["expected_missing"], a["bundled_loaded"], a["unknown_count"]) == (10000, 0, 0, 0)
    u = mod.serialize(mod.UNKNOWN, {"name": "x", "name_hash": "a" * 64, "source": "user", "state": "loaded",
                                    "install_host": "h", "revision": "local", "pinned": 1, "tools": 5000,
                                    "hooks": -2, "action": "none", "tool_names": ["t"]})
    assert list(u) == list(mod.UNKNOWN_FIELDS) and (u["revision"], u["pinned"], u["tools"], u["hooks"]) == (
        None, None, 5000, 0)


@pytest.mark.parametrize("source,host", [
    ("https://github.com/x/y.git", "github.com"), ("https://u:tok@GitHub.com:443/x", "github.com"),
    ("git@gitlab.example.org:x/y.git", "gitlab.example.org"), ("file:///tmp/repo", None), ("owner/repo", None),
    ("http://[::1]/x", None), (None, None), ("", None), ("https://bad_host!/x", None)])
def test_install_host_is_the_host_only(source, host):
    assert _mod().install_host(source) == host


def test_hash_key_is_our_own_stable_0600_and_ephemeral_when_unwritable(tmp_path, clean_env, caplog):
    mod = _mod()
    home = tmp_path / ".hermes"
    state = {"home": home}
    first = mod._name_hash(state, "fixture-echo")
    key_file = home / "av-approval" / "hash.key"
    assert (key_file.stat().st_mode & 0o777) == 0o600 and not (home / "av-events").exists()
    assert first == hmac.new(bytes.fromhex(key_file.read_text()), b"av-approval|plugin|fixture-echo",
                             hashlib.sha256).hexdigest()
    assert mod._name_hash({"home": home}, "fixture-echo") == first  # a restart reads the same key
    key_file.write_text("corrupt", encoding="ascii")
    assert mod._name_hash({"home": home}, "fixture-echo") != first and re.fullmatch(r"[0-9a-f]{64}", key_file.read_text())
    if os.geteuid() == 0:
        return  # root writes through a 0500 directory
    blocked = tmp_path / "ro"
    blocked.mkdir()
    blocked.chmod(0o500)
    try:
        with caplog.at_level(logging.WARNING, logger="av-approval.plugins"):
            one = mod._name_hash({"home": blocked}, "x")
            two = mod._name_hash({"home": blocked}, "y")
        assert re.fullmatch(r"[0-9a-f]{64}", one) and one != two
        assert [r.getMessage() for r in caplog.records] == [mod.EPHEMERAL_LINE]
    finally:
        blocked.chmod(0o700)


# ---------------------------------------------------------------------------
# PARITY with the contract file av-events reads
# ---------------------------------------------------------------------------

def test_parity_bus_names_fields_and_shapes():
    mod = _mod()
    manifest = yaml.safe_load((PLUGIN_DIR / "plugin.yaml").read_text(encoding="utf-8"))
    assert manifest["name"] == "av-approval"
    assert CONTRACT["bus"] == {"inventory": "av-approval:" + mod.INVENTORY, "unknown": "av-approval:" + mod.UNKNOWN}
    assert {t: v["bus"] for t, v in CONTRACT["types"].items()} == {
        mod.INVENTORY: "av-approval:" + mod.INVENTORY, mod.UNKNOWN: "av-approval:" + mod.UNKNOWN}
    assert tuple(CONTRACT["fields"][mod.INVENTORY]) == mod.INVENTORY_FIELDS
    assert tuple(CONTRACT["fields"][mod.UNKNOWN]) == mod.UNKNOWN_FIELDS
    inv, unk = CONTRACT["fields"][mod.INVENTORY], CONTRACT["fields"][mod.UNKNOWN]
    assert inv["hermes_version"]["regex"] == mod.HERMES_VERSION_RE  # character for character
    assert inv["expected_set_version"]["regex"] == mod.SET_VERSION_RE
    assert (unk["name"]["regex"], unk["install_host"]["regex"], unk["revision"]["regex"]) == (
        mod.NAME_RE, mod.HOST_RE, mod.REVISION_RE)
    assert tuple(unk["source"]["enum"]) == mod.UNKNOWN_SOURCES and tuple(inv["mode"]["enum"]) == mod.MODES
    assert [k for k, r in inv.items() if r["kind"] == "int"] == [
        k for k in mod.INVENTORY_FIELDS if mod._RULES[mod.INVENTORY][k] is mod._count]
    assert all(inv[k]["range"] == [0, mod.COUNT_MAX] for k in inv if inv[k]["kind"] == "int")


@pytest.mark.parametrize("vector", CONTRACT["accept"], ids=[f"{v['type']}: {v['note']}" for v in CONTRACT["accept"]])
def test_parity_every_accept_vector_through_our_serializer(vector):
    mod = _mod()
    rules = CONTRACT["fields"][vector["type"]]
    ours = mod.serialize(vector["type"], vector["record"])
    assert list(ours) == list(rules) == list(vector["emits"])
    for key, rule in rules.items():
        if rule.get("above") == "clamp":
            assert ours[key] == vector["record"][key]  # raw counts; av-events clamps
        else:
            assert ours[key] == vector["emits"][key], key


def test_parity_every_bad_shape_refusal_on_name_or_host_is_nulled_by_us():
    mod = _mod()
    refused = [v for v in CONTRACT["refuse"] if v["reason"] == "bad_shape" and v["type"] == mod.UNKNOWN
               and set(v["record"]) & {"name", "install_host"}
               and any(_contract_drop(mod.UNKNOWN, {**v["record"], k: None}) is None for k in ("name", "install_host"))]
    for vector in refused:  # round 2 made these accept-with-null; any that return are nulled on our side too
        assert _contract_drop(mod.UNKNOWN, mod.serialize(mod.UNKNOWN, vector["record"])) is None
    nulled = [v for v in CONTRACT["accept"] if v["type"] == mod.UNKNOWN
              and any(v["record"][k] is not None and v["emits"][k] is None for k in ("name", "install_host"))]
    assert len(nulled) >= 16 and all(mod.serialize(mod.UNKNOWN, v["record"]) == {
        **v["emits"], "tools": v["record"]["tools"], "hooks": v["record"]["hooks"]} for v in nulled)


# ---------------------------------------------------------------------------
# Mutation checks: each switched-off check must fail the table
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("mutation", ["classification off", "path check off", "revision check off"])
def test_mutation_is_caught(tmp_path, monkeypatch, mutation):
    mod = _mod()
    if mutation == "classification off":
        monkeypatch.setattr(mod, "_verdict", lambda *a, **k: ("expected", ""))
    elif mutation == "path check off":
        monkeypatch.setattr(mod, "_under", lambda *a, **k: True)
    else:
        monkeypatch.setattr(mod, "_revision_matches", lambda *a, **k: True)
    failed = []
    for case in CASES:
        try:
            _check_case(mod, tmp_path, case)
        except AssertionError:
            failed.append(case[0])
    assert failed, f"{mutation}: no case failed"


# ---------------------------------------------------------------------------
# Hermes-backed: runs 1-3 in a real Hermes (a subprocess per process lifetime)
# ---------------------------------------------------------------------------

_HAVE_HERMES = bool(importlib.util.find_spec("hermes_cli")) and bool(importlib.util.find_spec("ruamel"))

_RUN = r'''
import json, logging, os, shutil, sys
home, plugin_dir, repo, scenario, mode, allow_rev = sys.argv[1:7]
os.environ["HERMES_HOME"] = home
import yaml
plugins = os.path.join(home, "plugins")
first = not os.path.isdir(os.path.join(plugins, "av-approval"))
if first:
    shutil.copytree(plugin_dir, os.path.join(plugins, "av-approval"), ignore=shutil.ignore_patterns("tests", "__pycache__"))
    block = {"unknown_plugins": mode}
    if allow_rev:
        block["plugins_allow"] = [{"name": "fixture-echo", "revision": allow_rev}]
    with open(os.path.join(home, "config.yaml"), "w") as fh:
        yaml.safe_dump({"plugins": {"enabled": ["av-approval"]}, "av_approval": block}, fh)
    if scenario == "allow":  # a same-named user override of the bundled disk-cleanup
        os.makedirs(os.path.join(plugins, "disk-cleanup"))
        open(os.path.join(plugins, "disk-cleanup", "plugin.yaml"), "w").write("name: disk-cleanup\n")
        open(os.path.join(plugins, "disk-cleanup", "__init__.py"), "w").write("def register(ctx):\n    pass\n")
from hermes_cli import plugins_cmd
from hermes_cli.plugins import get_plugin_manager
from tools.registry import registry
manager = get_plugin_manager()
seen = []
real = manager._dispatch_event
def spy(event, payload):
    if event.startswith("av-approval:plugin."):  # SEC-6's model.* events are pinned in test_model_observer.py
        seen.append([event, dict(payload)])
    return real(event, payload)
manager._dispatch_event = spy
manager.discover_and_load()  # boot
def cfg():
    with open(os.path.join(home, "config.yaml")) as fh:
        return (yaml.safe_load(fh) or {}).get("plugins") or {}
if scenario in ("install", "allow"):
    plugins_cmd.cmd_install("file://" + repo, enable=True, no_deps=True)
    manager.discover_and_load(force=True)
elif scenario == "race":  # the refuter's shape: a tick lands while a forced re-discovery is loading
    import threading
    state = logging.getLogger("av-approval")._av_approval_plugins
    real_load, fired = manager._load_plugin, []
    def hooked(manifest):
        if not fired:
            fired.append(1)
            t = threading.Thread(target=lambda: fired.append(state["run"]("tick")))
            t.start(); t.join()
        return real_load(manifest)
    manager._load_plugin = hooked
    manager.discover_and_load(force=True)
    manager._load_plugin = real_load
    seen.append(["mid-sweep-tick", fired[1:]])
    seen.append(["after-tick", state["run"]("tick") is not None])
elif scenario == "noenable":
    plugins_cmd.cmd_install("file://" + repo, enable=False, no_deps=True)
    with open(os.path.join(home, "config.yaml")) as fh:
        data = yaml.safe_load(fh)
    data.setdefault("plugins", {}).setdefault("enabled", []).append("fixture-echo")  # the hand edit
    with open(os.path.join(home, "config.yaml"), "w") as fh:
        yaml.safe_dump(data, fh)
    seen.append(["tick-result", logging.getLogger("av-approval")._av_approval_plugins["run"]("tick")["unknown"]])
    seen.append(["after-tick", cfg()])
    manager.discover_and_load(force=True)
loaded = sorted(k for k, p in manager._plugins.items() if p.enabled and not p.error)
print("\n" + json.dumps({"events": seen, "loaded": loaded, "tool": "fixture_echo" in registry.get_all_tool_names(),
                         "plugins": cfg()}, default=str))
'''


def _fixture_repo(tmp_path: Path) -> tuple[Path, str]:
    repo = tmp_path / "fixture-repo"
    repo.mkdir()
    (repo / "plugin.yaml").write_text("name: fixture-echo\nversion: 0.0.1\ndescription: SEC-3 test fixture\n",
                                      encoding="utf-8")
    (repo / "__init__.py").write_text(
        "def register(ctx):\n"
        "    ctx.register_tool(name='fixture_echo', toolset='fixture', schema={'name': 'fixture_echo', "
        "'description': 'echo', 'parameters': {'type': 'object', 'properties': {}}}, handler=lambda args, **kw: '{}')\n",
        encoding="utf-8")
    git = ["git", "-C", str(repo), "-c", "user.email=t@example.com", "-c", "user.name=t"]
    for args in (["init", "-q"], ["add", "."], ["commit", "-qm", "fixture"]):
        subprocess.run(git + args, check=True, capture_output=True, timeout=60)
    sha = subprocess.run(git + ["rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
    return repo, sha


def _hermes(home: Path, repo: Path, scenario: str, mode: str, allow_rev: str = "") -> dict:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AV_", "HERMES_"))}
    env.update(PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home), _HERMES_GATEWAY="1")
    out = subprocess.run([sys.executable, "-c", _RUN, str(home), str(PLUGIN_DIR), str(repo), scenario, mode, allow_rev],
                         capture_output=True, text=True, env=env, timeout=600, cwd=str(home.parent))
    assert out.returncode == 0, out.stderr[-3000:]
    return json.loads(out.stdout.strip().splitlines()[-1])


def _bus(result, bare):
    return [p for e, p in result["events"] if e == "av-approval:" + bare]


hermes_backed = pytest.mark.skipif(not _HAVE_HERMES, reason="needs hermes_cli and ruamel.yaml on PYTHONPATH")


@hermes_backed
@pytest.mark.parametrize("mode", ["report", "quarantine"])
def test_hermes_run1_admin_install_mid_run(tmp_path, mode):
    repo, _sha = _fixture_repo(tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    result = _hermes(home, repo, "install", mode)
    for event, payload in result["events"]:
        assert _contract_drop(event.split(":", 1)[1], payload) is None, (event, payload)
    inventories = _bus(result, "plugin.inventory")
    assert inventories[0]["trigger"] == "boot" and inventories[0]["unknown_count"] == 0
    assert inventories[0]["bundled_loaded"] > 0 and inventories[0]["expected_loaded"] == 1
    assert {p["trigger"] for p in inventories[1:]} == {"loaded"}
    assert [p["unknown_count"] for p in inventories[1:]] == [1] * (len(inventories) - 1)
    unknown = _bus(result, "plugin.unknown")
    assert [(u["name"], u["state"], u["source"]) for u in unknown] == [("fixture-echo", "loaded", "user")]
    assert unknown[0]["revision"] == _sha and unknown[0]["pinned"] is False and unknown[0]["tools"] == 1
    restart = _hermes(home, repo, "restart", mode)
    if mode == "report":
        assert {u["action"] for u in unknown} == {"none"}
        assert "fixture-echo" in result["loaded"] and result["tool"] and result["plugins"].get("disabled") in (None, [])
        assert "fixture-echo" in restart["loaded"]
    else:
        assert {u["action"] for u in unknown} == {"unloaded_unlisted"}
        assert "fixture-echo" not in result["loaded"] and not result["tool"]
        assert "fixture-echo" in result["plugins"]["disabled"]
        assert "fixture-echo" not in restart["loaded"] and not restart["tool"]  # the next start is clean
    assert "av-approval" in restart["loaded"]


@hermes_backed
def test_hermes_a_tick_inside_a_forced_rediscovery_publishes_nothing(tmp_path):
    repo, _sha = _fixture_repo(tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    result = _hermes(home, repo, "race", "report")
    (mid,) = [p for e, p in result["events"] if e == "mid-sweep-tick"]
    assert mid == [None]  # the tick ran mid-sweep and was skipped
    (after,) = [p for e, p in result["events"] if e == "after-tick"]
    assert after is True  # a tick with the lock free runs (and sends nothing: nothing changed)
    assert [p["trigger"] for p in _bus(result, "plugin.inventory")] == ["boot"]


_MAIN = r"""
import importlib.abc, json, logging, os, shutil, sys
home, plugin_dir = sys.argv[1:3]
os.environ["HERMES_HOME"] = home
os.environ.pop("_HERMES_GATEWAY", None)
import yaml
shutil.copytree(plugin_dir, os.path.join(home, "plugins", "av-approval"), ignore=shutil.ignore_patterns("tests", "__pycache__"))
with open(os.path.join(home, "config.yaml"), "w") as fh:
    yaml.safe_dump({"plugins": {"enabled": ["av-approval"]}, "av_approval": {"unknown_plugins": "report"}}, fh)
seen = {}
class StopAtGatewayRun(importlib.abc.MetaPathFinder):  # stop where Hermes would import gateway/run.py
    def find_spec(self, name, path, target=None):
        if name == "gateway.run":
            seen["marker_at_gateway_run_import"] = os.environ.get("_HERMES_GATEWAY")
            raise SystemExit(0)
        return None
sys.meta_path.insert(0, StopAtGatewayRun())
from hermes_cli import plugins as hp
real_load = hp.PluginManager._load_plugin
def load(self, manifest):
    if manifest.name == "av-approval":
        seen["marker_at_av_approval_load"] = os.environ.get("_HERMES_GATEWAY")
    return real_load(self, manifest)
hp.PluginManager._load_plugin = load
import hermes_cli.main_web_build as mwb, hermes_cli.main_install_repair as mir
mwb._sweep_stale_bytecode_if_checkout_changed = lambda: None  # never write into the Hermes tree
mir._recover_from_interrupted_install = lambda: None
from hermes_cli import main as hm
hm._sweep_stale_bytecode_if_checkout_changed = lambda: None
hm._recover_from_interrupted_install = lambda: None
sys.argv = ["hermes", "gateway", "run"]
try:
    hm.main()
except SystemExit:
    pass
hp._join_background_discovery()
state = getattr(logging.getLogger("av-approval"), "_av_approval_plugins", None) or {}
thread = state.get("thread")
seen.update(listener=state.get("unsubscribe") is not None, active=bool(state.get("active")),
            tick_alive=bool(thread is not None and thread.is_alive()), booted=bool(state.get("booted")))
print("\n" + json.dumps(seen))
"""


@hermes_backed
def test_hermes_gateway_run_without_the_marker_starts_the_inventory(tmp_path):
    # Recheck M1: `hermes gateway run` discovers plugins BEFORE gateway/run.py sets _HERMES_GATEWAY.
    home = tmp_path / ".hermes"
    home.mkdir()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AV_", "HERMES_", "_HERMES_", "INVOCATION_ID"))}
    env.update(PYTHONDONTWRITEBYTECODE="1", HERMES_HOME=str(home))
    out = subprocess.run([sys.executable, "-c", _MAIN, str(home), str(PLUGIN_DIR)], capture_output=True, text=True,
                         env=env, timeout=600, cwd=str(tmp_path))
    assert out.returncode == 0, out.stderr[-3000:]
    seen = json.loads(out.stdout.strip().splitlines()[-1])
    assert seen["marker_at_av_approval_load"] is None  # the race the marker alone loses
    assert seen["marker_at_gateway_run_import"] is None
    assert (seen["listener"], seen["active"], seen["tick_alive"], seen["booted"]) == (True, True, True, True)


@hermes_backed
def test_hermes_run2_no_enable_then_hand_edit_is_unlisted_by_the_tick(tmp_path):
    repo, _sha = _fixture_repo(tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    result = _hermes(home, repo, "noenable", "quarantine")
    (tick,) = [p for e, p in result["events"] if e == "tick-result"]
    assert [(u["key"], u["state"], u["action"]) for u in tick] == [("fixture-echo", "enabled_not_loaded", "unlisted")]
    (after,) = [p for e, p in result["events"] if e == "after-tick"]
    assert "fixture-echo" in after["disabled"] and "fixture-echo" not in after["enabled"]
    assert "fixture-echo" not in result["loaded"] and not result["tool"]


@hermes_backed
def test_hermes_run3_allow_listed_revision_stays_bundled_is_bundled_override_is_unknown(tmp_path):
    repo, sha = _fixture_repo(tmp_path)
    home = tmp_path / ".hermes"
    home.mkdir()
    result = _hermes(home, repo, "allow", "quarantine", sha)
    assert "fixture-echo" in result["loaded"] and result["tool"]
    assert "web/ddgs" in result["loaded"]
    last = _bus(result, "plugin.inventory")[-1]
    assert last["allowed_count"] == 1 and last["unknown_count"] == 1 and last["bundled_loaded"] > 0
    unknown = _bus(result, "plugin.unknown")
    assert {(u["name"], u["state"], u["action"]) for u in unknown} == {("disk-cleanup", "overrides_bundled", "unlisted")}
