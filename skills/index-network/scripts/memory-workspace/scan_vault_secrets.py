#!/usr/bin/env python3
"""Scan rendered memory workspace files and report secret counts/paths only."""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from common import memory_dir, vault_root
from secret_redaction import scan_files


def discover_files(root: Path, include_memory: bool) -> list[Path]:
    candidates = list(vault_root(root).rglob("*.md"))
    if include_memory:
        candidates.extend(path for path in memory_dir(root).rglob("*") if path.is_file())
    return candidates


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="Target Hermes workspace root")
    parser.add_argument("--path", action="append", help="Specific file or directory to scan; may be repeated")
    parser.add_argument("--include-memory", action="store_true", help="Also scan memory/* operational files")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    if args.path:
        files: list[Path] = []
        for raw_path in args.path:
            path = Path(raw_path).expanduser().resolve()
            if path.is_dir():
                files.extend(child for child in path.rglob("*") if child.is_file())
            else:
                files.append(path)
    else:
        files = discover_files(root, args.include_memory)

    report = scan_files(files)
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
