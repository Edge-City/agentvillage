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


@pytest.fixture
def fake_runner(monkeypatch):
    """A stand-in for gateway.run_turn_runner with Hermes 0.21.5's branch order in
    TurnRunner._progress_build_message (run_turn_runner.py:261-300, "new"/"all" mode): the
    terminal code block (:238-258) first, returned as is when built (:276); only then the
    verb tables of agent.display (:292-300)."""
    module = types.ModuleType("gateway.run_turn_runner")

    class TurnRunner:
        def __init__(self, adapter):
            self.adapter = adapter

        def _progress_terminal_blocks(self, adapter, tool_name, args, emoji):
            if not (getattr(adapter, "supports_code_blocks", False) and tool_name == "terminal"
                    and isinstance(args, dict) and isinstance(args.get("command"), str) and args["command"].strip()):
                return None, None
            cmd = args["command"].rstrip()
            short = cmd.splitlines()[0][:40]
            return f"{emoji} {tool_name}\n```\n{cmd}\n```", f"{emoji} {tool_name}\n```\n{short}\n```"

        def _progress_build_message(self, tool_name, preview, args):
            emoji = "⚙️"
            code_full, code_short = self._progress_terminal_blocks(self.adapter, tool_name, args, emoji)
            if code_short is not None:
                return code_short
            if not preview:
                return f"{emoji} {tool_name}..."
            display = sys.modules["agent.display"]
            verb = display.get_tool_verb(tool_name)
            if not verb:
                return f'{emoji} {tool_name}: "{preview}"'
            return f"{emoji} {verb}" if display.verb_drops_preview(tool_name) else f"{emoji} {verb} {preview}"

    module.TurnRunner = TurnRunner
    monkeypatch.setitem(sys.modules, "gateway.run_turn_runner", module)
    return module

