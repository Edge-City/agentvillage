#!/usr/bin/env python3
"""Secret redaction and secret-safe scan helpers for memory workspace output."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Iterable

SENSITIVE_ENV_NAMES = [
    "TELEGRAM_BOT_TOKEN",
    "ADMIN_TOKEN",
    "API_SERVER_KEY",
    "RAILWAY_API_TOKEN",
    "INDEX_API_KEY",
    "EDGEOS_API_KEY",
    "EDGEOS_BEARER_TOKEN",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
]

TOKEN_PATTERNS: list[tuple[str, re.Pattern[str], str]] = [
    ("edgeos-live", re.compile(r"\beos_live_[A-Za-z0-9._-]{8,}\b"), "eos_live_[REDACTED]"),
    ("github-user-token", re.compile(r"\bghu_[A-Za-z0-9_]{16,}\b"), "ghu_[REDACTED]"),
    (
        "jwt",
        re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b"),
        "eyJ[REDACTED]",
    ),
    ("openai-sk", re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"), "sk-[REDACTED]"),
    ("bearer-token", re.compile(r"(?i)(bearer\s+)[A-Za-z0-9._\-+/=]{16,}"), r"\1[REDACTED]"),
    ("x-api-key", re.compile(r"(?i)(x-api-key['\"\s:=]+)[A-Za-z0-9._\-+/=]{12,}"), r"\1[REDACTED]"),
    ("generic-api-key", re.compile(r"(?i)(api[_-]?key['\"\s:=]+)[A-Za-z0-9._\-+/=]{12,}"), r"\1[REDACTED]"),
    ("generic-secret", re.compile(r"(?i)(secret['\"\s:=]+)[A-Za-z0-9._\-+/=]{12,}"), r"\1[REDACTED]"),
    ("generic-token", re.compile(r"(?i)(token['\"\s:=]+)[A-Za-z0-9._\-+/=]{16,}"), r"\1[REDACTED]"),
]

_ENV_NAME_ALT = "|".join(re.escape(name) for name in SENSITIVE_ENV_NAMES)
ASSIGNMENT_PATTERNS: list[re.Pattern[str]] = [
    re.compile(rf"(?m)^(\s*(?:export\s+)?(?:{_ENV_NAME_ALT})\s*=\s*)([^\s#]+)"),
    re.compile(rf"(?m)^(\s*(?:{_ENV_NAME_ALT})\s*:\s*)([^\s#,]+)"),
    re.compile(rf"(?m)^(\s*['\"](?:{_ENV_NAME_ALT})['\"]\s*:\s*)([^\s#,]+)"),
]


def _is_non_secret_reference(value: str) -> bool:
    stripped = value.strip().rstrip(",")
    if not stripped:
        return True
    unquoted = stripped.strip("'\"")
    if unquoted in {"[REDACTED]", "<redacted>", "<REDACTED>", "REDACTED"}:
        return True
    if unquoted.startswith("${") or unquoted.startswith("$"):
        return True
    if unquoted.startswith("<") and unquoted.endswith(">"):
        return True
    return False


def _redact_assignment_match(match: re.Match[str]) -> str:
    prefix = match.group(1)
    value = match.group(2)
    if _is_non_secret_reference(value):
        return match.group(0)
    suffix = "," if value.rstrip().endswith(",") else ""
    quote = value[:1] if value[:1] in {"'", '"'} else ""
    closing = quote if quote else ""
    return f"{prefix}{quote}[REDACTED]{closing}{suffix}"


def redact(text: str, enabled: bool = True) -> str:
    if not enabled:
        return text
    text = redact_assignments(text)
    for _name, pattern, replacement in TOKEN_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def redact_assignments(text: str) -> str:
    for pattern in ASSIGNMENT_PATTERNS:
        text = pattern.sub(_redact_assignment_match, text)
    return text


def scan_text(text: str) -> dict[str, int]:
    counts: dict[str, int] = {}
    for pattern in ASSIGNMENT_PATTERNS:
        for match in pattern.finditer(text):
            if not _is_non_secret_reference(match.group(2)):
                counts["sensitive-assignment"] = counts.get("sensitive-assignment", 0) + 1
    token_text = redact_assignments(text)
    for name, pattern, _replacement in TOKEN_PATTERNS:
        count = len(pattern.findall(token_text))
        if count:
            counts[name] = counts.get(name, 0) + count
    return counts


def scan_files(paths: Iterable[Path]) -> dict:
    files: list[dict] = []
    total = 0
    by_kind: dict[str, int] = {}
    for path in sorted(paths):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        counts = scan_text(text)
        if not counts:
            continue
        file_count = sum(counts.values())
        total += file_count
        for key, value in counts.items():
            by_kind[key] = by_kind.get(key, 0) + value
        files.append({"path": str(path), "count": file_count, "kinds": sorted(counts)})
    return {"ok": total == 0, "matchCount": total, "byKind": by_kind, "files": files}
