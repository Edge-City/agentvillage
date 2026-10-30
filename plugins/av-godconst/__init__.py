"""av-godconst: the resident's God Constitution ballot as Telegram button cards (GC-TELEGRAM-BALLOT).

Design: docs/GODCONST-TELEGRAM-BALLOT.md. The resident's own bot sends the statements of the open rating pool in the
resident's own order (the app's), PAGE_SIZE at a time (a pair: with the app's godconst-order-v2, one agent-written and
one ODIN-written statement, in a random inside order per resident), each with five buttons 1..5. A tap is a rating
saved on the SAME ballot the /constitution page shows; the next pair arrives once the current one is rated; a re-tap
is a revision; "rate as many as you can" (unrated = no opinion).

**The data path.** The box never reaches the app and holds no app credential. It calls its control plane with its
own ballot key (``CONTROL_PLANE_URL`` pinned to ``CP_HOSTS``, ``Authorization: Bearer $AV_GODCONST_BALLOT_KEY``, a
per-tenant credential custody keeps from every agent-run child; the ask-village wire otherwise): ``POST /tenants/<own tenant>/godconst/ballot`` (read), ``.../ballot/rate`` (one tap) and ``.../ballot/submit`` (Submit), one path per op (``OP_PATHS``). The control
plane authenticates the key against this tenant, checks its switches and research consent, and forwards with the
GODCONST bridge key and the authenticated tenant id; the app maps that tenant to its one resident and applies every
GODCONST rule (cohort, take-part consent, pool phase, order, ballot) on every call. So every send follows a fresh read
and every tap is re-checked end to end.

**Nothing private on disk.** Statement texts and rating values pass through memory on their way to Telegram and are
never written: the ledger (``$HERMES_HOME/av-godconst/ballot.json``, 0600 in a 0700 directory) holds the pool id and
hash, the order's statement ids, message ids and the positions known rated; no value and no derivative of one (the
check a card shows is kept in memory only, ``_SHOWN``). When the ballot ends here (submitted, closed, the window over,
withdrawn), the session is deleted and only a tombstone stays (the pool hash, the nonce and the ending), so a later
tap answers why it no longer saves. Nothing is
injected into the agent's session and the agent's tools never see a card or a tap (the Bot API's own sends are not
updates, and the ``^gcb:`` handler answers every tap before Hermes's core): the experiment's agent ballots and
snapshots stay blind to the resident's ratings.

**Wiring** (Hermes v2026.9.24, av-vote's and av-rate's): ``ctx.register_platform_handler("telegram", factory)``; one
``CallbackQueryHandler`` scoped to ``^gcb:`` with ``block=False``; a pass every ``PASS_INTERVAL_S`` on PTB's job queue,
else an asyncio task. The pass reads (at most every ``POLL_ACTIVE_S`` while a ballot is open on this box, else every
``POLL_IDLE_S``) and then starts, advances, re-marks or ends the cards.

**Taps**: owner only (the box's own resident in their own DM: av-vote's rule); the card's session nonce must be the
ledger's; the save goes to the control plane; the answer is "Saved: <label>", the card's tapped button is marked, and
a page fully rated sends the next one. A failed save answers a short reason and leaves the card as it is.

**Switch.** ``AV_GODCONST_BALLOT`` (``1|true|yes|on``; process environment, else ``$HERMES_HOME/.env``), written by the
control plane from ``GODCONST_BALLOT_TENANTS``. Off: nothing is read or sent; taps still answer (the control plane is
the authority and refuses when the route is off). Logs: ``av-godconst: tenant=<id8> outcome=<code> [k=v]``, codes and
counts only; never a statement, a text, a rating, a user id, a key or callback data.

**Non-voter elicitation cards** (GC-ELICIT §11.4; section "Non-voter elicitation cards" of the design doc): a second,
independent mode behind ``AV_GODCONST_ELICIT_CARDS`` (exactly ``1``). When the control plane writes
``$HERMES_HOME/av-events/godconst/elicit-cards.json`` after a non-voter's elicitation window settles, and no av-elicit
opener is pending, the box offers those statements as ``gce:`` cards (its own handler, ledger ``av-godconst/elicit.json``
and tombstones); each tap saves one rating on the elicitation's own ratings via ``.../godconst/elicitation-ratings``.
It never touches the ballot, and the shared page-open marker stays while either mode has an open page.

**THOR nudge card** (third, independent mode; data's ODIN-THOR-NUDGES design section 5, product copy
THOR-NUDGE-CARD-COPY-2026-10-29): on while the box holds its ``AV_THOR_KEY`` (absent: no read, no card;
``THOR_NUDGES_ENABLED`` is the control plane's flag, enforced there by an empty answer), the same pass reads
``GET /tenants/<own tenant>/thor/today`` at most once per UTC day in village daytime and sends at most one card from the
resident's own bot (Do it / Not now / Not for me, ``avt:`` buttons, its own handler and ledger ``av-godconst/thor.json``);
a tap posts the answer to ``.../thor/<item_key>/answer`` and shows the copy file's follow-up line. No approval class, no
consent step, no gate; nothing injected into the agent's session; the control plane serves an intro's B card itself.

Python 3.11, standard library only; the Telegram SDK is imported inside the factory.
"""

from __future__ import annotations

import asyncio
import html
import http.client
import json
import logging
import os
import re
import secrets
import stat
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings
from typing import Any, Callable, Optional

try:
    from . import _logic as L
except ImportError:  # loaded by path without a package (a local run)
    import importlib.util as _ilu

    _spec = _ilu.spec_from_file_location("av_godconst_logic", os.path.join(os.path.dirname(os.path.abspath(__file__)), "_logic.py"))
    L = _ilu.module_from_spec(_spec)  # type: ignore[arg-type]
    _spec.loader.exec_module(L)  # type: ignore[union-attr]

try:
    from . import _thor as T
except ImportError:  # loaded by path without a package (a local run)
    import importlib.util as _ilu

    _tspec = _ilu.spec_from_file_location("av_godconst_thor", os.path.join(os.path.dirname(os.path.abspath(__file__)), "_thor.py"))
    T = _ilu.module_from_spec(_tspec)  # type: ignore[arg-type]
    _tspec.loader.exec_module(T)  # type: ignore[union-attr]

logger = logging.getLogger(__name__)

PLUGIN_ID = "av-godconst"
ON_SWITCH = "AV_GODCONST_BALLOT"
#: The non-voter elicitation cards' own switch (GC-ELICIT §11.4), written by the control plane for the tenants in
#: GODCONST_ELICIT_TENANTS. On only when exactly ``1``; independent of ON_SWITCH.
ELICIT_SWITCH = "AV_GODCONST_ELICIT_CARDS"
URL_ENV = "CONTROL_PLANE_URL"
#: The per-tenant ballot credential the control plane writes (godconst-ballot-key.js). Never EDGEOS_API_KEY: the agent
#: can read that one. av-approval custody strips this name from every agent-run child (custody_keys.json, FLOOR), so
#: only this plugin, inside the gateway, holds it.
CREDENTIAL_ENV = "AV_GODCONST_BALLOT_KEY"
HOME_CHANNEL_ENV = "TELEGRAM_HOME_CHANNEL"
TENANT_ENVS = ("AV_TENANT_ID", "TENANT_ID")
TRUTHY = frozenset({"1", "true", "yes", "on"})
#: av-events _pray.CP_HOSTS (directory.ts): the only hosts the ballot key is sent to over https.
CP_HOSTS = frozenset({"control-plane-production-606c.up.railway.app"})
LOOPBACK_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})
READ_PATH = "/tenants/{tenant}/godconst/ballot"
RATE_PATH = "/tenants/{tenant}/godconst/ballot/rate"
SUBMIT_PATH = "/tenants/{tenant}/godconst/ballot/submit"
#: The control plane routes by PATH (index.js: ``.../ballot`` is the read, ``.../ballot/rate`` and ``.../ballot/submit``
#: their ops) and holds each op to its exact body (godconst-ballot.js parseBody). One path per op; an op with no path
#: raises in cp_call and never falls back to another route (ov#483 M1: Submit went to /rate and got 400 body_invalid).
ELICIT_READ_PATH = "/tenants/{tenant}/godconst/elicitation-cards"
ELICIT_RATE_PATH = "/tenants/{tenant}/godconst/elicitation-ratings"
OP_PATHS = {"read": READ_PATH, "rate": RATE_PATH, "submit": SUBMIT_PATH,
            "elicit_read": ELICIT_READ_PATH, "elicit_rate": ELICIT_RATE_PATH}
HTTP_TIMEOUT_S = 12.0
RESPONSE_MAX_BYTES = 2 * 1024 * 1024

PASS_INTERVAL_S = 60.0
#: How often the pass reads while a ballot is open here (web changes, the close) and otherwise (a pool opening).
POLL_ACTIVE_S = 300.0
POLL_IDLE_S = 600.0
#: A card whose send keeps failing (bot blocked, chat gone) stops the session after this many passes in a row.
SEND_FAILURES_MAX = 3
#: Re-marks (a web change shown on a sent card) per pass at most.
REMARKS_PER_PASS = 10
SEND_GAP_S = 0.35
LEDGER_MAX_BYTES = 256 * 1024
DIR_MODE = 0o700
FILE_MODE = 0o600
ANSWER_MAX = 200
_TELEGRAM_USER = re.compile(r"[1-9][0-9]{0,19}")
_TENANT = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

#: Session statuses. `active`: cards go out; `stopped`: the resident pressed Stop (taps still save); the rest are final
#: for this pool: `done` (every page sent and the last line too), `submitted`, `closed`, `withdrawn`, `undeliverable`.
ACTIVE, STOPPED = "active", "stopped"
FINAL = frozenset({"done", "submitted", "closed", "withdrawn", "undeliverable"})
#: The endings that delete the session (a tombstone stays): nothing about this ballot is kept on the box after them.
ENDINGS = frozenset({"submitted", "closed", "withdrawn"})

NOT_YOURS = "This card is not yours"
BAD_BUTTON = "This button is not valid."
OLD_CARD = "This card is from an earlier ballot."
IN_FLIGHT = "Still saving..."
CLOSED = "Rating has closed."
SUBMITTED = "Your ballot is submitted, so rating is closed for you."
WITHDRAWN = "You can't take part right now."
OFF = "Rating by Telegram is off right now. You can still rate on the Constitution page."
FAILED = "Could not save that. Tap again, or use the Constitution page."
REFUSAL_TEXT = {
    "submitted": SUBMITTED, "pool_not_rating": CLOSED, "stale_pool": CLOSED, "closed": CLOSED,
    "consent_withdrawn": WITHDRAWN, "research_grant_required": WITHDRAWN, "research_consent_required": WITHDRAWN,
    "not_enabled": OFF, "not_found": WITHDRAWN, "unauthorized": OFF,
}
#: The refusal codes that end this box's session for the pool, and how.
REFUSAL_STATUS = {
    "submitted": "submitted", "pool_not_rating": "closed", "stale_pool": "closed",
    "consent_withdrawn": "withdrawn", "research_grant_required": "withdrawn", "research_consent_required": "withdrawn",
    # The app's own 404 (no longer admitted: removed from the cohort, the setup gone); never the control plane's
    # not_enabled (a switch, which can come back).
    "not_found": "withdrawn",
}
ENDED_TEXT = {"submitted": SUBMITTED, "closed": CLOSED, "withdrawn": WITHDRAWN}

_LEDGER_LOCK = threading.RLock()
_SEND_LOCK: Optional[asyncio.Lock] = None
_in_flight: set = set()
_last_read = {"at": 0.0}
#: (nonce, position) -> the value the card's check shows. Memory only: a restart forgets it and re-marks from the app.
_SHOWN: dict = {}


# --------------------------------------------------------------------------- env, paths, logging


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


def _dotenv(home: str) -> dict:
    parsed: dict = {}
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


def ballot_on(home: Optional[str] = None) -> bool:
    return env(ON_SWITCH, home).lower() in TRUTHY


def state_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-godconst")


def ledger_path(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "ballot.json")


def page_open_path(home: Optional[str] = None) -> str:
    """GC-ELICIT coexistence: the empty marker av-elicit (overlay #478) reads to hold its opener while a page is open."""
    return os.path.join(home or hermes_home(), "av-events", "godconst", "page-open")


def page_is_open(session: Optional[dict], now: float) -> bool:
    """A sent page with an unrated card, cards active, inside the window."""
    if not isinstance(session, dict) or session.get("status") != ACTIVE or int(session.get("page", -1)) < 0:
        return False
    closes = L.epoch_from_iso(session.get("closes_at")) if session.get("closes_at") else None
    if closes is not None and now >= closes:
        return False
    rated = set(session.get("rated", []))
    sent = {int(p) for p in session.get("cards", {})}
    return any(p in sent and p not in rated for p in L.page_positions(int(session["page"]), len(session["order"])))


