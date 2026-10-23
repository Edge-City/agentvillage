"""Persist server previews, not model-supplied purchase proofs. The app/CP are authority."""
from __future__ import annotations
import hashlib
import json
import os
import re
import stat
import time
import unicodedata
from datetime import datetime
from pathlib import Path
from ._mini_apps import approval_modules, ORDER_APPROVE_IN_BOT, ORDER_CARD_CLOSED, ORDER_SUPERSEDED, ORDER_NEWEST_UNREADABLE

MAX_PAYLOAD_BYTES = 60000
SUMMARY_MAX_BYTES = 4096
# Telegram technical cards reserve the rest of a 3600-character segment for labels.
SUMMARY_HTML_MAX_BYTES = 3000

# The For Kicks flat order card (Carter P0, 21 Oct; product L17668 (a), nonav L17696/L17701, approval L17700/L17702).
# The APP builds the approval payload at prepare and hashes it (agentvillage-app forkicks.ts); the box never builds
# it. Two shapes are accepted, so the box can ship before the app switches (nonav's ordering trap L17692):
#   LEGACY_KEYS: {appId, operation, preview} (today's shape);
#   CARD_KEYS:   exactly {order, total, pickup, name}, the strings the minimal card quotes. The app returns the
#                order's `preview` BESIDE the payload in its prepare answer; the box saves it in the per-draftId record
#                and re-derives the four strings from it (card_fields), refusing any difference.
# Both shapes are proposed under the same class and per-draftId key as before (approval L17713: no class change in the
# v2.1.10 hotfix). Spec + golden vectors: tests/vectors/forkicks-approval-card.{md,json}.
APPROVAL_CLASS = "marketplace.app.action"
# A card core will never grant again (wait exit 1 rejected/revoked/withdrawn/not-registered, 3 expired, 7 void).
CARD_CLOSED_STATES = frozenset({"rejected", "revoked", "withdrawn", "not-registered", "expired", "void"})
# The card refusals the prepare path answers by preparing once more in the legacy shape (__init__.py, lead L17847).
CARD_FALLBACK_ERRORS = frozenset({"approval_card_invalid", "approval_card_not_minimal", "approval_card_too_long"})
LEGACY_KEYS = frozenset({"appId", "operation", "preview"})
CARD_KEYS = frozenset({"order", "total", "pickup", "name"})
PREVIEW_KEYS = frozenset({"appId", "draftId", "quote", "displayName", "items", "fulfilment", "paymentMethod"})
# approval-md 0.4.7 telegram-minimal: a quoted value is cut past MINIMAL_QUOTE_MAX (280) code points, two of which are
# the runtime's own isolate marks, and some characters are drawn as «U+XXXX» marks (which count). A card value must be
# shown whole and unmarked, so a value longer than this, or failing card_value_fits, is not a minimal card: the app
# sends the legacy shape instead (the technical card, every line, never cut).
CARD_VALUE_MAX = 278
CARD_VALUE_REFUSED = frozenset("\u00ab\u23ce\u115f\u1160\u3164\uffa0\u2800")  # « ⏎, Hangul fillers, braille blank
# Combining marks core draws as themselves (at most CARD_MARKS_MAX in a row), minus the default-ignorable ones it marks.
CARD_MARKS_MAX = 2
CARD_MARKS_REFUSED = frozenset([0x034F, 0x17B4, 0x17B5, *range(0x180B, 0x1810), *range(0xFE00, 0xFE10), *range(0xE0100, 0xE01F0)])
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
# Product owns these words (product-confirm, L17668): how the payment method reads after the total.
PAYMENT_WORDS = {"upi": "pay by UPI", "card_on_pickup": "card at pickup"}

