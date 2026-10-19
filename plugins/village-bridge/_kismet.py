"""Kismet: native previews and the owner-turn boundary for its writes. The app server and Kismet are authority.

Kismet's writes carry no money and no daemon grant (purchases keep For Kicks' manual grant). The consent
boundary is the owner's own later message about an exact thing this plugin showed them:
- kismet.signup and kismet.delete stage locally first (no network): the plugin saves the exact sign-up
  answers (or the delete request) under a new draftId with the turn it was shown in, and returns the
  preview text the agent shows. Only a later owner message may send that draftId, and the plugin sends the
  saved answers, never model-supplied ones.
- kismet.decide answers one recommendation that kismet.status returned (server data, cached with the turn
  it was first shown in) and only in a later owner message.
Every write also takes the sibling writes' gate_verified() (__init__.py).
"""
from __future__ import annotations
import json
import os
import re
import stat
import time
import unicodedata
import uuid
from pathlib import Path

DRAFTS = "kismet-drafts"
SHOWN = "kismet-shown"
DRAFT_TTL_SECONDS = 3600
MAX_ANSWERS_BYTES = 8000
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
TELEGRAM = re.compile(r"[A-Za-z0-9_]{4,32}")

STATUS = ("single", "relationship", "married", "complicated", "undisclosed")
OPENNESS = ("mono", "poly", "open", "unsure", "undisclosed")
LOOKING_FOR = ("romance", "friends", "collaborators", "cofounder", "adventure", "vibes")
GENDER = ("man", "woman", "nonbinary")
INTERESTED_IN = ("men", "women", "everyone")
# The reviewed answer keys, in preview order. Kismet's /api/village/signup validates the same fields again.
ANSWER_KEYS = ("name", "status", "openness", "lookingFor", "gender", "interestedIn", "interests", "about",
               "agentProfile", "publicQuotes", "telegram", "ageConfirmed", "agreedToTerms")
REQUIRED = ("name", "lookingFor", "interests", "ageConfirmed", "agreedToTerms")
# Kismet's validation names a field by its own schema path; the agent fixes the answer it asked.
FIELD_NAMES = {"relStatus": "status", "bio": "about"}
REFUSED_FIELDS = frozenset(ANSWER_KEYS) | frozenset(FIELD_NAMES)


def _plain(value, cap, allow_newlines=False):
    """A bounded string with no control or format characters (newlines only where allowed)."""
    if not isinstance(value, str):
        return False
    text = value.strip()
    if not 1 <= len(text) <= cap:
        return False
    for ch in text:
        if ch == "\n" and allow_newlines:
            continue
        if unicodedata.category(ch) in ("Cc", "Cf", "Cs", "Co", "Cn", "Zl", "Zp"):
            return False
    return True