def ballot_page_open_now(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """The ballot mode's page is open, from its ledger as it is on disk (no lock: writes are atomic renames)."""
    try:
        ledger, why = load_ledger(home)
        return why is None and page_is_open(ledger.get("session"), time.time() if now is None else now)
    except Exception:  # noqa: BLE001 - a ledger of the wrong types: unknown, so not open
        _log("page_marker_unknown", mode="ballot")
        return False


def set_page_open(is_open: bool, home: Optional[str] = None, touch: bool = False) -> None:
    """The ballot mode's say on the shared marker: kept while either mode has an open page (the elicitation cards'
    page is read from their ledger), so neither mode removes the other's hold."""
    _write_marker(is_open or elicit_page_open_now(home), home, touch)


def set_elicit_page_open(is_open: bool, home: Optional[str] = None, touch: bool = False) -> None:
    """The elicitation cards' say on the shared marker (the ballot's page read from its ledger)."""
    _write_marker(is_open or ballot_page_open_now(home), home, touch)


def _write_marker(is_open: bool, home: Optional[str] = None, touch: bool = False) -> None:
    """Create (empty, 0600, in a 0700 directory) or remove the marker; `touch` refreshes its mtime (each page sent: the
    av-elicit plugin ignores a marker older than 12 h, so a page left open long ago never holds the opener). Never
    raises."""
    path = page_open_path(home)
    try:
        if is_open:
            if not os.path.lexists(path):
                os.makedirs(os.path.dirname(path), mode=DIR_MODE, exist_ok=True)
                os.close(os.open(path, os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), FILE_MODE))
            elif touch:
                os.utime(path, None, follow_symlinks=False)
        elif os.path.lexists(path):
            os.unlink(path)
    except OSError:
        _log("page_marker_unwritable")


def reconcile_page_open(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """At plugin start: keep the marker only while the ledger shows an open page inside the window (a crash or a
    restart never leaves it stale). True when it is kept."""
    stamp = time.time() if now is None else now
    with _LEDGER_LOCK:
        keep = ballot_page_open_now(home, stamp) or elicit_page_open_now(home, stamp)
    _write_marker(keep, home)
    return keep


def tenant_id(home: Optional[str] = None) -> Optional[str]:
    for name in TENANT_ENVS:
        value = env(name, home).lower()
        if _TENANT.fullmatch(value):
            return value
    return None


def tenant_id8() -> str:
    for name in TENANT_ENVS:
        value = os.environ.get(name, "").strip()
        if value:
            return re.sub(r"[^A-Za-z0-9-]", "", value)[:8]
    return "-"


def _log(outcome: str, **counts: Any) -> None:
    extra = "".join(f" {key}={value}" for key, value in sorted(counts.items()))
    logger.info("av-godconst: tenant=%s outcome=%s%s", tenant_id8(), outcome, extra)


def now_iso(epoch: Optional[float] = None) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() if epoch is None else epoch))


# --------------------------------------------------------------------------- private files


def _uid() -> Optional[int]:
    return os.getuid() if hasattr(os, "getuid") else None


def _private_dir(path: str) -> bool:
    try:
        st = os.lstat(path)
    except OSError:
        return False
    uid = _uid()
    return stat.S_ISDIR(st.st_mode) and (uid is None or st.st_uid == uid) and not st.st_mode & 0o077


def _read_private(path: str, max_bytes: int) -> tuple:
    """`(data, None)` or `(None, code)`: missing, bad_dir, not_regular, foreign_owner, not_private, too_big, unreadable."""
    if not os.path.lexists(path):
        return None, "missing"
    if not _private_dir(os.path.dirname(path)):
        return None, "bad_dir"
    try:
        st = os.lstat(path)
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
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
        with os.fdopen(fd, encoding="utf-8") as handle:
            opened = os.fstat(handle.fileno())  # what is read is what was checked (no swap between lstat and open)
            if not stat.S_ISREG(opened.st_mode):
                return None, "not_regular"
            if opened.st_size > max_bytes:
                return None, "too_big"
            return json.loads(handle.read(max_bytes + 1)), None
    except (OSError, ValueError):
        return None, "unreadable"


def _write_private(path: str, data: Any) -> None:
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


# --------------------------------------------------------------------------- the ledger


def empty_ledger() -> dict:
    return {"v": 1, "session": None}


def load_ledger(home: Optional[str] = None) -> tuple:
    """`(ledger, None)`; `(empty, "missing")` when there is none yet; `(empty, code)` when it cannot be trusted (then
    nothing is written over it and nothing is sent)."""
    data, why = _read_private(ledger_path(home), LEDGER_MAX_BYTES)
    if why is not None:
        return empty_ledger(), why
    if not isinstance(data, dict) or data.get("v") != 1 or not (data.get("session") is None or isinstance(data.get("session"), dict)):
        return empty_ledger(), "bad_shape"
    return data, None


def save_ledger(ledger: dict, home: Optional[str] = None) -> None:
    _write_private(ledger_path(home), ledger)


def end_session(ledger: dict, status: str, home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """Delete the session (order, cards, rated positions) and keep a tombstone: the pool hash, the nonce and the ending.
    True when there was a session to end. The caller holds no lock; this takes it."""
    session = ledger.get("session")
    if not isinstance(session, dict):
        return False
    for key in [k for k in _SHOWN if k[0] == session.get("nonce")]:
        _SHOWN.pop(key, None)
    ledger.clear()
    ledger.update({"v": 1, "session": None, "ended": {"pool_sha256": session.get("pool_sha256"), "nonce": session.get("nonce"),
                                                      "status": status, "at": now_iso(now)}})
    with _LEDGER_LOCK:
        save_ledger(ledger, home)
    set_page_open(False, home)
    _log("ended", status=status)
    return True


def ended_for(ledger: dict, nonce: Optional[str] = None, pool_sha256: Optional[str] = None) -> Optional[str]:
    """The ending recorded for this nonce (a tap) or this pool (a read), else None."""
    ended = ledger.get("ended")
    if not isinstance(ended, dict):
        return None
    if nonce is not None and ended.get("nonce") == nonce or pool_sha256 is not None and ended.get("pool_sha256") == pool_sha256:
        status = ended.get("status")
        return status if status in ENDINGS else None
    return None


def new_session(view: dict, now: float) -> dict:
    """A session for the view's pool: ids and positions only (never a text or a value)."""
    pool = view["pool"]
    return {
        "pool_id": pool["id"], "pool_sha256": pool["sha256"], "order_rule": pool["order_rule"],
        "nonce": secrets.token_urlsafe(6)[: L.NONCE_CHARS].replace("=", "A"),
        "order": [s["id"] for s in view["statements"]], "closes_at": pool["closes_at"],
        "status": ACTIVE, "started_at": now_iso(now), "header_message_id": None,
        "page": -1, "cards": {}, "rated": [], "final_sent": False, "send_failures": 0,
    }


# --------------------------------------------------------------------------- the control plane


def cp_origin(raw: str) -> Optional[str]:
    """av-events _pray.cp_origin: https on a CP_HOSTS host (port 443), no userinfo, path, query or fragment; plain http
    only to a loopback host (tests, local runs)."""
    if not raw or "?" in raw or "#" in raw or any(ord(ch) <= 0x20 or ord(ch) == 0x7F for ch in raw):
        return None
    try:
        parts = urllib.parse.urlsplit(raw)
        host = (parts.hostname or "").lower()
        port = parts.port
    except ValueError:
        return None
    if not host or parts.username is not None or parts.password is not None or parts.path not in ("", "/"):
        return None
    if parts.scheme == "https" and host in CP_HOSTS and port in (None, 443):
        return f"https://{host}"
    if parts.scheme == "http" and host in LOOPBACK_HOSTS:
        return f"http://{parts.netloc}"
    return None


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: Any, **kwargs: Any) -> None:  # noqa: D401 - never follow
        return None


_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect)


class Reply:
    """`status` and `data` when the control plane answered; `code` is the answer's closed code (`state` on a 200,
    `error` on a refusal) or a transport failure (`not_configured`, `network`, `timeout`, `bad_response`)."""

    __slots__ = ("status", "data", "code")

    def __init__(self, status: Optional[int], data: Optional[dict], code: str) -> None:
        self.status, self.data, self.code = status, data, code

    @property
    def ok(self) -> bool:
        return self.status == 200 and self.data is not None


def cp_call(op: str, body: dict, home: Optional[str] = None) -> Reply:
    """One POST to the control plane (blocking; called through asyncio.to_thread) to the op's own path (``OP_PATHS``).
    Never raises for the network or the answer; an op with no path raises ValueError (a programming error) before
    anything is read or sent."""
    path = OP_PATHS.get(op) if isinstance(op, str) else None
    if path is None:
        raise ValueError("av-godconst: no control-plane route for this op")
    origin = cp_origin(env(URL_ENV, home))
    key = env(CREDENTIAL_ENV, home)
    tenant = tenant_id(home)
    if origin is None or not key or tenant is None:
        return Reply(None, None, "not_configured")
    url = origin + path.format(tenant=tenant)
    request = urllib.request.Request(url, data=json.dumps(body, separators=(",", ":")).encode("utf-8"), method="POST",
                                     headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": f"Bearer {key}"})
    try:
        with _OPENER.open(request, timeout=HTTP_TIMEOUT_S) as response:
            status, raw = int(getattr(response, "status", 0) or 0), response.read(RESPONSE_MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = int(error.code)
        try:
            raw = error.read(RESPONSE_MAX_BYTES + 1)
        except Exception:  # noqa: BLE001
            raw = b""
    except (TimeoutError, OSError, http.client.HTTPException, ValueError) as error:
        return Reply(None, None, "timeout" if "timed out" in str(error).lower() or isinstance(error, TimeoutError) else "network")
    if len(raw) > RESPONSE_MAX_BYTES:
        return Reply(status, None, "bad_response")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        data = None
    if not isinstance(data, dict):
        return Reply(status, None, "bad_response" if status == 200 else f"http_{status}")
    code = data.get("state") if status == 200 else data.get("error")
    code = code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else ("bad_response" if status == 200 else f"http_{status}")
    return Reply(status, data, code)


# --------------------------------------------------------------------------- owner (av-vote's rule)


def _positive_id(value: Any) -> Optional[str]:
    text = str(value).strip() if isinstance(value, (int, str)) and not isinstance(value, bool) else ""
    return text if _TELEGRAM_USER.fullmatch(text) else None


def _home_field(adapter: Any, fields: tuple) -> list:
    found = []
    try:
        home = getattr(getattr(adapter, "config", None), "home_channel", None)
        for field in fields:
            value = home.get(field) if isinstance(home, dict) else getattr(home, field, None)
            ident = _positive_id(value) if value is not None else None
            if ident:
                found.append(ident)
    except Exception:  # noqa: BLE001 - an unreadable config falls back to the env
        pass
    return found


def owner_ids(adapter: Any = None) -> set:
    found = set(_home_field(adapter, ("user_id", "chat_id")))
    env_id = _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))
    if env_id:
        found.add(env_id)
    return found


def home_chat_id(adapter: Any = None) -> Optional[str]:
    """Where the cards go: the home channel's positive chat id, else its user id, else TELEGRAM_HOME_CHANNEL."""
    found = _home_field(adapter, ("chat_id", "user_id"))
    return found[0] if found else _positive_id(os.environ.get(HOME_CHANNEL_ENV, ""))


def paired_on_box(user: str) -> bool:
    try:
        from gateway.pairing import PairingStore  # noqa: PLC0415 - Hermes, in-process on a box

        return bool(PairingStore().is_approved("telegram", user))
    except Exception:  # noqa: BLE001
        return False


def is_owner_tap(adapter: Any, user: Optional[str], chat: Optional[str], chat_type: Optional[str]) -> bool:
    if user is None or (chat is not None and chat != user):
        return False
    if isinstance(chat_type, str) and chat_type and chat_type != "private":
        return False
    if user in owner_ids(adapter):
        return True
    return chat is not None and paired_on_box(user)


# --------------------------------------------------------------------------- sending


def _send_lock() -> asyncio.Lock:
    global _SEND_LOCK
    if _SEND_LOCK is None:
        _SEND_LOCK = asyncio.Lock()
    return _SEND_LOCK


async def _send(bot: Any, chat: str, text: str, markup: Any = None) -> Optional[int]:
    """One message; its id, or None when Telegram refused or failed (blocked bot, network)."""
    try:
        message = await bot.send_message(chat_id=int(chat), text=text, parse_mode="HTML", reply_markup=markup, disable_web_page_preview=True)
    except Exception:  # noqa: BLE001
        return None
    return getattr(message, "message_id", None) or 0