def approval_summary(payload):
    """Mirrored by CP forkicksSummary; never shorten the order the human approves."""
    def text(value, allow_empty=False):
        if not isinstance(value, str) or (not allow_empty and not value.strip()) or any(unicodedata.category(c) in {"Cc", "Cf", "Cs", "Zl", "Zp"} for c in value):
            raise ValueError("approval_card_invalid")
        return json.dumps(value, ensure_ascii=False)

    def money(value):
        if type(value) is not int or not 0 <= value <= 1000000000:
            raise ValueError("approval_card_invalid")
        return str(value)

    try:
        p = payload["preview"]
        quote, fulfilment = p["quote"], p["fulfilment"]
        lines, items = quote["lines"], p["items"]
        if not isinstance(lines, list) or not lines or len(lines) != len(items):
            raise ValueError("approval_card_invalid")
        card = ["For Kicks order"]
        for line, item in zip(lines, items):
            qty = line["qty"]
            if type(qty) is not int or not 1 <= qty <= 1000000000 or qty != item["qty"] or not isinstance(line["options"], list):
                raise ValueError("approval_card_invalid")
            options = ", ".join(text(option) for option in line["options"]) or "none"
            card.append(f'{qty} × {text(line["name"])}; options: {options}; unit ₹{money(line["unitInr"])}; line ₹{money(line["lineInr"])}')
        card.append("Total: ₹" + money(quote["totalInr"]))
        kind = fulfilment["type"]
        if kind not in ("pickup", "delivery"):
            raise ValueError("approval_card_invalid")
        location = quote["location"]
        card.append("Fulfilment: " + kind)
        card.append(f'Location: {text(location["name"])} ({text(fulfilment["locationId"])}); address: {text(location["address"])}')
        date = fulfilment.get("date") or location["opens"][:10]
        if not isinstance(date, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date, flags=re.ASCII):
            raise ValueError("approval_card_invalid")
        card.append("Date (IST): " + date)
        if kind == "delivery":
            card.append("Delivery address: " + text(fulfilment["deliveryAddress"]))
        method = p["paymentMethod"]
        if method not in ("upi", "card_on_pickup"):
            raise ValueError("approval_card_invalid")
        card.append("Payment: " + ("UPI" if method == "upi" else "Card at pickup (honor system)") + "; if simulated: Test payment, no money moved")
        card.append("Café display name: " + text(p["displayName"]))
        if "note" in p:
            card.append("Note: " + text(p["note"], allow_empty=True))
        summary = "\n".join(card)
        escaped = summary.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        if len(summary.encode("utf-8")) > SUMMARY_MAX_BYTES or len(escaped.encode("utf-8")) > SUMMARY_HTML_MAX_BYTES:
            raise ValueError("approval_card_too_long")
        return summary
    except (KeyError, TypeError, IndexError, AttributeError) as error:
        raise ValueError("approval_card_invalid") from error

def canonical(payload):
    return json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)

def card_value_fits(value, lines=False):
    """Whether core 0.4.7's minimal card draws `value` whole and unmarked (see CARD_VALUE_MAX): only U+0020 spaces,
    letters, numbers, punctuation and symbols (minus CARD_VALUE_REFUSED), and combining marks (minus the
    default-ignorable ones) at most CARD_MARKS_MAX in a row. With `lines` (the Order row) a U+000A between items is
    allowed; core draws it as " ⏎ " (MINIMAL_NEWLINE_MARK), three code points, and counts them."""
    if not isinstance(value, str) or not 0 < len(value) + (2 * value.count("\n") if lines else 0) <= CARD_VALUE_MAX:
        return False
    run = 0
    for c in value:
        if lines and c == "\n":
            run = 0
            continue
        kind = unicodedata.category(c)[0]
        if kind == "M" and ord(c) not in CARD_MARKS_REFUSED:
            run += 1
            if run > CARD_MARKS_MAX:
                return False
            continue
        run = 0
        if c != " " and (kind not in "LNPS" or c in CARD_VALUE_REFUSED):
            return False
    return True

