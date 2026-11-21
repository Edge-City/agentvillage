"""av-rate: the suggestion rating cards (data docs/design/suggestion-rating.md).

Replaces the evening outcome ask's text question ("Did you and <name> meet? Reply met, not
useful, or missed.", overlay #198) with two Telegram button cards about the suggestion itself,
sent by the resident's own bot and answered with a tap:

  Card 1  "How good a match was this suggestion from <agentName>?"  five emoji buttons 😕 😐 🙂 😊 🤩
          for 1..5 (labels in the body: Not a fit / Weak fit / OK fit / Good fit / Great fit, scale
          ``match_fit_5_v1``), a privacy line and the manage line.
  Card 2  "Could you imagine collaborating with this person 🤝?"  [Yes] [No] / [Not sure yet] (scale
          ``collab_interest_v1``), sent after card 1's first tap, whatever the rating.

The earlier card 2, "Did you already plan this meetup?" (``avr:p:``), is no longer sent; a tap on
one still open from an older release is recorded as before (``opportunity.pre_planned``).

**Who decides what to ask.** The evening trigger (``skills/index-network/scripts/rating-cards.ts``
through ``proactive.ts``) picks the accepted connections to ask about and writes one stage file per
subject into ``av-events/proactive/rating/`` (0600, this user; the cleaned name and headline are the
only text, and they never reach an event). This plugin sends the cards from those files, records
the taps, hands the events to av-events, and tells the agent.

**Wiring** (Hermes v2026.9.24, the av-vote precedent). ``ctx.register_platform_handler("telegram",
factory)``: the Telegram adapter's ``connect()`` calls the factory with the PTB ``Application`` and
the adapter before its own handlers, so a ``CallbackQueryHandler`` scoped to ``^avr:`` sees every
``avr:`` tap and nothing else; registered ``block=False`` (Hermes's Application processes one update
at a time). The same factory starts the pick-up: PTB's job queue every ``PICKUP_INTERVAL_S`` when the
``job-queue`` extra is installed, else an asyncio task on the gateway loop. The pick-up sends the
staged cards and injects the lines that are due.

**The resident's controls** (wave 1). The cards go out under the installer's "Edge — evening
questions" job and its manage line (on card 1). Before a send the pick-up checks, exactly as the trigger does:
the job is not stopped (Hermes's job record ``cron/jobs.json``: a job named as the evening job
whose id ``av-events/installed_jobs.json`` lists, ``enabled`` false, ``state`` ``paused`` or a
``paused_at`` means stopped; message-labels.ts ``storedJobEnabled``), this is not a team tenant
(``AV_TEAM_TENANT`` exactly ``1``; a team tenant's stages are dropped), and it is not quiet hours:
the resident's evening window from ``av-events/job-settings.json`` (``jobs.evening.window``
``HH:MM-HH:MM`` and ``tz``, job-settings.ts grammar) or, with none, 08:00 to 22:00 village time
(``Asia/Kolkata``). A stopped job, quiet hours, an unreadable job store or invalid settings DEFER
the stage to the next pick-up, never drop it; a stage older than ``STAGE_MAX_AGE_S`` (3 days) is
dropped and counted.

**callback_data** (under Telegram's 64 bytes): ``avr:f:<1-5>:<nonce>`` for card 1 and
``avr:c:<y|n|u>:<nonce>`` for card 2 (``avr:p:<y|n>:<nonce>`` for the retired planned card). ``<nonce>`` is the first 22 base64url characters of
HMAC-SHA256(key, "avr|<opportunity_id>|match_fit_5_v1") under the tenant's av-events key
(``av-events/hash.key``; this plugin's own ``av-events/av-rate.key`` when av-events has made none
yet). The ledger maps a nonce back to its opportunity; a nonce not on file answers "no longer
valid". The nonce is routing only: the owner check and the message binding authorise a tap.

**A tap**: owner only (the box's own resident, in their private chat with the bot: the home
channel's ids, ``TELEGRAM_HOME_CHANNEL``, or Hermes's approved pairings, exactly av-vote's rule),
on a message the ledger knows (the tap's chat is the card's ``chat_id`` and its message id is
card 1's or card 2's, or a retired planned card's); each card inside its own 24 h window after it went out, else "This question has closed." and no event; a re-tap
with another value is a revision (``revision`` 1, 2, ...; last wins downstream), the same value
again is answered "Already recorded" and records nothing. Answers the tap with "Recorded: <label>",
marks the chosen button, sends card 2 after card 1's first tap, and hands the event over. Double
taps on one card while the first is being recorded are answered "Still recording..." and do
nothing.

**Concurrency.** The pick-up and the taps run on the gateway's one event loop. No lock is ever
held across an ``await``: every ledger change is one synchronous critical section (load, change,
save under ``_LEDGER_LOCK``), so a tap during a send never loses its answer to a stale in-memory
ledger. A card is written to the ledger BEFORE its message is sent (write-ahead: ``message_id``
null, ``pending_since``), filled in after, and the stage file is unlinked last, so a crash between
send and save never sends the card twice: a pending card found later is kept as asked, never
re-sent (``stage_resolved_pending``).

**Three sinks per tap.**
1. The events, through av-events (``plugins/av-events/_rating_cards.py`` reads
   ``av-events/proactive/rating-events/*.json`` on the flusher's cadence and emits
   ``opportunity.rating_asked@1`` / ``opportunity.rated@1`` / ``opportunity.collab_interest@1``
   (``opportunity.pre_planned@1`` for a retired planned card) with ids
   derived from (type, opportunity, card, revision), so a re-send never doubles a row). This plugin
   never posts to the ingest API itself and never builds an envelope.
2. The agent: after card 2 resolves (or its send failed, or both windows close with card 1
   answered) one line
   is injected into the resident's DM session through ``ctx.inject_message`` (gated by Hermes on
   ``plugins.entries.av-rate.allow_gateway_injection: true``): ``[Rating recorded] <Name>: <value>/5
   match fit; could imagine collaborating: <yes|no|unsure|not answered>. Reply with exactly: Got it!`` Hermes persists that turn as
   ``internal_notification`` (actor ``system`` on the data side). A refusal or an error is retried
   on later pick-ups up to ``INJECT_ATTEMPTS_MAX`` times (Hermes's ``inject_message`` returns one
   boolean for "flag off", "no live gateway" and "scheduling failed", so they cannot be told
   apart), then the card is closed with ``inject_gave_up``.
3. The ledger ``av-events/proactive/rated.json`` (ids, nonces, message ids, times, the two answers,
   and the cleaned name for the injected line), which the trigger reads as "asked". Cards evicted
   when the ledger is full leave an id-only tombstone in ``evicted``, so an evicted card stays
   asked and is never staged again.

**Switches.** Cards only with ``AV_RATE_CARDS`` on (``1|true|yes|on``, process environment then
``$HERMES_HOME/.env``); off, stages are left where they are and taps still answer. Logging: codes
and counts and the tenant's first eight characters; never a name, a token, a user id or callback
data.

**Trust boundary.** Everything here is in the agent's home, writable by the agent; the file checks
catch accidents, not forgers. The data side caps a plugin token's events at agent-asserted (the
asks) and self-reported (the answers). See the design note §5 and §7.

Python 3.11, standard library only; the Telegram SDK is imported inside the factory.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import html
import itertools
import json
import logging
import os
import re
import secrets
import stat
import threading
import time
import warnings
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable, Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

logger = logging.getLogger(__name__)

PLUGIN_ID = "av-rate"
PREFIX = "avr:"
#: The PTB handler's pattern: scoped, so core callback flows fall through to Hermes.
HANDLER_PATTERN = r"^avr:"
NONCE_CHARS = 22
CALLBACK_DATA = re.compile(r"^avr:(f:[1-5]|p:[yn]|c:[ynu]):([A-Za-z0-9_-]{22})$")
#: Telegram's limit on callback_data (bytes, UTF-8).
CALLBACK_DATA_MAX_BYTES = 64

SCALE = "match_fit_5_v1"
QUESTION_VERSION = SCALE
CHANNEL = "telegram_button"
WINDOW_HOURS = 24
WINDOW_S = WINDOW_HOURS * 3600
CARD_FIT = "fit"
CARD_PLANNED = "planned"
LABELS = {1: "Not a fit", 2: "Weak fit", 3: "OK fit", 4: "Good fit", 5: "Great fit"}
#: Card 1's buttons: one emoji per value, the words in the body (five labelled buttons do not fit a phone row).
EMOJI = {1: "😕", 2: "😐", 3: "🙂", 4: "😊", 5: "🤩"}
PLANNED_LABELS = {"y": "Yes", "n": "No"}
PLANNED_VALUES = {"y": "yes", "n": "no"}
CARD_COLLAB = "collab"
COLLAB_SCALE = "collab_interest_v1"
#: Card 2's buttons in order: Yes and No on one row, "Not sure yet" alone below; one letter each in callback_data.
COLLAB_CHOICES = ("y", "n", "u")
COLLAB_VALUES = {"y": "yes", "n": "no", "u": "unsure"}
COLLAB_LABELS = {"y": "Yes", "n": "No", "u": "Not sure yet"}
CHECK = "✅ "
#: DATA-373: every scheduled message ends with its manage line, card 1 too (card 1 opens the set).
MANAGE_LINE = "(Evening questions message - you can ask me to stop or manage it)"
#: True whatever the resident's research consent: the plugin cannot know it, so it promises only
#: what it can keep (the counterpart never sees the answer; where it goes beyond the agent's own
#: records is the consent brief's to say, not this card's).
PRIVACY_LINE = "{name} never sees this."
QUESTION_FIT = "How good a match was this suggestion from {agent}?"
QUESTION_COLLAB = "Could you imagine collaborating with this person 🤝?"
#: Ends the injected line: the agent's reply to the taps is this and nothing else.
REPLY_INSTRUCTION = "Reply with exactly: Got it!"

ON_SWITCH = "AV_RATE_CARDS"
SESSION_KEY_ENV = "AV_RATE_SESSION_KEY"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"
TENANT_ENVS = ("AV_TENANT_ID", "TENANT_ID")
#: job-settings.ts TEAM_TENANT_VAR: exactly `1` once trimmed, the process environment winning when set at all.
TEAM_TENANT_VAR = "AV_TEAM_TENANT"
TRUTHY = frozenset({"1", "true", "yes", "on"})

PICKUP_INTERVAL_S = 60.0
#: A stage older than this when the pick-up sees it is dropped (and counted): the trigger stages
#: again the next evening if the subject is still due (rating-cards.ts STALE_DAYS, the same 3 days).
STAGE_MAX_AGE_S = 3 * 24 * 3600
#: A stage whose send keeps failing is dropped after this many attempts across pick-ups.
SEND_ATTEMPTS_MAX = 3
#: An injection that is refused or errors is retried on later pick-ups this many times in all.
INJECT_ATTEMPTS_MAX = 3
#: An injection claimed this recently is in progress elsewhere (the tap or the pick-up); a claim
#: older than this (a crash mid-injection) lapses and the card is due again.
INJECT_CLAIM_S = 600
#: A pending (write-ahead) card with no message id after this long is kept as asked, never re-sent.
PENDING_MAX_AGE_S = 10 * 60
STAGE_MAX_BYTES = 4096
LEDGER_MAX_BYTES = 512 * 1024
#: Cards kept on the ledger at most; the oldest closed ones go first, leaving a tombstone.
LEDGER_MAX_CARDS = 500
#: Id-only tombstones kept at most (the oldest go first).
EVICTED_MAX = 5000
NAME_MAX = 80
HEADLINE_MAX = 120
AGENT_NAME_MAX = 40
#: An envelope id (agentvillage-data src/envelope.ts ID_PATTERN).
ID_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{1,128}$")
_UUID_SHAPE = re.compile(r"^[0-9a-fA-F-]{36}$")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")
_TELEGRAM_USER = re.compile(r"[1-9][0-9]{0,19}")
#: answerCallbackQuery text is at most 200 characters.
ANSWER_MAX = 200
DIR_MODE = 0o700
FILE_MODE = 0o600

# The installer's evening job and the files the trigger reads (message-labels.ts, job-settings.ts).
EVENING_JOB_NAMES = frozenset({"Edge — evening questions"})
#: pause-job.ts MAX_INSTALLED_IDS_BYTES, message-labels.ts MAX_JOBS_STORE_BYTES, job-settings.ts MAX_SETTINGS_BYTES.
INSTALLED_IDS_MAX_BYTES = 1024 * 1024
JOBS_STORE_MAX_BYTES = 16 * 1024 * 1024
SETTINGS_MAX_BYTES = 64 * 1024
_JOB_ID = re.compile(r"^[0-9a-f]{12}$")
#: job-settings.ts: `HH:MM-HH:MM`, start and end different.
_WINDOW = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$")
_ZONE_AREAS = frozenset({"Africa", "America", "Antarctica", "Arctic", "Asia", "Atlantic", "Australia", "Europe", "Indian", "Pacific"})
_ZONE = re.compile(r"^([A-Z][A-Za-z]+)/[A-Za-z][A-Za-z0-9_+-]*(?:/[A-Za-z][A-Za-z0-9_+-]*)?$")
DEFAULT_TZ = "Asia/Kolkata"
#: Quiet hours when the resident set no evening window: deliver 08:00 to 22:00 village time (the
#: pending alert's default, job-settings.ts DEFAULT_WINDOWS.pending).
QUIET_DEFAULT_WINDOW = (8 * 60, 22 * 60)

NOT_YOURS = "This card is not yours"
BAD_BUTTON = "This button is not valid."
INVALID = "This card is no longer valid."
CLOSED = "This question has closed."
IN_FLIGHT = "Still recording..."
FAILED = "Could not record that. Try again."

#: Outcome codes (the only thing logged besides the tenant's id8).
RECORDED = "recorded"
ALREADY = "already_recorded"

# Cards whose tap is being recorded right now: (chat id, message id).
_in_flight: set[tuple[str, str]] = set()
#: Held only inside synchronous critical sections (load, change, save); never across an await.
_LEDGER_LOCK = threading.Lock()
#: The plugin context Hermes handed `register`, for `inject_message`.
_CTX: Any = None
#: Stage files whose send failed, by name -> attempts (this process; a restart starts over).
_SEND_FAILURES: dict[str, int] = {}
#: Stage files Telegram rate-limited, by name -> the epoch not to try before.
_RETRY_NOT_BEFORE: dict[str, float] = {}
#: Hand-off files written by this process, in order: the name sorts the way they were written.
_HANDOFF_SEQ = itertools.count(1)


# --------------------------------------------------------------------------- env, paths, logging


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _dotenv(home: str) -> dict[str, str]:
    parsed: dict[str, str] = {}
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8-sig") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                parsed[name.strip()] = value.strip().strip("'\"")
    except OSError:
        return {}
    return parsed


def env(name: str, home: Optional[str] = None) -> str:
    """The process environment (a present, blank value is authoritative), else `$HERMES_HOME/.env`."""
    raw = os.environ.get(name)
    if raw is not None:
        return raw.strip()
    return _dotenv(home or hermes_home()).get(name, "").strip()


def cards_on(home: Optional[str] = None) -> bool:
    return env(ON_SWITCH, home).lower() in TRUTHY


def team_tenant(home: Optional[str] = None) -> bool:
    """job-settings.ts isTeamTenant: `AV_TEAM_TENANT` exactly `1` trimmed; the process environment
    wins when set at all (even empty); else the LAST assignment in `.env`, no quote stripping."""
    raw = os.environ.get(TEAM_TENANT_VAR)
    if raw is not None:
        return raw.strip() == "1"
    value: Optional[str] = None
    try:
        with open(os.path.join(home or hermes_home(), ".env"), encoding="utf-8") as handle:
            for line in handle.read().split("\n"):
                match = re.match(r"^\s*(?:export\s+)?AV_TEAM_TENANT\s*=(.*)$", line.rstrip("\r"))
                if match:
                    value = match.group(1)
    except OSError:
        return False
    return value is not None and value.strip() == "1"


def state_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-events")


def stage_dir(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "proactive", "rating")


def events_dir(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "proactive", "rating-events")


def ledger_path(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "proactive", "rated.json")


def tenant_id8() -> str:
    for name in TENANT_ENVS:
        value = os.environ.get(name, "").strip()
        if value:
            return re.sub(r"[^A-Za-z0-9-]", "", value)[:8]
    return "-"


def _log(outcome: str, **counts: int) -> None:
    extra = "".join(f" {key}={value}" for key, value in sorted(counts.items()))
    logger.info("av-rate: tenant=%s outcome=%s%s", tenant_id8(), outcome, extra)


def now_iso(epoch: Optional[float] = None) -> str:
    stamp = datetime.fromtimestamp(time.time() if epoch is None else epoch, tz=timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch_from_iso(value: Any) -> Optional[float]:
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        stamp = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return None
    return stamp.timestamp()


# --------------------------------------------------------------------------- private files


def _uid() -> Optional[int]:
    return os.getuid() if hasattr(os, "getuid") else None


def private_dir(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    uid = _uid()
    return stat.S_ISDIR(st.st_mode) and (uid is None or st.st_uid == uid) and not st.st_mode & 0o022


def _read_private_text(path: str, max_bytes: int) -> tuple[Optional[str], Optional[str]]:
    """`(text, None)` for a regular, this-user, 0600-or-tighter file under `max_bytes` (opened
    O_NOFOLLOW), else `(None, code)`: `missing`, `bad_dir`, `unreadable`, `not_regular`,
    `foreign_owner`, `not_private`, `too_big`."""
    if not private_dir(os.path.dirname(path)):
        return None, "missing" if not os.path.lexists(path) else "bad_dir"
    try:
        st = os.lstat(path)
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "unreadable"
    uid = _uid()
    if not stat.S_ISREG(st.st_mode):
        return None, "not_regular"
    if uid is not None and st.st_uid != uid:
        return None, "foreign_owner"
    if st.st_mode & 0o077:
        return None, "not_private"
    if st.st_size > max_bytes:
        return None, "too_big"
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, encoding="utf-8") as handle:
            raw = handle.read(max_bytes + 1)
    except OSError:
        return None, "unreadable"
    if len(raw) > max_bytes:
        return None, "too_big"
    return raw, None


def private_file(path: str, max_bytes: int) -> tuple[Any, Optional[str]]:
    """`(data, None)`, or `(None, code)` (`_outcome_ask.private_file`'s codes)."""
    raw, why = _read_private_text(path, max_bytes)
    if why is not None:
        return None, why
    try:
        return json.loads(raw or ""), None
    except ValueError:
        return None, "unreadable"


def write_private(path: str, data: Any) -> None:
    """By temp file and rename, 0600 in a 0700 directory. Raises OSError."""
    os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, separators=(",", ":"))
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _unlink(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _listing(path: str) -> list[str]:
    if not private_dir(path):
        return []
    try:
        return sorted(name for name in os.listdir(path) if name.endswith(".json") and not name.endswith(".tmp"))
    except OSError:
        return []


def _read_json_file(path: str, max_bytes: int) -> tuple[Any, Optional[str]]:
    """A file the resident may write (Hermes's job store, the installer's ids, the settings): a
    regular file under `max_bytes` that parses, else `(None, code)`: `missing`, `unreadable`."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "unreadable"
    if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
        return None, "unreadable"
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle), None
    except (OSError, ValueError):
        return None, "unreadable"


# --------------------------------------------------------------------------- the resident's controls


def evening_job_state(home: Optional[str] = None) -> str:
    """rating-cards.ts eveningJobState: `stopped` when a job named as the installer's evening job,
    with an id `av-events/installed_jobs.json` lists, is paused or disabled (message-labels.ts
    storedJobEnabled: `enabled` false, `state` "paused" or a `paused_at`); `running` when such a
    job is enabled; `absent` when the store names no installed evening job (no file is no jobs,
    as Hermes reads it); `unreadable` when either file cannot be read or has the wrong shape."""
    root = home or hermes_home()
    store, why = _read_json_file(os.path.join(root, "cron", "jobs.json"), JOBS_STORE_MAX_BYTES)
    if why == "missing":
        jobs: list = []
    elif why is not None:
        return "unreadable"
    else:
        if not isinstance(store, dict):
            return "unreadable"
        jobs = store.get("jobs", [])
        if not isinstance(jobs, list):
            return "unreadable"
    ids_data, why = _read_json_file(os.path.join(root, "av-events", "installed_jobs.json"), INSTALLED_IDS_MAX_BYTES)
    if why == "missing":
        installed: frozenset = frozenset()
    elif why is not None or not isinstance(ids_data, dict) or not isinstance(ids_data.get("ids"), list):
        return "unreadable"
    else:
        installed = frozenset(i for i in ids_data["ids"] if isinstance(i, str) and _JOB_ID.match(i))
    seen = False
    for job in jobs:
        if not isinstance(job, dict) or job.get("name") not in EVENING_JOB_NAMES:
            continue
        job_id = job.get("id")
        if not isinstance(job_id, str) or not _JOB_ID.match(job_id) or job_id not in installed:
            continue
        seen = True
        if job.get("enabled") is False or job.get("state") == "paused" or job.get("paused_at"):
            return "stopped"
    return "running" if seen else "absent"


def _valid_zone(name: Any) -> bool:
    """job-settings.ts isValidTimeZone: `UTC`, or `Area/Location` in the ten areas the runtime knows."""
    if not isinstance(name, str) or len(name) > 64:
        return False
    if name == "UTC":
        return True
    match = _ZONE.match(name)
    if not match or match.group(1) not in _ZONE_AREAS:
        return False
    try:
        ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return False
    return True


def parse_window(text: Any) -> Optional[tuple[int, int]]:
    """job-settings.ts parseWindow: minutes since local midnight, start and end different."""
    if not isinstance(text, str):
        return None
    match = _WINDOW.match(text)
    if not match:
        return None
    start = int(match.group(1)) * 60 + int(match.group(2))
    end = int(match.group(3)) * 60 + int(match.group(4))
    return None if start == end else (start, end)


def in_window(minute: int, window: tuple[int, int]) -> bool:
    start, end = window
    return (start <= minute < end) if start < end else (minute >= start or minute < end)


def quiet_delivery(home: Optional[str] = None) -> tuple[Optional[tuple[int, int]], str, Optional[str]]:
    """`(window, tz, invalid_code)` for the cards: the resident's evening entry in
    `av-events/job-settings.json` (job-settings.ts readJobSettings and validateEntry, read the
    same strict way), else the default quiet hours. An invalid file or entry is `(None, tz, code)`:
    the trigger holds the evening run silent in that case, and the pick-up defers."""
    path = os.path.join(home or hermes_home(), "av-events", "job-settings.json")
    data, why = _read_json_file(path, SETTINGS_MAX_BYTES)
    if why == "missing":
        return QUIET_DEFAULT_WINDOW, DEFAULT_TZ, None
    if why is not None:
        return None, DEFAULT_TZ, "file-unreadable"
    if not isinstance(data, dict):
        return None, DEFAULT_TZ, "file-not-object"
    if data.get("v") != 1:
        return None, DEFAULT_TZ, "file-version"
    jobs = data.get("jobs")
    if jobs is None:
        return QUIET_DEFAULT_WINDOW, DEFAULT_TZ, None
    if not isinstance(jobs, dict):
        return None, DEFAULT_TZ, "file-jobs"
    if "evening" not in jobs:
        return QUIET_DEFAULT_WINDOW, DEFAULT_TZ, None
    entry = jobs["evening"]
    if not isinstance(entry, dict):
        return None, DEFAULT_TZ, "entry"
    window: Optional[tuple[int, int]] = None
    if "window" in entry:
        window = parse_window(entry["window"])
        if window is None:
            return None, DEFAULT_TZ, "window"
    tz = DEFAULT_TZ
    if "tz" in entry:
        if not _valid_zone(entry["tz"]):
            return None, DEFAULT_TZ, "tz"
        tz = entry["tz"]
    return window or QUIET_DEFAULT_WINDOW, tz, None


def minute_of_day(now: float, tz: str) -> int:
    try:
        local = datetime.fromtimestamp(now, tz=ZoneInfo(tz))
    except (ZoneInfoNotFoundError, ValueError, OSError, OverflowError):
        local = datetime.fromtimestamp(now, tz=ZoneInfo(DEFAULT_TZ))
    return local.hour * 60 + local.minute


def quiet_hours(now: float, home: Optional[str] = None) -> Optional[str]:
    """None when a card may go out now; else the deferral code: `quiet_hours` (outside the
    resident's evening window or the default 08:00 to 22:00) or `settings_invalid`."""
    window, tz, invalid = quiet_delivery(home)
    if invalid is not None or window is None:
        return "settings_invalid"
    return None if in_window(minute_of_day(now, tz), window) else "quiet_hours"


# --------------------------------------------------------------------------- key, nonce, hashes


def _read_key_file(path: str) -> Optional[bytes]:
    """A key file read with the private-file checks (regular, this user, 0600, O_NOFOLLOW): the key,
    or None when it is missing, not private, empty or not 64 hex yet."""
    text, why = _read_private_text(path, 256)
    if why is not None or text is None:
        return None
    text = text.strip()
    return bytes.fromhex(text) if _HEX64.match(text) else None


def hash_key(home: Optional[str] = None) -> Optional[bytes]:
    """The tenant's av-events key (`av-events/hash.key`, 64 hex), else this plugin's own
    `av-events/av-rate.key`, made once: written whole to a private temp file and linked into place,
    so no reader ever sees an empty key file. None when neither can be read or made this pass (the
    pick-up counts `no_key` and tries again); an existing file that is empty or not hex is "not
    yet", never dead."""
    directory = state_dir(home)
    for name in ("hash.key", "av-rate.key"):
        key = _read_key_file(os.path.join(directory, name))
        if key is not None:
            return key
    path = os.path.join(directory, "av-rate.key")
    try:
        os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
        tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), FILE_MODE)
        value = secrets.token_hex(32)
        try:
            with os.fdopen(fd, "w", encoding="ascii") as handle:
                handle.write(value + "\n")
            os.link(tmp, path)
        except FileExistsError:
            pass
        finally:
            _unlink(tmp)
    except OSError:
        return None
    return _read_key_file(path)