def checked_answers(answers):
    """The exact answers object to stage, or ValueError. Ids only (no labels), no unknown or empty fields."""
    if not isinstance(answers, dict) or set(answers) - set(ANSWER_KEYS) or set(REQUIRED) - set(answers):
        raise ValueError("invalid_kismet_answers")
    a = answers
    if a["ageConfirmed"] is not True or a["agreedToTerms"] is not True:
        raise ValueError("kismet_consent_required")
    if not _plain(a["name"], 40):
        raise ValueError("invalid_kismet_answers")
    looking = a["lookingFor"]
    if not isinstance(looking, list) or not 1 <= len(looking) <= 6 or len(set(map(str, looking))) != len(looking) or any(v not in LOOKING_FOR for v in looking):
        raise ValueError("invalid_kismet_answers")
    interests = a["interests"]
    if not isinstance(interests, list) or not 1 <= len(interests) <= 15 or not all(_plain(v, 30) for v in interests):
        raise ValueError("invalid_kismet_answers")
    for key, allowed in (("status", STATUS), ("openness", OPENNESS), ("gender", GENDER), ("interestedIn", INTERESTED_IN)):
        if key in a and a[key] not in allowed:
            raise ValueError("invalid_kismet_answers")
    # Gender and interested-in only ever accompany romance, exactly as Kismet keeps them.
    if ("gender" in a or "interestedIn" in a) and "romance" not in looking:
        raise ValueError("invalid_kismet_answers")
    if "about" in a and not _plain(a["about"], 160):
        raise ValueError("invalid_kismet_answers")
    if "agentProfile" in a and not _plain(a["agentProfile"], 1500, allow_newlines=True):
        raise ValueError("invalid_kismet_answers")
    if "publicQuotes" in a and type(a["publicQuotes"]) is not bool:
        raise ValueError("invalid_kismet_answers")
    if "telegram" in a and not (isinstance(a["telegram"], str) and TELEGRAM.fullmatch(a["telegram"])):
        raise ValueError("invalid_kismet_answers")
    exact = {key: (a[key].strip() if isinstance(a[key], str) else [v.strip() for v in a[key]] if key == "interests" else a[key])
             for key in ANSWER_KEYS if key in a}
    if len(canonical(exact).encode("utf-8")) > MAX_ANSWERS_BYTES:
        raise ValueError("invalid_kismet_answers")
    return exact


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def signup_preview(answers):
    """Every field exactly as it will be sent; private fields are labelled, unasked ones say so."""
    def show(key, label, private=False):
        tag = " (private, never shown to anyone)" if private else ""
        if key not in answers:
            return f"{label}{tag}: not given"
        value = answers[key]
        if isinstance(value, bool):
            value = "yes" if value else "no"
        elif isinstance(value, list):
            value = ", ".join(json.dumps(v, ensure_ascii=False) if key == "interests" else v for v in value)
        elif key in ("name", "about", "agentProfile", "telegram"):
            value = json.dumps(value, ensure_ascii=False)
        return f"{label}{tag}: {value}"
    lines = ["Kismet sign-up, exactly what will be sent:",
             show("name", "Name other residents see"),
             show("status", "Relationship status", True),
             show("openness", "Open to", True),
             show("lookingFor", "Looking for"),
             show("gender", "Gender", True),
             show("interestedIn", "Interested in", True),
             show("interests", "Interests"),
             show("about", "One line about you"),
             show("agentProfile", "Profile your agent dates with (other residents see only the one line)"),
             show("publicQuotes", "Quotes from your dates on the anonymous public board"),
             show("telegram", "Telegram username (shown only to matches; if not given, your paired Telegram is used)"),
             "18 or older: yes. Agrees to the Kismet Terms: yes."]
    return "\n".join(lines)


DELETE_PREVIEW = "Delete your Kismet account: your profile, recommendations, answers and matches are erased for good. Your matches can no longer reach you through Kismet."


def _path(home: Path, folder, name):
    if not isinstance(name, str) or not UUID.fullmatch(name):
        raise ValueError("invalid_kismet_id")
    path = home / folder / (name + ".json")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("kismet_preview_unavailable")
    return path


def _create(path: Path, record):
    """Write once (O_EXCL, 0600 in a 0700 folder); False when the file already exists."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        return False
    with os.fdopen(fd, "wb") as handle:
        handle.write(canonical(record).encode("utf-8"))
    return True


def _read(path: Path, config):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
            raise ValueError("kismet_preview_unavailable")
        record = json.load(handle)
    if not isinstance(record, dict) or record.get("owner") != config["ownerTelegramId"] or record.get("origin") != config["origin"]:
        raise ValueError("kismet_preview_unavailable")
    return record


def stage(home: Path, kind, answers, context, config):
    """Save an exact sign-up (or delete) under a new draftId; nothing leaves the box."""
    draft = str(uuid.uuid4())
    record = {"kind": kind, "owner": config["ownerTelegramId"], "origin": config["origin"],
              "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"], "at": int(time.time())}
    if kind == "signup":
        record["answers"] = answers
    _create(_path(home, DRAFTS, draft), record)
    return draft


def staged(home: Path, kind, draft, context, config):
    """The saved record, only for this owner's later message in the same conversation, before it expires."""
    record = _read(_path(home, DRAFTS, draft), config)
    if record.get("kind") != kind or (kind == "signup" and not isinstance(record.get("answers"), dict)):
        raise ValueError("kismet_preview_unavailable")
    if type(record.get("at")) is not int or not 0 <= time.time() - record["at"] <= DRAFT_TTL_SECONDS:
        raise ValueError("kismet_preview_expired")
    if record.get("session") != context["SESSION_KEY"] or record.get("message") == context["MESSAGE_ID"]:
        raise ValueError("kismet_confirmation_required")
    if kind == "signup":
        checked_answers(record["answers"])
    return record


def discard(home: Path, draft):
    try:
        path = _path(home, DRAFTS, draft)
        if path.is_file() and not path.is_symlink():
            path.unlink()
    except (OSError, ValueError):
        pass


def remember_shown(home: Path, recommendations, context, config):
    """Each recommendation the owner was shown, with the FIRST turn it was shown in (a re-read never moves it)."""
    for rec in recommendations:
        _create(_path(home, SHOWN, rec["dateId"]), {"name": rec["name"], "owner": config["ownerTelegramId"], "origin": config["origin"],
                                                     "session": context["SESSION_KEY"], "message": context["MESSAGE_ID"]})


