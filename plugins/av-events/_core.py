"""Agent Village event collector — pure-stdlib core.

Everything in this module is independent of Hermes: env resolution, the uuid v7
generator, canonical hashing, the secret sanitizer, the on-disk buffer and its
background flusher, and the session bookkeeping that turns hook callbacks into
envelope-v1 events.

`__init__.py` holds `register(ctx)` and the hook adapters. Keeping the two apart
lets the test suite drive the collector with a fake `ctx` and without importing
Hermes.

Python 3.11, standard library only. See README.md for the contract.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

SCHEMA_VERSION = 1

#: Everything this plugin observes is the agent describing its own behaviour.
#: The ingest server downgrades anything higher anyway (spec scenario 4).
EVIDENCE_CLASS = "agent_report"

#: Per-hook wall-clock budget. Overruns are counted, never enforced: aborting a
#: hook halfway is worse for the agent than a slow one.
HOOK_BUDGET_MS = 50.0

#: Failures in one session before the plugin disables itself *for that session*.
MAX_SESSION_FAILURES = 10

#: Failures across the whole process, regardless of session, before the plugin
#: gives up entirely. A gateway process interleaves many sessions (subagents,
#: cron), so a per-session breaker alone can be outrun by churn: every failure
#: lands on a fresh id and no single session ever reaches ten.
MAX_PROCESS_FAILURES = 50

#: Upper bound on tracked sessions. Finished sessions are evicted on end; this
#: is the backstop for the ones that never report an end.
MAX_TRACKED_SESSIONS = 256

#: How stale the resolved config may get when no new session appears. The kill
#: switches are read at session boundaries; this bounds the long-lived-session
#: case without putting an env sweep on the hot path.
CONFIG_TTL_S = 60.0

#: Files the flusher will attempt in one pass, so a large backlog cannot turn a
#: single tick into a long blocking walk.
MAX_FILES_PER_TICK = 5

#: Buffer flush triggers.
FLUSH_INTERVAL_S = 10.0
FLUSH_MAX_EVENTS = 50

#: Flusher wake-up period. Shorter than FLUSH_INTERVAL_S so the 10 s deadline is
#: honoured rather than rounded up.
TICK_INTERVAL_S = 1.0

#: Total age a buffer file may reach before it is dropped (spec §7.1).
MAX_BUFFER_AGE_S = 72 * 60 * 60

#: Exponential backoff for a file that will not send.
BACKOFF_BASE_S = 2.0
BACKOFF_MAX_S = 300.0

HTTP_TIMEOUT_S = 10.0

#: Total seconds the atexit flush may spend before giving up. The process is on
#: its way out; the buffer survives on disk either way.
EXIT_FLUSH_BUDGET_S = 5.0

CAPTURE_MODES = ("metadata", "sanitized", "full")
DEFAULT_CAPTURE = "sanitized"

#: Spellings of "off" accepted for `AV_EVENTS_ENABLED`, compared case-folded
#: and stripped. An operator flipping a kill switch under pressure should not
#: have to remember which word this particular plugin wanted.
DISABLED_VALUES = frozenset({"0", "false", "no", "off"})

#: Everything the buffer writes is per-tenant telemetry sitting in the agent's
#: home directory: owner-only.
DIR_MODE = 0o700
FILE_MODE = 0o600

#: HTTP statuses worth trying again. Everything else 4xx means this batch will
#: never be accepted, so retrying it forever only delays the batches behind it.
RETRYABLE_STATUSES = frozenset({408, 425, 429})

#: uuid5 namespace for Agent Village derived ids (spec §4.3). Producer events
#: get uuid v7; the one derived id this plugin mints is `cron.run`'s
#: (`cron_run_event_id`). `agentvillage-data/src/ids.ts` pins the same value.
NS_AV = uuid.UUID("6d1f2d4e-6a6b-5c29-9b3a-0f0f9b1d4a11")


# --------------------------------------------------------------------------
# Environment
# --------------------------------------------------------------------------


def hermes_home() -> str:
    return os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")


_DOTENV_LOCK = threading.Lock()
#: (path, mtime_ns) -> parsed mapping. Hermes memoises `$HERMES_HOME/.env` on
#: its mtime for the same reason: config resolution sits on the hot path and a
#: miss would otherwise cost one file open per missing variable per hook.
_DOTENV_CACHE: dict[tuple[str, int], dict[str, str]] = {}


def _read_dotenv() -> dict[str, str]:
    path = os.path.join(hermes_home(), ".env")
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        return {}
    key = (path, mtime)
    with _DOTENV_LOCK:
        cached = _DOTENV_CACHE.get(key)
    if cached is not None:
        return cached
    parsed: dict[str, str] = {}
    try:
        with open(path, encoding="utf-8-sig") as handle:
            for line in handle:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, _, value = line.partition("=")
                parsed[name.strip()] = value.strip().strip("'\"")
    except OSError:
        return {}
    with _DOTENV_LOCK:
        _DOTENV_CACHE.clear()  # only the current mtime is ever interesting
        _DOTENV_CACHE[key] = parsed
    return parsed


def env(name: str) -> str:
    """Read `name` from the process env, falling back to `$HERMES_HOME/.env`.

    Same helper shape as `plugins/dashboard-auth-edgecity`, with one deliberate
    difference: a variable **present but blank** in the process environment is
    authoritative and does *not* fall through to the dotfile. `AV_EVENTS_TOKEN=""`
    is how the control plane revokes a tenant, and a stale `.env` line must not
    be able to undo that.
    """
    raw = os.environ.get(name)
    if raw is not None:
        return raw.strip()
    return _read_dotenv().get(name, "").strip()


def env_flag_disabled(name: str) -> bool:
    """True when `name` holds any accepted spelling of "off"."""
    return env(name).strip().lower() in DISABLED_VALUES


# --------------------------------------------------------------------------
# uuid v7 (RFC 9562 §5.7)
# --------------------------------------------------------------------------

_UUID7_LOCK = threading.Lock()
_UUID7_LAST_MS = 0
_UUID7_SEQ = 0


def uuid7() -> str:
    """RFC 9562 version 7 UUID. The stdlib has no `uuid.uuid7()` on 3.11.

    Layout: 48-bit big-endian Unix milliseconds, 4-bit version `0b0111`, 12 bits
    of `rand_a`, 2-bit variant `0b10`, 62 bits of `rand_b`.

    `rand_a` carries a monotonic counter within a millisecond (method 1 of the
    RFC's "fixed bit-length dedicated counter") so that ids minted in the same
    millisecond still sort in emission order.
    """
    global _UUID7_LAST_MS, _UUID7_SEQ
    with _UUID7_LOCK:
        now_ms = int(time.time() * 1000)
        if now_ms > _UUID7_LAST_MS:
            _UUID7_LAST_MS = now_ms
            _UUID7_SEQ = secrets.randbits(10)  # leave headroom before rollover
        else:
            now_ms = _UUID7_LAST_MS
            _UUID7_SEQ += 1
            if _UUID7_SEQ > 0xFFF:
                # Counter exhausted inside one millisecond: borrow the next.
                _UUID7_LAST_MS += 1
                now_ms = _UUID7_LAST_MS
                _UUID7_SEQ = secrets.randbits(10)
        seq = _UUID7_SEQ & 0xFFF

    raw = now_ms.to_bytes(6, "big")
    raw += ((0x7 << 12) | seq).to_bytes(2, "big")
    raw += ((0b10 << 62) | secrets.randbits(62)).to_bytes(8, "big")
    return str(uuid.UUID(bytes=raw))


# --------------------------------------------------------------------------
# Time and hashing
# --------------------------------------------------------------------------


def now_iso() -> str:
    """RFC 3339 timestamptz, millisecond precision, always UTC."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def iso_from_epoch(value: Any) -> Optional[str]:
    """Same format from a Unix timestamp, or None if it is not one.

    Hermes hands hooks `started_at` / `ended_at` as `time.time()` floats.
    """
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        return None
    try:
        stamp = datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical_json(obj: Any) -> str:
    """The one canonicalisation. Any change here changes every hash we emit."""
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sha256_text(text: str) -> str:
    # `surrogatepass`: a lone surrogate (which JSON can carry and Python can
    # hold) must hash, not raise. Well-formed text hashes exactly as UTF-8.
    return hashlib.sha256(text.encode("utf-8", errors="surrogatepass")).hexdigest()


def hash_obj(obj: Any) -> str:
    """SHA-256 over canonical JSON. Key order in the input is irrelevant."""
    return sha256_text(canonical_json(obj))


def hash_text(text: Optional[str]) -> Optional[str]:
    return None if text is None else sha256_text(text)


# --------------------------------------------------------------------------
# Secret sanitiser
# --------------------------------------------------------------------------

#: Order matters: the more specific provider shapes run before the generic
#: `sk-` shape, so an Anthropic key is labelled as one.
_SECRET_PATTERNS: tuple[tuple[str, "re.Pattern[str]"], ...] = (
    ("anthropic_key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{16,}")),
    ("openrouter_key", re.compile(r"sk-or-(?:v\d+-)?[A-Za-z0-9_\-]{16,}")),
    ("openai_key", re.compile(r"sk-(?:proj-|svcacct-)?[A-Za-z0-9_\-]{16,}")),
    ("telegram_bot_token", re.compile(r"\b\d{6,12}:[A-Za-z0-9_\-]{30,}")),
    ("bearer", re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=\-]{8,}")),
)