def make_nonce(key: bytes, opportunity_id: str) -> str:
    digest = hmac.new(key, f"avr|{opportunity_id}|{SCALE}".encode("utf-8"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")[:NONCE_CHARS]


def keyed_hash(key: bytes, text: str) -> str:
    """As av-events hashes `message.out` content: HMAC-SHA256 under the tenant's key, hex."""
    return hmac.new(key, text.encode("utf-8", errors="surrogatepass"), hashlib.sha256).hexdigest()


# --------------------------------------------------------------------------- callback data, keyboards


def parse_callback(data: Any) -> Optional[tuple[str, str, str]]:
    """``(card, choice, nonce)`` for a well-formed ``avr:`` value inside 64 bytes: card ``fit`` with
    choice ``1``..``5``, ``collab`` with one of COLLAB_CHOICES, or the retired ``planned`` with
    ``y``/``n``. Else None."""
    if not isinstance(data, str) or len(data.encode("utf-8")) > CALLBACK_DATA_MAX_BYTES:
        return None
    match = CALLBACK_DATA.fullmatch(data)
    if match is None:
        return None
    kind, choice = match.group(1).split(":", 1)
    return {"f": CARD_FIT, "p": CARD_PLANNED, "c": CARD_COLLAB}[kind], choice, match.group(2)


def fit_callback(value: int, nonce: str) -> str:
    return f"avr:f:{value}:{nonce}"


def planned_callback(choice: str, nonce: str) -> str:
    return f"avr:p:{choice}:{nonce}"


def collab_callback(choice: str, nonce: str) -> str:
    return f"avr:c:{choice}:{nonce}"


def fit_rows(nonce: str, make_button: Callable[[str, str], Any], selected: Optional[int] = None) -> list[list[Any]]:
    """One row of five emoji buttons; the selected one carries a check mark."""
    return [[make_button((CHECK if selected == value else "") + EMOJI[value], fit_callback(value, nonce)) for value in range(1, 6)]]


def collab_rows(nonce: str, make_button: Callable[[str, str], Any], selected: Optional[str] = None) -> list[list[Any]]:
    buttons = [make_button((CHECK if selected == choice else "") + COLLAB_LABELS[choice], collab_callback(choice, nonce)) for choice in COLLAB_CHOICES]
    return [buttons[:2], buttons[2:]]


def fit_text(agent_name: str, name: str, headline: Optional[str]) -> str:
    """Card 1, HTML-escaped. The headline line is left out when the trigger withheld it."""
    lines = [html.escape(QUESTION_FIT.format(agent=agent_name))]
    lines.append(html.escape(f"{name}, about {headline}" if headline else name))
    lines.append("")
    lines += [html.escape(f"{EMOJI[value]}  {label}") for value, label in LABELS.items()]
    lines.append("")
    lines.append(html.escape(PRIVACY_LINE.format(name=name)))
    lines.append("")
    lines.append(html.escape(MANAGE_LINE))
    return "\n".join(lines)


def collab_text() -> str:
    return html.escape(QUESTION_COLLAB)


# --------------------------------------------------------------------------- owner


def _positive_id(value: Any) -> Optional[str]:
    text = str(value).strip() if isinstance(value, (int, str)) and not isinstance(value, bool) else ""
    return text if _TELEGRAM_USER.fullmatch(text) else None


def owner_ids(adapter: Any = None) -> set[str]:
    """av-vote's rule: the adapter config's home channel (`user_id`, and `chat_id` when a positive
    DM id) and `TELEGRAM_HOME_CHANNEL`."""
    found: set[str] = set()
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in ("user_id", "chat_id"):
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                found.add(ident)
    except Exception:  # noqa: BLE001 - an unreadable config falls back to the env
        pass
    env_id = _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))
    if env_id:
        found.add(env_id)
    return found


