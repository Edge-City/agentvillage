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

import errno
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

try:  # POSIX only; without it, orphan detection falls back to pid liveness and age.
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

# --------------------------------------------------------------------------
# Constants
# --------------------------------------------------------------------------

SCHEMA_VERSION = 1

#: The plugin's own version: `__init__.__version__` and `plugin.yaml` carry the
#: same string (a test holds them together). Lives here so `_backup` can write
#: it into a snapshot manifest without importing the package `__init__`.
PLUGIN_VERSION = "0.1.0"

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

#: A dead process's `current-<pid>.jsonl` with no owner lock to probe (a writer
#: from before DATA-94, or a platform without `fcntl`) is adopted once its pid
#: is gone, or once it is this old whatever its pid says: a live writer rotates
#: its current file within `FLUSH_INTERVAL_S` of the first event in it, so one
#: untouched for five minutes has nobody behind it. Covers a pid reused by an
#: unrelated process after a container restart.
ORPHAN_STALE_S = 300.0

#: A new buffer whose own lock is held (another process probing it, for
#: microseconds) tries again this many times, this far apart, before it
#: settles for running without one. At most ~30 ms, once per process.
OWNER_LOCK_HELD_RETRIES = 3
OWNER_LOCK_RETRY_S = 0.01

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

#: HTTP statuses that refuse the *token*, not the batch: 401 only. A process
#: started before a token rotation (`hermes dashboard` outlives a
#: gateway-only restart) holds a revoked token while the gateway beside it
#: holds the new one; the batch is fine and must stay queued for the process
#: that can send it. The 72-hour age limit still bounds a token that is
#: really gone. 403 is not here: ingest answers 403 for `tenant_mismatch`,
#: `source_mismatch` and `token_class_forbidden`, verdicts on the batch, and a
#: batch like that left queued would sit at the head of the queue for 72 h.
AUTH_STATUSES = frozenset({401})

#: How long a process whose token ingest refused waits before re-reading its
#: config and trying again.
AUTH_BACKOFF_S = 600.0

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


#: A process's current batch and the lock that says its owner is alive.
_OWNER_FILE = re.compile(r"^current-(\d+)\.(jsonl|lock)$")

#: What a non-blocking `flock` fails with when another open file holds the
#: lock. Any other failure (ENOLCK on a filesystem without locks, …) means
#: locking is unavailable here, and ownership falls back to pid and age.
_LOCK_HELD = frozenset({errno.EAGAIN, errno.EWOULDBLOCK, errno.EACCES})


def _same_inode(path: str, handle: Any) -> bool:
    """Whether `path` still names the file `handle` has open."""
    try:
        return os.path.samestat(os.stat(path), os.fstat(handle.fileno()))
    except OSError:
        return False


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _probe_lock(path: str) -> tuple[str, Any]:
    """Try a dead owner's lock without waiting.

    Returns `("free", handle)` holding it (the owner is gone; close the handle
    to let go), or `("held", None)`, `("missing", None)`, `("unsupported",
    None)`.
    """
    if fcntl is None:
        return "unsupported", None
    try:
        handle = open(path, "rb", buffering=0)
    except FileNotFoundError:
        return "missing", None
    except OSError:
        return "unsupported", None
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as exc:
        handle.close()
        return ("held" if exc.errno in _LOCK_HELD else "unsupported"), None
    if not _same_inode(path, handle):
        # Unlinked or replaced while we opened it: someone else is on it.
        # The next scan looks again.
        handle.close()
        return "held", None
    return "free", handle


