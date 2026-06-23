#!/usr/bin/env python3
"""Deterministic preflight gate for the AgentVillage memory signal sync cron.

The expensive memory-sync prompt only needs to run when MEMORY.md changed since
its last successful sync. This script reads local files only, records the current
hash for quiet/no-op cases, and emits a final JSON line with wakeAgent so Hermes
can decide whether to invoke the LLM.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - old Python fallback
    ZoneInfo = None  # type: ignore[assignment]


STATE_VERSION = 1
NO_REPLY = {"wakeAgent": False}


def pacific_today() -> str:
    if ZoneInfo is not None:
        return datetime.now(ZoneInfo("America/Los_Angeles")).date().isoformat()
    return datetime.now(timezone.utc).date().isoformat()


def normalize_memory(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).strip()


def substantive_memory(text: str) -> bool:
    normalized = normalize_memory(text)
    if not normalized:
        return False
    content_lines: list[str] = []
    for line in normalized.split("\n"):
        stripped = line.strip()
        if not stripped:
            continue
        if re.match(r"^#+\s*(long[- ]term\s+)?memory\s*$", stripped, re.I):
            continue
        content_lines.append(stripped)
    return bool("\n".join(content_lines).strip())


def memory_hash(text: str) -> str:
    normalized = normalize_memory(text)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def read_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def memory_signals(state: dict[str, Any]) -> dict[str, Any]:
    raw = state.get("memorySignals")
    if isinstance(raw, dict):
        return dict(raw)
    return {}


def write_quiet_state(state_path: Path, state: dict[str, Any], signals: dict[str, Any], *, today: str, current_hash: str | None, reason: str) -> None:
    # Quiet gate checks are not successful sync runs. Do not update
    # lastRunDate here; the prompt writes it only after it processes changed
    # memory. This lets a same-day MEMORY.md edit wake the agent even if an
    # earlier unchanged check already happened.
    signals["lastCheckDate"] = today
    signals["lastGateReason"] = reason
    signals["gateVersion"] = STATE_VERSION
    if current_hash:
        signals["lastMemoryHash"] = current_hash
    state["memorySignals"] = signals
    atomic_write_json(state_path, state)


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Gate AgentVillage memory signal sync on MEMORY.md changes")
    parser.add_argument("--memory-file", default="MEMORY.md")
    parser.add_argument("--state-file", default="memory/heartbeat-state.json")
    parser.add_argument("--json-only", action="store_true", help="emit only the final JSON object")
    args = parser.parse_args(argv)

    memory_path = Path(args.memory_file)
    state_path = Path(args.state_file)
    today = pacific_today()
    state = read_state(state_path)
    signals = memory_signals(state)

    if not memory_path.exists():
        write_quiet_state(state_path, state, signals, today=today, current_hash=None, reason="missing_memory")
        emit({**NO_REPLY, "reason": "missing_memory"})
        return 0

    try:
        memory_text = memory_path.read_text(encoding="utf-8")
    except Exception as exc:
        emit({**NO_REPLY, "reason": "memory_read_failed", "error": exc.__class__.__name__})
        return 0

    if not substantive_memory(memory_text):
        write_quiet_state(state_path, state, signals, today=today, current_hash=None, reason="empty_memory")
        emit({**NO_REPLY, "reason": "empty_memory"})
        return 0

    current_hash = memory_hash(memory_text)
    previous_hash = signals.get("lastMemoryHash") if isinstance(signals.get("lastMemoryHash"), str) else ""

    if previous_hash == current_hash:
        write_quiet_state(state_path, state, signals, today=today, current_hash=current_hash, reason="unchanged_memory")
        emit({**NO_REPLY, "reason": "unchanged_memory", "memoryHash": current_hash})
        return 0

    # Existing tenants had prompt-led memory sync before this hash gate existed.
    # If there is evidence that memory sync has already run, initialize the hash
    # quietly instead of waking every resident once at rollout.
    has_prior_sync = bool(signals.get("lastRunDate")) or bool(signals.get("captured"))
    if not previous_hash and has_prior_sync:
        write_quiet_state(state_path, state, signals, today=today, current_hash=current_hash, reason="initialized_existing_state")
        emit({**NO_REPLY, "reason": "initialized_existing_state", "memoryHash": current_hash})
        return 0

    payload = {
        "wakeAgent": True,
        "reason": "memory_changed" if previous_hash else "first_memory_sync",
        "memoryHash": current_hash,
        "previousMemoryHashPresent": bool(previous_hash),
        "stateFile": str(state_path),
        "memoryFile": str(memory_path),
    }
    if not args.json_only:
        print("# AgentVillage Memory Signal Gate")
        print("")
        print("MEMORY.md changed since the last successful memory-signal sync.")
        print("Use the memory-signals prompt, read MEMORY.md, and update memorySignals.lastMemoryHash to the value below only after successful processing.")
        print("")
        print("```json")
        print(json.dumps(payload, indent=2, sort_keys=True))
        print("```")
    emit(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
