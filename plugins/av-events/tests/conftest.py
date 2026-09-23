"""Fixtures for the av-events suite.

The plugin is loaded exactly the way Hermes loads it — `spec_from_file_location`
on `__init__.py` with `submodule_search_locations` set, under a mangled name in
a synthetic namespace package (`hermes_cli/plugins.py:5424` and `:5490`). That
makes the import path itself part of what these tests verify: the hyphenated
directory name and the relative imports inside the plugin have to work.

Hermes is never imported.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable, Optional

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
#: Same mangling Hermes applies: "av-events" -> "hermes_plugins.av_events".
MODULE_NAME = "hermes_plugins.av_events"

AV_ENV_VARS = (
    "AV_EVENTS_ENABLED",
    "AV_EVENTS_URL",
    "AV_EVENTS_TOKEN",
    "AV_CAPTURE",
    "AV_HOOKS_DISABLED",
    "HERMES_VERSION",
    "OVERLAY_REF",
    "AV_OVERLAY_REF",
    "TENANT_ID",
    "AV_TENANT_ID",
    "AV_BACKUP_URL",
    "AV_BACKUP_TOKEN",
    "AV_BACKUP_MAX_BYTES",
)


def load_plugin():
    """Import the plugin the way `PluginManager._load_directory_module` does."""
    parent = MODULE_NAME.rsplit(".", 1)[0]
    if parent not in sys.modules:
        namespace = types.ModuleType(parent)
        namespace.__path__ = []  # type: ignore[attr-defined]
        namespace.__package__ = parent
        sys.modules[parent] = namespace

    stale = f"{MODULE_NAME}."
    for name in [n for n in list(sys.modules) if n == MODULE_NAME or n.startswith(stale)]:
        del sys.modules[name]

    spec = importlib.util.spec_from_file_location(
        MODULE_NAME,
        PLUGIN_DIR / "__init__.py",
        submodule_search_locations=[str(PLUGIN_DIR)],
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    module.__package__ = MODULE_NAME
    module.__path__ = [str(PLUGIN_DIR)]  # type: ignore[attr-defined]
    sys.modules[MODULE_NAME] = module
    spec.loader.exec_module(module)
    return module


def read_buffer(collector) -> list[dict]:
    """Every event the collector has written, current file included."""
    root = Path(collector.config.buffer_dir)
    if not root.exists():
        return []
    events: list[dict] = []
    for path in sorted(root.iterdir()):
        if not path.name.endswith(".jsonl"):
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                events.append(json.loads(line))
    return events


def types_of(events) -> list[str]:
    return [event["event_type"] for event in events]


class FakeCtx:
    """Stands in for `hermes_cli.plugins.PluginContext`.

    Only `register_hook` and `subscribe` are used by this plugin; anything else
    would be an error we want to see rather than silently absorb.
    """

    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.subscriptions: dict[str, list[Callable]] = {}

    def register_hook(self, hook_name: str, callback: Callable):
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def subscribe(self, event: str, callback: Callable) -> None:
        self.subscriptions.setdefault(event, []).append(callback)

    def publish(self, event: str, **payload: Any) -> None:
        """Deliver like `PluginManager._deliver_event`: `callback(**payload)`.

        Synchronous here; Hermes delivers on its own worker thread. Exceptions
        are not swallowed, for the same reason as `fire`.
        """
        for callback in self.subscriptions.get(event, []):
            callback(**payload)

    def fire(self, hook_name: str, **kwargs: Any) -> list:
        """Dispatch like `PluginManager.invoke_hook`: collect non-None returns.

        Deliberately does NOT swallow exceptions. Hermes does, but the whole
        point of scenario 25 is that the plugin must not rely on that.
        """
        results = []
        for callback in self.hooks.get(hook_name, []):
            value = callback(**kwargs)
            if value is not None:
                results.append(value)
        return results


class StubIngest:
    """A real `http.server` on localhost. The plugin speaks actual HTTP to it."""

    def __init__(self, statuses: Optional[list[int]] = None) -> None:
        #: Batches the server accepted (2xx).
        self.batches: list[list[dict]] = []
        #: Every batch it was offered, accepted or not.
        self.attempts: list[list[dict]] = []
        self.auth_headers: list[str] = []
        self.paths: list[str] = []
        self._statuses = list(statuses or [])
        self._lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):  # noqa: N802 - BaseHTTPRequestHandler API
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length).decode("utf-8")
                with outer._lock:
                    outer.paths.append(self.path)
                    outer.auth_headers.append(self.headers.get("Authorization") or "")
                    status = outer._statuses.pop(0) if outer._statuses else 200
                    try:
                        events = json.loads(raw).get("events", [])
                    except json.JSONDecodeError:
                        events = []
                    outer.attempts.append(events)
                    # `received` is what was actually accepted: a batch the
                    # server rejected has not been delivered.
                    if 200 <= status < 300:
                        outer.batches.append(events)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *args):  # noqa: A003 - silence the test log
                return

        self._server = HTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    def __enter__(self) -> "StubIngest":
        self._thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self._server.shutdown()
        self._server.server_close()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    @property
    def received(self) -> list[dict]:
        with self._lock:
            return [event for batch in self.batches for event in batch]

    @property
    def request_count(self) -> int:
        with self._lock:
            return len(self.attempts)


class Helpers:
    """Test helpers handed over as a fixture.

    pytest runs this suite in `importlib` import mode (see the repo-root
    `pytest.ini` for why), which does not put the test directory on `sys.path`,
    so a test module cannot `from conftest import ...`. A fixture is the way
    across.
    """

    MODULE_NAME = MODULE_NAME
    load_plugin = staticmethod(load_plugin)
    read_buffer = staticmethod(read_buffer)
    types_of = staticmethod(types_of)
    StubIngest = StubIngest
    PLUGIN_DIR = PLUGIN_DIR


# --------------------------------------------------------------------------
# Fixtures
# --------------------------------------------------------------------------


@pytest.fixture()
def av() -> Helpers:
    return Helpers()


@pytest.fixture()
def home(tmp_path, monkeypatch):
    """A clean `$HERMES_HOME` with every AV_* variable unset."""
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for name in AV_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    return tmp_path


@pytest.fixture()
def plugin(home):
    """A freshly imported plugin module with its singleton cleared."""
    module = load_plugin()
    module._COLLECTOR = None
    module._REGISTERED = False
    sys.modules[f"{MODULE_NAME}._collector"].reset_runtime_cache()
    yield module
    collector = module._COLLECTOR
    if collector is not None:
        collector._stop.set()
        collector._wake.set()
    module._COLLECTOR = None
    module._REGISTERED = False


@pytest.fixture()
def ctx():
    return FakeCtx()