class Buffer:
    """Append-only JSONL under `$HERMES_HOME/av-events/buffer/`.

    One `current-<pid>.jsonl` per process is appended to; it is rotated to a
    timestamped name once it holds `FLUSH_MAX_EVENTS` events or is
    `FLUSH_INTERVAL_S` old. Rotated files are what the flusher sends. A file
    named with the epoch-ms of its *first* event is its own age clock, so a
    crashed process leaves recoverable, self-describing batches behind.

    A process that dies without rotating (the gateway leaves through
    `os._exit`, DATA-94) leaves its `current-<pid>.jsonl` behind. The owner
    holds an `flock` on `current-<pid>.lock` for as long as its buffer lives,
    and the kernel drops it however the process ends. `adopt_orphans` renames
    a current file whose lock it can take into an ordinary batch. A new buffer
    does the same at once for a leftover file carrying its own pid (a container
    restart hands the gateway the same pid), before its first append could
    land behind a half-written line.
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
        #: The open lock file whose `flock` says "this pid's current file is
        #: live", or None: another buffer in this same process holds it (tests
        #: do that), the directory refused the file, or locking is unavailable.
        state, self._owner_lock = self._take_owner_lock()
        if state in ("ours", "unsupported"):
            # Nobody alive writes to a file with our pid in its name but us,
            # and we have not written yet: whatever is there is a dead
            # process's. Move it aside before the first append.
            if os.path.exists(self._current):
                self._adopt(self._current, self._pid)

    # -- ownership --------------------------------------------------------

    def _lock_path(self, pid: int) -> str:
        return os.path.join(self.root, f"current-{pid}.lock")

    def _take_owner_lock(self) -> tuple[str, Any]:
        """`("ours", handle)`, or `("held" | "unsupported" | "error", None)`.

        Never blocks on the lock; waits at most ~30 ms in all, and only when
        it is held. "held" after that is another buffer in this process, or an
        adopter still moving aside a dead namesake's file.
        """
        if fcntl is None:
            return "unsupported", None
        path = self._lock_path(self._pid)
        held_retries = 0
        # Retried because an adopter unlinks a dead owner's lock file while
        # holding it: a lock taken on an inode no longer at `path` guards
        # nothing, so check the path still names the inode we locked. And
        # retried, briefly, when it is held: another process probing whether
        # this pid is alive (`has_backlog`, `adopt_orphans`) holds a free lock
        # for microseconds, and losing that race would leave this process
        # without a lock for its whole life.
        for _ in range(3 + OWNER_LOCK_HELD_RETRIES):
            try:
                fd = os.open(path, os.O_RDWR | os.O_CREAT, FILE_MODE)
            except OSError:
                return "error", None
            handle = os.fdopen(fd, "r+b", buffering=0)
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as exc:
                handle.close()
                if exc.errno in _LOCK_HELD:
                    if held_retries < OWNER_LOCK_HELD_RETRIES:
                        held_retries += 1
                        time.sleep(OWNER_LOCK_RETRY_S)
                        continue
                    return "held", None
                # No locks on this filesystem. A lock file here would guard
                # nothing, and one per pid would pile up: take it away again.
                _unlink_quietly(path)
                return "unsupported", None
            if _same_inode(path, handle):
                return "ours", handle
            handle.close()
        return "held", None

    @staticmethod
    def _pid_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return False
        except OSError:
            return True  # EPERM: it exists, it is just not ours to signal
        return True

    def adopt_orphans(self) -> int:
        """Turn every dead process's current file into a ready batch.

        Local renames only, never the network: the flusher calls it, and sends
        the result on its normal pass. Returns how many files were adopted.
        """
        try:
            names = sorted(os.listdir(self.root))
        except OSError:
            return 0
        present = set(names)
        adopted = 0
        for name in names:
            match = _OWNER_FILE.match(name)
            if match is None:
                continue
            pid, kind = int(match.group(1)), match.group(2)
            if pid == self._pid:
                continue  # ours, or a sibling buffer's in this same process
            path = os.path.join(self.root, name)
            if kind == "lock":
                if f"current-{pid}.jsonl" not in present:
                    self._release_dead_lock(path)
                continue
            gone, handle = self._owner_gone(pid, path)
            if not gone:
                continue
            try:
                if self._adopt(path, pid):
                    adopted += 1
                if handle is not None:
                    # Unlinked while still held, so a process that reuses this
                    # pid and opens the path meanwhile finds its lock on a dead
                    # inode and takes a fresh one (`_take_owner_lock`).
                    _unlink_quietly(self._lock_path(pid))
            finally:
                if handle is not None:
                    handle.close()
        return adopted

    def _owner_gone(self, pid: int, path: str) -> tuple[bool, Any]:
        """Whether the process that wrote `current-<pid>.jsonl` at `path` is gone.

        When its lock was what said so, the lock comes back held; the caller
        closes it. With no lock to probe (a writer from before DATA-94, or a
        filesystem without `flock`), a gone pid is dead, and a live one may be
        a reused pid, so the file's age decides.
        """
        state, handle = _probe_lock(self._lock_path(pid))
        if state == "held":
            return False, None
        if state == "free":
            return True, handle
        if self._pid_alive(pid):
            try:
                idle = time.time() - os.path.getmtime(path)
            except OSError:
                return False, None
            if idle < ORPHAN_STALE_S:
                return False, None
        return True, None

    @staticmethod
    def _release_dead_lock(lock_path: str) -> None:
        """Tidy a lock whose owner is gone and left no current file behind."""
        state, handle = _probe_lock(lock_path)
        if state == "free":
            try:
                _unlink_quietly(lock_path)
            finally:
                handle.close()

    def _adopt(self, path: str, pid: int) -> bool:
        """Rename a dead process's current file to an ordinary batch name.

        Named for its first event, as a rotation would have, so it sorts after
        every batch the dead process did rotate and before anything newer.
        """
        started_ms = self._first_event_ms(path)
        try:
            if started_ms is None:
                if os.path.getsize(path) == 0:
                    os.unlink(path)
                    return False
                started_ms = int(os.path.getmtime(path) * 1000)
            target = os.path.join(self.root, f"{started_ms:013d}-{pid}-orphan.jsonl")
            if os.path.exists(target):
                target = os.path.join(self.root, f"{started_ms:013d}-{pid}-orphan-{secrets.token_hex(4)}.jsonl")
            os.replace(path, target)
        except OSError:
            return False
        return True

    @staticmethod
    def _first_event_ms(path: str) -> Optional[int]:
        """`emitted_at` of the first readable line, in epoch ms, or None."""
        events, _ = Buffer.read_events_counted(path, limit=1)
        stamp = events[0].get("emitted_at") if events else None
        seconds = epoch_from_iso(stamp) if isinstance(stamp, str) else None
        return int(seconds * 1000) if seconds is not None else None

    def has_backlog(self) -> bool:
        """Anything on disk that is this process's to send: a non-empty
        rotated batch, or a non-empty current file whose owner is gone.

        A live process's current file is not: it is that process's to rotate
        and send. Counting it would start a flusher in every process that
        loads the plugin next to a running gateway (`hermes dashboard`, a
        CLI), each with whatever token it was started with.
        """
        try:
            names = os.listdir(self.root)
        except OSError:
            return False
        for name in names:
            if not name.endswith(".jsonl"):
                continue
            path = os.path.join(self.root, name)
            try:
                if os.path.getsize(path) == 0:
                    continue
            except OSError:
                continue
            match = _OWNER_FILE.match(name)
            if match is None:
                return True  # a rotated batch
            pid = int(match.group(1))
            if pid == self._pid:
                continue
            gone, handle = self._owner_gone(pid, path)
            if handle is not None:
                handle.close()
            if gone:
                return True
        return False

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
                # The old current file went with the directory: this is a new
                # batch, and its start is now, not the lost one's.
                self._started_ms = None
                self._count = 0
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
        except FileNotFoundError:
            # The file went away under us (a wipe, an operator's `rm`), and its
            # events with it. Start the next batch clean: keeping the old start
            # would name it for a first event long gone, and the 72-hour rule
            # could then drop it as expired the moment it is rotated.
            self._started_ms = None
            self._count = 0
            return
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
        return Buffer.read_events_counted(path)[0]

    @staticmethod
    def read_events_counted(path: str, limit: Optional[int] = None) -> tuple[list[dict], int]:
        """The file's events, and how many of its lines could not be read.

        Read as bytes and decoded line by line. A process killed mid-write
        leaves a truncated last line, possibly cut inside a multi-byte UTF-8
        character (lines are written with `ensure_ascii=False`); that line is
        dropped and counted, and must cost neither the rest of the batch nor
        an exception out of the flusher, which would wedge the queue on it.
        """
        events: list[dict] = []
        unreadable = 0
        try:
            with open(path, "rb") as handle:
                for raw in handle:
                    if limit is not None and len(events) >= limit:
                        break
                    raw = raw.strip()
                    if not raw:
                        continue
                    try:
                        parsed = json.loads(raw.decode("utf-8"))
                    except ValueError:  # JSONDecodeError and UnicodeDecodeError both
                        unreadable += 1
                        continue
                    if isinstance(parsed, dict):
                        events.append(parsed)
                    else:
                        unreadable += 1
        except OSError:
            return [], 0
        return events, unreadable


# --------------------------------------------------------------------------
# Sender
# --------------------------------------------------------------------------


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect.

    urllib's default handler follows 301/302/303 (and 307/308 for a GET) and
    re-sends every header but the content ones, `Authorization` included, to
    whatever host `Location` names. Ingest never redirects, so a 3xx is a
    misconfiguration or an attack, and following it would hand the bearer to
    a host other than the configured URL's. With `redirect_request` returning
    None, urllib raises `HTTPError` with the 3xx code instead, and no request
    is made to the new location.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401, ANN001
        return None


#: The only urllib opener this plugin sends a bearer through: the events
#: poster and the consent fetch. (The backup uploader speaks `http.client`
#: directly, which never follows a redirect.)
NO_REDIRECT_OPENER = urllib.request.build_opener(NoRedirect)


def is_redirect(status: Optional[int]) -> bool:
    return status is not None and 300 <= status < 400


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

        401 is the exception the flusher handles before this (`auth_refused`):
        it says this *process's* token is wrong, not the batch, so the batch
        stays queued for a process that has the right one. 403 is a verdict on
        the batch (wrong tenant, source or token class) and is not retryable.

        A 3xx is refused, never followed (`NoRedirect`), and is retryable like
        a 5xx: ingest never redirects, so a redirect is a fault in front of
        it (a proxy, a moved domain), not a verdict on the batch. The batch
        waits, backing off, until the fault is fixed or it is 72 hours old;
        quarantining it would throw away good evidence.
        """
        if self.status is None:
            return True
        if self.status in RETRYABLE_STATUSES:
            return True
        if is_redirect(self.status):
            return True
        return self.status >= 500

    @property
    def redirect_refused(self) -> bool:
        """The server answered 3xx and the redirect was not followed."""
        return not self.ok and is_redirect(self.status)

    @property
    def auth_refused(self) -> bool:
        """Ingest refused the token (401), not the batch."""
        return self.status in AUTH_STATUSES


def post_events(url: str, token: str, events: list[dict]) -> SendResult:
    """POST one batch to `{url}/v1/events`, and nowhere else.

    Sent through `NO_REDIRECT_OPENER`: a 3xx is `SendResult(False, <3xx>,
    "redirect")` and the bearer never reaches the `Location` host.
    """
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
        with NO_REDIRECT_OPENER.open(request, timeout=HTTP_TIMEOUT_S) as response:
            status = int(getattr(response, "status", 0) or 0)
            response.read()
            return SendResult(200 <= status < 300, status)
    except urllib.error.HTTPError as exc:
        try:
            exc.read()
        except Exception:  # noqa: BLE001 - draining the body must never raise
            pass
        code = int(getattr(exc, "code", 0) or 0)
        return SendResult(False, code, "redirect" if is_redirect(code) else "http_error")
    except Exception as exc:  # noqa: BLE001 - URLError, socket timeouts, TLS, DNS
        return SendResult(False, None, type(exc).__name__)
