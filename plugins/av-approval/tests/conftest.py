"""Fixtures for the av-approval suite.

The plugin is loaded the way Hermes loads it (`spec_from_file_location` on
`__init__.py` under the mangled name `hermes_plugins.av_approval`), as the
av-events suite does. Hermes is never imported.
"""

from __future__ import annotations

import importlib.util
import json
import logging
import sys
import threading
import types
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any, Callable

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_approval"
ENV_VARS = (
    "AV_APPROVAL_ENABLED",
    "AV_APPROVAL_URL",
    "AV_APPROVAL_TOKEN",
    "AV_APPROVAL_TOKEN_FILE",
    "HERMES_ACCEPT_HOOKS",
    "HERMES_HOME",
)


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


class FakeCtx:
    """Stands in for Hermes's PluginContext; records every registration attempt."""

    def __init__(self) -> None:
        self.hooks: dict[str, list[Callable]] = {}
        self.tools: list[Any] = []

    def register_hook(self, hook_name: str, callback: Callable):
        self.hooks.setdefault(hook_name, []).append(callback)
        return object()

    def register_tool(self, *args: Any, **kwargs: Any) -> None:
        self.tools.append((args, kwargs))


class ExplodingCtx:
    """A ctx whose every attribute raises, to prove register touches nothing on it."""

    def __getattr__(self, name: str):
        raise RuntimeError(f"ctx.{name} touched")


class FakeFacade:
    """A loopback HTTP server that records every request it receives and answers allow."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, str, dict[str, str], bytes]] = []
        facade = self

        class Handler(BaseHTTPRequestHandler):
            def _record(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                facade.requests.append((self.command, self.path, dict(self.headers), body))
                payload = b'{"exit_code":0,"stdout":"{}","stderr":""}'
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            do_GET = _record
            do_POST = _record

            def log_message(self, *args: Any) -> None:  # silence the test output
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


@pytest.fixture
def clean_env(monkeypatch):
    for name in ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    # "Once" is kept on the logger across reloads; each test starts from a fresh process view.
    logger = logging.getLogger("av-approval")
    if hasattr(logger, "_av_approval_logged"):
        delattr(logger, "_av_approval_logged")
    yield monkeypatch
    if hasattr(logger, "_av_approval_logged"):
        delattr(logger, "_av_approval_logged")


#: The installer's gated matchers, as config.yaml carries them.
SHIM_REL = "agent-hooks/hermes-hook-shim.sh"


def write_gate(home: Path, matchers, *, entries=None, auto_accept=True, env_lines=None) -> Path:
    """A HERMES_HOME as install/install_approval.ts leaves it: hooks block, consent, shim, marker."""
    import hashlib

    import yaml

    shim = home / SHIM_REL
    shim.parent.mkdir(parents=True, exist_ok=True)
    shim.write_text("#!/bin/sh\n# stand-in shim\ncat >/dev/null\necho '{}'\n", encoding="utf-8")
    shim.chmod(0o700)
    marker = {"daemon_id": None, "tenant_id": None, "installed_at": "2026-10-02T00:00:00Z", "overrides": [],
              "prior": {}, "shim_sha256": hashlib.sha256(shim.read_bytes()).hexdigest()}
    (home / "agent-hooks" / "approval-surface.json").write_text(json.dumps(marker), encoding="utf-8")
    if entries is None:
        entries = [{"matcher": m, "command": str(shim), "timeout": 300, "fail_closed": True} for m in matchers]
    cfg = {"model": {"default": "m"}, "hooks": {"pre_tool_call": entries}, "hooks_auto_accept": auto_accept,
           "plugins": {"enabled": ["av-approval"], "hook_callback_timeout": 600}}
    (home / "config.yaml").write_text(yaml.safe_dump(cfg), encoding="utf-8")
    lines = env_lines if env_lines is not None else ["# control plane", "AV_EVENTS_TOKEN=keep", "HERMES_ACCEPT_HOOKS=1"]
    (home / ".env").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return shim


@pytest.fixture
def gate(clean_env, tmp_path):
    """A healthy enforced-on gate; returns (monkeypatch, home, loaded plugin)."""
    home = tmp_path / ".hermes"
    home.mkdir()
    plugin = load_plugin()
    write_gate(home, plugin.GATED_MATCHERS)
    clean_env.setenv("HERMES_HOME", str(home))
    clean_env.setenv("AV_APPROVAL_ENABLED", "1")
    clean_env.setenv("AV_APPROVAL_URL", "http://127.0.0.1:4682")
    clean_env.setenv("HERMES_ACCEPT_HOOKS", "1")
    yield clean_env, home, plugin
    # Undo any permission a test took away, so tmp_path can be removed.
    for path in (home, *home.rglob("*")):
        try:
            if not path.is_symlink():
                path.chmod(0o700)
        except OSError:
            pass


@pytest.fixture
def facade():
    f = FakeFacade()
    yield f
    f.close()