# What the flat card shows is what the order sends (security review, WYSIWYS). Every preview field is SHOWN on the four
# rows, BOUND to a shown one, or the flat card is refused (approval_card_invalid) and the app sends the legacy shape,
# whose technical card shows everything:
#   appId                 constant "forkicks" (checked);
#   draftId               the per-draftId approval key and record (bound);
#   displayName           shown (name);
#   paymentMethod         shown (total);
#   quote.lines           name, qty, options shown (order); unitInr/lineInr are the merchant's prices summed in the shown
#                         total; itemId/optionIds must equal items[i] (bound);
#   quote.totalInr        shown (total); quote.location.name shown (pickup); the rest of the quote is the merchant's own
#                         answer for this quoteId, not text the agent sends;
#   items[i]              exactly {itemId, optionIds, qty}, equal to quote.lines[i] (bound);
#   fulfilment            exactly type (shown), locationId (equal to the quote's location id when it names one), date
#                         (shown), deliveryAddress (shown; only for delivery);
#   note                  text the agent writes to the café: NOT on the card. KNOWN GAP accepted by Carter (lead L17772,
#                         21 Oct: "it's fine for now if there is a note the agent sends without the resident seeing it").
FULFILMENT_KEYS = frozenset({"type", "locationId", "date", "deliveryAddress"})
# No phantom lines (product + lead L17778): the Order row puts ONE item per line, joined with U+000A, so a separator
# inside a name cannot fake a line, and no text may hold a line break of its own: control/format characters (Cc, Cf,
# incl. U+000A/U+000D and bidi controls; also Cs, Zl, Zp: U+2028/U+2029) in any order text are refused by
# approval_summary (approval_card_invalid; no shape carries them, as today) and core's marked characters by
# card_value_fits. A pickup location's name must not start like the delivery form: NFKC, runs of U+0020 collapsed to
# one, leading U+0020 dropped, ASCII A-Z lowercased, then no "delivery to" prefix (approval_card_not_minimal).
CARD_DELIVERY_PREFIX = "delivery to"
# Security review fold: free text must not fake the Pickup row's " · <date>" part or the Order row's " ⏎ " line mark.
# After NFKC, a pickup place or delivery address holding U+00B7, or an item/option name holding U+23CE or a character
# of the arrow and control-picture blocks below, gets approval_card_not_minimal (the app sends the legacy shape).
# Second fold: the middle-dot and bullet lookalikes that survive NFKC (U+2022 U+2027 U+2219 U+22C5 U+30FB; U+FF65
# normalises to U+30FB), and the Dingbat arrows U+2794-U+27BF and Supplemental Arrows-C U+1F800-U+1F8FF.
CARD_PLACE_REFUSED = frozenset("\u00b7\u16eb\u2022\u2024\u2027\u2219\u22c5\u2e31\u30fb")
CARD_LINE_MARK_BLOCKS = ((0x23CE, 0x23CE), (0x2190, 0x21FF), (0x2400, 0x243F), (0x2794, 0x27BF), (0x27F0, 0x27FF), (0x2900, 0x297F), (0x2B00, 0x2BFF), (0x1F800, 0x1F8FF))

def card_place_fakes_date(text):
    return any(c in CARD_PLACE_REFUSED for c in unicodedata.normalize("NFKC", text))

def card_name_fakes_line(text):
    return any(lo <= ord(c) <= hi for c in unicodedata.normalize("NFKC", text) for lo, hi in CARD_LINE_MARK_BLOCKS)

def card_place_like_delivery(text):
    """Whether a pickup location's name starts like the delivery form (see above)."""
    collapsed = re.sub(" +", " ", unicodedata.normalize("NFKC", text)).lstrip(" ")
    return "".join(chr(ord(c) + 32) if "A" <= c <= "Z" else c for c in collapsed).startswith(CARD_DELIVERY_PREFIX)

def _card_unshown(preview):
    """Why the flat card would not show everything this order sends, or None."""
    quote, fulfilment = preview["quote"], preview["fulfilment"]
    if not isinstance(fulfilment, dict) or not set(fulfilment) <= FULFILMENT_KEYS or (fulfilment["type"] != "delivery" and "deliveryAddress" in fulfilment):
        return "fulfilment"
    location = quote["location"]
    if fulfilment.get("locationId") != location.get("id", fulfilment.get("locationId")) or fulfilment.get("locationId") != quote.get("locationId", fulfilment.get("locationId")):
        return "location"
    for item, line in zip(preview["items"], quote["lines"]):
        if not isinstance(item, dict) or set(item) != {"itemId", "optionIds", "qty"} or line.get("itemId") != item["itemId"] or line.get("optionIds") != item["optionIds"]:
            return "items"
    return None