_REDACTED = "[redacted:{}]"

#: Literal values that must never leave, registered at config time. Currently
#: just our own token; a value appearing verbatim in a prompt is still a leak.
_LITERAL_SECRETS: set[str] = set()
_LITERAL_LOCK = threading.Lock()


def register_literal_secret(value: str) -> None:
    if value and len(value) >= 8:
        with _LITERAL_LOCK:
            _LITERAL_SECRETS.add(value)


def sanitize(text: Any) -> Any:
    """Redact known credential shapes from any string that leaves the process.

    Non-strings pass through untouched; containers are walked. This is a last
    line of defence, not the privacy control — the capture modes are.
    """
    if isinstance(text, str):
        out = text
        with _LITERAL_LOCK:
            literals = tuple(_LITERAL_SECRETS)
        for literal in literals:
            if literal in out:
                out = out.replace(literal, _REDACTED.format("token"))
        for label, pattern in _SECRET_PATTERNS:
            out = pattern.sub(_REDACTED.format(label), out)
        return out
    if isinstance(text, dict):
        return {key: sanitize(value) for key, value in text.items()}
    if isinstance(text, (list, tuple)):
        return [sanitize(item) for item in text]
    return text


# --------------------------------------------------------------------------
# Derived ids, host timestamps, read-only host stores
# --------------------------------------------------------------------------