def home_chat_id(adapter: Any = None) -> Optional[str]:
    """Where the cards go: the home channel's positive `chat_id`, else its `user_id`, else
    `TELEGRAM_HOME_CHANNEL`. None when the box names no DM."""
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in ("chat_id", "user_id"):
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                return ident
    except Exception:  # noqa: BLE001
        pass
    return _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))


def paired_on_box(user: str) -> bool:
    try:
        from gateway.pairing import PairingStore  # noqa: PLC0415 - Hermes, in-process on a box

        return bool(PairingStore().is_approved("telegram", user))
    except Exception:  # noqa: BLE001
        return False


def is_owner_tap(adapter: Any, user: Optional[str], chat: Optional[str], chat_type: Optional[str]) -> bool:
    """The tap is the resident's, in the resident's own DM with the bot. A tap with no chat (no
    message on the callback) is never the owner's: the card binding needs the message."""
    if user is None or chat is None:
        return False
    if chat != user:
        return False
    if isinstance(chat_type, str) and chat_type and chat_type != "private":
        return False
    if user in owner_ids(adapter):
        return True
    return paired_on_box(user)


# --------------------------------------------------------------------------- the ledger


def empty_ledger() -> dict:
    return {"v": 1, "cards": {}, "evicted": []}


def load_ledger(home: Optional[str] = None) -> tuple[dict, Optional[str]]:
    """`(ledger, None)`, or `(empty, code)` when there is none yet (`missing`) or it cannot be
    trusted (`private_file`'s other codes, `bad_shape`): then nothing is written over it."""
    data, why = private_file(ledger_path(home), LEDGER_MAX_BYTES)
    if why is not None:
        return empty_ledger(), why
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("cards"), dict):
        return empty_ledger(), "bad_shape"
    evicted = data.get("evicted")
    data["evicted"] = [i for i in evicted if isinstance(i, str)] if isinstance(evicted, list) else []
    return data, None


