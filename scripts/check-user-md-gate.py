#!/usr/bin/env python3
"""Release canary for the USER.md gate (review-b ov#558 S1): is it in place on this Hermes, by each path?

Run with Hermes's own interpreter and source, against the box's home (the plugins the installer staged):

    HERMES_HOME=$HOME/.hermes PYTHONPATH=$HOME/.hermes/hermes-agent \\
        $HOME/.hermes/hermes-agent/venv/bin/python scripts/check-user-md-gate.py

It checks two paths, each in a fresh interpreter, because the gate is installed once per process:
- `provider`: Hermes loads the village-memory provider (`plugins.memory.load_memory_provider`), whose
  `register()` installs the gate;
- `av-events`: av-events' `_user_md_gate.py` (self-contained) installs the same gate, as av-events'
  `register()` does in every gateway and cron process.
For each it reads `gate_state()`: `seam` (the per-session gate on `agent.system_prompt._memory_parts`, which the
prompt build reaches by bare name), `snapshot` (the fail-closed store gate: no seam on this Hermes) or `none`.

Prints one line, `user_md_gate provider=<state> av-events=<state>`, and exits 0 when both are `seam`, 1 when
the worst is `snapshot` (fail closed, but the private DM loses the entries from its prompt), 2 when either
is `none` or a path failed. Standard library only; reads no USER.md text and prints none.
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

RANK = {"seam": 0, "snapshot": 1}


def _state_via(via: str, home: Path) -> str:
    if via == "provider":
        from plugins.memory import load_memory_provider  # type: ignore[import-not-found]

        provider = load_memory_provider("village-memory")
        if provider is None:
            return "none"
        return sys.modules[type(provider).__module__].gate_state()
    gate = _load(home / "plugins" / "av-events" / "_user_md_gate.py", "_av_events_user_md_gate_probe")
    gate.install_user_md_gate()
    return gate.gate_state()


def _load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise ImportError(str(path))
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def main(argv: list) -> int:
    home = Path(os.environ.get("HERMES_HOME") or Path.home() / ".hermes")
    if len(argv) == 2 and argv[0] == "--via":
        try:
            print(json.dumps({"state": _state_via(argv[1], home)}))
        except Exception as exc:  # noqa: BLE001 - a path that fails is "none"
            print(json.dumps({"state": "none", "error": type(exc).__name__}))
        return 0
    states = {}
    for via in ("provider", "av-events"):
        out = subprocess.run([sys.executable, __file__, "--via", via], capture_output=True, text=True, timeout=120)
        try:
            states[via] = json.loads(out.stdout.strip().splitlines()[-1])["state"]
        except Exception:  # noqa: BLE001
            states[via] = "none"
    print(f"user_md_gate provider={states['provider']} av-events={states['av-events']}")
    worst = max(RANK.get(s, 2) for s in states.values())
    return worst


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
