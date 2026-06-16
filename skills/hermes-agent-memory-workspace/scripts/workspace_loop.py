#!/usr/bin/env python3
from __future__ import annotations

import argparse
from pathlib import Path

from common import append_skip, context_path, ensure_today_budget, now_iso, read_json, state_path, today, vault_root, write_json


APPROVAL_MARKER = "APPROVED_HERMES_WORKSPACE_NUDGE"


def latest(path: Path) -> Path | None:
    files = sorted(path.glob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def signal_strength(vault: Path) -> tuple[bool, str]:
    forum = latest(vault / "forum")
    irl = latest(vault / "irl")
    if not forum and not irl:
        return False, "no-new-context"
    forum_text = forum.read_text(encoding="utf-8", errors="replace") if forum else ""
    irl_text = irl.read_text(encoding="utf-8", errors="replace") if irl else ""
    if "No configured" in forum_text and "No grounded" in irl_text:
        return False, "weak-signal"
    if "[[" not in irl_text:
        return False, "no-person-event-bridge"
    return True, "fresh-forum-irl-bridge"


def prepare(root: Path, dry_run: bool = False) -> dict:
    state = read_json(state_path(root))
    ensure_today_budget(state)
    vault = vault_root(root)
    ok, reason = signal_strength(vault)
    if not ok:
        append_skip(state, reason)
        if not dry_run:
            write_json(state_path(root), state)
        return {"staged": False, "reason": reason}

    budget = state["visibleBudget"]
    if budget.get("nonBriefSent", 0) >= budget.get("nonBriefLimit", 1):
        append_skip(state, "budget-used")
        if not dry_run:
            write_json(state_path(root), state)
        return {"staged": False, "reason": "budget-used"}

    staged_dir = root / "memory" / "hermes-workspace-staged"
    staged_dir.mkdir(parents=True, exist_ok=True)
    staged = staged_dir / f"{today()}-nudge.md"
    if staged.exists():
        append_skip(state, "duplicate-recent-nudge", str(staged))
        if not dry_run:
            write_json(state_path(root), state)
        return {"staged": False, "reason": "duplicate-recent-nudge"}

    body = f"""A fresh forum/IRL bridge may be worth a quiet optional nudge.

Review this staged draft and replace it with final user-facing copy before approval.

<!-- reason: {reason} -->
<!-- add {APPROVAL_MARKER} on its own line before send -->
"""
    state["prepared"] = {"at": now_iso(), "path": str(staged), "reason": reason}
    if dry_run:
        return {"staged": True, "path": str(staged), "dryRun": True}
    staged.write_text(body, encoding="utf-8")
    write_json(state_path(root), state)
    return {"staged": True, "path": str(staged), "reason": reason}


def send(root: Path, dry_run: bool = False) -> str:
    state = read_json(state_path(root))
    ensure_today_budget(state)
    prepared = state.get("prepared") if isinstance(state.get("prepared"), dict) else {}
    path_text = str(prepared.get("path", "")).strip()
    if not path_text:
        append_skip(state, "no-staged-nudge")
        if not dry_run:
            write_json(state_path(root), state)
        return "[SILENT]"
    path = Path(path_text)
    if not path.exists():
        append_skip(state, "no-staged-nudge")
        if not dry_run:
            write_json(state_path(root), state)
        return "[SILENT]"
    body = path.read_text(encoding="utf-8", errors="replace")
    if APPROVAL_MARKER not in body:
        append_skip(state, "approval-required", str(path))
        if not dry_run:
            write_json(state_path(root), state)
        return "[SILENT]"
    final = body.replace(APPROVAL_MARKER, "").strip()
    state["visibleBudget"]["nonBriefSent"] = state["visibleBudget"].get("nonBriefSent", 0) + 1
    state.setdefault("sent", []).append({"at": now_iso(), "path": str(path)})
    if not dry_run:
        write_json(state_path(root), state)
    return final


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--send", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    root = Path(args.root).expanduser().resolve()

    if args.send:
        print(send(root, args.dry_run))
        return
    result = prepare(root, args.dry_run)
    ctx = read_json(context_path(root))
    ctx["lastWorkspaceLoop"] = {"at": now_iso(), **result}
    if not args.dry_run:
        write_json(context_path(root), ctx)
    print(result)


if __name__ == "__main__":
    main()