async def _send_page(bot: Any, chat: str, session: dict, view: dict, page: int, rated: set, home: Optional[str],
                     make_button: Callable, make_markup: Callable, count: Callable) -> bool:
    """The page's unrated cards (texts from the fresh read, never the ledger). True when every card went out."""
    n = len(session["order"])
    texts = {s["id"]: s for s in view["statements"]}
    positions = L.to_send(page, n, rated, session["cards"].keys())
    for position in positions:
        submit = position == positions[-1]
        sid = session["order"][position]
        statement = texts.get(sid)
        if statement is None:
            count("order_mismatch")
            return False
        label = view["categories"].get(statement["category"], "Other")
        message_id = await _send(bot, chat, L.card_text(position, n, label, statement["text"]),
                                 make_markup(L.rating_rows(session["nonce"], position, make_button, submit=submit)))
        if message_id is None:
            return False
        session["cards"][str(position)] = {"message_id": message_id, "submit": submit}
        _SHOWN[(session["nonce"], position)] = None
        set_page_open(True, home, touch=True)
        count("card_sent")
        await asyncio.sleep(SEND_GAP_S)
    session["page"] = max(int(session["page"]), page)
    return True


async def sync(bot: Any, adapter: Any, view: dict, make_button: Callable, make_markup: Callable,
               home: Optional[str] = None, now: Optional[float] = None, tick: bool = True) -> dict:
    """Apply a fresh read to this box's cards: start, advance, re-mark, end, or settle. Returns code -> count; never
    raises. The caller has checked the switch; texts and values in `view` are used here and never written. `tick`:
    a pass drives it (every send waits for village daytime); False for the reply to the resident's own tap."""
    codes: dict = {}
    stamp = time.time() if now is None else now

    def count(code: str, n: int = 1) -> None:
        codes[code] = codes.get(code, 0) + n

    try:
        async with _send_lock():
            await _sync_locked(bot, adapter, view, make_button, make_markup, home, stamp, count, tick)
    except Exception:  # noqa: BLE001
        logger.warning("av-godconst: tenant=%s outcome=sync_error", tenant_id8())
        count("sync_error")
    if codes:
        _log("sync", **codes)
    return codes


async def _sync_locked(bot: Any, adapter: Any, view: dict, make_button: Callable, make_markup: Callable,
                       home: Optional[str], now: float, count: Callable, tick: bool = True) -> None:
    with _LEDGER_LOCK:
        ledger, why = load_ledger(home)
    if why not in (None, "missing"):
        count(f"ledger_{why}")
        return
    session = ledger.get("session")
    # What this pass loaded: each write-back merges into the ledger as it is then (S1, `_store`).
    base = {"nonce": session.get("nonce"), "status": session.get("status")} if isinstance(session, dict) else {"nonce": None, "status": None}
    state = view["state"]
    pool = view.get("pool")
    same_pool = session is not None and pool is not None and session["pool_sha256"] == pool["sha256"]
    if state in ("closed", "no_pool", "not_participant") or (state == "submitted" and not same_pool):
        if session is not None and state == "closed" and end_session(ledger, "closed", home, now):
            count("ended_closed")
        return
    if state == "submitted":
        if end_session(ledger, "submitted", home, now):
            count("ended_submitted")
        return
    # state == "open"
    if not same_pool and ended_for(ledger, pool_sha256=pool["sha256"]):
        count("ended_here")  # this pool's ballot ended on this box: never restarted
        return
    chat = home_chat_id(adapter)
    if chat is None:
        count("no_home_chat")
        return
    closes = L.epoch_from_iso(pool["closes_at"]) if pool["closes_at"] else None
    if same_pool and closes is not None and now >= closes:
        end_session(ledger, "closed", home, now)
        count("ended_window")
        return
    if not same_pool:
        # A new pool (or none before): start, in village daytime, inside the window, unless all is rated already.
        if closes is not None and now >= closes:
            count("window_over")
            return
        if not L.in_send_window(now):  # a new ballot's first card: daytime, tick or tap
            count("waiting_daytime")
            return
        session = new_session(view, now)
        ledger.pop("ended", None)
        ledger["session"] = session
        rated = L.rated_positions(session["order"], view["ratings"])
        session["rated"] = sorted(rated)
        if len(rated) == len(session["order"]):
            session["status"] = "done"
            count("all_rated_on_web")
            _store(ledger, home, now, base)
            return
        header = await _send(bot, chat, L.header_text(len(session["order"]), closes),
                             make_markup(L.control_rows(session["nonce"], make_button, stopped=False)))
        if header is None:
            count("send_failed")
            return  # nothing kept: the next pass starts again
        session["header_message_id"] = header
        _store(ledger, home, now, base)
        count("started")
        _log("order", rule=session["order_rule"], n=len(session["order"]))
    if session["order"] != [s["id"] for s in view["statements"]]:
        # The app's order for this pool never changes; a different one is a fault, never re-sent.
        count("order_changed")
        return
    rated = L.rated_positions(session["order"], view["ratings"])
    session["rated"] = sorted(rated)
    await _remark(bot, chat, session, view, make_button, make_markup, count)
    # The re-marks awaited: a tap may have stopped, resumed or ended the session meanwhile; the merge takes it in.
    if not _store(ledger, home, now, base) or session["status"] != ACTIVE:
        return
    await _advance(bot, chat, session, view, rated, closes, now, home, make_button, make_markup, count, tick)
    _store(ledger, home, now, base)


def _store(ledger: dict, home: Optional[str], now: Optional[float], base: dict) -> bool:
    """The pass's write-back (ov#483 S1). The pass holds its copy of the ledger across awaits (sends, edits) while a tap
    can Stop, Resume, submit or end the session (those write under ``_LEDGER_LOCK`` only), and pass_once's endings run
    outside the send lock. So a session the pass loaded is never written back whole: the ledger is re-read under the
    lock and only the pass's own fields are merged into it (the cards it sent with their message ids, the page, the
    final line, its send failures, the rated positions). The status is the pass's (its own ``done`` /
    ``undeliverable``) only while the ledger's is still the one the pass loaded, so a Stop or Resume made meanwhile
    stands, and a session ended or replaced meanwhile is never brought back (nor its page-open marker). Smaller than
    taking the send lock in every other writer (Stop/Resume, Submit, each refusal, the tap's window close, the tap's
    rated positions, pass_once's endings): one place, and no tap waits behind a pass's sends. A session this pass
    started is written whole (no tap can know its nonce before this write).
    True when the pass's session is still the ledger's; the pass's `session` then holds the merged copy."""
    session = ledger.get("session")
    stamp = time.time() if now is None else now
    with _LEDGER_LOCK:
        if not isinstance(session, dict) or session.get("nonce") != base["nonce"]:
            save_ledger(ledger, home)
            current: Optional[dict] = session
        else:
            disk, why = load_ledger(home)
            current = disk.get("session") if why is None else None
            if isinstance(current, dict) and current.get("nonce") == session["nonce"]:
                if current.get("status") == base["status"]:
                    current["status"] = session["status"]
                current["cards"] = {**(current.get("cards") or {}), **session["cards"]}
                current["page"] = max(int(current.get("page", -1)), int(session["page"]))
                current["final_sent"] = bool(current.get("final_sent")) or bool(session["final_sent"])
                current["send_failures"] = int(session.get("send_failures", 0))
                current["rated"] = sorted(set(current.get("rated") or []) | set(session["rated"]))
                save_ledger(disk, home)
                session.update(current)
                current = session
            else:
                _log("store_skipped", code="session_changed" if why is None else f"ledger_{why}")
                current = None
    set_page_open(page_is_open(current, stamp), home)
    if current is None:
        return False
    base["nonce"], base["status"] = current["nonce"], current["status"]
    return True


async def _advance(bot: Any, chat: str, session: dict, view: dict, rated: set, closes: Optional[float], now: float, home: Optional[str],
                   make_button: Callable, make_markup: Callable, count: Callable, tick: bool = True) -> None:
    # ov#483 N2: a send a pass makes (a tick) goes only in village daytime, 08:00-21:30 IST, like the first card: the
    # next pair after a pair finished on the web page, a failed card's retry, the final line, the cards after a Resume.
    # The reply to the resident's own tap (`tick` False: the next pair, or the final line, after they rated this pair)
    # is not a tick send: they are at the phone right now, so it goes at once at any hour.
    def held() -> bool:
        if tick and not L.in_send_window(now):
            count("waiting_daytime")
            return True
        return False

    n = len(session["order"])
    page = int(session["page"])
    # The current page first: a card of it that never went out (a failed send) goes now.
    if page >= 0 and L.to_send(page, n, rated, session["cards"].keys()):
        if held():
            return
        if not await _send_page(bot, chat, session, view, page, rated, home, make_button, make_markup, count):
            _send_failed(session, count)
            return
    if not L.page_done(page, n, rated):
        return
    nxt = L.next_page(page, n, rated)
    if nxt is None:
        if not session["final_sent"]:
            if held():
                return
            text = L.done_text(n) if len(rated) == n else L.end_text(len(rated), n)
            if await _send(bot, chat, text, make_markup(L.submit_rows(session["nonce"], make_button))) is None:
                _send_failed(session, count)
                return
            session["final_sent"] = True
            session["status"] = "done"
            count("final_sent")
        return
    if closes is not None and now >= closes:
        count("window_over")
        return
    if held():
        return
    if await _send_page(bot, chat, session, view, nxt, rated, home, make_button, make_markup, count):
        session["send_failures"] = 0
        count("page_sent")
    else:
        _send_failed(session, count)


def _send_failed(session: dict, count: Callable) -> None:
    session["send_failures"] = int(session.get("send_failures", 0)) + 1
    count("send_failed")
    if session["send_failures"] >= SEND_FAILURES_MAX:
        session["status"] = "undeliverable"
        count("settled_undeliverable")


async def _remark(bot: Any, chat: str, session: dict, view: dict, make_button: Callable, make_markup: Callable, count: Callable) -> None:
    """A sent card whose check differs from the ballot (a change on the web page, or unknown after a restart) gets its
    keyboard redrawn from the app's value. What a card shows is remembered in memory only (``_SHOWN``)."""
    edits = 0
    for position, card in list(session["cards"].items()):
        if edits >= REMARKS_PER_PASS:
            break
        sid = session["order"][int(position)]
        value = view["ratings"].get(sid)
        key = (session["nonce"], int(position))
        if key in _SHOWN and _SHOWN[key] == value:
            continue
        try:
            await bot.edit_message_reply_markup(chat_id=int(chat), message_id=int(card["message_id"]),
                                                reply_markup=make_markup(L.rating_rows(session["nonce"], int(position), make_button, value, submit=bool(card.get("submit")))))
        except Exception:  # noqa: BLE001 - "message is not modified", a deleted card: remembered anyway
            count("remark_failed")
        _SHOWN[key] = value
        edits += 1
        count("remarked")


# --------------------------------------------------------------------------- the pass


async def pass_once(bot: Any, adapter: Any, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                    now: Optional[float] = None, reader: Optional[Callable] = None) -> str:
    """One pass: read when due, then sync. Returns a code; never raises."""
    stamp = time.time() if now is None else now
    try:
        if not ballot_on(home):
            return "off"
        with _LEDGER_LOCK:
            ledger, why = load_ledger(home)
        if why not in (None, "missing"):
            _log(f"ledger_{why}")
            return f"ledger_{why}"
        session = ledger.get("session")
        closes = L.epoch_from_iso(session.get("closes_at")) if session is not None and session.get("closes_at") else None
        if closes is not None and stamp >= closes:
            end_session(ledger, "closed", home, stamp)  # the pool's rating window is over: nothing of it stays here
            return "window_over"
        live = session is not None and session["status"] in (ACTIVE, STOPPED)
        if stamp - _last_read["at"] < (POLL_ACTIVE_S if live else POLL_IDLE_S):
            return "not_due"
        _last_read["at"] = stamp
        reply = await asyncio.to_thread(reader or cp_call, "read", {}, home)
        if not reply.ok:
            if session is not None and REFUSAL_STATUS.get(reply.code) == "withdrawn":
                end_session(ledger, "withdrawn", home, stamp)
            _log("read_failed", code=reply.code)
            return reply.code
        view = L.valid_view(reply.data)
        if view is None:
            _log("read_bad_shape")
            return "bad_shape"
        await sync(bot, adapter, view, make_button, make_markup, home, stamp)
        return view["state"]
    except Exception:  # noqa: BLE001 - the pass never raises into the gateway
        logger.warning("av-godconst: tenant=%s outcome=pass_error", tenant_id8())
        return "pass_error"


# --------------------------------------------------------------------------- the tap


