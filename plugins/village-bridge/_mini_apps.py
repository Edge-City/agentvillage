"""Reviewed local availability and daemon authority; neither model arguments nor disk grant writes."""
from __future__ import annotations
import hashlib
import importlib
import json
import logging
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
# Edge City Volunteers: the owner's own volunteer reads, ECV's propose (a check: nothing changes, it returns a
# summary and a code) and its one write, eci-volunteers.confirm (makes the change the owner said yes to). The write takes
# zzz's path (gate_verified), never a manual grant: ECV's own propose/confirm is the owner's explicit yes.
ECV_READ_OPERATIONS = ("eci-volunteers.initialize", "eci-volunteers.guide", "eci-volunteers.my_hours", "eci-volunteers.my_shifts", "eci-volunteers.get_shift", "eci-volunteers.plan_view",
                       "eci-volunteers.open_shifts", "eci-volunteers.my_requests", "eci-volunteers.move_targets", "eci-volunteers.propose")
ECV_WRITE_OPERATIONS = ("eci-volunteers.confirm",)
READ_OPERATIONS = frozenset({"rolodex.search", "rolodex.person", "gold-stars.quota", "gold-stars.status", "skylight.status", "mini-app.read",
                             "mini-app.context.read", "forkicks.menu", "forkicks.schedule", "forkicks.order.status", "slopfolio.status", "zzz.pairs", *ZZZ_READ_OPERATIONS,
                             *ECV_READ_OPERATIONS})
WRITE_OPERATIONS = frozenset({"rolodex.meeting", "gold-stars.prepare", "gold-stars.send", "gold-stars.cancel", "mini-app.context.write",
                              "forkicks.order.prepare", "forkicks.order.confirm", "forkicks.order.cancel", "slopfolio.prepare", *ZZZ_WRITE_OPERATIONS,
                              *ECV_WRITE_OPERATIONS})
# Only generic reviewed app operations accept an appId from the caller.
APP_SCOPED_OPERATIONS = frozenset({"mini-app.read", "mini-app.context.read", "mini-app.context.write"})
# The zzzbot install, by exact equality: the CP catalog entry and install/install_miniapps.ts carry the same
# list in this order. Its operations name their app; a caller never supplies an appId for them.
ZZZBOT = {"version": "1.0.0", "skills": ["zzzbot"], "operations": [*ZZZ_READ_OPERATIONS, *ZZZ_WRITE_OPERATIONS]}
# zzz.pairs is an app-side feature-gated read which borrows the existing
# list_rooms install permission; it is deliberately absent from the CP catalog.
ZZZ_OPERATIONS = frozenset((*ZZZBOT["operations"], "zzz.pairs"))
# The eci-volunteers install, by exact equality (CP catalog entry and install/install_miniapps.ts, this order).
ECI_VOLUNTEERS = {"version": "1.0.0", "skills": ["eci-volunteers"], "operations": [*ECV_READ_OPERATIONS, *ECV_WRITE_OPERATIONS]}
ECV_OPERATIONS = frozenset(ECI_VOLUNTEERS["operations"])
SLOPFOLIO = {"version": "1.0.0", "skills": ["slopfolio"], "operations": ["slopfolio.prepare", "slopfolio.status"]}
# ov#441 S1 (lead RULING CLAIMS L16692, reaffirmed L16696): managed private-pair participation is gated ONLY by a
# separate cp catalog/allowlist entry, projected in `apps` beside zzzbot and granted per tenant at activation (the
# Mosaic restricted-entry pattern). Id `zzz-bridge`: cp and app validate app ids with ^[a-z0-9][a-z0-9-]{0,39}$,
# so the ruling's `zzz_bridge` is spelled with a hyphen (the app half, app#500, reads the same id). It carries no
# skill and no operation, so it grants no tool by itself; an entry of any other shape refuses the whole file.
ZZZ_BRIDGE_ID = "zzz-bridge"
ZZZ_BRIDGE = {"version": "1.0.0", "skills": [], "operations": []}
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
# FK-CARD-AT-PREPARE (CLAIMS L19913/L19916): the prepare answer carries it, since the bridge raises the card right
# after prepare. The daemon's propose answer has no delivery field (core gate.ts commandPropose: ok, task, action_key,
# class, payload_hash, decision, state, seq, idempotent), so the words never claim the card arrived (lead L19923).
ORDER_PLACED_ON_APPROVAL = ("The approval card for this exact For Kicks order was handed to the owner's approvals bot (its "
                            "delivery is not confirmed). Show the preview, then tell the owner: \"I've sent your approval card "
                            "to your approvals bot; tap Approve there and I'll place it. If no card arrives within a minute, "
                            "tell me and I'll check.\" When they approve, it is placed automatically and they get one message "
                            "in this chat; do not announce it again. Never ask for a yes in chat, and never say it was placed "
                            "before a receipt. To check, call forkicks.order.confirm with this SAME draftId (it never sends a "
                            "second card); never prepare another order.")
