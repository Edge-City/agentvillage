"""Fixtures for the av-vote suite.

The plugin is loaded the way Hermes loads it (`spec_from_file_location` on `__init__.py` under the
mangled name `hermes_plugins.av_vote`), as the av-display suite does. Hermes is never imported; the
PTB-backed tests skip when `telegram` (python-telegram-bot) is not installed.
"""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_vote"


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
def plugin(monkeypatch):
    for name in ("AV_APP_ORIGIN", "TELEGRAM_HOME_CHANNEL", "AV_TENANT_ID", "TENANT_ID"):
        monkeypatch.delenv(name, raising=False)
    return load_plugin()