def _button_fields(button: Any) -> tuple:
    if isinstance(button, dict):
        return str(button.get("text", "")), button.get("callback_data")
    return str(getattr(button, "text", "") or ""), getattr(button, "callback_data", None)


def mark_keyboard(rows: Any, data: str, make_button: Callable, prefix: str = L.PREFIX) -> Optional[list]:
    """The card's keyboard with the check on the tapped button (of `prefix`: ``gcb:``, or ``gce:``) only; None when
    nothing changes."""
    if not rows:
        return None
    found = changed = False
    out = []
    for row in rows:
        new_row = []
        for button in row or ():
            text, callback = _button_fields(button)
            if isinstance(callback, str) and callback.startswith(prefix):
                bare = text[len(L.CHECK):] if text.startswith(L.CHECK) else text
                want = L.CHECK + bare if callback == data else bare
                found = found or callback == data
                if want != text:
                    changed = True
                    new_row.append(make_button(want, callback))
                    continue
            new_row.append(button)
        out.append(new_row)
    return out if found and changed else None


async def _answer(query: Any, text: str) -> None:
    try:
        await query.answer(text=text if len(text) <= ANSWER_MAX else text[: ANSWER_MAX - 3] + "...")
    except Exception:  # noqa: BLE001 - an expired query cannot be answered
        logger.debug("av-godconst: answerCallbackQuery failed")  # no exc_info: an exception can echo the callback data


def make_handler(adapter: Any = None, *, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                 clock: Callable[[], float] = time.time, caller: Optional[Callable] = None) -> Callable:
    """The PTB callback for ``gcb:`` taps."""
    call = caller or cp_call

    async def on_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        key: Optional[tuple] = None
        try:
            data = getattr(query, "data", None)
            user = _positive_id(getattr(getattr(query, "from_user", None), "id", None))
            message = getattr(query, "message", None)
            chat_obj = getattr(message, "chat", None) if message is not None else None
            raw_chat = getattr(chat_obj, "id", None)
            chat = None if raw_chat is None else str(raw_chat).strip()
            chat_type = getattr(chat_obj, "type", None)
            chat_type = getattr(chat_type, "value", chat_type)
            if not is_owner_tap(adapter, user, chat, chat_type):
                _log("not_owner")
                await _answer(query, NOT_YOURS)
                return
            parsed = L.parse_callback(data)
            if parsed is None:
                _log("bad_data")
                await _answer(query, BAD_BUTTON)
                return
            key = (str(chat), str(getattr(message, "message_id", "")))
            if key in _in_flight:
                key = None
                _log("in_flight")
                await _answer(query, IN_FLIGHT)
                return
            _in_flight.add(key)
            with _LEDGER_LOCK:
                ledger, why = load_ledger(home)
            session = ledger.get("session") if why is None else None
            ended = ended_for(ledger, nonce=parsed[1]) if why is None else None
            if ended is not None:
                _log("ended_card", status=ended)
                await _answer(query, ENDED_TEXT[ended])
                return
            if session is None or session.get("nonce") != parsed[1]:
                _log("old_card" if why is None else f"ledger_{why}")
                await _answer(query, OLD_CARD)
                return
            closes = L.epoch_from_iso(session.get("closes_at")) if session.get("closes_at") else None
            if closes is not None and clock() >= closes:
                end_session(ledger, "closed", home, clock())
                await _answer(query, CLOSED)
                return
            if parsed[0] in ("stop", "resume"):
                await _control(query, message, parsed[0], session, ledger, make_button, make_markup, home)
                return
            if parsed[0] in ("submit", "confirm", "cancel"):
                await _submit(query, message, parsed[0], session, ledger, call, make_button, make_markup, home, clock)
                return
            _, _, position, value = parsed
            if position >= len(session["order"]):
                _log("bad_position")
                await _answer(query, BAD_BUTTON)
                return
            sid = session["order"][position]
            reply = await asyncio.to_thread(call, "rate", {"pool_sha256": session["pool_sha256"], "statement_id": sid, "rating": value}, home)
            if not reply.ok or reply.code != "saved":
                await _refused(query, reply, session, ledger, home)
                return
            ratings = reply.data.get("ratings") if isinstance(reply.data.get("ratings"), dict) else {}
            changed = position in set(session.get("rated", []))
            _log("saved", revision=reply.data.get("revision", 0) if isinstance(reply.data.get("revision"), int) else 0)
            await _answer(query, f"Saved: {L.LABELS[value]}" + (" (changed)" if changed else ""))
            rows = getattr(getattr(message, "reply_markup", None), "inline_keyboard", None)
            marked = mark_keyboard(rows, data, make_button)
            if marked is not None:
                try:
                    await query.edit_message_reply_markup(reply_markup=make_markup(marked))
                except Exception:  # noqa: BLE001 - saved already; a stale check is cosmetic
                    _log("edit_failed")
            with _LEDGER_LOCK:
                ledger, why = load_ledger(home)
                fresh = ledger.get("session") if why is None else None
                if fresh is not None and fresh.get("nonce") == session["nonce"]:
                    if str(position) in fresh["cards"]:
                        _SHOWN[(fresh["nonce"], position)] = value
                    fresh["rated"] = sorted(L.rated_positions(fresh["order"], ratings))
                    save_ledger(ledger, home)
                    session = fresh
            set_page_open(page_is_open(session, clock()), home)
            rated = set(session["rated"])
            n = len(session["order"])
            if session["status"] == ACTIVE and L.page_done(int(session["page"]), n, rated):
                # The pair is rated: read (for the next texts) and advance.
                follow = await asyncio.to_thread(call, "read", {}, home)
                view = L.valid_view(follow.data) if follow.ok else None
                if view is not None:
                    bot = _bot_of(query, message)
                    if bot is not None:
                        # The reply to this tap (not a tick send): immediate at any hour (N2).
                        await sync(bot, adapter, view, make_button, make_markup, home, clock(), tick=False)
                else:
                    _log("advance_read_failed", code=follow.code)
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-godconst: tenant=%s outcome=handler_error", tenant_id8())
            await _answer(query, FAILED)
        finally:
            if key is not None:
                _in_flight.discard(key)

    return on_tap


def _bot_of(query: Any, message: Any) -> Any:
    getter = getattr(message, "get_bot", None)
    if callable(getter):
        try:
            return getter()
        except Exception:  # noqa: BLE001
            pass
    return getattr(query, "bot", None) or getattr(message, "bot", None)


async def _refused(query: Any, reply: Reply, session: dict, ledger: dict, home: Optional[str]) -> None:
    """A refused save or submit: the answer, and for a final refusal (submitted, closed, withdrawn, no longer admitted)
    the session deleted (a tombstone stays)."""
    _log("save_refused", code=reply.code)
    status = REFUSAL_STATUS.get(reply.code)
    if status is not None:
        with _LEDGER_LOCK:
            fresh, why = load_ledger(home)
        s = fresh.get("session") if why is None else None
        if s is not None and s.get("nonce") == session["nonce"]:
            end_session(fresh, status, home)
    await _answer(query, REFUSAL_TEXT.get(reply.code, FAILED))


async def _submit(query: Any, message: Any, kind: str, session: dict, ledger: dict, call: Callable, make_button: Callable,
                  make_markup: Callable, home: Optional[str], clock: Callable[[], float]) -> None:
    """Submit asks to confirm (a message with Yes / Not yet); Yes submits the app's latest merged draft (partial
    allowed, final); then the session is deleted and every later tap answers that the ballot is submitted."""
    bot = _bot_of(query, message)
    chat = getattr(getattr(message, "chat", None), "id", None)
    if kind == "submit":
        # The count shown is the app's, read now (a rating given on the web page since the last tap counts too).
        read = await asyncio.to_thread(call, "read", {}, home)
        view = L.valid_view(read.data) if read.ok else None
        if view is None:
            if read.code in REFUSAL_STATUS:
                await _refused(query, read, session, ledger, home)
            else:
                await _answer(query, FAILED)
            return
        if view["state"] != "open":
            await _answer(query, SUBMITTED if view["state"] == "submitted" else CLOSED)
            return
        n = len(view["statements"])
        rated = sum(1 for st in view["statements"] if st["id"] in view["ratings"])
        await _answer(query, "Confirm below.")
        if bot is not None and chat is not None:
            await _send(bot, str(chat), L.confirm_text(rated, n), make_markup(L.confirm_rows(session["nonce"], make_button)))
        _log("submit_asked", n_rated=rated)
        return
    if kind == "cancel":
        await _answer(query, "Not submitted. You can keep rating.")
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:  # noqa: BLE001
            _log("edit_failed")
        return
    reply = await asyncio.to_thread(call, "submit", {"pool_sha256": session["pool_sha256"]}, home)
    if not reply.ok or reply.code != "submitted":
        if reply.code == "incomplete":
            await _answer(query, "Rate at least one statement before you submit.")
            return
        await _refused(query, reply, session, ledger, home)
        return
    with _LEDGER_LOCK:
        fresh, why = load_ledger(home)
    if why is None and isinstance(fresh.get("session"), dict) and fresh["session"].get("nonce") == session["nonce"]:
        end_session(fresh, "submitted", home, clock())
    _log("submitted")
    await _answer(query, "Submitted")
    try:
        await query.edit_message_reply_markup(reply_markup=None)
    except Exception:  # noqa: BLE001
        _log("edit_failed")
    n_rated = reply.data.get("n_rated") if isinstance(reply.data.get("n_rated"), int) else None
    if bot is not None and chat is not None:
        await _send(bot, str(chat), L.submitted_text(n_rated, len(session["order"])))


async def _control(query: Any, message: Any, kind: str, session: dict, ledger: dict, make_button: Callable, make_markup: Callable,
                   home: Optional[str]) -> None:
    """Stop: no more cards (taps still save). Resume: cards again from the next pass (or the next tap)."""
    if session["status"] in FINAL:
        await _answer(query, "This ballot's cards are finished.")
        return
    stopped = kind == "stop"
    with _LEDGER_LOCK:
        fresh, why = load_ledger(home)
        s = fresh.get("session") if why is None else None
        if s is None or s.get("nonce") != session["nonce"]:
            await _answer(query, OLD_CARD)
            return
        s["status"] = STOPPED if stopped else ACTIVE
        save_ledger(fresh, home)
    set_page_open(page_is_open(s, time.time()), home)
    _last_read["at"] = 0.0  # resume: the next pass reads at once
    _log("stopped" if stopped else "resumed")
    await _answer(query, "Stopped. Your ratings are kept." if stopped else "Resumed. The next statements come shortly.")
    try:
        await query.edit_message_reply_markup(reply_markup=make_markup(L.control_rows(session["nonce"], make_button, stopped=stopped)))
    except Exception:  # noqa: BLE001
        _log("edit_failed")
    if stopped:
        bot = _bot_of(query, message)
        chat = getattr(getattr(message, "chat", None), "id", None)
        if bot is not None and chat is not None:
            await _send(bot, str(chat), L.stopped_text())


# --------------------------------------------------------------------------- non-voter elicitation cards (GC-ELICIT §11.4)
#
# A second mode, independent of the ballot: once a non-voter's elicitation window has settled, the control plane writes
# ``$HERMES_HOME/av-events/godconst/elicit-cards.json`` = {elicitation_id, pool_id, window_ms, statement_ids,
# expires_ms} (atomically; removed on withdrawal). While ``AV_GODCONST_ELICIT_CARDS`` is exactly ``1``, the file is
# present, valid and unexpired, no av-elicit opener is pending and no ballot page or ballot session is open, the pass
# sends a short header (village daytime) and those statements two at a time, five buttons each (``gce:``), every one
# labelled a follow-up that is not the ballot. Each tap saves one rating on the elicitation's own ratings (never the
# ballot) through the control plane. Its own ledger (``av-godconst/elicit.json``: ids, positions, message ids; never a
# text or a value), its own tombstones keyed by elicitation id (an ended elicitation never restarts), and the shared
# page-open marker kept while either mode has an open page.

ELICIT_TRIGGER_MAX_BYTES = 64 * 1024
#: After a temporary failure of a cards read (the network, a 5xx, a switch, the window not settled yet), the pass
#: waits this long before reading again.
ELICIT_RETRY_S = 300.0
#: Tombstones kept (newest last).
ELICIT_ENDED_MAX = 50
#: The trigger file missing on this many passes in a row is a withdrawal (one miss could be a rewrite in flight).
ELICIT_MISSING_PASSES = 2
#: 4xx refusals of a cards read or a save that end this box's cards for the elicitation (app#601): not a non-voter
#: window, withdrawn, gone, no research grant, expired; plus the aliases of the first cut. Everything else is temporary
#: (``window_not_settled``, a switch's ``not_enabled``, a 404 with no code, any 5xx, the network) and is retried.
ELICIT_END_CODES = frozenset({
    "not_non_voter", "voter_window", "withdrawn", "elicitation_withdrawn", "elicitation_not_found",
    "research_grant_required", "expired",
    "consent_withdrawn", "research_consent_required", "prior_ballot", "not_eligible", "not_found", "closed",
})
#: A save's 422 for one statement no longer in the window: final for that statement only (its card is dropped).
UNKNOWN_STATEMENT = "unknown_statement"
ELICIT_CLOSED = "This rating has closed."
ELICIT_FAILED = "Could not save that. Tap again in a moment."
ELICIT_GONE = "This statement is no longer available."

