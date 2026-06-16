#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import subprocess
from pathlib import Path

from common import env_path, memory_dir, vault_root


def renderer_candidates(script: Path) -> list[Path]:
    candidates = [
        script.parent / "render_hermes_sessions.py",
        script.parents[3] / "scripts" / "render_hermes_sessions.py",
    ]
    override = os.environ.get("HERMES_AGENT_MEMORY_SESSION_RENDERER", "").strip()
    if override:
        candidates.insert(0, Path(override).expanduser())
    return candidates


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".", help="Target Hermes workspace root")
    parser.add_argument("--input", help="Hermes sessions input directory")
    parser.add_argument("--mode", choices=["new", "all"], default="new")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    sessions = Path(args.input).expanduser() if args.input else env_path("HERMES_SESSIONS_DIR", Path(os.environ.get("HERMES_HOME", str(Path.home() / ".hermes"))) / "sessions")
    output = vault_root(root) / "hermes" / "sessions"
    state = memory_dir(root) / "hermes-workspace-session-render-state.json"

    renderer = next((candidate for candidate in renderer_candidates(Path(__file__).resolve()) if str(candidate) and candidate.exists()), None)
    if not renderer:
        raise SystemExit("No internal render_hermes_sessions.py found. Set HERMES_AGENT_MEMORY_SESSION_RENDERER.")

    cmd = [
        "python3",
        str(renderer),
        "--input",
        str(sessions),
        "--output",
        str(output),
        "--state",
        str(state),
        "--mode",
        args.mode,
        "--no-enzyme-config",
    ]
    if args.dry_run:
        print({"dryRun": True, "cmd": cmd})
        return
    result = subprocess.run(cmd, check=False, text=True, capture_output=True)
    if result.returncode != 0:
        raise SystemExit(result.stderr.strip() or result.stdout.strip() or "session render failed")
    print(result.stdout.strip())


if __name__ == "__main__":
    main()
