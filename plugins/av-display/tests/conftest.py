"""Fixtures for the av-display suite.

The plugin is loaded the way Hermes loads it (`spec_from_file_location` on
`__init__.py` under the mangled name `hermes_plugins.av_display`), as the
av-approval suite does. Hermes is never imported.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_display"


def load_plugin():
    parent = MODULE_NAME.rsplit(".", 1)[0]
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []  # type: ignore[attr-defined]
        namespace.__package__ = parent
        sys.modules[parent] = namespace
    sys.modules.pop(MODULE_NAME, None)
    spec = importlib.util.spec_from_file_location(
        MODULE_NAME, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = MODULE_NAME
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def plugin():
    return load_plugin()


@pytest.fixture
def fake_display(monkeypatch):
    """A stand-in for Hermes 0.21.5's agent.display: its two tables as they are at v2026.9.24."""
    module = types.ModuleType("agent.display")
    module._TOOL_VERBS = {
        "web_search": "Searching the web", "web_extract": "Reading",
        "read_file": "Reading", "write_file": "Writing", "patch": "Editing", "search_files": "Searching files",
        "terminal": "Running", "execute_code": "Running code",
        "session_search": "Searching past sessions", "skills_list": "Listing skills",
        "delegate_task": "Delegating", "cronjob_manage": "Scheduling",
        "memory": "Updating memory", "todo_list": "Updating tasks",
    }
    module._TOOL_VERBS_NO_PREVIEW = frozenset({"skills_list", "session_search"})

    def get_tool_verb(name):
        return module._TOOL_VERBS.get(name)

    def verb_drops_preview(name):
        return name in module._TOOL_VERBS_NO_PREVIEW

    module.get_tool_verb = get_tool_verb
    module.verb_drops_preview = verb_drops_preview
    monkeypatch.setitem(sys.modules, "agent.display", module)
    return module
