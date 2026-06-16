#!/usr/bin/env python3
"""Prepare deterministic context for a Hermes heartbeat-agent distillation cron."""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def resolve_root(script: Path, explicit: str | None) -> Path:
    if explicit:
        return Path(explicit).expanduser().resolve()
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    if hermes_home:
        return Path(hermes_home).expanduser().resolve()
    return script.parents[3]


def run_step(label: str, command: list[str]) -> None:
    print(f"--- {label} ---", file=sys.stderr)
    result = subprocess.run(command, text=True, capture_output=True)
    if result.stdout.strip():
        print(result.stdout.strip(), file=sys.stderr)
    if result.stderr.strip():
        print(result.stderr.strip(), file=sys.stderr)
    if result.returncode != 0:
        raise SystemExit(result.returncode)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", help="Target Hermes workspace root. Defaults to $HERMES_HOME or the installed Hermes root.")
    args = parser.parse_args()

    script = Path(__file__).resolve()
    scripts_dir = script.parent
    root = resolve_root(script, args.root)

    run_step("1/3 render session transcripts", ["python3", str(scripts_dir / "render_vault_sessions.py"), "--root", str(root)])
    run_step("2/3 prepare IRL context", ["python3", str(scripts_dir / "prepare_irl_context.py"), "--root", str(root)])
    run_step("3/3 prepare forum context", ["python3", str(scripts_dir / "prepare_forum_context.py"), "--root", str(root)])

    context_file = root / "memory" / "hermes-workspace-context.json"
    if context_file.exists():
        context = json.loads(context_file.read_text(encoding="utf-8"))
    else:
        context = {"error": "missing hermes-workspace-context.json"}

    print(
        "\n".join(
            [
                "# Hermes Agent Memory Heartbeat",
                "",
                "Use this runtime context plus recent rendered session Markdown to write or update:",
                "",
                "- `agent-memory-vault/forum/YYYY-MM-DD.md`",
                "- `agent-memory-vault/irl/YYYY-MM-DD.md`",
                "",
                "Keep the notes concise, grounded, and uncertainty-aware. Do not copy the JSON wholesale into the vault.",
                "After writing the notes, run `workspace_loop.py --prepare` to stage or skip any nudge.",
                "",
                "```json",
                json.dumps(context, indent=2, sort_keys=True),
                "```",
            ]
        )
    )


if __name__ == "__main__":
    main()
