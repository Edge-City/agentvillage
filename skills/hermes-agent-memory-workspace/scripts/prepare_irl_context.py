#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import urllib.parse
import urllib.request
from pathlib import Path

from common import context_path, now_iso, read_json, safe_read, state_path, today, vault_root, write_json


PERSON_RE = re.compile(r"\[\[([A-Z][^]\n]{1,80})\]\]")
EDGEOS_BASE = "https://api.edgeos.world/api/v1"
EDGE_ESMERALDA_POPUP_ID = "43746fd0-bce2-472b-93e4-a438177b2dff"
EDGE_ESMERALDA_EVENT_BASE_URL = "https://edgecity.simplefi.tech/portal/edge-esmeralda-2026/events"
PACIFIC_TZ = "America/Los_Angeles"


def recent_session_text(session_root: Path, limit: int = 5) -> str:
    files = sorted(session_root.rglob("*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    return "\n\n".join(safe_read(path)[:3000] for path in files)


def resolve_edgeos_api_key(root: Path) -> str:
    token = os.environ.get("EDGEOS_API_KEY", "").strip()
    if token:
        return token
    hermes_home = os.environ.get("HERMES_HOME", "").strip()
    candidates = [
        root / ".env",
        Path(hermes_home).expanduser() / ".env" if hermes_home else None,
        Path.home() / ".hermes" / ".env",
    ]
    seen: set[Path] = set()
    for env_file in candidates:
        if env_file is None:
            continue
        env_file = env_file.resolve()
        if env_file in seen or not env_file.exists():
            continue
        seen.add(env_file)
        try:
            for line in env_file.read_text(encoding="utf-8", errors="replace").splitlines():
                match = re.match(r"^\s*(?:export\s+)?EDGEOS_API_KEY\s*=\s*(.*)\s*$", line)
                if not match:
                    continue
                value = match.group(1).strip().strip("\"'")
                if value:
                    return value
        except Exception:
            continue
    return ""


def pacific_day_bounds(day: str) -> tuple[str, str]:
    # EdgeOS expects UTC instants. For this deployment we only need Pacific dates.
    # Avoid third-party deps; noon UTC offset is enough for PDT/PST day bounds here.
    y, m, d = [int(part) for part in day.split("-")]
    start_local = dt.datetime(y, m, d, 0, 0)
    # Determine offset from Intl-equivalent zone by asking the system zoneinfo.
    try:
        from zoneinfo import ZoneInfo

        tz = ZoneInfo(PACIFIC_TZ)
        start = start_local.replace(tzinfo=tz).astimezone(dt.timezone.utc)
        end = (start_local + dt.timedelta(days=1)).replace(tzinfo=tz).astimezone(dt.timezone.utc)
    except Exception:
        start = dt.datetime(y, m, d, 7, 0, tzinfo=dt.timezone.utc)
        end = start + dt.timedelta(days=1)
    return (
        start.isoformat(timespec="seconds").replace("+00:00", "Z"),
        end.isoformat(timespec="seconds").replace("+00:00", "Z"),
    )


def format_pacific(iso_value: str) -> str:
    try:
        from zoneinfo import ZoneInfo

        parsed = dt.datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
        local = parsed.astimezone(ZoneInfo(PACIFIC_TZ))
        return local.strftime("%-I:%M %p %Z")
    except Exception:
        return iso_value


def edgeos_get_events(root: Path, day: str, rsvped_only: bool) -> tuple[list[dict], str]:
    token = resolve_edgeos_api_key(root)
    if not token:
        return [], "unavailable:no-edgeos-api-key"
    popup_id = os.environ.get("EDGEOS_POPUP_ID", EDGE_ESMERALDA_POPUP_ID).strip()
    start_iso, end_iso = pacific_day_bounds(day)
    params = {
        "popup_id": popup_id,
        "event_status": "published",
        "start_after": start_iso,
        "start_before": end_iso,
        "limit": "100",
    }
    if rsvped_only:
        params["rsvped_only"] = "true"
    url = f"{EDGEOS_BASE}/events/portal/events?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.loads(response.read().decode("utf-8"))
        results = data.get("results", [])
        return results if isinstance(results, list) else [], "edgeos"
    except Exception as exc:
        return [], f"unavailable:{type(exc).__name__}"


def event_line(event: dict, reason: str) -> str:
    title = str(event.get("title") or "Untitled event")
    event_id = event.get("id")
    url = f"{EDGE_ESMERALDA_EVENT_BASE_URL}/{event_id}" if event_id else ""
    start = str(event.get("start_time") or "")
    end = str(event.get("end_time") or "")
    venue = event.get("venue_title") or event.get("custom_location_name") or ""
    host = str(event.get("host_display_name") or "").strip()
    tags = event.get("tags") if isinstance(event.get("tags"), list) else []
    tag_text = ", ".join(str(tag) for tag in tags if str(tag).strip())
    time_text = format_pacific(start)
    if end:
        time_text = f"{time_text}-{format_pacific(end)}"
    parts = [time_text, f"[{title}]({url})" if url else title]
    if venue:
        parts.append(f"at {venue}")
    if host:
        parts.append(f"host: {host}")
    if tag_text:
        parts.append(f"tags: {tag_text}")
    return f"- {' - '.join(part for part in parts if part)} ({reason})"


def edgeos_calendar_context(root: Path, day: str) -> tuple[str, dict]:
    events, event_source = edgeos_get_events(root, day, False)
    rsvps, rsvp_source = edgeos_get_events(root, day, True)
    highlighted = [event for event in events if event.get("highlighted") is True][:6]
    if not highlighted:
        highlighted = sorted(events, key=lambda event: str(event.get("start_time") or ""))[:6]
    lines = ["## EdgeOS calendar"]
    if rsvps:
        lines.append("\n### RSVPs")
        lines.extend(event_line(event, "RSVP") for event in sorted(rsvps, key=lambda event: str(event.get("start_time") or ""))[:6])
    if highlighted:
        lines.append("\n### Highlighted / selected events")
        lines.extend(event_line(event, "calendar") for event in sorted(highlighted, key=lambda event: str(event.get("start_time") or ""))[:6])
    if not rsvps and not highlighted:
        lines.append("\n- No live EdgeOS events available from this run.")
    return "\n".join(lines), {
        "calendarSource": event_source,
        "rsvpSource": rsvp_source,
        "eventCount": len(events),
        "rsvpCount": len(rsvps),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=".")
    parser.add_argument("--date", default=today())
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = Path(args.root).expanduser().resolve()
    vault = vault_root(root)
    session_text = recent_session_text(vault / "hermes" / "sessions")
    edgeos_text, edgeos_meta = edgeos_calendar_context(root, args.date)
    calendar_text = edgeos_text.strip()
    people = sorted(set(PERSON_RE.findall(session_text + "\n" + calendar_text)))[:20]
    context = read_json(context_path(root), {"forum": {}, "irl": {}, "petri": {}})
    context["irl"] = {
        "date": args.date,
        "calendarExcerpt": calendar_text[:1200],
        "calendarDiagnostics": edgeos_meta,
        "people": people,
        "recentSessionExcerpt": session_text.strip()[:1800],
        "targetPath": f"agent-memory-vault/irl/{args.date}.md",
        "instructions": [
            "Capture people, events, opportunities, and uncertainty from Telegram/calendar context.",
            "Preserve uncertainty plainly: attended, maybe attended, RSVP'd, mentioned, proposed, or unclear.",
            "Create person/event subnotes only when an entity recurs enough to deserve one.",
        ],
        "updatedAt": now_iso(),
    }

    if args.dry_run:
        print({"context": str(context_path(root)), "people": people, "edgeos": edgeos_meta})
        return
    write_json(context_path(root), context)
    state = read_json(state_path(root))
    state.setdefault("irlPreprocess", []).append({"at": now_iso(), "date": args.date, "context": str(context_path(root)), "people": people, "edgeos": edgeos_meta})
    write_json(state_path(root), state)
    print({"updated": str(context_path(root)), "people": people})


if __name__ == "__main__":
    main()
