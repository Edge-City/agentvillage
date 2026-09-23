"""`tool.call`: the tool-name allowlist and the payload (spec §4.1, §7.1).

Pure functions over one `post_tool_call` payload. The allowlist is the frozen
seed `tool_categories.json` next to this file, read once at import — plugin
load, never inside a hook.

A tool the seed lists leaves by its Hermes registry name and a category. Any
other tool leaves as category `other` with a null name, so a third-party MCP
server's tool names never reach ingest in any capture mode (§7.1 "tool names
passed through a category allowlist"). Arguments and results never leave
either: only a SHA-256 and a character count, and in `metadata` not even
those.

Python 3.11, standard library only.
"""

from __future__ import annotations

import json
import math
import os
import re
from typing import Any, Callable, Optional

from ._core import canonical_json

SEED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tool_categories.json")

UNLISTED_TOOL_CATEGORY = "other"

#: Hermes `post_tool_call` statuses (`model_tools.py` at `v2026.8.31`, plus
#: the `timeout` and `cancelled` it emits on an interrupted call). Anything
#: else is reported as `other`, never passed through.
TOOL_STATUSES = frozenset({"ok", "error", "blocked", "timeout", "cancelled"})
OTHER_STATUS = "other"

#: An `error_type` leaves only when it looks like a class or category name.
#: `error_message` never leaves: it can quote the arguments that caused it.
_ERROR_TYPE = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]{0,63}$")

_CATEGORY = re.compile(r"^[a-z][a-z0-9_]{0,31}$")
_NAME = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def load_categories(path: str = SEED_FILE) -> tuple[Optional[str], dict[str, str]]:
    """(version, {Hermes tool name: category}) from the seed, or (None, {}).

    `builtin` names are keyed as Hermes reports them; `mcp.<server>.<tool>`
    becomes `mcp__<server>__<tool>`, the name Hermes registers an MCP tool
    under (`tools/mcp_tool.py`, `MCP_TOOL_NAME_PREFIX`). A bare Index tool name
    is therefore *not* listed: a native tool that happens to be called
    `create_intent` is not Index. A missing or malformed seed lists nothing,
    which fails closed — every tool is `other`.
    """
    try:
        with open(path, encoding="utf-8") as handle:
            seed = json.load(handle)
    except (OSError, ValueError):
        return None, {}
    if not isinstance(seed, dict):
        return None, {}
    out: dict[str, str] = {}
    builtin = seed.get("builtin")
    if isinstance(builtin, dict):
        for name, category in builtin.items():
            if isinstance(name, str) and _NAME.match(name) and isinstance(category, str) and _CATEGORY.match(category):
                out[name] = category
    servers = seed.get("mcp")
    if isinstance(servers, dict):
        for server, tools in servers.items():
            if not (isinstance(server, str) and _NAME.match(server) and isinstance(tools, dict)):
                continue
            for tool, category in tools.items():
                full = f"mcp__{server}__{tool}"
                if isinstance(tool, str) and _NAME.match(full) and isinstance(category, str) and _CATEGORY.match(category):
                    out[full] = category
    version = seed.get("version") if isinstance(seed.get("version"), str) else None
    return version, out


TOOL_CATEGORY_VERSION, TOOL_CATEGORIES = load_categories()


def tool_category(name: Any) -> str:
    if not isinstance(name, str) or not name:
        return UNLISTED_TOOL_CATEGORY
    return TOOL_CATEGORIES.get(name, UNLISTED_TOOL_CATEGORY)


def listed_tool_name(name: Any) -> Optional[str]:
    """The tool's name if the allowlist lists it, else None."""
    return name if isinstance(name, str) and name in TOOL_CATEGORIES else None


def normalise_status(status: Any) -> Optional[str]:
    """Hermes's status, case-folded; None when absent; `other` when unknown."""
    if status is None:
        return None
    text = str(status).strip().lower()
    if not text:
        return None
    return text if text in TOOL_STATUSES else OTHER_STATUS


def status_ok(status: Optional[str]) -> bool:
    """A call Hermes reports `ok`, or reports no status at all, did its work."""
    return status in (None, "ok")


def _latency_ms(duration: Any) -> Optional[int]:
    if isinstance(duration, bool) or not isinstance(duration, (int, float)):
        return None
    if not math.isfinite(duration) or duration < 0:
        return None
    return int(round(duration))


def _as_text(value: Any) -> Optional[str]:
    """What is hashed: the string itself, or canonical JSON of anything else."""
    if value is None:
        return None
    if isinstance(value, str):
        return value
    try:
        return canonical_json(value)
    except (TypeError, ValueError, RecursionError):
        return None


def tool_call_payload(
    tool_name: Any,
    args: Any,
    result: Any,
    status: Any,
    duration_ms: Any,
    error_type: Any,
    capture: str,
    hasher: Callable[[str], Optional[str]],
) -> dict:
    """§4.1 `tool.call`: `tool_name`, `args_hash`, `result_hash`, `ok`,
    `latency_ms`, `receipt?` — every key always present, null when unknown.

    Not in §4.1: `tool_category`, `status`, `error_type`, `operation` /
    `target_system` (filled by the EdgeOS matcher), `category_version`, and
    `args_length` / `result_length` above `metadata`.

    The two hashes are `hasher`'s: HMAC-SHA256 under the tenant's own key
    (`Collector.keyed_hash`), not a plain SHA-256 — a plain hash of a short
    argument is a dictionary lookup away from the argument, and nothing
    outside the tenant joins on it. In `metadata` they are null.
    """
    normalised = normalise_status(status)
    raw_error = error_type if isinstance(error_type, str) else None
    payload: dict[str, Any] = {
        "tool_name": listed_tool_name(tool_name),
        "tool_category": tool_category(tool_name),
        "args_hash": None,
        "result_hash": None,
        "ok": status_ok(normalised),
        "status": normalised,
        "latency_ms": _latency_ms(duration_ms),
        "receipt": None,
        "error_type": raw_error if raw_error and _ERROR_TYPE.match(raw_error) else None,
        "operation": None,
        "target_system": None,
        "category_version": TOOL_CATEGORY_VERSION,
    }
    if capture != "metadata":
        args_text = _as_text(args)
        result_text = _as_text(result)
        payload["args_hash"] = hasher(args_text) if args_text is not None else None
        payload["result_hash"] = hasher(result_text) if result_text is not None else None
        payload["args_length"] = len(args_text) if args_text is not None else None
        payload["result_length"] = len(result_text) if result_text is not None else None
    return payload


__all__ = [
    "SEED_FILE",
    "TOOL_CATEGORIES",
    "TOOL_CATEGORY_VERSION",
    "TOOL_STATUSES",
    "UNLISTED_TOOL_CATEGORY",
    "listed_tool_name",
    "load_categories",
    "normalise_status",
    "status_ok",
    "tool_call_payload",
    "tool_category",
]
