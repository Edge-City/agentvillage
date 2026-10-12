"""av-help: only a bare /help is rewritten. Hermes is never imported."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_help"


@pytest.fixture
def plugin():
    parent = MODULE_NAME.rsplit(".", 1)[0]
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []  # type: ignore[attr-defined]
        sys.modules[parent] = namespace
    sys.modules.pop(MODULE_NAME, None)
    spec = importlib.util.spec_from_file_location(
        MODULE_NAME, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)]
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


class Event:
    def __init__(self, text):
        self.text = text


@pytest.mark.parametrize("text", ["/help", "/HELP", "  /help  ", "/help@EdgeAgentBot", "/help\n"])
def test_a_bare_help_becomes_the_residents_question(plugin, text):
    assert plugin.pre_gateway_dispatch(event=Event(text)) == {
        "action": "rewrite", "text": "help - what can you do for me?",
    }


@pytest.mark.parametrize("text", [
    "/help schedule", "/helpme", "/commands", "/new", "help", "what can you do?", "please /help", "", None,
])
def test_everything_else_passes_through_untouched(plugin, text):
    assert plugin.pre_gateway_dispatch(event=Event(text)) is None


def test_an_event_with_no_text_is_left_alone(plugin):
    assert plugin.pre_gateway_dispatch(event=object()) is None
    assert plugin.pre_gateway_dispatch() is None


def test_register_adds_exactly_one_hook(plugin):
    hooks = []

    class Ctx:
        def register_hook(self, name, callback):
            hooks.append((name, callback))

    plugin.register(Ctx())
    assert hooks == [("pre_gateway_dispatch", plugin.pre_gateway_dispatch)]


def test_a_context_that_refuses_the_hook_never_stops_the_gateway(plugin):
    class Ctx:
        def register_hook(self, name, callback):
            raise RuntimeError("no such hook")

    plugin.register(Ctx())
