"""Fixtures for the av-rate suite: the plugin loaded the way Hermes loads it (the av-vote pattern);
Hermes and the Telegram SDK are never imported."""

from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_rate"


def load_plugin():
    parent = MODULE_NAME.rsplit(".", 1)[0]
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []  # type: ignore[attr-defined]
        namespace.__package__ = parent
        sys.modules[parent] = namespace
    sys.modules.pop(MODULE_NAME, None)
    spec = importlib.util.spec_from_file_location(MODULE_NAME, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = MODULE_NAME
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for name in ("AV_RATE_CARDS", "AV_RATE_SESSION_KEY", "TELEGRAM_HOME_CHANNEL", "AV_TENANT_ID", "TENANT_ID"):
        monkeypatch.delenv(name, raising=False)
    (tmp_path / "av-events").mkdir(mode=0o700)
    return tmp_path


@pytest.fixture
def plugin(home):
    return load_plugin()