_ELICIT_LOCK = threading.RLock()
_ELICIT_ASYNC_LOCK: Optional[asyncio.Lock] = None
_elicit_read = {"failed_at": 0.0}
#: Consecutive passes that found the trigger file missing, for the session with this nonce (memory only).
_elicit_missing = {"nonce": None, "n": 0}


def elicit_on(home: Optional[str] = None) -> bool:
    return env(ELICIT_SWITCH, home) == "1"


def elicit_trigger_path(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-events", "godconst", "elicit-cards.json")


def elicit_inject_dir(home: Optional[str] = None) -> str:
    return os.path.join(home or hermes_home(), "av-events", "elicit", "inject")


def elicit_ledger_path(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "elicit.json")


def _elicit_lock() -> asyncio.Lock:
    global _ELICIT_ASYNC_LOCK
    if _ELICIT_ASYNC_LOCK is None:
        _ELICIT_ASYNC_LOCK = asyncio.Lock()
    return _ELICIT_ASYNC_LOCK


def read_elicit_trigger(home: Optional[str] = None) -> tuple:
    """`(trigger, None)`, or `(None, code)`: missing, not_regular, foreign_owner, not_private (group or world
    writable), too_big, bad_shape. Opened without following a link and without blocking (a FIFO never hangs the pass),
    then checked on the open descriptor, so what is checked is what is read."""
    path = elicit_trigger_path(home)
    try:
        fd = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    except FileNotFoundError:
        return None, "missing"
    except OSError:
        return None, "not_regular"  # a symlink (ELOOP), a directory, a socket
    try:
        st = os.fstat(fd)
        uid = _uid()
        if not stat.S_ISREG(st.st_mode):
            return None, "not_regular"
        if uid is not None and st.st_uid != uid:
            return None, "foreign_owner"
        if st.st_mode & 0o022:
            return None, "not_private"
        if st.st_size > ELICIT_TRIGGER_MAX_BYTES:
            return None, "too_big"
        raw = b""
        while len(raw) <= ELICIT_TRIGGER_MAX_BYTES:
            chunk = os.read(fd, ELICIT_TRIGGER_MAX_BYTES + 1 - len(raw))
            if not chunk:
                break
            raw += chunk
    except OSError:
        return None, "bad_shape"
    finally:
        os.close(fd)
    if len(raw) > ELICIT_TRIGGER_MAX_BYTES:
        return None, "too_big"
    try:
        data = json.loads(raw.decode("utf-8-sig"))
    except ValueError:
        return None, "bad_shape"
    trigger = L.valid_trigger(data)
    return (trigger, None) if trigger is not None else (None, "bad_shape")


def opener_pending(home: Optional[str] = None) -> bool:
    """An av-elicit opener is pending: any ``inject/*.txt`` or ``*.sending``. A listing that fails (other than a
    missing directory) counts as pending: the cards wait rather than land on top of the agent's conversation."""
    try:
        names = os.listdir(elicit_inject_dir(home))
    except FileNotFoundError:
        return False
    except OSError:
        _log("inject_list_failed")
        return True
    return any(name.endswith((".txt", ".sending")) for name in names)


def ballot_holds_elicit(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """The ballot mode is busy here: a ballot page open, or a ballot session active inside its window. The
    elicitation cards send nothing meanwhile, so the two never interleave in the resident's chat."""
    stamp = time.time() if now is None else now
    try:
        ledger, why = load_ledger(home)
        session = ledger.get("session") if why is None else None
        if not isinstance(session, dict):
            return False
        if page_is_open(session, stamp):
            return True
        if session.get("status") != ACTIVE:
            return False
        closes = L.epoch_from_iso(session.get("closes_at")) if session.get("closes_at") else None
        return closes is None or stamp < closes
    except Exception:  # noqa: BLE001 - a ledger of the wrong types: unknown, so not busy
        _log("page_marker_unknown", mode="ballot")
        return False


def _expired(expires_ms: Any, now: float) -> bool:
    return not isinstance(expires_ms, int) or now * 1000.0 >= expires_ms


def empty_elicit_ledger() -> dict:
    return {"v": 1, "session": None, "ended": []}


def load_elicit_ledger(home: Optional[str] = None) -> tuple:
    data, why = _read_private(elicit_ledger_path(home), LEDGER_MAX_BYTES)
    if why is not None:
        return empty_elicit_ledger(), why
    if (not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("ended", []), list)
            or not (data.get("session") is None or isinstance(data.get("session"), dict))):
        return empty_elicit_ledger(), "bad_shape"
    data.setdefault("ended", [])
    return data, None


def save_elicit_ledger(ledger: dict, home: Optional[str] = None) -> None:
    with _ELICIT_LOCK:
        _write_private(elicit_ledger_path(home), ledger)


def _done_positions(session: dict) -> set:
    """Positions that need nothing more: rated, or dropped (the statement no longer in the window)."""
    return set(session.get("rated", [])) | set(session.get("dropped", []))


def elicit_page_is_open(session: Optional[dict], now: float) -> bool:
    """A sent elicitation page with an unrated card, cards active (not yet all rated), before expiry."""
    if not isinstance(session, dict) or session.get("status") != ACTIVE or int(session.get("page", -1)) < 0:
        return False
    if _expired(session.get("expires_ms"), now):
        return False
    done = _done_positions(session)
    sent = {int(p) for p in session.get("cards", {})}
    return any(p in sent and p not in done for p in L.page_positions(int(session["page"]), len(session.get("order", []))))


def elicit_page_open_now(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    try:
        ledger, why = load_elicit_ledger(home)
        return why is None and elicit_page_is_open(ledger.get("session"), time.time() if now is None else now)
    except Exception:  # noqa: BLE001 - a ledger of the wrong types: unknown, so not open
        _log("page_marker_unknown", mode="elicit")
        return False


def elicit_ended(ledger: dict, elicitation_id: Optional[str] = None, nonce: Optional[str] = None) -> Optional[str]:
    """The ending recorded for this elicitation (a pass) or this nonce (a tap), else None."""
    for item in ledger.get("ended") or ():
        if isinstance(item, dict) and (elicitation_id is not None and item.get("elicitation_id") == elicitation_id
                                       or nonce is not None and item.get("nonce") == nonce):
            return str(item.get("status") or "ended")
    return None


def _tombstone(ledger: dict, elicitation_id: str, nonce: Optional[str], status: str, now: float) -> None:
    ended = [e for e in ledger.get("ended") or () if isinstance(e, dict) and e.get("elicitation_id") != elicitation_id]
    ended.append({"elicitation_id": elicitation_id, "nonce": nonce, "status": status, "at": now_iso(now)})
    ledger["ended"] = ended[-ELICIT_ENDED_MAX:]
    ledger.pop("start_failures", None)


def end_elicit(ledger: dict, status: str, home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """Delete the elicitation session and keep a tombstone {elicitation_id, nonce, status, at}. True when there was one."""
    session = ledger.get("session")
    if not isinstance(session, dict):
        return False
    stamp = time.time() if now is None else now
    ledger["session"] = None
    _tombstone(ledger, session["elicitation_id"], session.get("nonce"), status, stamp)
    save_elicit_ledger(ledger, home)
    set_elicit_page_open(False, home)
    _log("elicit_ended", status=status)
    return True


def _end_if_same(nonce: str, status: str, home: Optional[str], now: float) -> bool:
    """Under the lock: end the ledger's session only while it is still the one with this nonce."""
    ledger, why = load_elicit_ledger(home)
    session = ledger.get("session") if why is None else None
    if isinstance(session, dict) and session.get("nonce") == nonce:
        return end_elicit(ledger, status, home, now)
    return False


def _final_refusal(reply: Reply) -> bool:
    return reply.status is not None and 400 <= reply.status < 500 and reply.code in ELICIT_END_CODES


def _elicit_session_ending(session: dict, trigger: Optional[dict], now: float) -> Optional[str]:
    """Why the session ends now: ``replaced`` (another elicitation's file) or ``expired``; None to keep it. A missing
    file is confirmed over passes (``_elicit_missing``); a malformed file holds without ending."""
    if trigger is not None and trigger["elicitation_id"] != session.get("elicitation_id"):
        return "replaced"
    if _expired(session.get("expires_ms"), now) or (trigger is not None and _expired(trigger["expires_ms"], now)):
        return "expired"
    return None


def new_elicit_session(trigger: dict, order: list, now: float) -> dict:
    return {
        "elicitation_id": trigger["elicitation_id"], "nonce": secrets.token_urlsafe(6)[: L.NONCE_CHARS].replace("=", "A"),
        "order": list(order), "expires_ms": trigger["expires_ms"], "status": ACTIVE, "started_at": now_iso(now),
        "header_message_id": None, "page": -1, "cards": {}, "rated": [], "dropped": [], "send_failures": 0,
    }


def _elicit_needs_send(session: dict) -> bool:
    """Something to send on a pass: the current page's unsent card, or the next page (or the last line) once the
    current one needs nothing more."""
    n = len(session["order"])
    page = int(session["page"])
    done = _done_positions(session)
    if page >= 0 and any(str(p) not in session["cards"] and p not in done for p in L.page_positions(page, n)):
        return True
    return L.page_done(page, n, done)


async def _elicit_read_cards(call: Callable, elicitation_id: str, statement_ids: list, home: Optional[str], count: Callable) -> tuple:
    """`(cards, reply)`: the cards (filtered to `statement_ids`, the read's order) or None, and the reply."""
    reply = await asyncio.to_thread(call, "elicit_read", {"elicitation_id": elicitation_id}, home)
    if not reply.ok:
        count("read_failed")
        _log("elicit_read_failed", code=reply.code)
        return None, reply
    cards = L.valid_cards(reply.data, statement_ids)
    if cards is None:
        count("read_bad_shape")
        return None, Reply(reply.status, None, "bad_shape")
    return cards, reply


def _send_failure(ledger: dict, session: dict, home: Optional[str], count: Callable) -> None:
    _send_failed(session, count)
    if session["status"] == "undeliverable":
        end_elicit(ledger, "undeliverable", home)
    else:
        save_elicit_ledger(ledger, home)


async def _elicit_advance(bot: Any, chat: str, session: dict, cards: list, ledger: dict, home: Optional[str],
                          make_button: Callable, make_markup: Callable, count: Callable) -> None:
    """Send what is due: the current page's missing cards, then each next page while the one before needs nothing
    more (a pair already rated shows its checks and the next follows), and the last line once every statement is
    rated (the session stays, status ``done``: re-taps still save until expiry or withdrawal). Texts and saved values
    come from `cards` (this read) and are never stored. The caller holds the elicitation lock."""
    order = session["order"]
    n = len(order)
    by_id = {c["id"]: c for c in cards}
    if [c["id"] for c in cards if c["id"] in set(order)] != [sid for sid in order if sid in by_id]:
        # The participant's order for these ids never changes: a different one is a fault, never re-read every pass.
        count("order_changed")
        end_elicit(ledger, "order_changed", home)
        return
    session["dropped"] = sorted(set(session.get("dropped", [])) | {i for i, sid in enumerate(order) if sid not in by_id})
    session["rated"] = sorted(set(session["rated"]) | {i for i, sid in enumerate(order) if sid in by_id and by_id[sid]["saved"] is not None})
    done = _done_positions(session)
    expires = session["expires_ms"] / 1000.0
    while True:
        page = int(session["page"])
        if page >= 0:
            for position in L.page_positions(page, n):
                if str(position) in session["cards"] or position in set(session["dropped"]):
                    continue
                card = by_id[order[position]]
                message_id = await _send(bot, chat, L.elicit_card_text(position, n, card["text"]),
                                         make_markup(L.elicit_rating_rows(session["nonce"], position, make_button, card["saved"])))
                if message_id is None:
                    _send_failure(ledger, session, home, count)
                    return
                session["cards"][str(position)] = {"message_id": message_id}
                session["send_failures"] = 0
                save_elicit_ledger(ledger, home)
                set_elicit_page_open(elicit_page_is_open(session, time.time()), home, touch=True)
                count("card_sent")
                await asyncio.sleep(SEND_GAP_S)
            if not L.page_done(page, n, done):
                save_elicit_ledger(ledger, home)
                set_elicit_page_open(elicit_page_is_open(session, time.time()), home)
                return
        if page + 1 >= L.page_count(n):
            break
        session["page"] = page + 1
        save_elicit_ledger(ledger, home)
    # Every statement rated (or dropped): the last line once; the cards stay tappable for revisions.
    if session["status"] == ACTIVE:
        if await _send(bot, chat, L.elicit_done_text(len(session["rated"]), expires)) is None:
            count("send_failed")
        session["status"] = "done"
        count("final_sent")
        _log("elicit_all_rated")
    save_elicit_ledger(ledger, home)
    set_elicit_page_open(False, home)


async def elicit_pass_once(bot: Any, adapter: Any, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                           now: Optional[float] = None, reader: Optional[Callable] = None) -> str:
    """One pass of the elicitation cards: end what is over, start or continue what is due. Returns a code; never
    raises. Independent of the ballot's switch; holds while the ballot is busy."""
    stamp = time.time() if now is None else now
    call = reader or cp_call
    codes: dict = {}

    def count(code: str, n: int = 1) -> None:
        codes[code] = codes.get(code, 0) + n

    try:
        async with _elicit_lock():
            result = await _elicit_pass_locked(bot, adapter, make_button, make_markup, home, stamp, call, count)
    except Exception:  # noqa: BLE001 - the pass never raises into the gateway
        logger.warning("av-godconst: tenant=%s outcome=elicit_pass_error", tenant_id8())
        return "pass_error"
    if codes:
        _log("elicit_sync", **codes)
    return result


async def _elicit_pass_locked(bot: Any, adapter: Any, make_button: Callable, make_markup: Callable, home: Optional[str],
                              stamp: float, call: Callable, count: Callable) -> str:
    ledger, why = load_elicit_ledger(home)
    if why not in (None, "missing"):
        _log(f"elicit_ledger_{why}")
        return f"ledger_{why}"
    trigger, twhy = read_elicit_trigger(home)
    session = ledger.get("session")
    if isinstance(session, dict):
        if twhy == "missing":
            if _elicit_missing["nonce"] == session["nonce"]:
                _elicit_missing["n"] += 1
            else:
                _elicit_missing.update(nonce=session["nonce"], n=1)
            if _elicit_missing["n"] < ELICIT_MISSING_PASSES:
                return "trigger_missing"
            end_elicit(ledger, "withdrawn", home, stamp)
            return "ended_withdrawn"
        _elicit_missing.update(nonce=None, n=0)
        ending = _elicit_session_ending(session, trigger, stamp)
        if ending is not None:
            end_elicit(ledger, ending, home, stamp)
            session = None
            if ending != "replaced":
                return f"ended_{ending}"
    if not elicit_on(home):
        return "off"
    if trigger is None:
        if twhy != "missing":
            _log("elicit_trigger_invalid", code=twhy)
        return "no_trigger" if twhy == "missing" else f"trigger_{twhy}"
    if session is None:
        if _expired(trigger["expires_ms"], stamp):
            return "expired"
        if elicit_ended(ledger, elicitation_id=trigger["elicitation_id"]):
            return "ended_here"
    elif session["status"] != ACTIVE:
        return "idle"  # all rated: re-taps still save; nothing more is sent
    if opener_pending(home):
        return "opener_pending"
    if ballot_holds_elicit(home, stamp):
        return "ballot_active"
    if session is not None and not _elicit_needs_send(session):
        return "idle"
    if not L.in_send_window(stamp):  # every send a pass makes: village daytime (the ballot's rule)
        return "waiting_daytime"
    chat = home_chat_id(adapter)
    if chat is None:
        return "no_home_chat"
    if stamp - _elicit_read["failed_at"] < ELICIT_RETRY_S:
        return "not_due"
    cards, reply = await _elicit_read_cards(call, trigger["elicitation_id"], trigger["statement_ids"], home, count)
    if cards is None:
        if _final_refusal(reply):
            if session is not None:
                end_elicit(ledger, "refused", home, stamp)
            else:
                _tombstone(ledger, trigger["elicitation_id"], None, "refused", stamp)
                save_elicit_ledger(ledger, home)
            return f"refused_{reply.code}"
        _elicit_read["failed_at"] = stamp  # temporary: retried after the backoff, until expiry
        return reply.code
    _elicit_read["failed_at"] = 0.0
    if session is None:
        eid = trigger["elicitation_id"]
        if not cards or all(c["saved"] is not None for c in cards):
            status = "empty" if not cards else "all_rated"
            _tombstone(ledger, eid, None, status, stamp)
            save_elicit_ledger(ledger, home)
            _log("elicit_not_started", status=status)
            return status
        session = new_elicit_session(trigger, [c["id"] for c in cards], stamp)
        header = await _send(bot, chat, L.elicit_header_text(len(cards), trigger["expires_ms"] / 1000.0),
                             make_markup(L.elicit_header_rows(session["nonce"], make_button)))
        if header is None:
            # Nothing kept but the count (ids only): the next pass starts again; SEND_FAILURES_MAX in a row end it.
            failures = ledger.get("start_failures")
            n = failures["n"] + 1 if isinstance(failures, dict) and failures.get("elicitation_id") == eid and isinstance(failures.get("n"), int) else 1
            count("send_failed")
            if n >= SEND_FAILURES_MAX:
                _tombstone(ledger, eid, None, "undeliverable", stamp)
                count("settled_undeliverable")
            else:
                ledger["start_failures"] = {"elicitation_id": eid, "n": n}
            save_elicit_ledger(ledger, home)
            return "send_failed"
        ledger.pop("start_failures", None)
        session["header_message_id"] = header
        ledger["session"] = session
        save_elicit_ledger(ledger, home)
        count("started")
        _log("elicit_order", n=len(cards))
    await _elicit_advance(bot, chat, session, cards, ledger, home, make_button, make_markup, count)
    return "sent"


def make_elicit_handler(adapter: Any = None, *, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                        clock: Callable[[], float] = time.time, caller: Optional[Callable] = None) -> Callable:
    """The PTB callback for ``gce:`` taps: the ballot's owner rule; one save per tap; Stop ends the cards. The save
    and the answer never wait for a pass: the elicitation lock is taken only to merge into the ledger and advance."""
    call = caller or cp_call

    async def on_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        key: Optional[tuple] = None
        try:
            data = getattr(query, "data", None)
            user = _positive_id(getattr(getattr(query, "from_user", None), "id", None))
            message = getattr(query, "message", None)
            chat_obj = getattr(message, "chat", None) if message is not None else None
            raw_chat = getattr(chat_obj, "id", None)
            chat = None if raw_chat is None else str(raw_chat).strip()
            chat_type = getattr(chat_obj, "type", None)
            chat_type = getattr(chat_type, "value", chat_type)
            if not is_owner_tap(adapter, user, chat, chat_type):
                _log("elicit_not_owner")
                await _answer(query, NOT_YOURS)
                return
            parsed = L.parse_elicit_callback(data)
            if parsed is None:
                _log("elicit_bad_data")
                await _answer(query, BAD_BUTTON)
                return
            key = ("gce", str(chat), str(getattr(message, "message_id", "")))
            if key in _in_flight:
                key = None
                _log("elicit_in_flight")
                await _answer(query, IN_FLIGHT)
                return
            _in_flight.add(key)
            await _elicit_tap(query, message, parsed, data, call, make_button, make_markup, home, clock)
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-godconst: tenant=%s outcome=elicit_handler_error", tenant_id8())
            await _answer(query, ELICIT_FAILED)
        finally:
            if key is not None:
                _in_flight.discard(key)

    return on_tap


async def _elicit_tap(query: Any, message: Any, parsed: tuple, data: str, call: Callable, make_button: Callable,
                      make_markup: Callable, home: Optional[str], clock: Callable[[], float]) -> None:
    ledger, why = load_elicit_ledger(home)
    session = ledger.get("session") if why is None else None
    nonce = parsed[1]
    if why is None and elicit_ended(ledger, nonce=nonce) or not isinstance(session, dict) or session.get("nonce") != nonce:
        _log("elicit_closed_card" if why is None else f"elicit_ledger_{why}")
        await _answer(query, ELICIT_CLOSED)
        return
    now = clock()
    trigger, twhy = read_elicit_trigger(home)
    if twhy == "missing":
        # Withdrawn, or a rewrite in flight: nothing is saved; the pass confirms a withdrawal before it ends anything.
        _log("elicit_trigger_missing")
        await _answer(query, ELICIT_CLOSED)
        return
    ending = _elicit_session_ending(session, trigger, now)
    if ending is not None:
        async with _elicit_lock():
            _end_if_same(nonce, ending, home, now)
        await _answer(query, ELICIT_CLOSED)
        return
    if parsed[0] == "stop":
        async with _elicit_lock():
            _end_if_same(nonce, "stopped", home, now)
        await _answer(query, "Stopped. The ratings you gave are kept.")
        try:
            await query.edit_message_reply_markup(reply_markup=None)
        except Exception:  # noqa: BLE001
            _log("edit_failed")
        bot = _bot_of(query, message)
        chat = getattr(getattr(message, "chat", None), "id", None)
        if bot is not None and chat is not None:
            await _send(bot, str(chat), L.elicit_stopped_text())
        return
    if trigger is None:  # malformed: hold (no save), never end
        _log("elicit_trigger_invalid", code=twhy)
        await _answer(query, ELICIT_FAILED)
        return
    _, _, position, value = parsed
    n = len(session["order"])
    if position >= n:
        _log("elicit_bad_position")
        await _answer(query, BAD_BUTTON)
        return
    if position in set(session.get("dropped", [])):
        await _answer(query, ELICIT_GONE)
        return
    sid = session["order"][position]
    body = {"elicitation_id": session["elicitation_id"], "ratings": [{"statement_id": sid, "rating": value}], "channel": "telegram_card"}
    # The save and the answer outside the lock: a pass mid-send never delays the resident's tap.
    reply = await asyncio.to_thread(call, "elicit_rate", body, home)
    if not reply.ok:
        _log("elicit_save_refused", code=reply.code)
        if reply.status == 422 and reply.code == UNKNOWN_STATEMENT:
            await _answer(query, ELICIT_GONE)
            try:
                await query.edit_message_reply_markup(reply_markup=None)
            except Exception:  # noqa: BLE001
                _log("edit_failed")
            await _elicit_merge(query, message, nonce, "dropped", position, trigger, call, make_button, make_markup, home, clock)
            return
        if _final_refusal(reply):
            async with _elicit_lock():
                _end_if_same(nonce, "refused", home, now)
            await _answer(query, ELICIT_CLOSED)
        else:
            await _answer(query, ELICIT_FAILED)
        return
    changed = position in set(session["rated"])
    _log("elicit_saved", changed=int(changed))
    await _answer(query, f"Saved: {L.LABELS[value]}" + (" (changed)" if changed else ""))
    rows = getattr(getattr(message, "reply_markup", None), "inline_keyboard", None)
    marked = mark_keyboard(rows, data, make_button, prefix=L.ELICIT_PREFIX)
    if marked is not None:
        try:
            await query.edit_message_reply_markup(reply_markup=make_markup(marked))
        except Exception:  # noqa: BLE001 - saved already; a stale check is cosmetic
            _log("edit_failed")
    await _elicit_merge(query, message, nonce, "rated", position, trigger, call, make_button, make_markup, home, clock)


async def _elicit_merge(query: Any, message: Any, nonce: str, field: str, position: int, trigger: dict, call: Callable,
                        make_button: Callable, make_markup: Callable, home: Optional[str], clock: Callable[[], float]) -> None:
    """Under the lock: re-load the ledger, add the position to `field` (rated or dropped) of the session that still
    has this nonce (a session ended or replaced meanwhile is never brought back), save, and advance when the current
    pair needs nothing more (the reply to the resident's tap: any hour, never over a pending opener or a busy ballot)."""
    async with _elicit_lock():
        ledger, why = load_elicit_ledger(home)
        session = ledger.get("session") if why is None else None
        if not isinstance(session, dict) or session.get("nonce") != nonce:
            _log("elicit_merge_skipped")
            return
        session[field] = sorted(set(session.get(field, [])) | {position})
        save_elicit_ledger(ledger, home)
        now = clock()
        set_elicit_page_open(elicit_page_is_open(session, now), home)
        n = len(session["order"])
        if session["status"] != ACTIVE or not L.page_done(int(session["page"]), n, _done_positions(session)):
            return
        if opener_pending(home):
            _log("elicit_opener_pending")
            return
        if ballot_holds_elicit(home, now):
            _log("elicit_ballot_active")
            return
        bot = _bot_of(query, message)
        chat = getattr(getattr(message, "chat", None), "id", None)
        if bot is None or chat is None:
            return
        codes: dict = {}

        def count(code: str, k: int = 1) -> None:
            codes[code] = codes.get(code, 0) + k

        cards, reply = await _elicit_read_cards(call, session["elicitation_id"], trigger["statement_ids"], home, count)
        if cards is None:
            if _final_refusal(reply):
                end_elicit(ledger, "refused", home, now)
            return
        await _elicit_advance(bot, str(chat), session, cards, ledger, home, make_button, make_markup, count)
        if codes:
            _log("elicit_sync", **codes)


# --------------------------------------------------------------------------- THOR nudge card (third mode)
#
# The resident's daily THOR nudge (data's ODIN-THOR-NUDGES design section 5; product copy THOR-NUDGE-CARD-COPY): at most
# one card per UTC day, from the resident's own bot in their own DM, three taps (Do it / Not now / Not for me). It rides
# this plugin's existing pass (no poller of its own) and Telegram factory (its own ``^avt:`` handler). The box switch
# is ``AV_THOR_KEY`` alone (present and non-blank = on; absent: no read, no card, a tap is answered "This card has
# closed." with nothing sent). ``THOR_NUDGES_ENABLED`` is the control plane's flag: it answers empty while off, so the
# box needs no flag of its own. Every other ON condition stays: a pinned CONTROL_PLANE_URL, the tenant uuid, the home
# chat, 08:00-21:30 IST.
#
# The wire: ``GET {CONTROL_PLANE_URL}/tenants/<own tenant>/thor/today`` and ``POST .../thor/<item_key>/answer
# {"answer": "do_it"|"not_now"|"not_for_me"}``, both with ``Authorization: Bearer $AV_THOR_KEY``: a per-tenant key the
# control plane writes for this plugin only, held in custody (av-approval custody_keys.json "strip" and _custody.FLOOR,
# as AV_GODCONST_BALLOT_KEY), so agent-run code gets no copy of it through the tool and environment surface custody
# controls; the residual is the ballot key's ($HERMES_HOME/.env stays readable by the agent's user). Never EDGEOS_API_KEY
# (the agent can read that one) and no fallback to it: with no AV_THOR_KEY on the box the card mode is off (no read, no
# card; one code-only log line a UTC day, ``thor_no_key``; a 401/403 read logs ``thor_unauthorized`` and the dark
# route's 404 ``thor_route_dark``, each once a UTC day; neither spends one of the day's reads). CP_HOSTS-pinned, no redirects, no proxies. The control plane is the
# authority for everything else (approved run, consent, double opt-in for intros, expiry, one per day, the B mirror
# card); this box renders only what the route returns and never names or contacts anyone.
#
# Read cadence: inside village daytime (_logic.in_send_window, 08:00-21:30 IST, inside one UTC day), at most once per
# UTC day after an answered read (served, empty, expired, refused); a transport failure or a 429/5xx retries after
# THOR_RETRY_S, at most THOR_READS_PER_DAY reads a day. The day's read count, its answered read and its backoff are
# kept in memory too (per tenant and UTC day), so a ledger that cannot be written still caps the reads. Serving marks the item carded at the control plane, so a card
# whose Telegram send fails is retried from memory (THOR_SEND_ATTEMPTS, while unexpired); a restart in between loses
# it for that day (logged ``thor_send_lost``).
#
# Nothing private on disk: the ledger ``av-godconst/thor.json`` (0600) holds the day, read counters and, per card, its
# nonce, the opaque item_key, the intro flag and role, message id, the day and the answer value; never a title, draft, evidence
# or name. Logs: ``av-godconst: tenant=<id8> outcome=thor_<code> [k=v]``, codes and counts only.

THOR_CREDENTIAL_ENV = "AV_THOR_KEY"
THOR_READ_PATH = "/tenants/{tenant}/thor/today"
THOR_ANSWER_PATH = "/tenants/{tenant}/thor/{item_key}/answer"
THOR_ANSWER_FIELD = "answer"
THOR_RESPONSE_MAX_BYTES = 256 * 1024
THOR_RETRY_S = 1800.0
THOR_READS_PER_DAY = 4
THOR_SEND_ATTEMPTS = 3
THOR_CARDS_KEPT = 14
#: A refused answer whose code means the card can no longer be answered.
THOR_CLOSED_CODES = frozenset({"thor_unknown_item", "thor_not_yours", "thor_item_expired", "thor_already_answered",
                               "thor_nudges_off"})
#: A read refused for the credential (the box's AV_THOR_KEY not written yet, or not accepted: 401/403) or answered by
#: the dark control plane's unknown-route 404: no card, no text, retry after THOR_RETRY_S, and NOT one of the day's
#: reads, so the card can still arrive that day once the key or the route lands. Each logs once a UTC day by code.
THOR_NO_CARD_STATUSES = {401: "unauthorized", 403: "unauthorized", 404: "route_dark"}

_THOR_LEDGER_LOCK = threading.RLock()
_THOR_PASS_LOCK: Optional[asyncio.Lock] = None
#: nonce -> (card text, expires_at): a carded card waiting for its Telegram send. Memory only.
_THOR_PENDING: dict = {}
#: nonce -> the other party's first name on A's intro card, for the follow-up line. Memory only (never on disk): after
#: a restart the line is the plain "Noted.".
_THOR_NAMES: dict = {}
_thor_in_flight: set = set()
#: code -> the UTC day it was last logged: ``no_key`` and ``unauthorized`` log once a UTC day per box, not per attempt.
_THOR_LOGGED_DAY: dict = {}
#: (tenant, UTC day) -> {"reads", "done", "next_read_at"}: the day's read state in memory, so an unwritable ledger
#: never lifts the reads-per-day cap (each GET can spend the day's item at the control plane). Today's key only.
_THOR_DAY: dict = {}


def _thor_day_state(tenant: str, day: str) -> dict:
    key = (tenant, day)
    for stale in [k for k in _THOR_DAY if k != key]:
        _THOR_DAY.pop(stale, None)
    return _THOR_DAY.setdefault(key, {"reads": 0, "done": False, "next_read_at": None})


def thor_key(home: Optional[str] = None) -> str:
    """The custody-held THOR key, read as the ballot key is (process environment, then ``$HERMES_HOME/.env``)."""
    return env(THOR_CREDENTIAL_ENV, home)


def _thor_log_daily(code: str, now: Optional[float] = None) -> None:
    """Log `code` at most once per UTC day for this box (a condition that repeats every pass, e.g. no key)."""
    day = T.utc_day(time.time() if now is None else now)
    if _THOR_LOGGED_DAY.get(code) != day:
        _THOR_LOGGED_DAY[code] = day
        _thor_log(code)


def thor_active(home: Optional[str] = None, now: Optional[float] = None) -> bool:
    """The box switch is the custody key alone: present and non-blank = the card mode is on. Absent: off, logged once
    a UTC day by code (``thor_no_key``). THOR_NUDGES_ENABLED is never read here: the control plane enforces it."""
    if thor_key(home):
        return True
    _thor_log_daily("no_key", now)
    return False


def thor_ledger_path(home: Optional[str] = None) -> str:
    return os.path.join(state_dir(home), "thor.json")


def empty_thor_ledger() -> dict:
    return {"v": 1, "day": None, "reads": 0, "next_read_at": None, "done": False, "cards": []}


def load_thor_ledger(home: Optional[str] = None) -> tuple:
    data, why = _read_private(thor_ledger_path(home), LEDGER_MAX_BYTES)
    if why is not None:
        return empty_thor_ledger(), why
    if not isinstance(data, dict) or data.get("v") != 1 or not isinstance(data.get("cards"), list):
        return empty_thor_ledger(), "bad_shape"
    return data, None


def save_thor_ledger(ledger: dict, home: Optional[str] = None) -> None:
    ledger["cards"] = ledger.get("cards", [])[-THOR_CARDS_KEPT:]
    _write_private(thor_ledger_path(home), ledger)


def _thor_log(outcome: str, **counts: Any) -> None:
    _log(f"thor_{outcome}", **counts)


def thor_cp_call(method: str, path: str, body: Optional[dict] = None, home: Optional[str] = None) -> Reply:
    """One call to the control plane's THOR route (blocking; run through asyncio.to_thread). `path` is a template
    with ``{tenant}`` (and ``{item_key}`` already filled). Never raises; ``code`` is ``ok`` on a 200, else the refusal's
    closed ``error`` code, ``http_<status>``, or a transport code (not_configured, network, timeout, bad_response)."""
    origin = cp_origin(env(URL_ENV, home))
    key = thor_key(home)
    tenant = tenant_id(home)
    if origin is None or not key or tenant is None or method not in ("GET", "POST"):
        return Reply(None, None, "not_configured")
    headers = {"Accept": "application/json", "Authorization": f"Bearer {key}"}
    data = None
    if method == "POST":
        headers["Content-Type"] = "application/json"
        data = json.dumps(body or {}, separators=(",", ":")).encode("utf-8")
    request = urllib.request.Request(origin + path.format(tenant=tenant), data=data, method=method, headers=headers)
    try:
        with _OPENER.open(request, timeout=HTTP_TIMEOUT_S) as response:
            status, raw = int(getattr(response, "status", 0) or 0), response.read(THOR_RESPONSE_MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        status = int(error.code)
        try:
            raw = error.read(THOR_RESPONSE_MAX_BYTES + 1)
        except Exception:  # noqa: BLE001
            raw = b""
    except (TimeoutError, OSError, http.client.HTTPException, ValueError) as error:
        return Reply(None, None, "timeout" if "timed out" in str(error).lower() or isinstance(error, TimeoutError) else "network")
    if len(raw) > THOR_RESPONSE_MAX_BYTES:
        return Reply(status, None, "bad_response")
    try:
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
    except (UnicodeDecodeError, ValueError):
        parsed = None
    if not isinstance(parsed, dict):
        return Reply(status, None, "bad_response" if status == 200 else f"http_{status}")
    if status == 200:
        return Reply(status, parsed, "ok")
    code = parsed.get("error")
    return Reply(status, parsed, code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else f"http_{status}")


def _thor_pass_lock() -> asyncio.Lock:
    global _THOR_PASS_LOCK
    if _THOR_PASS_LOCK is None:
        _THOR_PASS_LOCK = asyncio.Lock()
    return _THOR_PASS_LOCK


def _thor_retryable(reply: Reply) -> bool:
    return reply.status is None and reply.code != "not_configured" or reply.status == 429 or (reply.status or 0) >= 500


async def _thor_send(bot: Any, chat: str, card: dict, make_button: Callable, make_markup: Callable, now: float) -> Optional[str]:
    """Send a pending card; the outcome code. The caller saves the ledger."""
    pending = _THOR_PENDING.get(card["nonce"])
    if pending is None:
        card["status"] = "lost"
        return "send_lost"
    text, expires = pending
    if expires <= now:
        _THOR_PENDING.pop(card["nonce"], None)
        card["status"] = "expired"
        return "expired_unsent"
    message_id = await _send(bot, chat, text, make_markup(T.card_rows(card["nonce"], make_button)))
    if message_id is None:
        card["send_failures"] = int(card.get("send_failures", 0)) + 1
        if card["send_failures"] >= THOR_SEND_ATTEMPTS:
            _THOR_PENDING.pop(card["nonce"], None)
            card["status"] = "undeliverable"
            return "undeliverable"
        return "send_failed"
    _THOR_PENDING.pop(card["nonce"], None)
    card.update({"status": "sent", "message_id": message_id, "chat": str(chat), "sent_at": now_iso(now)})
    return "card_sent"


async def thor_pass_once(bot: Any, adapter: Any, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                         now: Optional[float] = None, reader: Optional[Callable] = None) -> dict:
    """One THOR step on the shared pass: send a pending card, else read today's item once and send its card. Returns
    code -> count; never raises."""
    codes: dict = {}

    def count(code: str, log: bool = True) -> None:
        codes[code] = codes.get(code, 0) + 1
        if log:
            _thor_log(code)

    try:
        stamp = time.time() if now is None else now
        if not thor_active(home, stamp):
            return codes
        if not L.in_send_window(stamp):
            return codes
        chat = home_chat_id(adapter)
        if chat is None:
            count("no_home_chat")
            return codes
        call = reader or thor_cp_call
        async with _thor_pass_lock():
            with _THOR_LEDGER_LOCK:
                ledger, why = load_thor_ledger(home)
            if why not in (None, "missing"):
                count(f"ledger_{why}")
                return codes
            today = T.utc_day(stamp)
            if ledger.get("day") != today:
                ledger.update({"day": today, "reads": 0, "next_read_at": None, "done": False})
            mem = _thor_day_state(tenant_id(home) or "-", today)
            for card in ledger["cards"]:
                if card.get("status") == "pending":
                    if card.get("day") != today:
                        _THOR_PENDING.pop(card.get("nonce"), None)
                        card["status"] = "lost"
                        continue
                    count(await _thor_send(bot, chat, card, make_button, make_markup, stamp))
                    with _THOR_LEDGER_LOCK:
                        save_thor_ledger(_merge_thor(ledger, home), home)
                    return codes
            if ledger.get("done") or mem["done"] or any(c.get("day") == today for c in ledger["cards"]):
                return codes
            waits = [t for t in (ledger.get("next_read_at"), mem["next_read_at"]) if isinstance(t, (int, float))]
            if waits and stamp < max(waits):
                return codes
            reads = max(int(ledger.get("reads", 0)), int(mem["reads"]))
            if reads >= THOR_READS_PER_DAY:
                ledger["done"] = mem["done"] = True
                count("reads_exhausted")
                with _THOR_LEDGER_LOCK:
                    save_thor_ledger(_merge_thor(ledger, home), home)
                return codes
            ledger["reads"] = mem["reads"] = reads + 1
            reply = await asyncio.to_thread(call, "GET", THOR_READ_PATH, None, home)
            if not reply.ok:
                if reply.status in THOR_NO_CARD_STATUSES:
                    ledger["reads"] = mem["reads"] = reads  # not one of the day's reads
                    ledger["next_read_at"] = mem["next_read_at"] = stamp + THOR_RETRY_S
                    count(THOR_NO_CARD_STATUSES[reply.status], log=False)
                    _thor_log_daily(THOR_NO_CARD_STATUSES[reply.status], stamp)
                elif _thor_retryable(reply):
                    ledger["next_read_at"] = mem["next_read_at"] = stamp + THOR_RETRY_S
                    count(f"read_retry_{reply.code}")
                else:
                    ledger["done"] = mem["done"] = True
                    count(f"read_refused_{reply.code}")
                with _THOR_LEDGER_LOCK:
                    save_thor_ledger(_merge_thor(ledger, home), home)
                return codes
            item, code = T.today_item(reply.data, stamp)
            ledger["done"] = mem["done"] = True
            if item is None:
                count(f"read_{code}")
                with _THOR_LEDGER_LOCK:
                    save_thor_ledger(_merge_thor(ledger, home), home)
                return codes
            if item["role"] == "b" and not item["other_first_name"]:
                # B's mirror card names A; without A's first name there is nothing safe to show (review-b S3).
                count("mirror_no_name")
                with _THOR_LEDGER_LOCK:
                    save_thor_ledger(_merge_thor(ledger, home), home)
                return codes
            nonce = secrets.token_urlsafe(6)[: T.NONCE_CHARS].replace("=", "A")
            if item["other_first_name"]:
                _THOR_NAMES[nonce] = item["other_first_name"]
            card = {"nonce": nonce, "item_key": item["item_key"], "intro": item["intro"], "role": item["role"],
                    "day": today, "status": "pending", "message_id": None, "chat": None, "sent_at": None,
                    "send_failures": 0, "answer": None, "answered_at": None}
            ledger["cards"].append(card)
            _THOR_PENDING[nonce] = (T.card_text(item), item["expires_at"])
            with _THOR_LEDGER_LOCK:  # write-ahead: the card is on the ledger before the send
                save_thor_ledger(_merge_thor(ledger, home), home)
            count("served")
            count(await _thor_send(bot, chat, card, make_button, make_markup, stamp))
            with _THOR_LEDGER_LOCK:
                save_thor_ledger(_merge_thor(ledger, home), home)
    except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
        logger.warning("av-godconst: tenant=%s outcome=thor_pass_error", tenant_id8())
    return codes


def _merge_thor(ledger: dict, home: Optional[str]) -> dict:
    """The pass's ledger with answers a tap saved meanwhile kept (a tap never waits for the pass's lock)."""
    disk, why = load_thor_ledger(home)
    if why is None:
        answered = {c.get("nonce"): c for c in disk["cards"] if c.get("answer")}
        for card in ledger["cards"]:
            seen = answered.get(card.get("nonce"))
            if seen is not None and not card.get("answer"):
                card["answer"], card["answered_at"] = seen.get("answer"), seen.get("answered_at")
    return ledger


def make_thor_handler(adapter: Any = None, *, make_button: Callable, make_markup: Callable, home: Optional[str] = None,
                      clock: Callable[[], float] = time.time, caller: Optional[Callable] = None) -> Callable:
    """The PTB callback for ``avt:`` taps: owner only (av-vote's rule), one answer per card, posted to the answer
    route; the card keeps only the chosen button (marked) and the copy file's follow-up line is sent."""
    call = caller or thor_cp_call

    async def on_tap(update: Any, context: Any = None) -> None:
        query = getattr(update, "callback_query", None)
        if query is None:
            return
        nonce: Optional[str] = None
        try:
            data = getattr(query, "data", None)
            user = _positive_id(getattr(getattr(query, "from_user", None), "id", None))
            message = getattr(query, "message", None)
            chat_obj = getattr(message, "chat", None) if message is not None else None
            raw_chat = getattr(chat_obj, "id", None)
            chat = None if raw_chat is None else str(raw_chat).strip()
            chat_type = getattr(chat_obj, "type", None)
            chat_type = getattr(chat_type, "value", chat_type)
            if not is_owner_tap(adapter, user, chat, chat_type):
                _thor_log("not_owner")
                await _answer(query, T.NOT_YOURS)
                return
            parsed = T.parse_callback(data)
            if parsed is None:
                _thor_log("bad_data")
                await _answer(query, T.BAD_BUTTON)
                return
            choice, tapped = parsed
            if not thor_active(home):
                _thor_log("tap_no_key")
                await _answer(query, T.CLOSED)
                return
            with _THOR_LEDGER_LOCK:
                ledger, why = load_thor_ledger(home)
            card = next((c for c in ledger["cards"] if c.get("nonce") == tapped), None) if why is None else None
            if card is None or card.get("message_id") != getattr(message, "message_id", None) or card.get("chat") != chat:
                _thor_log("old_card" if why is None else f"ledger_{why}")
                await _answer(query, T.INVALID)
                return
            if card.get("answer"):
                _thor_log("already_answered")
                await _answer(query, T.ALREADY)
                return
            if tapped in _thor_in_flight:
                _thor_log("in_flight")
                await _answer(query, T.IN_FLIGHT)
                return
            nonce = tapped
            _thor_in_flight.add(nonce)
            value = T.ANSWERS[choice]
            path = THOR_ANSWER_PATH.replace("{item_key}", urllib.parse.quote(card["item_key"], safe=""))
            reply = await asyncio.to_thread(call, "POST", path, {THOR_ANSWER_FIELD: value}, home)
            if not reply.ok:
                # ANY 404 is closed: thor_unknown_item, or the dark/absent route's unknown-route 404 (the card can never
                # be saved there), logged once a UTC day and never answered with a retry prompt (review-b L33153).
                if reply.status == 404:
                    _thor_log_daily("answer_404", clock())
                    await _answer(query, T.CLOSED)
                    return
                closed = reply.status is not None and 400 <= reply.status < 500 and reply.code in THOR_CLOSED_CODES
                _thor_log("answer_closed" if closed else f"answer_failed_{reply.code}")
                await _answer(query, T.CLOSED if closed else T.FAILED)
                return
            with _THOR_LEDGER_LOCK:
                ledger, why = load_thor_ledger(home)
                if why is None:
                    for stored in ledger["cards"]:
                        if stored.get("nonce") == nonce:
                            stored["answer"], stored["answered_at"] = value, now_iso(clock())
                    save_thor_ledger(ledger, home)
            _thor_log("answered", **{value: 1})
            line = T.follow_up(choice, card.get("intro") is True, _THOR_NAMES.get(nonce), card.get("role"))
            await _answer(query, line)
            try:
                await query.edit_message_reply_markup(reply_markup=make_markup(T.card_rows(nonce, make_button, chosen=choice)))
            except Exception:  # noqa: BLE001 - recorded already; the mark is cosmetic
                _thor_log("edit_failed")
            bot = _bot_of(query, message)
            if bot is None or await _send(bot, chat, html.escape(line, quote=False)) is None:
                _thor_log("follow_up_failed")
        except Exception:  # noqa: BLE001 - fail-open: never raise into the gateway
            logger.warning("av-godconst: tenant=%s outcome=thor_handler_error", tenant_id8())
            await _answer(query, T.FAILED)
        finally:
            if nonce is not None:
                _thor_in_flight.discard(nonce)

    return on_tap


# --------------------------------------------------------------------------- wiring


def _wire_telegram(application: Any, adapter: Any) -> None:
    """Factory Hermes calls at Telegram connect with the PTB ``Application``; SDK imports stay here."""
    from telegram import InlineKeyboardButton, InlineKeyboardMarkup  # noqa: PLC0415
    from telegram.ext import CallbackQueryHandler  # noqa: PLC0415

    make_button = lambda text, data: InlineKeyboardButton(text=text, callback_data=data)  # noqa: E731
    make_markup = lambda rows: InlineKeyboardMarkup(rows)  # noqa: E731
    application.add_handler(CallbackQueryHandler(make_handler(adapter, make_button=make_button, make_markup=make_markup),
                                                 pattern=L.HANDLER_PATTERN, block=False))
    logger.info("av-godconst: ballot card buttons wired (pattern %s)", L.HANDLER_PATTERN)
    application.add_handler(CallbackQueryHandler(make_elicit_handler(adapter, make_button=make_button, make_markup=make_markup),
                                                 pattern=L.ELICIT_HANDLER_PATTERN, block=False))
    logger.info("av-godconst: elicitation card buttons wired (pattern %s)", L.ELICIT_HANDLER_PATTERN)
    application.add_handler(CallbackQueryHandler(make_thor_handler(adapter, make_button=make_button, make_markup=make_markup),
                                                 pattern=T.HANDLER_PATTERN, block=False))
    logger.info("av-godconst: THOR nudge card buttons wired (pattern %s)", T.HANDLER_PATTERN)

    async def tick(*_: Any) -> None:
        # Three independent modes, each behind its own switch; each pass never raises.
        await pass_once(application.bot, adapter, make_button, make_markup)
        await elicit_pass_once(application.bot, adapter, make_button, make_markup)
        await thor_pass_once(application.bot, adapter, make_button, make_markup)

    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        job_queue = getattr(application, "job_queue", None)
    if job_queue is not None and callable(getattr(job_queue, "run_repeating", None)):
        try:
            job_queue.run_repeating(tick, interval=PASS_INTERVAL_S, first=10.0, name="av-godconst-pass")
            logger.info("av-godconst: pass on the job queue every %ss", int(PASS_INTERVAL_S))
            return
        except Exception:  # noqa: BLE001
            logger.info("av-godconst: job queue refused; using a loop task")

    async def loop() -> None:
        await asyncio.sleep(10.0)
        while True:
            await tick()
            await asyncio.sleep(PASS_INTERVAL_S)

    try:
        asyncio.get_running_loop().create_task(loop(), name="av-godconst-pass")
        logger.info("av-godconst: pass on a loop task every %ss", int(PASS_INTERVAL_S))
    except RuntimeError:
        logger.warning("av-godconst: no running loop at wire time; cards advance on taps only")


def register(ctx: Any) -> None:
    """Hermes plugin entrypoint: two scoped Telegram callback handlers (``gcb:`` the ballot, ``gce:`` the elicitation
    cards) and the pass. No tools, no hooks. At start the page-open marker is reconciled with both ledgers (removed
    unless either mode has a page open inside its window)."""
    try:
        reconcile_page_open()
    except Exception:  # noqa: BLE001
        logger.warning("av-godconst: page marker reconcile failed")
    try:
        wire = getattr(ctx, "register_platform_handler", None)
        if callable(wire):
            wire("telegram", _wire_telegram)
            return
        legacy = getattr(ctx, "register_telegram_handler", None)
        if callable(legacy):
            legacy(_wire_telegram)
            return
        logger.warning("av-godconst: this Hermes has no platform handler registration; cards are off")
    except Exception:  # noqa: BLE001
        logger.warning("av-godconst: could not register the ballot card handler", exc_info=True)


__all__ = [
    "Reply", "ballot_on", "cp_call", "cp_origin", "elicit_on", "elicit_pass_once", "home_chat_id", "is_owner_tap",
    "ledger_path", "load_elicit_ledger", "load_ledger", "make_elicit_handler", "make_handler", "mark_keyboard",
    "new_session", "pass_once", "register", "save_ledger", "sync",
    "load_thor_ledger", "make_thor_handler", "save_thor_ledger", "thor_active", "thor_cp_call", "thor_key",
    "thor_pass_once",
]
