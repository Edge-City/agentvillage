"""Reviewed local availability and daemon authority; neither model arguments nor disk grant writes."""
from __future__ import annotations
import hashlib
import importlib
import json
import os
import re
import stat
from pathlib import Path

MINI_APPS_GATE_VERSION = 1
# BRIDGE-RESTORE (rc41, Carter's ruling, CLAIMS L7212/L7216): ov#300's native `rolodex.meeting`
# (owner-requested mark/undo) and `skylight.status` (the owner's own read) ride the Gold Stars install,
# appended in this exact order. The control-plane catalog's gold-stars entry must carry the same list.
GOLD_STARS = {"version": "1.1.0", "skills": ["gold-stars"], "operations": ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status"]}
# The entry before the restore (ov#343). Still accepted so the overlay and the CP catalog can land in
# either order; it carries no meeting or Skylight operation, so those stay refused under it.
GOLD_STARS_PREVIOUS = {"version": "1.1.0", "skills": ["gold-stars"], "operations": ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel"]}


def installed(home: Path, app_id: str, operation: str) -> bool:
    try:
        path = home / "mini-apps.json"
        if any(p.is_symlink() for p in (path, *path.parents)):
            return False
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as handle:
            st = os.fstat(handle.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > 16384:
                return False
            doc = json.load(handle)
        if not isinstance(doc, dict) or set(doc) != {"version", "apps"} or type(doc["version"]) is not int or doc["version"] != 1 or not isinstance(doc["apps"], list):
            return False
        seen = set()
        for app in doc["apps"]:
            if not isinstance(app, dict) or set(app) != {"id", "version", "skills", "operations"} or not isinstance(app["id"], str):
                return False
            name = app["id"]
            if name in seen or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name):
                return False
            if name == "gold-stars":
                if app != {"id": name, **GOLD_STARS} and app != {"id": name, **GOLD_STARS_PREVIOUS}:
                    return False
            elif (not isinstance(app["version"], str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", app["version"])
                  or app["skills"] != [name] or app["operations"] != ["mini-app.read"]):
                return False
            # CP/server remains authoritative for the endpoint, exact tool and schema.
            # A projection cannot introduce an endpoint or an unreviewed write operation.
            seen.add(name)
        return any(app["id"] == app_id and operation in app["operations"] for app in doc["apps"])
    except Exception:
        return False


def approval_modules():
    # Hermes's documented plugin module names. Never import from model-controlled paths.
    ap = importlib.import_module("hermes_plugins.av_events._approval")
    backstop = importlib.import_module("hermes_plugins.av_approval")
    if not ap.configured() or backstop.switch() != "on" or backstop.current_codes():
        raise ValueError("approval_unavailable")
    return ap


def authorize_send(preview: object, draft_id: str):
    """Start a manual grant once; reconstruct its exact proof for same-draft recovery."""
    if not isinstance(preview, dict) or set(preview) != {"appId", "draftId", "attendeeId", "recipientName", "note", "visibility"} or not all(isinstance(v, str) for v in preview.values()) or preview["appId"] != "gold-stars" or preview["draftId"] != draft_id or preview["visibility"] not in ("named", "anonymous"):
        return None, {"error": "approval_preview_unavailable"}
    payload = {"appId": "gold-stars", "operation": "gold-stars.send", "preview": preview}
    # All leaf values are strings; sorted compact UTF-8 is JCS for this closed schema.
    held = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(held.encode("utf-8")).hexdigest()
    key = "marketplace.app.action:gold-stars.send:" + draft_id
    ap = approval_modules()
    answer = ap.propose("marketplace.app.action", key, "Send one Gold Star: " + preview["recipientName"], held)
    task = answer.doc.get("task")
    if not answer.ok or not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task) or answer.doc.get("payload_hash") != digest or answer.doc.get("decision") != "requested":
        return None, {"error": "approval_refused"}
    if answer.doc.get("state") == "executed":
        # The earlier start may have outlived an app timeout or a CP outage. Reuse
        # only this same daemon-bound proof; the app/CP revalidate manual grant,
        # current install binding and immutable draft before any idempotent effect.
        return {"taskId": task, "payloadHash": digest, "payload": payload}, None
    granted = ap.wait(task)
    if granted.exit_code != 0 or granted.status != "granted":
        return None, {"error": "approval_required", "instruction": "Approve the exact Gold Star in the approval app, then retry this same draftId. Chat consent alone cannot authorize sending."}
    started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return {"taskId": task, "payloadHash": digest, "payload": payload}, None