# FK-CARD-AT-PREPARE: the card could not be raised at prepare (refused, unavailable, or an error): the preview is
# still returned, and the agent says plainly that nothing was ordered.
ORDER_CARD_NOT_RAISED = ("The approval card for this order could not be raised, so nothing was ordered. Show the preview, "
                         "then tell the owner plainly: \"I couldn't send the approval card, so I haven't ordered anything.\" "
                         "Never say a card was sent or an order was placed.")
# The same honesty for a confirm whose approval check refused or could not run (nothing is sent to the café then).
ORDER_APPROVAL_REFUSED = ("The approval check refused this order, so nothing was ordered. Tell the owner plainly that it "
                          "was not placed; never say it was.")
ORDER_APPROVAL_UNAVAILABLE = ("The approval check could not run just now, so nothing was ordered by this request. Tell the "
                              "owner plainly that it is not placed; never say it was. Retry forkicks.order.confirm with this "
                              "SAME draftId later; never prepare another order.")
# S2 (review-a RA41, lead L20080): a confirm that reads this draft's card as declined, withdrawn, expired or void.
# No new card is raised for a draft (one card per draft), so the agent never points at a card that is gone.
ORDER_CARD_CLOSED = ("This draft's approval card was declined, withdrawn or expired, so nothing was ordered. Tell the "
                     "owner: \"Nothing was ordered. Ask me for a new preview.\" Do not retry this draft.")
# S1 (security review): the agent's confirm of a draft older than the newest saved one, or while that record is
# unreadable (fail closed). Nothing is started or sent.
ORDER_SUPERSEDED = ("This is an earlier preview that a newer one replaced, so nothing was ordered from it. Tell the owner: "
                    "\"Nothing was ordered from your earlier preview.\" Do not retry this draft.")
ORDER_NEWEST_UNREADABLE = ("I couldn't check that this is the newest preview, so nothing was ordered. Tell the owner: "
                           "\"Nothing was ordered. Ask me for a new preview.\" Do not retry this draft.")
# The receipt the on-grant pass recorded: the owner already got the placed line in this chat (one line per order).
ORDER_ALREADY_TOLD = ("This order is placed and the owner was already told so in this chat. Do not announce it again; "
                      "only give receipt details they ask for or still need, such as a payment link.")


# CARD-OV (Phase 1 item 6; CARD-COMMON amendment 14:00Z): a GENERIC app's entry may carry `approval: {prepare, card,
# fields: {item, total, when, shared}, bind: [[requestPath, previewPath], ...]}`: its one prepare op, its one needs-card
# op and that op's card declaration (cp#352). Absent for every reviewed app and every app without a card, so every
# projection today validates byte for byte as before. `{prepare, card}` without the declaration is accepted too, and
# the box then refuses the card op (`approval_card_undeclared`, never proposed). Such an entry lists exactly an accepted
# generic operations list (or none) followed by those two ops, in that order. The paths are checked when used.
CARD_ENTRY_KEYS = frozenset({"prepare", "card"})
CARD_DECLARED_KEYS = frozenset({"prepare", "card", "fields", "bind"})
CARD_FIELD_KEYS = frozenset({"item", "total", "when", "shared"})
CARD_OPERATION = re.compile(r"[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){1,3}")


def _card_entry_ok(app) -> bool:
    approval, name = app["approval"], app["id"]
    if not isinstance(approval, dict) or set(approval) not in (CARD_ENTRY_KEYS, CARD_DECLARED_KEYS):
        return False
    if "fields" in approval:
        fields, bind = approval["fields"], approval["bind"]
        if (not isinstance(fields, dict) or set(fields) != CARD_FIELD_KEYS or not all(isinstance(v, str) and 0 < len(v) <= 200 for v in fields.values())
                or not isinstance(bind, list) or len(bind) > 32
                or not all(isinstance(pair, list) and len(pair) == 2 and all(isinstance(p, str) and 0 < len(p) <= 200 for p in pair) for pair in bind)):
            return False
    prepare, card = approval["prepare"], approval["card"]
    if (not all(isinstance(op, str) and CARD_OPERATION.fullmatch(op) and op.split(".", 1)[0] == name for op in (prepare, card))
            or prepare == card):
        return False
    return any(app["operations"] == [*ops, prepare, card] for ops in (*APP_OPERATIONS_ACCEPTED, ()))