def save_ledger(ledger: dict, home: Optional[str] = None) -> None:
    """Write the ledger. Over LEDGER_MAX_CARDS the oldest closed cards are evicted, each leaving an
    id-only tombstone in `evicted` (capped at EVICTED_MAX, oldest first), so an evicted card stays
    "asked" for the trigger (rating-cards.ts readRatedIds reads both)."""
    cards = ledger["cards"]
    evicted: list = ledger.setdefault("evicted", [])
    if len(cards) > LEDGER_MAX_CARDS:
        ordered = sorted(cards.items(), key=lambda item: str((item[1] or {}).get("sent_at") or (item[1] or {}).get("pending_since") or ""))
        for key, _ in ordered[: len(cards) - LEDGER_MAX_CARDS]:
            cards.pop(key, None)
            if key not in evicted:
                evicted.append(key)
    if len(evicted) > EVICTED_MAX:
        del evicted[: len(evicted) - EVICTED_MAX]
    write_private(ledger_path(home), ledger)


def ledger_update(home: Optional[str], change: Callable[[dict], Any]) -> tuple[Any, Optional[str]]:
    """One synchronous critical section: load the ledger, apply `change` (which returns a result,
    or `(result, False)` to skip the save), save. `(result, None)`, or `(None, code)` when the
    ledger cannot be trusted (then nothing is written over it). Never held across an await."""
    with _LEDGER_LOCK:
        ledger, why = load_ledger(home)
        if why not in (None, "missing"):
            return None, why
        outcome = change(ledger)
        if isinstance(outcome, tuple) and len(outcome) == 2 and outcome[1] is False:
            return outcome[0], None
        save_ledger(ledger, home)
        return outcome, None