def cron_run_event_id(tenant_id: str, execution_id: str) -> str:
    """§4.3 tail-derived id: `uuid5(NS_AV, "{tenant_id}|cron|{execution_id}")`.

    The one uuid v5 a plugin token may send. Ingest recomputes exactly this
    from the token's tenant and `payload.execution_id` and quarantines any
    other v5 (`pluginEventIdProblem` in `agentvillage-data/src/ingest/events.ts`).
    """
    return str(uuid.uuid5(NS_AV, f"{tenant_id}|cron|{execution_id}"))


def iso_from_text(value: Any) -> Optional[str]:
    """An ISO-8601 timestamp from a host store, as UTC `...Z` at ms, or None.

    Hermes writes cron timestamps with `hermes_time.now().isoformat()`, which
    carries the host's local offset; ordering and storage need one zone. A
    naive stamp is not guessed at and yields None.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        stamp = datetime.fromisoformat(value.strip())
    except ValueError:
        return None
    if stamp.tzinfo is None:
        return None
    return stamp.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def epoch_from_iso(value: Optional[str]) -> Optional[float]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def sqlite_read(path: str, sql: str, params: tuple = (), *, timeout: float = 0.2) -> Optional[list[dict]]:
    """Rows from a Hermes SQLite store, opened read-only, or None on any failure.

    `mode=ro` means this plugin cannot write to a Hermes database even by
    mistake. A missing file, a missing table, a lock held past `timeout` —
    every one of them is "no data", never an exception.
    """
    if not os.path.isfile(path):
        return None
    import sqlite3  # stdlib; imported here so a plugin that never reads a store never loads it
    import urllib.parse

    uri = "file:" + urllib.parse.quote(os.path.abspath(path)) + "?mode=ro"
    conn = None
    try:
        conn = sqlite3.connect(uri, uri=True, timeout=timeout)
        conn.row_factory = sqlite3.Row
        return [dict(row) for row in conn.execute(sql, params).fetchall()]
    except sqlite3.Error:
        return None
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:  # noqa: BLE001
                pass


# --------------------------------------------------------------------------
# Buffer
# --------------------------------------------------------------------------


class Buffer:
    """Append-only JSONL under `$HERMES_HOME/av-events/buffer/`.

    One `current-<pid>.jsonl` per process is appended to; it is rotated to a
    timestamped name once it holds `FLUSH_MAX_EVENTS` events or is
    `FLUSH_INTERVAL_S` old. Rotated files are what the flusher sends. A file
    named with the epoch-ms of its *first* event is its own age clock, so a
    crashed process leaves recoverable, self-describing batches behind.
    """

    def __init__(self, root: str) -> None:
        self.root = root
        #: Batches ingest refused outright. Kept on disk for a human to look at,
        #: never offered to the server again.
        self.rejected_root = os.path.join(root, "rejected")
        self._lock = threading.RLock()
        self._pid = os.getpid()
        self._current = os.path.join(root, f"current-{self._pid}.jsonl")
        self._started_ms: Optional[int] = None
        self._count = 0
        self._seq = 0
        # `makedirs` applies `mode` to the leaf only; the `av-events/` parent it
        # creates on the way would otherwise land at the process umask.
        parent = os.path.dirname(root)
        if parent:
            os.makedirs(parent, mode=DIR_MODE, exist_ok=True)
            try:
                os.chmod(parent, DIR_MODE)
            except OSError:
                pass
        os.makedirs(root, mode=DIR_MODE, exist_ok=True)

    # -- writing ----------------------------------------------------------

    def append(self, event: dict) -> None:
        # Encode before anything touches the file: a line that cannot be
        # encoded (a lone surrogate) raises here, with no fd open and nothing
        # half-written.
        data = (json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            # `os.open` so the file is created 0o600 from the start rather than
            # existing world-readable for the width of a chmod. Exactly one
            # close, in `finally`: closing twice could close an fd another
            # thread has since been handed.
            flags = os.O_WRONLY | os.O_CREAT | os.O_APPEND
            try:
                fd = os.open(self._current, flags, FILE_MODE)
            except FileNotFoundError:
                # The directory went away under a running process (a
                # `reset.ts --wipe-user`, an operator's `rm`): make it again.
                os.makedirs(os.path.dirname(self.root), mode=DIR_MODE, exist_ok=True)
                os.makedirs(self.root, mode=DIR_MODE, exist_ok=True)
                fd = os.open(self._current, flags, FILE_MODE)
            try:
                view = memoryview(data)
                while view:
                    written = os.write(fd, view)
                    view = view[written:]
            finally:
                os.close(fd)
            if self._started_ms is None:
                self._started_ms = int(time.time() * 1000)
            self._count += 1
            if self._count >= FLUSH_MAX_EVENTS:
                self._rotate_locked()

    def reject(self, path: str) -> bool:
        """Move a refused batch out of the send queue, keeping it on disk."""
        try:
            os.makedirs(self.rejected_root, mode=DIR_MODE, exist_ok=True)
            os.replace(path, os.path.join(self.rejected_root, os.path.basename(path)))
            return True
        except OSError:
            return False

    def rotate_if_due(self, force: bool = False) -> None:
        with self._lock:
            if self._count == 0 or self._started_ms is None:
                return
            age = time.time() - (self._started_ms / 1000.0)
            if force or age >= FLUSH_INTERVAL_S:
                self._rotate_locked()

    def _rotate_locked(self) -> None:
        if self._count == 0 or self._started_ms is None:
            return
        self._seq += 1
        target = os.path.join(self.root, f"{self._started_ms:013d}-{self._pid}-{self._seq:04d}.jsonl")
        try:
            os.replace(self._current, target)
        except OSError:
            return
        self._started_ms = None
        self._count = 0

    @property
    def pending_count(self) -> int:
        with self._lock:
            return self._count

    # -- reading ----------------------------------------------------------

    def ready_files(self) -> list[str]:
        """Rotated batches, oldest first. Never includes any process's current file.

        `rejected/` is a subdirectory, so quarantined batches fall out of this
        listing without any name filtering.
        """
        try:
            names = os.listdir(self.root)
        except OSError:
            return []
        out = [
            os.path.join(self.root, name)
            for name in names
            if name.endswith(".jsonl") and not name.startswith("current-")
        ]
        out.sort()
        return out

    @staticmethod
    def file_started_ms(path: str) -> int:
        base = os.path.basename(path)
        try:
            return int(base.split("-", 1)[0])
        except (ValueError, IndexError):
            try:
                return int(os.path.getmtime(path) * 1000)
            except OSError:
                return int(time.time() * 1000)

    @staticmethod
    def read_events(path: str) -> list[dict]:
        events: list[dict] = []
        try:
            with open(path, encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        parsed = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(parsed, dict):
                        events.append(parsed)
        except OSError:
            return []
        return events


# --------------------------------------------------------------------------
# Sender
# --------------------------------------------------------------------------


class SendResult:
    __slots__ = ("ok", "status", "reason")

    def __init__(self, ok: bool, status: Optional[int] = None, reason: str = "") -> None:
        self.ok = ok
        self.status = status
        self.reason = reason

    @property
    def retryable(self) -> bool:
        """Whether offering this batch again could ever succeed.

        No status means a network-level failure (DNS, refused, timeout, TLS) —
        always worth retrying. 5xx is the server's problem, 408/425/429 are
        explicit "try again". Every other 4xx is a statement about this batch or
        this token: a malformed body, a wrong tenant, an oversized payload. That
        will not change on its own, and retrying it for 72 hours only delays
        every batch queued behind it.
        """
        if self.status is None:
            return True
        if self.status in RETRYABLE_STATUSES:
            return True
        return self.status >= 500


def post_events(url: str, token: str, events: list[dict]) -> SendResult:
    """POST one batch. The only network destination this plugin has."""
    body = json.dumps({"events": events}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url.rstrip("/") + "/v1/events",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "Authorization": f"Bearer {token}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=HTTP_TIMEOUT_S) as response:
            status = int(getattr(response, "status", 0) or 0)
            response.read()
            return SendResult(200 <= status < 300, status)
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except Exception:  # noqa: BLE001 - draining the body must never raise
            pass
        return SendResult(False, exc.code, "http_error")
    except Exception as exc:  # noqa: BLE001 - URLError, socket timeouts, TLS, DNS
        return SendResult(False, None, type(exc).__name__)