def card_fields(preview):
    """The four strings of the flat order card, from the app's saved order preview. Mirrored byte for byte by the app
    (prepare + confirm) and the CP forkicksSummary mirror; spec + golden vectors in tests/vectors/."""
    approval_summary({"preview": preview})  # every check the technical card makes, first
    try:
        if _card_unshown(preview) is not None:
            raise ValueError("approval_card_invalid")
        quote, fulfilment = preview["quote"], preview["fulfilment"]
        lines = []
        for line in quote["lines"]:
            options = ", ".join(line["options"])
            lines.append(f'{line["qty"]} × {line["name"]}' + (f" ({options})" if options else ""))
        date = fulfilment.get("date") or quote["location"]["opens"][:10]
        year, month, day = (int(part) for part in date.split("-"))
        if not 1 <= month <= 12 or not 1 <= day <= 31:
            raise ValueError("approval_card_invalid")
        when = f"{day} {MONTHS[month - 1]} {year}"
        where = quote["location"]["name"] if fulfilment["type"] == "pickup" else "Delivery to " + fulfilment["deliveryAddress"]
        fields = {"order": "\n".join(lines), "total": f'₹{quote["totalInr"]}, {PAYMENT_WORDS[preview["paymentMethod"]]}',
                  "pickup": f"{where} · {when}", "name": preview["displayName"]}
        place = quote["location"]["name"] if fulfilment["type"] == "pickup" else fulfilment["deliveryAddress"]
        names = [line["name"] for line in quote["lines"]] + [o for line in quote["lines"] for o in line["options"]]
        # review-b ov#446 S1: a delivery address is the agent's free text (app forkicks-schema.ts:14), so today only a
        # PICKUP order gets the flat card; a delivery order keeps the technical card (an address allowlist: v2.1.12).
        if fulfilment["type"] != "pickup" or card_place_like_delivery(place) or card_place_fakes_date(place) or \
                any(card_name_fakes_line(name) for name in names):
            raise ValueError("approval_card_not_minimal")
    except (KeyError, TypeError, IndexError, AttributeError) as error:
        raise ValueError("approval_card_invalid") from error
    if not all(card_value_fits(value, lines=key == "order") for key, value in fields.items()):
        raise ValueError("approval_card_not_minimal")
    return fields

def is_flat(payload):
    """The flat card's shape: exactly the four rows."""
    return isinstance(payload, dict) and set(payload) == CARD_KEYS

def _checked_preview(preview, draft_id):
    if not isinstance(preview, dict) or set(preview) not in (PREVIEW_KEYS, PREVIEW_KEYS | {"note"}) or preview["appId"] != "forkicks" or preview["draftId"] != draft_id:
        raise ValueError("approval_preview_unavailable")
    return preview

def checked_payload(payload, draft_id, expected_hash, preview=None):
    """The app's payload, checked; `preview` is the order the app returned beside a CARD_KEYS payload."""
    if is_flat(payload):
        if card_fields(_checked_preview(preview, draft_id)) != payload:
            raise ValueError("approval_card_invalid")
    elif isinstance(payload, dict) and set(payload) == LEGACY_KEYS and payload["appId"] == "forkicks" and payload["operation"] == "forkicks.order.confirm":
        _checked_preview(payload["preview"], draft_id)
    else:
        raise ValueError("approval_preview_unavailable")
    held = canonical(payload)
    if len(held.encode("utf-8")) > MAX_PAYLOAD_BYTES or hashlib.sha256(held.encode("utf-8")).hexdigest() != expected_hash:
        raise ValueError("approval_preview_unavailable")
    return held

def order_preview(record):
    """The saved order behind a record: inside a legacy payload, beside a flat one."""
    payload = record["payload"]
    return record["preview"] if is_flat(payload) else payload["preview"]

