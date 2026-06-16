#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any, Dict


def workspace_root() -> Path:
    return Path.cwd()


def vault_root(root: Path | None = None) -> Path:
    return (root or workspace_root()) / "agent-memory-vault"


def memory_dir(root: Path | None = None) -> Path:
    return (root or workspace_root()) / "memory"


def state_path(root: Path | None = None) -> Path:
    return memory_dir(root) / "hermes-workspace-state.json"


def context_path(root: Path | None = None) -> Path:
    return memory_dir(root) / "hermes-workspace-context.json"


def today() -> str:
    return dt.date.today().isoformat()


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def read_json(path: Path, default: Dict[str, Any] | None = None) -> Dict[str, Any]:
    if not path.exists():
        return dict(default or {})
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else dict(default or {})
    except Exception:
        return dict(default or {})


def write_json(path: Path, value: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tmp.replace(path)


def append_skip(state: Dict[str, Any], reason: str, detail: str = "") -> None:
    state.setdefault("skips", [])
    state["skips"].append({"at": now_iso(), "reason": reason, "detail": detail})


def safe_read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def wikilink_date(day: str) -> str:
    return f"[[{day}]]"


def default_state() -> Dict[str, Any]:
    return {
        "visibleBudget": {"date": today(), "nonBriefLimit": 1, "nonBriefSent": 0},
        "prepared": {},
        "sent": [],
        "skips": [],
    }


def ensure_today_budget(state: Dict[str, Any]) -> None:
    budget = state.get("visibleBudget")
    if not isinstance(budget, dict) or budget.get("date") != today():
        state["visibleBudget"] = {"date": today(), "nonBriefLimit": 1, "nonBriefSent": 0}


def env_path(name: str, fallback: Path) -> Path:
    value = os.environ.get(name)
    return Path(value).expanduser() if value else fallback