def card_for_nonce(ledger: dict, nonce: str) -> Optional[tuple[str, dict]]:
    for opportunity_id, card in ledger["cards"].items():
        if isinstance(card, dict) and card.get("nonce") == nonce:
            return opportunity_id, card
    return None


def is_closed(card: dict, now: float) -> bool:
    """Card 1's window: 24 h from its send (a pending card with no send time is open)."""
    closes = epoch_from_iso(card.get("closes_at"))
    return closes is not None and now > closes


def planned_closed(card: dict, now: float) -> bool:
    """The retired planned card's own window, 24 h from its own send (older releases only)."""
    if card.get("planned_message_id") is None:
        return is_closed(card, now)
    closes = epoch_from_iso(card.get("closes_at_planned"))
    return closes is None or now > closes


def collab_closed(card: dict, now: float) -> bool:
    """Card 2's own window, 24 h from its own send; before card 2 is sent, card 1's window."""
    if card.get("collab_message_id") is None:
        return is_closed(card, now)
    closes = epoch_from_iso(card.get("closes_at_collab"))
    return closes is None or now > closes


def card_closed(card: dict, kind: str, now: float) -> bool:
    if kind == CARD_FIT:
        return is_closed(card, now)
    return planned_closed(card, now) if kind == CARD_PLANNED else collab_closed(card, now)


#: The ledger field holding each card's Telegram message id.
MESSAGE_FIELD = {CARD_FIT: "message_id", CARD_PLANNED: "planned_message_id", CARD_COLLAB: "collab_message_id"}


def card_message_matches(card: dict, kind: str, message_id: Any) -> bool:
    """The tap's message is the card's own: card 1's `message_id`, card 2's `collab_message_id`, or
    a retired planned card's `planned_message_id`. A card 1 whose id is unknown (a pending card
    resolved after a crash) binds on this first tap instead."""
    stored = card.get(MESSAGE_FIELD[kind])
    if stored is None:
        # Card 1 with no id on file (a pending card resolved after a crash) binds now; so does a
        # card 2 whose send reported failure (a timeout after Telegram took the message). A card 2
        # never attempted has no message a tap could come from.
        return kind == CARD_FIT or (kind == CARD_COLLAB and bool(card.get("collab_send_failed")))
    return str(stored) == str(message_id)


# --------------------------------------------------------------------------- the stage files


def valid_stage(data: Any) -> Optional[dict]:
    """The trigger's stage (rating-cards.ts `RatingStage`), or None unless exactly the shape:
    `v` 1, `opportunity_id` an envelope id, `intention_id` an id or null, `name` (1..80),
    `headline` (1..120 or null), `agent_name` (1..40), `staged_at` ISO, `date` YYYY-MM-DD."""
    keys = {"v", "opportunity_id", "intention_id", "name", "headline", "agent_name", "staged_at", "date"}
    if not isinstance(data, dict) or set(data) != keys or data["v"] != 1 or type(data["v"]) is not int:
        return None
    opportunity = data["opportunity_id"]
    if not (isinstance(opportunity, str) and ID_PATTERN.fullmatch(opportunity)):
        return None
    intention = data["intention_id"]
    if intention is not None and not (isinstance(intention, str) and ID_PATTERN.fullmatch(intention)):
        return None
    name, headline, agent = data["name"], data["headline"], data["agent_name"]
    if not (isinstance(name, str) and 0 < len(name) <= NAME_MAX and name == name.strip()):
        return None
    if headline is not None and not (isinstance(headline, str) and 0 < len(headline) <= HEADLINE_MAX):
        return None
    if not (isinstance(agent, str) and 0 < len(agent) <= AGENT_NAME_MAX):
        return None
    if epoch_from_iso(data["staged_at"]) is None or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", str(data["date"])):
        return None
    return {
        "opportunity_id": opportunity.lower() if _UUID_SHAPE.fullmatch(opportunity) else opportunity,
        "intention_id": intention,
        "name": name,
        "headline": headline,
        "agent_name": agent,
        "staged_at": data["staged_at"],
    }


# --------------------------------------------------------------------------- the hand-off to av-events