# RA42 ov S1 (lead L20281): a GENERIC entry (any id but the reviewed four) that fails its own check is refused PER APP:
# skipped and logged once (its id only), and every other app of the file stays installed, as the installer's checkApp
# refuses per app (ov#455). What stays WHOLE-FILE is the structure: the doc shape, version 1, an app that is not an
# object or has no string id, a duplicate id, and a reviewed id failing its exact equality (the tamper signal).
REVIEWED_ENTRIES = {"forkicks": (FORKICKS,), "zzzbot": (ZZZBOT,), ZZZ_BRIDGE_ID: (ZZZ_BRIDGE,), "eci-volunteers": (ECI_VOLUNTEERS,),
                    "slopfolio": (SLOPFOLIO,)}
LOGGED_ID = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
LOG = logging.getLogger("village_bridge")
_REFUSED_LOGGED = set()
REFUSED_LOG_MAX = 256


def _generic_entry_ok(app) -> bool:
    """A generic app's own check: id, version, skills == [id], and an accepted operations list, or a card entry
    (`_card_entry_ok`) when it carries `approval`. Any failure (or error) refuses this entry alone."""
    try:
        name = app["id"]
        if set(app) - {"approval"} != {"id", "version", "skills", "operations"} or not re.fullmatch(r"[a-z][a-z0-9-]{0,63}", name):
            return False
        if "approval" in app:
            return (isinstance(app["version"], str) and re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", app["version"]) is not None
                    and app["skills"] == [name] and _card_entry_ok(app))
        return not (not isinstance(app["version"], str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", app["version"])
                    or app["skills"] != [name] or not any(app["operations"] == list(ops) for ops in APP_OPERATIONS_ACCEPTED))
    except Exception:  # noqa: BLE001 - a malformed generic entry is refused alone
        return False


def _entry_refused(name: str) -> None:
    """One codes-only line per refused generic id per process: `mini_apps.entry_refused app=<id>`, nothing else."""
    shown = name if LOGGED_ID.fullmatch(name) else "invalid"
    if shown in _REFUSED_LOGGED or len(_REFUSED_LOGGED) >= REFUSED_LOG_MAX:
        return
    _REFUSED_LOGGED.add(shown)
    LOG.warning("village_bridge mini_apps.entry_refused app=%s", shown)


def projection(home: Path):
    """The installed apps of a valid projection (`mini-apps.json`), each checked as `installed` requires; a refused
    generic entry is left out (RA42 ov S1). None when the file itself is refused."""
    try:
        path = home / "mini-apps.json"
        if any(p.is_symlink() for p in (path, *path.parents)):
            return None
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as handle:
            st = os.fstat(handle.fileno())
            if not stat.S_ISREG(st.st_mode) or st.st_size > 16384:
                return None
            doc = json.load(handle)
        if not isinstance(doc, dict) or set(doc) != {"version", "apps"} or type(doc["version"]) is not int or doc["version"] != 1 or not isinstance(doc["apps"], list):
            return None
        seen, apps = set(), []
        for app in doc["apps"]:
            if not isinstance(app, dict) or not isinstance(app.get("id"), str):
                return None
            name = app["id"]
            if name in seen:
                return None
            seen.add(name)
            if name == "gold-stars":
                if not any(app == {"id": name, **entry} for entry in GOLD_STARS_ACCEPTED):
                    return None
            elif name in REVIEWED_ENTRIES:
                if not any(app == {"id": name, **entry} for entry in REVIEWED_ENTRIES[name]):
                    return None
            elif not _generic_entry_ok(app):
                _entry_refused(name)
                continue
            # CP/server remains authoritative for the endpoint, exact tool and schema.
            # A projection cannot introduce an endpoint or an unreviewed write operation.
            apps.append(app)
        return apps
    except Exception:
        return None


def installed(home: Path, app_id: str, operation: str) -> bool:
    apps = projection(home)
    return apps is not None and any(app["id"] == app_id and operation in app["operations"] for app in apps)


def zzz_participation(home: Path) -> bool:
    """Managed participation needs both exact reviewed entries in the current projection."""
    apps = projection(home)
    return (apps is not None and any(app["id"] == "zzzbot" for app in apps)
            and any(app["id"] == ZZZ_BRIDGE_ID for app in apps))


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
