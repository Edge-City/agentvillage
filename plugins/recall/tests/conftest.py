"""Fixtures for the recall plugin suite.

The plugin is loaded the way Hermes loads a directory plugin
(`spec_from_file_location` with `submodule_search_locations`, under
`hermes_plugins.<name>`), and so is `av-events` for the end-to-end test.
Hermes itself is never imported: a `FakeCtx` stands in for `PluginContext`.
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
import types
from pathlib import Path
from typing import Any, Callable

import pytest

REPO = Path(__file__).resolve().parents[3]
PLUGIN_DIR = REPO / "plugins" / "recall"
AV_EVENTS_DIR = REPO / "plugins" / "av-events"
SCRIPT = REPO / "skills" / "recall" / "scripts" / "recall.ts"
FIXTURE = REPO / "skills" / "recall" / "scripts" / "tests" / "fixtures" / "workspace"

ENV_VARS = (
    "AV_RECALL_ENABLED",
    "AV_RECALL_SCRIPT",
    "AV_RECALL_BUN",
    "AV_RECALL_INDEX",
    "AV_RECALL_STATE_DB",
    "HERMES_SESSION_CHAT_TYPE",
    "HERMES_SESSION_PLATFORM",
    "HERMES_SESSION_SOURCE",
    "HERMES_CRON_SESSION",
    "AV_EVENTS_ENABLED",
    "AV_EVENTS_URL",
    "AV_EVENTS_TOKEN",
    "AV_CAPTURE",
    "AV_HOOKS_DISABLED",
)


def load(directory: Path, module_name: str):
    parent = module_name.rsplit(".", 1)[0]
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []  # type: ignore[attr-defined]
        namespace.__package__ = parent
        sys.modules[parent] = namespace
    for name in [n for n in list(sys.modules) if n == module_name or n.startswith(f"{module_name}.")]:
        del sys.modules[name]
    spec = importlib.util.spec_from_file_location(
        module_name, directory / "__init__.py", submodule_search_locations=[str(directory)]
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = module_name
    module.__path__ = [str(directory)]  # type: ignore[attr-defined]
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


class FakeCtx:
    """Stands in for `hermes_cli.plugins.PluginContext`.

    `emit` publishes `<plugin>:<event>` like Hermes does; `bus` lets a second
    plugin's `subscribe` receive it, synchronously.
    """

    def __init__(self, plugin_key: str = "recall", bus: "Bus | None" = None) -> None:
        self.plugin_key = plugin_key
        self.bus = bus
        self.tools: dict[str, dict[str, Any]] = {}
        self.hooks: dict[str, list[Callable]] = {}
        self.emitted: list[tuple[str, dict]] = []

    def register_tool(self, name, toolset, schema, handler, **kwargs):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kwargs}
        return object()

    def register_hook(self, hook_name, callback):
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def subscribe(self, event, callback):
        assert self.bus is not None
        self.bus.subscriptions.setdefault(event, []).append(callback)

    def emit(self, event, payload=None):
        assert ":" not in event, "Hermes forces the namespace; a plugin emits a bare name"
        self.emitted.append((event, dict(payload or {})))
        if self.bus is not None:
            return self.bus.deliver(f"{self.plugin_key}:{event}", dict(payload or {}))
        return 0

    def call(self, args, **kwargs) -> str:
        """Dispatch like `tools.registry.dispatch`: `handler(args, **kwargs)`."""
        return self.tools["recall"]["handler"](args, **kwargs)


class Bus:
    def __init__(self) -> None:
        self.subscriptions: dict[str, list[Callable]] = {}

    def deliver(self, event, payload) -> int:
        callbacks = self.subscriptions.get(event, [])
        for callback in callbacks:
            callback(**payload)
        return len(callbacks)


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A `$HERMES_HOME` holding the fixture workspace and the installed skill."""
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    shutil.copytree(FIXTURE, tmp_path, dirs_exist_ok=True)
    skill = tmp_path / "skills" / "recall" / "scripts"
    skill.mkdir(parents=True)
    shutil.copy(SCRIPT, skill / "recall.ts")
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    return tmp_path


@pytest.fixture()
def recall(home):
    module = load(PLUGIN_DIR, "hermes_plugins.recall")
    module._RECALL = None
    module._REGISTERED = False
    yield module
    module._RECALL = None
    module._REGISTERED = False


@pytest.fixture()
def ctx():
    return FakeCtx()


@pytest.fixture()
def bun_available():
    if shutil.which("bun") is None:
        pytest.skip("bun is not installed")
    return True


class Helpers:
    load = staticmethod(load)
    FakeCtx = FakeCtx
    Bus = Bus
    AV_EVENTS_DIR = AV_EVENTS_DIR
    PLUGIN_DIR = PLUGIN_DIR


@pytest.fixture()
def rc() -> Helpers:
    return Helpers()