def hand_off(record: dict, home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """Write one event record for av-events' `_rating_cards.tick` (one file per record:
    `{"v":1,"written_at":<ISO>,"records":[record]}`). The record carries ids, codes, a value and
    times only. True when written."""
    stamp = time.time() if now is None else now
    try:
        directory = events_dir(home)
        os.makedirs(directory, mode=DIR_MODE, exist_ok=True)
        path = os.path.join(directory, f"{int(stamp * 1000)}-{os.getpid()}-{next(_HANDOFF_SEQ):08d}-{secrets.token_hex(4)}.json")
        write_private(path, {"v": 1, "written_at": now_iso(stamp), "records": [record]})
        return True
    except OSError:
        _log("handoff_unwritable")
        return False


def asked_record(opportunity_id: str, intention_id: Optional[str], card: str, message_hash: str, at: str) -> dict:
    return {"event_type": "opportunity.rating_asked", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": card, "revision": 1, "value": None, "at": at, "message_hash": message_hash}


def rated_record(opportunity_id: str, intention_id: Optional[str], value: int, revision: int, at: str) -> dict:
    return {"event_type": "opportunity.rated", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": CARD_FIT, "revision": revision, "value": value, "at": at, "message_hash": None}


def planned_record(opportunity_id: str, intention_id: Optional[str], value: str, revision: int, at: str) -> dict:
    return {"event_type": "opportunity.pre_planned", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": CARD_PLANNED, "revision": revision, "value": value, "at": at, "message_hash": None}


def collab_record(opportunity_id: str, intention_id: Optional[str], value: str, revision: int, at: str) -> dict:
    return {"event_type": "opportunity.collab_interest", "opportunity_id": opportunity_id, "intention_id": intention_id,
            "card": CARD_COLLAB, "revision": revision, "value": value, "at": at, "message_hash": None}


# --------------------------------------------------------------------------- the agent hand-off


def injected_line(card: dict) -> str:
    fit = card.get("fit") or {}
    collab = card.get("collab") or {}
    value = fit.get("value")
    collab_value = collab.get("value") if collab.get("value") in COLLAB_VALUES.values() else "not answered"
    # The resident has just tapped the cards: the agent's whole answer is a short acknowledgement.
    return (f"[Rating recorded] {card.get('name', 'This person')}: {value}/5 match fit; "
            f"could imagine collaborating: {collab_value}. {REPLY_INSTRUCTION}")


def session_key_for(chat_id: str) -> str:
    """The resident's DM session key (`gateway/session.py` build_session_key: `<ns>:<platform>:
    <chat_type>:<chat_id>`, the default namespace `agent:main`), or `AV_RATE_SESSION_KEY` when set."""
    override = env(SESSION_KEY_ENV)
    return override or f"agent:main:telegram:dm:{chat_id}"


def inject(card: dict, chat_id: str, ctx: Any = None) -> str:
    """One line into the resident's DM session. A code: `injected`, `inject_no_ctx`,
    `inject_refused` (Hermes said no: the config flag, no live gateway, scheduling failed; one
    boolean for all three) or `inject_error`."""
    context = ctx if ctx is not None else _CTX
    inject_fn = getattr(context, "inject_message", None)
    if not callable(inject_fn):
        return "inject_no_ctx"
    try:
        accepted = inject_fn(injected_line(card), session_key=session_key_for(chat_id))
    except Exception:  # noqa: BLE001
        return "inject_error"
    return "injected" if accepted else "inject_refused"


def ready_to_inject(card: dict, now: float) -> bool:
    """After card 2 resolves; after card 1 when card 2 could not be sent; or when both windows have
    closed with card 1 answered."""
    if card.get("injected") or not card.get("fit"):
        return False
    claimed = epoch_from_iso(card.get("inject_claimed_at"))
    if claimed is not None and now - claimed < INJECT_CLAIM_S:
        return False
    if card.get("collab"):
        return True
    # Card 2 could not be sent, or an older release's planned card was answered: card 1 settles it.
    if card.get("collab_message_id") is None and (card.get("collab_send_failed") or card.get("planned")):
        return True
    return is_closed(card, now) and collab_closed(card, now)


def claim_injection(home: Optional[str], opportunity_id: str, now: float) -> Optional[dict]:
    """A snapshot of the card when it is due, claimed in the same critical section so a tap and the
    pick-up never inject one card twice; else None."""

    def claim(ledger: dict) -> Any:
        card = ledger["cards"].get(opportunity_id)
        if not isinstance(card, dict) or not ready_to_inject(card, now):
            return None, False
        card["inject_claimed_at"] = now_iso(now)
        return dict(card)

    snapshot, why = ledger_update(home, claim)
    return snapshot if why is None else None


def _settle_injection(card: dict, code: str) -> bool:
    """Record one injection attempt on the card and release its claim. True when the card is now
    final (injected, no context, or out of attempts)."""
    card.pop("inject_claimed_at", None)
    if code == "injected" or code == "inject_no_ctx":
        card["injected"] = True
        card["injected_code"] = code
        return True
    attempts = int(card.get("inject_attempts") or 0) + 1
    card["inject_attempts"] = attempts
    if attempts >= INJECT_ATTEMPTS_MAX:
        card["injected"] = True
        card["injected_code"] = "inject_gave_up"
        return True
    return False


# --------------------------------------------------------------------------- the pick-up


async def pick_up(bot: Any, adapter: Any, make_button: Callable[[str, str], Any], make_markup: Callable[[list], Any],
                  home: Optional[str] = None, now: Optional[float] = None, ctx: Any = None) -> dict:
    """One pass: send the staged cards (AV_RATE_CARDS on), then inject the lines that are due.
    Returns code -> count; never raises. No lock is held across an await."""
    codes: dict[str, int] = {}
    stamp = time.time() if now is None else now

    def count(code: str, n: int = 1) -> None:
        if n:
            codes[code] = codes.get(code, 0) + n

    try:
        _, why = ledger_update(home, lambda ledger: (None, False))
        if why is not None:
            count(f"ledger_{why}")
            return codes
        if cards_on(home):
            await _send_staged(bot, adapter, make_button, make_markup, home, stamp, count)
        await _inject_due(home, stamp, count, ctx)
    except Exception:  # noqa: BLE001 - the pass never raises into the gateway
        logger.warning("av-rate: tenant=%s outcome=pickup_error", tenant_id8())
        count("pickup_error")
    if codes:
        _log("pickup", **codes)
    return codes


def _retry_after_of(error: BaseException) -> Optional[float]:
    """Telegram's 429: PTB raises `RetryAfter` with `retry_after` (seconds, or a timedelta on
    newer builds). None for any other error."""
    value = getattr(error, "retry_after", None)
    if value is None:
        return None
    seconds = getattr(value, "total_seconds", None)
    if callable(seconds):
        value = seconds()
    try:
        wait = float(value)
    except (TypeError, ValueError):
        return None
    return wait if wait >= 0 else None


async def _send_staged(bot: Any, adapter: Any, make_button: Callable[[str, str], Any], make_markup: Callable[[list], Any],
                       home: Optional[str], now: float, count: Callable[..., None]) -> None:
    folder = stage_dir(home)
    if os.path.lexists(folder) and not private_dir(folder):
        count("stage_folder_not_private")
        return
    names = _listing(folder)
    if not names:
        return
    # The resident's controls, exactly as the trigger reads them: a team tenant never gets a card
    # (its stages are dropped); a stopped evening job or quiet hours defer the stages; an
    # unreadable job store or invalid settings defer too (never a send the resident did not allow).
    if team_tenant(home):
        for name in names:
            _unlink(os.path.join(folder, name))
        count("stage_dropped_team_tenant", len(names))
        return
    job_state = evening_job_state(home)
    if job_state == "stopped":
        count("deferred_job_stopped", len(names))
        return
    if job_state == "unreadable":
        count("deferred_jobs_unreadable", len(names))
        return
    quiet = quiet_hours(now, home)
    if quiet is not None:
        count(f"deferred_{quiet}", len(names))
        return
    chat = home_chat_id(adapter)
    if chat is None:
        count("no_home_chat", len(names))
        return
    key = hash_key(home)
    if key is None:
        count("no_key", len(names))
        return
    for name in names:
        path = os.path.join(folder, name)
        not_before = _RETRY_NOT_BEFORE.get(name)
        if not_before is not None and now < not_before:
            count("deferred_rate_limited")
            continue
        _RETRY_NOT_BEFORE.pop(name, None)
        data, why = private_file(path, STAGE_MAX_BYTES)
        if why is not None:
            count(f"stage_dropped_{why}")
            _unlink(path)
            continue
        stage = valid_stage(data)
        if stage is None:
            count("stage_dropped_bad_shape")
            _unlink(path)
            continue
        staged = epoch_from_iso(stage["staged_at"]) or 0.0
        if now - staged > STAGE_MAX_AGE_S:
            count("stage_dropped_stale")
            _unlink(path)
            continue
        opportunity_id = stage["opportunity_id"]
        nonce = make_nonce(key, opportunity_id)
        text = fit_text(stage["agent_name"], stage["name"], stage["headline"])

        # Write-ahead: the card is on the ledger before the message exists.
        def reserve(ledger: dict) -> str:
            existing = ledger["cards"].get(opportunity_id)
            if opportunity_id in ledger["evicted"]:
                return "already_asked"
            if existing is not None:
                if existing.get("message_id") is not None or existing.get("sent_at") is not None:
                    return "already_asked"
                # A pending card from an earlier pass that never got its message id: this process
                # knows nothing about it, so it may have been sent. Never send it again.
                pending_since = epoch_from_iso(existing.get("pending_since")) or 0.0
                if now - pending_since > PENDING_MAX_AGE_S or existing.get("pid") != os.getpid():
                    existing["sent_at"] = existing.get("sent_at") or now_iso(pending_since or now)
                    existing["closes_at"] = existing.get("closes_at") or now_iso((pending_since or now) + WINDOW_S)
                    existing["send_unknown"] = True
                    return "resolve_pending"
                return "in_progress"
            ledger["cards"][opportunity_id] = {
                "nonce": nonce,
                "intention_id": stage["intention_id"],
                "name": stage["name"],
                "agent_name": stage["agent_name"],
                "chat_id": chat,
                "message_id": None,
                "collab_message_id": None,
                "pending_since": now_iso(now),
                "pid": os.getpid(),
                "sent_at": None,
                "closes_at": None,
                "closes_at_collab": None,
                "fit": None,
                "collab": None,
                "injected": False,
            }
            return "reserved"

        reserved, why = ledger_update(home, reserve)
        if why is not None:
            count(f"ledger_{why}")
            return
        if reserved == "already_asked":
            count("stage_dropped_already_asked")
            _unlink(path)
            continue
        if reserved == "resolve_pending":
            count("stage_resolved_pending")
            _unlink(path)
            hand_off(asked_record(opportunity_id, stage["intention_id"], CARD_FIT, keyed_hash(key, text), now_iso(now)), home, now)
            continue
        if reserved == "in_progress":
            count("send_in_progress")
            continue
        try:
            message = await bot.send_message(chat_id=int(chat), text=text, parse_mode="HTML",
                                             reply_markup=make_markup(fit_rows(nonce, make_button)),
                                             disable_web_page_preview=True)
        except Exception as error:  # noqa: BLE001 - Telegram down, blocked bot, rate limit, ...
            # The reservation is withdrawn so the next pass may try again (or drop the stage).
            ledger_update(home, lambda ledger: _withdraw(ledger, opportunity_id))
            wait = _retry_after_of(error)
            if wait is not None:
                _RETRY_NOT_BEFORE[name] = now + wait
                count("send_rate_limited")
                continue
            _SEND_FAILURES[name] = _SEND_FAILURES.get(name, 0) + 1
            if _SEND_FAILURES[name] >= SEND_ATTEMPTS_MAX:
                _SEND_FAILURES.pop(name, None)
                _unlink(path)
                count("stage_dropped_send_failed")
            else:
                count("send_failed")
            continue
        _SEND_FAILURES.pop(name, None)
        sent_at = now_iso(now)
        message_id = getattr(message, "message_id", None)

        def fill(ledger: dict) -> None:
            card = ledger["cards"].get(opportunity_id)
            if card is None:
                return
            card["message_id"] = message_id
            card["sent_at"] = sent_at
            card["closes_at"] = now_iso(now + WINDOW_S)
            card.pop("pid", None)

        _, why = ledger_update(home, fill)
        if why is not None:
            count(f"ledger_{why}")
        _unlink(path)
        hand_off(asked_record(opportunity_id, stage["intention_id"], CARD_FIT, keyed_hash(key, text), sent_at), home, now)
        count("sent")


def _withdraw(ledger: dict, opportunity_id: str) -> Any:
    card = ledger["cards"].get(opportunity_id)
    if card is not None and card.get("message_id") is None and card.get("sent_at") is None:
        ledger["cards"].pop(opportunity_id, None)
        return None
    return None, False


async def _inject_due(home: Optional[str], now: float, count: Callable[..., None], ctx: Any) -> None:
    due, why = ledger_update(home, lambda ledger: ([key for key, card in ledger["cards"].items() if isinstance(card, dict) and ready_to_inject(card, now)], False))
    if why is not None or not due:
        return
    for opportunity_id in due:
        snapshot = claim_injection(home, opportunity_id, now)
        if not snapshot:
            continue
        code = await asyncio.to_thread(inject, snapshot, str(snapshot.get("chat_id", "")), ctx)
        count(code)

        def settle(ledger: dict) -> Any:
            card = ledger["cards"].get(opportunity_id)
            if card is None or card.get("injected"):
                return None, False
            _settle_injection(card, code)
            return None

        ledger_update(home, settle)


# --------------------------------------------------------------------------- the tap


def _button_fields(button: Any) -> tuple[str, Any]:
    if isinstance(button, dict):
        return str(button.get("text", "")), button.get("callback_data")
    return str(getattr(button, "text", "") or ""), getattr(button, "callback_data", None)


def _unchecked(text: str) -> str:
    return text[len(CHECK):] if text.startswith(CHECK) else text


def mark_keyboard(rows: Any, data: str, make_button: Callable[[str, str], Any]) -> Optional[list[list[Any]]]:
    """The card's keyboard with a check mark on the tapped ``avr:`` button only (av-vote's)."""
    if not rows:
        return None
    found = changed = False
    out: list[list[Any]] = []
    for row in rows:
        new_row = []
        for button in row or ():
            text, callback = _button_fields(button)
            if isinstance(callback, str) and callback.startswith(PREFIX):
                want = CHECK + _unchecked(text) if callback == data else _unchecked(text)
                found = found or callback == data
                if want != text:
                    changed = True
                    new_row.append(make_button(want, callback))
                    continue
            new_row.append(button)
        out.append(new_row)
    return out if found and changed else None


def _truncate(text: str) -> str:
    return text if len(text) <= ANSWER_MAX else text[: ANSWER_MAX - 3] + "..."


async def _answer(query: Any, text: str) -> None:
    try:
        await query.answer(text=_truncate(text))
    except Exception:  # noqa: BLE001 - an expired query id cannot be answered
        logger.debug("av-rate: answerCallbackQuery failed", exc_info=True)


def record_tap(ledger: dict, opportunity_id: str, card: str, choice: str, now: float, home: Optional[str] = None) -> tuple[str, str, Optional[int]]:
    """Record one tap on the ledger and hand its event over. `(label, value_text, revision)`;
    `revision` None when the same value was already recorded (nothing changes, no event). The
    caller holds the ledger lock and has checked the window and the message."""
    entry = ledger["cards"][opportunity_id]
    at = now_iso(now)
    if card == CARD_FIT:
        value = int(choice)
        current = entry.get("fit") or {}
        if current.get("value") == value:
            return LABELS[value], str(value), None
        revision = int(current.get("revision", 0)) + 1
        entry["fit"] = {"value": value, "revision": revision, "at": at}
        hand_off(rated_record(opportunity_id, entry.get("intention_id"), value, revision, at), home, now)
        return LABELS[value], str(value), revision
    if card == CARD_COLLAB:
        collab_value = COLLAB_VALUES[choice]
        current = entry.get("collab") or {}
        if current.get("value") == collab_value:
            return COLLAB_LABELS[choice], collab_value, None
        revision = int(current.get("revision", 0)) + 1
        entry["collab"] = {"value": collab_value, "revision": revision, "at": at}
        hand_off(collab_record(opportunity_id, entry.get("intention_id"), collab_value, revision, at), home, now)
        return COLLAB_LABELS[choice], collab_value, revision
    value_text = PLANNED_VALUES[choice]
    current = entry.get("planned") or {}
    if current.get("value") == value_text:
        return PLANNED_LABELS[choice], value_text, None
    revision = int(current.get("revision", 0)) + 1
    entry["planned"] = {"value": value_text, "revision": revision, "at": at}
    hand_off(planned_record(opportunity_id, entry.get("intention_id"), value_text, revision, at), home, now)
    return PLANNED_LABELS[choice], value_text, revision


def make_handler(adapter: Any = None, *, make_button: Callable[[str, str], Any], make_markup: Callable[[list], Any],
                 home: Optional[str] = None, clock: Callable[[], float] = time.time, ctx: Any = None,
                 send_next: bool = True) -> Callable[[Any, Any], Awaitable[None]]:
    """The PTB callback for ``avr:`` taps."""

    async def on_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        key: Optional[tuple[str, str]] = None
        recorded = False
        handed_over = False
        try:
            data = getattr(query, "data", None)
            user = _positive_id(getattr(getattr(query, "from_user", None), "id", None))
            message = getattr(query, "message", None)
            chat_obj = getattr(message, "chat", None) if message is not None else None
            raw_chat = getattr(chat_obj, "id", None)
            chat = None if raw_chat is None else str(raw_chat).strip()
            chat_type = getattr(chat_obj, "type", None)
            chat_type = getattr(chat_type, "value", chat_type)
            message_id = getattr(message, "message_id", None) if message is not None else None
            if message is None or message_id is None or not is_owner_tap(adapter, user, chat, chat_type):
                _log("not_owner")
                await _answer(query, NOT_YOURS)
                return
            parsed = parse_callback(data)
            if parsed is None:
                _log("bad_data")
                await _answer(query, BAD_BUTTON)
                return
            card_kind, choice, nonce = parsed
            key = (str(chat), str(message_id))
            if key in _in_flight:
                key = None
                _log("in_flight")
                await _answer(query, IN_FLIGHT)
                return
            _in_flight.add(key)
            now = clock()

            # One synchronous critical section: find, bind, check the window, record, save.
            def take(ledger: dict) -> tuple[str, Any]:
                found = card_for_nonce(ledger, nonce)
                if found is None:
                    return ("unknown_nonce", None), False
                opportunity_id, entry = found
                if str(entry.get("chat_id", "")) != str(chat) or not card_message_matches(entry, card_kind, message_id):
                    return ("message_mismatch", None), False
                if card_closed(entry, card_kind, now):
                    return ("closed", None), False
                if card_kind in (CARD_FIT, CARD_COLLAB) and entry.get(MESSAGE_FIELD[card_kind]) is None:
                    entry[MESSAGE_FIELD[card_kind]] = message_id
                # The first answer to card 1, whatever the rating, sends card 2.
                first = card_kind == CARD_FIT and not entry.get("fit")
                label, _value, revision = record_tap(ledger, opportunity_id, card_kind, choice, now, home)
                if revision is None:
                    return ("already", (opportunity_id, label, first, None)), False
                return ("recorded", (opportunity_id, label, first, revision)), True

            outcome, why = ledger_update(home, lambda ledger: _unwrap(take(ledger)))
            if why is not None:
                _log(f"ledger_{why}")
                await _answer(query, INVALID)
                return
            code, detail = outcome
            if code in ("unknown_nonce", "message_mismatch"):
                _log(code)
                await _answer(query, INVALID)
                return
            if code == "closed":
                _log("closed")
                await _answer(query, CLOSED)
                return
            opportunity_id, label, first, revision = detail
            if code == "already":
                _log(ALREADY)
                await _answer(query, f"Already recorded: {label}")
                return
            recorded = True
            _log(RECORDED, revision=revision)
            await _answer(query, f"Recorded: {label}")
            handed_over = True  # the steps below release the key
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-rate: tenant=%s outcome=handler_error", tenant_id8())
            if not recorded:
                await _answer(query, FAILED)
            return
        finally:
            # Every early return (closed, already recorded, not this card) frees the card for the next tap.
            if key is not None and not handed_over:
                _in_flight.discard(key)
        # Recorded and answered. Each later step fails on its own; none ever answers FAILED.
        try:
            rows = getattr(getattr(message, "reply_markup", None), "inline_keyboard", None)
            marked = mark_keyboard(rows, data, make_button)
            if marked is not None:
                try:
                    await query.edit_message_reply_markup(reply_markup=make_markup(marked))
                except Exception:  # noqa: BLE001 - a stale card is cosmetic
                    _log("edit_failed")
            if first and send_next:
                await _send_collab(query, message, nonce, opportunity_id, make_button, make_markup, home, now)
            if card_kind != CARD_FIT or first:
                snapshot = claim_injection(home, opportunity_id, now)
                if snapshot:
                    code = await asyncio.to_thread(inject, snapshot, str(snapshot.get("chat_id", "")), ctx)
                    _log(code)

                    def settle(ledger: dict) -> Any:
                        card = ledger["cards"].get(opportunity_id)
                        if card is None or card.get("injected"):
                            return None, False
                        _settle_injection(card, code)
                        return None

                    ledger_update(home, settle)
        except Exception:  # noqa: BLE001
            logger.warning("av-rate: tenant=%s outcome=after_record_error", tenant_id8())
        finally:
            if key is not None:
                _in_flight.discard(key)

    return on_tap


def _unwrap(result: tuple[Any, bool]) -> Any:
    """`take`'s `(outcome, save)` into ledger_update's convention: `outcome` to save, `(outcome, False)` not to."""
    outcome, save = result
    return outcome if save else (outcome, False)


async def _send_collab(query: Any, message: Any, nonce: str, opportunity_id: str, make_button: Callable[[str, str], Any],
                       make_markup: Callable[[list], Any], home: Optional[str], now: float) -> None:
    """Card 2 after card 1's first tap."""
    text = collab_text()
    bot = getattr(message, "get_bot", None)
    bot = bot() if callable(bot) else getattr(query, "bot", None) or getattr(message, "bot", None)
    chat = getattr(getattr(message, "chat", None), "id", None)
    if bot is None or chat is None:
        _log("collab_no_bot")
        _note_send_failed(home, opportunity_id)
        return
    try:
        sent = await bot.send_message(chat_id=chat, text=text, parse_mode="HTML",
                                      reply_markup=make_markup(collab_rows(nonce, make_button)))
    except Exception:  # noqa: BLE001
        _log("collab_send_failed")
        _note_send_failed(home, opportunity_id)
        return
    sent_id = getattr(sent, "message_id", None)

    def note(ledger: dict) -> Any:
        entry = ledger["cards"].get(opportunity_id)
        if entry is None:
            return None, False
        entry["collab_message_id"] = sent_id
        entry["closes_at_collab"] = now_iso(now + WINDOW_S)
        return entry.get("intention_id")

    intention_id, why = ledger_update(home, note)
    if why is not None:
        _log(f"ledger_{why}")
        return
    key = hash_key(home)
    if key is not None:
        hand_off(asked_record(opportunity_id, intention_id, CARD_COLLAB, keyed_hash(key, text), now_iso(now)), home, now)
    _log("collab_sent")


def _note_send_failed(home: Optional[str], opportunity_id: str) -> None:
    """Card 2 is never retried: a failed send lets card 1's answer settle the card for the agent."""

    def note(ledger: dict) -> Any:
        entry = ledger["cards"].get(opportunity_id)
        if entry is None:
            return None, False
        entry["collab_send_failed"] = True
        return None

    ledger_update(home, note)


# --------------------------------------------------------------------------- wiring


def _wire_telegram(application: Any, adapter: Any) -> None:
    """Factory Hermes calls at Telegram connect with the PTB ``Application``; SDK imports stay here."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup  # noqa: PLC0415
    from telegram.ext import CallbackQueryHandler  # noqa: PLC0415

    make_button = lambda text, data: InlineKeyboardButton(text=text, callback_data=data)  # noqa: E731
    make_markup = lambda rows: InlineKeyboardMarkup(rows)  # noqa: E731
    handler = make_handler(adapter, make_button=make_button, make_markup=make_markup, ctx=_CTX)
    application.add_handler(CallbackQueryHandler(handler, pattern=HANDLER_PATTERN, block=False))
    logger.info("av-rate: rating card buttons wired (pattern %s)", HANDLER_PATTERN)

    async def pass_once(*_: Any) -> None:
        await pick_up(application.bot, adapter, make_button, make_markup, ctx=_CTX)

    # PTB's `Application.job_queue` property warns ("No `JobQueue` set up") when the optional
    # job-queue extra is not installed, the common case; read it quietly and fall back below.
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        job_queue = getattr(application, "job_queue", None)
    if job_queue is not None and callable(getattr(job_queue, "run_repeating", None)):
        try:
            job_queue.run_repeating(pass_once, interval=PICKUP_INTERVAL_S, first=5.0, name="av-rate-pickup")
            logger.info("av-rate: pick-up on the job queue every %ss", int(PICKUP_INTERVAL_S))
            return
        except Exception:  # noqa: BLE001 - fall through to the loop task
            logger.info("av-rate: job queue refused; using a loop task")

    async def loop() -> None:
        await asyncio.sleep(5.0)
        while True:
            await pass_once()
            await asyncio.sleep(PICKUP_INTERVAL_S)

    try:
        asyncio.get_running_loop().create_task(loop(), name="av-rate-pickup")
        logger.info("av-rate: pick-up on a loop task every %ss", int(PICKUP_INTERVAL_S))
    except RuntimeError:
        logger.warning("av-rate: no running loop at wire time; cards are sent on taps only")


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint: one scoped Telegram callback handler and the pick-up. No tools."""
    global _CTX
    _CTX = ctx
    try:
        wire = getattr(ctx, "register_platform_handler", None)
        if callable(wire):
            wire("telegram", _wire_telegram)
            return
        legacy = getattr(ctx, "register_telegram_handler", None)
        if callable(legacy):
            legacy(_wire_telegram)
            return
        logger.warning("av-rate: this Hermes has no platform handler registration; cards are off")
    except Exception:  # noqa: BLE001
        logger.warning("av-rate: could not register the rating card handler", exc_info=True)


__all__ = [
    "CALLBACK_DATA_MAX_BYTES", "CARD_COLLAB", "CARD_FIT", "CARD_PLANNED", "CHANNEL", "EMOJI", "EVENING_JOB_NAMES", "INJECT_ATTEMPTS_MAX", "LABELS",
    "MANAGE_LINE", "PRIVACY_LINE", "QUIET_DEFAULT_WINDOW", "SCALE", "STAGE_MAX_AGE_S", "WINDOW_HOURS", "asked_record",
    "card_message_matches", "cards_on", "evening_job_state", "fit_callback", "fit_rows", "fit_text", "hand_off", "hash_key",
    "collab_callback", "collab_closed", "collab_record", "collab_rows", "collab_text", "in_window", "injected_line", "is_owner_tap", "ledger_path", "ledger_update", "load_ledger", "make_handler", "make_nonce",
    "mark_keyboard", "parse_callback", "parse_window", "pick_up", "planned_callback", "planned_closed", "planned_record",
    "quiet_delivery", "quiet_hours", "rated_record", "ready_to_inject", "record_tap", "register",
    "save_ledger", "session_key_for", "stage_dir", "events_dir", "team_tenant", "valid_stage",
]