def cache_path(home: Path, draft_id):
    if not isinstance(draft_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", draft_id):
        raise ValueError("invalid_draft")
    folder = home / "forkicks-drafts"
    path = folder / (draft_id + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("approval_preview_unavailable")
    return path

def save_preview(home, result, context, config):
    if not isinstance(result, dict) or result.get("error") or not result.get("draftId"):
        return  # A refused quote has no draft and cannot be confirmed.
    payload = result.get("approvalPayload")
    flat = is_flat(payload)
    # The order behind a flat payload is the app's own `preview` beside it in this prepare answer (never the agent's).
    held = checked_payload(payload, result["draftId"], result.get("payloadHash"), result.get("preview") if flat else None)
    path = cache_path(home, result["draftId"])
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    record = {"payload": json.loads(held), "payloadHash": result["payloadHash"], "owner": config["ownerTelegramId"],
              "origin": config["origin"], "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"],
              **({"preview": result["preview"]} if flat else {})}
    data = canonical(record).encode("utf-8")
    # O_EXCL keeps the first immutable preview/turn across retries; a prepare replay cannot move its consent boundary.
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        previous = load_preview(home, result["draftId"], config)
        if previous["payloadHash"] != result["payloadHash"]:
            raise ValueError("approval_preview_unavailable")
        return
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)

def load_preview(home, draft_id, config):
    path = cache_path(home, draft_id)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
            raise ValueError("approval_preview_unavailable")
        record = json.load(handle)
    if record.get("owner") != config["ownerTelegramId"] or record.get("origin") != config["origin"]:
        raise ValueError("approval_preview_unavailable")
    checked_payload(record.get("payload"), draft_id, record.get("payloadHash"), record.get("preview"))
    return record

def quote_expires(record):
    """The saved quote's `expiresAt` as a timestamp, or None (missing, unreadable, or without a zone)."""
    try:
        moment = datetime.fromisoformat(order_preview(record)["quote"]["expiresAt"])
    except (KeyError, TypeError, ValueError):
        return None
    return moment.timestamp() if moment.tzinfo else None

def _quote_gone(record, now):
    """Past a known `expiresAt` (no start or first confirm after it). An unknown one is left to the app."""
    expires = quote_expires(record)
    return expires is not None and float(now if now is not None else time.time()) >= expires

def _adopted(proof, guard_adopt):
    """An already-started draft's proof, unless its start was refused after the fact (a `.refused` tombstone, read
    fail-closed under the drafts lock: security review of 5a984408). Every adoption is a started draft, so the
    newest-draft rule's in-flight exception applies to it exactly when no tombstone exists."""
    if guard_adopt is not None:
        reason = guard_adopt()
        if reason is not None:
            return None, {"error": "approval_card_closed", "instruction": ORDER_SUPERSEDED}
    return proof, None


