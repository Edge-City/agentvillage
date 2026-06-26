#!/usr/bin/env python3
"""Search public agent-world sources through the control plane.

This compatibility entrypoint is named for the original Agent Commons forum
search, but the control-plane endpoint now exposes explicit surfaces:
Agent Commons forum plus Simocracy proposal/deliberation records.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any


MAX_QUERY_CHARS = 500
MAX_LIMIT = 8
SURFACES = {"agent_commons", "simocracy_proposals", "simocracy_deliberations"}


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def normalize_query(value: str) -> str:
    query = " ".join(str(value or "").split())
    if not query:
        raise ValueError("query required")
    if len(query) > MAX_QUERY_CHARS:
        raise ValueError(f"query must be {MAX_QUERY_CHARS} characters or fewer")
    return query


def normalize_limit(value: int) -> int:
    if value <= 0:
        return 5
    return min(value, MAX_LIMIT)


def normalize_surface(value: str) -> str:
    surface = str(value or "").strip().lower().replace("-", "_")
    if not surface:
        return ""
    if surface not in SURFACES:
        raise ValueError(f"unsupported surface: {surface}")
    return surface


def endpoint_url() -> str:
    base = os.environ.get("EDGE_AGENT_CONTROL_PLANE_URL", "").strip().rstrip("/")
    if not base:
        return ""
    return f"{base}/community/forum/search"


def search_forum(query: str, limit: int, surface: str = "", timeout: float = 8.0) -> dict[str, Any]:
    url = endpoint_url()
    token = os.environ.get("ADMIN_TOKEN", "").strip()
    if not url:
        return {"ok": False, "reason": "missing_control_plane_url", "results": []}
    if not token:
        return {"ok": False, "reason": "missing_admin_token", "results": []}

    request_body: dict[str, Any] = {"query": normalize_query(query), "limit": normalize_limit(limit)}
    normalized_surface = normalize_surface(surface)
    if normalized_surface:
        request_body["surface"] = normalized_surface
    body = json.dumps(request_body).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read(256 * 1024)
    except (urllib.error.URLError, TimeoutError, OSError):
        return {"ok": False, "reason": "forum_search_unavailable", "results": []}
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except Exception:
        return {"ok": False, "reason": "forum_search_invalid_response", "results": []}

    results = parsed.get("results", []) if isinstance(parsed, dict) else []
    if not isinstance(results, list):
        results = []
    return {
        "ok": True,
        "surface": normalized_surface or None,
        "queryHash": parsed.get("queryHash") if isinstance(parsed, dict) else None,
        "filters": parsed.get("filters") if isinstance(parsed, dict) else None,
        "results": results[: normalize_limit(limit)],
    }


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Search public agent-world source context")
    parser.add_argument("--query", required=True)
    parser.add_argument("--limit", type=int, default=5)
    parser.add_argument(
        "--surface",
        choices=sorted(SURFACES),
        default="",
        help="Optional retrieval surface: agent_commons, simocracy_proposals, or simocracy_deliberations",
    )
    parser.add_argument("--timeout-seconds", type=float, default=8.0)
    args = parser.parse_args(argv)

    try:
        payload = search_forum(args.query, args.limit, args.surface, timeout=args.timeout_seconds)
    except ValueError as err:
        payload = {"ok": False, "reason": str(err), "results": []}
    emit(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
