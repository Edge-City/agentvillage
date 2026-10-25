"""Fixtures for the av-elicit suite: the plugin loaded the way Hermes loads it (the av-rate pattern);
Hermes is never imported. A temp HERMES_HOME holds a small state.db with Hermes's columns we read."""

from __future__ import annotations

import importlib.util
import sqlite3
import sys
import types
from pathlib import Path

import pytest

PLUGIN_DIR = Path(__file__).resolve().parents[1]
MODULE_NAME = "hermes_plugins.av_elicit"
OWNER = "123456789"
HOME_KEY = f"agent:main:telegram:dm:{OWNER}"


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


class StateDb:
    """A state.db with the sessions and messages columns the plugin reads."""

    def __init__(self, path: Path, active: bool = False):
        """``active``: the store has Hermes's ``messages.active`` column (an older store has none)."""
        self.path = path
        self.active = active
        con = sqlite3.connect(path)
        con.executescript(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, session_key TEXT, chat_type TEXT,"
            " started_at REAL NOT NULL);"
            "CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,"
            " content TEXT, timestamp REAL NOT NULL"
            + (", active INTEGER NOT NULL DEFAULT 1, _compressed_summary INTEGER NOT NULL DEFAULT 0" if active else "")
            + ");"
        )
        con.commit()
        con.close()

    def session(self, sid: str, source: str = "telegram", key: str = HOME_KEY, chat_type: str = "dm") -> str:
        con = sqlite3.connect(self.path)
        con.execute("INSERT INTO sessions (id, source, session_key, chat_type, started_at) VALUES (?,?,?,?,0)",
                    (sid, source, key, chat_type))
        con.commit()
        con.close()
        return sid

    def message(self, sid: str, role: str, content, ts: float, active: int = 1, summary: int = 0) -> None:
        con = sqlite3.connect(self.path)
        if self.active:
            con.execute("INSERT INTO messages (session_id, role, content, timestamp, active, _compressed_summary)"
                        " VALUES (?,?,?,?,?,?)", (sid, role, content, ts, active, summary))
        else:
            con.execute("INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)", (sid, role, content, ts))
        con.commit()
        con.close()


@pytest.fixture
def home(tmp_path, monkeypatch):
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    for name in ("AV_ELICIT_SESSION_KEY", "TELEGRAM_HOME_CHANNEL"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("TELEGRAM_HOME_CHANNEL", OWNER)
    return tmp_path


@pytest.fixture
def db(home):
    return StateDb(home / "state.db")


@pytest.fixture
def active_db(home):
    """A state.db with Hermes's current ``messages.active`` column."""
    return StateDb(home / "state.db", active=True)


@pytest.fixture
def plugin(home):
    return load_plugin()