def authorize_order(record, draft_id, on_requested=None, known_task=None, on_proposed=None, guard_start=None,
                    guard_adopt=None, on_quote_expired=None, now=None):
    """The human grant for this exact saved order, or a refusal. Never places anything itself.

    FK-CARD-AT-PREPARE (approval L19920 (2), one live card per draft): `known_task` is the task this box already
    proposed for this draft (`_forkicks_grant.card_task`). With it, the daemon is NOT asked again: the task is only
    read (`wait --timeout 0`), so a looping confirm can never re-file a card (core re-asks a withdrawn or expired
    request on a repeated propose). Without it, the one propose runs and `on_proposed(task)` records it, only after
    the daemon answered `requested` for these exact bytes.

    Quote expiry (lead L20310, approval L20313): with `on_quote_expired`, a confirm past the quote's `expiresAt` that
    would propose, wait for a tap or start answers ORDER_CARD_CLOSED and calls `on_quote_expired(task or None)`
    (`_forkicks_grant.close_expired`: tombstone + withdraw), never "tap Approve" for a quote that is gone. A spent
    grant (an order in flight) is still adopted: the app answers its idempotency key. That includes a start the close
    itself finds (its own read under the drafts lock, approval L20892): `on_quote_expired` answers False, nothing is
    closed, and the start is adopted."""
    payload = record["payload"]
    held = checked_payload(payload, draft_id, record["payloadHash"], record.get("preview"))
    key = APPROVAL_CLASS + ":forkicks.order.confirm:" + draft_id
    try:
        summary = approval_summary({"preview": order_preview(record)})
    except ValueError as error:
        return None, {"error": str(error)}
    ap = approval_modules()
    proof = {"taskId": None, "payloadHash": record["payloadHash"], "payload": payload}
    if known_task is None:
        if on_quote_expired is not None and _quote_gone(record, now):
            on_quote_expired(None)  # no card is raised for a quote that is gone
            return None, {"error": "approval_card_closed", "instruction": ORDER_CARD_CLOSED}
        # The app's payload, byte for byte (its confirm compares it with the stored one): the box only checks it.
        answer = ap.propose(APPROVAL_CLASS, key, summary, held)
        task = answer.doc.get("task")
        # Purchases ALWAYS require a human grant, even when Gold Stars uses autonomous policy.
        if not answer.ok or not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task) or answer.doc.get("payload_hash") != record["payloadHash"] or answer.doc.get("decision") != "requested":
            return None, {"error": "approval_refused"}
        if on_proposed is not None:
            on_proposed(task)
        proof["taskId"] = task
        if answer.doc.get("state") == "executed":
            return _adopted(proof, guard_adopt)  # The CP re-reads the direct grant/start; same draft is merchant-idempotent.
    else:
        task = known_task
        if not isinstance(task, str) or not re.fullmatch(r"propose:[a-f0-9]{32}", task):
            return None, {"error": "approval_refused"}
        proof["taskId"] = task
    granted = ap.wait(task)
    if known_task is not None and granted.exit_code == 0 and granted.status in ("nothing-to-wait-for", "executed"):
        # Already started (an earlier confirm, or the on-grant pass): adopt it, as the propose answer's `executed`
        # path does, only when this draft's own action reads granted (a human's decision; the pass's same check).
        mine = [a for a in (granted.doc.get("actions") or []) if isinstance(a, dict) and a.get("action_key") == key]
        if len(mine) == 1 and mine[0].get("state") == "granted":
            return _adopted(proof, guard_adopt)
    if granted.exit_code in (1, 3, 7) or granted.status in CARD_CLOSED_STATES:
        # S2: the card is declined, withdrawn, expired or void (core: wait exit 1/3/7). No start runs, and this draft
        # gets no second card: nothing was ordered, and only a new preview can be approved.
        return None, {"error": "approval_card_closed", "instruction": ORDER_CARD_CLOSED}
    if on_quote_expired is not None and _quote_gone(record, now):
        # Quote expiry: neither a tap nor a start can place this draft any more; its card is withdrawn.
        if on_quote_expired(task) is False:
            # FK-N6 (approval L20892): the close read the wait again under the drafts lock and found it spent (the
            # on-grant pass's start landed after this wait): an order in flight, never "nothing was ordered". It is
            # adopted like any spent grant; the app answers its idempotency key, and the merchant refuses a new create
            # past the quote (forkicks lib/orders.ts:33-44).
            return _adopted(proof, guard_adopt)
        return None, {"error": "approval_card_closed", "instruction": ORDER_CARD_CLOSED}
    if granted.exit_code != 0 or granted.status != "granted":
        # FK-ON-GRANT: a card still waiting for its tap (wait exit 6) is handed to the on-grant pass
        # (_forkicks_grant.track), which places the order on the resident's grant; it returns the instruction.
        tracked = on_requested(task) if on_requested is not None and granted.exit_code == 6 else None
        return None, {"error": "approval_required", "instruction": tracked or ORDER_APPROVE_IN_BOT}
    if guard_start is not None:
        # S1 + security review: the newest-draft check (fail closed, under the drafts lock) right before the start.
        # An already-started draft (the adoption paths above) is an order in flight and keeps its confirm.
        reason, started = guard_start(lambda: ap.start(task, key, held))
        if reason is not None:
            # An `expired` tombstone (quote expiry) reads as the closed card, not as a newer preview.
            return None, {"error": "approval_card_closed", "instruction": ORDER_NEWEST_UNREADABLE if reason == "latest_unreadable"
                          else ORDER_CARD_CLOSED if reason == "expired" else ORDER_SUPERSEDED}
    else:
        started = ap.start(task, key, held)
    if not started.ok or started.doc.get("authorization") != "grant":
        return None, {"error": "approval_not_started"}
    return proof, None
