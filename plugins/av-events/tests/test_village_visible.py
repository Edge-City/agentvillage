"""R-DEON: the village tools, and av-elicit's `elicitation_record` (GC-ELICIT), stay in the model's
tool list when Hermes's `tool_search` is on.

`_village_visible.py` rebinds `tools.tool_search._core_tool_names`. Most tests here use a small
stand-in of that module (Hermes is not installed in CI) whose `is_deferrable_tool_name` reads
`_core_tool_names` through the module global, as v2026.9.24 does (tool_search.py:150-162). The last
test runs the real Hermes (v2026.9.24) `assemble_tool_defs` in a subprocess and skips when no Hermes
source tree and Python are found (CI), as test_village_memory_hermes.py does. Synthetic names only.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import types
from pathlib import Path

import pytest

VILLAGE = {"ask_village": "av-events", "search_village": "av-events", "query_village": "av-events", "village": "village",
           "elicitation_record": "av-elicit"}

_FAKE_SOURCE = '''
REGISTRY = {}
CORE = frozenset({"terminal", "memory", "clarify"})
DEFER = frozenset({"todo_list"})

def _core_tool_names():
    return CORE

def _registry_toolset(name):
    return REGISTRY.get(name)

def is_deferrable_tool_name(name, defer_tools=DEFER):
    if name in defer_tools:
        return True
    if name in _core_tool_names():
        return False
    return _registry_toolset(name) is not None

def classify(names):
    return [n for n in names if not is_deferrable_tool_name(n)], [n for n in names if is_deferrable_tool_name(n)]
'''


@pytest.fixture
def fake_tool_search(home, monkeypatch):
    """A stand-in `tools.tool_search` in sys.modules, removed afterwards."""
    tools_pkg = types.ModuleType("tools")
    tools_pkg.__path__ = []  # type: ignore[attr-defined]
    module = types.ModuleType("tools.tool_search")
    exec(compile(_FAKE_SOURCE, "tool_search_standin", "exec"), module.__dict__)
    tools_pkg.tool_search = module  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "tools", tools_pkg)
    monkeypatch.setitem(sys.modules, "tools.tool_search", module)
    module.REGISTRY.update(VILLAGE)
    module.REGISTRY.update({"some_plugin_tool": "other-plugin", "todo_list": "todo"})
    return module


def vv(plugin):
    return sys.modules[f"{plugin.__name__}._village_visible"]


ALL = ["terminal", "memory", "todo_list", "ask_village", "search_village", "query_village", "village",
       "elicitation_record", "some_plugin_tool"]


def test_the_list_is_the_village_toolset_by_exact_registered_name(plugin):
    assert vv(plugin).VISIBLE_TOOLS == VILLAGE
    # Each name and toolset is the one its plugin registers with.
    events = Path(__file__).resolve().parents[1]
    for module, name in (("_ask_village", "ask_village"), ("_search_village", "search_village"),
                         ("_query_village", "query_village")):
        mod = sys.modules[f"{plugin.__name__}.{module}"]
        assert (mod.TOOL_NAME, mod.TOOLSET) == (name, "av-events")
    bridge = (events.parent / "village-bridge" / "__init__.py").read_text(encoding="utf-8")
    assert 'ctx.register_tool(name="village", toolset="village",' in bridge
    elicit = (events.parent / "av-elicit" / "__init__.py").read_text(encoding="utf-8")
    assert 'TOOL_NAME = "elicitation_record"' in elicit and 'TOOLSET = "av-elicit"' in elicit
    assert "register_tool(name=TOOL_NAME, toolset=TOOLSET," in elicit


def test_before_install_hermes_defers_every_village_tool(fake_tool_search):
    visible, deferred = fake_tool_search.classify(ALL)
    assert visible == ["terminal", "memory"]
    assert set(VILLAGE) <= set(deferred)


def test_register_keeps_the_village_tools_visible_and_nothing_else(fake_tool_search, plugin, ctx):
    plugin.register(ctx)
    visible, deferred = fake_tool_search.classify(ALL)
    assert visible == ["terminal", "memory", "ask_village", "search_village", "query_village", "village",
                       "elicitation_record"]
    # Every other plugin tool still defers, and Hermes's own defer list still wins.
    assert deferred == ["todo_list", "some_plugin_tool"]
    # Hermes's own set is not mutated.
    assert fake_tool_search.CORE == frozenset({"terminal", "memory", "clarify"})


def test_an_unregistered_name_is_not_added(fake_tool_search, av):
    # search_village and query_village with AV_SEARCH_VILLAGE off: not registered, so not core either
    # (a tool_call naming them keeps Hermes's "unknown name" answer, not "directly listed").
    del fake_tool_search.REGISTRY["search_village"]
    del fake_tool_search.REGISTRY["query_village"]
    plugin = av.load_plugin()
    assert vv(plugin).install() is True
    core = fake_tool_search._core_tool_names()
    assert {"ask_village", "village"} <= core
    assert not {"search_village", "query_village"} & core


def test_a_same_name_under_another_toolset_is_not_added(fake_tool_search, av):
    fake_tool_search.REGISTRY["ask_village"] = "someone-else"
    plugin = av.load_plugin()
    vv(plugin).install()
    assert "ask_village" not in fake_tool_search._core_tool_names()
    assert fake_tool_search.is_deferrable_tool_name("ask_village") is True


# ---- GC-ELICIT: av-elicit's elicitation_record ---------------------------------------------------
# Deferred behind the bridge, the GODCONST elicitation tool was never called in two live Haiku runs
# (the agent saved what it learned to memory instead).


def test_elicitation_record_under_av_elicit_is_core(fake_tool_search, av):
    plugin = av.load_plugin()
    assert vv(plugin).install() is True
    assert "elicitation_record" in fake_tool_search._core_tool_names()
    assert fake_tool_search.is_deferrable_tool_name("elicitation_record") is False


def test_elicitation_record_under_another_toolset_is_not_core(fake_tool_search, av):
    fake_tool_search.REGISTRY["elicitation_record"] = "av-events"
    plugin = av.load_plugin()
    vv(plugin).install()
    assert "elicitation_record" not in fake_tool_search._core_tool_names()
    assert fake_tool_search.is_deferrable_tool_name("elicitation_record") is True


def test_elicitation_record_unregistered_is_not_core(fake_tool_search, av):
    # av-elicit absent or not registered (no ctx.register_tool): nothing to keep visible.
    del fake_tool_search.REGISTRY["elicitation_record"]
    plugin = av.load_plugin()
    vv(plugin).install()
    core = fake_tool_search._core_tool_names()
    assert "elicitation_record" not in core
    assert {"ask_village", "village"} <= core


def test_load_order_does_not_matter_a_later_registration_counts(fake_tool_search, av):
    # av-events installs the wrapper first; av-elicit registers afterwards. The wrapper reads the
    # registry on every call, so the next assembly keeps the tool visible; an unregister defers it again.
    del fake_tool_search.REGISTRY["elicitation_record"]
    plugin = av.load_plugin()
    assert vv(plugin).install() is True
    assert "elicitation_record" not in fake_tool_search._core_tool_names()
    fake_tool_search.REGISTRY["elicitation_record"] = "av-elicit"
    assert "elicitation_record" in fake_tool_search._core_tool_names()
    visible, _ = fake_tool_search.classify(ALL)
    assert "elicitation_record" in visible
    del fake_tool_search.REGISTRY["elicitation_record"]
    assert "elicitation_record" not in fake_tool_search._core_tool_names()


def test_av_elicit_register_record_tool_lands_where_the_list_looks(fake_tool_search, av):
    # The real av-elicit registration, through a ctx that writes Hermes's registry stand-in.
    import importlib.util

    del fake_tool_search.REGISTRY["elicitation_record"]
    plugin = av.load_plugin()
    vv(plugin).install()
    src = Path(__file__).resolve().parents[2] / "av-elicit" / "__init__.py"
    spec = importlib.util.spec_from_file_location("av_elicit_for_visible_test", src)
    elicit = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(elicit)

    class Ctx:
        def register_tool(self, name, toolset, schema, handler, **kwargs):
            fake_tool_search.REGISTRY[name] = toolset

    assert elicit.register_record_tool(Ctx()) is True
    assert fake_tool_search.REGISTRY["elicitation_record"] == "av-elicit"
    assert "elicitation_record" in fake_tool_search._core_tool_names()


@pytest.mark.parametrize("value", ["0", "false", "no", "off", " OFF "])
def test_switch_off_leaves_hermes_as_is(fake_tool_search, av, monkeypatch, value):
    monkeypatch.setenv("AV_VILLAGE_TOOLS_VISIBLE", value)
    plugin = av.load_plugin()
    original = fake_tool_search._core_tool_names
    assert vv(plugin).install() is False
    assert fake_tool_search._core_tool_names is original
    assert fake_tool_search.is_deferrable_tool_name("ask_village") is True


def test_switch_off_from_the_dotenv(fake_tool_search, av, home):
    (home / ".env").write_text("AV_VILLAGE_TOOLS_VISIBLE=off\n", encoding="utf-8")
    plugin = av.load_plugin()
    assert vv(plugin).install() is False


@pytest.mark.parametrize("value", ["1", "on", "yes", "anything"])
def test_switch_default_and_other_values_are_on(fake_tool_search, av, monkeypatch, value):
    monkeypatch.setenv("AV_VILLAGE_TOOLS_VISIBLE", value)
    plugin = av.load_plugin()
    assert vv(plugin).install() is True
    assert "ask_village" in fake_tool_search._core_tool_names()


def test_idempotent_and_a_reload_rewraps_hermes_original(fake_tool_search, av):
    original = fake_tool_search._core_tool_names
    first = av.load_plugin()
    assert vv(first).install() is True
    wrapped = fake_tool_search._core_tool_names
    assert vv(first).install() is True
    assert fake_tool_search._core_tool_names is wrapped
    second = av.load_plugin()  # a force reload re-imports the plugin
    assert vv(second).install() is True
    assert fake_tool_search._core_tool_names is not wrapped
    assert fake_tool_search._core_tool_names.__wrapped__ is original


def test_unload_puts_hermes_function_back(fake_tool_search, plugin, ctx):
    original = fake_tool_search._core_tool_names
    plugin.register(ctx)
    assert fake_tool_search._core_tool_names is not original
    plugin._on_unload()
    assert fake_tool_search._core_tool_names is original


def test_a_failing_lookup_returns_hermes_own_set(fake_tool_search, av):
    plugin = av.load_plugin()
    vv(plugin).install()

    def boom(name):
        raise RuntimeError("registry down")

    fake_tool_search._registry_toolset = boom
    assert fake_tool_search._core_tool_names() == frozenset({"terminal", "memory", "clarify"})


def test_no_hermes_is_one_log_line_and_nothing_touched(home, av, monkeypatch, caplog):
    monkeypatch.setitem(sys.modules, "tools.tool_search", None)  # import raises
    plugin = av.load_plugin()
    with caplog.at_level("INFO", logger="av-events"):
        assert vv(plugin).install() is False
    assert "av-events: village_visible skipped=no_tool_search" in caplog.text


def test_a_hermes_without_the_seam_is_left_alone(fake_tool_search, av, caplog):
    del fake_tool_search._registry_toolset
    plugin = av.load_plugin()
    original = fake_tool_search._core_tool_names
    with caplog.at_level("INFO", logger="av-events"):
        assert vv(plugin).install() is False
    assert fake_tool_search._core_tool_names is original
    assert "skipped=no_seam" in caplog.text


def test_the_switch_is_documented():
    events = Path(__file__).resolve().parents[1]
    assert "- AV_VILLAGE_TOOLS_VISIBLE" in (events / "plugin.yaml").read_text(encoding="utf-8")
    readme = (events / "README.md").read_text(encoding="utf-8")
    assert "| `AV_VILLAGE_TOOLS_VISIBLE` | *(on)* |" in readme
    assert "## Village tools never deferred (R-DEON)" in readme


# ---- the real Hermes (v2026.9.24): skips in CI ---------------------------------------------------

_SRC = Path(os.environ.get("AV_HERMES_SRC") or os.environ.get("HERMES_AGENT_SRC")
            or Path.home() / "dev" / "hermes-agent-ref-v2026.9.24")
_PY_CANDIDATES = [os.environ.get("AV_HERMES_PYTHON") or "", str(_SRC / "venv" / "bin" / "python"),
                  str(Path.home() / ".hermes" / "hermes-agent" / "venv" / "bin" / "python")]
_PY = next((c for c in _PY_CANDIDATES if c and Path(c).is_file()), "")

_DRIVER = r'''
import importlib.util, json, sys, types
from pathlib import Path
try:
    from tools.registry import registry
    from tools import tool_search as ts
except Exception as exc:
    print(json.dumps({"import_error": f"{type(exc).__name__}: {exc}"}))
    sys.exit(0)

def schema(name):
    return {"name": name, "description": name.replace("_", " ") + " tool.",
            "parameters": {"type": "object", "properties": {}, "required": []}}

def handler(args, **kwargs):
    return "{}"

for name, toolset in (("ask_village", "av-events"), ("search_village", "av-events"),
                      ("query_village", "av-events"), ("village", "village"),
                      ("some_plugin_tool", "other-plugin")):
    registry.register(name=name, toolset=toolset, schema=schema(name), handler=handler)

names = ["terminal", "memory", "ask_village", "search_village", "query_village", "village", "some_plugin_tool",
         "elicitation_record"]
defs = [{"type": "function", "function": schema(n)} for n in names]
config = ts.ToolSearchConfig.from_raw({"enabled": "auto"})

def assemble():
    present = [d for d in defs if ts._registry_toolset(d["function"]["name"]) is not None
               or d["function"]["name"] in ("terminal", "memory")]
    result = ts.assemble_tool_defs(present, context_length=90000, config=config)
    return {"tools": [td["function"]["name"] for td in result.tool_defs],
            "activated": result.activated, "deferred": result.deferred_count}

def wrong_door(name):
    return ts.resolve_underlying_call({"calls": [{"name": name, "arguments": {}}]})[2] or ""

report = {"before": assemble(), "before_call": wrong_door("ask_village")}
plugin_dir = Path(sys.argv[1])
parent = types.ModuleType("hermes_plugins"); parent.__path__ = []
sys.modules.setdefault("hermes_plugins", parent)
spec = importlib.util.spec_from_file_location("hermes_plugins.av_events", plugin_dir / "__init__.py",
                                              submodule_search_locations=[str(plugin_dir)])
module = importlib.util.module_from_spec(spec)
sys.modules["hermes_plugins.av_events"] = module
spec.loader.exec_module(module)
vv = sys.modules["hermes_plugins.av_events._village_visible"]
report["installed"] = vv.install()
report["after"] = assemble()
# av-elicit registers after av-events installed the wrapper (plugin load order).
registry.register(name="elicitation_record", toolset="av-elicit", schema=schema("elicitation_record"), handler=handler)
report["after_elicit"] = assemble()
report["after_call"] = wrong_door("ask_village")
report["after_other_call"] = wrong_door("some_plugin_tool")
vv.uninstall()
report["restored"] = assemble()
print(json.dumps(report))
'''


@pytest.mark.skipif(not (_SRC / "tools" / "tool_search.py").is_file() or not _PY,
                    reason="needs a Hermes v2026.9.24 source tree and its Python (AV_HERMES_SRC, AV_HERMES_PYTHON)")
def test_real_hermes_assembly_keeps_village_tools_visible(tmp_path):
    plugin_dir = Path(__file__).resolve().parents[1]
    env = {k: v for k, v in os.environ.items() if not k.startswith("AV_")}
    env.update({"PYTHONPATH": str(_SRC), "HERMES_HOME": str(tmp_path)})
    out = subprocess.run([_PY, "-c", _DRIVER, str(plugin_dir)], cwd=_SRC, env=env, capture_output=True,
                         text=True, timeout=180)
    assert out.returncode == 0, out.stderr[-2000:]
    report = json.loads(out.stdout.strip().splitlines()[-1])
    assert "import_error" not in report, report
    bridge = {"tool_search", "tool_describe", "tool_call"}
    # Hermes as shipped: every plugin tool behind the bridge.
    before = report["before"]
    assert before["activated"] and before["deferred"] == 5
    assert not set(VILLAGE) & set(before["tools"]) and bridge <= set(before["tools"])
    # With av-events loaded: the village tools are listed, the unrelated plugin tool still defers.
    assert report["installed"] is True
    after = report["after"]
    assert after["activated"] and after["deferred"] == 1
    assert set(VILLAGE) - {"elicitation_record"} <= set(after["tools"]) and "some_plugin_tool" not in after["tools"]
    assert "directly-listed tool" in report["after_call"]
    # GC-ELICIT: elicitation_record registered after install is listed from the next assembly.
    after_elicit = report["after_elicit"]
    assert after_elicit["deferred"] == 1 and "elicitation_record" in after_elicit["tools"]
    assert report["after_other_call"] == ""
    # Unload: Hermes's behaviour again (now with elicitation_record deferred as well).
    restored = report["restored"]
    assert restored["activated"] and restored["deferred"] == 6
    assert not set(VILLAGE) & set(restored["tools"]) and bridge <= set(restored["tools"])
