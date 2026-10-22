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
# ROLODEX.PERSON (rc42, Carter's ruling, CLAIMS 7799): `rolodex.person` (a read of another resident's
# public profile: PUBLIC + VILLAGE card lines and social profile links; never contact details) rides
# the Gold Stars install like rolodex.search, appended LAST. The control-plane catalog's gold-stars entry
# moves to this exact list only AFTER boxes run this overlay (an older overlay refuses it).
GOLD_STARS = {"version": "1.1.0", "skills": ["gold-stars"], "operations": ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status", "rolodex.person"]}
# BRIDGE-RESTORE (rc41, Carter's ruling, CLAIMS L7212/L7216; ov#350): ov#300's native `rolodex.meeting`
# (owner-requested mark/undo) and `skylight.status` (the owner's own read). The CP catalog's current entry;
# still accepted, and rolodex.person stays refused (mini_app_not_installed) under it.
GOLD_STARS_RESTORED = {"version": "1.1.0", "skills": ["gold-stars"], "operations": ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel", "rolodex.meeting", "skylight.status"]}
# The entry before the restore (ov#343). Still accepted so this overlay can roll out before the CP
# catalog moves (one way only: overlay first, then the catalog); it carries no meeting, Skylight or
# person operation, so those stay refused under it.
GOLD_STARS_PREVIOUS = {"version": "1.1.0", "skills": ["gold-stars"], "operations": ["rolodex.search", "gold-stars.quota", "gold-stars.prepare", "gold-stars.send", "gold-stars.status", "gold-stars.cancel"]}
# Every gold-stars entry this overlay accepts, each by exact equality (newest first).
GOLD_STARS_ACCEPTED = (GOLD_STARS, GOLD_STARS_RESTORED, GOLD_STARS_PREVIOUS)
FORKICKS = {"version": "1.0.0", "skills": ["forkicks"], "operations": ["forkicks.menu", "forkicks.schedule", "forkicks.order.prepare", "forkicks.order.confirm", "forkicks.order.status", "forkicks.order.cancel"]}

# Every `village` operation, classified. A write changes the owner's account state; a read does not.
# `rolodex.meeting` (mark/undo) is a WRITE: it rides the `village` tool's existing gate entry (no preview
# step, CLAIMS L7216) and runs only while that gate is on and verified (gate_verified). `skylight.status`
# is a READ of the owner's own status. `rolodex.person` is a READ of one resident's public profile.
# Star sends also need their own daemon start (authorize_send, class SEND_CLASS).
# NEW-03 (rc44): `mini-app.context.read` is a READ of the app's own context namespace; `mini-app.context.write`
# is a WRITE into it and takes rolodex.meeting's path (gate_verified), never the Gold Stars send start.
# P-6 ZZZ-MINIAPP: zzz.bot's named reads and its two writes (public posts on zzz.bot as the owner's connected
# zzz agent). The writes take mini-app.context.write's path (gate_verified), never a manual grant.
ZZZ_READ_OPERATIONS = ("zzz.list_rooms", "zzz.read_thread", "zzz.changes")
ZZZ_WRITE_OPERATIONS = ("zzz.reply", "zzz.create_thread")
READ_OPERATIONS = frozenset({"rolodex.search", "rolodex.person", "gold-stars.quota", "gold-stars.status", "skylight.status", "mini-app.read",
                             "mini-app.context.read", "forkicks.menu", "forkicks.schedule", "forkicks.order.status", "slopfolio.status", *ZZZ_READ_OPERATIONS})
WRITE_OPERATIONS = frozenset({"rolodex.meeting", "gold-stars.prepare", "gold-stars.send", "gold-stars.cancel", "mini-app.context.write",
                              "forkicks.order.prepare", "forkicks.order.confirm", "forkicks.order.cancel", "slopfolio.prepare", *ZZZ_WRITE_OPERATIONS})
# Only generic reviewed app operations accept an appId from the caller.
APP_SCOPED_OPERATIONS = frozenset({"mini-app.read", "mini-app.context.read", "mini-app.context.write"})
# The zzzbot install, by exact equality: the CP catalog entry and install/install_miniapps.ts carry the same
# list in this order. Its operations name their app; a caller never supplies an appId for them.
ZZZBOT = {"version": "1.0.0", "skills": ["zzzbot"], "operations": [*ZZZ_READ_OPERATIONS, *ZZZ_WRITE_OPERATIONS]}
ZZZ_OPERATIONS = frozenset(ZZZBOT["operations"])
SLOPFOLIO = {"version": "1.0.0", "skills": ["slopfolio"], "operations": ["slopfolio.prepare", "slopfolio.status"]}
# NEW-03 (rc44, P-013; context's design NEW-03-APP-NAMESPACES.md section 2, CLAIMS L8997): every operations
# list this overlay accepts for a non-Gold-Stars app, each by exact equality (newest first): the reviewed
# public read alone, or the read plus that app's own context namespace read and write. Order fixed, no
# duplicates and no other operation (a planted op or a reordered list refuses the whole projection). The
# CP/app stay authoritative for the endpoint, the namespace and its quota.
APP_OPERATIONS_ACCEPTED = (("mini-app.read", "mini-app.context.read", "mini-app.context.write"), ("mini-app.read",))


# B-133 (Carter 18 Oct): a star send proposes this member class, not the parent marketplace.app.action.
# The shipped resident policy template carries it as autonomous (the resident's chat confirmation of the
# exact preview is the consent), while the parent stays manual for any other installed app. The daemon
# requires the propose key to start with "<class>:", so the key is derived from it (send_key).
SEND_CLASS = "marketplace.app.action.gold-stars.send"


def send_key(draft_id: str) -> str:
    return SEND_CLASS + ":" + draft_id


# HOT-01 (B-033): what the agent tells the owner when a send waits for the owner's tap. One wording
# for the daemon's "not granted yet" and the app's 403 star_approval_required (__init__.py). With the
# member row autonomous (the shipped template, B-133) the daemon answers "autonomous" and no card is
# shown; a policy that still says manual for the member class (an older box) keeps the card and this text.
APPROVE_IN_BOT = ("Ask the owner to approve this exact Gold Star on its card in the approvals bot, then retry "
                  "gold-stars.send with this SAME draftId. Never prepare a new preview to retry. Chat consent alone "
                  "cannot authorize sending.")
ORDER_APPROVE_IN_BOT = ("Ask the owner to approve this exact For Kicks order on its card in the approvals bot, then retry "
                        "forkicks.order.confirm with this SAME draftId. Never prepare another order to retry an uncertain confirm.")
# FK-ON-GRANT (CLAIMS L17710/L17711/L17726): the daemon's "not granted yet" when this box will place the order
# itself on the resident's tap (_forkicks_grant.py) and tell them in this chat. Product owns the quoted words.
ORDER_PLACED_ON_APPROVAL = ("The approval card for this exact For Kicks order is in the owner's approvals bot. Tell the owner: "
                            "\"I'll place it as soon as you approve.\" When they approve, it is placed automatically and they "
                            "get a message in this chat; never ask them to approve or confirm here, and never claim it was "
                            "placed before a receipt. If they ask later, retry forkicks.order.confirm with this SAME draftId; "
                            "never prepare another order.")


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
                if not any(app == {"id": name, **entry} for entry in GOLD_STARS_ACCEPTED):
                    return False
            elif name == "forkicks":
                if app != {"id": name, **FORKICKS}:
                    return False
            elif name == "zzzbot":
                if app != {"id": name, **ZZZBOT}:
                    return False
            elif name == "slopfolio":
                if app != {"id": name, **SLOPFOLIO}:
                    return False
            elif (not isinstance(app["version"], str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", app["version"])
                  or app["skills"] != [name] or not any(app["operations"] == list(ops) for ops in APP_OPERATIONS_ACCEPTED)):
                return False
            # CP/server remains authoritative for the endpoint, exact tool and schema.
            # A projection cannot introduce an endpoint or an unreviewed write operation.
            seen.add(name)
        return any(app["id"] == app_id and operation in app["operations"] for app in doc["apps"])
    except Exception:
        return False


def gate_verified() -> None:
    """A gated write never runs while the approval gate is off or unverified (no bypass of its entry)."""
    backstop = importlib.import_module("hermes_plugins.av_approval")
    if backstop.switch() != "on" or backstop.current_codes():
        raise ValueError("approval_unavailable")


def approval_modules():
    # Hermes's documented plugin module names. Never import from model-controlled paths.
    ap = importlib.import_module("hermes_plugins.av_events._approval")
    backstop = importlib.import_module("hermes_plugins.av_approval")
    if not ap.configured() or backstop.switch() != "on" or backstop.current_codes():
        raise ValueError("approval_unavailable")
    return ap


def authorize_send(preview: object, draft_id: str):
    """Start the send once (the policy's own start, or a manual grant); reconstruct its exact proof for same-draft recovery."""
    if not isinstance(preview, dict) or set(preview) != {"appId", "draftId", "attendeeId", "recipientName", "note", "visibility"} or not all(isinstance(v, str) for v in preview.values()) or preview["appId"] != "gold-stars" or preview["draftId"] != draft_id or preview["visibility"] not in ("named", "anonymous"):
        return None, {"error": "approval_preview_unavailable"}
    payload = {"appId": "gold-stars", "operation": "gold-stars.send", "preview": preview}
    # All leaf values are strings; sorted compact UTF-8 is JCS for this closed schema.
    held = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    digest = hashlib.sha256(held.encode("utf-8")).hexdigest()
    key = send_key(draft_id)
    ap = approval_modules()
    answer = ap.propose(SEND_CLASS, key, "Send one Gold Star: " + preview["recipientName"], held)
    task = answer.doc.get("task")
    decision = answer.doc.get("decision")
    # HOT-01 (B-032), B-133: "autonomous" = the attested policy's SEND_CLASS row (autonomous in the
    # shipped template) authorizes the send; core records the start as authorized by the policy, and
    # refuses that for a manual or human-only class. "requested" = a policy that still says manual for
    # the class (an older box) asks first, and a human grant is spent. Either way the daemon writes the
    # start (the audit record), and the control plane re-reads it from the daemon's own log before any
    # star is sent. "supervised" and anything else are refused.
    if not answer.ok or not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task) or answer.doc.get("payload_hash") != digest or decision not in ("requested", "autonomous"):
        return None, {"error": "approval_refused"}
    proof = {"taskId": task, "payloadHash": digest, "payload": payload}
    if answer.doc.get("state") == "executed":
        # The earlier start may have outlived an app timeout or a CP outage. Reuse
        # only this same daemon-bound proof; the app/CP revalidate the grant or the
        # policy start, current install binding and immutable draft before any idempotent effect.
        return proof, None
    if decision == "autonomous":
        if answer.doc.get("state") is not None:
            return None, {"error": "approval_refused"}
        started = ap.start(task, key, held)
        if not started.ok or started.doc.get("authorization") != "policy":
            return None, {"error": "approval_not_started"}
        return proof, None
    granted = ap.wait(task)
    if granted.exit_code != 0 or granted.status != "granted":
        return None, {"error": "approval_required", "instruction": APPROVE_IN_BOT}
    started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return proof, None