def shown(home: Path, date_id, context, config):
    """The recommendation, only if kismet.status showed it in an earlier message of this conversation."""
    try:
        record = _read(_path(home, SHOWN, date_id), config)
    except (OSError, ValueError):
        raise ValueError("kismet_recommendation_not_shown")
    if record.get("session") != context["SESSION_KEY"] or record.get("message") == context["MESSAGE_ID"] or not isinstance(record.get("name"), str):
        raise ValueError("kismet_recommendation_not_shown")
    return record


def forget_all(home: Path):
    """After the account is deleted: remove every saved Kismet preview and shown recommendation (this plugin's files only)."""
    for folder in (DRAFTS, SHOWN):
        path = home / folder
        if path.is_symlink() or not path.is_dir():
            continue
        for item in path.iterdir():
            if re.fullmatch(r"[0-9a-f-]{36}\.json", item.name) and item.is_file() and not item.is_symlink():
                item.unlink()
        try:
            path.rmdir()
        except OSError:
            pass


def request_id(*parts):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps(["kismet", *parts])))


def _count(value, high=10000):
    return value if type(value) is int and 0 <= value <= high else None


def status_answer(result, prose, short_field, stamp):
    """Only the reviewed kismet.status shape reaches the model. No free text from Kismet is forwarded unchecked,
    contact-shaped text is dropped, and a Telegram handle appears only on a mutual match."""
    if not isinstance(result, dict) or type(result.get("signedUp")) is not bool:
        return {"error": "village_unavailable"}
    if not result["signedUp"]:
        return {"signedUp": False}
    out = {"signedUp": True}
    name = short_field(result.get("name"), 40)
    if name:
        out["name"] = name
    for key in ("datesLeftToday", "running", "recommendationCount"):
        if _count(result.get(key)) is not None:
            out[key] = result[key]
    recs = []
    for rec in (result.get("recommendations") if isinstance(result.get("recommendations"), list) else [])[:20]:
        if not isinstance(rec, dict) or not isinstance(rec.get("dateId"), str) or not UUID.fullmatch(rec["dateId"]):
            continue
        person = short_field(rec.get("name"), 40)
        if not person:
            continue  # a recommendation without a clean name cannot be shown, so it cannot be answered here
        kept = {"dateId": rec["dateId"], "name": person}
        for key, cap in (("summary", 160), ("reason", 400), ("suggestedMeetup", 200)):
            text = prose(rec.get(key), cap)
            if text:
                kept[key] = text
        if isinstance(rec.get("sharedInterests"), list):
            kept["sharedInterests"] = [t for t in (prose(v, 30) for v in rec["sharedInterests"][:15]) if t]
        recs.append(kept)
    out["recommendations"] = recs
    matches = []
    for match in (result.get("matches") if isinstance(result.get("matches"), list) else [])[:30]:
        if not isinstance(match, dict) or not isinstance(match.get("telegram"), str) or not TELEGRAM.fullmatch(match["telegram"]):
            continue
        person = short_field(match.get("name"), 40)
        if not person:
            continue
        kept = {"name": person, "telegram": match["telegram"], "link": "https://t.me/" + match["telegram"]}
        if stamp(match.get("matchedAt")):
            kept["matchedAt"] = match["matchedAt"]
        matches.append(kept)
    out["matches"] = matches
    return out


def decide_answer(result, name, short_field):
    if not isinstance(result, dict) or result.get("decision") not in ("yes", "no") or type(result.get("match")) is not bool:
        return {"error": "village_unavailable"}
    out = {"recommendation": name, "decision": result["decision"], "match": result["match"]}
    other = result.get("matchWith")
    if result["match"] and result["decision"] == "yes" and isinstance(other, dict) and isinstance(other.get("telegram"), str) and TELEGRAM.fullmatch(other["telegram"]):
        out["matchWith"] = {"name": short_field(other.get("name"), 40) or name, "telegram": other["telegram"], "link": "https://t.me/" + other["telegram"]}
    return out


def invalid_answers_field(detail):
    """The one answer Kismet refused, by name only (its message text is not forwarded)."""
    if not isinstance(detail, str) or len(detail) > 300:
        return None
    match = re.match(r"([A-Za-z]+)(?:\.\d+)?:", detail)
    if not match or match.group(1) not in REFUSED_FIELDS:
        return None
    return FIELD_NAMES.get(match.group(1), match.group(1))
