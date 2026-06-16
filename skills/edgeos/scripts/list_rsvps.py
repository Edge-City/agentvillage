#!/usr/bin/env python3
"""List the caller's published RSVP events for one bounded EdgeOS window."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, Iterable, List, Optional


EDGEOS_BASE_URL = "https://api.edgeos.world/api/v1"


def _text(value: Any) -> Optional[str]:
    if isinstance(value, str) and value:
        return value
    return None


def _first_text(record: Dict[str, Any], keys: Iterable[str]) -> Optional[str]:
    for key in keys:
        value = _text(record.get(key))
        if value:
            return value
    return None


def _venue_fields(event: Dict[str, Any]) -> Dict[str, Optional[str]]:
    venue = event.get("venue")
    if not isinstance(venue, dict):
        venue = event.get("event_venue")
    if not isinstance(venue, dict):
        venue = {}

    return {
        "venue_title": _first_text(venue, ("title", "name")),
        "venue_location": _first_text(
            venue, ("location", "formatted_address", "address")
        ),
        "custom_location_name": _text(event.get("custom_location_name")),
        "custom_location_url": _text(event.get("custom_location_url")),
    }


def _event_summary(event: Dict[str, Any]) -> Dict[str, Any]:
    summary: Dict[str, Any] = {
        "title": _first_text(event, ("title", "name")),
        "start_time": _text(event.get("start_time")),
        "end_time": _text(event.get("end_time")),
        "timezone": _text(event.get("timezone")),
    }
    summary.update(_venue_fields(event))
    return summary


def _load_results(payload: Any) -> List[Dict[str, Any]]:
    if not isinstance(payload, dict):
        raise ValueError("response JSON must be an object")
    results = payload.get("results")
    if not isinstance(results, list):
        raise ValueError("response JSON missing results array")
    events: List[Dict[str, Any]] = []
    for index, item in enumerate(results):
        if not isinstance(item, dict):
            raise ValueError(f"response result at index {index} is not an object")
        events.append(item)
    return events


class NoRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[override]
        return None


def _build_url(args: argparse.Namespace) -> str:
    params = {
        "popup_id": args.popup_id,
        "event_status": "published",
        "rsvped_only": "true",
        "start_after": args.start_after,
        "start_before": args.start_before,
        "limit": str(args.limit),
    }
    query = urllib.parse.urlencode(params)
    return f"{EDGEOS_BASE_URL}/events/portal/events?{query}"


def _fetch_json(url: str, token: str, timeout: float) -> tuple[int, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        },
        method="GET",
    )
    opener = urllib.request.build_opener(NoRedirectHandler)
    with opener.open(request, timeout=timeout) as response:
        status = int(response.status)
        body = response.read()
    try:
        return status, json.loads(body.decode("utf-8"))
    except UnicodeDecodeError as exc:
        raise ValueError("response body is not valid UTF-8") from exc
    except json.JSONDecodeError as exc:
        raise ValueError("response body is not valid JSON") from exc


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Read-only RSVP event list/count for one popup and time window. "
            "Requires EDGEOS_API_KEY in the environment."
        )
    )
    parser.add_argument("--popup-id", required=True)
    parser.add_argument("--start-after", required=True)
    parser.add_argument("--start-before", required=True)
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--timeout", type=float, default=20.0)
    args = parser.parse_args(argv)

    if args.limit < 1 or args.limit > 100:
        parser.error("--limit must be between 1 and 100")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    return args


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    token = os.environ.get("EDGEOS_API_KEY", "").strip()
    if not token:
        print("EDGEOS_API_KEY is required", file=sys.stderr)
        return 2

    url = _build_url(args)
    try:
        status, payload = _fetch_json(url, token, args.timeout)
        events = _load_results(payload)
    except urllib.error.HTTPError as exc:
        print(f"EdgeOS RSVP list request failed with HTTP {exc.code}", file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        reason = exc.reason.__class__.__name__
        print(f"EdgeOS RSVP list request failed: {reason}", file=sys.stderr)
        return 1
    except TimeoutError:
        print("EdgeOS RSVP list request timed out", file=sys.stderr)
        return 1
    except ValueError as exc:
        print(f"EdgeOS RSVP list response error: {exc}", file=sys.stderr)
        return 1

    print(
        json.dumps(
            {
                "ok": 200 <= status < 300,
                "status": status,
                "results_count": len(events),
                "events": [_event_summary(event) for event in events],
            },
            ensure_ascii=True,
            separators=(",", ":"),
        )
    )
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    raise SystemExit(main())
