"""Fixtures for the av-godconst suite.

The plugin is loaded the way Hermes loads it (`spec_from_file_location` on `__init__.py` under the mangled name
`hermes_plugins.av_godconst`, its `_logic` submodule by relative import), as the av-vote suite does. Hermes and the
Telegram SDK are never imported: the bot, the buttons and the control plane are fakes.
"""

from __future__ import annotations

import importlib.util
import os
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_godconst"
ENV = ("THOR_NUDGES_ENABLED", "AV_THOR_KEY", "AV_GODCONST_BALLOT", "AV_GODCONST_ELICIT_CARDS", "AV_GODCONST_BALLOT_KEY", "CONTROL_PLANE_URL", "EDGEOS_API_KEY", "TELEGRAM_HOME_CHANNEL", "AV_TENANT_ID", "TENANT_ID", "HERMES_HOME")


def load_plugin():
    parent = MODULE_NAME.rsplit(".", 1)[0]
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []  # type: ignore[attr-defined]
        namespace.__package__ = parent
        sys.modules[parent] = namespace
    for name in (MODULE_NAME, f"{MODULE_NAME}._logic", f"{MODULE_NAME}._thor"):
        sys.modules.pop(name, None)
    spec = importlib.util.spec_from_file_location(MODULE_NAME, PLUGIN_DIR / "__init__.py", submodule_search_locations=[str(PLUGIN_DIR)])
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = MODULE_NAME
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def home(tmp_path, monkeypatch):
    path = tmp_path / "hermes"
    path.mkdir(mode=0o700)
    os.chmod(path, 0o700)
    for name in ENV:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("HERMES_HOME", str(path))
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", "4242")
    monkeypatch.setenv("AV_TENANT_ID", "0190a5b2-aaaa-4222-8333-444455556666")
    monkeypatch.setenv("AV_GODCONST_BALLOT", "1")
    return str(path)


@pytest.fixture
def plugin(home):
    module = load_plugin()
    module.SEND_GAP_S = 0.0
    return module
